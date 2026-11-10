import { HocuspocusProvider } from "@hocuspocus/provider";
import { Server } from "@hocuspocus/server";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

describe("Hocuspocus queued frame handling", () => {
  it("drops frames queued behind a rejected sync update", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    let rejectUpdates = false;
    let beforeSyncCalls = 0;
    let observeFirstUpdate!: () => void;
    const firstUpdateObserved = new Promise<void>((resolve) => {
      observeFirstUpdate = resolve;
    });
    let releaseFirstUpdate!: () => void;
    const firstUpdateRelease = new Promise<void>((resolve) => {
      releaseFirstUpdate = resolve;
    });
    const server = new Server({
      address: "127.0.0.1",
      port: 0,
      quiet: true,
      stopOnSignals: false,
      async beforeSync({ type }) {
        if (!rejectUpdates || type !== 2) {
          return;
        }
        beforeSyncCalls += 1;
        if (beforeSyncCalls === 1) {
          observeFirstUpdate();
          await firstUpdateRelease;
          throw Object.assign(new Error("Injected sync rejection"), {
            code: 4403,
            reason: "Injected sync rejection",
          });
        }
      },
    });
    await server.listen();

    const editor = await connectProvider(server.webSocketURL, "queued-frame");
    const observer = await connectProvider(server.webSocketURL, "queued-frame");
    const observerBefore = Y.encodeStateAsUpdate(observer.document);

    try {
      rejectUpdates = true;
      editor.document.getText("content").insert(0, "first");
      await Promise.race([
        firstUpdateObserved,
        rejectAfter(2_000, "first queued update"),
      ]);
      editor.document.getText("content").insert(5, "second");
      editor.document.getText("content").insert(11, "third");
      releaseFirstUpdate();

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(beforeSyncCalls).toBe(1);
      expect(Y.encodeStateAsUpdate(observer.document)).toEqual(observerBefore);
    } finally {
      releaseFirstUpdate();
      editor.provider.destroy();
      observer.provider.destroy();
      await server.destroy();
      consoleError.mockRestore();
    }
  });
});

async function connectProvider(url: string, name: string) {
  const document = new Y.Doc({ gc: true });
  let provider: HocuspocusProvider | undefined;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for Hocuspocus sync")),
      2_000,
    );
    provider = new HocuspocusProvider({
      document,
      name,
      url,
      onSynced: () => {
        clearTimeout(timeout);
        resolve();
      },
    });
  });
  return { document, provider: provider! };
}

function rejectAfter(delayMs: number, description: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(
      () => reject(new Error(`Timed out waiting for ${description}`)),
      delayMs,
    );
  });
}
