import type {
  BlockNoteEditor,
  BlockSchema,
  InlineContentSchema,
  StyleSchema,
} from "@blocknote/core";
import { YUndoExtension } from "@blocknote/core/extensions";

export function restoreRoomDocumentCollaborationUndo<
  BSchema extends BlockSchema,
  ISchema extends InlineContentSchema,
  SSchema extends StyleSchema,
>(editor: BlockNoteEditor<BSchema, ISchema, SSchema>): void {
  const undoManager = editor
    .getExtension(YUndoExtension)
    ?.prosemirrorPlugins[0].getState(editor.prosemirrorState)?.undoManager;

  if (!undoManager || undoManager.trackedOrigins.has(undoManager)) return;

  // BlockNote remounts its ProseMirror view when `editable` changes. The
  // y-prosemirror view destroys this manager during that remount, but the
  // plugin state and undo history remain valid and are reused by the new view.
  undoManager.trackedOrigins.add(undoManager);
  undoManager.doc.on("afterTransaction", undoManager.afterTransactionHandler);
}
