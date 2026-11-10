/**
 * Per-tenant memory of the global search dialog: the last queries the person
 * ran. It lives only in this
 * browser's localStorage, so every read and write tolerates a missing or
 * blocked storage.
 */

export interface SearchTargetActor {
  id: string;
  kind: "agent" | "human";
  name: string;
}

/** Enough of a result to render its row and navigate to it. */
export type SearchTarget =
  | {
      kind: "message";
      id: string;
      path: string;
      author: SearchTargetActor;
      roomLabel: string;
      text: string;
      createdAt: string;
    }
  | {
      kind: "document";
      id: string;
      path: string;
      fileName: string;
      location: string;
      ownerName: string;
      formatLabel: string;
      updatedAt: string;
    }
  | {
      kind: "agent";
      id: string;
      /** The Agent's Direct Room chat, once that Room is known; resolved on open otherwise. */
      path?: string;
      name: string;
      description: string;
      agentType: string;
      avatarKey?: string;
    }
  | {
      kind: "room";
      id: string;
      path: string;
      roomKind: "room" | "thread";
      name: string;
      description?: string;
      parentName?: string;
      /** The first members in join order, for the Room's avatar mosaic. */
      members?: SearchTargetActor[];
    };

export type SearchTargetKind = SearchTarget["kind"];

export interface GlobalSearchStore {
  queries: string[];
}

const MAX_QUERIES = 8;

const storagePrefix = "global-search-recent.v2:";

const storageKey = (tenantId: string) => `${storagePrefix}${tenantId}`;

const emptyStore = (): GlobalSearchStore => ({ queries: [] });

export function clearGlobalSearchHistory() {
  try {
    const storage = window.localStorage;
    for (let index = storage.length - 1; index >= 0; index--) {
      const key = storage.key(index);
      if (key?.startsWith(storagePrefix)) storage.removeItem(key);
    }
  } catch {
    // Blocked storage must not prevent Session cleanup.
  }
}

export function readGlobalSearchStore(tenantId: string): GlobalSearchStore {
  try {
    const raw = window.localStorage.getItem(storageKey(tenantId));
    if (!raw) return emptyStore();
    return sanitizeStore(JSON.parse(raw));
  } catch {
    return emptyStore();
  }
}

function writeGlobalSearchStore(tenantId: string, store: GlobalSearchStore) {
  try {
    window.localStorage.setItem(storageKey(tenantId), JSON.stringify(store));
  } catch {
    // A blocked or full storage only loses the convenience lists.
  }
  return store;
}

/** Remember a query the person ran; the newest spelling wins over an earlier casing. */
export function recordGlobalSearchQuery(tenantId: string, query: string) {
  const text = query.trim();
  const store = readGlobalSearchStore(tenantId);
  if (!text) return store;
  const normalized = text.toLocaleLowerCase();
  return writeGlobalSearchStore(tenantId, {
    ...store,
    queries: [
      text,
      ...store.queries.filter(
        (candidate) => candidate.toLocaleLowerCase() !== normalized,
      ),
    ].slice(0, MAX_QUERIES),
  });
}

export function removeGlobalSearchQuery(tenantId: string, query: string) {
  const store = readGlobalSearchStore(tenantId);
  return writeGlobalSearchStore(tenantId, {
    ...store,
    queries: store.queries.filter((candidate) => candidate !== query),
  });
}

export function clearGlobalSearchQueries(tenantId: string) {
  return writeGlobalSearchStore(tenantId, {
    ...readGlobalSearchStore(tenantId),
    queries: [],
  });
}

/** Anything unexpected in the stored value reads as empty. */
function sanitizeStore(value: unknown): GlobalSearchStore {
  if (!value || typeof value !== "object") {
    return emptyStore();
  }
  const candidate = value as Partial<GlobalSearchStore>;
  const queries = Array.isArray(candidate.queries)
    ? candidate.queries
        .filter(
          (query): query is string =>
            typeof query === "string" && query.trim() !== "",
        )
        .slice(0, MAX_QUERIES)
    : [];
  return { queries };
}
