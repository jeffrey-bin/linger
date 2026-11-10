import { describe, expect, it, vi } from "vitest";
import {
  composeActivationFeatures,
  composeContextFeatures,
} from "../../../../src/agent/agent-features/compose.js";
import {
  AGENT_MEMORY_FEATURE_ID,
  createAgentMemoryFeature,
  type AgentMemoryFeatureDeps,
} from "../../../../src/agent/agent-features/agent-memory/feature.js";
import {
  makeTestActivationView,
  makeTestFeatureContext,
  makeTestMessage,
} from "../fixtures.js";

const deps = (
  overrides: Partial<AgentMemoryFeatureDeps> = {},
): AgentMemoryFeatureDeps => ({
  agentMemory: {
    recordRun: vi.fn(async () => {}),
    wake: vi.fn(async () => {}),
  },
  agentMemoryProjection: {
    prepare: vi.fn(async () => ({
      summary: "memory summary",
      mapping: {
        kind: "memory" as const,
        sourcePath: "/generations/rev-1",
        targetPath: "/workspace/agent-memory",
        access: "read_only" as const,
      },
    })),
  },
  ...overrides,
});

describe("createAgentMemoryFeature context scope", () => {
  it("counts succeeded Meta Runs with the shared coordinator, even while stopping", async () => {
    const feature = createAgentMemoryFeature(deps());
    expect(feature.id).toBe(AGENT_MEMORY_FEATURE_ID);
    const recordRun = vi.fn(async () => {});
    const wake = vi.fn(async () => {});
    const { context, scope } = makeTestFeatureContext();
    const composed = composeContextFeatures({
      context,
      features: [
        createAgentMemoryFeature(deps({ agentMemory: { recordRun, wake } })),
      ],
    });
    try {
      expect(composed.matched).toEqual([AGENT_MEMORY_FEATURE_ID]);
      composed.onRunTerminal({
        runId: "run-1",
        terminal: { type: "succeeded" },
      });
      expect(recordRun).toHaveBeenCalledWith(context.ref.agentId);
      // The host invalidates the bound instance (signal) and releases
      // sources; observer ports keep dispatching during shutdown so
      // terminal forwarding is preserved.
      scope.abort();
      await composed.release();
      composed.onRunTerminal({
        runId: "run-2",
        terminal: { type: "succeeded" },
      });
      expect(recordRun).toHaveBeenCalledTimes(2);
      expect(wake).not.toHaveBeenCalled();
    } finally {
      await composed.release();
    }
  });

  it("does not count failed or canceled terminals", async () => {
    const recordRun = vi.fn(async () => {});
    const { context } = makeTestFeatureContext();
    const composed = composeContextFeatures({
      context,
      features: [
        createAgentMemoryFeature(
          deps({ agentMemory: { recordRun, wake: vi.fn(async () => {}) } }),
        ),
      ],
    });
    try {
      composed.onRunTerminal({
        runId: "run-1",
        terminal: { type: "failed", error: "boom" },
      });
      composed.onRunTerminal({
        runId: "run-2",
        terminal: { type: "canceled" },
      });
      expect(recordRun).not.toHaveBeenCalled();
    } finally {
      await composed.release();
    }
  });

  it("does not count Runs of a Context whose history it never reads", async () => {
    const recordRun = vi.fn(async () => {});
    const { context } = makeTestFeatureContext({
      ref: { kind: "alter_ego", agentId: "agent-1", taskId: "task-1" },
    });
    const composed = composeContextFeatures({
      context,
      features: [
        createAgentMemoryFeature(
          deps({ agentMemory: { recordRun, wake: vi.fn(async () => {}) } }),
        ),
      ],
    });
    try {
      composed.onRunTerminal({
        runId: "run-1",
        terminal: { type: "succeeded" },
      });
      expect(recordRun).not.toHaveBeenCalled();
    } finally {
      await composed.release();
    }
  });

  it("wakes when a compaction starts, without waiting for its outcome", async () => {
    const wake = vi.fn(() => new Promise<void>(() => {}));
    const { context } = makeTestFeatureContext();
    const composed = composeContextFeatures({
      context,
      features: [
        createAgentMemoryFeature(
          deps({ agentMemory: { recordRun: vi.fn(async () => {}), wake } }),
        ),
      ],
    });
    const trigger = { kind: "idle_suspend" } as const;
    const action = { kind: "compact", reason: "test" } as const;
    try {
      composed.onMaintenance({ phase: "started", trigger, action });
      expect(wake).toHaveBeenCalledExactlyOnceWith(context.ref.agentId);
      composed.onMaintenance({
        phase: "finished",
        trigger,
        action,
        outcome: { status: "completed" },
      });
      expect(wake).toHaveBeenCalledOnce();
    } finally {
      await composed.release();
    }
  });
});

