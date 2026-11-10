let documentPageModule:
  | Promise<typeof import("./room-document-surface")>
  | undefined;

export function preloadUnifiedDocumentPage() {
  documentPageModule ??= import("./room-document-surface");
  return documentPageModule;
}
