import { describe, expect, it } from "vitest";

import { materializeRoomDocument, readRoomDocumentBlocks } from "./index.js";

const materializationId = "9b5be123-4fd2-4a47-a98d-548879f3fc78";
const encoder = new TextEncoder();

describe("Room Document materialization", () => {
  it("creates one deterministic editable block for a blank Document", async () => {
    const first = await materializeRoomDocument({
      materializationId,
      schemaVersion: 1,
      sourceKind: "blank",
    });
    const replay = await materializeRoomDocument({
      materializationId,
      schemaVersion: 1,
      sourceKind: "blank",
    });

    expect(first.stateBytes).toEqual(replay.stateBytes);
    expect(first.stateVector).toEqual(replay.stateVector);
    expect(first.stateHash).toBe(first.bytesSha256);
    expect(readRoomDocumentBlocks(first.stateBytes)).toMatchObject([
      { type: "paragraph", content: [] },
    ]);
  });

  it("preserves Markdown structure in the BlockNote Yjs state", async () => {
    const result = await materializeRoomDocument({
      materializationId,
      schemaVersion: 1,
      sourceKind: "markdown",
      sourceBytes: encoder.encode("# Design\n\nA **durable** draft."),
    });

    expect(readRoomDocumentBlocks(result.stateBytes)).toMatchObject([
      { type: "heading", props: { level: 1 } },
      {
        type: "paragraph",
        content: [
          { text: "A ", styles: {} },
          { text: "durable", styles: { bold: true } },
          { text: " draft.", styles: {} },
        ],
      },
    ]);
  });

  it("materializes Mermaid Markdown as a standard editable code block", async () => {
    const result = await materializeRoomDocument({
      materializationId,
      schemaVersion: 1,
      sourceKind: "markdown",
      sourceBytes: encoder.encode(
        "```mermaid\ngraph TD\n  Human --> Agent\n```",
      ),
    });

    expect(readRoomDocumentBlocks(result.stateBytes)).toMatchObject([
      {
        content: [{ text: "graph TD\n  Human --> Agent" }],
        props: { language: "mermaid" },
        type: "codeBlock",
      },
    ]);
  });

  it("maps plain-text lines and sanitized HTML into editable blocks", async () => {
    const plain = await materializeRoomDocument({
      materializationId,
      schemaVersion: 1,
      sourceKind: "plain_text",
      sourceBytes: encoder.encode("Alpha\nBeta"),
    });
    const html = await materializeRoomDocument({
      materializationId: "29abbb91-84ce-4c3c-8785-0b8b61617b8c",
      schemaVersion: 1,
      sourceKind: "sanitized_html",
      sourceBytes: encoder.encode("<h2>Title</h2><p>Body</p>"),
    });

    expect(readRoomDocumentBlocks(plain.stateBytes)).toMatchObject([
      { type: "paragraph", content: [{ text: "Alpha" }] },
      { type: "paragraph", content: [{ text: "Beta" }] },
    ]);
    expect(readRoomDocumentBlocks(html.stateBytes)).toMatchObject([
      { type: "heading", props: { level: 2 } },
      { type: "paragraph", content: [{ text: "Body" }] },
    ]);
  });

  it("keeps no script, event handler or script URL from imported HTML", async () => {
    const result = await materializeRoomDocument({
      materializationId,
      schemaVersion: 1,
      sourceKind: "sanitized_html",
      sourceBytes: encoder.encode(
        '<p>Safe<script>alert("script")</script></p>' +
          '<p><img src="document-asset:document_asset_safe" alt="Image" onerror="alert(1)"></p>' +
          '<p><a href="javascript:alert(2)" onclick="alert(3)">Link</a></p>',
      ),
      allowedDocumentAssetIds: ["document_asset_safe"],
    });
    const blocks = readRoomDocumentBlocks(result.stateBytes);

    expect(JSON.stringify(blocks)).not.toMatch(
      /alert|<script|onerror|onclick|javascript:/i,
    );
    expect(blocks).toMatchObject([
      { type: "paragraph", content: [{ text: "Safe" }] },
      { type: "image", props: { url: "document-asset:document_asset_safe" } },
      { type: "paragraph", content: [{ text: "Link" }] },
    ]);
  });

  it("preserves external media evidence as text until Document Assets exist", async () => {
    const result = await materializeRoomDocument({
      materializationId,
      schemaVersion: 1,
      sourceKind: "markdown",
      sourceBytes: encoder.encode(
        "![Diagram](https://example.test/diagram.png)",
      ),
    });

    expect(result.warnings).toEqual([
      "External media was converted to text because Document Assets are not available during materialization",
    ]);
    const blocks = readRoomDocumentBlocks(result.stateBytes);
    expect(blocks).toMatchObject([
      {
        type: "paragraph",
        content: [
          { text: expect.stringContaining("https://example.test/diagram.png") },
        ],
      },
    ]);
    expect(blocks.every((block) => block.id.length <= 256)).toBe(true);
  });

  it("preserves allowlisted imported HTML media as stable Document Asset references", async () => {
    const result = await materializeRoomDocument({
      materializationId,
      schemaVersion: 1,
      sourceKind: "sanitized_html",
      sourceBytes: encoder.encode(
        '<h2>Diagram</h2><p><img src="document-asset:document_asset_diagram" alt="Original"></p><p><img src="document-asset:document_asset_diagram" alt="Again"></p>',
      ),
      allowedDocumentAssetIds: ["document_asset_diagram"],
    });
    expect(result.warnings).toEqual([]);
    expect(result.completeReferences.documentAssetIds).toEqual([
      "document_asset_diagram",
    ]);
    expect(readRoomDocumentBlocks(result.stateBytes)).toMatchObject([
      { type: "heading", props: { level: 2 } },
      {
        type: "image",
        props: { url: "document-asset:document_asset_diagram" },
      },
      {
        type: "image",
        props: { url: "document-asset:document_asset_diagram" },
      },
    ]);
  });

  it("keeps images from HTML table cells as editable media blocks", async () => {
    const result = await materializeRoomDocument({
      materializationId,
      schemaVersion: 1,
      sourceKind: "sanitized_html",
      sourceBytes: encoder.encode(
        '<p><img src="document-asset:document_asset_outside"></p>' +
          '<table><tbody><tr><td>first <img src="document-asset:document_asset_inside" alt="first"></td>' +
          '<td>second <img src="document-asset:document_asset_inside" alt="second"></td></tr></tbody></table>',
      ),
      allowedDocumentAssetIds: [
        "document_asset_outside",
        "document_asset_inside",
      ],
    });
    expect(result.completeReferences.documentAssetIds).toEqual([
      "document_asset_inside",
      "document_asset_outside",
    ]);
    const blocks = readRoomDocumentBlocks(result.stateBytes);
    expect(
      blocks
        .filter((block) => block.type === "image")
        .map((block) => block.props.url),
    ).toEqual([
      "document-asset:document_asset_outside",
      "document-asset:document_asset_inside",
      "document-asset:document_asset_inside",
    ]);
    const table = blocks.find((block) => block.type === "table");
    expect(table).toBeDefined();
    expect(JSON.stringify(table)).toContain("first");
    expect(JSON.stringify(table)).toContain("second");
  });

  it("rejects media inside table cells when not in the allowlist", async () => {
    await expect(
      materializeRoomDocument({
        materializationId,
        schemaVersion: 1,
        sourceKind: "sanitized_html",
        sourceBytes: encoder.encode(
          '<table><tr><td><img src="document-asset:document_asset_untrusted"></td></tr></table>',
        ),
        allowedDocumentAssetIds: [],
      }),
    ).rejects.toThrow("not allowed");
  });

  it("rejects imported HTML media outside the materialization allowlist", async () => {
    await expect(
      materializeRoomDocument({
        materializationId,
        schemaVersion: 1,
        sourceKind: "sanitized_html",
        sourceBytes: encoder.encode(
          '<img src="document-asset:document_asset_untrusted">',
        ),
        allowedDocumentAssetIds: [],
      }),
    ).rejects.toThrow("not allowed");
  });

  it.each(["data:image/png;base64,aW1hZ2U=", "document-image:temporary"])(
    "rejects unimported Markdown image %s instead of saving it as text",
    async (url) => {
      await expect(
        materializeRoomDocument({
          materializationId,
          schemaVersion: 1,
          sourceKind: "markdown",
          sourceBytes: encoder.encode(`![Original image](${url})`),
        }),
      ).rejects.toThrow("must be imported");
    },
  );

  it("rejects raw data URI media before BlockNote parsing", async () => {
    await expect(
      materializeRoomDocument({
        materializationId,
        schemaVersion: 1,
        sourceKind: "sanitized_html",
        sourceBytes: encoder.encode(
          '<img src="data:image/png;base64,aW1hZ2U=">',
        ),
        allowedDocumentAssetIds: [],
      }),
    ).rejects.toThrow("must be imported");
  });
  it("rejects Markdown data images instead of persisting Base64 paragraphs", async () => {
    await expect(
      materializeRoomDocument({
        materializationId,
        schemaVersion: 1,
        sourceKind: "markdown",
        sourceBytes: encoder.encode(
          "![Original](data:image/png;base64,aW1hZ2U=)",
        ),
      }),
    ).rejects.toThrow("must be imported");
    const code = await materializeRoomDocument({
      materializationId,
      schemaVersion: 1,
      sourceKind: "markdown",
      sourceBytes: encoder.encode(
        "```md\n![Example](data:image/png;base64,aW1hZ2U=)\n```",
      ),
    });
    expect(readRoomDocumentBlocks(code.stateBytes)).toMatchObject([
      { type: "codeBlock" },
    ]);
  });
});
