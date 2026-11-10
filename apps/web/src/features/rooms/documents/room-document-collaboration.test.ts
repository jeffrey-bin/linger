// @vitest-environment jsdom
import type {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from "@hocuspocus/provider";
import {
  fingerprintRoomDocumentState,
  fingerprintRoomDocumentDeletes,
} from "@linger/document-model";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { openRoomDocumentSession } from "./room-document-collaboration";

const fakes = vi.hoisted(() => ({
  persistenceDestroy: vi.fn(async () => undefined),
  persistenceInputs: [] as Array<{ document: Y.Doc; name: string }>,
  providerConfigurations: [] as Array<Record<string, unknown>>,
  providerDestroy: vi.fn(),
  providerAttach: vi.fn(),
  realProviders: [] as HocuspocusProvider[],
  realWebsockets: [] as HocuspocusProviderWebsocket[],
  rejectPersistence: undefined as ((error: Error) => void) | undefined,
  resolvePersistence: undefined as (() => void) | undefined,
  websocketConfigurations: [] as Array<Record<string, unknown>>,
  websocketDestroy: vi.fn(),
  websocketDisconnect: vi.fn(),
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- the cast widens the hoisted value type
  webSocketPolyfill: undefined as unknown,
}));

vi.mock("y-indexeddb", () => ({
  IndexeddbPersistence: class IndexeddbPersistenceFake {
    destroy = fakes.persistenceDestroy;
    whenSynced = new Promise<void>((resolve, reject) => {
      fakes.rejectPersistence = reject;
      fakes.resolvePersistence = resolve;
    });

    constructor(name: string, document: Y.Doc) {
      fakes.persistenceInputs.push({ document, name });
    }
  },
}));

vi.mock("@hocuspocus/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hocuspocus/provider")>();
  return {
    HocuspocusProvider: class HocuspocusProviderFake {
      awareness = { clientID: 1 };
      attach = fakes.providerAttach;
      destroy = fakes.providerDestroy;

      constructor(configuration: Record<string, unknown>) {
        fakes.providerConfigurations.push(configuration);
        if (fakes.webSocketPolyfill !== undefined) {
          const provider = new actual.HocuspocusProvider(
            configuration as unknown as ConstructorParameters<
              typeof actual.HocuspocusProvider
            >[0],
          );
          fakes.realProviders.push(provider);
          return provider as unknown as HocuspocusProviderFake;
        }
      }
    },
    HocuspocusProviderWebsocket: class HocuspocusProviderWebsocketFake {
      status = "connected";
      destroy = fakes.websocketDestroy;
      disconnect = fakes.websocketDisconnect;

      constructor(configuration: Record<string, unknown>) {
        fakes.websocketConfigurations.push(configuration);
        if (fakes.webSocketPolyfill !== undefined) {
          const websocket = new actual.HocuspocusProviderWebsocket({
            ...(configuration as { url: string }),
            WebSocketPolyfill: fakes.webSocketPolyfill,
            delay: 1,
            initialDelay: 0,
            maxDelay: 1,
            minDelay: 1,
          });
          fakes.realWebsockets.push(websocket);
          return websocket as unknown as HocuspocusProviderWebsocketFake;
        }
      }
    },
  };
});

class BlackHoleWebSocket {
  static instances: BlackHoleWebSocket[] = [];
  binaryType = "arraybuffer";
  readyState = 0;
  #listeners = new Map<string, Set<(payload: unknown) => void>>();

  constructor(readonly url: string) {
    BlackHoleWebSocket.instances.push(this);
  }

  addEventListener(name: string, listener: (payload: unknown) => void) {
    const listeners = this.#listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(name, listeners);
  }

  removeEventListener(name: string, listener: (payload: unknown) => void) {
    this.#listeners.get(name)?.delete(listener);
  }

  send() {}

  // An unreachable peer never delivers the close event.
  close() {}

  open() {
    this.readyState = 1;
    this.#listeners.get("open")?.forEach((listener) => listener({}));
  }
}

