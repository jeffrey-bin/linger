import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  ContextRuntimeActivationRequest,
  ContextRuntimeActivator,
} from "../../../src/agent/executor/activation.js";
import {
  createTeamHubContextRuntimeState,
  type ExecutionResources,
} from "../../../src/agent/executor/context-runtime-state.js";
import {
  TeamHubRuntimeStateError,
  type RuntimeSession,
  type TeamHubRuntimeStateClient,
} from "../../../src/agent/executor/teamhub-runtime-state-client.js";
import { createStandaloneExecutor } from "../test-support/standalone-executor.js";
import {
  ProviderRunStartError,
  type AgentProvider,
  type ExecutionSpec,
} from "../../../src/agent/executor/provider.js";
import { createTeamHubRuntimeStateClientFake } from "../test-support/teamhub-runtime-state-client.js";
import { createTestFeatureAssembly } from "../test-support/executor-features.js";

const ref = {
  kind: "meta",
  agentId: "agent-recovery",
  roomId: "room-1",
} as const;
const contextKey = JSON.stringify(["meta", ref.agentId, "room", "room-1"]);
interface TestRuntime {
  type: "test";
}
type StoredRun = Awaited<ReturnType<TeamHubRuntimeStateClient["getRun"]>>;
type Checkpoint = Parameters<
  TeamHubRuntimeStateClient["checkpointSession"]
>[0]["checkpoint"];

describe("Agent resource versions across Runs", () => {
  it("keeps a retried Run's resources and refreshes the next Run with history", async () => {
    const original: ExecutionResources = {
      version: 1,
      effectiveSha256: "a".repeat(64),
      skills: [
        {
          skillId: "skill-old",
          manifestId: "manifest-old",
          manifestVersion: "1.0.0",
          name: "Retained skill",
          packageName: "retained-skill",
          packageSha256: "d".repeat(64),
          config: { language: "zh" },
          source: "explicit",
        },
      ],
    };
    const harness = await createHarness();
    try {
      const updated = harness.current;
      harness.current = original;
      harness.enqueue("run-first");
      let firstAttempt = true;
      harness.beforeProviderStart = () => {
        // Starting a Run writes nothing; resources ride on the Session.
        expect(harness.stored).toBeNull();
        if (firstAttempt) {
          firstAttempt = false;
          harness.current = updated;
          throw new ProviderRunStartError(
            "definitely_not_started",
            "retry before native creation",
          );
        }
      };
      await harness.shell.start();
      await vi.waitFor(() =>
        expect(harness.runs.get("run-first")?.status).toBe("succeeded"),
      );
      expect(harness.activations).toHaveLength(1);
      expect(harness.activations[0]).toMatchObject({ mode: "start" });
      expect(harness.starts.map(({ resources }) => resources)).toEqual([
        original,
        original,
      ]);
      expect(harness.runs.get("run-first")?.attempt_count).toBe(2);
      expect(harness.stored?.session).toEqual({
        nativeSession: { threadId: "native-history" },
        executionResources: original,
      });

      harness.beforeProviderStart = undefined;
      harness.enqueue("run-next");
      harness.shell.notifyWorkAvailable();
      await vi.waitFor(() =>
        expect(harness.runs.get("run-next")?.status).toBe("succeeded"),
      );
      expect(harness.activations).toHaveLength(2);
      expect(harness.activations[1]).toMatchObject({
        mode: "resume",
        previousSession: { threadId: "native-history" },
      });
      expect(harness.starts.at(-1)?.resources).toEqual(harness.current);
      expect(harness.stored).toMatchObject({
        thread_id: "native-history",
        session: {
          nativeSession: { threadId: "native-history" },
          executionResources: {
            effectiveSha256: harness.current.effectiveSha256,
          },
        },
      });
    } finally {
      await harness.close();
    }
  });

  it.each(["recover", "stop"])(
    "handles a transient TeamHub claim failure while reporting replacement load failure: %s",
    async (action) => {
      const harness = await createHarness();
      try {
        await harness.shell.start();
        harness.failReplacement = true;
        harness.current = {
          ...harness.current,
          effectiveSha256: "c".repeat(64),
        };
        let failClaim = true;
        harness.beforeClaim = () => {
          if (harness.activations.length >= 3 && failClaim) {
            failClaim = false;
            throw new TeamHubRuntimeStateError(
              503,
              "temporary TeamHub failure",
              "UNAVAILABLE",
              true,
            );
          }
        };
        harness.enqueue("run-bad-config");
        harness.shell.notifyWorkAvailable();
        await vi.waitFor(() => expect(failClaim).toBe(false));
        if (action === "stop") {
          await harness.shell.stop();
          expect(harness.runs.get("run-bad-config")).toMatchObject({
            status: "queued",
            attempt_count: 0,
          });
          expect(harness.starts).toHaveLength(0);
          return;
        }
        await vi.waitFor(
          () =>
            expect(harness.runs.get("run-bad-config")).toMatchObject({
              status: "failed",
              terminal: { type: "failed", error: "Skill package unavailable" },
            }),
          { timeout: 3000 },
        );
        expect(harness.starts).toHaveLength(0);
        expect(harness.runs.get("run-bad-config")?.attempt_count).toBe(1);
      } finally {
        await harness.close();
      }
    },
  );
});

