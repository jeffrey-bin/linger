import { BlockNoteEditor } from "@blocknote/core";
import type {
  Block,
  DefaultBlockSchema,
  DefaultInlineContentSchema,
  DefaultStyleSchema,
} from "@blocknote/core";
import { yDocToBlocks } from "@blocknote/core/yjs";
import * as Y from "yjs";

import {
  ROOM_DOCUMENT_MAX_BLOCKS,
  ROOM_DOCUMENT_MAX_BLOCK_DEPTH,
  ROOM_DOCUMENT_MAX_INLINE_SEGMENTS,
  ROOM_DOCUMENT_MAX_REFERENCES,
  ROOM_DOCUMENT_MAX_STATE_BYTES,
  ROOM_DOCUMENT_MAX_TEXT_BYTES,
  RoomDocumentModelError,
} from "./state-invariants.js";

const blockNoteFragmentKey = "prosemirror";
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const commentMarkPattern = /^comment(?:--[A-Za-z0-9+/=]{8})?$/;
const mediaBlockTypes = new Set(["file", "image", "video", "audio"]);
const textEncoder = new TextEncoder();
export const ROOM_DOCUMENT_ASSET_REFERENCE_PREFIX = "document-asset:";

type DefaultBlock = Block<
  DefaultBlockSchema,
  DefaultInlineContentSchema,
  DefaultStyleSchema
>;

export interface RoomDocumentStateInspection {
  completeReferences: {
    documentAssetIds: string[];
    documentThreadIds: string[];
  };
  hasMediaBlocks: boolean;
}

export function inspectRoomDocumentState(
  stateBytes: Uint8Array,
): RoomDocumentStateInspection {
  if (stateBytes.byteLength > ROOM_DOCUMENT_MAX_STATE_BYTES) {
    throw invalidState("Room Document state exceeds 32 MiB");
  }
  const document = new Y.Doc({ gc: true });
  document.getXmlFragment(blockNoteFragmentKey);
  try {
    Y.applyUpdate(document, stateBytes);
  } catch {
    throw invalidState("Room Document state is not a valid Yjs update");
  }
  return inspectRoomDocument(document);
}

/**
 * Inspects a Room Document that is already decoded, so a caller holding the
 * Y.Doc saves decoding its state again. It types the BlockNote fragment on the
 * Y.Doc but leaves its state unchanged. The caller enforces the state byte
 * limit.
 */
export function inspectRoomDocument(
  document: Y.Doc,
): RoomDocumentStateInspection {
  let fragment: Y.XmlFragment;
  try {
    fragment = document.getXmlFragment(blockNoteFragmentKey);
  } catch {
    throw invalidState("Room Document must contain one BlockNote fragment");
  }
  if (document.share.size !== 1) {
    throw invalidState("Room Document must contain one BlockNote fragment");
  }

  const raw = inspectRawFragment(fragment);
  if (
    raw.documentAssetIds.size + raw.documentThreadIds.size >
    ROOM_DOCUMENT_MAX_REFERENCES
  ) {
    throw invalidState("Room Document references exceed their limit");
  }
  const stateVectorBeforeSchemaRead = Y.encodeStateVector(document);
  const editor = BlockNoteEditor.create();
  let blocks: DefaultBlock[];
  try {
    blocks = yDocToBlocks(editor, document, blockNoteFragmentKey);
  } catch {
    throw invalidState("Room Document BlockNote schema is invalid");
  } finally {
    editor.unmount();
  }
  if (
    !bytesEqual(stateVectorBeforeSchemaRead, Y.encodeStateVector(document)) ||
    countBlocks(blocks) !== raw.blockCount
  ) {
    throw invalidState("Room Document BlockNote schema is invalid");
  }
  return {
    completeReferences: {
      documentAssetIds: [...raw.documentAssetIds].sort(),
      documentThreadIds: [...raw.documentThreadIds].sort(),
    },
    hasMediaBlocks: raw.hasMediaBlocks,
  };
}

