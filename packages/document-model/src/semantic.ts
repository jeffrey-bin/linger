import { BlockNoteEditor } from "@blocknote/core";
import type {
  Block,
  DefaultBlockSchema,
  DefaultInlineContentSchema,
  DefaultStyleSchema,
  PartialBlock,
} from "@blocknote/core";
import { blocksToYXmlFragment, yDocToBlocks } from "@blocknote/core/yjs";
import * as Y from "yjs";

import { replaceWorkingCopyBlocks } from "./working-copy.js";
import { inspectRoomDocumentState } from "./document-state.js";
import { validateRoomDocumentSemanticBlocks } from "./semantic-blocks.js";
import {
  ROOM_DOCUMENT_MAX_STATE_BYTES,
  ROOM_DOCUMENT_SCHEMA_VERSION,
  ROOM_DOCUMENT_STATE_HASH_VERSION,
  RoomDocumentModelError,
  sha256Hex,
} from "./state-invariants.js";

import {
  nativeDocumentBlockEdit,
  nativeDocumentTextEdit,
  validateNativeDocumentEdit,
  type NativeDocumentEdit,
} from "./native-edit.js";

const blockNoteFragmentKey = "prosemirror";
const semanticSchemaVersion = "blocknote-semantic-v1" as const;
const maximumOperations = 64;
const maximumRequestBytes = 256 << 10;
const commentMarkPattern = /^comment(?:--[A-Za-z0-9+/=]{8})?$/;

type DefaultBlock = Block<
  DefaultBlockSchema,
  DefaultInlineContentSchema,
  DefaultStyleSchema
>;
export type RoomDocumentSemanticBlock = PartialBlock<
  DefaultBlockSchema,
  DefaultInlineContentSchema,
  DefaultStyleSchema
>;

export type RoomDocumentSemanticOperation =
  | NativeDocumentEdit
  | { kind: "replace_body_html"; html: string }
  | { kind: "replace_body_blocks"; blocks: RoomDocumentSemanticBlock[] }
  | { kind: "set_title"; title: string }
  | { kind: "append_blocks"; blocks: RoomDocumentSemanticBlock[] }
  | {
      kind: "insert_blocks";
      position: "before" | "after";
      stableBlockId: string;
      blocks: RoomDocumentSemanticBlock[];
    }
  | {
      kind: "replace_blocks";
      stableBlockIds: string[];
      blocks: RoomDocumentSemanticBlock[];
    }
  | {
      kind: "update_block";
      stableBlockId: string;
      block: RoomDocumentSemanticBlock;
    }
  | { kind: "delete_blocks"; stableBlockIds: string[] }
  | { kind: "replace_comment_text"; threadId: string; replacement: string };

export type RoomDocumentSemanticMutationResult =
  | {
      status: "applied";
      title: string;
      update: Uint8Array;
      updateSha256: string;
      stateBytes: Uint8Array;
      stateBytesSha256: string;
      endStateVector: Uint8Array;
      stateHash: string;
      stateHashVersion: typeof ROOM_DOCUMENT_STATE_HASH_VERSION;
      completeReferences: {
        documentAssetIds: string[];
        documentThreadIds: string[];
      };
    }
  | {
      status: "conflicted";
      reason:
        | "text_not_found"
        | "ambiguous_text"
        | "missing_block"
        | "duplicate_target"
        | "noncontiguous_blocks"
        | "invalid_structure"
        | "missing_comment_selection"
        | "ambiguous_comment_selection";
    };

