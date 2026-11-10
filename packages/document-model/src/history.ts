import * as Y from "yjs";

import { inspectRoomDocumentState } from "./document-state.js";
import {
  ROOM_DOCUMENT_MAX_STATE_BYTES,
  ROOM_DOCUMENT_STATE_HASH_VERSION,
  RoomDocumentModelError,
  sha256Hex,
} from "./state-invariants.js";

const blockNoteFragmentKey = "prosemirror";

export interface RoomDocumentRevisionRestore {
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

export function restoreRoomDocumentRevision(input: {
  restoreOperationId: string;
  currentStateBytes: Uint8Array;
  targetStateBytes: Uint8Array;
}): RoomDocumentRevisionRestore {
  if (input.restoreOperationId.trim() === "") {
    throw invalidRestore("History restore operation identity is required");
  }
  if (
    input.currentStateBytes.byteLength > ROOM_DOCUMENT_MAX_STATE_BYTES ||
    input.targetStateBytes.byteLength > ROOM_DOCUMENT_MAX_STATE_BYTES
  ) {
    throw new RoomDocumentModelError(
      "payload_too_large",
      "History restore state exceeds 32 MiB",
    );
  }
  const current = loadValidatedState(input.currentStateBytes, "current");
  const target = loadValidatedState(input.targetStateBytes, "target");
  const baseVector = Y.encodeStateVector(current);
  current.clientID = stableClientID(input.restoreOperationId);

  const currentGroup = blockGroup(current);
  const targetGroup = blockGroup(target);
  const replacements = targetGroup
    .toArray()
    .filter(
      (node): node is Y.XmlElement | Y.XmlText =>
        node instanceof Y.XmlElement || node instanceof Y.XmlText,
    )
    .map((node) => node.clone());
  current.transact(() => {
    currentGroup.delete(0, currentGroup.length);
    if (replacements.length > 0) {
      currentGroup.insert(0, replacements);
    }
  }, input.restoreOperationId);

  const stateBytes = Y.encodeStateAsUpdate(current);
  if (stateBytes.byteLength > ROOM_DOCUMENT_MAX_STATE_BYTES) {
    throw new RoomDocumentModelError(
      "payload_too_large",
      "Restored History state exceeds 32 MiB",
    );
  }
  const inspection = inspectRoomDocumentState(stateBytes);
  const update = Y.encodeStateAsUpdate(current, baseVector);
  return {
    update,
    updateSha256: sha256Hex(update),
    stateBytes,
    stateBytesSha256: sha256Hex(stateBytes),
    endStateVector: Y.encodeStateVector(current),
    stateHash: sha256Hex(stateBytes),
    stateHashVersion: ROOM_DOCUMENT_STATE_HASH_VERSION,
    completeReferences: inspection.completeReferences,
  };
}

function loadValidatedState(stateBytes: Uint8Array, role: string): Y.Doc {
  try {
    inspectRoomDocumentState(stateBytes);
    const document = new Y.Doc({ gc: true });
    Y.applyUpdate(document, stateBytes);
    return document;
  } catch (error) {
    if (error instanceof RoomDocumentModelError) {
      throw error;
    }
    throw invalidRestore(`History restore ${role} Revision state is invalid`);
  }
}

function blockGroup(document: Y.Doc): Y.XmlElement {
  const group = document
    .getXmlFragment(blockNoteFragmentKey)
    .toArray()
    .find(
      (node): node is Y.XmlElement =>
        node instanceof Y.XmlElement && node.nodeName === "blockGroup",
    );
  if (group === undefined) {
    throw invalidRestore(
      "History restore Revision has no BlockNote block group",
    );
  }
  return group;
}

function stableClientID(operationID: string): number {
  const value = Number.parseInt(
    sha256Hex(new TextEncoder().encode(operationID)).slice(0, 8),
    16,
  );
  return value === 0 ? 1 : value;
}

function invalidRestore(message: string): RoomDocumentModelError {
  return new RoomDocumentModelError("validation_failed", message);
}
