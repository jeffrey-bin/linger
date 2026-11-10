import { BlockNoteEditor } from "@blocknote/core";
import { describe, expect, it } from "vitest";

import { roomDocumentCommentSchema } from "./room-document-comment-schema";
import {
  filterRoomDocumentSlashMenuItems,
  getRoomDocumentSlashMenuItems,
} from "./room-document-slash-menu";

describe("Room Document slash menu", () => {
  it("inserts Mermaid as a structured code block", () => {
    const editor = BlockNoteEditor.create({
      initialContent: [{ content: "/", type: "paragraph" }],
      schema: roomDocumentCommentSchema,
    });
    const mermaid = getRoomDocumentSlashMenuItems(editor).find(
      (item) => item.title === "Mermaid diagram",
    );

    expect(mermaid).toBeDefined();
    mermaid?.onItemClick();

    expect(editor.document).toHaveLength(1);
    expect(editor.document[0]).toMatchObject({
      props: { language: "mermaid" },
      type: "codeBlock",
    });
  });

  it("places Mermaid after the default slash menu items", () => {
    const editor = BlockNoteEditor.create({
      schema: roomDocumentCommentSchema,
    });
    const items = getRoomDocumentSlashMenuItems(editor);

    expect(items.at(-1)?.title).toBe("Mermaid diagram");
  });

  it("prefers title matches over broad default aliases", () => {
    const editor = BlockNoteEditor.create({
      schema: roomDocumentCommentSchema,
    });

    expect(
      filterRoomDocumentSlashMenuItems(editor, "Me").map((item) => item.title),
    ).toEqual(["Mermaid diagram"]);
  });
});