export function applyRoomDocumentSemanticMutation(input: {
  mutationId: string;
  schemaVersion: typeof semanticSchemaVersion;
  currentTitle: string;
  stateBytes: Uint8Array;
  allowedDocumentAssetIds: string[];
  operations: RoomDocumentSemanticOperation[];
}): RoomDocumentSemanticMutationResult {
  validateInput(input);
  const initialInspection = inspectRoomDocumentState(input.stateBytes);
  const current = new Y.Doc({ gc: true });
  Y.applyUpdate(current, input.stateBytes);
  const baseVector = Y.encodeStateVector(current);
  let title = input.currentTitle;
  let blocksChanged = false;
  let directStateChanged = false;
  const commentOperations = input.operations.filter(
    (operation) => operation.kind === "replace_comment_text",
  );
  const nativeEdit = input.operations.find(
    (op): op is NativeDocumentEdit => op.kind === "edit_document",
  );
  if (nativeEdit) {
    if (input.operations.length !== 1)
      throw invalidSemantic("Native edit must be one operation");
    validateNativeDocumentEdit(nativeEdit);
  }
  if (nativeEdit?.command === "str_replace") {
    current.clientID = stableClientID(input.mutationId);
    const result = nativeDocumentTextEdit(current, nativeEdit);
    if (result) return result;
    directStateChanged = true;
  } else if (nativeEdit?.command === "append") {
    const operation = nativeDocumentBlockEdit([], nativeEdit, input.mutationId);
    if ("status" in operation) return operation;
    if (operation.kind !== "append_blocks")
      throw invalidSemantic("Append must produce new blocks");
    current.clientID = stableClientID(input.mutationId);
    // Build only the new tail. Never round-trip or rewrite existing nodes:
    // they may contain comment anchors or formatting the parser cannot emit.
    const target = documentWithBlocks(validatedBlocks(operation.blocks));
    try {
      const additions = blockGroup(target)
        .toArray()
        .map((node) => {
          if (!(node instanceof Y.XmlElement || node instanceof Y.XmlText))
            throw invalidSemantic("Append produced an unsupported node");
          return node.clone();
        });
      const group = blockGroup(current);
      current.transact(
        () => group.insert(group.length, additions),
        input.mutationId,
      );
    } finally {
      target.destroy();
    }
    directStateChanged = true;
  } else if (input.operations.some((op) => op.kind === "replace_body_blocks")) {
    const operation = input.operations[0]!;
    if (
      input.operations.length !== 1 ||
      operation.kind !== "replace_body_blocks"
    )
      throw invalidSemantic("Body replacement must be a single operation");
    current.clientID = stableClientID(input.mutationId);
    replaceWorkingCopyBlocks(current, operation.blocks);
    directStateChanged = true;
  } else if (commentOperations.length > 0) {
    if (input.operations.length !== 1 || commentOperations.length !== 1) {
      throw invalidSemantic(
        "Comment text replacement cannot be combined with other operations",
      );
    }
    current.clientID = stableClientID(input.mutationId);
    const conflict = applyCommentTextReplacement(
      current,
      commentOperations[0]!,
    );
    if (conflict !== undefined) return conflict;
    directStateChanged = true;
  } else {
    const reader = BlockNoteEditor.create();
    let blocks: RoomDocumentSemanticBlock[];
    try {
      blocks = structuredClone(
        yDocToBlocks(reader, current, blockNoteFragmentKey) as DefaultBlock[],
      );
    } finally {
      reader.unmount();
    }
    for (const requestedOperation of input.operations) {
      if (
        initialInspection.completeReferences.documentThreadIds.length > 0 &&
        requestedOperation.kind !== "set_title" &&
        !(
          requestedOperation.kind === "edit_document" &&
          requestedOperation.command === "set_title"
        )
      )
        throw invalidSemantic(
          "Block edits cannot preserve anchored comments; use the selected text action",
        );
      const operation =
        requestedOperation.kind === "edit_document"
          ? nativeDocumentBlockEdit(
              blocks,
              requestedOperation,
              input.mutationId,
            )
          : requestedOperation;
      if ("status" in operation) return operation;
      if (operation.kind === "edit_document")
        throw invalidSemantic("Nested edit action is invalid");
      if (operation.kind === "replace_body_blocks")
        throw invalidSemantic("Body replacement must be a single operation");
      if (operation.kind === "replace_body_html") {
        if (input.operations.length !== 1)
          throw invalidSemantic(
            "Whole-body replacement cannot preserve anchored comments; use targeted semantic edits",
          );
        blocks = parseReplacementHTML(operation.html);
        blocksChanged = true;
        continue;
      }
      if (operation.kind === "set_title") {
        validateTitle(operation.title);
        title = operation.title;
        continue;
      }
      if (operation.kind === "replace_comment_text") {
        throw invalidSemantic(
          "Comment text replacement cannot be combined with other operations",
        );
      }
      const conflict = applyBlockOperation(blocks, operation);
      if (conflict !== undefined) return conflict;
      blocksChanged = true;
    }
    if (blocksChanged) {
      const target = documentWithBlocks(blocks);
      current.clientID = stableClientID(input.mutationId);
      const currentGroup = blockGroup(current);
      const replacements = blockGroup(target)
        .toArray()
        .filter(
          (node): node is Y.XmlElement | Y.XmlText =>
            node instanceof Y.XmlElement || node instanceof Y.XmlText,
        )
        .map((node) => node.clone());
      current.transact(() => {
        currentGroup.delete(0, currentGroup.length);
        currentGroup.insert(0, replacements);
      }, input.mutationId);
    }
  }

  let stateBytes = input.stateBytes;
  let update: Uint8Array = new Uint8Array();
  let endStateVector = baseVector;
  let inspection = initialInspection;
  if (blocksChanged || directStateChanged) {
    stateBytes = Y.encodeStateAsUpdate(current);
    update = Y.encodeStateAsUpdate(current, baseVector);
    endStateVector = Y.encodeStateVector(current);
    inspection = inspectRoomDocumentState(stateBytes);
  }
  if (stateBytes.byteLength > ROOM_DOCUMENT_MAX_STATE_BYTES) {
    throw invalidSemantic("Semantic mutation result exceeds 32 MiB");
  }
  const allowedAssets = new Set(input.allowedDocumentAssetIds);
  if (
    inspection.completeReferences.documentAssetIds.some(
      (assetId) => !allowedAssets.has(assetId),
    )
  ) {
    throw invalidSemantic(
      "Semantic mutation referenced an unpinned Document Asset",
    );
  }
  const stateHash = sha256Hex(stateBytes);
  return {
    status: "applied",
    title,
    update,
    updateSha256: sha256Hex(update),
    stateBytes,
    stateBytesSha256: stateHash,
    endStateVector,
    stateHash,
    stateHashVersion: ROOM_DOCUMENT_STATE_HASH_VERSION,
    completeReferences: inspection.completeReferences,
  };
}

