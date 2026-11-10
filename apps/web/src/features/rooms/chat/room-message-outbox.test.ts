import {
  forceCloseDatabase,
  IDBFactory,
  IDBKeyRange,
  IDBVersionChangeEvent,
} from "fake-indexeddb";
import { File as NodeFile } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createBrowserRoomMessageOutbox,
  createMemoryRoomMessageOutbox,
  type PersistedRoomMessageIntent,
} from "./room-message-outbox";

describe("Browser Room Message Outbox recovery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function setup() {
    const factory = new IDBFactory();
    vi.stubGlobal("indexedDB", factory);
    vi.stubGlobal("File", NodeFile);
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    const connections: IDBDatabase[] = [];
    const open = factory.open.bind(factory);
    const openSpy = vi.spyOn(factory, "open").mockImplementation((...args) => {
      const request = open(...args);
      request.addEventListener("success", () =>
        connections.push(request.result),
      );
      return request;
    });
    return { outbox: createBrowserRoomMessageOutbox(), connections, openSpy };
  }

  it.each(["close", "forced", "versionchange"])(
    "restores the same intent after %s without reloading",
    async (reason) => {
      const { outbox, connections, openSpy } = setup();
      const intent = {
        ...failedIntent(),
        voiceLiveTurn: { voice_session_id: "voice-1", turn_id: "lt-1" },
      };
      await outbox.put(intent);
      const connection = connections[0]!;
      if (reason === "forced")
        Reflect.apply(forceCloseDatabase, undefined, [connection]);
      else if (reason === "versionchange")
        connection.dispatchEvent(
          new IDBVersionChangeEvent("versionchange", {
            oldVersion: 3,
            newVersion: 4,
          }),
        );
      else connection.close();

      const [restored] = await outbox.list(intent.scope);
      expect(restored).toMatchObject({
        clientId: intent.clientId,
        idempotencyKey: intent.idempotencyKey,
        body: intent.body,
        voiceLiveTurn: intent.voiceLiveTurn,
      });
      expect(await restored!.attachmentInputs[0]!.file.text()).toBe("report");
      expect(openSpy).toHaveBeenCalledTimes(2);
      await outbox.remove(intent.scope, intent.clientId);
      expect(await outbox.list(intent.scope)).toEqual([]);
    },
  );

  it("shares reconnection across concurrent operations and preserves account isolation", async () => {
    const { outbox, connections, openSpy } = setup();
    const intent = failedIntent();
    await outbox.put(intent);
    connections[0]!.close();
    await Promise.all([
      outbox.list(intent.scope),
      outbox.put({
        ...intent,
        clientId: "other",
        scope: { ...intent.scope, accountId: "other" },
      }),
      outbox.clearAccount(intent.scope.accountId),
    ]);
    expect(openSpy).toHaveBeenCalledTimes(2);
    expect(await outbox.list(intent.scope)).toEqual([]);
    expect(
      await outbox.list({ ...intent.scope, accountId: "other" }),
    ).toHaveLength(1);
  });

  it("allows another operation to reopen after an open failure", async () => {
    const { outbox, openSpy } = setup();
    openSpy.mockImplementationOnce(() => {
      throw new DOMException("unavailable", "UnknownError");
    });
    await expect(outbox.list(failedIntent().scope)).rejects.toMatchObject({
      name: "UnknownError",
    });
    await expect(outbox.list(failedIntent().scope)).resolves.toEqual([]);
    expect(openSpy).toHaveBeenCalledTimes(2);
  });

  it("bounds retry when each opened connection closes before transaction creation", async () => {
    const { outbox, openSpy } = setup();
    const open = openSpy.getMockImplementation()!;
    openSpy.mockImplementation((...args) => {
      const request = open(...args);
      request.addEventListener("success", () => request.result.close());
      return request;
    });
    await expect(outbox.list(failedIntent().scope)).rejects.toMatchObject({
      name: "InvalidStateError",
    });
    expect(openSpy).toHaveBeenCalledTimes(2);
  });

  it("does not replay a transaction that has already started and aborted", async () => {
    const { outbox, connections, openSpy } = setup();
    const intent = failedIntent();
    await outbox.put(intent);
    const connection = connections[0]!;
    const transaction = connection.transaction.bind(connection);
    const transactionSpy = vi
      .spyOn(connection, "transaction")
      .mockImplementation((...args) => {
        const started = transaction(...args);
        queueMicrotask(() => started.abort());
        return started;
      });
    await expect(
      outbox.put({ ...intent, body: "changed" }),
    ).rejects.toBeDefined();
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledTimes(1);
    transactionSpy.mockRestore();
    expect((await outbox.list(intent.scope))[0]!.body).toBe(intent.body);
  });

  it("reopens for a write and keeps the original idempotency key", async () => {
    const { outbox, connections } = setup();
    const intent = failedIntent();
    await outbox.put(intent);
    connections[0]!.close();
    await outbox.put({ ...intent, status: "sending" });
    expect(await outbox.list(intent.scope)).toMatchObject([
      {
        clientId: intent.clientId,
        idempotencyKey: intent.idempotencyKey,
        status: "sending",
      },
    ]);
    const transactionSpy = vi.spyOn(connections[1]!, "transaction");
    await outbox.list(intent.scope);
    expect(transactionSpy).toHaveBeenCalledWith("message-intents", "readonly");
  });

  it("does not retry storage errors unrelated to a closed connection", async () => {
    const { outbox, connections, openSpy } = setup();
    await outbox.list(failedIntent().scope);
    vi.spyOn(connections[0]!, "transaction").mockImplementation(() => {
      throw new DOMException("storage full", "QuotaExceededError");
    });
    await expect(outbox.put(failedIntent())).rejects.toMatchObject({
      name: "QuotaExceededError",
    });
    expect(openSpy).toHaveBeenCalledTimes(1);
  });

  it("unblocks a real version upgrade but does not downgrade or clear the database", async () => {
    const { outbox, openSpy } = setup();
    const intent = failedIntent();
    await outbox.put(intent);
    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("linger-room-message-outbox-v1", 3);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error("IndexedDB request failed"));
      request.onblocked = () =>
        reject(new Error("old connection blocked upgrade"));
    });
    try {
      await expect(outbox.list(intent.scope)).rejects.toMatchObject({
        name: "VersionError",
      });
      expect(openSpy).toHaveBeenCalledTimes(3);
      const records = await new Promise<unknown[]>((resolve, reject) => {
        const request = upgraded
          .transaction("message-intents")
          .objectStore("message-intents")
          .getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () =>
          reject(request.error ?? new Error("IndexedDB request failed"));
      });
      expect(records).toMatchObject([
        { idempotencyKey: intent.idempotencyKey },
      ]);
    } finally {
      upgraded.close();
    }
  });

  it("deletes intents older than seven days from every scope", async () => {
    const { outbox, connections } = setup();
    const fresh = failedIntent();
    const stale = {
      ...failedIntent(),
      clientId: "local-old",
      createdAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
      idempotencyKey: "intent-old",
    };
    await outbox.put(fresh);
    await outbox.put(stale);
    await outbox.put({
      ...stale,
      clientId: "local-old-other-room",
      scope: { ...stale.scope, roomId: "room-other" },
    });

    expect(await outbox.list(fresh.scope)).toMatchObject([
      { clientId: fresh.clientId },
    ]);
    const records = await new Promise<unknown[]>((resolve, reject) => {
      const request = connections[0]!
        .transaction("message-intents")
        .objectStore("message-intents")
        .getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error("IndexedDB request failed"));
    });
    expect(records).toMatchObject([{ clientId: fresh.clientId }]);
  });

  it("drops version 1 intents, which carry no creation time", async () => {
    const factory = new IDBFactory();
    await new Promise<void>((resolve, reject) => {
      const request = factory.open("linger-room-message-outbox-v1", 1);
      request.onupgradeneeded = () => {
        request.result
          .createObjectStore("message-intents", { keyPath: "key" })
          .put({ ...failedIntent(), createdAt: undefined, key: "old" });
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () =>
        reject(request.error ?? new Error("IndexedDB request failed"));
    });
    vi.stubGlobal("indexedDB", factory);
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);

    await expect(
      createBrowserRoomMessageOutbox().list(failedIntent().scope),
    ).resolves.toEqual([]);
  });
});

