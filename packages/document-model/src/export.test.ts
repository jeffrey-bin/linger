import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import {
  exportRoomDocumentRevision,
  fingerprintRoomDocumentState,
  inspectRoomDocumentState,
  materializeRoomDocument,
} from "./index.js";

describe("exportRoomDocumentRevision", () => {
  it("preserves stable block IDs in HTML for semantic editing", async () => {
    const state = stateWithBlocks([
      { id: "block_heading", type: "heading", content: "Report" },
      { id: "block_paragraph", type: "paragraph", content: "Original text" },
    ]);
    const exported = await exportRoomDocumentRevision({
      revisionId: "revision_html_edit",
      schemaVersion: 1,
      state,
      assetManifest: [],
      format: "html",
    });
    const element = document.createElement("div");
    element.innerHTML = new TextDecoder().decode(exported.bytes);
    expect(
      element.querySelector('[data-id="block_heading"]')?.textContent,
    ).toBe("Report");
    expect(
      element.querySelector('[data-id="block_paragraph"]')?.textContent,
    ).toBe("Original text");
  });
  it("releases media renderer listeners after repeated HTML exports", async () => {
    const state = stateWithBlocks([
      {
        id: "block_image",
        type: "image",
        props: { url: "document-asset:asset_image" },
      },
      {
        id: "block_file",
        type: "file",
        props: { url: "document-asset:asset_file", name: "Guide" },
      },
    ]);
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    try {
      for (let iteration = 0; iteration < 5; iteration++) {
        const exported = await exportRoomDocumentRevision({
          revisionId: "revision_media_html",
          schemaVersion: 1,
          state,
          assetManifest: [
            asset("asset_file", "application/pdf", "Guide"),
            asset("asset_image", "image/png", "Image"),
          ],
          format: "html",
        });
        const html = new TextDecoder().decode(exported.bytes);
        expect(html).toContain("document-asset:asset_image");
        expect(html).toContain("document-asset:asset_file");
        await new Promise((resolve) => setTimeout(resolve, 0));
        for (const [type, listener] of add.mock.calls) {
          expect(
            remove.mock.calls.some(
              ([removedType, removedListener]) =>
                removedType === type && removedListener === listener,
            ),
          ).toBe(true);
        }
      }
    } finally {
      // Cleanup the defective implementation too, so the red test is isolated.
      for (const [type, listener, options] of add.mock.calls)
        window.removeEventListener(type, listener, options);
      add.mockRestore();
      remove.mockRestore();
    }
  });
  it("deterministically exports immutable Room Document state as Markdown", async () => {
    const state = await materializeRoomDocument({
      materializationId: "00000000-0000-4000-8000-000000000041",
      schemaVersion: 1,
      sourceKind: "plain_text",
      sourceBytes: new TextEncoder().encode("Alpha\nBeta"),
    });

    const first = await exportRoomDocumentRevision({
      revisionId: "document_revision_export_fixture",
      schemaVersion: 1,
      state,
      assetManifest: [],
      format: "markdown",
    });
    const replay = await exportRoomDocumentRevision({
      revisionId: "document_revision_export_fixture",
      schemaVersion: 1,
      state,
      assetManifest: [],
      format: "markdown",
    });

    expect(new TextDecoder().decode(first.bytes)).toBe("Alpha\n\nBeta");
    expect(first).toEqual({
      mediaType: "text/markdown",
      bytes: new TextEncoder().encode("Alpha\n\nBeta"),
      sizeBytes: 11,
      sha256:
        "611a167854cd6d1c92d7fbcc4ca9b3887ab9cec955ef0e11d4a8dfa3f0596cc4",
      completeReferences: {
        documentAssetIds: [],
        documentThreadIds: [],
      },
      warnings: [],
    });
    expect(replay).toEqual(first);
  });

  it.each(["\n", "\n\n", " ", "\t", "\u00a0"])(
    "exports blank paragraph %j without rejecting neighboring visible content",
    async (blank) => {
      const state = stateWithBlocks([
        { id: "block_before", type: "paragraph", content: "Before" },
        { id: "block_blank", type: "paragraph", content: blank },
        {
          id: "block_diagram",
          type: "codeBlock",
          props: { language: "mermaid" },
          content: "graph TD\n  Human --> Agent",
        },
      ]);
      const original = state.stateBytes.slice();
      const input = {
        revisionId: "revision_blank_paragraph",
        schemaVersion: 1,
        state,
        assetManifest: [],
        format: "markdown" as const,
      };
      const exported = await exportRoomDocumentRevision(input);
      const markdown = new TextDecoder().decode(exported.bytes);
      expect(markdown).toContain("Before");
      expect(markdown).toContain(
        "```mermaid\ngraph TD\n  Human --> Agent\n```",
      );
      expect(await exportRoomDocumentRevision(input)).toEqual(exported);
      expect(state.stateBytes).toEqual(original);
    },
  );

  it.each(["paragraph", "toggleListItem"] as const)(
    "preserves visible %s text when the Markdown converter drops it",
    async (type) => {
      const state = stateWithBlocks([
        { id: "block_visible", type, content: " Visible text " },
      ]);
      const exporter = vi
        .spyOn(BlockNoteEditor.prototype, "blocksToMarkdownLossy")
        .mockReturnValue("");
      try {
        const result = await exportRoomDocumentRevision({
          revisionId: "revision_visible_text",
          schemaVersion: 1,
          state,
          assetManifest: [],
          format: "markdown",
        });
        expect(new TextDecoder().decode(result.bytes)).toContain(
          "Visible text",
        );
      } finally {
        exporter.mockRestore();
      }
    },
  );

  it("round-trips an editable Mermaid code block through Markdown", async () => {
    const source = "```mermaid\ngraph TD\n  Human --> Agent\n```";
    const state = await materializeRoomDocument({
      materializationId: "00000000-0000-4000-8000-000000000042",
      schemaVersion: 1,
      sourceKind: "markdown",
      sourceBytes: new TextEncoder().encode(source),
    });

    const exported = await exportRoomDocumentRevision({
      assetManifest: [],
      format: "markdown",
      revisionId: "document_revision_mermaid",
      schemaVersion: 1,
      state,
    });

    expect(new TextDecoder().decode(exported.bytes)).toBe(source);
  });

  it("preserves Default Schema media and toggle content through deterministic Markdown downgrades", async () => {
    const state = stateWithBlocks([
      {
        id: "block_toggle",
        type: "toggleListItem",
        content: "Release notes",
        children: [
          {
            id: "block_toggle_detail",
            type: "paragraph",
            content: "Hidden detail",
          },
        ],
      },
      {
        id: "block_image",
        type: "image",
        props: {
          caption: "Architecture diagram",
          name: "architecture.png",
          url: "document-asset:asset_image",
        },
      },
      {
        id: "block_file",
        type: "file",
        props: {
          name: "Roadmap",
          url: "document-asset:asset_file",
        },
      },
      {
        id: "block_video",
        type: "video",
        props: {
          caption: "Product demo",
          url: "document-asset:asset_video",
        },
      },
      {
        id: "block_audio",
        type: "audio",
        props: {
          name: "Customer interview",
          url: "document-asset:asset_audio",
        },
      },
      {
        id: "block_styled",
        type: "paragraph",
        props: { textColor: "red" },
        content: "Styled conclusion",
      },
      {
        id: "block_inline_styled",
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Inline style",
            styles: {
              underline: true,
              textColor: "blue",
              backgroundColor: "yellow",
            },
          },
        ],
      },
    ]);

    const exported = await exportRoomDocumentRevision({
      revisionId: "document_revision_rich_export",
      schemaVersion: 1,
      state,
      assetManifest: [
        asset("asset_audio", "audio/mpeg", "Customer interview"),
        asset("asset_file", "application/pdf", "Roadmap"),
        asset("asset_image", "image/png", "Architecture diagram"),
        asset("asset_video", "video/mp4", "Product demo"),
      ],
      format: "markdown",
    });

    expect(new TextDecoder().decode(exported.bytes)).toBe(
      [
        "<details>",
        "<summary>Release notes</summary>",
        "",
        "Hidden detail",
        "",
        "</details>",
        "",
        "![Architecture diagram](document-asset:asset_image)",
        "",
        "[Roadmap (application/pdf)](document-asset:asset_file)",
        "",
        "[Product demo (video/mp4)](document-asset:asset_video)",
        "",
        "[Customer interview (audio/mpeg)](document-asset:asset_audio)",
        "",
        "Styled conclusion",
        "",
        "Inline style",
      ].join("\n"),
    );
    expect(exported.completeReferences.documentAssetIds).toEqual([
      "asset_audio",
      "asset_file",
      "asset_image",
      "asset_video",
    ]);
    expect(exported.warnings).toEqual([
      "markdown_visual_style_downgraded:block_styled:textColor",
      "markdown_visual_style_downgraded:block_inline_styled:inline.underline",
      "markdown_visual_style_downgraded:block_inline_styled:inline.textColor",
      "markdown_visual_style_downgraded:block_inline_styled:inline.backgroundColor",
    ]);
  });

  it.each(["image", "file", "video", "audio"] as const)(
    "preserves nested text and attachments beneath a Markdown %s block",
    async (type) => {
      const state = stateWithBlocks([
        {
          id: "block_media",
          type,
          props: {
            url: "document-asset:asset_parent",
            name: "Parent",
            caption: "Parent",
          },
          children: [
            {
              id: "block_detail",
              type: "paragraph",
              content: "Nested visible text",
            },
            {
              id: "block_child_media",
              type: "file",
              props: { url: "document-asset:asset_child", name: "Child" },
              children: [
                { id: "block_deep", type: "paragraph", content: "Deep detail" },
              ],
            },
          ],
        },
      ]);
      const before = state.stateBytes.slice();
      const input = {
        revisionId: "revision_media_children",
        schemaVersion: 1,
        state,
        assetManifest: [
          asset("asset_child", "text/plain", "Child"),
          asset("asset_parent", "image/png", "Parent"),
        ],
        format: "markdown" as const,
      };
      const result = await exportRoomDocumentRevision(input);
      expect(new TextDecoder().decode(result.bytes)).toBe(
        [
          type === "image"
            ? "![Parent](document-asset:asset_parent)"
            : "[Parent (image/png)](document-asset:asset_parent)",
          "Nested visible text",
          "[Child (text/plain)](document-asset:asset_child)",
          "Deep detail",
        ].join("\n\n"),
      );
      expect(await exportRoomDocumentRevision(input)).toEqual(result);
      expect(state.stateBytes).toEqual(before);
    },
  );

  it.each(["", " ", "\t", "\n", "\u00a0"])(
    "exports blank toggle title %j with its child content",
    async (content) => {
      const state = stateWithBlocks([
        {
          id: "block_toggle",
          type: "toggleListItem",
          content,
          children: [
            {
              id: "block_detail",
              type: "paragraph",
              content: "Visible detail",
            },
          ],
        },
      ]);
      const result = await exportRoomDocumentRevision({
        revisionId: "revision_toggle",
        schemaVersion: 1,
        state,
        assetManifest: [],
        format: "markdown",
      });
      expect(new TextDecoder().decode(result.bytes)).toBe(
        "<details>\n<summary>Details</summary>\n\nVisible detail\n\n</details>",
      );
    },
  );

  it.each([false, true])(
    "exports table text without schema or style fields (structured cells: %s)",
    async (structured) => {
      const cells = [
        [
          [{ type: "text" as const, text: "Header", styles: { bold: true } }],
          [],
        ],
        [
          [
            {
              type: "link" as const,
              href: "https://example.com",
              content: [
                { type: "text" as const, text: "Link label", styles: {} },
              ],
            },
          ],
          [
            {
              type: "text" as const,
              text: "Value",
              styles: { textColor: "red" },
            },
          ],
        ],
      ];
      const state = stateWithBlocks([
        {
          id: "block_table",
          type: "table",
          content: {
            type: "tableContent",
            columnWidths: [120, 240],
            headerRows: 1,
            rows: cells.map((row) => ({
              cells: structured
                ? row.map((content) => ({
                    type: "tableCell" as const,
                    props: {
                      backgroundColor: "blue",
                      textAlignment: "right" as const,
                    },
                    content,
                  }))
                : row,
            })),
          },
        },
      ]);
      const before = state.stateBytes.slice();
      const input = {
        revisionId: "revision_table",
        schemaVersion: 1,
        state,
        assetManifest: [],
        format: "plain_text" as const,
      };
      const result = await exportRoomDocumentRevision(input);
      expect(new TextDecoder().decode(result.bytes)).toBe(
        "Header\t\nLink label\tValue",
      );
      expect(await exportRoomDocumentRevision(input)).toEqual(result);
      expect(state.stateBytes).toEqual(before);
    },
  );

  it("caps Markdown downgrade warnings at the wire contract limit", async () => {
    const state = stateWithBlocks(
      Array.from({ length: 257 }, (_, index) => ({
        id: `block_styled_${String(index).padStart(3, "0")}`,
        type: "paragraph" as const,
        props: { textColor: "red" },
        content: `Styled ${index}`,
      })),
    );

    const exported = await exportRoomDocumentRevision({
      revisionId: "document_revision_warning_limit",
      schemaVersion: 1,
      state,
      assetManifest: [],
      format: "markdown",
    });

    expect(exported.warnings).toHaveLength(256);
    expect(exported.warnings.at(-1)).toBe(
      "markdown_visual_style_downgraded:truncated",
    );
  }, 15_000);
});

function stateWithBlocks(blocks: PartialBlock[]) {
  const document = new Y.Doc({ gc: true });
  const editor = BlockNoteEditor.create({ initialContent: blocks });
  try {
    blocksToYXmlFragment(
      editor,
      editor.document,
      document.getXmlFragment("prosemirror"),
    );
  } finally {
    editor.unmount();
  }
  const stateBytes = Y.encodeStateAsUpdate(document);
  const inspection = inspectRoomDocumentState(stateBytes);
  const stateFingerprint = fingerprintRoomDocumentState(document);
  return {
    stateBytes,
    bytesSha256: stateFingerprint,
    stateVector: Y.encodeStateVector(document),
    stateHash: stateFingerprint,
    stateHashVersion: 1 as const,
    completeReferences: inspection.completeReferences,
    warnings: [],
  };
}

function asset(id: string, mediaType: string, title: string) {
  return {
    id,
    mediaType,
    sizeBytes: 1,
    sha256: "a".repeat(64),
    title,
  };
}
