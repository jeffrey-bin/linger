import type { TeamHubVoiceLiveTurnMarker } from "@/features/teamhub/teamhub-types";
import type { TeamHubCompositionAttachmentInput } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubMessageDocumentReference,
  TeamHubMessageSkillReference,
} from "@/features/teamhub/teamhub-message-content";
import type { PendingRoomMessage } from "./message-row";

const databaseName = "linger-room-message-outbox-v1";
const databaseVersion = 2;
const intentStore = "message-intents";
const accountIndex = "account-id";
const createdAtIndex = "created-at";
// An unsent intent is dropped after seven days, so its idempotency key never
// outlives TeamHub's replay record and a late retry cannot post it twice.
const intentRetentionMs = 7 * 24 * 60 * 60 * 1000;

export interface RoomMessageOutboxScope {
  accountId: string;
  roomId: string;
  tenantId: string;
}

export type PersistedRoomMessageIntent = PendingRoomMessage & {
  voiceLiveTurn?: TeamHubVoiceLiveTurnMarker;
  attachmentInputs: TeamHubCompositionAttachmentInput[];
  contextDocumentVersionIds: string[];
  documentReferences: TeamHubMessageDocumentReference[];
  idempotencyKey: string;
  scope: RoomMessageOutboxScope;
  skillReferences: TeamHubMessageSkillReference[];
  wireBody: string;
};

export interface RoomMessageOutbox {
  clearAccount(accountId: string): Promise<void>;
  list(scope: RoomMessageOutboxScope): Promise<PersistedRoomMessageIntent[]>;
  put(intent: PersistedRoomMessageIntent): Promise<void>;
  remove(scope: RoomMessageOutboxScope, clientId: string): Promise<void>;
}

type StoredIntent = PersistedRoomMessageIntent & { key: string };

export function createMemoryRoomMessageOutbox(): RoomMessageOutbox {
  const intents = new Map<string, PersistedRoomMessageIntent>();
  return {
    async clearAccount(accountId) {
      for (const [key, intent] of intents) {
        if (intent.scope.accountId === accountId) intents.delete(key);
      }
    },
    async list(scope) {
      const cutoff = expiryCutoff();
      for (const [key, intent] of intents) {
        if (intent.createdAt < cutoff) intents.delete(key);
      }
      return [...intents.values()].flatMap((intent) =>
        sameScope(intent.scope, scope) ? [cloneIntent(intent)] : [],
      );
    },
    async put(intent) {
      intents.set(
        intentKey(intent.scope, intent.clientId),
        cloneIntent(intent),
      );
    },
    async remove(scope, clientId) {
      intents.delete(intentKey(scope, clientId));
    },
  };
}

export function createBrowserRoomMessageOutbox(): RoomMessageOutbox {
  if (typeof indexedDB === "undefined") {
    return createMemoryRoomMessageOutbox();
  }
  const transaction = createOutboxTransactionFactory();
  return {
    async clearAccount(accountId) {
      await deleteIntents(
        transaction,
        accountIndex,
        IDBKeyRange.only(accountId),
      );
    },
    async list(scope) {
      await deleteIntents(
        transaction,
        createdAtIndex,
        IDBKeyRange.upperBound(expiryCutoff(), true),
      );
      const records = await runRequest<StoredIntent[]>(
        transaction("readonly"),
        (store) => store.getAll(),
      );
      return records.flatMap((record) => {
        if (!sameScope(record.scope, scope)) return [];
        const intent = { ...record };
        delete (intent as Partial<StoredIntent>).key;
        return [intent];
      });
    },
    async put(intent) {
      await runRequest(transaction("readwrite"), (store) =>
        store.put({
          ...intent,
          key: intentKey(intent.scope, intent.clientId),
        } satisfies StoredIntent),
      );
    },
    async remove(scope, clientId) {
      await runRequest(transaction("readwrite"), (store) =>
        store.delete(intentKey(scope, clientId)),
      );
    },
  };
}

export const browserRoomMessageOutbox = createBrowserRoomMessageOutbox();

