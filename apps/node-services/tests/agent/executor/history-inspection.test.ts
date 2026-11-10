import { createPersistedHistoryInspector } from "../../../src/agent/executor/application.js";
import { describe, expect, it } from "vitest";
import { parseRuntimeSettings } from "../../../src/agent/runtime-settings.js";

describe("Runtime settings", () => {
  it("requires a Local placement", () => {
    for (const runtime of [
      {},
      { type: "codex", model: "gpt-test" },
      { type: "claude", model: "claude-sonnet-5", reasoningEffort: "high" },
    ]) {
      expect(() => parseRuntimeSettings(runtime)).toThrow();
    }
  });

  it("parses Local placements", () => {
    expect(
      parseRuntimeSettings({
        type: "local",
        placement: {
          type: "local",
          tenantId: "tenant-acme",
          ownerActorId: "actor-alice",
          computerId: "computer-a",
          runtimeType: "pi",
          workspaceGrantId: "grant-a",
          assignmentRevision: 1,
        },
      }),
    ).toMatchObject({ type: "local" });
    expect(
      parseRuntimeSettings({
        type: "codex",
        model: "gpt-local",
        placement: {
          type: "local",
          tenantId: "tenant-acme",
          ownerActorId: "actor-alice",
          computerId: "computer-a",
          runtimeType: "codex",
          workspaceGrantId: "grant-a",
          assignmentRevision: 1,
        },
      }),
    ).toMatchObject({ type: "local", model: "gpt-local" });
  });
});

describe("Persisted Runtime history", () => {
  const localRequest = {
    ref: {
      kind: "meta" as const,
      agentId: "agent-local-history",
      roomId: "room-1",
    },
    runtime: {
      type: "local" as const,
      placement: {
        type: "local" as const,
        tenantId: "tenant-acme",
        ownerActorId: "actor-alice",
        computerId: "computer-a",
        runtimeType: "codex" as const,
        workspaceGrantId: "grant-a",
        assignmentRevision: 1,
      },
    },
    session: { threadId: "thread-local" },
    options: {},
  };

  it("reports History unsupported without a detached Runner Gateway reader", async () => {
    await expect(
      createPersistedHistoryInspector(undefined)(localRequest),
    ).resolves.toMatchObject({ status: "unsupported", providerKind: "codex" });
  });
});