type BlockOperation = Exclude<
  RoomDocumentSemanticOperation,
  | { kind: "edit_document" }
  | { kind: "set_title" }
  | { kind: "replace_comment_text" }
  | { kind: "replace_body_html" }
  | { kind: "replace_body_blocks" }
>;
type Conflict = Extract<
  RoomDocumentSemanticMutationResult,
  { status: "conflicted" }
>;
interface BlockLocation {
  siblings: RoomDocumentSemanticBlock[];
  index: number;
  block: RoomDocumentSemanticBlock;
}

function applyBlockOperation(
  root: RoomDocumentSemanticBlock[],
  operation: BlockOperation,
): Conflict | undefined {
  if (
    operation.kind === "insert_blocks" ||
    operation.kind === "append_blocks"
  ) {
    const target =
      operation.kind === "append_blocks"
        ? { siblings: root, index: root.length }
        : findBlock(root, operation.stableBlockId);
    if (target === undefined) return conflict("missing_block");
    const replacements = validatedBlocks(operation.blocks);
    if (replacements.length === 0)
      throw invalidSemantic("Inserted blocks cannot be empty");
    if (hasIDCollision(root, replacements, new Set())) {
      throw invalidSemantic("Inserted Block IDs already exist");
    }
    target.siblings.splice(
      target.index +
        (operation.kind === "insert_blocks" && operation.position === "after"
          ? 1
          : 0),
      0,
      ...replacements,
    );
    return undefined;
  }

  const targetIDs =
    operation.kind === "update_block"
      ? [operation.stableBlockId]
      : operation.stableBlockIds;
  const range = contiguousRange(root, targetIDs);
  if ("status" in range) return range;
  if (operation.kind === "delete_blocks") {
    if (range.siblings === root && range.siblings.length === range.width) {
      return conflict("invalid_structure");
    }
    range.siblings.splice(range.start, range.width);
    return undefined;
  }

  const replacements = validatedBlocks(
    operation.kind === "update_block" ? [operation.block] : operation.blocks,
  );
  if (operation.kind === "update_block") {
    if (replacements[0]?.id !== operation.stableBlockId) {
      throw invalidSemantic("Updated Block must preserve its stable ID");
    }
  } else if (
    replacements.length === 0 &&
    range.siblings === root &&
    range.width === root.length
  ) {
    return conflict("invalid_structure");
  }
  if (hasIDCollision(root, replacements, new Set(targetIDs))) {
    throw invalidSemantic("Replacement Block IDs already exist");
  }
  range.siblings.splice(range.start, range.width, ...replacements);
  return undefined;
}

interface CommentSelection {
  node: Y.XmlText;
  offset: number;
  length: number;
  attributes: Record<string, unknown>;
}

