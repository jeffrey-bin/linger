// An editor keeps its unsaved Document edits in one IndexedDB database per
// actor and Document; a reopened session saves them under its new connection
// token. A copy is deleted when access to the Document is lost and at logout. Sessions open on a Document close before its copies are deleted: in
// this tab through the registry below, in other tabs when the deletion reaches
// their database. This module stays free of editor dependencies, so logout can
// use it.

interface OpenDocumentSession {
  actorId: string;
  /** Closes the session; its owner reopens it from TeamHub. */
  close(): Promise<void>;
  documentId: string;
  hasUnsavedChanges(): boolean;
}

const openSessions = new Set<OpenDocumentSession>();

export function roomDocumentLocalCopyName(input: {
  actorId: string;
  documentId: string;
  schemaVersion: number;
  stateHashVersion: number;
}): string {
  return [
    "room-document",
    encodeURIComponent(input.actorId),
    encodeURIComponent(input.documentId),
    `schema-${input.schemaVersion}`,
    `hash-${input.stateHashVersion}`,
  ].join(":");
}

/** Registers an open session; the returned function unregisters it. */
export function registerOpenDocumentSession(
  session: OpenDocumentSession,
): () => void {
  openSessions.add(session);
  return () => openSessions.delete(session);
}

/** Whether a session in this tab has edits the Document Runtime has not saved. */
export function hasUnsavedRoomDocumentChanges(): boolean {
  return [...openSessions].some((session) => session.hasUnsavedChanges());
}

/** Deletes the actors' Document copies: every copy, or one Document's. */
export async function deleteRoomDocumentLocalCopies(input: {
  actorIds: readonly string[];
  documentId?: string;
}): Promise<void> {
  const selected = (copy: { actorId: string; documentId: string }) =>
    input.actorIds.includes(copy.actorId) &&
    (input.documentId === undefined || copy.documentId === input.documentId);
  await Promise.all(
    [...openSessions].filter(selected).map((session) => session.close()),
  );
  if (typeof indexedDB === "undefined") return;
  const databases = await indexedDB.databases();
  await Promise.all(
    databases.flatMap(({ name }) => {
      const copy = name === undefined ? undefined : parseLocalCopyName(name);
      return copy !== undefined && selected(copy)
        ? [deleteDatabase(name!)]
        : [];
    }),
  );
}

function parseLocalCopyName(name: string) {
  const [prefix, actor, document] = name.split(":");
  if (
    prefix !== "room-document" ||
    actor === undefined ||
    document === undefined
  )
    return undefined;
  try {
    return {
      actorId: decodeURIComponent(actor),
      documentId: decodeURIComponent(document),
    };
  } catch {
    return undefined;
  }
}

// Sessions in other tabs close their copy on versionchange, so a deletion
// completes instead of waiting on them.
function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB deletion failed"));
  });
}
