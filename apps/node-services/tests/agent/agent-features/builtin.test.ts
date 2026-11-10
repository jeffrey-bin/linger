import { describe, expect, it, vi } from "vitest";

import { createAgentMemoryServices } from "../../../src/agent/agent-features/agent-memory/index.js";
import { createUserMemoryTracker } from "../../../src/agent/agent-features/user-memory/index.js";
import { createBuiltinAgentFeatures } from "../../../src/agent/agent-features/builtin.js";
import { AGENT_FEATURE_MODULES } from "../../../src/agent/agent-features/catalog.generated.js";
import { EMOJI_REACTION_INSTRUCTIONS } from "../../../src/agent/agent-features/emoji-reaction/index.js";
import type { FeatureContext } from "../../../src/agent/agent-features/contracts.js";
import type {
  BuiltinFeatureHost,
  BuiltinRunBackend,
} from "../../../src/agent/agent-features/host-ports.js";
import type { InboxSourceHost } from "../../../src/agent/agent-features/inbox-source/index.js";
import type {
  RunWakeTarget,
  RunWakeTargetRegistrar,
} from "../../../src/agent/agent-features/inbox-source/types.js";
import type { AgentLogger } from "../../../src/agent/observability/agent-log.js";
import type { AgentInput } from "../../../src/agent/executor/provider.js";
import {
  makeTestActivationView,
  makeTestFeatureContext,
  makeTestMessage,
  testMetaRef,
} from "./fixtures.js";

const logger = (): AgentLogger => {
  const value: AgentLogger = { log: vi.fn(), child: () => value };
  return value;
};

const registrar = () => {
  const registered: RunWakeTarget[] = [];
  const registerTarget: RunWakeTargetRegistrar["registerTarget"] = vi.fn(
    (target: RunWakeTarget) => {
      registered.push(target);
      return { stop: vi.fn() };
    },
  );
  return { registered, registerTarget };
};

const inboxHost = (): InboxSourceHost => ({
  takeUpQueuedInput: vi.fn(),
});

const hostPorts = (inbox?: InboxSourceHost) => {
  const trackBackground = vi.fn();
  const timers = { set: vi.fn(), clear: vi.fn() };
  const host: BuiltinFeatureHost = {
    ...(inbox ? { inbox } : {}),
    trackBackground,
    timers,
  };
  return { host, trackBackground, timers };
};

const flashbackClient = () => ({
  suggest: vi.fn(async () => ({ reason: "no_cue" as const })),
  record: vi.fn(async () => undefined),
});

const fullServices = () => ({
  logger: logger(),
  runWakes: registrar(),
  flashback: {
    client: flashbackClient(),
    settings: {
      claimWaitMs: 0,
      followUpMinScore: 0.6,
      followUpWindowMs: 60_000,
    },
  },
  proactive: {
    client: {
      window: vi.fn(async () => undefined),
      finish: vi.fn(async () => true),
      queueWake: vi.fn(async () => undefined),
    },
  },
  taskProgress: {
    client: {
      read: vi.fn(async () => ({ live_foreground: false, tasks: [] })),
    },
  },
  agentMemory: {
    agentMemory: {
      recordRun: vi.fn(async () => undefined),
      wake: vi.fn(async () => undefined),
    },
    agentMemoryProjection: {
      prepare: vi.fn(async () => ({ summary: "memory summary" })),
    },
  },
  contextRestart: {},
  resolveUserMemory: vi.fn(async () => ({ version: 3, markdown: "# Memory" })),
  userMemories: createUserMemoryTracker(),
  replyRhythm: {
    settings: {
      activationRate: 1,
      enabled: true,
      maxMessageCount: 4,
      minMessageCount: 2,
      version: "v1",
    },
  },
});

const boundContext = (
  overrides: Parameters<typeof makeTestFeatureContext>[0] = {},
): { context: FeatureContext; scope: AbortController } =>
  makeTestFeatureContext({
    roomKind: "collaboration",
    runtime: { type: "codex" },
    identity: {
      actorId: "agent-actor",
      agentType: "anotherme",
      representedHuman: { actorId: "human_1", displayName: "Leo" },
      sponsor: { actorId: "sponsor-1", displayName: "Sponsor" },
    },
    ...overrides,
  });

const ownerFact = (inputId: string) => ({
  inboxId: "room:room-1",
  inputId,
  targeted: true,
  messages: [
    {
      sequence: 1n,
      messageId: inputId,
      sender: { actorId: "human_1", type: "user" as const },
      segments: [{ type: "text" as const, content: "How did it go?" }],
      disposition: "notify" as const,
      mentioned: false,
    },
  ],
});

const input = (text: string): AgentInput => ({ type: "text", text });

