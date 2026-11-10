import { readRoomDocumentBlocks } from "@linger/document-model";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import type { DocumentChangeComputation } from "../../src/document/document-changes.js";
import {
  appendToFirstText,
  connectRealtimeClient,
  documentId,
  memoryBodies,
  startRealtimeServer,
  wsUrl,
} from "./realtime-test-support.js";

// Appends text the way a server change does: computed on the given state.
function appendChange(text: string): DocumentChangeComputation {
  return async (stateBytes) => {
    const document = new Y.Doc({ gc: true });
    Y.applyUpdate(document, stateBytes);
    const vector = Y.encodeStateVector(document);
    appendToFirstText(document, text);
    const result = {
      update: Y.encodeStateAsUpdate(document, vector),
      stateBytes: Y.encodeStateAsUpdate(document),
      stateVector: Y.encodeStateVector(document),
      title: "",
      assetIds: [],
      threadIds: [],
    };
    document.destroy();
    return result;
  };
}

function firstText(stateBytes: Uint8Array): unknown {
  return readRoomDocumentBlocks(stateBytes)[0]?.content;
}

describe("Document Runtime server changes", () => {
  it("saves a change to a Document nobody has open", async () => {
    const { bodies } = await memoryBodies();
    const realtime = await startRealtimeServer(bodies);
    try {
      await expect(
        realtime.changes.apply({
          documentId,
          operationId: "operation_1",
          actorId: "actor_agent",
          compute: appendChange(" by agent"),
        }),
      ).resolves.toMatchObject({ status: "applied", seq: 1 });
      expect(firstText(bodies.rows.get(documentId)!.state)).toMatchObject([
        { text: "Durable initial state by agent" },
      ]);
      expect(bodies.rows.get(documentId)!.editorIds).toEqual(["actor_agent"]);
    } finally {
      await realtime.destroy();
    }
  });

  it("broadcasts a saved change to open connections and keeps their unsaved edits", async () => {
    const { bodies } = await memoryBodies();
    const realtime = await startRealtimeServer(bodies);
    const client = await connectRealtimeClient({
      token: "human_a",
      url: wsUrl(realtime.address),
    });
    try {
      appendToFirstText(client.document, " human");
      await expect.poll(() => bodies.rows.get(documentId)!.seq).toBe(1);
      await expect(
        realtime.changes.apply({
          documentId,
          operationId: "operation_2",
          actorId: "actor_agent",
          expectedSeq: 1,
          compute: appendChange(" agent"),
        }),
      ).resolves.toMatchObject({ status: "applied", seq: 2 });
      await expect
        .poll(() => firstText(Y.encodeStateAsUpdate(client.document)))
        .toMatchObject([{ text: "Durable initial state human agent" }]);
      appendToFirstText(client.document, " again");
      await expect
        .poll(() => firstText(bodies.rows.get(documentId)!.state))
        .toMatchObject([{ text: "Durable initial state human agent again" }]);
      expect(bodies.rows.get(documentId)!.seq).toBe(3);
    } finally {
      client.provider.destroy();
      client.document.destroy();
      await realtime.destroy();
    }
  });

  it("keeps an open Document in step after a change that leaves the body alone", async () => {
    const { bodies } = await memoryBodies();
    const realtime = await startRealtimeServer(bodies);
    const client = await connectRealtimeClient({
      token: "human_a",
      url: wsUrl(realtime.address),
    });
    // A title-only change saves the same body with an empty update.
    const titleOnly: DocumentChangeComputation = async (stateBytes) => {
      const document = new Y.Doc({ gc: true });
      Y.applyUpdate(document, stateBytes);
      const result = {
        update: new Uint8Array(),
        stateBytes,
        stateVector: Y.encodeStateVector(document),
        title: "Renamed",
        assetIds: [],
        threadIds: [],
      };
      document.destroy();
      return result;
    };
    try {
      appendToFirstText(client.document, " human");
      await expect.poll(() => bodies.rows.get(documentId)!.seq).toBe(1);
      await expect(
        realtime.changes.apply({
          documentId,
          operationId: "operation_title",
          actorId: "actor_agent",
          expectedSeq: 1,
          compute: titleOnly,
        }),
      ).resolves.toMatchObject({ status: "applied", seq: 2 });
      await expect(
        realtime.changes.apply({
          documentId,
          operationId: "operation_after_title",
          actorId: "actor_agent",
          expectedSeq: 2,
          compute: appendChange(" agent"),
        }),
      ).resolves.toMatchObject({ status: "applied", seq: 3 });
      await expect
        .poll(() => firstText(Y.encodeStateAsUpdate(client.document)))
        .toMatchObject([{ text: "Durable initial state human agent" }]);
    } finally {
      client.provider.destroy();
      client.document.destroy();
      await realtime.destroy();
    }
  });

  it("reports a retried change applied without applying it again", async () => {
    const { bodies } = await memoryBodies();
    const realtime = await startRealtimeServer(bodies);
    const change = {
      documentId,
      operationId: "operation_retried",
      actorId: "actor_agent",
      expectedSeq: 0,
      compute: appendChange(" once"),
    };
    try {
      const first = await realtime.changes.apply(change);
      expect(first).toMatchObject({ status: "applied", seq: 1 });
      await expect(realtime.changes.apply(change)).resolves.toEqual(first);
      expect(bodies.saves).toHaveLength(1);
      expect(firstText(bodies.rows.get(documentId)!.state)).toMatchObject([
        { text: "Durable initial state once" },
      ]);
    } finally {
      await realtime.destroy();
    }
  });

  it("reports a stale expected sequence without saving", async () => {
    const { bodies } = await memoryBodies();
    const realtime = await startRealtimeServer(bodies);
    try {
      await expect(
        realtime.changes.apply({
          documentId,
          operationId: "operation_3",
          actorId: "actor_agent",
          expectedSeq: 3,
          compute: appendChange(" late"),
        }),
      ).resolves.toEqual({ status: "conflicted", reason: "stale_head" });
      expect(bodies.saves).toHaveLength(0);
    } finally {
      await realtime.destroy();
    }
  });

  it("recomputes a change whose body moved while it was computed", async () => {
    const { bodies } = await memoryBodies();
    const realtime = await startRealtimeServer(bodies);
    let moved = false;
    bodies.beforeSave = () => {
      if (moved) return;
      moved = true;
      bodies.commitServerChange((document) =>
        appendToFirstText(document, " other"),
      );
    };
    try {
      await expect(
        realtime.changes.apply({
          documentId,
          operationId: "operation_4",
          actorId: "actor_agent",
          compute: appendChange(" agent"),
        }),
      ).resolves.toMatchObject({ status: "applied", seq: 2 });
      expect(firstText(bodies.rows.get(documentId)!.state)).toMatchObject([
        { text: "Durable initial state other agent" },
      ]);
    } finally {
      await realtime.destroy();
    }
  });
});
