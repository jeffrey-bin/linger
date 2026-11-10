import { createServer, type Server } from "node:net";
import { Worker } from "node:worker_threads";

import type { JsonLogger } from "@linger/service-kit/node";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startDocumentService } from "../../src/document/main.js";

const environment = {
  LINGER_SECRET_SEED: "test-seed-0123456789abcdef0123456789",
  // Nothing listens here. The body store connects on its first statement, and
  // these tests open no Document.
  TEAMHUB_DATABASE_URL: "postgres://teamhub@127.0.0.1:9/teamhub",
};
const savedEnvironment = new Map<string, string | undefined>();

function setEnvironment(values: Record<string, string>): void {
  for (const [name, value] of Object.entries(values)) {
    if (!savedEnvironment.has(name))
      savedEnvironment.set(name, process.env[name]);
    process.env[name] = value;
  }
}

afterEach(() => {
  for (const [name, value] of savedEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnvironment.clear();
});

function testLogger() {
  const log = vi.fn<JsonLogger["log"]>();
  const logger: JsonLogger = { log, child: () => logger };
  return { logger, log };
}

// The Document Runtime binds every interface, so only a wildcard listener
// makes its port busy.
async function occupyPort(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  return address.port;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  return address.port;
}

describe("Document role", () => {
  it("serves from its own thread without leaking DOM globals into the host", async () => {
    const port = await freePort();
    setEnvironment({
      ...environment,
      DOCUMENT_RUNTIME_HTTP_ADDRESS: `127.0.0.1:${port}`,
    });

    const role = await startDocumentService(testLogger());
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(response.status).toBe(200);
      expect("window" in globalThis).toBe(false);
      expect("document" in globalThis).toBe(false);
    } finally {
      await role.stop();
    }
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
  });

  it("fails startup with the thread's configuration error", async () => {
    setEnvironment({
      ...environment,
      DOCUMENT_RUNTIME_HTTP_ADDRESS: "127.0.0.1:0",
    });

    await expect(startDocumentService(testLogger())).rejects.toThrow(
      "DOCUMENT_RUNTIME_HTTP_ADDRESS must be host:port with a port between 1 and 65535",
    );
  });

  // Two real worker startups and teardown surround the bounded 10s wait.
  it("starts without the thread while its port is busy and serves once the port frees", async () => {
    const blocker = createServer();
    const port = await occupyPort(blocker);
    setEnvironment({
      ...environment,
      DOCUMENT_RUNTIME_HTTP_ADDRESS: `127.0.0.1:${port}`,
    });
    const { logger, log } = testLogger();

    const role = await startDocumentService({ logger });
    try {
      expect(log).toHaveBeenCalledWith(
        "error",
        "document.thread_failed",
        expect.objectContaining({ restart_in_ms: 1_000 }),
      );
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
      await vi.waitFor(
        async () => {
          const response = await fetch(`http://127.0.0.1:${port}/healthz`);
          expect(response.status).toBe(200);
        },
        { timeout: 10_000, interval: 100 },
      );
    } finally {
      blocker.close();
      await role.stop();
    }
  }, 15_000);

  it("rebuilds a thread that exits after startup and drains the new one", async () => {
    const threads: Worker[] = [];
    const { logger, log } = testLogger();
    const role = await startDocumentService({
      logger,
      createThread: () => {
        const thread = new Worker(
          new URL("./fixtures/document-thread-stub.mjs", import.meta.url),
        );
        threads.push(thread);
        return thread;
      },
    });
    let rebuiltExit: Promise<number> | undefined;
    try {
      expect(threads).toHaveLength(1);
      await threads[0]!.terminate();
      await vi.waitFor(() => expect(threads).toHaveLength(2), {
        timeout: 5_000,
        interval: 50,
      });
      expect(log).toHaveBeenCalledWith(
        "error",
        "document.thread_failed",
        expect.objectContaining({ restart_in_ms: 1_000 }),
      );
      rebuiltExit = new Promise((resolve) => threads[1]!.once("exit", resolve));
    } finally {
      // Resolves only after the rebuilt thread answers the drain.
      await role.stop();
    }
    await expect(rebuiltExit).resolves.toEqual(expect.any(Number));
    expect(threads).toHaveLength(2);
  });
});