describe("createBuiltinAgentFeatures", () => {
  it("considers every generated manifest module across the binding stages", () => {
    const builtin = createBuiltinAgentFeatures({ services: fullServices() });
    const { host } = hostPorts(inboxHost());
    // Every manifest module is covered exactly once: service/context-bound
    // declarations plus run-bound task-input.
    const covered = [
      ...builtin.contextDeclarations(host).map((d) => d.id),
      ...builtin.activationDeclarations.map((d) => d.id),
      ...builtin.runDeclarations({}).map((d) => d.id),
      ...builtin
        .runDeclarations({ prepareRunInput: async (x: AgentInput) => x })
        .map((d) => d.id),
    ];
    expect([...new Set(covered)].sort()).toEqual(
      Object.keys(AGENT_FEATURE_MODULES).sort(),
    );
  });

  it("assembles only the required modules when optional capabilities are absent", () => {
    const builtin = createBuiltinAgentFeatures({
      services: { logger: logger() },
    });
    const { context } = boundContext({
      identity: {
        actorId: "agent-actor",
        agentType: "general",
        sponsor: { actorId: "sponsor-1", displayName: "Sponsor" },
      },
      capabilities: [],
    });
    const composed = builtin.composeContext({
      context,
      host: hostPorts().host,
    });
    expect([...composed.matched].sort()).toEqual([
      "context-instructions",
      "emoji-reaction",
      "notification-context",
      "run-status",
    ]);
    expect(
      composed.contextInstructions({
        connectedApps: true,
        compactInstructions: false,
      }),
    ).not.toContain("<tool-approval-protocol>");
    expect(builtin.activationDeclarations).toEqual([]);
  });

  it("teaches the tool approval protocol only with a permission judge", () => {
    const builtin = createBuiltinAgentFeatures({
      services: { logger: logger() },
    });
    const instructions = (
      capabilities: FeatureContext["capabilities"],
      ref: FeatureContext["ref"],
    ) => {
      const composed = builtin.composeContext({
        context: boundContext({ capabilities, ref }).context,
        host: hostPorts().host,
      });
      return {
        matched: composed.matched.includes("tool-approval"),
        text:
          composed.contextInstructions({
            connectedApps: true,
            compactInstructions: false,
          }) ?? "",
      };
    };
    const meta = instructions(["permissionReview"], testMetaRef);
    expect(meta.matched).toBe(true);
    // The protocol closes the Context's own instructions, before emoji guidance.
    expect(meta.text.indexOf("</tool-approval-protocol>")).toBeLessThan(
      meta.text.indexOf(EMOJI_REACTION_INSTRUCTIONS),
    );
    expect(instructions([], testMetaRef).matched).toBe(false);
    expect(
      instructions(["permissionReview"], {
        kind: "document",
        agentId: "agent-1",
        documentId: "document-1",
      }).matched,
    ).toBe(false);
  });

  it("leaves out Another Me features whose services are absent", async () => {
    const services = fullServices();
    const builtin = createBuiltinAgentFeatures({
      services: {
        logger: services.logger,
        runWakes: services.runWakes,
        flashback: services.flashback,
        agentMemory: services.agentMemory,
        resolveUserMemory: services.resolveUserMemory,
      },
    });
    const { context } = boundContext();
    const composed = builtin.composeContext({
      context,
      host: hostPorts(inboxHost()).host,
    });
    expect(composed.matched).toContain("flashback");
    for (const id of ["auto-reaction", "proactive", "reply-rhythm"])
      expect(composed.matched).not.toContain(id);
    await composed.release();
  });

  it("fails loudly when a configured feature misses a required capability", () => {
    const builtin = createBuiltinAgentFeatures({
      services: { logger: logger(), runWakes: registrar() },
    });
    const { context } = boundContext();
    expect(() =>
      builtin.composeContext({ context, host: hostPorts().host }),
    ).toThrow(/host\.inbox/);
    const malformed = createBuiltinAgentFeatures({
      services: {
        logger: logger(),
        flashback: { client: {} as never },
      },
    });
    expect(() =>
      malformed.composeContext({ context, host: hostPorts().host }),
    ).toThrow(/flashback/);
  });

  it("wires the required contribution ports through one composed catalog", async () => {
    const builtin = createBuiltinAgentFeatures({ services: fullServices() });
    const { context } = boundContext();
    const { host } = hostPorts(inboxHost());
    const composed = builtin.composeContext({ context, host });

    expect(composed.matched).toEqual(
      expect.arrayContaining([
        "agent-memory",
        "context-instructions",
        "emoji-reaction",
        "flashback",
        "inbox-source",
        "notification-context",
        "reply-rhythm",
        "run-status",
      ]),
    );
    // Required context instructions for a room-bound Meta Context.
    expect(
      composed.contextInstructions({
        connectedApps: true,
        compactInstructions: false,
      }),
    ).toContain("## Who you are");
    expect(
      composed.contextInstructions({
        connectedApps: true,
        compactInstructions: false,
      }),
    ).toContain("teamhub message emoji <message-id> <emoji>");
    // The run-status projection is wired.
    expect(
      composed.onRunEvent({ type: "status.changed", status: "working" }),
    ).toEqual([{ type: "status.changed", status: "working" }]);

    // reply-rhythm always offers at activationRate 1; the prompt-domain
    // merger must place its contribution before the notification sentinel.
    const sentinel =
      "Use the messages shown above when they provide enough context.";
    const merged = composed.prepareInput(
      makeTestMessage(`shown messages\n\n${sentinel}\nmore`),
    );
    const body = merged.rawMessage;
    expect(body.indexOf(sentinel)).toBeGreaterThan(-1);
    expect(body.slice(0, body.indexOf(sentinel))).toContain("reply-rhythm");
    await composed.release();
  });

  it("shares service-level capabilities while per-Context state stays isolated", async () => {
    const services = fullServices();
    const { host, trackBackground } = hostPorts(inboxHost());
    const builtin = createBuiltinAgentFeatures({ services });
    const first = builtin.composeContext({ ...boundContext(), host });
    const second = builtin.composeContext({ ...boundContext(), host });
    // The same host serves both Contexts; declarations rebind per Context
    // without duplicating shared services.
    await first.bindSources({ bootstrap: "new" });
    await second.bindSources({ bootstrap: "new" });

    // One shared registrar receives one target per bound Context.
    expect(services.runWakes.registerTarget).toHaveBeenCalledTimes(2);
    first.afterInboxInputAccepted(ownerFact("in-1"));
    first.afterInboxInputAccepted(ownerFact("in-1"));
    const firstOperations = vi.mocked(trackBackground).mock.calls.length;
    for (const [operation] of vi.mocked(trackBackground).mock.calls)
      await operation;
    // Session dedup is per bound Context: the replay did not recall again.
    expect(services.flashback.client.suggest).toHaveBeenCalledTimes(1);

    second.afterInboxInputAccepted(ownerFact("in-1"));
    for (const [operation] of vi
      .mocked(trackBackground)
      .mock.calls.slice(firstOperations))
      await operation;
    expect(services.flashback.client.suggest).toHaveBeenCalledTimes(2);
    await first.release();
    await second.release();
  });

  it("prepares activation contributions from the shared services only", async () => {
    const services = fullServices();
    const builtin = createBuiltinAgentFeatures({ services });
    const composed = builtin.composeActivation({
      view: makeTestActivationView(),
    });
    expect(composed.matched).toEqual(
      expect.arrayContaining(["agent-memory", "user-memory"]),
    );
    const signal = new AbortController().signal;
    const prepared = await composed.prepare({ signal });
    expect(prepared.developerInstructions).toEqual([
      expect.stringContaining('<user-memory version="3">'),
    ]);
    expect(prepared.checks).toHaveLength(1);
    expect(
      services.agentMemory.agentMemoryProjection.prepare,
    ).toHaveBeenCalledWith("agent-1", expect.any(AbortSignal));
    await composed.release();
  });

  it("binds run declarations to each activation's backend, never an older one", async () => {
    const builtin = createBuiltinAgentFeatures({ services: fullServices() });
    const signal = new AbortController().signal;
    const backendA: BuiltinRunBackend = {
      async prepareRunInput(current) {
        return { ...current, text: `A:${current.text}` };
      },
    };
    const backendB: BuiltinRunBackend = {
      async prepareRunInput(current) {
        return { ...current, text: `B:${current.text}` };
      },
    };
    const runA = builtin.composeRun({
      view: makeTestActivationView(),
      backend: backendA,
    });
    const runB = builtin.composeRun({
      view: makeTestActivationView(),
      backend: backendB,
    });
    expect(runA.matched).toEqual(["task-input"]);
    expect(runB.matched).toEqual(["task-input"]);
    await expect(runA.prepareRunInput(input("x"), signal)).resolves.toEqual(
      input("A:x"),
    );
    // A later activation binds its own backend; the earlier one is untouched.
    await expect(runB.prepareRunInput(input("x"), signal)).resolves.toEqual(
      input("B:x"),
    );
    const runC = builtin.composeRun({
      view: makeTestActivationView(),
      backend: {},
    });
    expect(runC.matched).toEqual([]);
    await expect(runC.prepareRunInput(input("x"), signal)).resolves.toEqual(
      input("x"),
    );
  });

  it("propagates the shared Memory services' late start() binding loudly", async () => {
    const services = createAgentMemoryServices({
      memory: { read: vi.fn(), commit: vi.fn() },
      contextHost: { ensureAgentRoots: vi.fn() },
      runtimeState: {} as never,
      logger: logger(),
    });
    const builtin = createBuiltinAgentFeatures({
      services: { logger: logger(), agentMemory: services.featureDeps },
    });
    expect(builtin.activationDeclarations.map((d) => d.id)).toContain(
      "agent-memory",
    );
    // A missed start() throws instead of quietly disabling wake-ups.
    expect(() => services.featureDeps.agentMemory.wake("agent-1")).toThrow(
      /not started/,
    );
    services.start({ getGhost: async () => null } as never);
    await services.featureDeps.agentMemory.wake("agent-1");
    await services.close();
  });
});
