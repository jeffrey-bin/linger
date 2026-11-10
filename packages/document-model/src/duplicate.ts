import * as Y from "yjs";

import {
  createRoomDocumentAssetReference,
  inspectRoomDocumentState,
  parseRoomDocumentAssetReference,
} from "./document-state.js";
import {
  ROOM_DOCUMENT_MAX_STATE_BYTES,
  ROOM_DOCUMENT_STATE_HASH_VERSION,
  RoomDocumentModelError,
  sha256Hex,
} from "./state-invariants.js";

const commentMarkPattern = /^comment(?:--[A-Za-z0-9+/=]{8})?$/;
const mediaBlockTypes = new Set(["file", "image", "video", "audio"]);
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface RoomDocumentDuplicateResult {
  stateBytes: Uint8Array;
  stateBytesSha256: string;
  stateVector: Uint8Array;
  stateHash: string;
  stateHashVersion: typeof ROOM_DOCUMENT_STATE_HASH_VERSION;
  completeReferences: {
    documentAssetIds: string[];
    documentThreadIds: string[];
  };
}

export function duplicateRoomDocumentState(input: {
  duplicateOperationId: string;
  stateBytes: Uint8Array;
  assetIdMap: Readonly<Record<string, string>>;
}): RoomDocumentDuplicateResult {
  if (
    !identifierPattern.test(input.duplicateOperationId) ||
    input.stateBytes.byteLength > ROOM_DOCUMENT_MAX_STATE_BYTES
  ) {
    throw invalidDuplicate("Document Duplicate input is invalid");
  }
  const source = inspectRoomDocumentState(input.stateBytes);
  const sourceAssetIds = new Set(source.completeReferences.documentAssetIds);
  if (
    Object.keys(input.assetIdMap).length !== sourceAssetIds.size ||
    [...sourceAssetIds].some(
      (assetId) =>
        !identifierPattern.test(input.assetIdMap[assetId] ?? "") ||
        input.assetIdMap[assetId] === assetId,
    )
  ) {
    throw invalidDuplicate("Document Duplicate Asset mapping is incomplete");
  }

  const document = new Y.Doc({ gc: true });
  document.getXmlFragment("prosemirror");
  try {
    Y.applyUpdate(document, input.stateBytes);
  } catch {
    throw invalidDuplicate("Document Duplicate state is invalid");
  }
  document.clientID = stableClientId(input.duplicateOperationId);
  document.transact(() => rewriteReferences(document, input.assetIdMap));

  const stateBytes = Y.encodeStateAsUpdate(document);
  const stateBytesSha256 = sha256Hex(stateBytes);
  const result = inspectRoomDocumentState(stateBytes);
  return {
    stateBytes,
    stateBytesSha256,
    stateVector: Y.encodeStateVector(document),
    stateHash: stateBytesSha256,
    stateHashVersion: ROOM_DOCUMENT_STATE_HASH_VERSION,
    completeReferences: result.completeReferences,
  };
}

function rewriteReferences(
  document: Y.Doc,
  assetIdMap: Readonly<Record<string, string>>,
): void {
  const pending = [...document.getXmlFragment("prosemirror").toArray()];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node instanceof Y.XmlText) {
      let offset = 0;
      for (const delta of node.toDelta()) {
        if (typeof delta.insert !== "string") {
          throw invalidDuplicate("Document Duplicate inline state is invalid");
        }
        const comments = Object.keys(delta.attributes ?? {}).filter((name) =>
          commentMarkPattern.test(name),
        );
        if (comments.length > 0 && delta.insert.length > 0) {
          node.format(
            offset,
            delta.insert.length,
            Object.fromEntries(comments.map((name) => [name, null])),
          );
        }
        offset += delta.insert.length;
      }
      continue;
    }
    if (!(node instanceof Y.XmlElement)) {
      throw invalidDuplicate(
        "Document Duplicate state contains an unsupported node",
      );
    }
    if (mediaBlockTypes.has(node.nodeName)) {
      const sourceAssetId = parseRoomDocumentAssetReference(
        node.getAttribute("url"),
      );
      if (sourceAssetId !== undefined) {
        node.setAttribute(
          "url",
          createRoomDocumentAssetReference(assetIdMap[sourceAssetId]!),
        );
      }
    }
    pending.push(...node.toArray());
  }
}

function stableClientId(operationId: string): number {
  const value = Number.parseInt(
    sha256Hex(new TextEncoder().encode(operationId)).slice(0, 8),
    16,
  );
  return value === 0 ? 1 : value >>> 0;
}

function invalidDuplicate(message: string): RoomDocumentModelError {
  return new RoomDocumentModelError("validation_failed", message);
}
