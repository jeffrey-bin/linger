import { describe, expect, it } from "vitest";

import {
  appendToFirstText,
  connectRealtimeClient,
  documentId,
  memoryBodies,
  startRealtimeServer,
  wsUrl,
} from "./realtime-test-support.js";

describe("Document Runtime durable acknowledgement", () => {
  it("sends one committed head to every active recipient", async () => {
    const { bodies } = await memoryBodies();
    const realtime = await startRealtimeServer(bodies);
    const firstAcks: unknown[] = [];
    const secondAcks: unknown[] = [];
    const first = await connectRealtimeClient({
      token: "human_a",
      url: wsUrl(realtime.address),
      onStateless: (payload) => firstAcks.push(JSON.parse(payload)),
    });
    const second = await connectRealtimeClient({
      token: "human_b",
      url: wsUrl(realtime.address),
      onStateless: (payload) => secondAcks.push(JSON.parse(payload)),
    });

    try {
      firstAcks.length = 0;
      secondAcks.length = 0;
      appendToFirstText(first.document, " acknowledged");

      await waitFor(
        () =>
          findPersistedAck(firstAcks, 1) !== undefined &&
          findPersistedAck(secondAcks, 1) !== undefined,
      );
      const firstAck = findPersistedAck(firstAcks, 1)!;
      const secondAck = findPersistedAck(secondAcks, 1)!;
      expect(firstAck).toMatchObject({
        type: "durability_ack",
        head: { document_id: documentId, persisted_seq: 1 },
      });
      expect(firstAck).not.toHaveProperty("access_epoch");
      expect(firstAck).toEqual(secondAck);
      expect(firstAck.head).not.toHaveProperty("session_id");
      expect(firstAck.head).not.toHaveProperty("permit_id");
    } finally {
      first.provider.destroy();
      second.provider.destroy();
      await realtime.destroy();
    }
  });

  it("accepts an Open prefix captured before the resident durable head advances", async () => {
    const { bodies } = await memoryBodies();
    const secondOpenCaptured = deferred<void>();
    const releaseSecondOpen = deferred<void>();
    bodies.beforeLoad = async () => {
      if (bodies.loads.length === 2) {
        // The second connection read the body before the first save lands.
        const loaded = bodies.snapshot();
        secondOpenCaptured.resolve();
        await releaseSecondOpen.promise;
        return loaded;
      }
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
      const secondConnection = connectRealtimeClient({
        token: "human_b",
        url: wsUrl(realtime.address),
        onStateless: (payload) => secondAcks.push(JSON.parse(payload)),
      });
      await secondOpenCaptured.promise;
      appendToFirstText(first.document, " advanced while opening");
      await waitFor(() => findPersistedAck(firstAcks, 1) !== undefined);
      releaseSecondOpen.resolve();

      second = await secondConnection;
      await waitFor(() => findPersistedAck(secondAcks, 1) !== undefined);
      expect(findPersistedAck(secondAcks, 1)).toMatchObject({
        head: { document_id: documentId, persisted_seq: 1 },
      });
    } finally {
      releaseSecondOpen.resolve();
      first.provider.destroy();
      second?.provider.destroy();
      await realtime.destroy();
    }
  });
});

function findPersistedAck(
  acknowledgements: unknown[],
  persistedSequence: number,
): { head: Record<string, unknown> } | undefined {
  return acknowledgements.find(
    (
      value,
    ): value is {
      head: Record<string, unknown>;
    } => {
      if (typeof value !== "object" || value === null) {
        return false;
      }
      const head = (value as { head?: unknown }).head;
      return (
        typeof head === "object" &&
        head !== null &&
        (head as { persisted_seq?: unknown }).persisted_seq ===
          persistedSequence
      );
    },
  );
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for recipient durable ACKs");
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
