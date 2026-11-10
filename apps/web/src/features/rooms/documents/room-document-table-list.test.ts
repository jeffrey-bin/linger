import { BlockNoteEditor } from "@blocknote/core";
import { describe, expect, it } from "vitest";

import { roomDocumentCommentSchema } from "./room-document-comment-schema";
import { getRoomDocumentSlashMenuItems } from "./room-document-slash-menu";
import {
  continueTableCellList,
  insertTableCellList,
} from "./room-document-table-list";

function tableEditor(text = "Alpha") {
  const editor = BlockNoteEditor.create({
    schema: roomDocumentCommentSchema,
    initialContent: [
      {
        id: "table",
        type: "table",
        content: {
          type: "tableContent",
          rows: [{ cells: [text, "Other cell"] }],
        },
      },
    ],
  });
  editor.setTextCursorPosition("table", "start");
  return editor;
}

describe("table cell list commands", () => {
  it("converts the current line without replacing the table or other cells", () => {
    const editor = tableEditor();
    const bullet = getRoomDocumentSlashMenuItems(editor).find(
      (item) => item.title === editor.dictionary.slash_menu.bullet_list.title,
    )!;
    bullet.onItemClick();
    expect(editor.document).toHaveLength(1);
    expect(editor.document[0]).toMatchObject({
      type: "table",
      content: {
        rows: [
          {
            cells: [
              { content: [{ text: "• Alpha" }] },
              { content: [{ text: "Other cell" }] },
            ],
          },
        ],
      },
    });
    insertTableCellList(editor, "numbered");
    expect(editor.prosemirrorState.doc.textContent).toBe("1. AlphaOther cell");
    editor._tiptapEditor.destroy();
  });

  it("preserves list markers and line breaks through the existing document schema", () => {
    const editor = tableEditor("");
    insertTableCellList(editor, "numbered");
    editor.insertInlineContent("Alpha", { updateSelection: true });
    expect(continueTableCellList(editor)).toBe(true);
    editor.insertInlineContent("Beta", { updateSelection: true });
    const saved = editor.document;
    const restored = BlockNoteEditor.create({
      schema: roomDocumentCommentSchema,
      initialContent: saved,
    });
    expect(restored.document).toEqual(saved);
    expect(restored.document[0]).toMatchObject({
      content: {
        rows: [{ cells: [{ content: [{ text: "1. Alpha\n2. Beta" }] }, {}] }],
      },
    });
    editor._tiptapEditor.destroy();
    restored._tiptapEditor.destroy();
  });

  it("leaves ordinary paragraphs and normal table Enter behavior alone", () => {
    const editor = BlockNoteEditor.create({
      schema: roomDocumentCommentSchema,
      initialContent: [{ type: "paragraph", content: "Normal text" }],
    });
    expect(insertTableCellList(editor, "bullet")).toBe(false);
    expect(continueTableCellList(editor)).toBe(false);
    const table = tableEditor();
    expect(continueTableCellList(table)).toBe(false);
    editor._tiptapEditor.destroy();
    table._tiptapEditor.destroy();
  });
});
