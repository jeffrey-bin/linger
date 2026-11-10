import { PencilEdit02Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { type ChangeEvent, useEffect, useRef, useState } from "react";

import { ColorPalette } from "@/components/ui/color-palette";
import { ModalDialog } from "@/components/ui/modal-dialog";

import {
  AGENT_FIGURE_NAMES,
  agentAvatarAppearance,
  figureKey,
  imageKey,
  type AgentAvatarKey,
} from "./agent-avatar";
import { AgentAvatarPortrait } from "./agent-avatar-portrait";

/** Uploaded images are cropped square and scaled to this edge before saving. */
const AVATAR_IMAGE_EDGE = 256;
/** TeamHub keeps avatar images under this many data-URL characters. */
const AVATAR_IMAGE_MAX_LENGTH = 131_072;

/**
 * The Agent avatar editor: the avatar opens a gallery of the animal characters,
 * each on its own background (choosing one takes both), ending in an upload
 * tile where the caller can store images. The palette below recolors the
 * background behind whichever character or image is shown. Nothing persists
 * here; the caller saves the key and image together.
 */
export function AgentAvatarEditor({
  compact = false,
  disabled = false,
  image,
  onChange,
  onImageChange,
  value,
}: {
  compact?: boolean;
  disabled?: boolean;
  /** The uploaded image data URL, when the Agent uses one. */
  image?: string;
  onChange: (value: AgentAvatarKey) => void;
  /** Present where uploads are supported. */
  onImageChange?: (image: string) => void;
  value: AgentAvatarKey;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const appearance = agentAvatarAppearance(value);
  const showsImage = appearance.kind === "image" && Boolean(image);

  // Dismissing the file picker fires a bubbling "cancel" on the input, which a
  // surrounding <dialog> takes as its own Escape and closes the whole editor.
  const acceptsUploads = Boolean(onImageChange);
  useEffect(() => {
    const input = fileInputRef.current;
    if (!input) return;
    const hold = (event: Event) => event.stopPropagation();
    input.addEventListener("cancel", hold);
    return () => input.removeEventListener("cancel", hold);
  }, [acceptsUploads]);

  async function chooseImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !onImageChange) return;
    setUploadError(null);
    try {
      onImageChange(await readAvatarImage(file));
      onChange(imageKey(appearance.color));
      setGalleryOpen(false);
    } catch {
      setUploadError("This image could not be used. Try a JPEG, PNG, or WebP.");
    }
  }

  return (
    <div aria-disabled={disabled} className="flex flex-col items-center">
      <button
        aria-haspopup="dialog"
        aria-label="Choose avatar"
        className={`agent-avatar-upload group relative ${compact ? "size-24" : "size-40"} shrink-0 rounded-[20%] outline-none focus-visible:ring-2 focus-visible:ring-app-focus focus-visible:ring-offset-2 disabled:cursor-default`}
        data-testid="agent-avatar-hero"
        disabled={disabled}
        onClick={() => setGalleryOpen(true)}
        title="Choose avatar"
        type="button"
      >
        <AgentAvatarPortrait
          avatarKey={value}
          image={image}
          presentation="hero"
        />
        <span aria-hidden="true" className="agent-avatar-upload-hint">
          <Icon icon={PencilEdit02Icon} size={compact ? 20 : 24} />
        </span>
      </button>
      {onImageChange ? (
        <input
          accept="image/jpeg,image/png,image/webp"
          aria-label="Avatar image file"
          className="sr-only"
          disabled={disabled}
          onChange={(event) => void chooseImage(event)}
          ref={fileInputRef}
          tabIndex={-1}
          type="file"
        />
      ) : null}
      {uploadError ? (
        <p className="mt-2 text-xs text-app-danger" role="alert">
          {uploadError}
        </p>
      ) : null}
      {galleryOpen ? (
        <ModalDialog
          closeOnBackdrop
          onClose={() => setGalleryOpen(false)}
          size="sm"
          title="Choose avatar"
        >
          <div
            aria-label="Avatars"
            className="grid grid-cols-6 gap-2 px-5 py-4"
            role="radiogroup"
          >
            {AGENT_FIGURE_NAMES.map((figure, index) => {
              const selected =
                appearance.kind === "figure" &&
                !showsImage &&
                appearance.figure === figure;
              return (
                <button
                  aria-checked={selected}
                  aria-label={`Avatar ${index + 1}`}
                  className={`agent-avatar-option aspect-square rounded-[20%] outline-none focus-visible:ring-2 focus-visible:ring-app-focus ${selected ? "ring-2 ring-app-ink ring-offset-2 ring-offset-app-surface" : ""}`}
                  key={figure}
                  onClick={() => {
                    // The character comes with its own background.
                    onChange(figureKey(figure));
                    setGalleryOpen(false);
                  }}
                  role="radio"
                  type="button"
                >
                  <AgentAvatarPortrait avatarKey={figureKey(figure)} />
                </button>
              );
            })}
            {onImageChange ? (
              <button
                aria-label="Upload image"
                className="flex aspect-square items-center justify-center rounded-[20%] border border-dashed border-border-hover text-muted-foreground outline-none transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-app-focus"
                onClick={() => fileInputRef.current?.click()}
                title="Upload image"
                type="button"
              >
                <Icon icon={PlusSignIcon} size={20} />
              </button>
            ) : null}
          </div>
        </ModalDialog>
      ) : null}
      <div className="mt-4 flex w-full justify-center">
        <ColorPalette
          aria-label="Avatar background color"
          disabled={disabled}
          onChange={(color) =>
            onChange(
              showsImage
                ? imageKey(color)
                : figureKey(appearance.figure, color),
            )
          }
          value={appearance.color}
        />
      </div>
    </div>
  );
}

/** Crops the image to a centered square and encodes it small enough to store. */
async function readAvatarImage(file: File): Promise<string> {
  if (!/^image\/(?:jpeg|png|webp)$/.test(file.type)) {
    throw new Error("Unsupported avatar image type.");
  }
  const bitmap = await createImageBitmap(file);
  const edge = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_IMAGE_EDGE;
  canvas.height = AVATAR_IMAGE_EDGE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable.");
  context.drawImage(
    bitmap,
    (bitmap.width - edge) / 2,
    (bitmap.height - edge) / 2,
    edge,
    edge,
    0,
    0,
    AVATAR_IMAGE_EDGE,
    AVATAR_IMAGE_EDGE,
  );
  bitmap.close();
  // WebP keeps transparency so the chosen background shows through; browsers
  // without a WebP encoder return PNG, and JPEG is the size of last resort.
  const candidates = [
    () => canvas.toDataURL("image/webp", 0.9),
    () => canvas.toDataURL("image/webp", 0.72),
    () => canvas.toDataURL("image/jpeg", 0.85),
    () => canvas.toDataURL("image/jpeg", 0.65),
  ];
  for (const encode of candidates) {
    const url = encode();
    if (
      /^data:image\/(?:jpeg|png|webp);base64,/.test(url) &&
      url.length <= AVATAR_IMAGE_MAX_LENGTH
    ) {
      return url;
    }
  }
  throw new Error("Avatar image is too large.");
}
