import { describe, expect, it, vi } from "vitest";

import type { DocumentBodySave } from "../../src/document/bodies.js";
import {
  addCommentMarkToFirstText,
  appendToFirstText,
  connectRealtimeClient,
  documentId,
  memoryBodies,
  startRealtimeServer,
  wsUrl,
} from "./realtime-test-support.js";

describe("Document Runtime durable save retry", () => {
  it("retries the immutable failed batch before saving later mutations", async () => {
    const { bodies } = await memoryBodies();
    let failFirstSave!: () => void;
    const firstSaveFailed = new Promise<void>((resolve) => {
      failFirstSave = resolve;
    });
    let commitSecondBatch!: () => void;
    const secondBatchCommitted = new Promise<void>((resolve) => {
      commitSecondBatch = resolve;
    });
    bodies.beforeSave = (save) => {
      if (bodies.saves.length === 1) {
        failFirstSave();
        throw new Error("Temporary PostgreSQL failure");
      }
      if (bodies.saves.length === 3) {
        queueMicrotask(commitSecondBatch);
      }
      expect(save.documentId).toBe(documentId);
    };
    const realtime = await startRealtimeServer(bodies);
    const client = await connectRealtimeClient({
      token: "human_a",
      url: wsUrl(realtime.address),
    });

    try {
      appendToFirstText(client.document, " first");
      await Promise.race([
        firstSaveFailed,
        rejectAfter(2_000, "first save failure"),
      ]);
      appendToFirstText(client.document, " second");
      await Promise.race([
        secondBatchCommitted,
        rejectAfter(4_000, "second durable batch"),
      ]);

      expect(bodies.saves).toHaveLength(3);
      expect(bodies.saves[1]).toEqual(bodies.saves[0]);
      expect(bodies.saves[2]).toMatchObject<Partial<DocumentBodySave>>({
        baseSeq: 1,
        editorIds: ["actor_human_a"],
      });
    } finally {
      client.provider.destroy();
      await realtime.destroy();
    }
  });

  it("drains a closed connection before unloading its durable queue", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const { bodies } = await memoryBodies();
    bodies.knownThreads.add("document_thread_teardown");
    let beginUnload: () => void = () => undefined;
    let resolveFirstCheckStarted!: () => void;
    const firstCheckStarted = new Promise<void>((resolve) => {
      resolveFirstCheckStarted = resolve;
    });
    let releaseFirstCheck!: () => void;
    const firstCheckRelease = new Promise<void>((resolve) => {
      releaseFirstCheck = resolve;
    });
    bodies.beforeCheckReferences = async () => {
      if (bodies.referenceChecks.length === 1) {
        resolveFirstCheckStarted();
        await firstCheckRelease;
        queueMicrotask(() => beginUnload());
        throw new Error("Injected database failure");
      }
    };
    const realtime = await startRealtimeServer(bodies);
    let resolveUnloadStarted!: () => void;
    const unloadStarted = new Promise<void>((resolve) => {
      resolveUnloadStarted = resolve;
    });
    let unloadCompleted = Promise.resolve();
    beginUnload = () => {
      const resident = realtime.hocuspocus.documents.get(documentId);
      if (resident === undefined) {
        throw new Error("Expected a resident Document during teardown");
      }
      resolveUnloadStarted();
      unloadCompleted = realtime.hocuspocus.unloadDocument(resident);
    };
    let firstProvider: Awaited<
      ReturnType<typeof connectRealtimeClient>
    >["provider"];
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const first = await connectRealtimeClient({
      token: "teardown_a",
      url: wsUrl(realtime.address),
      onProviderCreated: (provider) => {
        firstProvider = provider;
      },
      onClose: () => {
        firstProvider.destroy();
        resolveClosed();
      },
    });

    try {
      addCommentMarkToFirstText(first.document, "document_thread_teardown");
      await Promise.race([
        firstCheckStarted,
        rejectAfter(2_000, "first reference check"),
      ]);
      appendToFirstText(first.document, " two");
      appendToFirstText(first.document, " three");
      appendToFirstText(first.document, " four");
      releaseFirstCheck();

      await Promise.race([unloadStarted, rejectAfter(2_000, "unload start")]);
      await Promise.race([closed, rejectAfter(2_000, "connection close")]);
      await Promise.race([
        unloadCompleted,
        rejectAfter(2_000, "drained unload"),
      ]);
      expect(bodies.referenceChecks).toHaveLength(1);

      const reopened = await connectRealtimeClient({
        document: first.document,
        token: "teardown_b",
        url: wsUrl(realtime.address),
      });
      try {
        await waitFor(() => bodies.saves.length === 1);
        expect(bodies.referenceChecks).toHaveLength(2);
        expect(bodies.saves[0]).toMatchObject<Partial<DocumentBodySave>>({
          baseSeq: 0,
          editorIds: ["actor_teardown_b"],
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(bodies.saves).toHaveLength(1);
        expect(
          consoleError.mock.calls
            .flat()
            .some((value) =>
              String(value).includes(
                "Document durable queue is not initialized",
              ),
            ),
        ).toBe(false);
      } finally {
        reopened.provider.destroy();
      }
    } finally {
      releaseFirstCheck();
      firstProvider!.destroy();
      await realtime.destroy();
      consoleError.mockRestore();
    }
  });
});

function rejectAfter(milliseconds: number, operation: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(
      () => reject(new Error(`Timed out waiting for ${operation}`)),
      milliseconds,
    );
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for teardown recovery");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