function applyCommentTextReplacement(
  document: Y.Doc,
  operation: Extract<
    RoomDocumentSemanticOperation,
    { kind: "replace_comment_text" }
  >,
): Conflict | undefined {
  if (
    operation.threadId.length < 1 ||
    operation.threadId.length > 255 ||
    operation.replacement.length < 1 ||
    operation.replacement.length > 50_000
  ) {
    throw invalidSemantic("Comment text replacement is invalid");
  }
  const selections: CommentSelection[] = [];
  const pending = [...document.getXmlFragment(blockNoteFragmentKey).toArray()];
  while (pending.length > 0) {
    const node = pending.shift()!;
    if (node instanceof Y.XmlText) {
      let offset = 0;
      for (const delta of node.toDelta()) {
        if (typeof delta.insert !== "string") {
          return conflict("ambiguous_comment_selection");
        }
        const matchingMarks = Object.entries(delta.attributes ?? {}).filter(
          ([name, value]) =>
            commentMarkPattern.test(name) &&
            value !== null &&
            typeof value === "object" &&
            "threadId" in value &&
            value.threadId === operation.threadId &&
            (!("orphan" in value) || value.orphan === false),
        );
        if (matchingMarks.length > 1) {
          return conflict("ambiguous_comment_selection");
        }
        if (matchingMarks.length === 1 && delta.insert.length > 0) {
          const previous = selections.at(-1);
          if (
            previous !== undefined &&
            previous.node === node &&
            previous.offset + previous.length === offset
          ) {
            previous.length += delta.insert.length;
          } else {
            selections.push({
              node,
              offset,
              length: delta.insert.length,
              attributes: { ...(delta.attributes ?? {}) },
            });
          }
        }
        offset += delta.insert.length;
      }
      continue;
    }
    if (!(node instanceof Y.XmlElement)) {
      return conflict("ambiguous_comment_selection");
    }
    pending.push(...node.toArray());
  }
  if (selections.length === 0) return conflict("missing_comment_selection");
  if (selections.length !== 1) return conflict("ambiguous_comment_selection");
  const selection = selections[0]!;
  document.transact(() => {
    selection.node.delete(selection.offset, selection.length);
    selection.node.insert(
      selection.offset,
      operation.replacement,
      selection.attributes,
    );
  }, operation.threadId);
  return undefined;
}

function contiguousRange(
  root: RoomDocumentSemanticBlock[],
  targetIDs: string[],
):
  | { siblings: RoomDocumentSemanticBlock[]; start: number; width: number }
  | Conflict {
  if (targetIDs.length === 0) return conflict("invalid_structure");
  if (new Set(targetIDs).size !== targetIDs.length)
    return conflict("duplicate_target");
  const locations = targetIDs.map((id) => findBlock(root, id));
  if (locations.some((location) => location === undefined))
    return conflict("missing_block");
  const resolved = locations as BlockLocation[];
  const first = resolved[0]!;
  if (
    resolved.some(
      (location, offset) =>
        location.siblings !== first.siblings ||
        location.index !== first.index + offset,
    )
  ) {
    return conflict("noncontiguous_blocks");
  }
  return {
    siblings: first.siblings,
    start: first.index,
    width: resolved.length,
  };
}

