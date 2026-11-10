import * as agentLog from "../../../src/agent/observability/agent-log.js";
import { describe, expect, it, vi } from "vitest";

import {
  createTeamHubContextRuntimeState,
  earliestInputReceivedAtMs,
} from "../../../src/agent/executor/context-runtime-state.js";
import {
  encodeExecutionContextRef,
  type ExecutionContextRef,
} from "../../../src/agent/executor/context-ref.js";
import {
  TeamHubRuntimeStateError,
  type RuntimeContext,
  type RuntimeSession,
  type TeamHubRuntimeStateClient,
} from "../../../src/agent/executor/teamhub-runtime-state-client.js";
import type { Message } from "../../../src/agent/executor/types.js";
import { createTeamHubRuntimeStateClientFake } from "../test-support/teamhub-runtime-state-client.js";

describe("TeamHub Context Runtime state", () => {
  it.each(["trusted", "steer"] as const)(
    "retains the %s acceptance baseline across refresh failure and retry, but not a restart",
    async (kind) => {
      const clock = vi.spyOn(performance, "now").mockReturnValue(1);
      let failRefresh = false;
      const input = {
        input_id: "latency-input",
        sequence: "1",
        source_kind: "trusted_turn" as const,
        status: "handled" as const,
        payload: message("latency-input") as unknown as Record<string, unknown>,
      };
      const accepted = () => {
        clock.mockReturnValue(100);
      };
      const overrides: Parameters<
        typeof createTeamHubRuntimeStateClientFake
      >[0] = {
        submitTrustedTurn: async () => {
          accepted();
          return { run_id: "run-1", created: true };
        },
        enqueueSteer: async () => {
          accepted();
          return { run_id: "run-1" };
        },
        claimRun: async () => ({
          claimed: true,
          run: {
            run_id: "run-1",
            attempt_count: 1,
            inputs: [input],
            continues_context: false,
          },
        }),
        requeueRun: async () => ({ success: true }),
        finishRun: async () => ({ run: terminalRun("succeeded") }),
        cancelRun: async () => ({ status: "canceled" }),
        getWorkState: async () => {
          clock.mockReturnValue(500);
          if (failRefresh) {
            failRefresh = false;
            throw new TeamHubRuntimeStateError(503, "refresh unavailable");
          }
          return {
            has_pending_work: true,
            has_queued_runs: true,
          };
        },
      };
      const fixture = await terminalFixture(overrides);
      clock.mockReturnValue(1);
      const accept = async () => {
        if (kind === "steer")
          return fixture.state.enqueueSteer("steer-1", [
            message("latency-input"),
          ]);
        return fixture.state.enqueueTrustedTurn([message("latency-input")]);
      };
      try {
        expect(
          (await fixture.state.claimLocalRun())?.acceptedAtMonotonicMs,
        ).toBeUndefined();
        // enqueueSteer still re-reads work after its commit; trusted commits
        // already carry the authoritative result.
        if (kind === "steer") {
          failRefresh = true;
          await expect(accept()).rejects.toThrow("refresh unavailable");
        } else await accept();
        expect(
          (await fixture.state.claimLocalRun())?.acceptedAtMonotonicMs,
        ).toBe(100);
        clock.mockReturnValue(900);
        await fixture.state.requeueLocalRun("run-1");
        expect(
          (await fixture.state.claimLocalRun())?.acceptedAtMonotonicMs,
        ).toBe(100);
        await fixture.state.finishLocalRun("run-1", { type: "succeeded" });
        expect(
          (await fixture.state.claimLocalRun())?.acceptedAtMonotonicMs,
        ).toBeUndefined();
        await accept();
        await fixture.state.cancelLocalRun("run-1");
        expect(
          (await fixture.state.claimLocalRun())?.acceptedAtMonotonicMs,
        ).toBeUndefined();
        await accept();
        await fixture.state.close();
        const recovered = await terminalFixture(overrides);
        try {
          expect(
            (await recovered.state.claimLocalRun())?.acceptedAtMonotonicMs,
          ).toBeUndefined();
        } finally {
          await recovered.state.close();
        }
      } finally {
        await fixture.state.close();
        clock.mockRestore();
      }
    },
  );

  it.each([
    { replayCreated: false, terminal: false },
    { replayCreated: false, terminal: true },
    { replayCreated: undefined, terminal: false },
  ])(
    "does not recreate an acceptance baseline for trusted replay (created=$replayCreated, terminal=$terminal)",
    async ({ replayCreated, terminal }) => {
      const clock = vi.spyOn(performance, "now").mockReturnValue(100);
      let created: boolean | undefined = true;
      const overrides = {
        submitTrustedTurn: async () => ({ run_id: "run-1", created }),
        claimRun: async () => ({
          claimed: true,
          run: {
            run_id: "run-1",
            attempt_count: 1,
            continues_context: false,
            inputs: [
              {
                input_id: "trusted-replay",
                sequence: "1",
                source_kind: "trusted_turn" as const,
                status: "handled" as const,
                payload: message("trusted-replay") as unknown as Record<
                  string,
                  unknown
                >,
              },
            ],
          },
        }),
        finishRun: async () => ({ run: terminalRun("succeeded") }),
      };
      const fixture = await terminalFixture(overrides);
      const inputs = [message("trusted-replay")] as const;
      try {
        await fixture.state.enqueueTrustedTurn(inputs);
        created = replayCreated;
        clock.mockReturnValue(900);
        await fixture.state.enqueueTrustedTurn(inputs);
        expect(
          (await fixture.state.claimLocalRun())?.acceptedAtMonotonicMs,
        ).toBe(100);
        if (terminal) {
          await fixture.state.finishLocalRun("run-1", { type: "succeeded" });
          await fixture.state.enqueueTrustedTurn(inputs);
          expect(
            (await fixture.state.claimLocalRun())?.acceptedAtMonotonicMs,
          ).toBeUndefined();
        }
        await fixture.state.close();

        const recovered = await terminalFixture(overrides);
        try {
          // Reposting historical input after restart must not invent a start.
          await recovered.state.enqueueTrustedTurn(inputs);
          expect(
            (await recovered.state.claimLocalRun())?.acceptedAtMonotonicMs,
          ).toBeUndefined();
        } finally {
          await recovered.state.close();
        }
      } finally {
        await fixture.state.close();
        clock.mockRestore();
      }
    },
  );

  it("checkpoints loaded resources with the first native Session and preserves them across terminal checkpoints", async () => {
    let stored: RuntimeSession | null = null;
    const resources = {
      version: 1 as const,
      effectiveSha256: "a".repeat(64),
      skills: [
        {
          skillId: "skill-1",
          manifestId: "manifest-1",
          manifestVersion: "1.2.3",
          name: "test-skill",
          packageName: "test-skill",
          packageSha256: "b".repeat(64),
          config: { language: "zh" },
          source: "explicit" as const,
        },
      ],
    };
    const save = (
      checkpoint: Parameters<
        TeamHubRuntimeStateClient["checkpointSession"]
      >[0]["checkpoint"],
    ) => {
      stored = {
        ...checkpoint,
        revision: String(Number(stored?.revision ?? "0") + 1),
        updated_at: "2026-10-14T00:00:00.000Z",
      };
      return structuredClone(stored);
    };
    const getSession = vi.fn<TeamHubRuntimeStateClient["getSession"]>(
      async () =>
        stored
          ? { available: true, session: structuredClone(stored) }
          : { available: false },
    );
    const fixture = await terminalFixture({
      getSession,
      checkpointSession: async ({ checkpoint }) => save(checkpoint),
      finishRun: async ({ session }) => ({
        run: terminalRun("succeeded"),
        ...(session ? { session: save(session) } : {}),
      }),
    });
    // Loading resources writes nothing; they ride on the first checkpoint.
    fixture.state.setExecutionResources(resources);
    expect(stored).toBeNull();
    expect(fixture.state.getExecutionResources()).toEqual(resources);
    await fixture.state.setRuntimeSession({ threadId: "thread-first" });
    expect(stored).toMatchObject({
      expected_revision: "0",
      schema_version: "2",
      thread_id: "thread-first",
      session: {
        nativeSession: { threadId: "thread-first" },
        executionResources: resources,
      },
    });
    await expect(fixture.state.getRuntimeSession()).resolves.toEqual({
      threadId: "thread-first",
    });
    await fixture.state.finishLocalRun(
      "run-1",
      { type: "succeeded" },
      { threadId: "thread-final" },
    );
    expect(stored).toMatchObject({
      thread_id: "thread-final",
      session: {
        nativeSession: { threadId: "thread-final" },
        executionResources: resources,
      },
    });
    await fixture.state.close();
  });

  it("upgrades a legacy session with exact resources in one checkpoint and restores both independently", async () => {
    let stored: RuntimeSession = {
      expected_revision: "1",
      revision: "1",
      schema_version: "1",
      configuration_revision: "1",
      provider_kind: "codex",
      thread_id: "thread-legacy",
      session: { threadId: "thread-legacy" },
      updated_at: "2026-10-14T00:00:00.000Z",
    };
    const checkpointSession = vi.fn<
      TeamHubRuntimeStateClient["checkpointSession"]
    >(async ({ checkpoint }) => {
      stored = {
        ...checkpoint,
        revision: "2",
        updated_at: stored.updated_at,
      };
      return structuredClone(stored);
    });
    const overrides = {
      getSession: async () => ({
        available: true,
        session: structuredClone(stored),
      }),
      checkpointSession,
    };
    const first = await terminalFixture(overrides);
    expect(await first.state.getExecutionResources()).toBeNull();
    await expect(first.state.getRuntimeSession()).resolves.toEqual({
      threadId: "thread-legacy",
    });
    const resources = {
      version: 1 as const,
      effectiveSha256: "c".repeat(64),
      skills: [],
    };
    await first.state.setRuntimeSession(
      { threadId: "thread-legacy" },
      resources,
    );
    expect(checkpointSession).toHaveBeenCalledOnce();
    expect(stored).toMatchObject({
      schema_version: "2",
      thread_id: "thread-legacy",
    });
    await first.state.close();
    const resumed = await terminalFixture(overrides);
    await expect(resumed.state.getRuntimeSession()).resolves.toEqual({
      threadId: "thread-legacy",
    });
    expect(await resumed.state.getExecutionResources()).toEqual(resources);
    await resumed.state.close();
  });

  it("restores and clears a resources-only checkpoint without fabricating native history", async () => {
    const resources = {
      version: 1 as const,
      effectiveSha256: "a".repeat(64),
      skills: [],
    };
    let stored: RuntimeSession | null = {
      expected_revision: "0",
      revision: "1",
      schema_version: "2",
      configuration_revision: "1",
      provider_kind: "codex",
      session: { nativeSession: null, executionResources: resources },
      updated_at: "2026-10-14T00:00:00.000Z",
    };
    const clearSession = vi.fn<TeamHubRuntimeStateClient["clearSession"]>(
      async () => {
        stored = null;
        return { cleared: true };
      },
    );
    const fixture = await terminalFixture({
      getSession: async () =>
        stored
          ? { available: true, session: structuredClone(stored) }
          : { available: false },
      clearSession,
    });
    await expect(fixture.state.getRuntimeSession()).resolves.toBeNull();
    await expect(fixture.state.getRuntimeSession()).resolves.toBeNull();
    expect(await fixture.state.getExecutionResources()).toEqual(resources);
    await expect(fixture.state.clearRuntimeSession()).resolves.toBe(true);
    expect(await fixture.state.getExecutionResources()).toBeNull();
    await expect(fixture.state.clearRuntimeSession()).resolves.toBe(false);
    expect(clearSession).toHaveBeenCalledOnce();
    await fixture.state.close();
  });

  it("explicitly clears direct resource metadata while retaining native history for an activation without exact resources", async () => {
    const resources = {
      version: 1 as const,
      effectiveSha256: "a".repeat(64),
      skills: [],
    };
    let stored: RuntimeSession = {
      expected_revision: "4",
      revision: "5",
      schema_version: "2",
      configuration_revision: "1",
      provider_kind: "codex",
      thread_id: "thread-old",
      session: {
        nativeSession: { threadId: "thread-old" },
        executionResources: resources,
      },
      updated_at: "2026-10-14T00:00:00.000Z",
    };
    const fixture = await terminalFixture({
      getSession: async () => ({
        available: true,
        session: structuredClone(stored),
      }),
      checkpointSession: async ({ checkpoint }) => {
        stored = {
          ...checkpoint,
          revision: "6",
          updated_at: stored.updated_at,
        };
        return structuredClone(stored);
      },
    });
    await fixture.state.setRuntimeSession({ threadId: "thread-old" }, null);
    expect(stored).toMatchObject({
      schema_version: "1",
      thread_id: "thread-old",
      session: { threadId: "thread-old" },
    });
    expect(stored.session).not.toHaveProperty("executionResources");
    expect(await fixture.state.getExecutionResources()).toBeNull();
    await expect(fixture.state.getRuntimeSession()).resolves.toEqual({
      threadId: "thread-old",
    });
    await fixture.state.close();
  });

  it("reads independent session and work state concurrently on initialization", async () => {
    let sessionRead = false;
    const client = createTeamHubRuntimeStateClientFake({
      getContext: async () => context("suspended"),
      getWorkState: async () => {
        await vi.waitFor(() => expect(sessionRead).toBe(true));
        return {
          has_pending_work: false,
          has_queued_runs: false,
        };
      },
      getSession: async () => {
        sessionRead = true;
        return { available: false };
      },
    });
    const state = await createTeamHubContextRuntimeState({
      client,
      ref: { kind: "meta", agentId: "agent-reviewer", roomId: "room-1" },
      configurationRevision: "1",
      providerKind: "codex",
    });
    await expect(state.getRuntimeSession()).resolves.toBeNull();
    await state.close();
  });

  it("keeps a hinted queued Run while an older work-state read is in flight", async () => {
    let finishRead!: (value: {
      has_pending_work: boolean;
      has_queued_runs: boolean;
    }) => void;
    let reads = 0;
    const client = createTeamHubRuntimeStateClientFake({
      getContext: async () => context("suspended"),
      getWorkState: () =>
        ++reads === 1
          ? Promise.resolve({ has_pending_work: false, has_queued_runs: false })
          : new Promise((resolve) => {
              finishRead = resolve;
            }),
      getSession: async () => ({ available: false }),
    });
    const state = await createTeamHubContextRuntimeState({
      client,
      ref: { kind: "meta", agentId: "agent-reviewer", roomId: "room-1" },
      configurationRevision: "1",
      providerKind: "codex",
    });
    try {
      const refreshing = state.refreshWorkState!();
      await vi.waitFor(() => expect(finishRead).toBeDefined());
      // A run.queued hint proves a Run TeamHub queued with its Message.
      state.noteQueuedRun!();
      // The read was answered before the commit; it must not hide the Run
      // the execution loop now claims without reading work state again.
      finishRead({ has_pending_work: false, has_queued_runs: false });
      await refreshing;
      expect(state.hasQueuedRuns()).toBe(true);
      expect(state.hasPendingWork()).toBe(true);
    } finally {
      await state.close();
    }
  });

  it.each([true, false])(
    "reports whether a claimed Run continues earlier Context input (%s)",
    async (continues) => {
      const fixture = await terminalFixture({
        claimRun: async () => ({
          claimed: true,
          run: {
            run_id: "run-1",
            attempt_count: 1,
            continues_context: continues,
            inputs: [
              {
                input_id: "input-1",
                sequence: "40",
                source_kind: "inbox" as const,
                status: "handled" as const,
                payload: message("input-1") as unknown as Record<
                  string,
                  unknown
                >,
              },
            ],
          },
        }),
      });
      try {
        expect((await fixture.state.claimLocalRun())?.continuesContext).toBe(
          continues,
        );
      } finally {
        await fixture.state.close();
      }
    },
  );

  it("hands each Message steer of a work-state read out once", async () => {
    const steer = (groupId: string, runId?: string) => ({
      input_id: `input-${groupId}`,
      sequence: "9",
      source_kind: "inbox" as const,
      source_inbox_id: "room:one",
      status: "steering" as const,
      steer_group_id: groupId,
      ...(runId ? { local_run_id: runId } : {}),
      payload: message(`input-${groupId}`) as unknown as Record<
        string,
        unknown
      >,
    });
    let steers = [steer("steer-1"), steer("steer-2", "run-1")];
    const fixture = await terminalFixture({
      getWorkState: async () => ({
        has_pending_work: true,
        has_queued_runs: false,
        message_steers: steers,
      }),
    });
    try {
      await fixture.state.refreshWorkState!();
      expect(
        fixture.state.takeMessageSteers!().map(
          ({ groupId, runId, inboxId, inputId }) => ({
            groupId,
            runId,
            inboxId,
            inputId,
          }),
        ),
      ).toEqual([
        {
          groupId: "steer-1",
          runId: undefined,
          inboxId: "room:one",
          inputId: "input-steer-1",
        },
        {
          groupId: "steer-2",
          runId: "run-1",
          inboxId: "room:one",
          inputId: "input-steer-2",
        },
      ]);
      // A later read that still lists them does not hand them out again.
      await fixture.state.refreshWorkState!();
      expect(fixture.state.takeMessageSteers!()).toEqual([]);
      steers = [steer("steer-3")];
      await fixture.state.refreshWorkState!();
      expect(
        fixture.state.takeMessageSteers!().map(({ groupId }) => groupId),
      ).toEqual(["steer-3"]);
    } finally {
      await fixture.state.close();
    }
  });

  it("returns durable trusted notification and trusted turn facts when the post-commit work-state read fails", async () => {
    let committed = false;
    const getWorkState = vi.fn(async () => {
      if (committed) throw new Error("post-commit refresh must not run");
      return {
        has_pending_work: false,
        has_queued_runs: false,
      };
    });
    const fixture = await terminalFixture({
      getWorkState,
      acceptTrustedNotification: async () => {
        committed = true;
        return {
          status: "committed" as const,
          steer_group_id: "steer-trusted",
        };
      },
      submitTrustedTurn: async () => {
        committed = true;
        return { run_id: "trusted-run", created: true };
      },
    });
    try {
      await expect(
        fixture.state.acceptTrustedNotification(
          "run-1",
          message("trusted-note"),
        ),
      ).resolves.toEqual({
        status: "committed",
        groupId: "steer-trusted",
      });
      expect(fixture.state.hasPendingWork()).toBe(true);
      expect(fixture.state.hasQueuedRuns()).toBe(false);

      await expect(
        fixture.state.enqueueTrustedTurn([message("trusted-turn")]),
      ).resolves.toBe("trusted-run");
      expect(fixture.state.hasQueuedRuns()).toBe(true);
      expect(fixture.state.hasPendingWork()).toBe(true);
      // The only work-state read was the initial snapshot; committed results
      // carry their own authoritative facts.
      expect(getWorkState).toHaveBeenCalledOnce();
    } finally {
      await fixture.state.close();
    }
  });

  it("propagates durable commit rejections instead of reporting acceptance", async () => {
    const fixture = await terminalFixture({
      acceptTrustedNotification: async () => {
        throw new TeamHubRuntimeStateError(409, "trusted accept rejected");
      },
      submitTrustedTurn: async () => {
        throw new TeamHubRuntimeStateError(409, "turn submit rejected");
      },
    });
    try {
      await expect(
        fixture.state.acceptTrustedNotification(
          "run-1",
          message("trusted-reject"),
        ),
      ).rejects.toThrow("trusted accept rejected");
      await expect(
        fixture.state.enqueueTrustedTurn([message("turn-reject")]),
      ).rejects.toThrow("turn submit rejected");
      expect(fixture.state.hasPendingWork()).toBe(false);
      expect(fixture.state.hasQueuedRuns()).toBe(false);
    } finally {
      await fixture.state.close();
    }
  });

  it("cancels the TeamHub turn identified by an immutable trusted Message", async () => {
    const submitTrustedTurn = vi.fn(async () => ({
      run_id: "stable-trusted-run",
    }));
    const cancelRun = vi.fn(async () => ({ status: "canceled" as const }));
    const fixture = await terminalFixture({ submitTrustedTurn, cancelRun });
    try {
      const inputs = [message("trusted-cancel")] as const;
      await expect(fixture.state.cancelTrustedTurn(inputs)).resolves.toEqual({
        runId: "stable-trusted-run",
        status: "canceled",
      });
      expect(submitTrustedTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          inputs: [
            expect.objectContaining({
              input_id: "trusted-cancel",
              source_kind: "trusted_turn",
            }),
          ],
        }),
      );
      expect(cancelRun).toHaveBeenCalledWith(
        expect.objectContaining({
          run_id: "stable-trusted-run",
        }),
      );
      expect(submitTrustedTurn.mock.invocationCallOrder[0]).toBeLessThan(
        cancelRun.mock.invocationCallOrder[0]!,
      );
    } finally {
      await fixture.state.close();
    }
  });

  it("persists a trusted notification against the active Local Run", async () => {
    const acceptTrustedNotification = vi.fn(async () => ({
      status: "committed" as const,
      steer_group_id: "steer-profile",
    }));
    const fixture = await terminalFixture({ acceptTrustedNotification });
    try {
      await expect(
        fixture.state.acceptTrustedNotification(
          "run-1",
          message("profile-initialized"),
        ),
      ).resolves.toEqual({ status: "committed", groupId: "steer-profile" });
      expect(acceptTrustedNotification).toHaveBeenCalledWith({
        context_key: '["meta","agent-reviewer","room","room-1"]',
        epoch: fixture.client.epoch,
        execution_run_ref: "run-1",
        input: expect.objectContaining({
          input_id: "profile-initialized",
          source_kind: "internal",
        }),
      });
    } finally {
      await fixture.state.close();
    }
  });

  it.each([
    ["active", "1"],
    ["suspended", "1"],
    ["active", "2"],
    ["suspended", "2"],
  ] as const)(
    "clears an old %s schema %s Runtime Session when activation refreshes the revision",
    async (targetResidency, schemaVersion) => {
      let sessionAvailable = true;
      const clearSession = vi.fn(async () => {
        sessionAvailable = false;
        return { cleared: true };
      });
      const client = createTeamHubRuntimeStateClientFake({
        getContext: async () => context(targetResidency),
        getWorkState: async () => ({
          has_pending_work: true,
          has_queued_runs: true,
        }),
        getSession: async () =>
          sessionAvailable
            ? {
                available: true,
                session: {
                  expected_revision: "0",
                  provider_kind: "codex",
                  schema_version: schemaVersion,
                  session:
                    schemaVersion === "1"
                      ? { threadId: "thread-old" }
                      : {
                          nativeSession: null,
                          executionResources: {
                            version: 1,
                            effectiveSha256: "a".repeat(64),
                            skills: [],
                          },
                        },
                  configuration_revision: "1",
                  revision: "1",
                  updated_at: "2026-01-01T00:00:00.000Z",
                },
              }
            : { available: false },
        clearSession,
      });

      const state = await createTeamHubContextRuntimeState({
        client,
        ref: { kind: "meta", agentId: "agent-reviewer", roomId: "room-1" },
        configurationRevision: "2",
        providerKind: "codex",
      });
      // Materialization alone is read-only: Debug inspection keeps reading the
      // last checkpointed session until the Context is activated again.
      expect(clearSession).not.toHaveBeenCalled();
      await expect(state.getRuntimeSession()).resolves.toEqual(
        schemaVersion === "1"
          ? {
              threadId: "thread-old",
            }
          : null,
      );

      await expect(state.discardStaleRuntimeSession!()).resolves.toBe(true);
      expect(clearSession).toHaveBeenCalledWith({
        context_key: '["meta","agent-reviewer","room","room-1"]',
        epoch: client.epoch,
        configuration_revision: "1",
        expected_current_configuration_revision: "2",
      });
      await expect(state.getRuntimeSession()).resolves.toBeNull();
      expect(await state.getExecutionResources()).toBeNull();
      await expect(state.discardStaleRuntimeSession!()).resolves.toBe(false);
      expect(clearSession).toHaveBeenCalledTimes(1);
      expect(state.hasPendingWork()).toBe(true);
      expect(state.hasQueuedRuns()).toBe(true);
      await state.close();
    },
  );

  it.each(["codex", "claude"])(
    "preserves a cold %s Session after proven profile initialization and checkpoints the loaded revision",
    async (providerKind) => {
      let persisted: RuntimeSession = {
        expected_revision: "7",
        revision: "7",
        provider_kind: providerKind,
        schema_version: "1",
        configuration_revision: "1",
        updated_at: "2026-10-12T16:29:24.000Z",
        thread_id: "thread-before-profile",
        session: {
          threadId: "thread-before-profile",
          sandboxNativeCheckpoint: { generation: "sealed-before-restart" },
        },
      };
      let reads = 0;
      const clearSession = vi.fn(async () => ({ cleared: true }));
      const checkpointSession = vi.fn<
        TeamHubRuntimeStateClient["checkpointSession"]
      >(async (body) => {
        persisted = {
          ...body.checkpoint,
          revision: "8",
          updated_at: "2026-10-12T18:35:00.000Z",
        };
        return persisted;
      });
      const fixture = await profileRecoveryFixture(providerKind, {
        getSession: async () => ({
          available: true,
          session: {
            ...persisted,
            // Initialization may observe a Session before its proof is ready.
            // Activation must refresh the server observation.
            ...(++reads > 1 ? { compatible_configuration_revision: "2" } : {}),
          },
        }),
        clearSession,
        checkpointSession,
      });
      try {
        await expect(fixture.state.discardStaleRuntimeSession!()).resolves.toBe(
          false,
        );
        const resumed = await fixture.state.getRuntimeSession();
        expect(resumed).toEqual(persisted.session);
        expect(clearSession).not.toHaveBeenCalled();
        expect(checkpointSession).not.toHaveBeenCalled();
        await fixture.state.setRuntimeSession(resumed);
        expect(checkpointSession).toHaveBeenCalledWith(
          expect.objectContaining({
            epoch: fixture.client.epoch,
            checkpoint: expect.objectContaining({
              expected_revision: "7",
              configuration_revision: "2",
              provider_kind: providerKind,
              thread_id: "thread-before-profile",
              session: resumed,
            }),
          }),
        );
        expect(persisted.revision).toBe("8");
      } finally {
        await fixture.state.close();
      }
    },
  );

  it("preserves the checkpoint when the proof refresh or a raced automatic clear fails", async () => {
    const persisted: RuntimeSession = {
      expected_revision: "7",
      revision: "7",
      provider_kind: "codex",
      schema_version: "1",
      configuration_revision: "1",
      updated_at: "2026-10-12T16:29:24.000Z",
      thread_id: "thread-before-profile",
      session: { threadId: "thread-before-profile" },
    };
    const getSession = vi.fn<TeamHubRuntimeStateClient["getSession"]>(
      async () => ({ available: true, session: persisted }),
    );
    const conflict = new TeamHubRuntimeStateError(409, "configuration changed");
    const clearSession = vi.fn(async () => {
      throw conflict;
    });
    const fixture = await profileRecoveryFixture("codex", {
      getSession,
      clearSession,
    });
    try {
      getSession.mockRejectedValueOnce(new Error("proof unavailable"));
      await expect(fixture.state.discardStaleRuntimeSession!()).rejects.toThrow(
        "proof unavailable",
      );
      expect(clearSession).not.toHaveBeenCalled();
      await expect(fixture.state.discardStaleRuntimeSession!()).rejects.toBe(
        conflict,
      );
      expect(clearSession).toHaveBeenCalledWith(
        expect.objectContaining({
          configuration_revision: "1",
          expected_current_configuration_revision: "2",
        }),
      );
      await expect(fixture.state.getRuntimeSession()).resolves.toEqual(
        persisted.session,
      );
    } finally {
      await fixture.state.close();
    }
  });

  it.each(["succeeded", "failed", "canceled"] as const)(
    "retries the same %s terminal after a prolonged outage and lost acknowledgement",
    async (type) => {
      vi.useFakeTimers();
      const log = vi
        .spyOn(agentLog, "logAgentEvent")
        .mockImplementation(() => undefined);
      const calls: unknown[] = [];
      let attempts = 0;
      const fixture = await terminalFixture({
        finishRun: async (body) => {
          calls.push(structuredClone(body));
          if (++attempts <= 5)
            throw new TeamHubRuntimeStateError(null, "connection refused");
          if (attempts === 6)
            throw new TeamHubRuntimeStateError(
              null,
              "committed but response lost",
            );
          return { run: terminalRun(type) };
        },
      });
      try {
        const terminal =
          type === "failed" ? { type, error: "provider HTTP 400" } : { type };
        const completion = fixture.state.finishLocalRun("run-1", terminal);
        const assertion = expect(completion).resolves.toBeUndefined();
        void assertion.catch(() => undefined);
        await vi.runAllTimersAsync();
        await assertion;
        expect(calls).toHaveLength(7);
        const requests = log.mock.calls.filter(
          ([, event]) => event === "local_run.finish_requested",
        );
        const acknowledgements = log.mock.calls.filter(
          ([, event]) => event === "local_run.finish_acknowledged",
        );
        expect(requests).toHaveLength(7);
        expect(acknowledgements).toHaveLength(1);
        for (const [index, [, , fields]] of requests.entries()) {
          expect(fields).toEqual({
            runId: "run-1",
            writeAttempt: index + 1,
            resultCode: type,
            observedAtUnixMs: expect.any(Number),
          });
        }
        expect(acknowledgements[0]?.[2]).toEqual({
          ...requests[6]?.[2],
          observedAtUnixMs: expect.any(Number),
        });
        expect(JSON.stringify(log.mock.calls)).not.toContain(
          "provider HTTP 400",
        );
        expect(
          calls.every(
            (body) => JSON.stringify(body) === JSON.stringify(calls[0]),
          ),
        ).toBe(true);
        expect(calls[0]).toMatchObject({
          terminal,
          epoch: fixture.client.epoch,
        });
      } finally {
        log.mockRestore();
        await fixture.state.close();
        vi.useRealTimers();
      }
    },
  );

  it("recovers a checkpoint read before committing the terminal", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const finishRun = vi.fn(
      async (
        _body: Parameters<
          ReturnType<typeof createTeamHubRuntimeStateClientFake>["finishRun"]
        >[0],
      ) => ({ run: terminalRun("failed") }),
    );
    const fixture = await terminalFixture({
      getSession: async () => {
        if (++reads === 2)
          throw new TeamHubRuntimeStateError(
            null,
            "checkpoint read unavailable",
          );
        return { available: false };
      },
      finishRun,
    });
    try {
      const session = { threadId: "thread-1" };
      const completion = fixture.state.finishLocalRun(
        "run-1",
        { type: "failed", error: "HTTP 400" },
        session,
      );
      const assertion = expect(completion).resolves.toBeUndefined();
      void assertion.catch(() => undefined);
      await vi.runAllTimersAsync();
      await assertion;
      expect(finishRun).toHaveBeenCalledOnce();
      expect(finishRun.mock.calls[0]?.[0]).toMatchObject({
        session: { expected_revision: "0", session },
      });
    } finally {
      await fixture.state.close();
      vi.useRealTimers();
    }
  });

  it("finishes the Run without its Session when TeamHub rejects the Session", async () => {
    const finishRun = vi.fn(
      async (
        body: Parameters<
          ReturnType<typeof createTeamHubRuntimeStateClientFake>["finishRun"]
        >[0],
      ) => {
        if (body.session)
          throw new TeamHubRuntimeStateError(
            409,
            "Agent Runtime State conflicts with the request",
            "AGENT_RUNTIME_CONFLICT",
          );
        return { run: terminalRun("failed") };
      },
    );
    const fixture = await terminalFixture({ finishRun });
    try {
      await expect(
        fixture.state.finishLocalRun(
          "run-1",
          { type: "failed", error: "provider failed" },
          { threadId: "thread-1" },
        ),
      ).resolves.toBeUndefined();
      expect(finishRun).toHaveBeenCalledTimes(2);
      expect(finishRun.mock.calls[0]?.[0].session).toBeDefined();
      expect(finishRun.mock.calls[1]?.[0]).toMatchObject({
        run_id: "run-1",
        terminal: { type: "failed", error: "provider failed" },
      });
      expect(finishRun.mock.calls[1]?.[0].session).toBeUndefined();
    } finally {
      await fixture.state.close();
    }
  });

  it("re-reads queued Local Runs after MCP resolve can make a Document Run claimable", async () => {
    let queued = false;
    const fixture = await terminalFixture({
      getWorkState: async () => ({
        has_pending_work: queued,
        has_queued_runs: queued,
      }),
    });
    try {
      expect(fixture.state.hasQueuedRuns()).toBe(false);
      queued = true;
      if (!fixture.state.refreshWorkState)
        throw new Error("Missing work-state refresh");
      await fixture.state.refreshWorkState();
      expect(fixture.state.hasQueuedRuns()).toBe(true);
    } finally {
      await fixture.state.close();
    }
  });

  it("does not turn an acknowledged terminal into failure when work-state refresh is unavailable", async () => {
    let unavailable = false;
    const fixture = await terminalFixture({
      getWorkState: async () => {
        if (unavailable)
          throw new TeamHubRuntimeStateError(null, "refresh unavailable");
        return {
          has_pending_work: true,
          has_queued_runs: false,
        };
      },
      finishRun: async () => ({ run: terminalRun("succeeded") }),
    });
    unavailable = true;
    await expect(
      fixture.state.finishLocalRun("run-1", {
        type: "succeeded",
        finalResponse: "done",
      }),
    ).resolves.toBeUndefined();
    await fixture.state.close();
  });

  it.each(["stop", "close", "conflict"] as const)(
    "stops terminal recovery on %s without changing the command outcome",
    async (reason) => {
      vi.useFakeTimers();
      const stop = new AbortController();
      const failure = new TeamHubRuntimeStateError(
        reason === "conflict" ? 409 : null,
        "unavailable",
      );
      const finishRun = vi.fn(async () => {
        throw failure;
      });
      const fixture = await terminalFixture({ finishRun });
      try {
        const completion = fixture.state.finishLocalRun(
          "run-1",
          { type: "failed", error: "provider failed" },
          undefined,
          stop.signal,
        );
        const assertion = expect(completion).rejects.toBeDefined();
        await vi.advanceTimersByTimeAsync(0);
        expect(finishRun).toHaveBeenCalledOnce();
        if (reason === "stop") stop.abort();
        if (reason === "close") await fixture.state.close();
        await vi.runAllTimersAsync();
        await assertion;
        expect(finishRun).toHaveBeenCalledOnce();
      } finally {
        await fixture.state.close();
        vi.useRealTimers();
      }
    },
  );

  it.each([
    ["AGENT_RUNTIME_CONFLICT", true, "canceled", undefined, true],
    [
      "AGENT_RUNTIME_CONFLICT",
      false,
      "canceled",
      "room_membership_revoked",
      true,
    ],
    ["AGENT_RUNTIME_CONFLICT", false, "canceled", undefined, false],
    ["AGENT_RUNTIME_CONFLICT", true, "running", undefined, false],
    ["CONTEXT_FENCED", true, "canceled", undefined, true],
    ["CONTEXT_FENCED", false, "canceled", undefined, false],
    ["CONTEXT_FENCED", false, "running", undefined, false],
    ["OTHER_CONFLICT", true, "canceled", "room_membership_revoked", false],
  ] as const)(
    "reconciles %s only with authoritative revocation (%s, %s, %s)",
    async (code, terminated, runStatus, reason, accepted) => {
      const client = createTeamHubRuntimeStateClientFake({
        getContext: async () => ({
          ...context("suspended"),
          ...(terminated ? { terminal_reason: "room_deleted" as const } : {}),
        }),
        getWorkState: async () => ({
          has_pending_work: false,
          has_queued_runs: false,
        }),
        getSession: async () => ({ available: false }),
        getRun: async () => ({
          run_id: "run-1",
          context_key: '["meta","agent-reviewer","room","room-1"]',
          attempt_count: 1,
          initial_input_ids: ["input-1"],
          steer_input_ids: [],
          status: runStatus,
          terminal: { type: "canceled", ...(reason ? { reason } : {}) },
        }),
      });
      const state = await createTeamHubContextRuntimeState({
        client,
        ref: { kind: "meta", agentId: "agent-reviewer", roomId: "room-1" },
        configurationRevision: "1",
        providerKind: "codex",
      });
      await expect(
        state.reconcileRevokedLocalRun?.(
          "run-1",
          new TeamHubRuntimeStateError(409, "conflict", code),
        ),
      ).resolves.toEqual(accepted ? { type: "canceled" } : null);
    },
  );

  it.each([
    ["alter_ego", "suspended", "task_terminal", "canceled", true],
    ["alter_ego", "active", "task_archived", "canceled", true],
    ["meta", "active", "room_membership_revoked", "canceled", true],
    ["meta", "suspended", "context_deleted", "canceled", true],
    ["alter_ego", "suspended", "", "canceled", false],
    ["alter_ego", "suspended", "task_terminal", "running", false],
  ] as const)(
    "settles a %s/%s Run that TeamHub canceled for %s (%s)",
    async (kind, residency, reason, runStatus, accepted) => {
      const ref: ExecutionContextRef =
        kind === "alter_ego"
          ? { kind, agentId: "agent-reviewer", taskId: "task-1" }
          : { kind, agentId: "agent-reviewer", roomId: "room-1" };
      const contextKey = encodeExecutionContextRef(ref);
      const fixture = await terminalFixture(
        {
          getContext: async () => ({
            ...context(residency),
            context_key: contextKey,
            ref:
              kind === "alter_ego"
                ? { kind, agent_id: "agent-reviewer", task_id: "task-1" }
                : { kind, agent_id: "agent-reviewer", room_id: "room-1" },
          }),
          getRun: async () => ({
            ...terminalRun("canceled"),
            context_key: contextKey,
            status: runStatus,
            terminal: { type: "canceled", reason },
          }),
        },
        ref,
      );
      await expect(
        fixture.state.reconcileRevokedLocalRun?.(
          "run-1",
          new TeamHubRuntimeStateError(
            409,
            "conflict",
            "AGENT_RUNTIME_CONFLICT",
          ),
        ),
      ).resolves.toEqual(accepted ? { type: "canceled" } : null);
      await fixture.state.close();
    },
  );

  it.each(["context", "run"])(
    "keeps %s lookup failures visible during conflict reconciliation",
    async (failedLookup) => {
      let initialized = false;
      const lookupError = new Error("lookup unavailable");
      const client = createTeamHubRuntimeStateClientFake({
        getContext: async () => {
          if (initialized && failedLookup === "context") throw lookupError;
          return { ...context("suspended"), terminal_reason: "room_deleted" };
        },
        getWorkState: async () => ({
          has_pending_work: false,
          has_queued_runs: false,
        }),
        getSession: async () => ({ available: false }),
        getRun: async () => {
          throw lookupError;
        },
      });
      const state = await createTeamHubContextRuntimeState({
        client,
        ref: { kind: "meta", agentId: "agent-reviewer", roomId: "room-1" },
        configurationRevision: "1",
        providerKind: "codex",
      });
      initialized = true;
      await expect(
        state.reconcileRevokedLocalRun?.(
          "run-1",
          new TeamHubRuntimeStateError(
            409,
            "conflict",
            "AGENT_RUNTIME_CONFLICT",
          ),
        ),
      ).rejects.toBe(lookupError);
    },
  );

  it("materializes a suspended Context with one work-state read", async () => {
    const getWorkState = vi.fn(async () => ({
      has_pending_work: false,
      has_queued_runs: false,
    }));
    const client = createTeamHubRuntimeStateClientFake({
      getContext: async () => context("suspended"),
      getWorkState,
      getSession: async () => ({ available: false }),
    });

    const state = await createTeamHubContextRuntimeState({
      client,
      ref: { kind: "meta", agentId: "agent-reviewer", roomId: "room-1" },
      configurationRevision: "1",
      providerKind: "codex",
    });

    expect(getWorkState).toHaveBeenCalledOnce();
    expect(state.hasPendingWork()).toBe(false);
    await state.close();
  });

  it("hands the claimed profile update to the Run", async () => {
    const client = createTeamHubRuntimeStateClientFake({
      getContext: async () => context("active"),
      getWorkState: async () => ({
        has_pending_work: false,
        has_queued_runs: false,
        has_waiting_inputs: false,
      }),
      getSession: async () => ({ available: false }),
      claimRun: async () => ({
        claimed: true,
        run: {
          attempt_count: 1,
          continues_context: false,
          inputs: [
            {
              input_id: "input-1",
              sequence: "1",
              payload: message("input-1") as unknown as Record<string, unknown>,
              source_kind: "trusted_turn",
              status: "handled",
            },
          ],
          run_id: "local-run-1",
          profile_update: {
            configuration_revision: 3,
            name: "Planner",
            instructions: "Plan the release.",
          },
        },
      }),
    });
    const state = await createTeamHubContextRuntimeState({
      client,
      ref: { kind: "meta", agentId: "agent-reviewer", roomId: "room-1" },
      configurationRevision: "1",
      providerKind: "codex",
    });

    await expect(state.claimLocalRun()).resolves.toMatchObject({
      runId: "local-run-1",
      profileUpdate: {
        configurationRevision: 3,
        name: "Planner",
        instructions: "Plan the release.",
      },
    });
    await state.close();
  });

  it("reports only committed Run claims and fresh checkpoints as its own revision advances", async () => {
    let committed = 0;
    const trackOwnRevisionAdvance = vi.fn(() => () => {
      committed += 1;
    });
    const claimRun = vi
      .fn<TeamHubRuntimeStateClient["claimRun"]>()
      .mockResolvedValueOnce({ claimed: false })
      .mockResolvedValueOnce({
        claimed: true,
        run: {
          attempt_count: 1,
          continues_context: false,
          inputs: [
            {
              input_id: "input-1",
              sequence: "1",
              payload: message("input-1") as unknown as Record<string, unknown>,
              source_kind: "trusted_turn",
              status: "handled",
            },
          ],
          run_id: "local-run-1",
        },
      });
    const checkpointSession = vi
      .fn<TeamHubRuntimeStateClient["checkpointSession"]>()
      .mockRejectedValueOnce(new Error("checkpoint unavailable"))
      .mockImplementation(async ({ checkpoint }) => ({
        ...checkpoint,
        revision: "1",
        updated_at: "2026-10-29T00:00:00.000Z",
      }));
    const client = createTeamHubRuntimeStateClientFake({
      getContext: async () => context("active"),
      getWorkState: async () => ({
        has_pending_work: false,
        has_queued_runs: false,
      }),
      getSession: async () => ({ available: false }),
      claimRun,
      checkpointSession,
    });
    const state = await createTeamHubContextRuntimeState({
      client,
      ref: { kind: "meta", agentId: "agent-reviewer", roomId: "room-1" },
      configurationRevision: "1",
      providerKind: "codex",
      trackOwnRevisionAdvance,
    });

    await expect(state.claimLocalRun()).resolves.toBeNull();
    expect(committed).toBe(0);
    await expect(state.claimLocalRun()).resolves.toMatchObject({
      runId: "local-run-1",
    });
    expect(committed).toBe(1);
    await expect(
      state.setRuntimeSession({ threadId: "thread-1" }),
    ).rejects.toThrow("checkpoint unavailable");
    expect(committed).toBe(1);
    await state.setRuntimeSession({ threadId: "thread-1" });
    expect(committed).toBe(2);
    expect(trackOwnRevisionAdvance).toHaveBeenCalledTimes(4);
    await state.close();
  });

  it("requeues a claimed Local Run under its epoch", async () => {
    const requeueRun = vi.fn().mockResolvedValue({ success: true });
    const client = createTeamHubRuntimeStateClientFake({
      getContext: async () => context("active"),
      getWorkState: async () => ({
        has_pending_work: false,
        has_queued_runs: false,
      }),
      getSession: async () => ({ available: false }),
      claimRun: async () => ({
        claimed: true,
        run: {
          attempt_count: 1,
          continues_context: false,
          inputs: [
            {
              input_id: "input-1",
              sequence: "1",
              payload: message("input-1") as unknown as Record<string, unknown>,
              source_kind: "trusted_turn",
              status: "handled",
            },
          ],
          run_id: "local-run-1",
        },
      }),
      requeueRun,
    });
    const state = await createTeamHubContextRuntimeState({
      client,
      ref: { kind: "meta", agentId: "agent-reviewer", roomId: "room-1" },
      configurationRevision: "1",
      providerKind: "codex",
    });

    await expect(state.claimLocalRun()).resolves.toMatchObject({
      attemptCount: 1,
      runId: "local-run-1",
    });
    await state.requeueLocalRun("local-run-1");

    expect(requeueRun).toHaveBeenCalledWith({
      context_key: '["meta","agent-reviewer","room","room-1"]',
      epoch: client.epoch,
      run_id: "local-run-1",
    });
    await state.close();
  });

  it("uses the durable claim result without a follow-up work-state read", async () => {
    let workStateReads = 0;
    const client = createTeamHubRuntimeStateClientFake({
      getContext: async () => context("active"),
      getWorkState: async () => {
        workStateReads += 1;
        if (workStateReads === 2) {
          throw new TeamHubRuntimeStateError(null, "temporary read timeout");
        }
        return {
          has_pending_work: false,
          has_queued_runs: false,
        };
      },
      getSession: async () => ({ available: false }),
      claimRun: async () => ({
        claimed: true,
        run: {
          attempt_count: 1,
          continues_context: false,
          inputs: [
            {
              input_id: "input-claimed",
              sequence: "1",
              payload: message("input-claimed") as unknown as Record<
                string,
                unknown
              >,
              source_kind: "trusted_turn",
              status: "handled",
            },
          ],
          run_id: "local-run-claimed",
        },
      }),
    });
    const state = await createTeamHubContextRuntimeState({
      client,
      ref: { kind: "meta", agentId: "agent-reviewer", roomId: "room-1" },
      configurationRevision: "1",
      providerKind: "codex",
    });

    await expect(state.claimLocalRun()).resolves.toMatchObject({
      runId: "local-run-claimed",
    });
    expect(state.hasPendingWork()).toBe(true);
    expect(state.hasQueuedRuns()).toBe(false);
    expect(workStateReads).toBe(1);
    await state.close();
  });
});

