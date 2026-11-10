let loadedEditor:
  | typeof import("./room-document-blocknote-editor").RoomDocumentBlockNoteEditor
  | undefined;

export function getPreloadedDocumentEditor() {
  return loadedEditor;
}

let editorModule:
  | Promise<typeof import("./room-document-blocknote-editor")>
  | undefined;

export function preloadDocumentEditor() {
  editorModule ??= import("./room-document-blocknote-editor")
    .then((module) => {
      loadedEditor = module.RoomDocumentBlockNoteEditor;
      return module;
    })
    .catch((error: unknown) => {
      editorModule = undefined;
      throw error;
    });
  return editorModule;
}
