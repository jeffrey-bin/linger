import {
  materializeRoomDocument,
  readRoomDocumentBlocks,
} from "@linger/document-model";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  appendToFirstText,
  connectRealtimeClient,
  documentId,
  memoryBodies,
  startRealtimeServer,
  wsUrl,
} from "./realtime-test-support.js";

describe("Document Runtime durable reopen", () => {
  it("replaces unloaded resident state with a newer saved body", async () => {
    const { bodies } = await memoryBodies();
    const advanced = await materializeRoomDocument({
      materializationId: "realtime-advanced-materialization",
      schemaVersion: 1,
      sourceKind: "plain_text",
      sourceBytes: Buffer.from("Advanced durable state"),
    });
    let realtime = await startRealtimeServer(bodies);
    const first = await connectRealtimeClient({
      token: "human_a",
      url: wsUrl(realtime.address),
    });

    first.provider.destroy();
    await realtime.destroy();
    bodies.put(advanced, { seq: 1 });
    realtime = await startRealtimeServer(bodies);

    const reopened = await connectRealtimeClient({
      token: "human_b",
      url: wsUrl(realtime.address),
    });
    try {
      expect(
        readRoomDocumentBlocks(Y.encodeStateAsUpdate(reopened.document)),
      ).toMatchObject([
        {
          type: "paragraph",
          content: [{ text: "Advanced durable state" }],
        },
      ]);
    } finally {
      reopened.provider.destroy();
      await realtime.destroy();
    }
  });

  it("finds a save whose reply was lost and reissues the durable ACK on reopen", async () => {
    const { bodies } = await memoryBodies();
    let resolveLostReply!: () => void;
    const lostReply = new Promise<void>((resolve) => {
      resolveLostReply = resolve;
    });
    let resolveRetried!: () => void;
    const retried = new Promise<void>((resolve) => {
      resolveRetried = resolve;
    });
    bodies.beforeSave = (save) => {
      if (bodies.saves.length === 1) {
        bodies.apply(save);
        resolveLostReply();
        throw new Error("Connection reset after commit");
      }
      queueMicrotask(resolveRetried);
    };
    const realtime = await startRealtimeServer(bodies);
    const firstAcks: unknown[] = [];
    const first = await connectRealtimeClient({
      token: "human_a",
      url: wsUrl(realtime.address),
      onStateless: (payload) => firstAcks.push(JSON.parse(payload)),
    });

    appendToFirstText(first.document, " recovered");
    await Promise.race([lostReply, rejectAfter(2_000, "lost save reply")]);
    first.provider.destroy();
    await Promise.race([retried, rejectAfter(2_000, "save retry")]);
    expect(firstAcks.some(isSequenceOneAck)).toBe(false);

    const reopenedAcks: unknown[] = [];
    const reopened = await connectRealtimeClient({
      token: "human_a",
      url: wsUrl(realtime.address),
      onStateless: (payload) => reopenedAcks.push(JSON.parse(payload)),
    });
    try {
      await waitFor(() => reopenedAcks.some(isSequenceOneAck));
      expect(
        readRoomDocumentBlocks(Y.encodeStateAsUpdate(reopened.document)),
      ).toMatchObject([
        {
          type: "paragraph",
          content: [{ text: "Durable initial state recovered" }],
        },
      ]);
      expect(bodies.saves).toHaveLength(2);
      expect(bodies.saves[1]).toEqual(bodies.saves[0]);
      expect(bodies.rows.get(documentId)!.seq).toBe(1);
    } finally {
      reopened.provider.destroy();
      await realtime.destroy();
    }
  });
});

function isSequenceOneAck(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "durability_ack" &&
    typeof (value as { head?: unknown }).head === "object" &&
    (value as { head: { persisted_seq?: unknown } }).head.persisted_seq === 1
  );
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for reopened durable ACK");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function rejectAfter(milliseconds: number, operation: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(
      () => reject(new Error(`Timed out waiting for ${operation}`)),
      milliseconds,
    );
  });
}
