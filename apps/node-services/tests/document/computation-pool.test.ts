import { describe, expect, it } from "vitest";

import { createDocumentRuntimeApp } from "../../src/document/app.js";
import {
  createDocumentComputationPool,
  DocumentComputationError,
} from "../../src/document/computation-pool.js";
import { useDocumentComputation } from "./computation-test-support.js";
import { sleep } from "@linger/service-kit";

const teamHubToken = "teamhub-to-runtime-pool-test-token";
const fixtureWorkerUrl = new URL(
  "./fixtures/fixture-computation-worker.ts",
  import.meta.url,
);
const failingWorkerUrl = new URL(
  "./fixtures/failing-computation-worker.ts",
  import.meta.url,
);
const closedMessage = "Document computation pool is closed";
describe("Document computation pool", () => {
  const computation = useDocumentComputation();

  it("rejects a coded model error with its code and keeps the HTTP status", async () => {
    const error = await computation
      .run("materializeRoomDocument", {
        materializationId: "9b5be123-4fd2-4a47-a98d-548879f3fc78",
        schemaVersion: 999,
        sourceKind: "blank",
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DocumentComputationError);
    expect(error).toBeInstanceOf(Error);
    expect((error as DocumentComputationError).code).toBe(
      "unsupported_document",
    );

    const response = await createDocumentRuntimeApp({
      computation,
      teamHubToken,
    }).request("/internal/v1/documents/import", {
      method: "POST",
      headers: {
        authorization: `Bearer ${teamHubToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        operation_id: "9b5be123-4fd2-4a47-a98d-548879f3fc78",
        schema_version: 999,
        source_kind: "blank",
      }),
    });
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      code: "unsupported_document",
      retryable: false,
    });
  });

  it("fails only the crashed task with a plain Error and replaces the worker", async () => {
    const reports: string[] = [];
    const pool = createDocumentComputationPool({
      size: 1,
      workerUrl: fixtureWorkerUrl,
      respawnDelayMs: 10,
      reportError: (message) => reports.push(message),
    });
    try {
      const crashed = await pool
        .run("materializeRoomDocument", "crash" as never)
        .catch((caught: unknown) => caught);

      expect(crashed).toBeInstanceOf(Error);
      expect(crashed).not.toBeInstanceOf(DocumentComputationError);
      expect("code" in (crashed as object)).toBe(false);
      expect(reports).toHaveLength(1);
      expect(reports[0]).toContain("materializeRoomDocument");
      expect(reports[0]).toContain("exited with code 1");

      await expect(
        pool.run("materializeRoomDocument", "after crash" as never),
      ).resolves.toBe("after crash");
    } finally {
      await pool.close();
    }
  });

  it("does not spin when replacement workers keep failing to load", async () => {
    const reports: string[] = [];
    const pool = createDocumentComputationPool({
      size: 1,
      workerUrl: failingWorkerUrl,
      respawnDelayMs: 50,
      reportError: (message) => reports.push(message),
    });
    const started = performance.now();
    const error = await pool
      .run("materializeRoomDocument", "value" as never)
      .catch((caught: unknown) => caught);

    expect(performance.now() - started).toBeLessThan(1000);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DocumentComputationError);
    expect("code" in (error as object)).toBe(false);

    await sleep(200);
    expect(reports.length).toBeGreaterThan(0);
    expect(reports.length).toBeLessThanOrEqual(6);

    await pool.close();
    const afterClose = reports.length;
    await sleep(150);
    expect(reports.length).toBe(afterClose);
  });

  it("spawns no worker until the first run", async () => {
    const reports: string[] = [];
    const pool = createDocumentComputationPool({
      size: 1,
      workerUrl: failingWorkerUrl,
      reportError: (message) => reports.push(message),
    });
    try {
      await sleep(200);
      expect(reports).toEqual([]);

      await expect(
        pool.run("materializeRoomDocument", "value" as never),
      ).rejects.toThrow("Document computation failed");
      expect(reports).toHaveLength(1);
    } finally {
      await pool.close();
    }
  });

  it("queues runs beyond the pool size and completes them in order", async () => {
    const pool = createDocumentComputationPool({
      size: 1,
      workerUrl: fixtureWorkerUrl,
      reportError: () => undefined,
    });
    try {
      const completed: string[] = [];
      await Promise.all(
        ["first", "second", "third"].map((input) =>
          pool
            .run("materializeRoomDocument", input as never)
            .then((result) => completed.push(result as unknown as string)),
        ),
      );
      expect(completed).toEqual(["first", "second", "third"]);
    } finally {
      await pool.close();
    }
  });

  it("retires an idle worker without reporting and spawns a fresh one on demand", async () => {
    const reports: string[] = [];
    const pool = createDocumentComputationPool({
      size: 1,
      workerUrl: fixtureWorkerUrl,
      idleTimeoutMs: 50,
      reportError: (message) => reports.push(message),
    });
    try {
      const first = await pool.run(
        "materializeRoomDocument",
        "thread" as never,
      );
      await sleep(300);
      const second = await pool.run(
        "materializeRoomDocument",
        "thread" as never,
      );

      expect(second).not.toBe(first);
      expect(reports).toEqual([]);
    } finally {
      await pool.close();
    }
  });

  it("keeps an idle worker that receives work before its timeout", async () => {
    const pool = createDocumentComputationPool({
      size: 1,
      workerUrl: fixtureWorkerUrl,
      idleTimeoutMs: 300,
      reportError: () => undefined,
    });
    try {
      const first = await pool.run(
        "materializeRoomDocument",
        "thread" as never,
      );
      await sleep(200);
      await expect(
        pool.run("materializeRoomDocument", "thread" as never),
      ).resolves.toBe(first);
      await sleep(200);
      await expect(
        pool.run("materializeRoomDocument", "thread" as never),
      ).resolves.toBe(first);
    } finally {
      await pool.close();
    }
  });

  it("drains queued work on a replacement spawned after the respawn delay", async () => {
    const reports: string[] = [];
    const pool = createDocumentComputationPool({
      size: 1,
      workerUrl: fixtureWorkerUrl,
      respawnDelayMs: 150,
      reportError: (message) => reports.push(message),
    });
    try {
      let crashedAt = 0;
      const crashed = pool
        .run("materializeRoomDocument", "crash" as never)
        .catch((caught: unknown) => {
          crashedAt = performance.now();
          return caught;
        });
      const queued = [
        pool.run("materializeRoomDocument", "first" as never),
        pool.run("materializeRoomDocument", "second" as never),
      ];

      expect(await crashed).toBeInstanceOf(Error);
      await expect(Promise.all(queued)).resolves.toEqual(["first", "second"]);
      expect(performance.now() - crashedAt).toBeGreaterThanOrEqual(140);
      expect(reports).toHaveLength(1);
    } finally {
      await pool.close();
    }
  });

  it("closes while its worker is idle", async () => {
    const reports: string[] = [];
    const pool = createDocumentComputationPool({
      size: 1,
      workerUrl: fixtureWorkerUrl,
      idleTimeoutMs: 50,
      reportError: (message) => reports.push(message),
    });
    await expect(
      pool.run("materializeRoomDocument", "idle" as never),
    ).resolves.toBe("idle");

    await pool.close();
    await sleep(150);
    expect(reports).toEqual([]);
    await expect(
      pool.run("materializeRoomDocument", "later" as never),
    ).rejects.toThrow(closedMessage);
  });

  it("rejects in-flight and queued work on close and rejects later runs", async () => {
    const pool = createDocumentComputationPool({
      size: 1,
      workerUrl: fixtureWorkerUrl,
      reportError: () => undefined,
    });
    const inFlight = expect(
      pool.run("materializeRoomDocument", "hang" as never),
    ).rejects.toThrow(closedMessage);
    const queued = expect(
      pool.run("materializeRoomDocument", "queued" as never),
    ).rejects.toThrow(closedMessage);

    await pool.close();
    await inFlight;
    await queued;
    await expect(
      pool.run("materializeRoomDocument", "later" as never),
    ).rejects.toThrow(closedMessage);
    await expect(pool.close()).resolves.toBeUndefined();
  });
});
