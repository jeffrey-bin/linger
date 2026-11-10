import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { DocumentDurabilityCoordinator } from "../../src/document/realtime-durability.js";
import { DocumentFailureEvidenceStore } from "../../src/document/failure-evidence.js";
import { installDocumentRuntimeDOM } from "../../src/document/server-dom.js";
import {
  documentBodyStore,
  documentFixture,
} from "./document-state-test-support.js";
import { appendToFirstText } from "./realtime-test-support.js";
import { deferred } from "./realtime-failure-test-support.js";

beforeAll(() => installDocumentRuntimeDOM());

async function fixture() {
  const value = await documentFixture();
  const directory = await mkdtemp(join(tmpdir(), "failed-durability-"));
  const bodies = documentBodyStore();
  const save = vi.fn(bodies.save);
  bodies.save = save;
  const load = vi.fn(bodies.load);
  bodies.load = load;
  const durability = new DocumentDurabilityCoordinator({
    bodies,
    maxUnsavedBacklogBytes: 1024,
    failureEvidence: new DocumentFailureEvidenceStore({
      directory,
      runtimeInstanceId: "runtime_unit",
    }),
  });
  durability.registerDocument({
    documentId: value.head.document_id,
    head: value.head,
    stateBytes: value.state.stateBytes,
    references: { document_asset_ids: [], document_thread_ids: [] },
  });
  const doc = new Y.Doc();
  Y.applyUpdate(doc, value.state.stateBytes);
  const vector = Y.encodeStateVector(doc);
  appendToFirstText(doc, " pending");
  const connection = {};
  durability.reserveMutation({
    connection,
    documentId: value.head.document_id,
    update: Y.encodeStateAsUpdate(doc, vector),
    actorId: "actor_unit",
  });
  durability.recordAppliedMutation({
    connection,
    documentId: value.head.document_id,
  });
  doc.destroy();
  return {
    ...value,
    directory,
    save,
    load,
    durability,
    async close() {
      durability.releaseDocument(value.head.document_id);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

it("short-circuits failed flushes with the original code and retains evidence on release", async () => {
  const f = await fixture();
  try {
    f.save.mockResolvedValue({ kind: "rejected" });
    await expect(f.durability.flush(f.head.document_id)).rejects.toMatchObject({
      failureCode: "append_rejected",
    });
    await expect(f.durability.flush(f.head.document_id)).rejects.toMatchObject({
      failureCode: "append_rejected",
    });
    expect(f.save).toHaveBeenCalledOnce();
    expect(() =>
      f.durability.registerDocument({
        documentId: f.head.document_id,
        head: f.head,
        stateBytes: f.state.stateBytes,
        references: { document_asset_ids: [], document_thread_ids: [] },
      }),
    ).toThrow("append_rejected");
    f.durability.releaseDocument(f.head.document_id);
    expect(f.durability.hasDocument(f.head.document_id)).toBe(false);
    expect(await readdir(f.directory)).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it("retains an in-flight failed queue until its save settles", async () => {
  const f = await fixture();
  const gate = deferred();
  try {
    f.save.mockImplementation(async () => {
      await gate.promise;
      return { kind: "rejected" };
    });
    const flushing = f.durability.flush(f.head.document_id);
    const rejected = expect(flushing).rejects.toMatchObject({
      failureCode: "append_rejected",
    });
    expect(() =>
      f.durability.assertWritable(f.head.document_id, 2048),
    ).toThrow();
    f.durability.releaseDocument(f.head.document_id);
    expect(f.durability.hasDocument(f.head.document_id)).toBe(true);
    expect(await readdir(f.directory)).toHaveLength(0);
    gate.resolve();
    await rejected;
    await expect(f.durability.flush(f.head.document_id)).rejects.toMatchObject({
      failureCode: "backlog_exceeded",
    });
    f.durability.releaseDocument(f.head.document_id);
    expect(f.durability.hasDocument(f.head.document_id)).toBe(false);
    expect(await readdir(f.directory)).toHaveLength(1);
    expect(f.save).toHaveBeenCalledOnce();
  } finally {
    gate.resolve();
    await f.close();
  }
});

it("fails with append_rejected when a stale save finds no newer body", async () => {
  const f = await fixture();
  try {
    f.save.mockResolvedValue({ kind: "stale" });
    f.load.mockResolvedValue({
      permissionCount: 0,
      seq: f.head.persisted_seq,
      state: f.state.stateBytes,
      stateVector: f.state.stateVector,
      assetIds: [],
      threadIds: [],
    });
    await expect(f.durability.flush(f.head.document_id)).rejects.toMatchObject({
      failureCode: "append_rejected",
    });
    expect(f.save).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

it("does not start another save when failure occurs during a successful in-flight commit", async () => {
  const f = await fixture();
  const gate = deferred();
  try {
    f.save.mockImplementation(async (request) => {
      await gate.promise;
      return { kind: "saved", seq: request.baseSeq + 1 };
    });
    const flushing = f.durability.flush(f.head.document_id);
    const rejected = expect(flushing).rejects.toMatchObject({
      failureCode: "backlog_exceeded",
    });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, f.state.stateBytes);
    const vector = Y.encodeStateVector(doc);
    appendToFirstText(doc, " second pending");
    const connection = {};
    f.durability.reserveMutation({
      connection,
      documentId: f.head.document_id,
      update: Y.encodeStateAsUpdate(doc, vector),
      actorId: "actor_unit",
    });
    f.durability.recordAppliedMutation({
      connection,
      documentId: f.head.document_id,
    });
    doc.destroy();
    expect(() =>
      f.durability.assertWritable(f.head.document_id, 2048),
    ).toThrow();
    gate.resolve();
    await rejected;
    expect(f.save).toHaveBeenCalledOnce();
  } finally {
    gate.resolve();
    await f.close();
  }
});

it.each(["request", "backoff"])(
  "does not retry a save after permanent failure during %s",
  async (phase) => {
    const f = await fixture();
    const gate = deferred();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      f.save.mockImplementationOnce(async () => {
        await gate.promise;
        throw new Error("connection reset");
      });
      f.save.mockImplementation(async (request) => ({
        kind: "saved",
        seq: request.baseSeq + 1,
      }));
      const rejected = expect(
        f.durability.flush(f.head.document_id),
      ).rejects.toMatchObject({ failureCode: "backlog_exceeded" });
      if (phase === "backoff") {
        gate.resolve();
        await vi.waitUntil(() => vi.getTimerCount() === 1, { interval: 1 });
      }
      expect(() =>
        f.durability.assertWritable(f.head.document_id, 2048),
      ).toThrow("backlog_exceeded");
      gate.resolve();
      await vi.runAllTimersAsync();
      await rejected;
      expect(f.save).toHaveBeenCalledOnce();
      f.durability.releaseDocument(f.head.document_id);
      expect(f.durability.hasDocument(f.head.document_id)).toBe(false);
      expect(await readdir(f.directory)).toHaveLength(1);
    } finally {
      gate.resolve();
      vi.useRealTimers();
      await f.close();
    }
  },
);
