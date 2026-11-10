import {
  materializeRoomDocument,
  readRoomDocumentBlocks,
} from "@linger/document-model";
import type { DocumentBodyStore } from "../../src/document/bodies.js";
import * as Y from "yjs";

import { DocumentDurabilityCoordinator } from "../../src/document/realtime-durability.js";
import { DocumentFailureEvidenceStore } from "../../src/document/failure-evidence.js";

export const documentId = "document_runtime_test";

export async function documentFixture(source = "Before selected words after") {
  const state = await materializeRoomDocument({
    materializationId: "00000000-0000-4000-8000-000000000099",
    schemaVersion: 1,
    sourceKind: "plain_text",
    sourceBytes: Buffer.from(source),
  });
  const head = {
    document_id: documentId,
    schema_version: 1,
    persisted_seq: 0,
    state_vector: Buffer.from(state.stateVector).toString("base64"),
    state_hash: state.stateHash,
    state_hash_version: 1,
  } as const;
  return { head, state };
}

// A body store whose operations each test replaces as it needs.
export function documentBodyStore(): DocumentBodyStore {
  const unexpected = () => {
    throw new Error("Unexpected Document body store call");
  };
  return {
    load: unexpected,
    save: unexpected,
    findOperation: unexpected,
    checkReferences: unexpected,
    close: async () => undefined,
  };
}

export function documentDurability(
  bodies = documentBodyStore(),
): DocumentDurabilityCoordinator {
  return new DocumentDurabilityCoordinator({
    bodies,
    maxUnsavedBacklogBytes: 1024 * 1024,
    failureEvidence: new DocumentFailureEvidenceStore({
      runtimeInstanceId: "runtime_test",
    }),
  });
}

export function residentDocument(
  stateBytes: Uint8Array,
  waitForBroadcast: () => Promise<void> = async () => undefined,
) {
  const document = new Y.Doc({ gc: true }) as Y.Doc & {
    getConnections(): Iterable<{ waitForPendingMessages(): Promise<void> }>;
  };
  Y.applyUpdate(document, stateBytes);
  document.getConnections = () => [
    { waitForPendingMessages: waitForBroadcast },
  ];
  return document;
}

export function documentText(document: Y.Doc): string {
  return readRoomDocumentBlocks(Y.encodeStateAsUpdate(document))
    .flatMap((block) => (Array.isArray(block.content) ? block.content : []))
    .map((content) =>
      typeof content === "object" &&
      content !== null &&
      "text" in content &&
      typeof content.text === "string"
        ? content.text
        : "",
    )
    .join("");
}
