import type { DocumentBodyStore } from "../../src/document/bodies.js";
import { DocumentDurabilityCoordinator } from "../../src/document/realtime-durability.js";
import { DocumentFailureEvidenceStore } from "../../src/document/failure-evidence.js";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import * as Y from "yjs";
import {
  appendToFirstText,
  connectRealtimeClient,
  createInitialState,
  documentId,
  MemoryDocumentBodies,
  startRealtimeServer,
  wsUrl,
} from "./realtime-test-support.js";

it("recovers a byte-verified legacy snapshot whose deleted structs normalize on load and saves new edits", async () => {
  const initial = await createInitialState();
  const legacy = new Y.Doc();
  Y.applyUpdate(legacy, initial.stateBytes);
  legacy.clientID = 7;
  const root = legacy.getXmlFragment("prosemirror");
  const removed = new Y.XmlElement("p");
  const text = new Y.XmlText();
  removed.insert(0, [text]);
  root.insert(root.length, [removed]);
  text.insert(0, "deleted text");
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(legacy));
  peer.clientID = 8;
  const other = root.length - 1;
  const peerText = (
    peer.getXmlFragment("prosemirror").get(other) as Y.XmlElement
  ).get(0) as Y.XmlText;
  peerText.insert(1, "x");
  root.delete(other, 1);
  Y.applyUpdate(legacy, Y.encodeStateAsUpdate(peer));
  text.insert(0, "y");
  const stateBytes = Y.encodeStateAsUpdate(legacy);
  const normalized = new Y.Doc();
  Y.applyUpdate(normalized, stateBytes);
  expect(
    Buffer.from(stateBytes).equals(
      Buffer.from(Y.encodeStateAsUpdate(normalized)),
    ),
  ).toBe(false);
  let saved = false;
  const bodies = new MemoryDocumentBodies();
  // The stored bytes stay exactly the legacy encoding.
  bodies.put({ stateBytes, stateVector: Y.encodeStateVector(legacy) });
  const runtime = await startRealtimeServer(bodies);
  let provider:
    | Awaited<ReturnType<typeof connectRealtimeClient>>["provider"]
    | undefined;
  try {
    const client = await connectRealtimeClient({
      token: "gc",
      url: wsUrl(runtime.address),
      onProviderCreated: (p) => (provider = p),
      onStateless: (p) => {
        const a = JSON.parse(p);
        if (a.type === "durability_ack" && a.head.persisted_seq === 1)
          saved = true;
      },
    });
    appendToFirstText(client.document, " saved after recovery");
    await expect.poll(() => saved).toBe(true);
  } finally {
    provider?.destroy();
    await runtime.destroy();
    legacy.destroy();
    peer.destroy();
    normalized.destroy();
  }
});

it("keeps committed state and reconnect consistent across deletion and stale peer edits", async () => {
  const initial = await createInitialState();
  const local = new Y.Doc();
  Y.applyUpdate(local, initial.stateBytes);
  local.clientID = 7;
  const group = local.getXmlFragment("prosemirror").get(0) as Y.XmlElement;
  const temporary = (group.get(0) as Y.XmlElement).clone();
  temporary.setAttribute("id", "temporary_block");
  group.insert(1, [temporary]);
  const staleText = (temporary.get(0) as Y.XmlElement).get(0) as Y.XmlText;
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(local));
  peer.clientID = 8;
  const peerGroup = peer.getXmlFragment("prosemirror").get(0) as Y.XmlElement;
  const peerText = (
    (peerGroup.get(1) as Y.XmlElement).get(0) as Y.XmlElement
  ).get(0) as Y.XmlText;
  let head = {
    document_id: documentId,
    schema_version: 1,
    persisted_seq: 0,
    state_vector: Buffer.from(Y.encodeStateVector(local)).toString("base64"),
    state_hash: createHash("sha256")
      .update(Y.encodeStateAsUpdate(local))
      .digest("hex"),
    state_hash_version: 1,
  };
  let persisted = Y.encodeStateAsUpdate(local);
  const committed: number[] = [];
  const coordinator = new DocumentDurabilityCoordinator({
    failureEvidence: new DocumentFailureEvidenceStore({
      runtimeInstanceId: "runtime_test",
    }),
    maxUnsavedBacklogBytes: 16 << 20,
    bodies: {
      save: async (request) => {
        persisted = request.state;
        head = {
          ...head,
          persisted_seq: request.baseSeq + 1,
          state_vector: Buffer.from(request.stateVector).toString("base64"),
          state_hash: createHash("sha256").update(request.state).digest("hex"),
        };
        return { kind: "saved", seq: head.persisted_seq };
      },
    } as DocumentBodyStore,
    onCommitted: (_, value) => committed.push(value.persisted_seq),
  });
  coordinator.registerDocument({
    documentId,
    head,
    stateBytes: persisted,
    references: { document_asset_ids: [], document_thread_ids: [] },
  });
  const save = async (change: () => void) => {
    const updates: Uint8Array[] = [];
    const collect = (update: Uint8Array) => updates.push(update);
    local.on("update", collect);
    change();
    local.off("update", collect);
    const connection = {};
    coordinator.reserveMutation({
      connection,
      documentId,
      update: Y.mergeUpdates(updates),
      actorId: "actor_unit",
    });
    coordinator.recordAppliedMutation({ connection, documentId });
    await coordinator.flush(documentId);
  };
  try {
    await save(() => group.delete(1, 1));
    await save(() => {
      peerText.insert(1, "x");
      Y.applyUpdate(local, Y.encodeStateAsUpdate(peer));
    });
    await save(() => staleText.insert(0, "y"));
    await save(() => appendToFirstText(local, " after GC"));
    expect(committed).toEqual([1, 2, 3, 4]);
    expect(coordinator.getPermanentFailure(documentId)).toBeUndefined();
    expect(coordinator.captureCommittedState(documentId)).toEqual({
      head,
      stateBytes: persisted,
    });
    expect(
      coordinator.registerDocument({
        documentId,
        head,
        stateBytes: persisted,
        references: { document_asset_ids: [], document_thread_ids: [] },
      }).head,
    ).toEqual(head);
  } finally {
    local.destroy();
    peer.destroy();
  }
});