async function createHarness() {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "agent-resources-recovery-"),
  );
  let stored: RuntimeSession | null = null;
  const runs = new Map<string, StoredRun>();
  const activations: ContextRuntimeActivationRequest<TestRuntime>[] = [];
  const starts: { resources: ExecutionResources; spec: ExecutionSpec }[] = [];
  const save = (checkpoint: Checkpoint): RuntimeSession => {
    stored = {
      ...structuredClone(checkpoint),
      revision: String(Number(stored?.revision ?? 0) + 1),
      updated_at: "2026-10-14T00:00:00Z",
    };
    return structuredClone(stored);
  };
  const client = createTeamHubRuntimeStateClientFake({
    getContext: async () => ({
      context_key: contextKey,
      ref: { kind: "meta", agent_id: ref.agentId, room_id: ref.roomId },
      tenant_id: "tenant-test",
      agent_actor_id: "actor-agent",
      target_residency: "active",
      state_revision: "1",
      next_input_sequence: "1",
    }),
    getWorkState: async () => ({
      has_pending_work: [...runs.values()].some(
        (run) => run.status === "queued" || run.status === "running",
      ),
      has_queued_runs: [...runs.values()].some(
        (run) => run.status === "queued",
      ),
    }),
    getSession: async () =>
      stored
        ? { available: true, session: structuredClone(stored) }
        : { available: false },
    checkpointSession: async ({ checkpoint }) => save(checkpoint),
    getRun: async (_key, id) => structuredClone(runs.get(id)!),
    claimRun: async () => {
      harness.beforeClaim?.();
      const run = [...runs.values()].find((entry) => entry.status === "queued");
      if (!run) return { claimed: false };
      run.status = "running";
      run.attempt_count++;
      return {
        claimed: true,
        run: {
          ...structuredClone(run),
          continues_context: false,
          inputs: [
            {
              input_id: `input-${run.run_id}`,
              sequence: "1",
              source_kind: "inbox" as const,
              status: "handled" as const,
              payload: {
                messageId: `input-${run.run_id}`,
                rawMessage: "execute",
                segments: [{ type: "text", content: "execute" }],
              },
            },
          ],
        },
      };
    },
    requeueRun: async ({ run_id }) => {
      runs.get(run_id)!.status = "queued";
      return { success: true };
    },
    finishRun: async ({ run_id, terminal, session }) => {
      const run = runs.get(run_id)!;
      run.status = terminal.type;
      run.terminal = terminal;
      return {
        run: structuredClone(run),
        ...(session ? { session: save(session) } : {}),
      };
    },
  });
  const activator: ContextRuntimeActivator<TestRuntime> = {
    async activate(request) {
      activations.push(request);
      if (harness.failReplacement && activations.length > 1)
        throw new Error("Skill package unavailable");
      const resources = harness.current;
      const runtimeSession = (request.previousSession ?? { threadId: "" }) as {
        threadId: string;
      };
      const provider: AgentProvider = {
        async createSession() {
          return runtimeSession;
        },
        async resumeSession() {
          return runtimeSession;
        },
        async startRun(_session, _input, spec) {
          starts.push({ resources, spec });
          harness.beforeProviderStart?.(spec);
          runtimeSession.threadId ||= "native-history";
          return {
            events: (async function* () {})(),
            async wait() {
              return { finalResponse: "done" };
            },
            cancel() {},
          };
        },
        async steer() {
          return { turnId: "unused" };
        },
        async close() {},
      };
      return {
        ref,
        provider,
        runtimeName: "test",
        runtimeSession,
        executionResources: resources,
        async prepareNextRun() {
          return resources.effectiveSha256 === harness.current.effectiveSha256;
        },
        sessionSpec: {
          workingDirectory: root,
          threadName: "Recovery",
          sandboxMode: "workspace-write",
          resources: { mcpServers: [] },
        },
        setActiveRunContext() {},
        async deactivate() {
          await provider.close();
        },
      };
    },
  };
  const shell = await createStandaloneExecutor<TestRuntime>({
    activator,
    stateFactory: async () =>
      createTeamHubContextRuntimeState({
        client,
        ref,
        configurationRevision: "1",
        providerKind: "codex",
      }),
    options: {
      ref,
      actorId: "actor-agent",
      tenantId: "tenant-test",
      agent: { name: "Recovery", instructions: "test" },
      runtime: { type: "test" },
      resources: { skills: [], mcpServers: [] },
      features: createTestFeatureAssembly({
        ref,
        actorId: "actor-agent",
      }).ports,
    },
  });
  const harness = {
    shell,
    runs,
    activations,
    starts,
    current: {
      version: 1,
      effectiveSha256: "b".repeat(64),
      skills: [],
    } as ExecutionResources,
    failReplacement: false,
    beforeProviderStart: undefined as
      | ((spec: ExecutionSpec) => void)
      | undefined,
    beforeClaim: undefined as (() => void) | undefined,
    get stored() {
      return stored;
    },
    enqueue(id: string, attemptCount = 0) {
      runs.set(id, {
        run_id: id,
        context_key: contextKey,
        status: "queued",
        attempt_count: attemptCount,
        initial_input_ids: [`input-${id}`],
        steer_input_ids: [],
      });
    },
    async close() {
      await shell.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
  return harness;
}
