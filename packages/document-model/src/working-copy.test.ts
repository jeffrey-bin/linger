import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import * as Y from "yjs";
import { expect, it } from "vitest";
import {
  applyRoomDocumentSemanticMutation,
  exportRoomDocumentRevision,
  inspectRoomDocumentState,
  fingerprintRoomDocumentState,
  readRoomDocumentBlocks,
} from "./index.js";

function fixture() {
  const doc = new Y.Doc();
  const editor = BlockNoteEditor.create({
    initialContent: [
      {
        id: "parent",
        type: "paragraph",
        content: "Parent",
        children: [
          { id: "commented", type: "paragraph", content: "Keep comment" },
        ],
      },
      { id: "other", type: "paragraph", content: "Other" },
    ],
  });
  blocksToYXmlFragment(
    editor,
    editor.document,
    doc.getXmlFragment("prosemirror"),
  );
  editor.unmount();
  const group = doc.getXmlFragment("prosemirror").get(0) as Y.XmlElement;
  const child = (group.get(0) as Y.XmlElement).get(1) as Y.XmlElement;
  const text = ((child.get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(
    0,
  ) as Y.XmlText;
  text.format(0, 4, { comment: { threadId: "thread_keep", orphan: false } });
  return { doc, anchor: Y.createRelativePositionFromTypeIndex(text, 2) };
}
async function download(doc: Y.Doc) {
  const bytes = Y.encodeStateAsUpdate(doc);
  const hash = fingerprintRoomDocumentState(doc);
  const result = await exportRoomDocumentRevision({
    revisionId: "revision_test",
    schemaVersion: 1,
    state: {
      stateBytes: bytes,
      bytesSha256: hash,
      stateHash: hash,
      stateHashVersion: 1,
      stateVector: Y.encodeStateVector(doc),
      completeReferences: inspectRoomDocumentState(bytes).completeReferences,
      warnings: [],
    },
    assetManifest: [],
    format: "blocks",
  });
  expect(result.mediaType).toBe("application/json");
  return JSON.parse(new TextDecoder().decode(result.bytes)) as {
    schema_version: number;
    blocks: PartialBlock[];
  };
}
function save(doc: Y.Doc, blocks: PartialBlock[], assets: string[] = []) {
  return applyRoomDocumentSemanticMutation({
    mutationId: "working-copy-save",
    schemaVersion: "blocknote-semantic-v1",
    currentTitle: "Keep title",
    stateBytes: Y.encodeStateAsUpdate(doc),
    allowedDocumentAssetIds: assets,
    operations: [{ kind: "replace_body_blocks", blocks }],
  });
}
it("edits parent text and inserts blocks while preserving the exact commented child and retry result", async () => {
  const { doc, anchor } = fixture();
  const copy = await download(doc);
  expect(copy.schema_version).toBe(1);
  expect(JSON.stringify(copy)).not.toContain("thread_keep");
  copy.blocks[0]!.content = "Edited parent";
  copy.blocks.push({ id: "new", type: "paragraph", content: "New" });
  const result = save(doc, copy.blocks);
  expect(save(doc, copy.blocks)).toEqual(result);
  expect(result.status).toBe("applied");
  if (result.status !== "applied") throw new Error("conflict");
  expect(result.title).toBe("Keep title");
  expect(result.completeReferences.documentThreadIds).toEqual(["thread_keep"]);
  const before = Y.createAbsolutePositionFromRelativePosition(anchor, doc)!;
  Y.applyUpdate(doc, result.update);
  const after = Y.createAbsolutePositionFromRelativePosition(anchor, doc)!;
  expect(after.type).toBe(before.type);
  expect(after.index).toBe(before.index);
  expect(fingerprintRoomDocumentState(doc)).toBe(result.stateHash);
  expect((await download(doc)).blocks).toMatchObject([
    { id: "parent", content: [{ text: "Edited parent" }] },
    { id: "other" },
    { id: "new" },
  ]);
});
it("rejects editing or removing a commented subtree and unsupported fields", async () => {
  const { doc } = fixture();
  const copy = await download(doc);
  const edited = structuredClone(copy.blocks);
  edited[0]!.children![0]!.content = "Overwritten";
  expect(() => save(doc, edited)).toThrow(/comment/i);
  expect(() => save(doc, copy.blocks.slice(1))).toThrow(/comment/i);
  const moved = structuredClone(copy.blocks);
  const commented = moved[0]!.children!.pop()!;
  moved[1]!.children = [commented];
  expect(() => save(doc, moved)).toThrow(/comment/i);
  const unsupported = structuredClone(copy.blocks);
  Object.assign(unsupported[1]!, { unsupported: "must not disappear" });
  expect(() => save(doc, unsupported)).toThrow(/preserv|unsupported/i);
  const duplicate = [...copy.blocks, copy.blocks[1]!];
  expect(() => save(doc, duplicate)).toThrow();
});
it("supports whole rewrites and preserves supplied image references only when authorized", () => {
  const doc = new Y.Doc();
  const editor = BlockNoteEditor.create({
    initialContent: [{ id: "old", type: "paragraph", content: "Old" }],
  });
  blocksToYXmlFragment(
    editor,
    editor.document,
    doc.getXmlFragment("prosemirror"),
  );
  editor.unmount();
  expect(
    save(doc, [{ id: "new", type: "paragraph", content: "New body" }]).status,
  ).toBe("applied");
  expect(() =>
    save(doc, [
      { id: "image", type: "image", props: { url: "document-asset:unknown" } },
    ]),
  ).toThrow();
});

it("reparents retained blocks and changes their text without losing identity", async () => {
  const doc = new Y.Doc();
  const editor = BlockNoteEditor.create({
    initialContent: [
      {
        id: "parent",
        type: "paragraph",
        content: "Parent",
        children: [{ id: "child", type: "paragraph", content: "Child" }],
      },
      { id: "other", type: "paragraph", content: "Other" },
    ],
  });
  blocksToYXmlFragment(
    editor,
    editor.document,
    doc.getXmlFragment("prosemirror"),
  );
  editor.unmount();
  const result = save(doc, [
    {
      id: "other",
      type: "paragraph",
      content: "Other",
      children: [
        { id: "child", type: "paragraph", content: "Moved and edited" },
      ],
    },
  ]);
  if (result.status !== "applied") throw new Error("conflict");
  Y.applyUpdate(doc, result.update);
  expect((await download(doc)).blocks).toMatchObject([
    {
      id: "other",
      children: [{ id: "child", content: [{ text: "Moved and edited" }] }],
    },
  ]);
});

it("keeps image references and properties when another paragraph changes", () => {
  const doc = new Y.Doc();
  const editor = BlockNoteEditor.create({
    initialContent: [
      {
        id: "image",
        type: "image",
        props: {
          url: "document-asset:asset_chart",
          caption: "Chart",
          previewWidth: 240,
        },
      },
      { id: "text", type: "paragraph", content: "Old text" },
    ],
  });
  blocksToYXmlFragment(
    editor,
    editor.document,
    doc.getXmlFragment("prosemirror"),
  );
  editor.unmount();
  const before = readRoomDocumentBlocks(Y.encodeStateAsUpdate(doc));
  const blocks: PartialBlock[] = structuredClone(before);
  blocks[1]!.content = "Updated text";
  const result = save(doc, blocks, ["asset_chart"]);
  if (result.status !== "applied") throw new Error("conflict");
  expect(result.completeReferences.documentAssetIds).toEqual(["asset_chart"]);
  expect(readRoomDocumentBlocks(result.stateBytes)[0]).toEqual(before[0]);
});
