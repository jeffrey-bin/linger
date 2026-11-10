// @vitest-environment jsdom
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";

import { openRoomDocumentSession } from "./room-document-collaboration";
import {
  deleteRoomDocumentLocalCopies,
  hasUnsavedRoomDocumentChanges,
  roomDocumentLocalCopyName,
} from "./room-document-local-copies";

vi.mock("@hocuspocus/provider", () => ({
  HocuspocusProvider: class {
    awareness = {};
    attach() {}
    destroy() {}
  },
  HocuspocusProviderWebsocket: class {
    status = "disconnected";
    destroy() {}
    disconnect() {}
  },
}));

describe("Room Document local copies", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps an editor's unsaved edits and nothing for a reader", async () => {
    const editor = await openSession({ actorId: "actor-a" });
    editor.document.getText("draft").insert(0, "unsaved");
    expect(hasUnsavedRoomDocumentChanges()).toBe(true);
    await editor.destroy();
    expect(hasUnsavedRoomDocumentChanges()).toBe(false);

    const reopened = await openSession({ actorId: "actor-a" });
    expect(reopened.document.getText("draft").toJSON()).toBe("unsaved");
    await reopened.destroy();
    const reader = await openSession({ actorId: "actor-b", readOnly: true });
    reader.document.getText("draft").insert(0, "not kept");
    expect(hasUnsavedRoomDocumentChanges()).toBe(false);
    await reader.destroy();

    expect(await copyNames()).toEqual([copyName("actor-a", "document-1")]);
  });

  it("deletes one Document's copies and keeps other Documents and actors", async () => {
    await createCopy("actor-a", "document-1");
    await createCopy("actor-a", "document-2");
    await createCopy("actor-b", "document-1");
    await createDatabase("room-message-outbox");

    await deleteRoomDocumentLocalCopies({
      actorIds: ["actor-a"],
      documentId: "document-1",
    });

    expect(await copyNames()).toEqual(
      [
        copyName("actor-a", "document-2"),
        copyName("actor-b", "document-1"),
        "room-message-outbox",
      ].sort(),
    );
  });

  it("closes this tab's sessions before deleting an account's copies and keeps another account's", async () => {
    await createCopy("actor-a2", "document-2");
    await createCopy("actor-b", "document-1");
    const editorClosed = vi.fn();
    const editor = await openSession({
      actorId: "actor-a1",
      onLocalCopiesDeleted: editorClosed,
    });
    editor.document.getText("draft").insert(0, "unsaved");
    const readerClosed = vi.fn();
    await openSession({
      actorId: "actor-a2",
      documentId: "document-2",
      onLocalCopiesDeleted: readerClosed,
      readOnly: true,
    });

    await deleteRoomDocumentLocalCopies({ actorIds: ["actor-a1", "actor-a2"] });

    expect(editorClosed).toHaveBeenCalledOnce();
    expect(readerClosed).toHaveBeenCalledOnce();
    expect(hasUnsavedRoomDocumentChanges()).toBe(false);
    expect(await copyNames()).toEqual([copyName("actor-b", "document-1")]);
  });

  it("closes an editor when another tab deletes its copy, without blocking the deletion", async () => {
    const closed = vi.fn();
    const editor = await openSession({
      actorId: "actor-a",
      onLocalCopiesDeleted: closed,
    });
    editor.document.getText("draft").insert(0, "older epoch");

    // Another tab deletes the copy directly, outside this tab's registry.
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(
        copyName("actor-a", "document-1"),
      );
      request.onblocked = () => reject(new Error("deletion blocked"));
      request.onerror = () =>
        reject(request.error ?? new Error("deletion failed"));
      request.onsuccess = () => resolve();
    });

    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
    expect(hasUnsavedRoomDocumentChanges()).toBe(false);
    expect(await copyNames()).toEqual([]);
    await editor.destroy();
    expect(closed).toHaveBeenCalledOnce();
  });
});

function openSession(input: {
  actorId: string;
  documentId?: string;
  onLocalCopiesDeleted?: () => void;
  readOnly?: boolean;
}) {
  return openRoomDocumentSession({
    actorId: input.actorId,
    collaborationCredential: "credential",
    documentId: input.documentId ?? "document-1",
    onLocalCopiesDeleted: input.onLocalCopiesDeleted,
    readOnly: input.readOnly ?? false,
    runtimeUrl: "wss://runtime.test",
    schemaVersion: 1,
    stateHashVersion: 1,
    user: { actorId: input.actorId, color: "#000000", name: "Human" },
  });
}

function copyName(actorId: string, documentId: string) {
  return roomDocumentLocalCopyName({
    actorId,
    documentId,
    schemaVersion: 1,
    stateHashVersion: 1,
  });
}

async function createCopy(actorId: string, documentId: string) {
  const persistence = new IndexeddbPersistence(
    copyName(actorId, documentId),
    new Y.Doc(),
  );
  await persistence.whenSynced;
  await persistence.destroy();
}

function createDatabase(name: string) {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onerror = () => reject(request.error ?? new Error("open failed"));
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
  });
}

async function copyNames() {
  const databases = await indexedDB.databases();
  return databases.map(({ name }) => name).sort();
}
