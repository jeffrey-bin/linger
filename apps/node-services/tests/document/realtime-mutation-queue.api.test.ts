import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import {
  addCommentMarkToFirstText,
  appendToFirstText,
  connectRealtimeClient,
  memoryBodies,
  startRealtimeServer,
  wsUrl,
} from "./realtime-test-support.js";

type RealtimeClient = Awaited<ReturnType<typeof connectRealtimeClient>>;
interface CloseEvent {
  code: number;
  reason: string;
}

describe("Document Runtime mutation queue", () => {
  it("keeps one rapidly editing client connected across a transient autosave lock", async () => {
    const fixture = await createDelayedValidationFixture(1_250);
    let closeEvent: CloseEvent | undefined;
    let client: RealtimeClient | undefined;
    let expectedStateVector: string | undefined;
    let resolveCommitted!: () => void;
    const committed = new Promise<void>((resolve) => {
      resolveCommitted = resolve;
    });

    try {
      client = await connectRealtimeClient({
        token: "rapid_editor",
        url: wsUrl(fixture.realtime.address),
        onClose: (event) => {
          closeEvent = event;
        },
        onStateless: (payload) => {
          const envelope = JSON.parse(payload) as {
            head?: { persisted_seq?: number; state_vector?: string };
          };
          if (
            expectedStateVector !== undefined &&
            envelope.head?.state_vector === expectedStateVector
          )
            resolveCommitted();
        },
      });
      addCommentMarkToFirstText(client.document, "document_thread_rapid");
      for (let index = 1; index < 4; index += 1) {
        appendToFirstText(client.document, String(index % 10));
      }
      expectedStateVector = Buffer.from(
        Y.encodeStateVector(client.document),
      ).toString("base64");

      await Promise.race([
        committed,
        rejectAfter(8_000, "rapid mutation commit"),
      ]);
      expect(fixture.validateRequests).toHaveLength(1);
      expect(closeEvent).toBeUndefined();
    } finally {
      client?.provider.destroy();
      await fixture.realtime.destroy();
    }
  }, 10_000);

  it("keeps a healthy mutation connected when reference validation exceeds 250ms", async () => {
    const fixture = await createBlockedValidationFixture();
    let closeEvent: CloseEvent | undefined;
    let client: RealtimeClient | undefined;
    let resolveCommitted!: () => void;
    const committed = new Promise<void>((resolve) => {
      resolveCommitted = resolve;
    });

    try {
      client = await connectRealtimeClient({
        token: "healthy_delayed_permit",
        url: wsUrl(fixture.realtime.address),
        onClose: (event) => {
          closeEvent = event;
        },
        onStateless: (payload) => {
          const envelope = JSON.parse(payload) as {
            head?: { persisted_seq?: number };
          };
          if (envelope.head?.persisted_seq === 1) {
            resolveCommitted();
          }
        },
      });
      addCommentMarkToFirstText(client.document, "document_thread_delayed");
      await Promise.race([
        fixture.firstValidationObserved,
        rejectAfter(2_000, "delayed reference validation"),
      ]);

      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(closeEvent).toBeUndefined();
      fixture.releaseFirstValidation();
      await Promise.race([
        committed,
        rejectAfter(2_000, "delayed mutation commit"),
      ]);
    } finally {
      fixture.releaseFirstValidation();
      client?.provider.destroy();
      await fixture.realtime.destroy();
    }
  });

  it("fails a queued mutation closed after its authorization deadline", async () => {
    const fixture = await createBlockedValidationFixture();
    const clients: RealtimeClient[] = [];
    let activeClient: RealtimeClient | undefined;
    let queuedClient: RealtimeClient | undefined;
    let resolveActiveClose!: (event: CloseEvent) => void;
    const activeClose = new Promise<CloseEvent>((resolve) => {
      resolveActiveClose = resolve;
    });
    let resolveQueuedClose!: (event: CloseEvent) => void;
    const queuedClose = new Promise<CloseEvent>((resolve) => {
      resolveQueuedClose = resolve;
    });

    try {
      const realtimeUrl = wsUrl(fixture.realtime.address);
      activeClient = await connectRealtimeClient({
        token: "active",
        url: realtimeUrl,
        onClose: (event) => {
          resolveActiveClose(event);
          activeClient?.provider.destroy();
        },
      });
      clients.push(activeClient);
      queuedClient = await connectRealtimeClient({
        token: "queued",
        url: realtimeUrl,
        onClose: (event) => {
          resolveQueuedClose(event);
          queuedClient?.provider.destroy();
        },
      });
      clients.push(queuedClient);
      clients.push(
        await connectRealtimeClient({ token: "observer", url: realtimeUrl }),
      );
      const observerBefore = Y.encodeStateAsUpdate(clients[2]!.document);

      addCommentMarkToFirstText(clients[0]!.document, "document_thread_active");
      await Promise.race([
        fixture.firstValidationObserved,
        rejectAfter(2_000, "first reference validation"),
      ]);
      // A queued frame that adds a reference waits on the check too, so it
      // times out whether or not it reaches the head of the queue in time.
      addCommentMarkToFirstText(clients[1]!.document, "document_thread_queued");

      await expect(
        Promise.all([
          Promise.race([
            activeClose,
            rejectAfter(7_000, "active mutation close"),
          ]),
          Promise.race([
            queuedClose,
            rejectAfter(7_000, "queued mutation close"),
          ]),
        ]),
      ).resolves.toEqual([
        { code: 1000, reason: "Document mutation authorization timed out" },
        { code: 1000, reason: "Document mutation authorization timed out" },
      ]);
      expect(fixture.validateRequests.length).toBeGreaterThanOrEqual(1);
      expect(fixture.validateRequests.length).toBeLessThanOrEqual(2);
      expect(Y.encodeStateAsUpdate(clients[2]!.document)).toEqual(
        observerBefore,
      );
    } finally {
      fixture.releaseFirstValidation();
      for (const client of clients) {
        client.provider.destroy();
      }
      await fixture.realtime.destroy();
    }
  }, 9_000);

  it("fails closed when a Document already has 128 waiting mutations", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const fixture = await createBlockedValidationFixture();
    const clients: RealtimeClient[] = [];
    const closeEvents: Array<CloseEvent | undefined> = [];
    let resolveQueueFull!: (result: {
      event: CloseEvent;
      index: number;
    }) => void;
    const queueFull = new Promise<{ event: CloseEvent; index: number }>(
      (resolve) => {
        resolveQueueFull = resolve;
      },
    );

    try {
      const realtimeUrl = wsUrl(fixture.realtime.address);
      const connected = await Promise.all(
        Array.from({ length: 130 }, async (_, index) =>
          connectRealtimeClient({
            token: `queue_${index}`,
            url: realtimeUrl,
            onClose: (event) => {
              closeEvents[index] = event;
              clients[index]?.provider.destroy();
              if (event.reason === "Document mutation queue is full") {
                resolveQueueFull({ event, index });
              }
            },
          }),
        ),
      );
      clients.push(...connected);
      const observer = await connectRealtimeClient({
        token: "queue_observer",
        url: realtimeUrl,
      });
      clients.push(observer);
      const observerBefore = Y.encodeStateAsUpdate(observer.document);

      addCommentMarkToFirstText(clients[0]!.document, "document_thread_active");
      await Promise.race([
        fixture.firstValidationObserved,
        rejectAfter(2_000, "first reference validation"),
      ]);
      for (let index = 1; index < 130; index += 1) {
        appendToFirstText(clients[index]!.document, ` queued_${index}`);
      }

      const rejected = await Promise.race([
        queueFull,
        rejectAfter(2_000, "queue-full close"),
      ]);
      expect(rejected.event).toEqual({
        code: 1000,
        reason: "Document mutation queue is full",
      });
      expect(rejected.index).toBeGreaterThan(0);
      expect(closeEvents.filter(Boolean)).toContainEqual(rejected.event);
      expect(fixture.validateRequests).toHaveLength(1);
      expect(Y.encodeStateAsUpdate(observer.document)).toEqual(observerBefore);
      // The held reference validation times out; a queued typing frame that
      // still has time left when the queue advances is admitted, because it
      // reads nothing from the database.
      await waitFor(
        () =>
          closeEvents[0]?.reason ===
          "Document mutation authorization timed out",
        "the held mutation to time out",
        7_000,
      );
    } finally {
      fixture.releaseFirstValidation();
      for (const client of clients) {
        client.provider.destroy();
      }
      await fixture.realtime.destroy();
      consoleError.mockRestore();
    }
  }, 12_000);
});

