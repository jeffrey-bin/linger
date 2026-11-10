import {
  open,
  readFile,
  readdir,
  rmdir,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import {
  fingerprintRoomDocumentState,
  readRoomDocumentBlocks,
} from "@linger/document-model";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import {
  addCommentMarkToFirstText,
  appendToFirstText,
  connectRealtimeClient,
  documentId,
  memoryBodies,
  startRealtimeServer,
  wsUrl,
} from "./realtime-test-support.js";
import { failedSaveHarness } from "./realtime-failure-test-support.js";

function loggedRecords(write: {
  mock: { calls: unknown[][] };
}): Record<string, unknown>[] {
  return write.mock.calls.flatMap(([chunk]) => {
    const line = String(chunk);
    return line.startsWith("{")
      ? [JSON.parse(line) as Record<string, unknown>]
      : [];
  });
}

describe("Document Runtime permanent durable save failure", () => {
  it("sends failure to every recipient before closing with the durable failure reason", async () => {
    const harness = await failedSaveHarness();
    try {
      const first = await harness.open("terminal_first");
      const second = await harness.open("terminal_second");
      await harness.fail(first);
      for (const client of [first, second]) {
        await expect
          .poll(() => client.events.find((event) => event.type === "close"))
          .toEqual({
            type: "close",
            code: 1000,
            reason: "Document durable save failed",
          });
        const failureIndex = client.events.findIndex(
          (event) => event.type === "durability_failure",
        );
        expect(failureIndex).toBeGreaterThanOrEqual(0);
        expect(failureIndex).toBeLessThan(
          client.events.findIndex((event) => event.type === "close"),
        );
      }
      expect(harness.saves).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it("adopts a body another writer saved and saves frames on top of it", async () => {
    const harness = await failedSaveHarness();
    try {
      harness.acceptSaves();
      const client = await harness.open("stale_base");
      // A server change lands in the body before the Human's frame is saved.
      const commit = harness.advanceHead();
      appendToFirstText(client.document, " unsaved human edit");
      await expect
        .poll(() => harness.head().persisted_seq)
        .toBe(commit.committed.persisted_seq + 1);
      expect(harness.saves.map((save) => save.baseSeq)).toEqual([
        commit.base.persisted_seq,
        commit.committed.persisted_seq,
      ]);
      await expect
        .poll(
          () =>
            client.events
              .filter((event) => event.type === "durability_ack")
              .reverse()[0]?.head,
        )
        .toEqual(harness.head());
      expect(fingerprintRoomDocumentState(client.document)).toBe(
        harness.head().state_hash,
      );
      expect(
        client.events.some((event) => event.type === "durability_failure"),
      ).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("reopens the same Document in the same Runtime from a higher canonical head", async () => {
    const harness = await failedSaveHarness();
    try {
      const first = await harness.open("reopen_first");
      await harness.fail(first);
      first.provider.destroy();
      await expect.poll(harness.unloaded).toBe(true);
      harness.advanceHead();
      const reopened = await harness.open("reopen_second");
      await expect
        .poll(
          () =>
            reopened.events.find((event) => event.type === "durability_ack")
              ?.head,
        )
        .toEqual(harness.head());
      expect(fingerprintRoomDocumentState(reopened.document)).toBe(
        harness.head().state_hash,
      );
      // A fresh queue accepts new frames; no private resident map inspection.
      harness.acceptSaves();
      appendToFirstText(reopened.document, " new session write");
      await expect.poll(() => harness.head().persisted_seq).toBe(2);
    } finally {
      await harness.close();
    }
  });

  it("writes private replayable failure evidence and content-free release and gauge logs", async () => {
    const log = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const harness = await failedSaveHarness();
    try {
      const client = await harness.open("evidence");
      const updates: Uint8Array[] = [];
      client.document.on("update", (update, origin) => {
        if (origin === null) updates.push(update);
      });
      await harness.fail(client);
      await expect
        .poll(async () => (await readdir(harness.directory)).length)
        .toBe(1);
      const [filename] = await readdir(harness.directory);
      const path = join(harness.directory, filename!);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(harness.directory)).mode & 0o777).toBe(0o700);
      const evidence = JSON.parse(await readFile(path, "utf8"));
      expect(evidence).toMatchObject({
        document_id: documentId,
        failure_code: "append_rejected",
        head: harness.head(),
        pending_bytes: updates[0]!.byteLength,
        runtime_instance_id: "document_runtime_test",
        pending: [
          {
            kind: "mutation",
            actor_id: "actor_evidence",
            update_bytes: updates[0]!.byteLength,
            update_base64: Buffer.from(updates[0]!).toString("base64"),
          },
        ],
      });
      expect(Date.parse(evidence.released_at)).toBeGreaterThanOrEqual(
        Date.parse(evidence.failure_at),
      );
      expect(filename).toBe(`${documentId}-${evidence.failure_at}.json`);
      const recovered = new Y.Doc();
      Y.applyUpdate(recovered, harness.initial.stateBytes);
      Y.applyUpdate(
        recovered,
        Buffer.from(evidence.pending[0].update_base64, "base64"),
      );
      expect(fingerprintRoomDocumentState(recovered)).toBe(
        fingerprintRoomDocumentState(client.document),
      );
      recovered.destroy();
      const records = loggedRecords(log);
      expect(records).toContainEqual(
        expect.objectContaining({
          event: "document_durability_failure_evidence",
          document_id: documentId,
          failure_code: "append_rejected",
          pending_count: 1,
          pending_bytes: updates[0]!.byteLength,
          persisted_seq: 0,
          evidence_path: path,
        }),
      );
      expect(records).toContainEqual(
        expect.objectContaining({
          failed_queue_count: 1,
          failed_queue_bytes: updates[0]!.byteLength,
        }),
      );
      expect(records).toContainEqual(
        expect.objectContaining({
          failed_queue_count: 0,
          failed_queue_bytes: 0,
        }),
      );
      expect(JSON.stringify(records)).not.toContain(
        evidence.pending[0].update_base64,
      );
      expect(JSON.stringify(records)).not.toContain("unsaved client content");
    } finally {
      await harness.close();
      log.mockRestore();
    }
  });

  it("releases and reopens even when the evidence destination is unwritable", async () => {
    const error = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const harness = await failedSaveHarness();
    try {
      // A file in place of the directory fails for privileged CI users too.
      await rmdir(harness.directory);
      await writeFile(harness.directory, "unavailable", { mode: 0o600 });
      const client = await harness.open("unwritable");
      await harness.fail(client);
      await expect
        .poll(() =>
          loggedRecords(error).some(
            (record) =>
              record.event === "document_durability_failure_evidence" &&
              record.level === "error",
          ),
        )
        .toBe(true);
      expect(loggedRecords(error)).toContainEqual(
        expect.objectContaining({
          level: "error",
          document_id: documentId,
          failure_code: "append_rejected",
          write_error: expect.any(String),
        }),
      );
      await expect.poll(harness.unloaded).toBe(true);
      harness.advanceHead();
      const reopened = await harness.open("after_unwritable");
      expect(reopened.events).toContainEqual(
        expect.objectContaining({
          type: "durability_ack",
          head: harness.head(),
        }),
      );
    } finally {
      await harness.close();
      error.mockRestore();
    }
  });

  it("evicts the oldest evidence before exceeding the 256 MiB directory budget", async () => {
    const harness = await failedSaveHarness();
    try {
      for (const [name, size, age] of [
        ["old.json", 256 << 20, 1],
        ["recent.json", 10, 2],
      ] as const) {
        const file = await open(join(harness.directory, name), "w", 0o600);
        await file.truncate(size);
        await file.close();
        await utimes(join(harness.directory, name), age, age);
      }
      await harness.fail(await harness.open("bounded_evidence"));
      await expect
        .poll(async () =>
          (await readdir(harness.directory)).includes("old.json"),
        )
        .toBe(false);
      const files = await readdir(harness.directory);
      expect(files).toContain("recent.json");
      expect(files).toHaveLength(2);
      const sizes = await Promise.all(
        files.map(
          async (name) => (await stat(join(harness.directory, name))).size,
        ),
      );
      expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(256 << 20);
    } finally {
      await harness.close();
    }
  });

  it("rejects new sessions with the original failure code until pending frames finish and unload completes", async () => {
    const harness = await failedSaveHarness({ holdReferenceCheck: true });
    try {
      const first = await harness.open("window_first");
      const second = await harness.open("window_second");
      appendToFirstText(first.document, " unsaved");
      await harness.saveStarted.promise;
      addCommentMarkToFirstText(second.document, "document_thread_delayed");
      await harness.referenceCheckStarted.promise;
      harness.rejectSave.resolve();
      await expect
        .poll(() =>
          first.events.some((event) => event.type === "durability_failure"),
        )
        .toBe(true);
      expect(second.events.some((event) => event.type === "close")).toBe(false);
      await expect(harness.open("window_third")).rejects.toThrow(
        "append_rejected",
      );
      harness.releaseReferenceCheck.resolve();
      await expect
        .poll(async () => (await readdir(harness.directory)).length)
        .toBe(1);
      await expect(harness.open("window_after_unload")).resolves.toBeDefined();
      expect(harness.saves).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it("persists the retained client update when the client resynchronizes after failure", async () => {
    const harness = await failedSaveHarness();
    try {
      const first = await harness.open("replay_first");
      await harness.fail(first);
      await expect
        .poll(async () => (await readdir(harness.directory)).length)
        .toBe(1);
      first.provider.destroy();
      const expected = fingerprintRoomDocumentState(first.document);
      harness.acceptSaves();
      const reopened = await harness.open("replay_second", first.document);
      await expect.poll(() => harness.head().persisted_seq).toBe(1);
      expect(harness.head().state_hash).toBe(expected);
      await expect
        .poll(() =>
          reopened.events.some(
            (event) =>
              event.type === "durability_ack" &&
              event.head?.state_hash === expected,
          ),
        )
        .toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("rechecks and reserves durability after a delayed reference validation", async () => {
    const { bodies } = await memoryBodies();
    let markSaveStarted!: () => void;
    const saveStarted = new Promise<void>((resolve) => {
      markSaveStarted = resolve;
    });
    let rejectSave!: () => void;
    const saveRejected = new Promise<void>((resolve) => {
      rejectSave = resolve;
    });
    let markFailureObserved!: () => void;
    const failureObserved = new Promise<void>((resolve) => {
      markFailureObserved = resolve;
    });
    bodies.beforeCheckReferences = async () => {
      rejectSave();
      await failureObserved;
      return "available" as const;
    };
    bodies.beforeSave = async () => {
      markSaveStarted();
      await saveRejected;
      return { kind: "rejected" };
    };
    const realtime = await startRealtimeServer(bodies);
    const first = await connectRealtimeClient({
      onStateless: (payload) => {
        const envelope = JSON.parse(payload) as { type?: string };
        if (envelope.type === "durability_failure") markFailureObserved();
      },
      token: "reservation_a",
      url: wsUrl(realtime.address),
    });
    const second = await connectRealtimeClient({
      token: "reservation_b",
      url: wsUrl(realtime.address),
    });

    try {
      appendToFirstText(first.document, " first-unsaved");
      await saveStarted;
      const peerBeforeSecondMutation = Y.encodeStateAsUpdate(first.document);

      addCommentMarkToFirstText(second.document, "document_thread_late");
      await waitFor(() => bodies.referenceChecks.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(Y.encodeStateAsUpdate(first.document)).toEqual(
        peerBeforeSecondMutation,
      );
      expect(bodies.saves).toHaveLength(1);
    } finally {
      rejectSave();
      first.provider.destroy();
      second.provider.destroy();
      await realtime.destroy();
    }
  });

  it("rejects a frame before broadcast when the unsaved backlog limit is reached", async () => {
    const { bodies } = await memoryBodies();
    const realtime = await startRealtimeServer(bodies, {
      maxUnsavedBacklogBytes: 1,
    });
    const failures: unknown[] = [];
    const closes: Array<{ code: number; reason: string }> = [];
    const first = await connectRealtimeClient({
      onStateless: (payload) => collectFailure(failures, payload),
      onClose: (event) => closes.push(event),
      token: "backlog_a",
      url: wsUrl(realtime.address),
    });
    const second = await connectRealtimeClient({
      token: "backlog_b",
      url: wsUrl(realtime.address),
    });

    try {
      appendToFirstText(first.document, " rejected");
      await waitFor(() => failures.length === 1);

      expect(failures[0]).toMatchObject({
        code: "backlog_exceeded",
        document_id: documentId,
        type: "durability_failure",
      });
      await expect
        .poll(() => closes[0])
        .toMatchObject({
          code: 1000,
          reason: "Document durable save failed",
        });
      expect(
        readRoomDocumentBlocks(Y.encodeStateAsUpdate(second.document)),
      ).toMatchObject([
        {
          type: "paragraph",
          content: [{ text: "Durable initial state" }],
        },
      ]);
    } finally {
      first.provider.destroy();
      second.provider.destroy();
      await realtime.destroy();
    }
  });

  it("notifies every recipient and rejects later mutations after a save is terminal", async () => {
    const { bodies } = await memoryBodies();
    bodies.beforeSave = () => ({ kind: "rejected" });
    const realtime = await startRealtimeServer(bodies);
    const firstFailures: unknown[] = [];
    const secondFailures: unknown[] = [];
    const first = await connectRealtimeClient({
      onStateless: (payload) => collectFailure(firstFailures, payload),
      token: "failure_a",
      url: wsUrl(realtime.address),
    });
    const second = await connectRealtimeClient({
      onStateless: (payload) => collectFailure(secondFailures, payload),
      token: "failure_b",
      url: wsUrl(realtime.address),
    });

    try {
      appendToFirstText(first.document, " unsaved");
      await waitFor(
        () => firstFailures.length === 1 && secondFailures.length === 1,
      );

      expect(firstFailures[0]).toMatchObject({
        code: "append_rejected",
        document_id: documentId,
        type: "durability_failure",
      });
      expect(secondFailures[0]).toMatchObject({
        code: "append_rejected",
        document_id: documentId,
        type: "durability_failure",
      });

      appendToFirstText(second.document, " blocked");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(bodies.saves).toHaveLength(1);
    } finally {
      first.provider.destroy();
      second.provider.destroy();
      await realtime.destroy();
    }
  });
});

function collectFailure(target: unknown[], payload: string): void {
  const envelope = JSON.parse(payload) as { type?: string };
  if (envelope.type === "durability_failure") {
    target.push(envelope);
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for permanent save failure");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
