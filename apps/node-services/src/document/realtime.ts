import { Server, type Connection } from "@hocuspocus/server";
import { ROOM_DOCUMENT_SESSION_LIMITS } from "@linger/document-model";
import type { components as RuntimeComponents } from "@linger/wire-contracts/node-services-internal/types";
import * as Y from "yjs";

import type { DocumentBodyStore } from "./bodies.js";
import {
  DocumentDurabilityCoordinator,
  type DocumentDurabilityFailureCode,
} from "./realtime-durability.js";
import {
  RealtimeAdmissionController,
  type RealtimeAdmissionLimits,
} from "./realtime-admission.js";
import { DocumentMutationPreflight } from "./realtime-preflight.js";
import { DocumentOrderingQueue } from "./realtime-ordering.js";
import {
  DocumentSessionManager,
  RuntimeConnectionError,
  type RoomDocumentConnectionContext,
} from "./realtime-session.js";
import { ConnectionDisconnects } from "./connection-disconnects.js";
import { DocumentAwarenessPolicy } from "./realtime-awareness.js";
import { DocumentChangeCoordinator } from "./document-changes.js";
import { DocumentFailureEvidenceStore } from "./failure-evidence.js";
import { installDocumentRuntimeDOM } from "./server-dom.js";

export interface DocumentRealtimeServerOptions {
  runtimeInstanceId: string;
  // The Document bodies this Runtime loads and saves.
  bodies: DocumentBodyStore;
  // Verifies the connection tokens TeamHub signs.
  connectionTokenKey: string;
  maxUnsavedBacklogBytes?: number;
  failureEvidenceDirectory?: string;
  realtimeAdmission?: Partial<RealtimeAdmissionLimits>;
  hostname?: string;
  port?: number;
}

export type DocumentRealtimeServer = Server<RoomDocumentConnectionContext> & {
  beginDrain(signal: AbortSignal): void;
  changes: DocumentChangeCoordinator;
  // disconnect closes the Document's connections, or one Actor's, after
  // TeamHub committed a permission change. Each client reconnects with a
  // token signed under the current permission count.
  disconnect(documentId: string, actorId?: string): void;
};

type PendingRealtimeConnection = object & {
  waitForPendingMessages(): Promise<void>;
};

const runtimeIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const accessChangedReason = "Document access changed";
export const defaultMaxUnsavedBacklogBytes = 16 << 20;
const documentLoadDeadlineMs = 14_000;
type DurableAckEnvelope = RuntimeComponents["schemas"]["DurableAckEnvelope"];
type DurabilityFailureEnvelope =
  RuntimeComponents["schemas"]["DurabilityFailureEnvelope"];
type DocumentDurableHead = DurableAckEnvelope["head"];