type OutboxTransactionFactory = (
  mode: IDBTransactionMode,
) => Promise<IDBTransaction>;

function createOutboxTransactionFactory(): OutboxTransactionFactory {
  let database: Promise<IDBDatabase> | undefined;
  function getDatabase() {
    if (!database) {
      const invalidate = () => {
        if (database === pending) database = undefined;
      };
      const pending = openDatabase(invalidate).catch((error: unknown) => {
        invalidate();
        throw error;
      });
      database = pending;
    }
    return database;
  }
  return async (mode) => {
    for (let attempt = 0; ; attempt += 1) {
      const pending = getDatabase();
      const connection = await pending;
      try {
        return connection.transaction(intentStore, mode);
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("name" in error) ||
          error.name !== "InvalidStateError"
        )
          throw error;
        if (database === pending) database = undefined;
        connection.close();
        if (attempt >= 1) throw error;
      }
    }
  };
}

function openDatabase(invalidate: () => void) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);
    request.onupgradeneeded = () => {
      const database = request.result;
      // Version 1 intents have no creation time and could never expire.
      if (database.objectStoreNames.contains(intentStore)) {
        database.deleteObjectStore(intentStore);
      }
      const store = database.createObjectStore(intentStore, {
        keyPath: "key",
      });
      store.createIndex(accountIndex, "scope.accountId", { unique: false });
      store.createIndex(createdAtIndex, "createdAt", { unique: false });
    };
    request.onsuccess = () => {
      const connection = request.result;
      connection.onclose = invalidate;
      connection.onversionchange = () => {
        invalidate();
        connection.close();
      };
      resolve(connection);
    };
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function deleteIntents(
  createTransaction: OutboxTransactionFactory,
  index: string,
  range: IDBKeyRange,
) {
  return createTransaction("readwrite").then(
    (transaction) =>
      new Promise<void>((resolve, reject) => {
        const store = transaction.objectStore(intentStore);
        const request = store.index(index).openKeyCursor(range);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          store.delete(cursor.primaryKey);
          cursor.continue();
        };
        request.onerror = () =>
          reject(
            request.error ??
              transaction.error ??
              new Error("IndexedDB request failed"),
          );
        transaction.onabort = () =>
          reject(
            transaction.error ?? new Error("IndexedDB transaction aborted"),
          );
        transaction.oncomplete = () => resolve();
      }),
  );
}

function runRequest<T = IDBValidKey>(
  pendingTransaction: Promise<IDBTransaction>,
  createRequest: (store: IDBObjectStore) => IDBRequest<T>,
) {
  return pendingTransaction.then(
    (transaction) =>
      new Promise<T>((resolve, reject) => {
        const request = createRequest(transaction.objectStore(intentStore));
        let result: T;
        request.onsuccess = () => {
          result = request.result;
        };
        request.onerror = () =>
          reject(
            request.error ??
              transaction.error ??
              new Error("IndexedDB request failed"),
          );
        transaction.onabort = () =>
          reject(
            transaction.error ?? new Error("IndexedDB transaction aborted"),
          );
        transaction.oncomplete = () => resolve(result);
      }),
  );
}

function cloneIntent(intent: PersistedRoomMessageIntent) {
  return {
    ...structuredClone({ ...intent, attachmentInputs: [] }),
    attachmentInputs: intent.attachmentInputs.map(({ clientId, file }) => ({
      clientId,
      file: new File([file], file.name, {
        lastModified: file.lastModified,
        type: file.type,
      }),
    })),
  } satisfies PersistedRoomMessageIntent;
}

function expiryCutoff() {
  return Date.now() - intentRetentionMs;
}

function sameScope(
  first: RoomMessageOutboxScope,
  second: RoomMessageOutboxScope,
) {
  return (
    first.accountId === second.accountId &&
    first.tenantId === second.tenantId &&
    first.roomId === second.roomId
  );
}

function intentKey(scope: RoomMessageOutboxScope, clientId: string) {
  return [scope.accountId, scope.tenantId, scope.roomId, clientId]
    .map(encodeURIComponent)
    .join(":");
}
