import {
  fingerprintRoomDocumentDeletes,
  fingerprintRoomDocumentState,
} from "@linger/document-model";
import type { components } from "@linger/wire-contracts/node-services-internal/types";
import * as Y from "yjs";
import type { DocumentBodyStore } from "./bodies.js";
import { DocumentFailureEvidenceStore } from "./failure-evidence.js";

import {
  createImmutableMutationBatch,
  DurabilityBatchError,
  type DurableMutation,
  type ImmutableMutationBatch,
} from "./realtime-durability-batches.js";
import { sleep } from "@linger/service-kit";
import { sha256Hex } from "@linger/service-kit/node";
import { documentLogger } from "./log.js";

type DocumentDurableHead = components["schemas"]["DocumentDurableHead"];
type CompleteReferences = components["schemas"]["CompleteReferences"];

type PendingMutation = DurableMutation & {
  kind: "mutation";
};

type PendingEntry = PendingMutation;

interface DocumentQueue {
  durableDocument: Y.Doc;
  durableStateBytes: Uint8Array;
  failure?: DocumentDurabilityFailureCode;
  failureAt?: string;
  head: DocumentDurableHead;
  inFlightHead?: DocumentDurableHead;
  pending: PendingEntry[];
  pendingBytes: number;
  reservedMutations: number;
  // Asset and Comment Thread references confirmed for this Document; a frame
  // that adds no other reference reads nothing from the database.
  knownReferences: Set<string>;
  inFlight?: Promise<void>;
  // Settles once the batch on the wire has committed or proved its base stale.
  appendSettled?: Promise<void>;
}

export type DocumentDurabilityFailureCode =
  components["schemas"]["DurabilityFailureEnvelope"]["code"];