describe("createAgentMemoryFeature activation scope", () => {
  it("maps the published files", async () => {
    const memoryDeps = deps();
    const composed = composeActivationFeatures({
      view: makeTestActivationView(),
      features: [createAgentMemoryFeature(memoryDeps)],
    });
    try {
      expect(composed.matched).toEqual([AGENT_MEMORY_FEATURE_ID]);
      const preparation = await composed.prepare({
        signal: new AbortController().signal,
      });
      expect(memoryDeps.agentMemoryProjection.prepare).toHaveBeenCalledWith(
        "agent-1",
        expect.any(AbortSignal),
      );
      expect(preparation.runtimeViewMappings).toEqual([
        {
          kind: "memory",
          sourcePath: "/generations/rev-1",
          targetPath: "/workspace/agent-memory",
          access: "read_only",
        },
      ]);
    } finally {
      await composed.release();
    }
  });
});

describe("createAgentMemoryFeature memory note", () => {
  const trigger = { kind: "idle_suspend" } as const;
  const action = { kind: "compact", reason: "test" } as const;
  // One declaration serves both scopes, as the builtin assembly binds it.
  const setup = () => {
    let published: string | undefined;
    const feature = createAgentMemoryFeature(
      deps({
        agentMemoryProjection: {
          prepare: vi.fn(async () =>
            published === undefined ? {} : { summary: published },
          ),
        },
      }),
    );
    const bind = () => {
      const { context, scope } = makeTestFeatureContext();
      const composed = composeContextFeatures({ context, features: [feature] });
      return {
        input: (messageId: string) =>
          composed.prepareInput({ ...makeTestMessage("hello"), messageId })
            .rawMessage,
        compacted: (status: "completed" | "skipped") =>
          composed.onMaintenance({
            phase: "finished",
            trigger,
            action,
            outcome:
              status === "completed"
                ? { status }
                : { status, reason: "input_arrived" },
          }),
        release: async () => {
          scope.abort();
          await composed.release();
        },
      };
    };
    const activate = async (
      summary: string | undefined,
      newSession: boolean,
    ) => {
      published = summary;
      const activation = composeActivationFeatures({
        view: makeTestActivationView(),
        features: [feature],
      });
      await activation.prepare({
        signal: new AbortController().signal,
        newSession,
      });
      await activation.release();
    };
    return { bind, activate };
  };

  it("appends the summary to the first input of a new Session only", async () => {
    const { bind, activate } = setup();
    const context = bind();
    await activate("A index", true);
    const first = context.input("m-1");
    expect(first).toMatch(/^hello\n\n<agent_memory>\n/u);
    expect(first).toContain("<summary>\nA index\n</summary>");
    // A replayed input renders the same note.
    expect(context.input("m-1")).toBe(first);
    expect(context.input("m-2")).toBe("hello");
    // A publication reaches the next activation, but not the conversation.
    await activate("B index", false);
    expect(context.input("m-3")).toBe("hello");
    await context.release();
  });

  it("appends the latest summary once after a completed compaction", async () => {
    const { bind, activate } = setup();
    const context = bind();
    await activate("A index", true);
    context.input("m-1");
    context.compacted("skipped");
    await activate("B index", false);
    expect(context.input("m-2")).toBe("hello");
    context.compacted("completed");
    await activate("C index", false);
    const note = context.input("m-3");
    expect(note).toContain("<summary>\nC index\n</summary>");
    expect(note).not.toContain("B index");
    expect(context.input("m-4")).toBe("hello");
    await context.release();
  });

  it("keeps an empty snapshot until the Session restarts or compacts", async () => {
    const { bind, activate } = setup();
    const context = bind();
    await activate(undefined, true);
    expect(context.input("m-1")).toBe("hello");
    await activate("A index", false);
    expect(context.input("m-2")).toBe("hello");
    context.compacted("completed");
    await activate("A index", false);
    expect(context.input("m-3")).toContain("A index");
    await context.release();
  });

  it("does not repeat the summary when a restored Context resumes its Session", async () => {
    const { bind, activate } = setup();
    const before = bind();
    await activate("A index", true);
    expect(before.input("m-1")).toContain("A index");
    await before.release();
    const restored = bind();
    await activate("B index", false);
    expect(restored.input("m-2")).toBe("hello");
    // A replaced Session starts a new conversation, which gets the summary.
    await activate("B index", true);
    expect(restored.input("m-3")).toContain("B index");
    await restored.release();
  });
});