describe("Room Document collaboration", () => {
  beforeEach(() => {
    fakes.persistenceDestroy.mockClear();
    fakes.persistenceInputs.length = 0;
    fakes.providerConfigurations.length = 0;
    fakes.providerAttach.mockClear();
    fakes.providerDestroy.mockClear();
    fakes.realProviders.length = 0;
    fakes.realWebsockets.length = 0;
    fakes.resolvePersistence = undefined;
    fakes.webSocketPolyfill = undefined;
    BlackHoleWebSocket.instances.length = 0;
    fakes.websocketConfigurations.length = 0;
    fakes.websocketDestroy.mockClear();
    fakes.websocketDisconnect.mockClear();
  });

  it.each([false, true])(
    "ends authentication failure without reconnecting or losing local state (readOnly=%s)",
    async (readOnly) => {
      const input = {
        actorId: "actor/one",
        collaborationCredential: "credential-one",
        documentId: "document/one",
        runtimeUrl: "wss://documents.example.test/collaboration",
        schemaVersion: 1,
        stateHashVersion: 1,
        user: { actorId: "actor/one", color: "#0f766e", name: "Human One" },
      };
      const opening = openRoomDocumentSession({ ...input, readOnly });
      fakes.resolvePersistence?.();
      const session = await opening;
      session.document.getText("local-draft").insert(0, "unsaved text");
      const provider = providerCallbacks();
      provider.onAuthenticationFailed({
        reason: "An unexpected error occurred",
      });
      provider.onClose();
      provider.onStatus({ status: "connected" });
      provider.onSynced({ state: true });
      provider.onStateless({
        payload: JSON.stringify(envelope(session.document)),
      });

      expect(session.getSaveSnapshot()).toMatchObject({
        canEdit: false,
        status: "Connection failed",
      });
      expect(fakes.websocketDisconnect).toHaveBeenCalledOnce();
      expect(session.document.getText("local-draft").toJSON()).toBe(
        "unsaved text",
      );
      expect(fakes.persistenceDestroy).not.toHaveBeenCalled();
      await session.destroy();
    },
  );

  it("preconnects transport while hydrating, but attaches the document only after hydration", async () => {
    const refreshCredential = vi.fn(async () => "credential-two");
    const opening = openRoomDocumentSession({
      readOnly: false,
      actorId: "actor/one",
      collaborationCredential: "credential-one",
      documentId: "document/one",
      runtimeUrl: "wss://documents.example.test/collaboration",
      refreshCredential: refreshCredential,
      schemaVersion: 1,
      stateHashVersion: 1,
      user: {
        actorId: "actor/one",
        color: "#0f766e",
        name: "Human One",
      },
    });

    expect(fakes.persistenceInputs).toMatchObject([
      {
        name: "room-document:actor%2Fone:document%2Fone:schema-1:hash-1",
      },
    ]);
    expect(fakes.websocketConfigurations).toHaveLength(1);
    expect(fakes.providerConfigurations).toHaveLength(0);
    expect(fakes.providerAttach).not.toHaveBeenCalled();
    fakes.resolvePersistence?.();
    const session = await opening;

    expect(fakes.providerConfigurations).toHaveLength(1);
    expect(fakes.providerAttach).toHaveBeenCalledOnce();
    expect(fakes.providerConfigurations[0]).toMatchObject({
      document: session.document,
      name: "document/one",
    });
    expect(fakes.websocketConfigurations).toEqual([
      {
        maxDelay: 5_000,
        url: "wss://documents.example.test/collaboration",
      },
    ]);
    const token = fakes.providerConfigurations[0]?.token;
    expect(token).toBeTypeOf("function");
    await expect((token as () => Promise<string>)()).resolves.toBe(
      "credential-one",
    );
    await expect((token as () => Promise<string>)()).resolves.toBe(
      "credential-two",
    );
    expect(refreshCredential).toHaveBeenCalledOnce();
    expect(session.awareness).toEqual({ clientID: 1 });
    expect(session.user).toEqual({
      actorId: "actor/one",
      color: "#0f766e",
      name: "Human One",
    });

    const provider = providerCallbacks();
    provider.onSynced({ state: true });
    provider.onUnsyncedChanges({ number: 0 });
    provider.onStateless({
      payload: JSON.stringify(envelope(session.document)),
    });
    expect(session.getSaveSnapshot().status).toBe("Saved");

    window.dispatchEvent(new Event("offline"));
    expect(session.getSaveSnapshot().status).toBe("Offline");
    provider.onStatus({ status: "connected" });
    expect(session.getSaveSnapshot().status).toBe("Connecting");
    provider.onSynced({ state: true });
    expect(session.getSaveSnapshot().status).toBe("Saved");
    provider.onClose();
    expect(session.getSaveSnapshot().status).toBe("Offline");
    provider.onStatus({ status: "connected" });
    expect(session.getSaveSnapshot().status).toBe("Connecting");
    provider.onSynced({ state: true });
    expect(session.getSaveSnapshot().status).toBe("Saved");

    session.document.getText("content").insert(0, "local");
    expect(session.getSaveSnapshot().status).toBe("Local pending");
    provider.onUnsyncedChanges({ number: 0 });
    expect(session.getSaveSnapshot().status).toBe("Local pending");
    provider.onStatus({ status: "disconnected" });
    expect(session.getSaveSnapshot().status).toBe("Offline pending");
    provider.onStatus({ status: "connected" });
    provider.onStateless({
      payload: JSON.stringify(envelope(session.document, 2)),
    });
    expect(session.getSaveSnapshot().status).toBe("Local pending");
    provider.onSynced({ state: true });
    expect(session.getSaveSnapshot().status).toBe("Saved");

    provider.onStateless({
      payload: JSON.stringify({
        code: "append_rejected",
        document_id: "document/one",
        type: "durability_failure",
      }),
    });
    expect(session.getSaveSnapshot()).toMatchObject({
      protocolError: "durable_save_failed",
      status: "Synced",
    });

    await session.destroy();
    expect(fakes.providerDestroy).toHaveBeenCalledOnce();
    expect(fakes.websocketDestroy).toHaveBeenCalledOnce();
    expect(fakes.persistenceDestroy).toHaveBeenCalledOnce();
  });

  it("repairs restored external media before attaching the sync provider", async () => {
    const opening = openRoomDocumentSession({
      readOnly: false,
      actorId: "actor-one",
      collaborationCredential: "credential",
      documentId: "document-one",
      runtimeUrl: "wss://documents.example.test/collaboration",
      schemaVersion: 1,
      stateHashVersion: 1,
      user: { actorId: "actor-one", color: "#000000", name: "One" },
    });
    const document = fakes.persistenceInputs[0]!.document;
    const group = new Y.XmlElement("blockGroup");
    const block = new Y.XmlElement("blockContainer");
    block.setAttribute("id", "pasted-image");
    const image = new Y.XmlElement("image");
    image.setAttribute("url", "https://example.test/image.png");
    block.insert(0, [image]);
    group.insert(0, [block]);
    document.getXmlFragment("prosemirror").insert(0, [group]);
    fakes.providerAttach.mockImplementationOnce(() => {
      expect(block.get(0)).toBeInstanceOf(Y.XmlElement);
      expect((block.get(0) as Y.XmlElement).nodeName).toBe("paragraph");
      expect(block.toJSON()).toContain("https://example.test/image.png");
    });
    fakes.resolvePersistence?.();
    const session = await opening;
    try {
      expect(fakes.providerAttach).toHaveBeenCalledOnce();
      expect(session.getSaveSnapshot().status).not.toBe("Saved");
    } finally {
      await session.destroy();
    }
  });

  it("closes the preconnected transport when local hydration fails", async () => {
    const opening = openRoomDocumentSession({
      readOnly: false,
      actorId: "actor/one",
      collaborationCredential: "credential",
      documentId: "doc",
      runtimeUrl: "wss://documents.example.test/collaboration",
      schemaVersion: 1,
      stateHashVersion: 1,
      user: { actorId: "actor/one", color: "#0f766e", name: "Human" },
    });
    fakes.rejectPersistence?.(new Error("local storage unavailable"));
    await expect(opening).rejects.toThrow("local storage unavailable");
    expect(fakes.websocketDestroy).toHaveBeenCalledOnce();
    expect(fakes.persistenceDestroy).toHaveBeenCalledOnce();
    expect(fakes.providerAttach).not.toHaveBeenCalled();
  });

  it("opens an incoming-only read session without IndexedDB", async () => {
    const session = await openRoomDocumentSession({
      readOnly: true,
      actorId: "actor/reader",
      collaborationCredential: "read-credential",
      documentId: "document/one",
      runtimeUrl: "wss://documents.example.test/collaboration",
      schemaVersion: 1,
      stateHashVersion: 1,
      user: {
        actorId: "actor/reader",
        color: "#0f766e",
        name: "Reader",
      },
    });

    expect(fakes.persistenceInputs).toHaveLength(0);
    expect(fakes.providerConfigurations).toHaveLength(1);
    expect(fakes.providerAttach).toHaveBeenCalledOnce();
    expect(fakes.websocketConfigurations).toEqual([
      {
        maxDelay: 5_000,
        url: "wss://documents.example.test/collaboration",
      },
    ]);
    expect(session.readOnly).toBe(true);
    const provider = providerCallbacks();
    provider.onStatus({ status: "connected" });
    provider.onSynced({ state: true });
    provider.onStateless({
      payload: JSON.stringify(envelope(session.document)),
    });
    expect(session.getSaveSnapshot()).toMatchObject({
      canEdit: false,
      status: "Saved",
    });

    session.document.getText("selection-mark").insert(0, "local-only");
    expect(session.getSaveSnapshot()).toMatchObject({
      canEdit: false,
      status: "Saved",
    });

    await session.destroy();
    expect(fakes.providerDestroy).toHaveBeenCalledOnce();
    expect(fakes.websocketDestroy).toHaveBeenCalledOnce();
    expect(fakes.persistenceDestroy).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "waits for the reconnected provider to resync before reporting Saved (readOnly=%s)",
    async (readOnly) => {
      const input = {
        actorId: "actor/one",
        collaborationCredential: "credential-one",
        documentId: "document/one",
        runtimeUrl: "wss://documents.example.test/collaboration",
        schemaVersion: 1,
        stateHashVersion: 1,
        user: { actorId: "actor/one", color: "#0f766e", name: "Human One" },
      };
      const opening = openRoomDocumentSession({ ...input, readOnly });
      fakes.resolvePersistence?.();
      const session = await opening;
      const provider = providerCallbacks();
      provider.onStatus({ status: "connected" });
      provider.onSynced({ state: true });
      provider.onStateless({
        payload: JSON.stringify(envelope(session.document)),
      });
      expect(session.getSaveSnapshot().status).toBe("Saved");

      // A Runtime restart closes the socket; the provider then reconnects and
      // replays its status before the new sync handshake has finished.
      provider.onClose();
      expect(session.getSaveSnapshot().status).toBe("Offline");
      provider.onStatus({ status: "connected" });
      provider.onStateless({
        payload: JSON.stringify(envelope(session.document)),
      });
      expect(session.getSaveSnapshot()).toMatchObject({
        canEdit: !readOnly,
        status: "Connecting",
      });
      provider.onSynced({ state: true });
      expect(session.getSaveSnapshot()).toMatchObject({
        canEdit: !readOnly,
        status: "Saved",
      });
      await session.destroy();
    },
  );

  it.each([false, true])(
    "resyncs after a forced close that bypasses the provider close handler (readOnly=%s)",
    async (readOnly) => {
      fakes.webSocketPolyfill = BlackHoleWebSocket;
      const input = {
        actorId: "actor/one",
        collaborationCredential: "credential-one",
        documentId: "document/one",
        runtimeUrl: "wss://documents.example.test/collaboration",
        schemaVersion: 1,
        stateHashVersion: 1,
        user: { actorId: "actor/one", color: "#0f766e", name: "Human One" },
      };
      const opening = openRoomDocumentSession({ ...input, readOnly });
      fakes.resolvePersistence?.();
      const session = await opening;
      try {
        const provider = fakes.realProviders[0]!;
        const websocket = fakes.realWebsockets[0]!;
        await vi.waitFor(() =>
          expect(BlackHoleWebSocket.instances).toHaveLength(1),
        );
        BlackHoleWebSocket.instances[0]!.open();
        await answerSyncStepOne(provider);
        provider.receiveStateless(JSON.stringify(envelope(session.document)));
        expect(session.getSaveSnapshot().status).toBe("Saved");

        // The third stale connection check closes without a socket close event.
        websocket.onClose({
          event: { code: 4408, reason: "forced" },
        });
        expect(session.getSaveSnapshot().status).toBe("Offline");
        await vi.waitFor(() =>
          expect(BlackHoleWebSocket.instances.length).toBeGreaterThan(1),
        );
        BlackHoleWebSocket.instances.at(-1)!.open();
        expect(session.getSaveSnapshot().status).toBe("Connecting");

        await answerSyncStepOne(provider);
        expect(session.getSaveSnapshot()).toMatchObject({
          canEdit: !readOnly,
          status: "Saved",
        });
      } finally {
        await session.destroy();
      }
    },
  );
});

// Plays the Runtime's replies to the SyncStep1 the provider sends on open:
// SyncStep2 sets `synced`, and SyncStatus acknowledges the pending sync.
async function answerSyncStepOne(provider: HocuspocusProvider) {
  await vi.waitFor(() => expect(provider.hasUnsyncedChanges).toBe(true));
  provider.synced = true;
  provider.decrementUnsyncedChanges();
}

function providerCallbacks() {
  const configuration = fakes.providerConfigurations[0];
  if (configuration === undefined) {
    throw new Error("Expected one Hocuspocus provider configuration");
  }
  return configuration as {
    onAuthenticationFailed(input: { reason: string }): void;
    onClose(): void;
    onStateless(input: { payload: string }): void;
    onStatus(input: { status: string }): void;
    onSynced(input: { state: boolean }): void;
    onUnsyncedChanges(input: { number: number }): void;
  };
}

function envelope(document: Y.Doc, persistedSequence = 1) {
  return {
    type: "durability_ack",
    delete_set_hash: fingerprintRoomDocumentDeletes(document),
    head: {
      document_id: "document/one",
      persisted_seq: persistedSequence,
      schema_version: 1,
      state_hash: fingerprintRoomDocumentState(document),
      state_hash_version: 1,
      state_vector: Buffer.from(Y.encodeStateVector(document)).toString(
        "base64",
      ),
    },
  };
}
