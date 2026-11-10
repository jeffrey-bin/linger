import type { BlockNoteEditor } from "@blocknote/core";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { restoreRoomDocumentCollaborationUndo } from "./room-document-undo";

describe("Room Document collaboration undo", () => {
  it("restores the existing undo manager after BlockNote destroys it during a view remount", () => {
    const document = new Y.Doc();
    const content = document.getText("content");
    const undoManager = new Y.UndoManager(content);
    const editor = createEditor({ undoManager });
    undoManager.destroy();

    restoreRoomDocumentCollaborationUndo(editor);
    document.transact(() => content.insert(0, "restored"), undoManager);

    expect(undoManager.trackedOrigins).toContain(undoManager);
    expect(undoManager.undoStack).toHaveLength(1);
    expect(editor.unregisterExtension).not.toHaveBeenCalled();
    expect(editor.registerExtension).not.toHaveBeenCalled();
  });

  it("restores the same manager across repeated view remounts without duplicate tracking", () => {
    const document = new Y.Doc();
    const content = document.getText("content");
    const undoManager = new Y.UndoManager(content);
    const editor = createEditor({ undoManager });

    undoManager.destroy();
    restoreRoomDocumentCollaborationUndo(editor);
    undoManager.destroy();
    restoreRoomDocumentCollaborationUndo(editor);
    document.transact(() => content.insert(0, "once"), undoManager);

    expect(undoManager.undoStack).toHaveLength(1);
    expect(editor.unregisterExtension).not.toHaveBeenCalled();
    expect(editor.registerExtension).not.toHaveBeenCalled();
  });

  it("keeps a live collaboration undo manager registered", () => {
    const undoManager = { trackedOrigins: new Set<unknown>() };
    undoManager.trackedOrigins.add(undoManager);
    const editor = createEditor({ undoManager });

    restoreRoomDocumentCollaborationUndo(editor);

    expect(editor.unregisterExtension).not.toHaveBeenCalled();
    expect(editor.registerExtension).not.toHaveBeenCalled();
  });

  it("does nothing while the collaboration undo state is unavailable", () => {
    const editor = createEditor(undefined);

    restoreRoomDocumentCollaborationUndo(editor);

    expect(editor.unregisterExtension).not.toHaveBeenCalled();
    expect(editor.registerExtension).not.toHaveBeenCalled();
  });
});

function createEditor(
  stateOrReader:
    | (() => { undoManager: Y.UndoManager } | undefined)
    | { undoManager: Y.UndoManager | { trackedOrigins: Set<unknown> } }
    | undefined,
): BlockNoteEditor {
  const readState =
    typeof stateOrReader === "function" ? stateOrReader : () => stateOrReader;
  return {
    getExtension: vi.fn(() => ({
      prosemirrorPlugins: [{ getState: readState }],
    })),
    prosemirrorState: {},
    registerExtension: vi.fn(),
    unregisterExtension: vi.fn(),
  } as unknown as BlockNoteEditor;
}
