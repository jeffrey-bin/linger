import {
  fingerprintRoomDocumentState,
  inspectRoomDocumentState,
  ROOM_DOCUMENT_MAX_STATE_BYTES,
  ROOM_DOCUMENT_SESSION_LIMITS,
} from "@linger/document-model";
import type { components } from "@linger/wire-contracts/node-services-internal/types";
import * as Y from "yjs";

import type { DocumentBodySave } from "./bodies.js";

type DocumentDurableHead = components["schemas"]["DocumentDurableHead"];

export interface DurableMutation {
  // The connection token's Actor; the batch's last one is its last editor.
  actorId: string;
  update: Uint8Array;
}

export interface ImmutableMutationBatch {
  candidateDocument: Y.Doc;
  count: number;
  expectedHead: DocumentDurableHead;
  save: DocumentBodySave;
}

export class DurabilityBatchError extends Error {
  readonly failureCode = "durability_invariant_failed";

  constructor(message: string) {
    super(message);
    this.name = "DurabilityBatchError";
  }
}

export function createImmutableMutationBatch(input: {
  documentId: string;
  durableDocument: Y.Doc;
  head: DocumentDurableHead;
  mutations: DurableMutation[];
}): ImmutableMutationBatch {
  // The body row stores the batch's result state, so only the mutation count
  // bounds a batch; the unsaved backlog already bounds its update bytes.
  const count = Math.min(
    input.mutations.length,
    ROOM_DOCUMENT_SESSION_LIMITS.mutations_per_batch,
  );
  const mutations = input.mutations.slice(0, count);
  const update = Y.mergeUpdates(mutations.map((mutation) => mutation.update));
  if (update.byteLength < 1) {
    throw new DurabilityBatchError("Document update batch is empty");
  }

  const candidate = cloneDocument(input.durableDocument);
  try {
    Y.applyUpdate(candidate, update);
    const candidateState = Y.encodeStateAsUpdate(candidate);
    if (candidateState.byteLength > ROOM_DOCUMENT_MAX_STATE_BYTES) {
      throw new DurabilityBatchError("Document durable state exceeds 32 MiB");
    }
    const stateVector = Y.encodeStateVector(candidate);
    const references =
      inspectRoomDocumentState(candidateState).completeReferences;
    return {
      candidateDocument: candidate,
      count,
      expectedHead: {
        document_id: input.documentId,
        schema_version: input.head.schema_version,
        persisted_seq: input.head.persisted_seq + 1,
        state_vector: Buffer.from(stateVector).toString("base64"),
        state_hash: fingerprintRoomDocumentState(candidate),
        state_hash_version: 1,
      },
      save: {
        documentId: input.documentId,
        baseSeq: input.head.persisted_seq,
        state: candidateState,
        stateVector,
        assetIds: references.documentAssetIds,
        threadIds: references.documentThreadIds,
        editorIds: orderedEditors(mutations),
        historyPoints: true,
      },
    };
  } catch (error) {
    candidate.destroy();
    throw error;
  }
}

// Each editor once, in the order of their last mutation in the batch.
function orderedEditors(mutations: DurableMutation[]): string[] {
  const editors: string[] = [];
  for (let index = mutations.length - 1; index >= 0; index -= 1) {
    const actorId = mutations[index]!.actorId;
    if (!editors.includes(actorId)) editors.unshift(actorId);
  }
  return editors;
}

function cloneDocument(document: Y.Doc): Y.Doc {
  const clone = new Y.Doc({ gc: true });
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(document));
  return clone;
}
