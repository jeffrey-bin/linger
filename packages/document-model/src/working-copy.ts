import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import * as Y from "yjs";
import { readExportBlocks } from "./export.js";
import {
  preservesRoomDocumentSemanticFields,
  validateRoomDocumentSemanticBlocks,
} from "./semantic-blocks.js";
import type { RoomDocumentSemanticBlock } from "./semantic.js";
import { RoomDocumentModelError } from "./state-invariants.js";

// Reconcile by stable identity, retaining untouched Yjs nodes and relative anchors.
export function replaceWorkingCopyBlocks(
  current: Y.Doc,
  supplied: RoomDocumentSemanticBlock[],
): void {
  if (!Array.isArray(supplied) || supplied.length === 0)
    fail("Replacement blocks cannot be empty");
  const original = readExportBlocks(Y.encodeStateAsUpdate(current));
  const originals = new Map<string, RoomDocumentSemanticBlock>();
  const collect = (blocks: RoomDocumentSemanticBlock[]) => {
    for (const block of blocks) {
      originals.set(block.id!, block);
      collect(block.children ?? []);
    }
  };
  collect(original);
  const merge = (
    blocks: RoomDocumentSemanticBlock[],
  ): RoomDocumentSemanticBlock[] =>
    blocks.map((block) => {
      const old = originals.get(block.id!);
      const base = old?.type === block.type ? old : undefined;
      return {
        ...base,
        ...block,
        props: { ...base?.props, ...block.props },
        children: merge(block.children ?? base?.children ?? []),
      } as RoomDocumentSemanticBlock;
    });
  // Validate identities before merging, so malformed or duplicated input cannot disappear.
  validateRoomDocumentSemanticBlocks({ schemaVersion: 1, blocks: supplied });
  const merged = merge(supplied);
  const target = build(merged);
  const normalized = readExportBlocks(Y.encodeStateAsUpdate(target));
  if (!preservesRoomDocumentSemanticFields(merged, normalized))
    fail(
      "Replacement contains unsupported fields or formatting that cannot be preserved",
    );
  const baseline = build(original);
  const snapshot = new Y.Doc();
  Y.applyUpdate(snapshot, Y.encodeStateAsUpdate(current));
  const rawNodes = indexNodes(snapshot);
  const baseNodes = indexNodes(baseline);
  const targetNodes = indexNodes(target);
  const normalizedById = new Map<string, RoomDocumentSemanticBlock>();
  const indexBlocks = (blocks: RoomDocumentSemanticBlock[]) => {
    for (const b of blocks) {
      normalizedById.set(b.id!, b);
      indexBlocks(b.children ?? []);
    }
  };
  indexBlocks(normalized);
  const unchangedOwn = (id: string) => {
    const own = (b: RoomDocumentSemanticBlock | undefined) =>
      b && { ...b, children: [] };
    return equal(own(originals.get(id)), own(normalizedById.get(id)));
  };
  const reconcile = (group: Y.XmlElement, desired: Y.XmlElement) => {
    const wanted = desired.toArray() as Y.XmlElement[];
    const ids = new Set(wanted.map(idOf));
    // Removing preceding siblings need not move a surviving commented node.
    for (let i = group.length - 1; i >= 0; i--) {
      const node = group.get(i) as Y.XmlElement;
      if (!ids.has(idOf(node))) {
        assertNoComments(node);
        group.delete(i, 1);
      }
    }
    for (let i = 0; i < wanted.length; i++) {
      const replacement = wanted[i]!;
      const id = idOf(replacement);
      let node = group.get(i) as Y.XmlElement | undefined;
      if (!node || idOf(node) !== id) {
        const at = group
          .toArray()
          .findIndex((n) => n instanceof Y.XmlElement && idOf(n) === id);
        const source =
          at >= 0 ? (group.get(at) as Y.XmlElement) : rawNodes.get(id);
        if (source) assertNoComments(source);
        const cloned = source?.clone() ?? replacement.clone();
        if (at >= 0) group.delete(at, 1);
        group.insert(i, [cloned]);
        node = cloned;
        if (!source) {
          const children = childGroup(node);
          if (children) node.delete(node.toArray().indexOf(children), 1);
        }
      }
      if (originals.has(id) && !unchangedOwn(id)) {
        const ownNodes = node
          .toArray()
          .filter(
            (n) => !(n instanceof Y.XmlElement && n.nodeName === "blockGroup"),
          );
        ownNodes.forEach(assertNoComments);
        const raw = rawNodes.get(id)!;
        if (!equal(ownShape(raw), ownShape(baseNodes.get(id)!)))
          fail("Existing block contains formatting that cannot be preserved");
        // Keep the child group itself integrated; children may carry comment anchors.
        for (let n = node.length - 1; n >= 0; n--) {
          const child = node.get(n);
          if (
            !(child instanceof Y.XmlElement && child.nodeName === "blockGroup")
          )
            node.delete(n, 1);
        }
        const contents = replacement
          .toArray()
          .filter(
            (n) => !(n instanceof Y.XmlElement && n.nodeName === "blockGroup"),
          );
        node.insert(
          0,
          contents.map((n) => {
            if (!(n instanceof Y.XmlElement || n instanceof Y.XmlText))
              fail("Unsupported native node");
            return n.clone();
          }),
        );
        for (const key of Object.keys(node.getAttributes()))
          node.removeAttribute(key);
        for (const [key, value] of Object.entries(replacement.getAttributes()))
          if (value !== undefined) node.setAttribute(key, value);
      }
      let children = childGroup(node);
      const targetChildren = childGroup(targetNodes.get(id)!);
      if (targetChildren) {
        if (!children) {
          children = new Y.XmlElement("blockGroup");
          node.insert(node.length, [children]);
        }
        reconcile(children, targetChildren);
      } else if (children) {
        assertNoComments(children);
        node.delete(node.toArray().indexOf(children), 1);
      }
    }
  };
  try {
    current.transact(() => reconcile(rootGroup(current), rootGroup(target)));
  } finally {
    target.destroy();
    baseline.destroy();
    snapshot.destroy();
  }
}
function build(blocks: RoomDocumentSemanticBlock[]): Y.Doc {
  const doc = new Y.Doc();
  const editor = BlockNoteEditor.create({ initialContent: blocks });
  try {
    blocksToYXmlFragment(
      editor,
      editor.document,
      doc.getXmlFragment("prosemirror"),
    );
  } finally {
    editor.unmount();
  }
  return doc;
}
function rootGroup(doc: Y.Doc): Y.XmlElement {
  const result = childGroup(doc.getXmlFragment("prosemirror"));
  if (!result) fail("Document has no BlockNote group");
  return result;
}
function childGroup(
  node: Y.XmlElement | Y.XmlFragment,
): Y.XmlElement | undefined {
  return node
    .toArray()
    .find(
      (n): n is Y.XmlElement =>
        n instanceof Y.XmlElement && n.nodeName === "blockGroup",
    );
}
function idOf(node: Y.XmlElement): string {
  return node.getAttribute("id")!;
}
function indexNodes(doc: Y.Doc): Map<string, Y.XmlElement> {
  const result = new Map<string, Y.XmlElement>();
  const visit = (node: Y.XmlFragment | Y.XmlElement) => {
    if (node instanceof Y.XmlElement && node.nodeName === "blockContainer")
      result.set(idOf(node), node);
    for (const child of node.toArray())
      if (child instanceof Y.XmlElement) visit(child);
  };
  visit(doc.getXmlFragment("prosemirror"));
  return result;
}
function assertNoComments(node: Y.XmlElement | Y.XmlText | Y.XmlHook): void {
  if (!(node instanceof Y.XmlElement || node instanceof Y.XmlText))
    fail("Unsupported native node");
  if (node instanceof Y.XmlText) {
    if (
      node
        .toDelta()
        .some((d: { attributes?: Record<string, unknown> }) =>
          Object.keys(d.attributes ?? {}).some((k) =>
            /^comment(?:--[A-Za-z0-9+/=]{8})?$/.test(k),
          ),
        )
    )
      fail("Cannot edit, remove or move a block containing anchored comments");
  } else for (const child of node.toArray()) assertNoComments(child);
}
function ownShape(node: Y.XmlElement): unknown {
  const shape = (n: Y.XmlElement | Y.XmlText | Y.XmlHook): unknown => {
    if (!(n instanceof Y.XmlElement || n instanceof Y.XmlText))
      fail("Unsupported native node");
    return n instanceof Y.XmlText
      ? n.toDelta()
      : [n.nodeName, n.getAttributes(), n.toArray().map(shape)];
  };
  return [
    node.getAttributes(),
    node
      .toArray()
      .filter(
        (n) => !(n instanceof Y.XmlElement && n.nodeName === "blockGroup"),
      )
      .map(shape),
  ];
}
function equal(a: unknown, b: unknown): boolean {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, canonical(v)]),
          )
        : v;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
function fail(message: string): never {
  throw new RoomDocumentModelError("validation_failed", message);
}
