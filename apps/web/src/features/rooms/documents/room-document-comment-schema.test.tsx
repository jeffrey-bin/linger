import { BlockNoteEditor } from "@blocknote/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { roomDocumentCommentSchema } from "./room-document-comment-schema";
import { insertRoomDocumentClipboardLink } from "./room-document-clipboard-link";
import { RoomDocumentReference } from "./room-document-reference";

describe("Room Document inline schema", () => {
  it("parses and renders a canonical Document link without exposing its URL", async () => {
    const url = `${window.location.origin}/t/tenant-1/documents/document-1`;
    const editor = BlockNoteEditor.create({
      initialContent: [
        {
          content: "",
          type: "paragraph",
        },
      ],
      schema: roomDocumentCommentSchema,
    });
    const inserted = insertRoomDocumentClipboardLink(
      editor,
      {
        getData: (type) =>
          type === "text/html"
            ? `<a href="${url}" data-linger-document-id="document-1" data-linger-tenant-id="tenant-1">Launch plan</a>`
            : url,
      },
      window.location.origin,
      "tenant-1",
    );

    expect(inserted).toBe(true);
    expect(editor.document[0]?.content).toEqual([
      {
        props: {
          documentId: "document-1",
          href: url,
          label: "Launch plan",
          tenantId: "tenant-1",
        },
        type: "documentLink",
      },
    ]);

    render(
      <RoomDocumentReference
        documentId="document-1"
        href={url}
        label="Launch plan"
        tenantId="tenant-1"
      />,
    );
    const link = screen.getByRole("link", { name: "Launch plan" });
    expect(link).toHaveTextContent("Launch plan");
    expect(link).toHaveAttribute("href", url);
    expect(link.querySelector("svg")).not.toBeNull();

    editor.unmount();
  });
});
