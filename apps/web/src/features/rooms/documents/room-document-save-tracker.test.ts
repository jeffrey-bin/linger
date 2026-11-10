import {
  fingerprintRoomDocumentState,
  fingerprintRoomDocumentDeletes,
} from "@linger/document-model";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { RoomDocumentSaveTracker } from "./room-document-save-tracker";

describe("Room Document save tracker", () => {
  it("requires hydration, exact vector, and a newer ACK after changes", () => {
    const document = new Y.Doc({ gc: true });
    document.getText("content").insert(0, "durable");
    const tracker = createTracker(document);

    expect(tracker.getSnapshot()).toMatchObject({
      canEdit: false,
      status: "Connecting",
    });

    tracker.setConnected(true);
    tracker.acceptDurableAck(envelope(document, 1));
    expect(tracker.getSnapshot()).toMatchObject({
      canEdit: false,
      status: "Connecting",
    });

    tracker.markLocalHydrated();
    tracker.markRemoteHydrated();
    tracker.setUnsyncedChanges(0);
    expect(tracker.getSnapshot()).toMatchObject({
      canEdit: true,
      status: "Saved",
    });

    tracker.setConnected(false);
    expect(tracker.getSnapshot().status).toBe("Offline");
    tracker.setConnected(true);
    expect(tracker.getSnapshot()).toMatchObject({
      canEdit: true,
      status: "Connecting",
    });
    tracker.markRemoteHydrated();
    expect(tracker.getSnapshot().status).toBe("Saved");

    document.getText("content").delete(0, 1);
    expect(tracker.getSnapshot().status).toBe("Local pending");
    tracker.setUnsyncedChanges(0);
    expect(tracker.getSnapshot().status).toBe("Local pending");

    tracker.setConnected(false);
    expect(tracker.getSnapshot().status).toBe("Offline pending");
    tracker.setConnected(true);
    expect(tracker.getSnapshot().status).toBe("Local pending");
    tracker.markRemoteHydrated();
    tracker.acceptDurableAck(envelope(document, 2));
    expect(tracker.getSnapshot()).toMatchObject({
      durableHead: envelope(document, 2).head,
      durableSequence: 2,
      status: "Saved",
    });
  });

  it("uses an authenticated durable ACK instead of comparing replica encodings", () => {
    const document = new Y.Doc({ gc: true });
    document.getText("content").insert(0, "durable");
    const tracker = createTracker(document);

    tracker.markLocalHydrated();
    tracker.markRemoteHydrated();
    tracker.setConnected(true);
    tracker.setUnsyncedChanges(0);
    tracker.acceptDurableAck({
      ...envelope(document, 1),
      head: {
        ...envelope(document, 1).head,
        state_hash: "f".repeat(64),
      },
    });

    expect(tracker.getSnapshot()).toMatchObject({
      durableSequence: 1,
      status: "Saved",
    });
  });

  it("does not require a newer ACK for an empty Yjs transaction", () => {
    const document = new Y.Doc({ gc: true });
    const tracker = createTracker(document);

    tracker.markLocalHydrated();
    tracker.markRemoteHydrated();
    tracker.setConnected(true);
    tracker.setUnsyncedChanges(0);
    tracker.acceptDurableAck(envelope(document, 1));
    expect(tracker.getSnapshot().status).toBe("Saved");

    document.transact(() => undefined);

    expect(tracker.getSnapshot().status).toBe("Saved");
  });

  it("ignores stale ACKs but fails closed on a divergent same-seq ACK", () => {
    const document = new Y.Doc({ gc: true });
    document.getText("content").insert(0, "durable");
    const tracker = createTracker(document);
    tracker.markLocalHydrated();
    tracker.markRemoteHydrated();
    tracker.setConnected(true);
    tracker.setUnsyncedChanges(0);

    expect(tracker.acceptDurableAck(envelope(document, 2))).toBe(true);
    expect(tracker.acceptDurableAck(envelope(document, 1))).toBe(false);
    expect(
      tracker.acceptDurableAck({
        ...envelope(document, 2),
        head: {
          ...envelope(document, 2).head,
          state_hash: "f".repeat(64),
        },
      }),
    ).toBe(false);
    expect(tracker.getSnapshot()).toMatchObject({
      protocolError: "durable_ack_conflict",
      status: "Synced",
    });
  });

  it("reports unsaved local edits even when the status does not show them", () => {
    const document = new Y.Doc({ gc: true });
    const tracker = createTracker(document);
    tracker.markLocalHydrated();
    tracker.markRemoteHydrated();
    tracker.setConnected(true);
    tracker.acceptDurableAck(envelope(document, 1));
    expect(tracker.hasUnsavedLocalChanges()).toBe(false);

    document.getText("content").insert(0, "typed");
    expect(tracker.hasUnsavedLocalChanges()).toBe(true);
    tracker.acceptDurableAck(envelope(document, 2));
    expect(tracker.getSnapshot().status).toBe("Saved");
    expect(tracker.hasUnsavedLocalChanges()).toBe(false);

    document.getText("content").insert(0, "more ");
    tracker.markAuthenticationFailed();
    expect(tracker.getSnapshot().status).toBe("Connection failed");
    expect(tracker.hasUnsavedLocalChanges()).toBe(true);
    tracker.destroy();
  });

  it("fails closed when Runtime reports a permanent durable save failure", () => {
    const document = new Y.Doc({ gc: true });
    document.getText("content").insert(0, "locally recoverable");
    const tracker = createTracker(document);

    expect(
      tracker.acceptDurabilityFailure({
        code: "append_rejected",
        document_id: "document-1",
        type: "durability_failure",
      }),
    ).toBe(true);
    expect(tracker.getSnapshot()).toMatchObject({
      protocolError: "durable_save_failed",
      status: "Synced",
    });
  });
});

