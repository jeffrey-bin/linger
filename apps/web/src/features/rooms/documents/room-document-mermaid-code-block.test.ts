// @vitest-environment jsdom
import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { roomDocumentCommentSchema } from "./room-document-comment-schema";
import { mermaidSourceFromCodeBlock } from "./room-document-mermaid-code-block";

vi.mock("../mermaid-preview-adapter", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../mermaid-preview-adapter")>();
  return {
    ...original,
    renderMermaidSvg: vi
      .fn()
      .mockResolvedValue(
        '<svg xmlns="http://www.w3.org/2000/svg"><text>Diagram</text></svg>',
      ),
  };
});

describe("Room Document Mermaid code block", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => vi.unstubAllGlobals());
  it("keeps Mermaid as a standard codeBlock with inline source", async () => {
    const editor = BlockNoteEditor.create({
      schema: roomDocumentCommentSchema,
    });
    const blocks = editor.tryParseMarkdownToBlocks(
      "```mermaid\ngraph TD\n  A --> B\n```",
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      props: { language: "mermaid" },
      type: "codeBlock",
    });
    expect(blocks[0]?.content).toEqual([
      {
        styles: {},
        text: "graph TD\n  A --> B",
        type: "text",
      },
    ]);
  });

  it("recognizes a fenced Mermaid document pasted into a plain code block", () => {
    expect(
      mermaidSourceFromCodeBlock(
        "text",
        "```mermaid\ngraph TD\n  A --> B\n```",
      ),
    ).toBe("graph TD\n  A --> B");
    expect(
      mermaidSourceFromCodeBlock("text", "const answer: number = 42;"),
    ).toBeUndefined();
  });

  it("keeps an explicit code language out of Mermaid detection", () => {
    expect(
      mermaidSourceFromCodeBlock("python", "graph TD\n  A --> B"),
    ).toBeUndefined();
    expect(
      mermaidSourceFromCodeBlock("typescript", "sequenceDiagram\n  A->>B: Hi"),
    ).toBeUndefined();
  });

  it("recognizes a diagram whose code block lost its language", () => {
    expect(
      mermaidSourceFromCodeBlock("text", "sequenceDiagram\n  A->>B: Hi"),
    ).toBe("sequenceDiagram\n  A->>B: Hi");
    expect(mermaidSourceFromCodeBlock("text", "graph TD\n  A --> B")).toBe(
      "graph TD\n  A --> B",
    );
    expect(
      mermaidSourceFromCodeBlock("text", "graphql query { user { id } }"),
    ).toBeUndefined();
  });

  it("uses the full source of a structured Mermaid code block", () => {
    expect(
      mermaidSourceFromCodeBlock("mermaid", "sequenceDiagram\n  A->>B: Hi"),
    ).toBe("sequenceDiagram\n  A->>B: Hi");
  });

  it("preserves ordinary code block languages and the default BlockNote UI", async () => {
    const editor = BlockNoteEditor.create({
      initialContent: [
        {
          content: "const answer: number = 42;",
          props: { language: "typescript" },
          type: "codeBlock",
        },
      ],
      schema: roomDocumentCommentSchema,
    });
    const host = window.document.createElement("div");
    window.document.body.appendChild(host);
    editor.mount(host);
    await nextTask();

    expect(editor.document[0]).toMatchObject({
      props: { language: "typescript" },
      type: "codeBlock",
    });
    expect(host.querySelector(".room-document-mermaid")).toBeNull();
    expect(host.querySelector("pre code")?.textContent).toBe(
      "const answer: number = 42;",
    );

    editor.unmount();
    host.remove();
  });

  it("removes a fenced wrapper after a plain block becomes Mermaid", () => {
    expect(
      mermaidSourceFromCodeBlock(
        "mermaid",
        "```mermaid\ngraph TD\n  A --> B\n```",
      ),
    ).toBe("graph TD\n  A --> B");
  });

  it("does not mutate the collaborative document when edit mode changes", async () => {
    const seed = BlockNoteEditor.create({
      initialContent: [
        {
          content: "```mermaid\ngraph TD\n  A --> B\n```",
          props: { language: "text" },
          type: "codeBlock",
        },
      ],
      schema: roomDocumentCommentSchema,
    });
    const document = new Y.Doc({ gc: true });
    blocksToYXmlFragment(
      seed,
      seed.document,
      document.getXmlFragment("prosemirror"),
    );
    seed.unmount();

    const editor = BlockNoteEditor.create({
      collaboration: {
        fragment: document.getXmlFragment("prosemirror"),
        user: {
          actorId: "actor-human-one",
          color: "#0f766e",
          name: "Human One",
        },
      },
      schema: roomDocumentCommentSchema,
    });
    const interval = vi.spyOn(window, "setInterval");
    const host = window.document.createElement("div");
    window.document.body.appendChild(host);
    editor.mount(host);
    await nextTask(100);

    let updates = 0;
    document.on("update", () => {
      updates += 1;
    });
    editor.isEditable = false;
    await nextTask(80);
    expect(
      host.querySelector<HTMLElement>(".room-document-mermaid__source")?.hidden,
    ).toBe(true);
    expect(
      host.querySelector<HTMLElement>(".room-document-mermaid__preview")
        ?.hidden,
    ).toBe(false);
    editor.isEditable = true;
    await nextTask(80);
    // Editing reveals the toolbar and leaves the reader on the diagram.
    expect(
      host.querySelector<HTMLElement>(".room-document-mermaid__toolbar")
        ?.hidden,
    ).toBe(false);
    expect(
      host.querySelector<HTMLElement>(".room-document-mermaid__source")?.hidden,
    ).toBe(true);

    expect(updates).toBe(0);
    // The Read/Edit switch is observed, not polled.
    expect(interval).not.toHaveBeenCalledWith(expect.any(Function), 50);
    interval.mockRestore();
    editor.unmount();
    document.destroy();
    host.remove();
  });

  it("opens Preview without a rendering placeholder or document updates", async () => {
    const seed = BlockNoteEditor.create({
      initialContent: [
        {
          content: "graph TD\n  A --> B",
          props: { language: "mermaid" },
          type: "codeBlock",
        },
      ],
      schema: roomDocumentCommentSchema,
    });
    const document = new Y.Doc({ gc: true });
    blocksToYXmlFragment(
      seed,
      seed.document,
      document.getXmlFragment("prosemirror"),
    );
    seed.unmount();
    const editor = BlockNoteEditor.create({
      collaboration: {
        fragment: document.getXmlFragment("prosemirror"),
        user: {
          actorId: "actor-human-one",
          color: "#0f766e",
          name: "Human One",
        },
      },
      schema: roomDocumentCommentSchema,
    });
    const host = window.document.createElement("div");
    window.document.body.appendChild(host);
    editor.mount(host);
    await nextTask(100);

    let updates = 0;
    document.on("update", () => {
      updates += 1;
    });
    const previewButton = host.querySelector<HTMLButtonElement>(
      ".room-document-mermaid__mode:last-child",
    );
    const source = host.querySelector<HTMLElement>(
      ".room-document-mermaid__source",
    );
    const preview = host.querySelector<HTMLElement>(
      ".room-document-mermaid__preview",
    );
    const before = editor.document;

    expect(previewButton?.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector("select")).toBeNull();
    expect(
      host.querySelector(".room-document-mermaid__language")?.textContent,
    ).toBe("Mermaid");
    expect(source?.hidden).toBe(true);
    expect(preview?.hidden).toBe(false);
    expect(preview?.textContent).not.toContain("Rendering diagram");
    expect(editor.document).toEqual(before);
    expect(updates).toBe(0);
    editor.unmount();
    document.destroy();
    host.remove();
  });

  it("opens an empty Mermaid block on Source without a syntax error", async () => {
    const editor = BlockNoteEditor.create({
      initialContent: [
        { content: "", props: { language: "mermaid" }, type: "codeBlock" },
      ],
      schema: roomDocumentCommentSchema,
    });
    const host = window.document.createElement("div");
    window.document.body.appendChild(host);
    editor.mount(host);
    await nextTask(100);

    const surface = host.querySelector<HTMLElement>(".room-document-mermaid");
    expect(surface?.dataset.mode).toBe("source");
    expect(
      host.querySelector<HTMLElement>(".room-document-mermaid__source")?.hidden,
    ).toBe(false);
    expect(host.querySelector(".room-document-mermaid__error")).toBeNull();
    expect(
      host.querySelector(".room-document-mermaid__preview")?.textContent,
    ).toContain("Add Mermaid source");

    editor.unmount();
    host.remove();
  });

  it("copies the complete source through the Clipboard API", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const editor = BlockNoteEditor.create({
      initialContent: [
        {
          content: "graph TD\n  A --> B",
          props: { language: "mermaid" },
          type: "codeBlock",
        },
      ],
      schema: roomDocumentCommentSchema,
    });
    const host = window.document.createElement("div");
    window.document.body.appendChild(host);
    editor.mount(host);
    await nextTask();

    host
      .querySelector<HTMLButtonElement>(".room-document-mermaid__copy")
      ?.click();
    await nextTask();

    expect(writeText).toHaveBeenCalledWith("graph TD\n  A --> B");
    expect(
      host.querySelector(".room-document-mermaid__copy")?.textContent,
    ).toBe("Copied");
    editor.unmount();
    host.remove();
  });

  it("lets the browser place the Source caret and drag a selection", async () => {
    const editor = BlockNoteEditor.create({
      initialContent: [
        {
          content: "graph TD\n  A --> B",
          props: { language: "mermaid" },
          type: "codeBlock",
        },
      ],
      schema: roomDocumentCommentSchema,
    });
    const setTextCursorPosition = vi.spyOn(editor, "setTextCursorPosition");
    const host = window.document.createElement("div");
    window.document.body.appendChild(host);
    editor.mount(host);
    await nextTask();

    const mouseDown = new MouseEvent("mousedown", {
      cancelable: true,
    });
    host
      .querySelector<HTMLElement>(".room-document-mermaid__source")
      ?.dispatchEvent(mouseDown);

    expect(mouseDown.defaultPrevented).toBe(false);
    expect(setTextCursorPosition).not.toHaveBeenCalled();
    editor.unmount();
    host.remove();
  });
});

function nextTask(delay = 20) {
  return new Promise((resolve) => window.setTimeout(resolve, delay));
}
