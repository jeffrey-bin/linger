import {
  inspectRoomDocumentState,
  ROOM_DOCUMENT_SCHEMA_VERSION,
  ROOM_DOCUMENT_STATE_HASH_VERSION,
} from "@linger/document-model";
import { sha256Hex } from "@linger/service-kit/node";
import { setTimeout as delay } from "node:timers/promises";
import type { components } from "@linger/wire-contracts/node-services-internal/types";
import * as Y from "yjs";

import type { DocumentBodyStore, LoadedDocumentBody } from "./bodies.js";
import { DocumentDurabilityCoordinator } from "./realtime-durability.js";
import type { RealtimeConnectionAdmission } from "./realtime-admission.js";
import type {
  ConnectionDisconnects,
  DisconnectMark,
} from "./connection-disconnects.js";
import { documentLogger } from "./log.js";
import { verifyConnectionToken } from "./connection-token.js";

type DocumentDurableHead = components["schemas"]["DocumentDurableHead"];

export interface RoomDocumentConnectionContext {
  admission: RealtimeConnectionAdmission;
  actorId: string;
  sessionId: string;
  sessionExpiresAt: number;
  schemaVersion: number;
  durableHead: DocumentDurableHead;
  canWrite: boolean;
  disconnectMark: DisconnectMark;
}

export class DocumentSessionManager {
  readonly #disconnects: ConnectionDisconnects;
  readonly #connectionTokenKey: string;
  readonly #durability: DocumentDurabilityCoordinator;
  readonly #bodies: DocumentBodyStore;

  constructor(input: {
    disconnects: ConnectionDisconnects;
    connectionTokenKey: string;
    durability: DocumentDurabilityCoordinator;
    bodies: DocumentBodyStore;
  }) {
    this.#disconnects = input.disconnects;
    this.#connectionTokenKey = input.connectionTokenKey;
    this.#durability = input.durability;
    this.#bodies = input.bodies;
  }

  // The token is the connection's whole authorization: TeamHub signed it with
  // the Document's permission count, and loading the body reads the current
  // count, so a token signed before any permission change is refused here.
  async open(
    documentId: string,
    authenticationToken: string,
    admission: RealtimeConnectionAdmission,
  ): Promise<RoomDocumentConnectionContext> {
    requireDocumentId(documentId);
    const claims = verifyConnectionToken(
      this.#connectionTokenKey,
      authenticationToken,
    );
    if (claims.documentId !== documentId) {
      throw new RuntimeConnectionError("Document authentication is invalid");
    }
    admission.promote(claims.sessionId);
    // Taken before the load, so a disconnect that lands while the body loads
    // still covers this connection.
    const disconnectMark = this.#disconnects.mark(documentId, claims.actorId);
    try {
      const loaded = await this.#load(documentId, admission.signal);
      if (loaded === undefined) {
        throw new RuntimeConnectionError("Document authentication is invalid");
      }
      if (loaded.permissionCount !== claims.permissionCount) {
        documentLogger().log("warn", "document.connection_token_stale", {
          document_id: documentId,
          actor_id: claims.actorId,
          session_id: claims.sessionId,
          token_permission_count: claims.permissionCount,
          permission_count: loaded.permissionCount,
        });
        throw new RuntimeConnectionError(
          "Document permissions changed since the connection token was issued",
        );
      }
      const head = await admission.runRecovery(async () =>
        verifyDocumentBody(documentId, loaded),
      );
      this.#assertConnected(documentId, claims.actorId, disconnectMark);
      const registered = this.#durability.registerDocument({
        documentId,
        head,
        stateBytes: loaded.state,
        references: {
          document_asset_ids: loaded.assetIds,
          document_thread_ids: loaded.threadIds,
        },
      });
      documentLogger().log("info", "document.connection_authenticated", {
        document_id: documentId,
        actor_id: claims.actorId,
        session_id: claims.sessionId,
        mode: claims.mode,
        permission_count: claims.permissionCount,
      });
      return {
        admission,
        actorId: claims.actorId,
        sessionId: claims.sessionId,
        sessionExpiresAt: claims.expiresAt,
        schemaVersion: head.schema_version,
        durableHead: registered.head,
        canWrite: claims.mode === "write",
        disconnectMark,
      };
    } catch (error) {
      disconnectMark.release();
      throw error;
    }
  }

  // One retry covers a dropped database connection inside the admission
  // window; an expired admission stops the wait.
  async #load(
    documentId: string,
    signal: AbortSignal,
  ): Promise<LoadedDocumentBody | undefined> {
    try {
      return await untilAborted(this.#bodies.load(documentId), signal);
    } catch (error) {
      if (signal.aborted) throw error;
      documentLogger().log("warn", "document.body_load_retry", {
        document_id: documentId,
        error_name: error instanceof Error ? error.name : "unknown",
      });
      await delay(200, undefined, { signal });
      return await untilAborted(this.#bodies.load(documentId), signal);
    }
  }

  load(documentId: string, context: RoomDocumentConnectionContext): Y.Doc {
    this.#assertConnected(documentId, context.actorId, context.disconnectMark);
    const document = new Y.Doc({ gc: true });
    Y.applyUpdate(document, this.#durability.captureLiveState(documentId));
    return document;
  }

  #assertConnected(
    documentId: string,
    actorId: string,
    mark: DisconnectMark,
  ): void {
    if (this.#disconnects.isDisconnected(documentId, actorId, mark)) {
      throw new RuntimeConnectionError("Document access changed");
    }
  }
}

function untilAborted<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      new RuntimeConnectionError("Document connection admission expired"),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(
        new RuntimeConnectionError("Document connection admission expired"),
      );
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

// verifyDocumentBody returns the durable head of a loaded body once its state
// parses and matches its vector and references. The body is the only copy of
// the online state, so a mismatch fails the connection.
export function verifyDocumentBody(
  documentId: string,
  body: LoadedDocumentBody,
): DocumentDurableHead {
  const document = new Y.Doc({ gc: true });
  try {
    try {
      Y.applyUpdate(document, body.state);
    } catch {
      throw new RuntimeConnectionError(
        "Document state is not a valid Yjs update",
      );
    }
    if (
      !Buffer.from(Y.encodeStateVector(document)).equals(
        Buffer.from(body.stateVector),
      )
    ) {
      throw new RuntimeConnectionError(
        "Document state vector does not match its body",
      );
    }
  } finally {
    document.destroy();
  }
  let references: ReturnType<
    typeof inspectRoomDocumentState
  >["completeReferences"];
  try {
    references = inspectRoomDocumentState(body.state).completeReferences;
  } catch {
    throw new RuntimeConnectionError("Room Document schema is invalid");
  }
  if (
    !sameStrings(references.documentAssetIds, body.assetIds) ||
    !sameStrings(references.documentThreadIds, body.threadIds)
  ) {
    throw new RuntimeConnectionError(
      "Document references do not match its body",
    );
  }
  return {
    document_id: documentId,
    schema_version: ROOM_DOCUMENT_SCHEMA_VERSION,
    persisted_seq: body.seq,
    state_vector: Buffer.from(body.stateVector).toString("base64"),
    state_hash: sha256Hex(body.state),
    state_hash_version: ROOM_DOCUMENT_STATE_HASH_VERSION,
  };
}

function sameStrings(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function requireDocumentId(documentId: string): void {
  if (
    documentId.length > 64 ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(documentId)
  ) {
    throw new RuntimeConnectionError("Document identifier is invalid");
  }
}

export class RuntimeConnectionError extends Error {
  readonly code = 4403;
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "RuntimeConnectionError";
    this.reason = reason;
  }
}