function createTracker(document: Y.Doc) {
  return new RoomDocumentSaveTracker({
    document,
    documentId: "document-1",
    schemaVersion: 1,
    stateHashVersion: 1,
  });
}

function envelope(document: Y.Doc, persistedSequence: number) {
  return {
    type: "durability_ack",
    delete_set_hash: fingerprintRoomDocumentDeletes(document),
    head: {
      document_id: "document-1",
      persisted_seq: persistedSequence,
      schema_version: 1,
      state_hash: stateHash(document),
      state_hash_version: 1,
      state_vector: Buffer.from(Y.encodeStateVector(document)).toString(
        "base64",
      ),
    },
  };
}

function stateHash(document: Y.Doc): string {
  return fingerprintRoomDocumentState(document);
}

describe("Room Document offline save recovery", () => {
  it("does not mark a restored offline deletion saved before the server persists it", () => {
    const server = new Y.Doc();
    server.getText("content").insert(0, "keep delete");
    const oldAck = envelope(server, 14);
    const offline = new Y.Doc();
    Y.applyUpdate(offline, Y.encodeStateAsUpdate(server));
    offline.getText("content").delete(5, 6);
    const reopened = new Y.Doc();
    const tracker = createTracker(reopened);
    // y-indexeddb hydrates through a non-local Yjs transaction.
    Y.transact(
      reopened,
      () => Y.applyUpdate(reopened, Y.encodeStateAsUpdate(offline)),
      "indexeddb",
      false,
    );
    tracker.markLocalHydrated();
    tracker.setConnected(true);
    tracker.acceptDurableAck(oldAck);
    tracker.markRemoteHydrated();
    tracker.setUnsyncedChanges(1);
    expect(reopened.getText("content").toJSON()).toBe("keep ");
    expect(server.getText("content").toJSON()).toBe("keep delete");
    expect(tracker.getSnapshot().status).not.toBe("Saved");
    Y.applyUpdate(server, Y.encodeStateAsUpdate(reopened));
    tracker.acceptDurableAck(envelope(server, 15));
    expect(tracker.getSnapshot().status).toBe("Saved");
    tracker.destroy();
    server.destroy();
    offline.destroy();
    reopened.destroy();
  });

  it("allows editing during a normal disconnect after a successful initial sync", () => {
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "content");
    const tracker = createTracker(doc);
    tracker.markLocalHydrated();
    tracker.markRemoteHydrated();
    tracker.setConnected(true);
    tracker.acceptDurableAck(envelope(doc, 1));
    tracker.setConnected(false);
    expect(tracker.getSnapshot().canEdit).toBe(true);
    doc.getText("content").insert(0, "offline ");
    expect(tracker.getSnapshot()).toMatchObject({
      canEdit: true,
      status: "Offline pending",
    });
  });
});

describe("Room Document delete evidence compatibility", () => {
  it("requires delete evidence, accepts enrichment, and rejects conflicting evidence", () => {
    const document = new Y.Doc();
    const tracker = createTracker(document);
    tracker.markLocalHydrated();
    tracker.markRemoteHydrated();
    tracker.setConnected(true);
    const ack = envelope(document, 1);
    const legacyAck = { ...ack, delete_set_hash: undefined };
    expect(tracker.acceptDurableAck(legacyAck)).toBe(true);
    expect(tracker.getSnapshot()).toMatchObject({
      canEdit: true,
      status: "Synced",
    });
    expect(tracker.acceptDurableAck(ack)).toBe(true);
    expect(tracker.getSnapshot().status).toBe("Saved");
    expect(tracker.acceptDurableAck(legacyAck)).toBe(true);
    expect(tracker.getSnapshot().status).toBe("Saved");
    expect(
      tracker.acceptDurableAck({ ...ack, delete_set_hash: "f".repeat(64) }),
    ).toBe(false);
    expect(tracker.getSnapshot().protocolError).toBe("durable_ack_conflict");
    tracker.destroy();
    document.destroy();
  });
});