export class DocumentDurabilityCoordinator {
  readonly #bodies: DocumentBodyStore;
  readonly #documents = new Map<string, DocumentQueue>();
  readonly #onCommitted: (
    documentId: string,
    head: DocumentDurableHead,
  ) => void;
  readonly #onPermanentFailure: (
    documentId: string,
    code: DocumentDurabilityFailureCode,
  ) => void;
  readonly #onNewerBody: (documentId: string, state: Uint8Array) => void;
  readonly #admittedFrames = new WeakMap<
    object,
    { documentId: string; actorId: string; update: Uint8Array }
  >();
  readonly #maxUnsavedBacklogBytes: number;
  readonly #failureEvidence: DocumentFailureEvidenceStore;
  readonly #drainController = new AbortController();
  #drainSignal: AbortSignal | undefined;

  constructor(input: {
    bodies: DocumentBodyStore;
    maxUnsavedBacklogBytes: number;
    failureEvidence: DocumentFailureEvidenceStore;
    onCommitted?: (documentId: string, head: DocumentDurableHead) => void;
    onPermanentFailure?: (
      documentId: string,
      code: DocumentDurabilityFailureCode,
    ) => void;
    // Merges a newer saved body into the resident Document, which broadcasts
    // it to the open connections.
    onNewerBody?: (documentId: string, state: Uint8Array) => void;
  }) {
    this.#bodies = input.bodies;
    this.#maxUnsavedBacklogBytes = input.maxUnsavedBacklogBytes;
    this.#failureEvidence = input.failureEvidence;
    this.#onCommitted = input.onCommitted ?? (() => undefined);
    this.#onPermanentFailure = input.onPermanentFailure ?? (() => undefined);
    this.#onNewerBody = input.onNewerBody ?? (() => undefined);
  }

  registerDocument(input: {
    documentId: string;
    head: DocumentDurableHead;
    stateBytes: Uint8Array;
    references: CompleteReferences;
  }): { head: DocumentDurableHead; stateBytes: Uint8Array } {
    const existing = this.#documents.get(input.documentId);
    if (existing?.failure !== undefined) {
      throw new DurabilityError(
        "Document durable save has permanently failed",
        existing.failure,
      );
    }
    const recoveredDocument = new Y.Doc({ gc: true });
    Y.applyUpdate(recoveredDocument, input.stateBytes);
    if (
      sha256Hex(input.stateBytes) !== input.head.state_hash ||
      Buffer.from(Y.encodeStateVector(recoveredDocument)).toString("base64") !==
        input.head.state_vector
    ) {
      recoveredDocument.destroy();
      throw new DurabilityError(
        "Recovered Document state does not match its durable head",
      );
    }
    if (existing !== undefined) {
      if (
        input.head.document_id !== existing.head.document_id ||
        input.head.schema_version !== existing.head.schema_version ||
        input.head.state_hash_version !== existing.head.state_hash_version ||
        (input.head.persisted_seq === existing.head.persisted_seq &&
          !sameHead(existing.head, input.head))
      ) {
        recoveredDocument.destroy();
        throw new DurabilityError(
          "Loaded body head does not match the resident durable head",
        );
      }
      addReferences(existing.knownReferences, input.references);
      if (
        existing.inFlightHead !== undefined &&
        sameHead(existing.inFlightHead, input.head)
      ) {
        // The batch on the wire is saved and only its reply is pending.
        existing.durableDocument.destroy();
        existing.durableDocument = recoveredDocument;
        existing.durableStateBytes = input.stateBytes.slice();
        existing.head = input.head;
      } else if (
        input.head.persisted_seq > existing.head.persisted_seq &&
        existing.inFlightHead === undefined
      ) {
        this.#adopt(input.documentId, existing, {
          document: recoveredDocument,
          stateBytes: input.stateBytes,
          head: input.head,
        });
      } else {
        recoveredDocument.destroy();
      }
      return {
        head: existing.head,
        stateBytes: existing.durableStateBytes.slice(),
      };
    }
    const queue: DocumentQueue = {
      durableDocument: recoveredDocument,
      durableStateBytes: input.stateBytes.slice(),
      head: input.head,
      pending: [],
      pendingBytes: 0,
      reservedMutations: 0,
      knownReferences: new Set(),
    };
    addReferences(queue.knownReferences, input.references);
    this.#documents.set(input.documentId, queue);
    return { head: input.head, stateBytes: input.stateBytes.slice() };
  }

  beginDrain(signal: AbortSignal): void {
    if (this.#drainSignal !== undefined && this.#drainSignal !== signal) {
      throw new DurabilityError("Document Runtime drain is already active");
    }
    this.#drainSignal = signal;
    if (signal.aborted) {
      this.#drainController.abort(signal.reason);
      return;
    }
    signal.addEventListener(
      "abort",
      () => this.#drainController.abort(signal.reason),
      { once: true },
    );
  }

  // References of `references` not yet confirmed for the Document.
  unknownReferences(
    documentId: string,
    references: CompleteReferences,
  ): CompleteReferences {
    const known = this.#documents.get(documentId)?.knownReferences;
    if (known === undefined) {
      throw new DurabilityError("Document durable queue is not initialized");
    }
    return {
      document_asset_ids: references.document_asset_ids.filter(
        (id) => !known.has(assetReference(id)),
      ),
      document_thread_ids: references.document_thread_ids.filter(
        (id) => !known.has(threadReference(id)),
      ),
    };
  }

  rememberReferences(documentId: string, references: CompleteReferences): void {
    const queue = this.#documents.get(documentId);
    if (queue !== undefined) addReferences(queue.knownReferences, references);
  }

  reserveMutation(input: {
    connection: object;
    documentId: string;
    actorId: string;
    update: Uint8Array;
  }): void {
    if (this.#admittedFrames.has(input.connection)) {
      throw new DurabilityError(
        "Connection already has an unapplied Document mutation",
      );
    }
    const queue = this.#documents.get(input.documentId);
    if (queue === undefined) {
      throw new DurabilityError("Document durable queue is not initialized");
    }
    this.assertWritable(input.documentId, input.update.byteLength);
    queue.pendingBytes += input.update.byteLength;
    queue.reservedMutations += 1;
    this.#admittedFrames.set(input.connection, {
      documentId: input.documentId,
      actorId: input.actorId,
      update: input.update.slice(),
    });
  }

  assertWritable(documentId: string, additionalBytes = 0): void {
    const queue = this.#documents.get(documentId);
    if (queue === undefined) {
      throw new DurabilityError("Document durable queue is not initialized");
    }
    if (queue.failure !== undefined) {
      throw new DurabilityError(
        "Document durable save has permanently failed",
        queue.failure,
      );
    }
    if (queue.pendingBytes + additionalBytes > this.#maxUnsavedBacklogBytes) {
      const error = new DurabilityError(
        "Document unsaved backlog exceeds its memory limit",
        "backlog_exceeded",
      );
      this.#markPermanentFailure(documentId, queue, error);
      throw error;
    }
  }

  getPermanentFailure(
    documentId: string,
  ): DocumentDurabilityFailureCode | undefined {
    return this.#documents.get(documentId)?.failure;
  }

  recordAppliedMutation(input: {
    connection: object;
    documentId: string;
  }): void {
    const reserved = this.#admittedFrames.get(input.connection);
    if (reserved === undefined || reserved.documentId !== input.documentId) {
      throw new DurabilityError(
        "Applied Document mutation was not admitted by preflight",
      );
    }
    const queue = this.#documents.get(input.documentId);
    if (queue === undefined) {
      throw new DurabilityError("Document durable queue is not initialized");
    }
    this.#admittedFrames.delete(input.connection);
    queue.reservedMutations -= 1;
    queue.pending.push({
      kind: "mutation",
      actorId: reserved.actorId,
      update: reserved.update,
    });
  }

  discardUnappliedMutation(connection: object): void {
    const reserved = this.#admittedFrames.get(connection);
    if (reserved !== undefined) {
      const queue = this.#documents.get(reserved.documentId);
      if (queue !== undefined) {
        queue.pendingBytes -= reserved.update.byteLength;
        queue.reservedMutations -= 1;
        if (queue.failure !== undefined) this.#reportFailedQueues();
      }
    }
    this.#admittedFrames.delete(connection);
  }

  async flush(documentId: string): Promise<void> {
    const queue = this.#documents.get(documentId);
    if (queue === undefined) {
      throw new DurabilityError("Document durable queue is not initialized");
    }
    if (queue.failure !== undefined) {
      throw new DurabilityError(
        "Document durable save has permanently failed",
        queue.failure,
      );
    }
    if (queue.inFlight !== undefined) {
      await queue.inFlight;
      return;
    }
    queue.inFlight = this.#drain(documentId, queue);
    try {
      await queue.inFlight;
    } catch (error) {
      this.#markPermanentFailure(documentId, queue, error);
      throw error;
    } finally {
      queue.inFlight = undefined;
    }
  }

  // Waits until no batch is on the wire, so a committed update meets the head
  // those batches leave behind.
  async settleAppend(documentId: string): Promise<void> {
    const queue = this.#documents.get(documentId);
    while (queue?.appendSettled !== undefined) await queue.appendSettled;
  }

  hasUnsavedMutations(documentId: string): boolean {
    const queue = this.#documents.get(documentId);
    return (
      queue !== undefined &&
      (queue.pending.length > 0 || queue.reservedMutations > 0)
    );
  }

  captureCommittedState(documentId: string): {
    head: DocumentDurableHead;
    stateBytes: Uint8Array;
  } {
    const queue = this.#documents.get(documentId);
    if (queue === undefined || queue.failure !== undefined) {
      throw new DurabilityError(
        "Document durable state is not ready for a committed operation",
      );
    }
    return {
      head: { ...queue.head },
      stateBytes: queue.durableStateBytes.slice(),
    };
  }

  // A server change the Runtime saved may land under unsaved mutations: they
  // stay pending and the next batch carries them onto the new head.
  commitExternalUpdate(input: {
    documentId: string;
    basePersistedSeq: number;
    update: Uint8Array;
    committedHead: DocumentDurableHead;
  }): void {
    const queue = this.#documents.get(input.documentId);
    if (queue === undefined || queue.failure !== undefined) {
      throw new DurabilityError(
        "Document durable state is not ready for an external Commit",
      );
    }
    if (sameHead(queue.head, input.committedHead)) {
      return;
    }
    if (
      queue.head.persisted_seq !== input.basePersistedSeq ||
      input.committedHead.persisted_seq !== input.basePersistedSeq + 1
    ) {
      throw new DurabilityError(
        "External Commit does not advance the resident durable head",
      );
    }
    const candidate = cloneDocument(queue.durableDocument);
    // A change that left the body alone (a title) has an empty update and
    // only advances the head.
    if (input.update.byteLength > 0) Y.applyUpdate(candidate, input.update);
    if (!stateMatchesHead(candidate, input.committedHead)) {
      candidate.destroy();
      throw new DurabilityError(
        "External Commit does not match the resident durable state",
      );
    }
    queue.durableDocument.destroy();
    queue.durableDocument = candidate;
    queue.durableStateBytes = Y.encodeStateAsUpdate(candidate);
    queue.head = { ...input.committedHead };
    this.#onCommitted(input.documentId, queue.head);
  }

  captureLiveState(documentId: string): Uint8Array {
    const queue = this.#documents.get(documentId);
    if (queue === undefined || queue.failure !== undefined) {
      throw new DurabilityError("Document live state is unavailable");
    }
    return Y.encodeStateAsUpdate(queue.durableDocument);
  }

  // The delete set of the durable state, which a durable ACK carries so a
  // client can tell whether it saw every deletion.
  durableDeleteSetHash(documentId: string): string {
    const queue = this.#documents.get(documentId);
    if (queue === undefined || queue.failure !== undefined) {
      throw new DurabilityError("Document live state is unavailable");
    }
    return fingerprintRoomDocumentDeletes(queue.durableDocument);
  }

  releaseDocument(documentId: string): void {
    const queue = this.#documents.get(documentId);
    if (queue === undefined) {
      return;
    }
    if (queue.inFlight !== undefined) return;
    if (queue.failure !== undefined) {
      // Pending mutations come from client updates, also retained in the client
      // Y.Doc/IndexedDB. Outbox updates are already durable in TeamHub. Evidence
      // is extra insurance, not the only copy; no new save repairs this queue.
      this.#recordFailureEvidence(documentId, queue);
    } else if (queue.pending.length > 0 || queue.reservedMutations > 0) {
      return;
    }
    queue.durableDocument.destroy();
    this.#documents.delete(documentId);
    if (queue.failure !== undefined) this.#reportFailedQueues();
  }

  hasDocument(documentId: string): boolean {
    return this.#documents.has(documentId);
  }

  #markPermanentFailure(
    documentId: string,
    queue: DocumentQueue,
    error: unknown,
  ): void {
    if (queue.failure !== undefined) {
      return;
    }
    queue.failure = durabilityFailureCode(error);
    queue.failureAt = new Date().toISOString();
    this.#reportFailedQueues();
    this.#onPermanentFailure(documentId, queue.failure);
  }

  #recordFailureEvidence(documentId: string, queue: DocumentQueue): void {
    if (queue.failure === undefined || queue.failureAt === undefined) return;
    this.#failureEvidence.record({
      document_id: documentId,
      failure_code: queue.failure,
      failure_at: queue.failureAt,
      released_at: new Date().toISOString(),
      head: queue.head,
      pending: queue.pending.map((entry) => ({
        kind: entry.kind,
        actor_id: entry.actorId,
        update_base64: Buffer.from(entry.update).toString("base64"),
        update_bytes: entry.update.byteLength,
      })),
      pending_bytes: queue.pendingBytes,
    });
  }

  #reportFailedQueues(): void {
    let count = 0;
    let bytes = 0;
    for (const queue of this.#documents.values()) {
      if (queue.failure !== undefined) {
        count += 1;
        bytes += queue.pendingBytes;
      }
    }
    documentLogger().log("info", "document_failed_queues", {
      failed_queue_count: count,
      failed_queue_bytes: bytes,
    });
  }

  async #drain(documentId: string, queue: DocumentQueue): Promise<void> {
    while (queue.pending.length > 0) {
      const base = queue.head;
      const batch = createImmutableMutationBatch({
        documentId,
        durableDocument: queue.durableDocument,
        head: base,
        mutations: queue.pending,
      });
      queue.inFlightHead = batch.expectedHead;
      let settle!: () => void;
      queue.appendSettled = new Promise((resolve) => (settle = resolve));
      let committed: DocumentDurableHead | undefined;
      try {
        committed = await this.#saveUntilCommitted(batch, queue);
      } catch (error) {
        batch.candidateDocument.destroy();
        throw error;
      } finally {
        queue.inFlightHead = undefined;
        queue.appendSettled = undefined;
        settle();
      }
      if (committed === undefined) {
        // Another writer saved this base first. Adopt its body, and the next
        // batch carries the pending mutations onto it.
        batch.candidateDocument.destroy();
        await this.#adoptSavedBody(documentId, queue, base);
        continue;
      }
      // Adopt the exact candidate that was validated and committed. Reapplying
      // to another Y.Doc can encode equivalent GC ranges differently.
      queue.durableDocument.destroy();
      queue.durableDocument = batch.candidateDocument;
      queue.durableStateBytes = batch.save.state;
      queue.head = committed;
      const committedMutations = queue.pending.splice(0, batch.count);
      queue.pendingBytes -= committedMutations.reduce(
        (bytes, mutation) => bytes + mutation.update.byteLength,
        0,
      );
      if (queue.failure !== undefined) {
        this.#reportFailedQueues();
        // An already-admitted save can settle after backlog failure. Keep its
        // durable head, but never drain another batch or acknowledge live state.
        throw new DurabilityError(
          "Document durable save has permanently failed",
          queue.failure,
        );
      }
      this.#onCommitted(documentId, committed);
    }
  }

  async #adoptSavedBody(
    documentId: string,
    queue: DocumentQueue,
    staleBase: DocumentDurableHead,
  ): Promise<void> {
    const loaded = await this.#bodies.load(documentId);
    if (loaded === undefined || loaded.seq <= staleBase.persisted_seq) {
      throw new DurabilityError(
        "The Document body refused the save without a newer body",
        "append_rejected",
      );
    }
    if (queue.head.persisted_seq >= loaded.seq) return;
    const document = new Y.Doc({ gc: true });
    Y.applyUpdate(document, loaded.state);
    this.#adopt(documentId, queue, {
      document,
      stateBytes: loaded.state,
      head: {
        ...queue.head,
        persisted_seq: loaded.seq,
        state_vector: Buffer.from(loaded.stateVector).toString("base64"),
        state_hash: sha256Hex(loaded.state),
      },
    });
  }

  // A body saved by another writer always extends the resident durable state,
  // so the resident Document merges it and pending mutations stay pending.
  #adopt(
    documentId: string,
    queue: DocumentQueue,
    body: {
      document: Y.Doc;
      stateBytes: Uint8Array;
      head: DocumentDurableHead;
    },
  ): void {
    if (
      Buffer.from(Y.encodeStateVector(body.document)).toString("base64") !==
      body.head.state_vector
    ) {
      body.document.destroy();
      throw new DurabilityError(
        "Saved Document body does not match its sequence head",
      );
    }
    queue.durableDocument.destroy();
    queue.durableDocument = body.document;
    queue.durableStateBytes = body.stateBytes.slice();
    queue.head = body.head;
    this.#onNewerBody(documentId, body.stateBytes);
    this.#onCommitted(documentId, queue.head);
  }

  // Returns undefined when the body moved past the batch's base.
  async #saveUntilCommitted(
    batch: ImmutableMutationBatch,
    queue: DocumentQueue,
  ): Promise<DocumentDurableHead | undefined> {
    let delay = 100;
    while (true) {
      // A different admitted frame can fail the queue while this save or its
      // backoff is in flight. Do not issue another save after that.
      if (queue.failure !== undefined) {
        throw new DurabilityError(
          "Document durable save has permanently failed",
          queue.failure,
        );
      }
      if (this.#drainController.signal.aborted) {
        throw new DurabilityError("Document Runtime drain deadline expired");
      }
      let result;
      try {
        result = await this.#bodies.save(batch.save);
      } catch (error) {
        documentLogger().log("warn", "document.body_save_retry", {
          document_id: batch.save.documentId,
          error_name: error instanceof Error ? error.name : "unknown",
        });
        await sleep(delay, this.#drainController.signal);
        delay = Math.min(delay * 2, 2_000);
        continue;
      }
      switch (result.kind) {
        case "saved":
          if (result.seq !== batch.expectedHead.persisted_seq) {
            throw new DurabilityError(
              "Document body saved an unexpected sequence",
            );
          }
          return batch.expectedHead;
        case "stale":
          return undefined;
        case "rejected":
          throw new DurabilityError(
            "The database permanently rejected the Document body save",
            "append_rejected",
          );
      }
    }
  }
}

