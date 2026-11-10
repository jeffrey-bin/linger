// @vitest-environment jsdom
import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYXmlFragment, yDocToBlocks } from "@blocknote/core/yjs";
import { inspectRoomDocumentState } from "@linger/document-model";
import { TextSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { roomDocumentCommentSchema } from "./room-document-comment-schema";
import {
  looksLikeMarkdown,
  pasteRoomDocumentMarkdown,
  pasteRoomDocumentRichHtml,
  pasteRoomDocumentSourceCode,
  recoverRoomDocumentPastedMedia,
} from "./room-document-markdown-paste";

describe("Markdown detection", () => {
  it.each([
    ["ATX heading", "# Product plan\nFirst paragraph."],
    ["consecutive headings", "# Level one\n## Level two\n### Level three"],
    ["a single bullet", "- Only one item"],
    ["a list starting at one", "1. First step"],
    ["a numbered list", "3. Third step\n4. Fourth step"],
    ["a task list", "- [ ] Todo one\n- [x] Todo two"],
    ["a blockquote", "> A quoted line"],
    ["fenced code", "```ts\nconst a = 1;\n```"],
    ["a thematic break", "Above\n\n---\n\nBelow"],
    ["a table row", "| Capability | Notes |\n| --- | --- |\n| A | B |"],
    ["a link reference definition", "[lev8]: https://example.com"],
    ["an inline link", "See the notes in [the doc](https://example.com)"],
    ["bold text", "This is **bold** text"],
    ["strikethrough", "This is ~~deleted~~ text"],
    ["inline code", "Install with `npm i`"],
  ])("treats %s as Markdown", (_label, text) => {
    expect(looksLikeMarkdown(text)).toBe(true);
  });

  it.each([
    ["empty text", "   \n  "],
    ["plain prose", "This is ordinary prose without any markup."],
    ["a sentence starting with a year", "2024. We did a lot this year."],
    ["a bare URL", "https://example.com/a/b?c=1"],
    ["snake_case identifiers", "Send both the user_name and user_id fields."],
    ["arithmetic", "The result is 3 * 4 * 5 = 60"],
  ])("leaves %s as plain text", (_label, text) => {
    expect(looksLikeMarkdown(text)).toBe(false);
  });
});

describe("Markdown paste", () => {
  const mounted: Array<() => void> = [];
  afterEach(() => {
    for (const release of mounted.splice(0)) release();
    vi.unstubAllGlobals();
  });

  function editorWithEmptyBlock() {
    const editor = BlockNoteEditor.create({
      schema: roomDocumentCommentSchema,
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    editor.mount(host);
    mounted.push(() => {
      editor.unmount();
      host.remove();
    });
    return editor;
  }

  function clipboard(data: Record<string, string>) {
    return {
      getData: (type: string) => data[type] ?? "",
      types: Object.keys(data),
    } as unknown as DataTransfer;
  }

  it("repairs rejected media restored from an old draft without replacing surrounding blocks", () => {
    const editor = editorWithEmptyBlock();
    editor.replaceBlocks(editor.document, [
      {
        id: "original-text",
        type: "paragraph",
        content: "Body waiting to be saved",
        children: [
          {
            id: "pasted-image",
            type: "image",
            props: {
              url: "https://example.test/image.png",
              caption: "Flowchart",
            },
          },
        ],
      },
      {
        id: "uploaded-image",
        type: "image",
        props: { url: "document-asset:asset_1" },
      },
    ]);
    const state = new Y.Doc();
    try {
      const fragment = state.getXmlFragment("prosemirror");
      blocksToYXmlFragment(editor, editor.document, fragment);
      const originalText = [...fragment.createTreeWalker(() => true)].find(
        (node): node is Y.XmlText => node instanceof Y.XmlText,
      )!;
      originalText.format(0, 2, { comment: { threadId: "thread_1" } });
      const originalDelta = originalText.toDelta();
      const inspect = () =>
        inspectRoomDocumentState(Y.encodeStateAsUpdate(state));
      expect(inspect).toThrow("Room Document Asset reference is invalid");
      recoverRoomDocumentPastedMedia(state);
      expect(inspect()).toMatchObject({
        completeReferences: {
          documentAssetIds: ["asset_1"],
          documentThreadIds: ["thread_1"],
        },
      });
      expect(originalText.toDelta()).toEqual(originalDelta);
      expect(yDocToBlocks(editor, state)).toMatchObject([
        {
          id: "original-text",
          children: [
            {
              id: "pasted-image",
              type: "paragraph",
              content: [
                { type: "link", href: "https://example.test/image.png" },
              ],
            },
          ],
        },
        { id: "uploaded-image", type: "image" },
      ]);
      const repaired = Y.encodeStateAsUpdate(state);
      recoverRoomDocumentPastedMedia(state);
      expect(Y.encodeStateAsUpdate(state)).toEqual(repaired);
    } finally {
      state.destroy();
    }
  });

  it.each([
    [
      "rich HTML",
      {
        "text/html":
          '<h1>Summary</h1><ul><li>User positioning<ul><li>Body kept</li></ul></li></ul><img src="https://example.test/meeting.png" alt="Meeting flowchart">',
      },
    ],
    [
      "Markdown",
      {
        "text/plain":
          "# Summary\n\n- User positioning\n  - Body kept\n\n![Meeting flowchart](https://example.test/meeting.png)",
      },
    ],
    [
      "table image",
      {
        "text/html":
          '<table><tr><td>Body kept</td><td><img src="https://example.test/meeting.png" alt="Meeting flowchart"></td></tr></table>',
      },
    ],
  ])(
    "keeps %s media as links in a valid collaborative document",
    (_kind, data) => {
      const editor = editorWithEmptyBlock();
      const transfer = clipboard(data);
      expect(
        pasteRoomDocumentRichHtml(editor, transfer) ||
          pasteRoomDocumentMarkdown(editor, transfer),
      ).toBe(true);
      const state = new Y.Doc();
      try {
        blocksToYXmlFragment(
          editor,
          editor.document,
          state.getXmlFragment("prosemirror"),
        );
        expect(
          inspectRoomDocumentState(Y.encodeStateAsUpdate(state)),
        ).toMatchObject({ hasMediaBlocks: false });
        expect(JSON.stringify(editor.document)).toContain("Body kept");
        expect(JSON.stringify(editor.document)).toContain(
          '"href":"https://example.test/meeting.png"',
        );
      } finally {
        state.destroy();
      }
    },
  );

  it("keeps remote media safe when replacing part of a paragraph", () => {
    vi.stubGlobal("ClipboardEvent", class extends Event {});
    const editor = editorWithEmptyBlock();
    editor.replaceBlocks(editor.document, [
      { type: "paragraph", content: "before selected after" },
    ]);
    editor.transact((tr) =>
      tr.setSelection(TextSelection.create(tr.doc, 10, 18)),
    );
    expect(
      pasteRoomDocumentRichHtml(
        editor,
        clipboard({
          "text/html":
            '<img src="https://example.test/image.png" alt="Diagram">',
        }),
      ),
    ).toBe(true);
    expect(JSON.stringify(editor.document)).toContain("before ");
    expect(JSON.stringify(editor.document)).toContain(" after");
    expect(JSON.stringify(editor.document)).not.toContain("selected");
    expect(JSON.stringify(editor.document)).toContain(
      '"href":"https://example.test/image.png"',
    );
  });

  it.each(["---", "\\---"])(
    "preserves %s frontmatter as YAML rather than a heading",
    (delimiter) => {
      const editor = editorWithEmptyBlock();
      const metadata = `${delimiter}\ntype: Process\ntitle: Multichannel outreach\ngraph:\n\u00a0 schema\\_version: 1\ngenerated: { by: "openwiki/0.4.3" }\n${delimiter}`;
      expect(
        pasteRoomDocumentMarkdown(
          editor,
          clipboard({
            "text/plain": metadata + "\n\n# Body\n\nNormal Markdown.",
          }),
        ),
      ).toBe(true);
      expect(editor.document[0]).toMatchObject({
        type: "codeBlock",
        props: { language: "yaml" },
      });
      expect(editor.document[0]?.content).toEqual([
        { type: "text", text: metadata, styles: {} },
      ]);
      expect(editor.document.map((block) => block.type)).toEqual([
        "codeBlock",
        "heading",
        "paragraph",
      ]);
    },
  );

  it("replaces all selected blocks with frontmatter and Markdown body", () => {
    const editor = editorWithEmptyBlock();
    editor.replaceBlocks(editor.document, [
      { type: "codeBlock", props: { language: "yaml" }, content: "type: Old" },
      { type: "paragraph", content: "Old body" },
    ]);
    editor.transact((tr) =>
      tr.setSelection(
        TextSelection.between(
          tr.doc.resolve(0),
          tr.doc.resolve(tr.doc.content.size),
        ),
      ),
    );
    expect(
      pasteRoomDocumentMarkdown(
        editor,
        clipboard({ "text/plain": "---\ntitle: Example\n---\n\nNew body" }),
      ),
    ).toBe(true);
    expect(editor.document.map((block) => block.type)).toEqual([
      "codeBlock",
      "paragraph",
    ]);
    expect(JSON.stringify(editor.document)).not.toContain("Old body");
    expect(JSON.stringify(editor.document)).toContain("New body");
  });

  it("does not treat ordinary thematic breaks or unclosed metadata as YAML", () => {
    const editor = editorWithEmptyBlock();
    for (const source of [
      "---\nOrdinary prose\n---",
      "---\ntitle: Not closed",
    ]) {
      editor.replaceBlocks(editor.document, [
        { type: "paragraph", content: "" },
      ]);
      pasteRoomDocumentMarkdown(editor, clipboard({ "text/plain": source }));
      expect(editor.document.some((block) => block.type === "codeBlock")).toBe(
        false,
      );
    }
  });

  it("parses Markdown copied out of a Markdown-mode editor", () => {
    const editor = editorWithEmptyBlock();

    expect(
      pasteRoomDocumentMarkdown(
        editor,
        clipboard({
          "text/plain": "# Title\n\nBody.",
          "vscode-editor-data": JSON.stringify({ mode: "markdown" }),
        }),
      ),
    ).toBe(true);
    expect(editor.document.map((block) => block.type)).toEqual([
      "heading",
      "paragraph",
    ]);
  });

  it("leaves code copied out of a code editor to the default handler", () => {
    const editor = editorWithEmptyBlock();

    expect(
      pasteRoomDocumentMarkdown(
        editor,
        clipboard({
          "text/plain": "# comment\nconst a = 1;",
          "vscode-editor-data": JSON.stringify({ mode: "typescript" }),
        }),
      ),
    ).toBe(false);
  });

  it("leaves BlockNote's own clipboard payload and plain prose alone", () => {
    const editor = editorWithEmptyBlock();

    expect(
      pasteRoomDocumentMarkdown(
        editor,
        clipboard({
          "blocknote/html": "<p>x</p>",
          "text/plain": "# Title",
        }),
      ),
    ).toBe(false);
    expect(
      pasteRoomDocumentMarkdown(
        editor,
        clipboard({ "text/plain": "This is ordinary prose with no markup." }),
      ),
    ).toBe(false);
  });

  it("leaves rich HTML with a Markdown-looking fallback to the rich paste handler", () => {
    const editor = editorWithEmptyBlock();

    expect(
      pasteRoomDocumentMarkdown(
        editor,
        clipboard({
          "text/html": "<h1>Title</h1><p><strong>Body</strong></p>",
          "text/plain": "# Title\n\n**Body**",
        }),
      ),
    ).toBe(false);
    expect(editor.document).toMatchObject([{ type: "paragraph" }]);
  });

  it("preserves headings and inline marks from a rich HTML clipboard", () => {
    const editor = editorWithEmptyBlock();

    expect(
      pasteRoomDocumentRichHtml(
        editor,
        clipboard({
          "text/html":
            "<h1>Method notes</h1><p><strong>Data sources and tools</strong></p><ul><li>Full search</li></ul>",
          "text/plain": "Method notes\nData sources and tools\nFull search",
        }),
      ),
    ).toBe(true);
    expect(editor.document.map((block) => block.type)).toEqual([
      "heading",
      "paragraph",
      "bulletListItem",
    ]);
    expect(editor.document[1]?.content).toMatchObject([
      { styles: { bold: true }, text: "Data sources and tools" },
    ]);
  });
});

describe("Source code paste", () => {
  const mounted: Array<() => void> = [];
  afterEach(() => {
    for (const release of mounted.splice(0)) release();
  });

  function editorWithEmptyBlock() {
    const editor = BlockNoteEditor.create({
      schema: roomDocumentCommentSchema,
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    editor.mount(host);
    mounted.push(() => {
      editor.unmount();
      host.remove();
    });
    return editor;
  }

  function codeClipboard(text: string, mode: string) {
    const data: Record<string, string> = {
      "text/plain": text,
      "vscode-editor-data": JSON.stringify({ mode }),
    };
    return {
      getData: (type: string) => data[type] ?? "",
      types: Object.keys(data),
    } as unknown as DataTransfer;
  }

  it("keeps an excerpt copied out of a code editor as a code block", () => {
    const editor = editorWithEmptyBlock();

    expect(
      pasteRoomDocumentSourceCode(
        editor,
        codeClipboard("const a = 1;\nconst b = 2;", "typescript"),
      ),
    ).toBe(true);
    expect(editor.document).toMatchObject([
      { props: { language: "typescript" }, type: "codeBlock" },
    ]);
  });

  it("leaves a single copied line and Markdown source to the other handlers", () => {
    const editor = editorWithEmptyBlock();

    expect(
      pasteRoomDocumentSourceCode(
        editor,
        codeClipboard("const a = 1;", "typescript"),
      ),
    ).toBe(false);
    expect(
      pasteRoomDocumentSourceCode(
        editor,
        codeClipboard("# Title\n\nBody.", "markdown"),
      ),
    ).toBe(false);
  });
});
