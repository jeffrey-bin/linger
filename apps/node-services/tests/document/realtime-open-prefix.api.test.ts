import { describe, expect, it } from "vitest";

import {
  appendToFirstText,
  connectRealtimeClient,
  memoryBodies,
  startRealtimeServer,
  wsUrl,
} from "./realtime-test-support.js";

describe("Document Runtime open prefix reconciliation", () => {
  it("accepts a saved prefix while its save reply is still in flight", async () => {
    const { bodies } = await memoryBodies();
    const saveCommitted = deferred<void>();
    const releaseSaveReply = deferred<void>();
    bodies.beforeSave = async (save) => {
      // The row commits first; the reply waits.
      bodies.apply(save);
      saveCommitted.resolve();
      await releaseSaveReply.promise;
      return { kind: "saved", seq: save.baseSeq + 1 };
    };
    const realtime = await startRealtimeServer(bodies);
    const firstAcks: unknown[] = [];
    const secondAcks: unknown[] = [];
    const first = await connectRealtimeClient({
      token: "human_a",
      url: wsUrl(realtime.address),
      onStateless: (payload) => firstAcks.push(JSON.parse(payload)),
    });
    let second: Awaited<ReturnType<typeof connectRealtimeClient>> | undefined;

    try {
      appendToFirstText(first.document, " committed before reply");
      await saveCommitted.promise;
      second = await connectRealtimeClient({
        token: "human_b",
        url: wsUrl(realtime.address),
        onStateless: (payload) => secondAcks.push(JSON.parse(payload)),
      });
      await waitFor(() => hasPersistedAck(secondAcks, 1));
      expect(second.document.getXmlFragment("prosemirror").toJSON()).toContain(
        "committed before reply",
      );

      releaseSaveReply.resolve();
      await waitFor(() => hasPersistedAck(firstAcks, 1));
    } finally {
      releaseSaveReply.resolve();
      first.provider.destroy();
      second?.provider.destroy();
      await realtime.destroy();
    }
  });
});

function hasPersistedAck(
  acknowledgements: unknown[],
  persistedSequence: number,
): boolean {
  return acknowledgements.some((value) => {
    if (typeof value !== "object" || value === null || !("head" in value)) {
      return false;
    }
    const head = value.head;
    return (
      typeof head === "object" &&
      head !== null &&
      "persisted_seq" in head &&
      head.persisted_seq === persistedSequence
    );
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for a durable ACK");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