export function createDocumentRealtimeServer(
  options: DocumentRealtimeServerOptions,
): DocumentRealtimeServer {
  validateOptions(options);
  const disconnects = new ConnectionDisconnects();
  // Realtime preflight and session recovery run document-model on this thread.
  installDocumentRuntimeDOM();
  const durability = new DocumentDurabilityCoordinator({
    bodies: options.bodies,
    maxUnsavedBacklogBytes:
      options.maxUnsavedBacklogBytes ?? defaultMaxUnsavedBacklogBytes,
    failureEvidence: new DocumentFailureEvidenceStore({
      directory: options.failureEvidenceDirectory,
      runtimeInstanceId: options.runtimeInstanceId,
    }),
    onCommitted: (documentId, head) => {
      const document = server.hocuspocus.documents.get(documentId);
      if (document === undefined) {
        return;
      }
      // One fingerprint per committed head serves every recipient.
      const deleteSetHash = durability.durableDeleteSetHash(documentId);
      for (const connection of document.getConnections()) {
        sendDurableAck(
          connection.context as RoomDocumentConnectionContext,
          head,
          deleteSetHash,
          disconnects,
          (payload) => connection.sendStateless(payload),
        );
      }
    },
    onNewerBody: (documentId, state) => {
      const document =
        loadingResidentDocuments.get(documentId) ??
        server.hocuspocus.documents.get(documentId);
      if (document !== undefined) {
        Y.applyUpdate(document, state, { kind: "saved_document_body" });
      }
    },
    onPermanentFailure: (documentId, code) => {
      const document = server.hocuspocus.documents.get(documentId);
      if (document === undefined) {
        return;
      }
      closeFailedConnections(documentId, code, [...document.getConnections()]);
    },
  });
  const admission = new RealtimeAdmissionController(options.realtimeAdmission);
  const sessions = new DocumentSessionManager({
    connectionTokenKey: options.connectionTokenKey,
    disconnects,
    durability,
    bodies: options.bodies,
  });
  const ordering = new DocumentOrderingQueue();
  const awareness = new DocumentAwarenessPolicy();
  const awarenessConnections = new Map<string, PendingRealtimeConnection>();
  const documentConnections = new Map<string, Set<PendingRealtimeConnection>>();
  const sessionExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const loadingResidentDocuments = new Map<
    string,
    Y.Doc & {
      getConnections(): Iterable<{ waitForPendingMessages(): Promise<void> }>;
    }
  >();
  const completingInitialSyncFrames = new WeakSet<object>();
  const documentLoadLeases = new Map<string, { release(): void }>();
  const residentDocumentLeases = new Map<string, { release(): void }>();
  const preflight = new DocumentMutationPreflight({
    disconnects,
    durability,
    ordering,
    bodies: options.bodies,
  });
  const changes = new DocumentChangeCoordinator({
    durability,
    ordering,
    bodies: options.bodies,
    getResidentDocument: (documentId) => {
      const loading = loadingResidentDocuments.get(documentId);
      if (loading !== undefined) {
        return loadingResident(loading);
      }
      const active = server.hocuspocus.documents.get(documentId);
      return active === undefined ? undefined : activeResident(active);
    },
  });

  const server = new Server<RoomDocumentConnectionContext>({
    address: options.hostname ?? "127.0.0.1",
    port: options.port ?? 0,
    debounce: 250,
    maxDebounce: 2_000,
    name: "linger-room-document-runtime",
    quiet: true,
    maxPendingDocuments: admission.limits.maxPendingDocumentsPerConnection,
    maxUnauthenticatedQueueMessages:
      admission.limits.maxUnauthenticatedQueueMessages,
    maxUnauthenticatedQueueSize: admission.limits.maxUnauthenticatedQueueBytes,
    stopOnSignals: false,
    websocketOptions: {
      maxPayload: ROOM_DOCUMENT_SESSION_LIMITS.yjs_frame_bytes,
    },
    yDocOptions: { gc: true, gcFilter: () => true },
    async onConnect() {
      return { admission: admission.reserveConnection() };
    },
    async onAuthenticate(payload) {
      const lease = payload.context.admission;
      if (lease === undefined) {
        throw new RuntimeConnectionError(
          "Document connection admission is missing",
        );
      }
      try {
        const context = await sessions.open(
          payload.documentName,
          payload.token,
          lease,
        );
        payload.connectionConfig.readOnly = !context.canWrite;
        return context;
      } catch (error) {
        lease.release();
        throw error;
      }
    },
    async onLoadDocument(payload) {
      const residentLease = admission.reserveResidentDocument(
        payload.documentName,
      );
      residentDocumentLeases.set(payload.documentName, residentLease);
      try {
        const lease = await ordering.acquireSessionLoad(
          payload.documentName,
          documentLoadDeadlineMs,
        );
        loadingResidentDocuments.set(payload.documentName, payload.document);
        documentLoadLeases.set(payload.documentName, lease);
        return sessions.load(payload.documentName, payload.context);
      } catch (error) {
        loadingResidentDocuments.delete(payload.documentName);
        documentLoadLeases.get(payload.documentName)?.release();
        documentLoadLeases.delete(payload.documentName);
        residentDocumentLeases.delete(payload.documentName);
        residentLease.release();
        throw error;
      }
    },
    async afterLoadDocument(payload) {
      const lease = documentLoadLeases.get(payload.documentName);
      documentLoadLeases.delete(payload.documentName);
      lease?.release();
    },
    async connected(payload) {
      payload.context.admission.markEstablished();
      if (
        disconnects.isDisconnected(
          payload.documentName,
          payload.context.actorId,
          payload.context.disconnectMark,
        )
      ) {
        // TeamHub disconnected the Document after this connection read its
        // permission count but before it joined the Document.
        payload.connection.close({ code: 1000, reason: accessChangedReason });
        return;
      }
      assertActiveConnection(payload.connection, payload.context);
      awarenessConnections.set(payload.socketId, payload.connection);
      const connections = documentConnections.get(payload.documentName);
      if (connections === undefined) {
        documentConnections.set(
          payload.documentName,
          new Set([payload.connection]),
        );
      } else {
        connections.add(payload.connection);
      }
      const expiresAt = payload.context.sessionExpiresAt;
      const scheduleExpiry = () => {
        // Node treats delays above signed int32 milliseconds as 1ms. Schedule
        // long-lived Sessions in bounded chunks, rechecking the real deadline.
        const delay = Math.min(
          2_147_483_647,
          Math.max(0, expiresAt - Date.now()),
        );
        const expiryTimer = setTimeout(() => {
          if (Date.now() < expiresAt) {
            scheduleExpiry();
            return;
          }
          payload.connection.close({
            code: 1000,
            reason: "Document session expired",
          });
        }, delay);
        expiryTimer.unref();
        sessionExpiryTimers.set(payload.socketId, expiryTimer);
      };
      scheduleExpiry();
      const failure = durability.getPermanentFailure(payload.documentName);
      if (failure !== undefined) {
        // Authentication may have succeeded just before another append failed.
        closeFailedConnections(payload.documentName, failure, [
          payload.connection,
        ]);
        return;
      }
      sendDurableAck(
        payload.context,
        payload.context.durableHead,
        durability.durableDeleteSetHash(payload.documentName),
        disconnects,
        (message) => payload.connection.sendStateless(message),
      );
    },
    async beforeHandleMessage(payload) {
      assertActiveConnection(payload.connection, payload.context);
      if (!payload.document.hasConnection(payload.connection)) {
        throw new RuntimeConnectionError("Document connection is closed");
      }
      preflight.captureRawFrame(payload.connection, payload.update);
    },
    async afterHandleMessage(payload) {
      preflight.finishRawFrame(payload.connection);
      if (completingInitialSyncFrames.delete(payload.connection)) {
        loadingResidentDocuments.delete(payload.documentName);
      }
    },
    async beforeSync(payload) {
      try {
        await preflight.authorizeSync({
          connection: payload.connection,
          context: payload.context,
          document: payload.document,
          documentId: payload.documentName,
          type: payload.type,
          update: payload.payload,
        });
      } catch (error) {
        if (
          durability.getPermanentFailure(payload.documentName) !== undefined
        ) {
          // Hocuspocus closes the offending frame's connection on rejection.
          // Keep that protocol reason fixed; authentication still reports the
          // original durability code when a new session enters the failed queue.
          throw Object.assign(new Error("Document durable save failed"), {
            code: 1000,
            reason: "Document durable save failed",
          });
        }
        throw error;
      }
      if (
        payload.type === 1 &&
        loadingResidentDocuments.has(payload.documentName)
      ) {
        completingInitialSyncFrames.add(payload.connection);
      }
    },
    async beforeHandleAwareness(payload) {
      if (payload.connection === undefined || payload.context === undefined) {
        throw new RuntimeConnectionError(
          "Document awareness requires an authenticated connection",
        );
      }
      assertActiveConnection(payload.connection, payload.context);
      awareness.authorize({
        connection: payload.connection,
        context: payload.context,
        removedClientIds: payload.removedClientIds,
        states: payload.states,
      });
    },
    async onChange(payload) {
      if (payload.connection === undefined) {
        return;
      }
      durability.recordAppliedMutation({
        connection: payload.connection,
        documentId: payload.documentName,
      });
    },
    async onStoreDocument(payload) {
      try {
        await durability.flush(payload.documentName);
      } catch (error) {
        if (durability.getPermanentFailure(payload.documentName) === undefined)
          throw error;
        // Hocuspocus retains a resident forever when this hook throws while the
        // last connection is closing. Permanent failure is already isolated and
        // notified; let it unload and capture evidence. This sends no Saved ACK.
      }
    },
    async onDisconnect(payload) {
      const connection = awarenessConnections.get(payload.socketId);
      if (connection !== undefined) {
        await connection.waitForPendingMessages();
        preflight.finishRawFrame(connection);
        documentConnections.get(payload.documentName)?.delete(connection);
        if (documentConnections.get(payload.documentName)?.size === 0) {
          documentConnections.delete(payload.documentName);
        }
        awareness.release(connection);
      }
      awarenessConnections.delete(payload.socketId);
      payload.context.admission.release();
      payload.context.disconnectMark.release();
      const timer = sessionExpiryTimers.get(payload.socketId);
      if (timer !== undefined) {
        clearTimeout(timer);
        sessionExpiryTimers.delete(payload.socketId);
      }
    },
    async beforeUnloadDocument(payload) {
      const pending = [
        ...(documentConnections.get(payload.documentName) ?? []),
      ];
      await Promise.all(
        pending.map((connection) => connection.waitForPendingMessages()),
      );
      if (
        durability.hasDocument(payload.documentName) &&
        durability.getPermanentFailure(payload.documentName) === undefined
      ) {
        await durability.flush(payload.documentName);
      }
    },
    async afterUnloadDocument(payload) {
      loadingResidentDocuments.delete(payload.documentName);
      durability.releaseDocument(payload.documentName);
      residentDocumentLeases.get(payload.documentName)?.release();
      residentDocumentLeases.delete(payload.documentName);
    },
  });
  return Object.assign(server, {
    beginDrain: (signal: AbortSignal) => durability.beginDrain(signal),
    changes,
    disconnect(documentId: string, actorId?: string) {
      disconnects.record(documentId, actorId);
      const document = server.hocuspocus.documents.get(documentId);
      for (const connection of document?.getConnections() ?? []) {
        const context = connection.context as RoomDocumentConnectionContext;
        if (actorId === undefined || context.actorId === actorId) {
          connection.close({ code: 1000, reason: accessChangedReason });
        }
      }
    },
  });
}