describe("Room Message Outbox", () => {
  it("restores one failed intent only inside its Account, Tenant, and Room scope", async () => {
    const outbox = createMemoryRoomMessageOutbox();
    const intent = failedIntent();

    await outbox.put(intent);

    await expect(outbox.list(intent.scope)).resolves.toEqual([intent]);
    await expect(
      outbox.list({ ...intent.scope, accountId: "account-other" }),
    ).resolves.toEqual([]);
    await expect(
      outbox.list({ ...intent.scope, roomId: "room-other" }),
    ).resolves.toEqual([]);
  });

  it("preserves attachment bytes and removes an intent after commit", async () => {
    const outbox = createMemoryRoomMessageOutbox();
    const intent = failedIntent();

    await outbox.put(intent);
    const [restored] = await outbox.list(intent.scope);

    expect(await restored?.attachmentInputs[0]?.file.text()).toBe("report");
    await outbox.remove(intent.scope, intent.clientId);
    await expect(outbox.list(intent.scope)).resolves.toEqual([]);
  });

  it("drops an intent seven days after its first send", async () => {
    const outbox = createMemoryRoomMessageOutbox();
    const intent = failedIntent();
    await outbox.put({
      ...intent,
      createdAt: Date.now() - 7 * 24 * 60 * 60 * 1000 - 1,
    });

    await expect(outbox.list(intent.scope)).resolves.toEqual([]);
  });

  it("clears only the current Account's local intents on explicit logout", async () => {
    const outbox = createMemoryRoomMessageOutbox();
    const first = failedIntent();
    await outbox.put(first);
    await outbox.put({
      ...first,
      clientId: "local-2",
      scope: { ...first.scope, roomId: "room-2" },
    });
    const otherAccount = {
      ...first,
      clientId: "local-3",
      scope: { ...first.scope, accountId: "account-2" },
    };
    await outbox.put(otherAccount);

    await outbox.clearAccount(first.scope.accountId);

    await expect(outbox.list(first.scope)).resolves.toEqual([]);
    await expect(
      outbox.list({ ...first.scope, roomId: "room-2" }),
    ).resolves.toEqual([]);
    await expect(outbox.list(otherAccount.scope)).resolves.toEqual([
      otherAccount,
    ]);
  });
});

function failedIntent(): PersistedRoomMessageIntent {
  const file = new File(["report"], "report.txt", { type: "text/plain" });
  return {
    attachmentInputs: [{ clientId: "attachment-1", file }],
    attachments: [
      {
        clientId: "attachment-1",
        file,
        filename: "report.txt",
        progress: 0,
        sizeBytes: file.size,
        status: "failed",
      },
    ],
    body: "Retry this",
    clientId: "local-1",
    contextDocumentVersionIds: [],
    contextMessages: [],
    createdAt: Date.now(),
    documentReferences: [],
    error: "Network unavailable.",
    idempotencyKey: "intent-1",
    mentions: [],
    scope: {
      accountId: "account-1",
      roomId: "room-1",
      tenantId: "tenant-1",
    },
    skillReferences: [],
    status: "unknown",
    wireBody: "Retry this",
  };
}