function addReferences(target: Set<string>, references: CompleteReferences) {
  for (const id of references.document_asset_ids) {
    target.add(assetReference(id));
  }
  for (const id of references.document_thread_ids) {
    target.add(threadReference(id));
  }
}

function assetReference(id: string): string {
  return `asset:${id}`;
}

function threadReference(id: string): string {
  return `thread:${id}`;
}

function sameHead(
  left: DocumentDurableHead,
  right: DocumentDurableHead,
): boolean {
  return (
    left.document_id === right.document_id &&
    left.schema_version === right.schema_version &&
    left.persisted_seq === right.persisted_seq &&
    left.state_vector === right.state_vector &&
    left.state_hash === right.state_hash &&
    left.state_hash_version === right.state_hash_version
  );
}

function stateMatchesHead(document: Y.Doc, head: DocumentDurableHead): boolean {
  return (
    Buffer.from(Y.encodeStateVector(document)).toString("base64") ===
      head.state_vector &&
    fingerprintRoomDocumentState(document) === head.state_hash
  );
}

function cloneDocument(document: Y.Doc): Y.Doc {
  const clone = new Y.Doc({ gc: true });
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(document));
  return clone;
}

class DurabilityError extends Error {
  readonly reason: string;
  constructor(
    message: string,
    readonly failureCode: DocumentDurabilityFailureCode = "durability_invariant_failed",
  ) {
    super(`${message}: ${failureCode}`);
    this.name = "DurabilityError";
    this.reason = this.message;
  }
}

function durabilityFailureCode(error: unknown): DocumentDurabilityFailureCode {
  return error instanceof DurabilityError ||
    error instanceof DurabilityBatchError
    ? error.failureCode
    : "durability_invariant_failed";
}