function assertActiveConnection(
  connection: { close(options: { code: number; reason: string }): void },
  context: RoomDocumentConnectionContext,
): void {
  if (context.sessionExpiresAt > Date.now()) {
    return;
  }
  connection.close({ code: 1000, reason: "Document session expired" });
  throw new RuntimeConnectionError("Document session has expired");
}

function activeResident(
  document: Y.Doc & {
    getConnections(): Iterable<{ waitForPendingMessages(): Promise<void> }>;
  },
) {
  return {
    state: document,
    waitForBroadcast: async () => {
      await Promise.all(
        [...document.getConnections()].map((connection) =>
          connection.waitForPendingMessages(),
        ),
      );
    },
  };
}

function loadingResident(document: Y.Doc) {
  return {
    state: document,
    waitForBroadcast: async () => undefined,
  };
}

function closeFailedConnections(
  documentId: string,
  code: DocumentDurabilityFailureCode,
  connections: Connection[],
): void {
  for (const connection of connections) {
    sendDurabilityFailure(
      connection.context as RoomDocumentConnectionContext,
      documentId,
      code,
      (payload) => connection.sendStateless(payload),
    );
  }
  // Broadcast every failure envelope before waiting for admitted frames.
  // Do not await here: failure can originate inside one of those frames.
  void Promise.allSettled(
    connections.map((connection) => connection.waitForPendingMessages()),
  ).then(() => {
    for (const connection of connections) {
      connection.close({ code: 1000, reason: "Document durable save failed" });
    }
  });
}