function inspectRawFragment(fragment: Y.XmlFragment): {
  blockCount: number;
  documentAssetIds: Set<string>;
  documentThreadIds: Set<string>;
  hasMediaBlocks: boolean;
} {
  const blockIds = new Set<string>();
  const documentAssetIds = new Set<string>();
  const documentThreadIds = new Set<string>();
  const pending = fragment.toArray().map((node) => ({ blockDepth: 0, node }));
  let blockCount = 0;
  let hasMediaBlocks = false;
  let inlineSegments = 0;
  let textBytes = 0;

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.node instanceof Y.XmlText) {
      for (const delta of current.node.toDelta()) {
        if (typeof delta.insert !== "string") {
          throw invalidState("Room Document inline content is invalid");
        }
        inlineSegments += 1;
        textBytes += textEncoder.encode(delta.insert).byteLength;
        inspectCommentAttributes(delta.attributes, documentThreadIds);
      }
      if (
        inlineSegments > ROOM_DOCUMENT_MAX_INLINE_SEGMENTS ||
        textBytes > ROOM_DOCUMENT_MAX_TEXT_BYTES
      ) {
        throw invalidState("Room Document content exceeds its limits");
      }
      continue;
    }
    if (!(current.node instanceof Y.XmlElement)) {
      throw invalidState("Room Document contains an unsupported Yjs node");
    }

    const isContainer = current.node.nodeName === "blockContainer";
    const blockDepth = current.blockDepth + (isContainer ? 1 : 0);
    if (blockDepth > ROOM_DOCUMENT_MAX_BLOCK_DEPTH) {
      throw invalidState("Room Document block nesting exceeds its limit");
    }
    if (isContainer) {
      const blockId = current.node.getAttribute("id");
      if (!validIdentifier(blockId, 128) || blockIds.has(blockId)) {
        throw invalidState("Room Document Block IDs must be unique and valid");
      }
      blockIds.add(blockId);
      blockCount += 1;
      if (blockCount > ROOM_DOCUMENT_MAX_BLOCKS) {
        throw invalidState("Room Document block count exceeds its limit");
      }
    }
    if (mediaBlockTypes.has(current.node.nodeName)) {
      hasMediaBlocks = true;
      inspectAssetReference(current.node, documentAssetIds);
    }
    for (const child of current.node.toArray()) {
      pending.push({ blockDepth, node: child });
    }
  }
  if (blockCount === 0) {
    throw invalidState("Room Document must contain at least one block");
  }
  return {
    blockCount,
    documentAssetIds,
    documentThreadIds,
    hasMediaBlocks,
  };
}

function inspectCommentAttributes(
  attributes: Record<string, unknown> | undefined,
  documentThreadIds: Set<string>,
): void {
  for (const [name, value] of Object.entries(attributes ?? {})) {
    if (!commentMarkPattern.test(name)) {
      continue;
    }
    if (
      value === null ||
      typeof value !== "object" ||
      !("threadId" in value) ||
      !validIdentifier(value.threadId, 64)
    ) {
      throw invalidState("Room Document Comment reference is invalid");
    }
    documentThreadIds.add(value.threadId);
  }
}

function inspectAssetReference(
  node: Y.XmlElement,
  documentAssetIds: Set<string>,
): void {
  const attributes = node.getAttributes();
  const value = attributes.url;
  if (value === "") {
    return;
  }
  const assetId = parseRoomDocumentAssetReference(value);
  if (assetId === undefined) {
    throw invalidState("Room Document Asset reference is invalid");
  }
  documentAssetIds.add(assetId);
}

export function createRoomDocumentAssetReference(assetId: string): string {
  if (!validIdentifier(assetId, 64)) {
    throw invalidState("Room Document Asset ID is invalid");
  }
  return `${ROOM_DOCUMENT_ASSET_REFERENCE_PREFIX}${assetId}`;
}

export function parseRoomDocumentAssetReference(
  reference: unknown,
): string | undefined {
  if (
    typeof reference !== "string" ||
    !reference.startsWith(ROOM_DOCUMENT_ASSET_REFERENCE_PREFIX)
  ) {
    return undefined;
  }
  const assetId = reference.slice(ROOM_DOCUMENT_ASSET_REFERENCE_PREFIX.length);
  return validIdentifier(assetId, 64) ? assetId : undefined;
}

function countBlocks(blocks: DefaultBlock[]): number {
  let count = 0;
  const pending = [...blocks];
  while (pending.length > 0) {
    const block = pending.pop()!;
    count += 1;
    pending.push(...block.children);
  }
  return count;
}

function validIdentifier(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length <= maxLength &&
    identifierPattern.test(value)
  );
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}

function invalidState(message: string): RoomDocumentModelError {
  return new RoomDocumentModelError("validation_failed", message);
}
