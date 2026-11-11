import { useEffect, useState } from "react";

/**
 * How many just-sent images keep their local file. Each pins the original
 * file through its object URL, so an older one goes back to the download.
 */
export const LOCAL_MESSAGE_IMAGE_LIMIT = 24;

/**
 * Images this browser just sent, by their Document id, so the committed
 * Message shows the local file at once instead of downloading it again.
 * Oldest first.
 */
const files = new Map<string, File>();

export function rememberLocalMessageImage(documentId: string, file: File) {
  files.delete(documentId);
  files.set(documentId, file);
  for (const [oldestId, oldest] of files) {
    if (files.size <= LOCAL_MESSAGE_IMAGE_LIMIT) break;
    files.delete(oldestId);
    if (![...files.values()].includes(oldest)) releaseLocalImage(oldest);
  }
}

export function localMessageImage(documentId: string): File | undefined {
  return files.get(documentId);
}

interface DecodedImage {
  height: number;
  url: string;
  width: number;
}

// Decoded once per file and kept while the file is remembered or picked, so
// the sending row and the committed row both show it at its size from their
// first frame.
const decoded = new WeakMap<File, Promise<DecodedImage>>();
const ready = new WeakMap<File, DecodedImage>();

/** Starts decoding a local image, e.g. as soon as it is picked to send. */
export function decodeLocalImage(file: File): Promise<DecodedImage> {
  let pending = decoded.get(file);
  if (!pending) {
    const url = URL.createObjectURL(file);
    const element = new Image();
    const decoding: Promise<DecodedImage> = new Promise<void>((resolve) => {
      element.onload = () => resolve();
      element.onerror = () => resolve();
      element.src = url;
    }).then(() => {
      const image = {
        height: element.naturalHeight,
        url,
        width: element.naturalWidth,
      };
      // Released while decoding: nothing will show it.
      if (decoded.get(file) !== decoding) URL.revokeObjectURL(url);
      else ready.set(file, image);
      return image;
    });
    pending = decoding;
    decoded.set(file, pending);
  }
  return pending;
}

/**
 * Frees a local image's object URL once nothing will show it again: a picked
 * file removed before sending, or a sent one past the remembered limit. An
 * image already painted keeps its pixels.
 */
export function releaseLocalImage(file: File) {
  const image = ready.get(file);
  if (image) URL.revokeObjectURL(image.url);
  ready.delete(file);
  decoded.delete(file);
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
