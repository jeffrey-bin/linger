import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  attachRoomDocumentCommentAnchor,
  inspectRoomDocumentState,
} from "./index.js";

describe("Room Document Comment anchor attachment", () => {
  it("attaches one exact thread mark without changing blocks or Asset references", () => {
    const stateBytes = documentState();
    const before = new Y.Doc({ gc: true });
    Y.applyUpdate(before, stateBytes);
    const beforeBlockIds = blockIds(before);
    const beforeText = plainText(targetText(before));
    const first = attach(stateBytes);
    const second = attach(stateBytes);

    expect(first.update).toEqual(second.update);
    expect(first.stateBytes).toEqual(second.stateBytes);
    expect(first.updateSha256).toBe(second.updateSha256);
    expect(first.stateBytesSha256).toBe(second.stateBytesSha256);
    expect(first.completeReferences).toEqual({
      documentAssetIds: ["asset_diagram"],
      documentThreadIds: ["thread_release"],
    });

    const replay = new Y.Doc({ gc: true });
    Y.applyUpdate(replay, stateBytes);
    Y.applyUpdate(replay, first.update);
    expect(blockIds(replay)).toEqual(beforeBlockIds);
    expect(plainText(targetText(replay))).toBe(beforeText);
    expect(Y.encodeStateAsUpdate(replay)).toEqual(first.stateBytes);
    expect(Y.encodeStateVector(replay)).toEqual(first.endStateVector);

    const marked = targetText(replay)
      .toDelta()
      .filter(
        (delta: { insert: string; attributes?: Record<string, unknown> }) =>
          Object.values(delta.attributes ?? {}).some(
            (value) =>
              typeof value === "object" &&
              value !== null &&
              "threadId" in value &&
              value.threadId === "thread_release",
          ),
      );
    expect(marked).toHaveLength(1);
    expect(marked[0]?.insert).toBe("release target");
    expect(Object.keys(marked[0]?.attributes ?? {})).toContain(
      "comment--+plxKq3Q",
    );
  });

  it.each([
    {
      name: "missing block",
      input: { blockId: "missing-block" },
      message: "Comment anchor Block was not found",
    },
    {
      name: "stale context",
      input: { contextBefore: "changed context " },
      message: "Comment anchor context is stale",
    },
    {
      name: "missing quote",
      input: { quotedText: "missing quote" },
      message: "Comment anchor quote was not found",
    },
  ])("rejects $name", ({ input, message }) => {
    expect(() => attach(documentState(), input)).toThrow(message);
  });

  it("rejects an ambiguous quote", () => {
    const stateBytes = documentState("release target release target");
    expect(() =>
      attach(stateBytes, { contextAfter: "", contextBefore: "" }),
    ).toThrow("Comment anchor quote is ambiguous");
  });

  it("rejects a thread already referenced anywhere in the Document", () => {
    const initial = new Y.Doc({ gc: true });
    Y.applyUpdate(initial, documentState());
    targetText(initial).format(0, 1, {
      comment: { orphan: false, threadId: "thread_release" },
    });
    expect(() => attach(Y.encodeStateAsUpdate(initial))).toThrow(
      "Comment thread is already attached",
    );
  });
});

function attach(
  stateBytes: Uint8Array,
  overrides: Partial<{
    blockId: string;
    contextAfter: string;
    contextBefore: string;
    quotedText: string;
  }> = {},
) {
  return attachRoomDocumentCommentAnchor({
    attachmentOperationId: "anchor_attachment_release",
    stateBytes,
    threadId: "thread_release",
    blockId: overrides.blockId ?? "target-block",
    quotedText: overrides.quotedText ?? "release target",
    contextBefore: overrides.contextBefore ?? "Intro\nBefore ",
    contextAfter: overrides.contextAfter ?? " after\n",
  });
}

function documentState(target = "Before release target after"): Uint8Array {
  const document = new Y.Doc({ gc: true });
  const editor = BlockNoteEditor.create({
    initialContent: [
      { id: "intro-block", type: "paragraph", content: "Intro" },
      { id: "target-block", type: "paragraph", content: target },
      {
        id: "asset-block",
        type: "image",
        props: { name: "diagram.png", url: "document-asset:asset_diagram" },
      },
    ],
  });
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
  expect(inspectRoomDocumentState(stateBytes).completeReferences).toEqual({
    documentAssetIds: ["asset_diagram"],
    documentThreadIds: [],
  });
  return stateBytes;
}

function targetText(document: Y.Doc): Y.XmlText {
  const pending = [...document.getXmlFragment("prosemirror").toArray()];
  let target = false;
  while (pending.length > 0) {
    const node = pending.shift();
    if (!(node instanceof Y.XmlElement)) continue;
    if (node.nodeName === "blockContainer") {
      target = node.getAttribute("id") === "target-block";
    }
    if (target) {
      const text = descendantText(node);
      if (text) return text;
    }
    pending.unshift(...node.toArray());
  }
  throw new Error("target text was not found");
}

function blockIds(document: Y.Doc): string[] {
  const ids: string[] = [];
  const pending = [...document.getXmlFragment("prosemirror").toArray()];
  while (pending.length > 0) {
    const node = pending.shift();
    if (!(node instanceof Y.XmlElement)) continue;
    if (node.nodeName === "blockContainer") {
      ids.push(node.getAttribute("id") ?? "");
    }
    pending.push(...node.toArray());
  }
  return ids;
}

function descendantText(node: Y.XmlElement): Y.XmlText | undefined {
  const pending = [...node.toArray()];
  while (pending.length > 0) {
    const child = pending.shift();
    if (child instanceof Y.XmlText) return child;
    if (child instanceof Y.XmlElement) pending.push(...child.toArray());
  }
  return undefined;
}

function plainText(text: Y.XmlText): string {
  return text
    .toDelta()
    .map((delta: { insert: string }) => delta.insert)
    .join("");
}