async function createBlockedValidationFixture() {
  const { bodies } = await memoryBodies();
  let observeFirstValidation!: () => void;
  const firstValidationObserved = new Promise<void>((resolve) => {
    observeFirstValidation = resolve;
  });
  let releaseFirstValidation!: () => void;
  const firstValidationRelease = new Promise<void>((resolve) => {
    releaseFirstValidation = resolve;
  });
  bodies.beforeCheckReferences = async () => {
    if (bodies.referenceChecks.length === 1) {
      observeFirstValidation();
    }
    await firstValidationRelease;
    return "available" as const;
  };
  const realtime = await startRealtimeServer(bodies);
  return {
    firstValidationObserved,
    validateRequests: bodies.referenceChecks,
    realtime,
    releaseFirstValidation,
  };
}

async function createDelayedValidationFixture(delayMs: number) {
  const { bodies } = await memoryBodies();
  bodies.beforeCheckReferences = async () => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return "available" as const;
  };
  const realtime = await startRealtimeServer(bodies);
  return { validateRequests: bodies.referenceChecks, realtime };
}

function rejectAfter(milliseconds: number, operation: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(
      () => reject(new Error(`Timed out waiting for ${operation}`)),
      milliseconds,
    );
  });
}

async function waitFor(
  predicate: () => boolean,
  operation: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${operation}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
