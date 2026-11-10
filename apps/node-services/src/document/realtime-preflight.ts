import {
  inspectRoomDocument,
  ROOM_DOCUMENT_SESSION_LIMITS,
  type RoomDocumentStateInspection,
} from "@linger/document-model";
import * as Y from "yjs";

import type { DocumentBodyStore } from "./bodies.js";
import { DocumentDurabilityCoordinator } from "./realtime-durability.js";
import {
  RuntimeConnectionError,
  type RoomDocumentConnectionContext,
} from "./realtime-session.js";
import { stateBundleFits } from "./realtime-recovery-budget.js";
import type { ConnectionDisconnects } from "./connection-disconnects.js";
import {
  DocumentOrderingQueue,
  type DocumentOrderingLease,
} from "./realtime-ordering.js";

const mutationAuthorizationDeadlineMs = 5_000;

// Preflight admits a frame under the connection's verified token. It checks the
// frame's schema, size and references locally and reads the database only for
// Asset or Comment Thread references the Document has not had before.
export class DocumentMutationPreflight {
  readonly #disconnects: ConnectionDisconnects;
  readonly #durability: DocumentDurabilityCoordinator;
  readonly #leases = new WeakMap<object, DocumentOrderingLease>();
  readonly #ordering: DocumentOrderingQueue;
  readonly #rawFrames = new WeakMap<object, Uint8Array>();
  readonly #bodies: DocumentBodyStore;

  constructor(input: {
    disconnects: ConnectionDisconnects;
    durability: DocumentDurabilityCoordinator;
    ordering: DocumentOrderingQueue;
    bodies: DocumentBodyStore;
  }) {
    this.#disconnects = input.disconnects;
    this.#durability = input.durability;
    this.#ordering = input.ordering;
    this.#bodies = input.bodies;
  }

  captureRawFrame(connection: object, rawFrame: Uint8Array): void {
    this.#rawFrames.set(connection, rawFrame);
  }

  finishRawFrame(connection: object): void {
    this.#rawFrames.delete(connection);
    this.#durability.discardUnappliedMutation(connection);
    this.#releaseLease(connection);
  }

  async authorizeSync(input: {
    connection: object;
    context: RoomDocumentConnectionContext;
    document: Y.Doc;
    documentId: string;
    type: number;
    update: Uint8Array;
  }): Promise<void> {
    if (input.type === 0) {
      return;
    }
    if (input.type !== 1 && input.type !== 2) {
      throw new RuntimeConnectionError("Yjs sync message type is invalid");
    }
    const rawFrame = this.#rawFrames.get(input.connection);
    if (
      rawFrame === undefined ||
      rawFrame.byteLength < 1 ||
      rawFrame.byteLength > ROOM_DOCUMENT_SESSION_LIMITS.yjs_frame_bytes
    ) {
      throw new RuntimeConnectionError("Yjs mutation frame is invalid");
    }
    let lease: DocumentOrderingLease;
    try {
      lease = await this.#ordering.acquireMutation(
        input.documentId,
        mutationAuthorizationDeadlineMs,
      );
    } catch (error) {
      if (
        error instanceof RuntimeConnectionError &&
        error.reason === "Document mutation queue timed out"
      ) {
        throw new RuntimeConnectionError(
          "Document mutation authorization timed out",
        );
      }
      throw error;
    }
    this.#leases.set(input.connection, lease);
    try {
      if (
        !input.context.canWrite ||
        input.context.sessionExpiresAt <= Date.now() ||
        this.#disconnects.isDisconnected(
          input.documentId,
          input.context.actorId,
          input.context.disconnectMark,
        )
      ) {
        throw new RuntimeConnectionError("Document mutation is not authorized");
      }
      const liveState = Y.encodeStateAsUpdate(input.document);
      const candidate = cloneAndApply(liveState, input.update);
      let inspection: RoomDocumentStateInspection;
      try {
        const candidateState = Y.encodeStateAsUpdate(candidate);
        if (Buffer.from(candidateState).equals(Buffer.from(liveState))) {
          this.#releaseLease(input.connection);
          return;
        }
        // The state bundle budget below also bounds the state's bytes.
        inspection = inspectCandidate(candidate);
        const candidateStateVector = Y.encodeStateVector(candidate);
        if (
          !stateBundleFits({
            stateBytes: candidateState.byteLength,
            stateVectorBytes: candidateStateVector.byteLength,
            references: inspection.completeReferences,
            limit: ROOM_DOCUMENT_SESSION_LIMITS.state_bundle_decoded_bytes,
          })
        ) {
          throw new RuntimeConnectionError(
            "Document state bundle exceeds its decoded size limit",
          );
        }
      } finally {
        candidate.destroy();
      }
      this.#durability.assertWritable(
        input.documentId,
        input.update.byteLength,
      );

      const unknown = this.#durability.unknownReferences(input.documentId, {
        document_asset_ids: inspection.completeReferences.documentAssetIds,
        document_thread_ids: inspection.completeReferences.documentThreadIds,
      });
      if (
        unknown.document_asset_ids.length > 0 ||
        unknown.document_thread_ids.length > 0
      ) {
        const check = await withinDeadline(
          this.#bodies.checkReferences({
            documentId: input.documentId,
            assetIds: unknown.document_asset_ids,
            threadIds: unknown.document_thread_ids,
          }),
          lease.remainingMilliseconds(),
        );
        if (check !== "available") {
          throw new RuntimeConnectionError(
            "Document mutation references are unavailable",
          );
        }
        this.#durability.rememberReferences(input.documentId, unknown);
      }
      this.#durability.reserveMutation({
        connection: input.connection,
        documentId: input.documentId,
        actorId: input.context.actorId,
        update: input.update,
      });
    } catch (error) {
      this.#releaseLease(input.connection);
      throw error;
    }
  }

  #releaseLease(connection: object): void {
    const lease = this.#leases.get(connection);
    if (lease === undefined) {
      return;
    }
    this.#leases.delete(connection);
    lease.release();
  }
}

// The reference check shares the frame's authorization deadline.
function withinDeadline<T>(
  operation: Promise<T>,
  milliseconds: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new RuntimeConnectionError(
            "Document mutation authorization timed out",
          ),
        ),
      milliseconds,
    );
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function cloneAndApply(liveState: Uint8Array, update: Uint8Array): Y.Doc {
  const candidate = new Y.Doc({ gc: true });
  try {
    Y.applyUpdate(candidate, liveState);
    Y.applyUpdate(candidate, update);
  } catch {
    throw new RuntimeConnectionError("Yjs mutation update is invalid");
  }
  return candidate;
}

function inspectCandidate(candidate: Y.Doc): RoomDocumentStateInspection {
  try {
    return inspectRoomDocument(candidate);
  } catch {
    throw new RuntimeConnectionError("Room Document schema is invalid");
  }
}
