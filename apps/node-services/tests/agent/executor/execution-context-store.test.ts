import { rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  encodeExecutionContextRef,
  type ExecutionContextRef,
  type ExecutionContextStore,
} from "../../../src/agent/executor/context-ref.js";
import { createInMemoryExecutionContextStore } from "../test-support/in-memory-execution-context-store.js";

const directories: string[] = [];
const stores: ExecutionContextStore[] = [];

afterEach(async () => {
  await Promise.allSettled(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe.each([
  ["memory", () => createInMemoryExecutionContextStore()],
] as const)("ExecutionContextStore (%s)", (_name, createStore) => {
  it("idempotently ensures Context identity without overwriting residency", async () => {
    const store = createStore();
    stores.push(store);
    const ref = meta("agent-1");

    await expect(store.ensure(ref)).resolves.toEqual({
      created: true,
      record: { ref, roomKind: "collaboration", targetResidency: "active" },
    });
    await store.setTargetResidency(ref, "suspended");
    await expect(store.ensure(ref, "active")).resolves.toEqual({
      created: false,
      record: { ref, roomKind: "collaboration", targetResidency: "suspended" },
    });
  });

  it("lists stable canonical records by Agent and removes them as a group", async () => {
    const store = createStore();
    stores.push(store);
    const first = meta("agent-1");
    const second = alterEgo("agent-1", "task-1");
    const other = meta("agent-2");
    await store.ensure(second);
    await store.ensure(other);
    await store.ensure(first);

    await expect(store.listByAgent("agent-1")).resolves.toEqual(
      [second, first].sort(byCanonicalKey).map((ref) => ({
        ref,
        ...(ref.kind === "meta" ? { roomKind: "collaboration" } : {}),
        targetResidency: "active",
      })),
    );
    await expect(store.removeByAgent("agent-1")).resolves.toBe(2);
    await expect(store.list()).resolves.toEqual([
      { ref: other, roomKind: "collaboration", targetResidency: "active" },
    ]);
  });
});

const meta = (agentId: string): ExecutionContextRef => ({
  kind: "meta",
  agentId,
  roomId: "room-1",
});

const alterEgo = (agentId: string, taskId: string): ExecutionContextRef => ({
  kind: "alter_ego",
  agentId,
  taskId,
});

const byCanonicalKey = (
  left: ExecutionContextRef,
  right: ExecutionContextRef,
): number =>
  encodeExecutionContextRef(left).localeCompare(
    encodeExecutionContextRef(right),
  );
