import { createHash, createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";

import { HocuspocusProvider } from "@hocuspocus/provider";
import {
  inspectRoomDocumentState,
  materializeRoomDocument,
} from "@linger/document-model";
import * as Y from "yjs";

import type {
  DocumentBodySave,
  DocumentBodySaveResult,
  DocumentBodyStore,
  DocumentReferenceCheck,
  LoadedDocumentBody,
} from "../../src/document/bodies.js";
import {
  createDocumentRealtimeServer,
  type DocumentRealtimeServerOptions,
} from "../../src/document/realtime.js";
import { installDocumentRuntimeDOM } from "../../src/document/server-dom.js";

export const documentId = "document_realtime_test";
export const runtimeInstanceId = "document_runtime_test";
export const connectionTokenKey = "document-connection-token-test-key";

type InitialState = Awaited<ReturnType<typeof materializeRoomDocument>>;

export async function createInitialState(
  source = "Durable initial state",
): Promise<InitialState> {
  installDocumentRuntimeDOM();
  return await materializeRoomDocument({
    materializationId: "realtime-materialization",
    schemaVersion: 1,
    sourceKind: "plain_text",
    sourceBytes: Buffer.from(source),
  });
}

export interface MemoryBodyRow {
  active: boolean;
  permissionCount: number;
  seq: number;
  state: Uint8Array;
  stateVector: Uint8Array;
  assetIds: string[];
  threadIds: string[];
  editorIds: string[];
  operations: Array<{ id: string; seq: number; title: string }>;
}

/**
 * An in-memory document_bodies table with the store's semantics: a save
 * applies only on its base sequence and to an active Document. Hooks run
 * before the default behavior and replace it when they return a value.
 */
export class MemoryDocumentBodies implements DocumentBodyStore {
  readonly rows = new Map<string, MemoryBodyRow>();
  readonly loads: string[] = [];
  readonly saves: DocumentBodySave[] = [];
  readonly referenceChecks: Array<{
    documentId: string;
    assetIds: string[];
    threadIds: string[];
  }> = [];
  readonly availableAssets = new Set<string>();
  readonly knownThreads = new Set<string>();
  beforeLoad?: (
    documentId: string,
  ) => Promise<LoadedDocumentBody | undefined | void> | void;
  beforeSave?: (
    save: DocumentBodySave,
  ) => Promise<DocumentBodySaveResult | void> | DocumentBodySaveResult | void;
  beforeCheckReferences?: (input: {
    documentId: string;
    assetIds: string[];
    threadIds: string[];
  }) => Promise<DocumentReferenceCheck | void> | DocumentReferenceCheck | void;

  put(
    state: { stateBytes: Uint8Array; stateVector: Uint8Array },
    options: {
      documentId?: string;
      permissionCount?: number;
      seq?: number;
    } = {},
  ): MemoryBodyRow {
    const references = inspectRoomDocumentState(
      state.stateBytes,
    ).completeReferences;
    const row: MemoryBodyRow = {
      active: true,
      permissionCount: options.permissionCount ?? 0,
      seq: options.seq ?? 0,
      state: state.stateBytes.slice(),
      stateVector: state.stateVector.slice(),
      assetIds: references.documentAssetIds,
      threadIds: references.documentThreadIds,
      editorIds: [],
      operations: [],
    };
    this.rows.set(options.documentId ?? documentId, row);
    return row;
  }

  // The row's current state as a Y.Doc the caller owns.
  document(id = documentId): Y.Doc {
    const document = new Y.Doc({ gc: true });
    Y.applyUpdate(document, this.#row(id).state);
    return document;
  }

  // Saves a change on the row as another writer would and returns the heads
  // and update.
  commitServerChange(change: (document: Y.Doc) => void, id = documentId) {
    const row = this.#row(id);
    const base = bodyHead(id, row);
    const document = this.document(id);
    const vector = Y.encodeStateVector(document);
    change(document);
    const update = Y.encodeStateAsUpdate(document, vector);
    this.put(
      {
        stateBytes: Y.encodeStateAsUpdate(document),
        stateVector: Y.encodeStateVector(document),
      },
      {
        documentId: id,
        permissionCount: row.permissionCount,
        seq: row.seq + 1,
      },
    );
    document.destroy();
    return { base, committed: bodyHead(id, this.#row(id)), update };
  }

  head(id = documentId) {
    return bodyHead(id, this.#row(id));
  }

  async load(id: string): Promise<LoadedDocumentBody | undefined> {
    this.loads.push(id);
    const hooked = await this.beforeLoad?.(id);
    if (hooked !== undefined) return hooked;
    return this.snapshot(id);
  }

  // What a load reads now, without hooks.
  snapshot(id = documentId): LoadedDocumentBody | undefined {
    const row = this.rows.get(id);
    if (row === undefined || !row.active) return undefined;
    return {
      permissionCount: row.permissionCount,
      seq: row.seq,
      state: row.state.slice(),
      stateVector: row.stateVector.slice(),
      assetIds: [...row.assetIds],
      threadIds: [...row.threadIds],
    };
  }

  async save(input: DocumentBodySave): Promise<DocumentBodySaveResult> {
    this.saves.push(input);
    const hooked = await this.beforeSave?.(input);
    if (hooked !== undefined) return hooked;
    const row = this.rows.get(input.documentId);
    if (row === undefined || !row.active) return { kind: "rejected" };
    if (row.seq !== input.baseSeq) {
      // An earlier attempt of this save landed and only its reply was lost.
      return row.seq === input.baseSeq + 1 &&
        Buffer.from(row.state).equals(Buffer.from(input.state))
        ? { kind: "saved", seq: row.seq }
        : { kind: "stale" };
    }
    this.apply(input);
    return { kind: "saved", seq: row.seq };
  }

  // Applies a save to its row as the database does, without hooks.
  apply(input: DocumentBodySave): void {
    const row = this.#row(input.documentId);
    row.seq += 1;
    row.state = input.state.slice();
    row.stateVector = input.stateVector.slice();
    row.assetIds = [...input.assetIds];
    row.threadIds = [...input.threadIds];
    row.editorIds = [
      ...row.editorIds.filter((editor) => !input.editorIds.includes(editor)),
      ...input.editorIds,
    ];
    if (input.operation !== undefined)
      row.operations = [
        ...row.operations.slice(-31),
        { id: input.operation.id, seq: row.seq, title: input.operation.title },
      ];
  }

  async findOperation(id: string, operationId: string) {
    const row = this.rows.get(id);
    const operation = row?.operations.find((entry) => entry.id === operationId);
    if (row === undefined || operation === undefined) return undefined;
    return {
      seq: operation.seq,
      title: operation.title,
      stateHash: createHash("sha256").update(row.state).digest("hex"),
      assetIds: [...row.assetIds],
      threadIds: [...row.threadIds],
    };
  }

  async checkReferences(input: {
    documentId: string;
    assetIds: string[];
    threadIds: string[];
  }): Promise<DocumentReferenceCheck> {
    this.referenceChecks.push(input);
    const hooked = await this.beforeCheckReferences?.(input);
    if (hooked !== undefined) return hooked;
    if (!this.rows.get(input.documentId)?.active) return "document_unavailable";
    if (!input.assetIds.every((id) => this.availableAssets.has(id)))
      return "asset_unavailable";
    if (!input.threadIds.every((id) => this.knownThreads.has(id)))
      return "thread_unknown";
    return "available";
  }

  async close(): Promise<void> {}

  #row(id: string): MemoryBodyRow {
    const row = this.rows.get(id);
    if (row === undefined) throw new Error(`No body for ${id}`);
    return row;
  }
}

function bodyHead(id: string, row: MemoryBodyRow) {
  return {
    document_id: id,
    schema_version: 1,
    persisted_seq: row.seq,
    state_vector: Buffer.from(row.stateVector).toString("base64"),
    state_hash: createHash("sha256").update(row.state).digest("hex"),
    state_hash_version: 1,
  };
}

// A body store holding the initial state of the test Document.
export async function memoryBodies(
  options: { source?: string; permissionCount?: number } = {},
): Promise<{ bodies: MemoryDocumentBodies; initial: InitialState }> {
  const initial = await createInitialState(options.source);
  const bodies = new MemoryDocumentBodies();
  bodies.put(initial, { permissionCount: options.permissionCount });
  return { bodies, initial };
}

export async function startRealtimeServer(
  bodies: DocumentBodyStore,
  options: Pick<
    DocumentRealtimeServerOptions,
    "maxUnsavedBacklogBytes" | "realtimeAdmission" | "failureEvidenceDirectory"
  > = {},
) {
  const realtime = createDocumentRealtimeServer({
    runtimeInstanceId,
    bodies,
    connectionTokenKey,
    ...options,
  });
  await realtime.listen();
  return realtime;
}

/** Signs a connection token the way TeamHub does. */
export function signConnectionToken(input: {
  actorKey: string;
  documentName?: string;
  sessionId?: string;
  mode?: "read" | "write";
  permissionCount?: number;
  expiresInMs?: number;
  key?: string;
}): string {
  const payload = Buffer.from(
    JSON.stringify({
      session_id:
        input.sessionId ??
        `document_session_${input.actorKey.replaceAll(/[^A-Za-z0-9_-]/g, "_")}`,
      document_id: input.documentName ?? documentId,
      actor_id: `actor_${input.actorKey}`,
      mode: input.mode ?? "write",
      expires_at: Date.now() + (input.expiresInMs ?? 60_000),
      permission_count: input.permissionCount ?? 0,
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", input.key ?? connectionTokenKey)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

export async function connectRealtimeClient(input: {
  url: string;
  // The Actor key the signed token names, unless rawToken is given.
  token: string;
  rawToken?: string;
  documentName?: string;
  sessionId?: string;
  mode?: "read" | "write";
  permissionCount?: number;
  expiresInMs?: number;
  document?: Y.Doc;
  onProviderCreated?: (provider: HocuspocusProvider) => void;
  onClose?: (event: { code: number; reason: string }) => void;
  onDisconnect?: () => void;
  onStateless?: (payload: string) => void;
  syncTimeoutMs?: number;
}): Promise<{ document: Y.Doc; provider: HocuspocusProvider }> {
  const document = input.document ?? new Y.Doc({ gc: true });
  let provider: HocuspocusProvider | undefined;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for initial Yjs sync")),
      input.syncTimeoutMs ?? 5_000,
    );
    provider = new HocuspocusProvider({
      document,
      name: input.documentName ?? documentId,
      token:
        input.rawToken ??
        signConnectionToken({
          actorKey: input.token,
          documentName: input.documentName,
          sessionId: input.sessionId,
          mode: input.mode,
          permissionCount: input.permissionCount,
          expiresInMs: input.expiresInMs,
        }),
      url: input.url,
      onClose: ({ event }) => {
        input.onClose?.(event);
      },
      onDisconnect: () => input.onDisconnect?.(),
      onStateless: ({ payload }) => input.onStateless?.(payload),
      onAuthenticationFailed: ({ reason }) => {
        clearTimeout(timeout);
        reject(new Error(`Authentication failed: ${reason}`));
      },
      onSynced: () => {
        clearTimeout(timeout);
        resolve();
      },
    });
    input.onProviderCreated?.(provider);
  });
  return { document, provider: provider! };
}

export function wsUrl(address: AddressInfo): string {
  return `ws://127.0.0.1:${address.port}`;
}

export function appendToFirstText(document: Y.Doc, value: string): void {
  const text = findFirstText(document.getXmlFragment("prosemirror"));
  if (text === undefined) {
    throw new Error("Expected a BlockNote text node in the synced fixture");
  }
  text.insert(text.length, value);
}

export function addCommentMarkToFirstText(
  document: Y.Doc,
  threadId: string,
): void {
  const text = findFirstText(document.getXmlFragment("prosemirror"));
  if (text === undefined) {
    throw new Error("Expected a BlockNote text node in the synced fixture");
  }
  text.format(0, text.length, {
    comment: { orphan: false, threadId },
  });
}

export function insertDocumentAssetBlock(
  document: Y.Doc,
  assetId: string,
): void {
  const group = document.getXmlFragment("prosemirror").toArray()[0];
  if (!(group instanceof Y.XmlElement) || group.nodeName !== "blockGroup") {
    throw new Error("Expected the synced BlockNote block group");
  }
  document.transact(() => {
    const container = new Y.XmlElement("blockContainer");
    group.push([container]);
    container.setAttribute("id", `block_${assetId}`);
    const image = new Y.XmlElement("image");
    container.push([image]);
    image.setAttribute("textAlignment", "left");
    image.setAttribute("backgroundColor", "default");
    image.setAttribute("name", "diagram.png");
    image.setAttribute("url", `document-asset:${assetId}`);
    image.setAttribute("caption", "");
    image.setAttribute("showPreview", "true");
  });
}

function findFirstText(
  parent: Y.XmlFragment | Y.XmlElement,
): Y.XmlText | undefined {
  for (const child of parent.toArray()) {
    if (child instanceof Y.XmlText) {
      return child;
    }
    if (child instanceof Y.XmlElement) {
      const nested = findFirstText(child);
      if (nested !== undefined) {
        return nested;
      }
    }
  }
  return undefined;
}