function findBlock(
  siblings: RoomDocumentSemanticBlock[],
  id: string,
): BlockLocation | undefined {
  for (let index = 0; index < siblings.length; index += 1) {
    const block = siblings[index]!;
    if (block.id === id) return { siblings, index, block };
    const nested = findBlock(block.children ?? [], id);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function validatedBlocks(
  blocks: RoomDocumentSemanticBlock[],
): RoomDocumentSemanticBlock[] {
  return validateRoomDocumentSemanticBlocks({
    schemaVersion: ROOM_DOCUMENT_SCHEMA_VERSION,
    blocks,
  }).blocks;
}

function hasIDCollision(
  current: RoomDocumentSemanticBlock[],
  replacements: RoomDocumentSemanticBlock[],
  removedIDs: Set<string>,
): boolean {
  const existing = collectIDs(current);
  for (const id of removedIDs) existing.delete(id);
  return [...collectIDs(replacements)].some((id) => existing.has(id));
}

function collectIDs(blocks: RoomDocumentSemanticBlock[]): Set<string> {
  const result = new Set<string>();
  const pending = [...blocks];
  while (pending.length > 0) {
    const block = pending.pop()!;
    if (block.id !== undefined) result.add(block.id);
    pending.push(...(block.children ?? []));
  }
  return result;
}

function documentWithBlocks(blocks: RoomDocumentSemanticBlock[]): Y.Doc {
  const document = new Y.Doc({ gc: true });
  const editor = BlockNoteEditor.create({ initialContent: blocks });
  try {
    blocksToYXmlFragment(
      editor,
      editor.document,
      document.getXmlFragment(blockNoteFragmentKey),
    );
  } catch {
    throw invalidSemantic(
      "Semantic mutation result does not match the BlockNote schema",
    );
  } finally {
    editor.unmount();
  }
  return document;
}

function blockGroup(document: Y.Doc): Y.XmlElement {
  const group = document
    .getXmlFragment(blockNoteFragmentKey)
    .toArray()
    .find(
      (node): node is Y.XmlElement =>
        node instanceof Y.XmlElement && node.nodeName === "blockGroup",
    );
  if (group === undefined)
    throw invalidSemantic("Semantic mutation state has no BlockNote group");
  return group;
}

function validateInput(input: {
  mutationId: string;
  schemaVersion: string;
  currentTitle: string;
  allowedDocumentAssetIds: string[];
  operations: RoomDocumentSemanticOperation[];
}): void {
  if (input.mutationId.trim() === "")
    throw invalidSemantic("Semantic mutation identity is required");
  if (input.schemaVersion !== semanticSchemaVersion) {
    throw new RoomDocumentModelError(
      "unsupported_document",
      "Semantic mutation schema is unsupported",
    );
  }
  validateTitle(input.currentTitle);
  if (
    input.operations.length === 0 ||
    input.operations.length > maximumOperations
  ) {
    throw invalidSemantic(
      "Semantic mutation must contain between 1 and 64 operations",
    );
  }
  if (
    new TextEncoder().encode(JSON.stringify(input.operations)).byteLength >
    (input.operations.some(
      (operation) =>
        operation.kind === "replace_body_html" ||
        operation.kind === "replace_body_blocks",
    )
      ? 8 << 20
      : maximumRequestBytes)
  ) {
    throw new RoomDocumentModelError(
      "payload_too_large",
      "Semantic mutation exceeds 256 KiB",
    );
  }
  if (
    new Set(input.allowedDocumentAssetIds).size !==
    input.allowedDocumentAssetIds.length
  ) {
    throw invalidSemantic("Pinned Document Asset IDs must be unique");
  }
}

function validateTitle(title: string): void {
  if (title.length < 1 || title.length > 255) {
    throw invalidSemantic(
      "Native Document title must contain between 1 and 255 characters",
    );
  }
}

function stableClientID(mutationID: string): number {
  const value = Number.parseInt(
    sha256Hex(new TextEncoder().encode(mutationID)).slice(0, 8),
    16,
  );
  return value === 0 ? 1 : value;
}

function conflict(reason: Conflict["reason"]): Conflict {
  return { status: "conflicted", reason };
}

function invalidSemantic(message: string): RoomDocumentModelError {
  return new RoomDocumentModelError("validation_failed", message);
}

function parseReplacementHTML(html: string): RoomDocumentSemanticBlock[] {
  if (
    typeof html !== "string" ||
    new TextEncoder().encode(html).byteLength > 1 << 20
  )
    throw invalidSemantic("Replacement HTML exceeds 1 MiB");
  const root = document.createElement("div");
  root.innerHTML = html;
  if (
    root.querySelector("script,style,iframe,object,embed,form,input") ||
    [...root.querySelectorAll("*")].some((el) =>
      [...el.attributes].some((a) => /^on/i.test(a.name)),
    )
  )
    throw invalidSemantic("Unsupported HTML in replacement");
  const elements = [
    ...root.querySelectorAll("[data-node-type=blockContainer]"),
  ];
  const ids = elements.map((el) => el.getAttribute("data-id"));
  if (
    !ids.length ||
    ids.some((id) => !id || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) ||
    new Set(ids).size !== ids.length
  )
    throw invalidSemantic(
      "Replacement requires unique stable data-id on every block",
    );
  const editor = BlockNoteEditor.create();
  try {
    const blocks = editor.tryParseHTMLToBlocks(html);
    const parsedIds: string[] = [];
    const visit = (items: typeof blocks) => {
      for (const b of items) {
        parsedIds.push(b.id);
        visit(b.children);
      }
    };
    visit(blocks);
    if (JSON.stringify(parsedIds) !== JSON.stringify(ids))
      throw invalidSemantic(
        "HTML conversion changed block identity or structure",
      );
    validateRoomDocumentSemanticBlocks({ schemaVersion: 1, blocks });
    const roundtrip = document.createElement("div");
    roundtrip.innerHTML = editor.blocksToFullHTML(blocks);
    const normalize = (element: Element) => {
      for (const el of [element, ...element.querySelectorAll("*")])
        el.removeAttribute("class");
      element.normalize();
    };
    normalize(root);
    normalize(roundtrip);
    if (!root.isEqualNode(roundtrip))
      throw invalidSemantic(
        "Replacement HTML contains formatting that cannot be preserved",
      );
    return blocks;
  } finally {
    editor.unmount();
  }
}