function sendDurabilityFailure(
  context: RoomDocumentConnectionContext,
  documentId: string,
  code: DocumentDurabilityFailureCode,
  send: (payload: string) => void,
): void {
  const envelope: DurabilityFailureEnvelope = {
    code,
    document_id: documentId,
    type: "durability_failure",
  };
  send(JSON.stringify(envelope));
}

function sendDurableAck(
  context: RoomDocumentConnectionContext,
  head: DocumentDurableHead,
  deleteSetHash: string,
  disconnects: ConnectionDisconnects,
  send: (payload: string) => void,
): void {
  if (
    context.sessionExpiresAt <= Date.now() ||
    disconnects.isDisconnected(
      head.document_id,
      context.actorId,
      context.disconnectMark,
    )
  ) {
    return;
  }
  const envelope: DurableAckEnvelope = {
    delete_set_hash: deleteSetHash,
    type: "durability_ack",
    head,
  };
  send(JSON.stringify(envelope));
}

function validateOptions(options: DocumentRealtimeServerOptions): void {
  if (
    options.runtimeInstanceId.length > 64 ||
    !runtimeIdPattern.test(options.runtimeInstanceId) ||
    options.connectionTokenKey.trim() === "" ||
    (options.maxUnsavedBacklogBytes !== undefined &&
      (!Number.isSafeInteger(options.maxUnsavedBacklogBytes) ||
        options.maxUnsavedBacklogBytes < 1))
  ) {
    throw new TypeError("Document realtime server options are invalid");
  }
}
