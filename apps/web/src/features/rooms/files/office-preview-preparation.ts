import { loadOfficePreviewFrameSource } from "./office-preview-frame-source";
import {
  getOfficePreviewExtension,
  isOfficePreviewMediaTypeCompatible,
} from "./office-preview-file-metadata";

let adapterModule:
  | Promise<typeof import("./office-preview-adapter")>
  | undefined;
export function loadOfficePreviewAdapter() {
  adapterModule ??= import("./office-preview-adapter").catch((error) => {
    adapterModule = undefined;
    throw error;
  });
  return adapterModule;
}
/** Prepare code only after an explicit open; the frame module never runs in the parent. */
export function prepareOfficePreview(filename: string, mediaType: string) {
  const extension = getOfficePreviewExtension(filename);
  if (!extension || !isOfficePreviewMediaTypeCompatible(extension, mediaType))
    return;
  void loadOfficePreviewFrameSource(filename).catch(() => undefined);
  // A failed speculative code load must still let the normal lazy boundary retry.
  void loadOfficePreviewAdapter().catch(() => undefined);
}
