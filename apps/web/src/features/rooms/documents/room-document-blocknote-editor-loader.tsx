import { lazy, Suspense, useState } from "react";
import {
  getPreloadedDocumentEditor,
  preloadDocumentEditor,
} from "./document-editor-preload";

import type { RoomDocumentBlockNoteEditorProps } from "./room-document-blocknote-editor";

const LazyRoomDocumentBlockNoteEditor = lazy(() =>
  preloadDocumentEditor().then((module) => ({
    default: module.RoomDocumentBlockNoteEditor,
  })),
);

export function RoomDocumentBlockNoteEditor(
  props: RoomDocumentBlockNoteEditorProps,
) {
  // Keep the selected component type for this mount: switching from lazy to
  // direct after hydration would remount the editor and lose its selection.
  const [Editor] = useState(
    () => getPreloadedDocumentEditor() ?? LazyRoomDocumentBlockNoteEditor,
  );
  return (
    <Suspense
      fallback={
        <section
          aria-busy="true"
          aria-label="Loading Room Document editor"
          className="room-document-blocknote min-h-[420px]"
          role="status"
        />
      }
    >
      <Editor {...props} />
    </Suspense>
  );
}
