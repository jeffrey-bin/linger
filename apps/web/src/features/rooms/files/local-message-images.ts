import { useEffect, useState } from "react";

/**
 * Images this browser just sent, by their Document id, so the committed
 * Message shows the local file at once instead of downloading it again.
 */
const files = new Map<string, File>();

export function rememberLocalMessageImage(documentId: string, file: File) {
  files.set(documentId, file);
}

export function localMessageImage(documentId: string): File | undefined {
  return files.get(documentId);
}

interface DecodedImage {
  height: number;
  url: string;
  width: number;
}

// Decoded once per file and kept for the session, so the sending row and the
// committed row both show it at its size from their first frame.
const decoded = new WeakMap<File, Promise<DecodedImage>>();
const ready = new WeakMap<File, DecodedImage>();

/** Starts decoding a local image, e.g. as soon as it is picked to send. */
export function decodeLocalImage(file: File): Promise<DecodedImage> {
  let pending = decoded.get(file);
  if (!pending) {
    const url = URL.createObjectURL(file);
    const element = new Image();
    pending = new Promise<void>((resolve) => {
      element.onload = () => resolve();
      element.onerror = () => resolve();
      element.src = url;
    }).then(() => {
      const image = {
        height: element.naturalHeight,
        url,
        width: element.naturalWidth,
      };
      ready.set(file, image);
      return image;
    });
    decoded.set(file, pending);
  }
  return pending;
}

/**
 * The size a chat image shows at: its own size, scaled down to fit 448 by
 * 360 px, so the frame hugs the picture rather than letterboxing it.
 */
export function chatImageSize(image: { height: number; width: number }) {
  const scale = Math.min(1, 448 / image.width, 360 / image.height);
  return {
    height: Math.round(image.height * scale),
    width: Math.round(image.width * scale),
  };
}

/** A local image with its size, once decoded. */
export function useDecodedImage(file: File | undefined) {
  const [, setDecodedFile] = useState<File>();
  useEffect(() => {
    if (!file || ready.has(file)) return;
    let active = true;
    void decodeLocalImage(file).then(() => {
      if (active) setDecodedFile(file);
    });
    return () => {
      active = false;
    };
  }, [file]);
  return file ? ready.get(file) : undefined;
}