const context = (targetResidency: "active" | "suspended"): RuntimeContext => ({
  context_key: '["meta","agent-reviewer","room","room-1"]',
  ref: { kind: "meta", agent_id: "agent-reviewer", room_id: "room-1" },
  tenant_id: "tenant-acme",
  agent_actor_id: "actor-reviewer",
  target_residency: targetResidency,
  state_revision: "1",
  next_input_sequence: "0",
});

const message = (messageId: string): Message => ({
  messageId,
  rawMessage: "Review this.",
  segments: [{ type: "text", content: "Review this." }],
});

async function terminalFixture(
  overrides: Parameters<typeof createTeamHubRuntimeStateClientFake>[0],
  ref: ExecutionContextRef = {
    kind: "meta",
    agentId: "agent-reviewer",
    roomId: "room-1",
  },
) {
  const client = createTeamHubRuntimeStateClientFake({
    getContext: async () => context("active"),
    getWorkState: async () => ({
      has_pending_work: false,
      has_queued_runs: false,
    }),
    getSession: async () => ({ available: false }),
    ...overrides,
  });
  const state = await createTeamHubContextRuntimeState({
    client,
    ref,
    configurationRevision: "1",
    providerKind: "codex",
  });
  return { state, client };
}

async function profileRecoveryFixture(
  providerKind: string,
  overrides: Parameters<typeof createTeamHubRuntimeStateClientFake>[0],
) {
  const client = createTeamHubRuntimeStateClientFake({
    getContext: async () => context("active"),
    getWorkState: async () => ({
      has_pending_work: false,
      has_queued_runs: false,
    }),
    ...overrides,
  });
  const state = await createTeamHubContextRuntimeState({
    client,
    ref: { kind: "meta", agentId: "agent-reviewer", roomId: "room-1" },
    configurationRevision: "2",
    providerKind,
  });
  return { state, client };
}

function terminalRun(status: "succeeded" | "failed" | "canceled") {
  return {
    run_id: "run-1",
    context_key: '["meta","agent-reviewer","room","room-1"]',
    status,
    attempt_count: 1,
    initial_input_ids: ["input-1"],
    steer_input_ids: [],
  };
}

describe("earliestInputReceivedAtMs", () => {
  it("uses the earliest created_at and ignores missing or invalid values", () => {
    expect(
      earliestInputReceivedAtMs([
        { created_at: "2026-10-21T00:00:02.500Z" },
        {},
        { created_at: "not a date" },
        { created_at: "2026-10-21T00:00:01.000Z" },
      ]),
    ).toBe(Date.parse("2026-10-21T00:00:01.000Z"));
  });

  it("is undefined when no input carries created_at", () => {
    expect(earliestInputReceivedAtMs([{}, {}])).toBeUndefined();
    expect(earliestInputReceivedAtMs([])).toBeUndefined();
  });
});
