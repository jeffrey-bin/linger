import { describe, expect, it, vi } from "vitest";

import type { ExecutionContextMessageDelivery } from "../../../src/agent/executor/agent-manager-api.js";
import type { LocalTurnObservation } from "../../../src/agent/executor/types.js";
import {
  createTaskWorker,
  type TaskEffect,
  type TaskExecution,
  type TaskWorkerLease,
  type TaskWorkerTransitionInput,
  type TeamHubTaskWorkerClient,
} from "../../../src/agent/task-manager/index.js";

describe("Task Worker", () => {
  it("asks TeamHub to reconcile a running Task and stops once it is idle", async () => {
    const initial = execution({
      status: "running",
      participants: [],
      effects: [],
    });
    const scripted = scriptedClient(initial, [
      step(
        "advance",
        execution({ status: "idle", participants: [], effects: [] }),
      ),
    ]);
    const worker = createTaskWorker({
      client: scripted.client,
      agentManager: {
        steerActiveTurn: vi.fn(async () => null),
        cancelLocalRun: cancelLocalRunMock(),
        cancelTrustedTurn: cancelTrustedTurnMock(),
        submitTrustedTurn: vi.fn(),
        observeTurn: vi.fn(),
      },
    });
    await expect(worker.runOnce()).resolves.toBe(true);
    expect(scripted.transitions).toHaveLength(1);
    expect(scripted.transitions[0]).toMatchObject({
      transition: "advance",
      expectedControlRevision: initial.control_revision,
    });
    expect(scripted.transitions[0]?.payload).toBeUndefined();
    expect(scripted.remainingSteps()).toBe(0);
  });

  it("records a classified activation failure instead of leaving the Task dispatching", async () => {
    const participants = [participant("actor-result", "agent-result")];
    const pending = submitEffect({
      id: "effect-activation-failed",
      recipients: ["actor-result"],
      inputManifest: { room_id: "room-task" },
      messageId: "message-activation-failed",
      text: "Run after activation",
      routed: true,
    });
    const dispatching = { ...pending, status: "dispatching" } as TaskEffect;
    const initial = execution({ participants, effects: [dispatching] });
    const failed = execution({
      participants,
      effects: [
        {
          ...dispatching,
          status: "failed",
          error: "CONTEXT_ACTIVATION_PREPARE_RUNTIME_VIEW_FAILED",
        },
      ],
    });
    const scripted = scriptedClient(initial, [
      step("record_agent_turn_failure", failed),
      step("advance", failed, true),
    ]);
    const activationError = Object.assign(new Error("activation failed"), {
      name: "ContextActivationError",
      code: "CONTEXT_ACTIVATION_PREPARE_RUNTIME_VIEW_FAILED",
      retryable: true,
      stage: "prepare_runtime_view",
    });
    const worker = createTaskWorker({
      workerId: "worker-activation-failed",
      client: scripted.client,
      agentManager: {
        steerActiveTurn: vi.fn(async () => null),
        cancelLocalRun: cancelLocalRunMock(),
        cancelTrustedTurn: cancelTrustedTurnMock(),
        submitTrustedTurn: vi.fn().mockRejectedValue(activationError),
        observeTurn: vi.fn(),
      },
    });

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(scripted.transitions).toEqual([
      expect.objectContaining({
        transition: "record_agent_turn_failure",
        payload: {
          effect_id: "effect-activation-failed",
          failure_code: "CONTEXT_ACTIVATION_PREPARE_RUNTIME_VIEW_FAILED",
          retryable: true,
        },
      }),
      expect.objectContaining({ transition: "advance" }),
    ]);
  });

  it("reconciles a possibly created Run before dispatching an activation retry", async () => {
    const participants = [participant("actor-result", "agent-result")];
    const failedSubmit = {
      ...submitEffect({
        id: "effect-activation-partial",
        recipients: ["actor-result"],
        inputManifest: { room_id: "room-task" },
        messageId: "message-activation-partial",
        text: "Possibly accepted before peer activation failed",
        routed: true,
      }),
      status: "failed",
      error: "CONTEXT_ACTIVATION_PREPARE_RUNTIME_VIEW_FAILED",
      observation: {
        failure_code: "CONTEXT_ACTIVATION_PREPARE_RUNTIME_VIEW_FAILED",
        retryable: true,
      },
    } as TaskEffect;
    const cleanupPending = responseLostCleanupEffect("pending", failedSubmit);
    const cleanupDispatching = responseLostCleanupEffect(
      "dispatching",
      failedSubmit,
    );
    const retrySubmit = submitEffect({
      id: "effect-activation-retry-next",
      recipients: ["actor-result"],
      inputManifest: { room_id: "room-task" },
      messageId: "message-activation-retry-next",
      text: "Retry after cleanup",
      routed: true,
    });
    const initial = execution({
      revision: 8,
      participants,
      effects: [failedSubmit, cleanupPending, retrySubmit],
    });
    const scripted = scriptedClient(initial, [
      step(
        "begin_effect_dispatch",
        execution({
          revision: 8,
          participants,
          effects: [failedSubmit, cleanupDispatching, retrySubmit],
        }),
      ),
      step(
        "complete_runtime_cleanup",
        execution({
          revision: 8,
          participants,
          effects: [
            failedSubmit,
            { ...cleanupDispatching, status: "succeeded" },
            retrySubmit,
          ],
        }),
        true,
      ),
    ]);
    const cancelTrustedTurn = cancelTrustedTurnMock();
    const submitTrustedTurn = vi.fn();
    const worker = createTaskWorker({
      workerId: "worker-activation-partial-cleanup",
      client: scripted.client,
      agentManager: {
        steerActiveTurn: vi.fn(async () => null),
        cancelLocalRun: cancelLocalRunMock(),
        cancelTrustedTurn,
        observeTurn: vi.fn(),
        submitTrustedTurn,
      },
    });

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(scripted.transitions.map(({ transition }) => transition)).toEqual([
      "begin_effect_dispatch",
      "complete_runtime_cleanup",
    ]);
    expect(cancelTrustedTurn).toHaveBeenCalledOnce();
    expect(submitTrustedTurn).not.toHaveBeenCalled();
  });

  it("replays a dispatching turn after activation fails without recording a phantom Run", async () => {
    const participants = [participant("actor-result", "agent-result")];
    const pending = submitEffect({
      id: "effect-activation-retry",
      recipients: ["actor-result"],
      inputManifest: { room_id: "room-task" },
      messageId: "message-activation-retry",
      text: "Run after the Task projection is ready",
      routed: true,
    });
    const dispatching = { ...pending, status: "dispatching" } as TaskEffect;
    const succeeded = {
      ...pending,
      status: "succeeded",
      observation: {
        participant_runs: [
          participantRun("actor-result", "agent-result", "run-reused"),
        ],
      },
    } as TaskEffect;
    const terminal = {
      ...succeeded,
      observation: {
        ...succeeded.observation,
        participant_terminals: [
          { agent_run_ref: "run-reused", status: "succeeded" },
        ],
      },
    } as TaskEffect;
    const initial = execution({ participants, effects: [dispatching] });
    const scripted = scriptedClient(initial, [
      step("schedule_reconcile", initial, true),
      step(
        "record_agent_turn",
        execution({ participants, effects: [succeeded] }),
      ),
      step(
        "record_agent_terminal",
        execution({ participants, effects: [terminal] }),
      ),
      step(
        "schedule_reconcile",
        execution({ participants, effects: [terminal] }),
        true,
      ),
    ]);
    const activationError = new Error("Task projection is not ready");
    const submitTrustedTurn = vi
      .fn()
      .mockRejectedValueOnce(activationError)
      .mockResolvedValue({ agentRunRef: "run-reused" });
    const worker = createTaskWorker({
      workerId: "worker-activation-retry",
      client: scripted.client,
      agentManager: {
        steerActiveTurn: vi.fn(async () => null),
        cancelLocalRun: cancelLocalRunMock(),
        cancelTrustedTurn: cancelTrustedTurnMock(),
        submitTrustedTurn,
        observeTurn: vi.fn(async (_target, runId) =>
          terminalObservation(runId),
        ),
      },
    });

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(scripted.transitions.map(({ transition }) => transition)).toEqual([
      "schedule_reconcile",
    ]);

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(submitTrustedTurn).toHaveBeenCalledTimes(2);
    expect(submitTrustedTurn.mock.calls[1]).toEqual(
      submitTrustedTurn.mock.calls[0],
    );
    expect(scripted.transitions.map(({ transition }) => transition)).toEqual([
      "schedule_reconcile",
      "record_agent_turn",
      "record_agent_terminal",
      "schedule_reconcile",
    ]);
    // A failed submit retries soon; a quiescent running Task waits for
    // TeamHub to make it due, behind a one-minute safety net.
    expect(scripted.transitions[0]?.payload).toEqual({
      reconcile_after_seconds: 1,
    });
    expect(scripted.transitions[3]?.payload).toEqual({
      reconcile_after_seconds: 60,
    });
    expect(scripted.transitions[1]?.payload).toMatchObject({
      participant_runs: [
        {
          actor_id: "actor-result",
          agent_management_id: "agent-result",
          agent_run_ref: "run-reused",
        },
      ],
    });
  });

  it.each([true, false])(
    "submits exact frozen recipients without message files (Work Room bound=%s)",
    async (isWorkRoom) => {
      const participants = [
        participant("actor-a", "agent-a"),
        participant("actor-b", "agent-b"),
        participant("actor-not-addressed", "agent-extra"),
      ];
      const pending = submitEffect({
        id: "effect-submit",
        recipients: ["actor-b", "actor-a"],
        inputManifest: {
          room_id: "room-task",
          source: isWorkRoom ? "human_task_room_message" : "task_creation",
        },
        messageId: "message-initial",
        text: "Investigate the failure",
        segments: [{ type: "html_fragment", content: "Investigation preview" }],
        routed: true,
      });
      const dispatching = { ...pending, status: "dispatching" } as TaskEffect;
      const succeeded = {
        ...pending,
        status: "succeeded",
        observation: {
          participant_runs: [
            participantRun("actor-a", "agent-a", "run-a"),
            participantRun("actor-b", "agent-b", "run-b"),
          ],
        },
      } as TaskEffect;
      const terminal = {
        ...succeeded,
        observation: {
          ...succeeded.observation,
          participant_terminals: [
            { agent_run_ref: "run-a", status: "succeeded" },
            { agent_run_ref: "run-b", status: "succeeded" },
          ],
        },
      } as TaskEffect;
      const initial = execution({ participants, effects: [pending] });
      const scripted = scriptedClient(initial, [
        step(
          "begin_effect_dispatch",
          execution({ participants, effects: [dispatching] }),
        ),
        step(
          "record_agent_turn",
          execution({ participants, effects: [succeeded] }),
        ),
        step(
          "record_agent_terminal",
          execution({ participants, effects: [terminal] }),
        ),
        step("advance", execution({ participants, effects: [terminal] }), true),
      ]);
      const deliveries: ExecutionContextMessageDelivery[] = [];
      const worker = createTaskWorker({
        workerId: "worker-exact",
        client: scripted.client,
        agentManager: {
          steerActiveTurn: vi.fn(async () => null),
          cancelLocalRun: cancelLocalRunMock(),
          cancelTrustedTurn: cancelTrustedTurnMock(),
          submitTrustedTurn: vi.fn(async (delivery) => {
            deliveries.push(delivery);
            return {
              agentRunRef:
                delivery.target.kind === "alter_ego" &&
                delivery.target.agentId === "agent-a"
                  ? "run-a"
                  : "run-b",
            };
          }),
          observeTurn: vi.fn(async (_target, runId) =>
            terminalObservation(runId),
          ),
        },
      });

      await expect(worker.runOnce()).resolves.toBe(true);

      expect(deliveries).toEqual([
        {
          target: { kind: "alter_ego", agentId: "agent-b", taskId: "task-1" },
          messages: [
            {
              messageId: "wake-actor-b",
              rawMessage:
                "A new Task input is available in the shared Task Inbox.",
              segments: [
                {
                  type: "text",
                  content:
                    "A new Task input is available in the shared Task Inbox.",
                },
              ],
              sourceInboxIds: ["meta:actor-b:task-1"],
            },
          ],
        },
        {
          target: { kind: "alter_ego", agentId: "agent-a", taskId: "task-1" },
          messages: [
            {
              messageId: "wake-actor-a",
              rawMessage:
                "A new Task input is available in the shared Task Inbox.",
              segments: [
                {
                  type: "text",
                  content:
                    "A new Task input is available in the shared Task Inbox.",
                },
              ],
              sourceInboxIds: ["meta:actor-a:task-1"],
            },
          ],
        },
      ]);
      expect(scripted.transitions[1]).toMatchObject({
        transition: "record_agent_turn",
        operationId: "root-effect-submit",
        payload: {
          effect_id: "effect-submit",
          participant_runs: [
            participantRun("actor-a", "agent-a", "run-a"),
            participantRun("actor-b", "agent-b", "run-b"),
          ],
        },
      });
      expect(scripted.transitions[2]).toMatchObject({
        transition: "record_agent_terminal",
        payload: {
          effect_id: "effect-submit",
          participant_terminals: [
            { agent_run_ref: "run-a", status: "succeeded" },
            { agent_run_ref: "run-b", status: "succeeded" },
          ],
        },
      });
      expect(scripted.transitions[3]).toMatchObject({
        transition: "advance",
        expectedControlRevision: 1,
      });
      expect(deliveries).toHaveLength(2);
    },
  );

  it("continues on the same lease when Attempt reconcile creates a correction turn", async () => {
    const participants = [participant("actor-result", "agent-result")];
    const completed = completedSubmitEffect({
      id: "effect-initial",
      actorId: "actor-result",
      agentId: "agent-result",
      runId: "run-initial",
    });
    const correction = submitEffect({
      id: "effect-correction",
      recipients: ["actor-result"],
      feedbackMessageId: "message-correction",
      messageId: "message-correction",
      text: "Submit the Task result with finish_task.",
      inputManifest: { room_id: "room-task" },
    });
    const dispatching = {
      ...correction,
      status: "dispatching",
    } as TaskEffect;
    const submitted = {
      ...correction,
      status: "succeeded",
      observation: {
        participant_runs: [
          participantRun("actor-result", "agent-result", "run-correction"),
        ],
      },
    } as TaskEffect;
    const initial = execution({ participants, effects: [completed] });
    const scripted = scriptedClient(initial, [
      step(
        "advance",
        execution({
          revision: 8,
          participants,
          effects: [completed, correction],
        }),
      ),
      step(
        "begin_effect_dispatch",
        execution({
          revision: 8,
          participants,
          effects: [completed, dispatching],
        }),
      ),
      step(
        "record_agent_turn",
        execution({
          revision: 8,
          participants,
          effects: [completed, submitted],
        }),
      ),
      step(
        "advance",
        execution({
          revision: 8,
          participants,
          effects: [completed, submitted],
        }),
        true,
      ),
    ]);
    const deliveries: ExecutionContextMessageDelivery[] = [];
    const worker = createTaskWorker({
      workerId: "worker-reconcile-correction",
      client: scripted.client,
      agentManager: {
        steerActiveTurn: vi.fn(async () => null),
        cancelLocalRun: vi.fn(async () => "not_found" as const),
        cancelTrustedTurn: cancelTrustedTurnMock(),
        submitTrustedTurn: vi.fn(async (delivery) => {
          deliveries.push(delivery);
          return { agentRunRef: "run-correction" };
        }),
        observeTurn: vi.fn(async () => null),
      },
    });

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(scripted.transitions.map(({ transition }) => transition)).toEqual([
      "advance",
      "begin_effect_dispatch",
      "record_agent_turn",
      "advance",
    ]);
    expect(scripted.transitions[0]).toMatchObject({});
    expect(scripted.transitions[3]).toMatchObject({});
    expect(deliveries).toEqual([
      {
        target: {
          kind: "alter_ego",
          agentId: "agent-result",
          taskId: "task-1",
        },
        messages: [
          {
            messageId: "message-correction",
            rawMessage: "Submit the Task result with finish_task.",
            segments: [
              {
                type: "text",
                content: "Submit the Task result with finish_task.",
              },
            ],
            sourceInboxIds: ["meta:actor-result:task-1"],
          },
        ],
      },
    ]);
  });

  it.each([
    { name: "joins the running turn", steeredRun: "run-active" },
    { name: "falls back to the next turn", steeredRun: null },
  ])("steers a Meta message when asked and $name", async ({ steeredRun }) => {
    const participants = [participant("actor-result", "agent-result")];
    const pending = {
      ...submitEffect({
        id: "effect-steer",
        recipients: ["actor-result"],
        messageId: "message-steer",
        text: "Also cover the 2025 numbers.",
        inputManifest: { room_id: "room-task" },
        routed: true,
      }),
    };
    const steerPayload = { ...pending.payload, steer: true };
    const steerEffect = { ...pending, payload: steerPayload } as TaskEffect;
    const dispatching = { ...steerEffect, status: "dispatching" } as TaskEffect;
    const runRef = steeredRun ?? "run-next";
    const submitted = {
      ...steerEffect,
      status: "succeeded",
      observation: {
        participant_runs: [
          participantRun("actor-result", "agent-result", runRef),
        ],
      },
    } as TaskEffect;
    const scripted = scriptedClient(
      execution({ participants, effects: [steerEffect] }),
      [
        step("advance", execution({ participants, effects: [steerEffect] })),
        step(
          "begin_effect_dispatch",
          execution({ participants, effects: [dispatching] }),
        ),
        step(
          "record_agent_turn",
          execution({ participants, effects: [submitted] }),
        ),
        step(
          "advance",
          execution({ participants, effects: [submitted] }),
          true,
        ),
      ],
    );
    const steerActiveTurn = vi.fn(async () =>
      steeredRun ? { agentRunRef: steeredRun } : null,
    );
    const submitTrustedTurn = vi.fn(async () => ({ agentRunRef: "run-next" }));
    const worker = createTaskWorker({
      workerId: "worker-steer",
      client: scripted.client,
      agentManager: {
        steerActiveTurn,
        cancelLocalRun: cancelLocalRunMock(),
        cancelTrustedTurn: cancelTrustedTurnMock(),
        submitTrustedTurn,
        observeTurn: vi.fn(async () => null),
      },
    });

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(steerActiveTurn).toHaveBeenCalledWith({
      target: { kind: "alter_ego", agentId: "agent-result", taskId: "task-1" },
      message: expect.objectContaining({ messageId: "wake-actor-result" }),
    });
    expect(submitTrustedTurn).toHaveBeenCalledTimes(steeredRun ? 0 : 1);
    expect(
      scripted.transitions.find(
        ({ transition }) => transition === "record_agent_turn",
      )?.payload,
    ).toEqual({
      effect_id: "effect-steer",
      participant_runs: [
        participantRun("actor-result", "agent-result", runRef),
      ],
    });
  });

  it("rejects routed turns whose private wake actors exceed the frozen recipients", async () => {
    const pending = submitEffect({
      id: "effect-extra-wake",
      recipients: ["actor-result"],
      messageId: "message-public",
      text: "Run the Task",
      inputManifest: { room_id: "room-task" },
      routed: true,
    });
    const extraWake = {
      actor_id: "actor-extra",
      author_actor_id: "actor-sponsor",
      meta_seq: 1,
      public_message_ids: ["message-public"],
      message: {
        message_id: "wake-actor-extra",
        raw_message: "A new Task input is available in the shared Task Inbox.",
        segments: [
          {
            type: "text",
            content: "A new Task input is available in the shared Task Inbox.",
          },
        ],
      },
    };
    const malformed = {
      ...pending,
      payload: {
        ...pending.payload,
        recipient_wakes: [
          ...((pending.payload.recipient_wakes as readonly unknown[]) ?? []),
          extraWake,
        ],
      },
    } as TaskEffect;
    const dispatching = {
      ...malformed,
      status: "dispatching",
    } as TaskEffect;
    const initial = execution({
      participants: [participant("actor-result", "agent-result")],
      effects: [malformed],
    });
    const scripted = scriptedClient(initial, [
      step(
        "begin_effect_dispatch",
        execution({
          participants: initial.participants,
          effects: [dispatching],
        }),
      ),
    ]);

    const submitTrustedTurn = vi.fn(async () => ({
      agentRunRef: "unexpected-run",
    }));
    const worker = createTaskWorker({
      workerId: "worker-extra-wake",
      client: scripted.client,
      agentManager: {
        steerActiveTurn: vi.fn(async () => null),
        cancelLocalRun: cancelLocalRunMock(),
        cancelTrustedTurn: cancelTrustedTurnMock(),
        submitTrustedTurn,
        observeTurn: vi.fn(async () => null),
      },
    });

    await expect(worker.runOnce()).rejects.toThrow(
      "recipient wakes do not exactly match frozen recipients",
    );
    expect(submitTrustedTurn).not.toHaveBeenCalled();
  });

  it("fails closed when any routed effect witness differs from its frozen Input Manifest", async () => {
    const tamperCases: readonly {
      readonly label: string;
      readonly path: readonly (string | number)[];
      readonly value: unknown;
    }[] = [
      {
        label: "public Message ID",
        path: ["public_context_message", "message_id"],
        value: "message-public-tampered",
      },
      {
        label: "public raw Message",
        path: ["public_context_message", "raw_message"],
        value: "Tampered public context",
      },
      {
        label: "public Message segments",
        path: ["public_context_message", "segments"],
        value: [{ type: "text", content: "Tampered public segment" }],
      },
      {
        label: "public author Actor ID",
        path: ["public_context_message", "author", "actor_id"],
        value: "actor-other",
      },
      {
        label: "public author kind",
        path: ["public_context_message", "author", "kind"],
        value: "agent",
      },
      {
        label: "public author display name",
        path: ["public_context_message", "author", "display_name"],
        value: "Other Author",
      },
      {
        label: "wake Actor ID",
        path: ["recipient_wakes", 0, "actor_id"],
        value: "actor-other",
      },
      {
        label: "wake author Actor ID",
        path: ["recipient_wakes", 0, "author_actor_id"],
        value: "actor-other",
      },
      {
        label: "wake Meta sequence",
        path: ["recipient_wakes", 0, "meta_seq"],
        value: 2,
      },
      {
        label: "wake public Message IDs",
        path: ["recipient_wakes", 0, "public_message_ids"],
        value: ["message-other"],
      },
      {
        label: "wake Message ID",
        path: ["recipient_wakes", 0, "message", "message_id"],
        value: "wake-tampered",
      },
      {
        label: "wake raw Message",
        path: ["recipient_wakes", 0, "message", "raw_message"],
        value: "Tampered private wake",
      },
      {
        label: "wake Message segments",
        path: ["recipient_wakes", 0, "message", "segments"],
        value: [{ type: "text", content: "Tampered private segment" }],
      },
      {
        label: "manifest wake author",
        path: ["input_manifest", "wake_author_actor_id"],
        value: "actor-other",
      },
      {
        label: "manifest recipient set",
        path: ["input_manifest", "recipient_wakes", 0, "actor_id"],
        value: "actor-other",
      },
      {
        label: "manifest public context",
        path: ["input_manifest", "public_context_message", "raw_message"],
        value: "Tampered frozen context",
      },
      {
        label: "manifest public Message segments",
        path: ["input_manifest", "public_context_message", "segments"],
        value: [{ type: "text", content: "Tampered frozen segment" }],
      },
      {
        label: "manifest public author Actor ID",
        path: [
          "input_manifest",
          "public_context_message",
          "author",
          "actor_id",
        ],
        value: "actor-other",
      },
      {
        label: "manifest public author kind",
        path: ["input_manifest", "public_context_message", "author", "kind"],
        value: "agent",
      },
      {
        label: "manifest public author display name",
        path: [
          "input_manifest",
          "public_context_message",
          "author",
          "display_name",
        ],
        value: "Other Author",
      },
      {
        label: "manifest wake",
        path: ["input_manifest", "recipient_wakes", 0, "meta_seq"],
        value: 2,
      },
      {
        label: "manifest wake author Actor ID",
        path: ["input_manifest", "recipient_wakes", 0, "author_actor_id"],
        value: "actor-other",
      },
      {
        label: "manifest wake public Message IDs",
        path: ["input_manifest", "recipient_wakes", 0, "public_message_ids"],
        value: ["message-other"],
      },
      {
        label: "manifest wake Message ID",
        path: ["input_manifest", "recipient_wakes", 0, "message", "message_id"],
        value: "wake-frozen-tampered",
      },
      {
        label: "manifest wake raw Message",
        path: [
          "input_manifest",
          "recipient_wakes",
          0,
          "message",
          "raw_message",
        ],
        value: "Tampered frozen private wake",
      },
      {
        label: "manifest wake Message segments",
        path: ["input_manifest", "recipient_wakes", 0, "message", "segments"],
        value: [{ type: "text", content: "Tampered frozen wake segment" }],
      },
      {
        label: "legacy manifest without routed witnesses",
        path: ["input_manifest", "recipient_wakes"],
        value: undefined,
      },
      {
        label: "legacy effect without frozen public Message IDs",
        path: ["input_manifest", "public_message_ids"],
        value: undefined,
      },
      {
        label: "replay Message",
        path: ["message", "raw_message"],
        value: "Tampered replay context",
      },
      {
        label: "replay public author",
        path: ["message", "author", "actor_id"],
        value: "actor-other",
      },
    ];

    for (const [index, tamper] of tamperCases.entries()) {
      const pending = submitEffect({
        id: `effect-route-tamper-${index}`,
        recipients: ["actor-result"],
        messageId: "message-public",
        text: "Run the Task",
        inputManifest: { room_id: "room-task" },
        routed: true,
      });
      const malformed = structuredClone(pending);
      setFixtureValue(malformed.payload, tamper.path, tamper.value);
      const dispatching = {
        ...malformed,
        status: "dispatching",
      } as TaskEffect;
      const initial = execution({
        participants: [participant("actor-result", "agent-result")],
        effects: [malformed],
      });
      const scripted = scriptedClient(initial, [
        step(
          "begin_effect_dispatch",
          execution({
            participants: initial.participants,
            effects: [dispatching],
          }),
        ),
      ]);

      const submitTrustedTurn = vi.fn(async () => ({
        agentRunRef: "unexpected-run",
      }));
      const worker = createTaskWorker({
        workerId: `worker-route-tamper-${index}`,
        client: scripted.client,
        agentManager: {
          steerActiveTurn: vi.fn(async () => null),
          cancelLocalRun: cancelLocalRunMock(),
          cancelTrustedTurn: cancelTrustedTurnMock(),
          submitTrustedTurn,
          observeTurn: vi.fn(async () => null),
        },
      });

      await expect(
        worker.runOnce(),
        `tampering ${tamper.label} must fail closed`,
      ).rejects.toThrow();
      expect(submitTrustedTurn).not.toHaveBeenCalled();
    }
  });

  it("rejects a turn that combines routed public input with private feedback", async () => {
    const pending = submitEffect({
      id: "effect-route-feedback-xor",
      recipients: ["actor-result"],
      messageId: "message-public",
      text: "Run the Task",
      inputManifest: { room_id: "room-task" },
      feedbackMessageId: "message-public",
      routed: true,
    });
    const dispatching = { ...pending, status: "dispatching" } as TaskEffect;
    const initial = execution({
      participants: [participant("actor-result", "agent-result")],
      effects: [pending],
    });
    const scripted = scriptedClient(initial, [
      step(
        "begin_effect_dispatch",
        execution({
          participants: initial.participants,
          effects: [dispatching],
        }),
      ),
    ]);
    const submitTrustedTurn = vi.fn(async () => ({
      agentRunRef: "unexpected-run",
    }));
    const worker = createTaskWorker({
      workerId: "worker-route-feedback-xor",
      client: scripted.client,
      agentManager: {
        steerActiveTurn: vi.fn(async () => null),
        cancelLocalRun: cancelLocalRunMock(),
        cancelTrustedTurn: cancelTrustedTurnMock(),
        submitTrustedTurn,
        observeTurn: vi.fn(async () => null),
      },
    });

    await expect(worker.runOnce()).rejects.toThrow(
      "cannot combine public Task routing with private feedback routing",
    );
    expect(submitTrustedTurn).not.toHaveBeenCalled();
  });

  it("rejects a submit effect that would use the shared Task Inbox as trusted ingress", async () => {
    const pending = submitEffect({
      id: "effect-direct-task-inbox",
      recipients: ["actor-result"],
      messageId: "message-public-only",
      text: "This public message cannot directly start a turn",
      inputManifest: { room_id: "room-task" },
    });
    const dispatching = { ...pending, status: "dispatching" } as TaskEffect;
    const initial = execution({
      participants: [participant("actor-result", "agent-result")],
      effects: [pending],
    });
    const scripted = scriptedClient(initial, [
      step(
        "begin_effect_dispatch",
        execution({
          participants: initial.participants,
          effects: [dispatching],
        }),
      ),
    ]);

    const submitTrustedTurn = vi.fn(async () => ({
      agentRunRef: "unexpected-run",
    }));
    const worker = createTaskWorker({
      workerId: "worker-direct-task-inbox",
      client: scripted.client,
      agentManager: {
        steerActiveTurn: vi.fn(async () => null),
        cancelLocalRun: cancelLocalRunMock(),
        cancelTrustedTurn: cancelTrustedTurnMock(),
        submitTrustedTurn,
        observeTurn: vi.fn(async () => null),
      },
    });

    await expect(worker.runOnce()).rejects.toThrow(
      "no private Meta Inbox ingress",
    );
    expect(submitTrustedTurn).not.toHaveBeenCalled();
  });

  it("drains an active peer through durable cleanup after the Task goes idle", async () => {
    const participants = [participant("actor-result", "agent-result")];
    const activeSubmit = {
      ...completedSubmitEffect({
        id: "effect-active-submit",
        actorId: "actor-result",
        agentId: "agent-result",
        runId: "run-cleanup",
      }),
      observation: {
        participant_runs: [
          participantRun("actor-result", "agent-result", "run-cleanup"),
        ],
      },
    } as TaskEffect;
    const cleanupPending = cleanupEffect("pending");
    const cleanupDispatching = cleanupEffect("dispatching");
    const initial = execution({
      status: "running",
      revision: 8,
      participants,
      effects: [activeSubmit],
    });
    const scripted = scriptedClient(initial, [
      step(
        "advance",
        execution({
          status: "idle",
          revision: 9,
          participants,
          effects: [activeSubmit, cleanupPending],
        }),
      ),
      step(
        "begin_effect_dispatch",
        execution({
          status: "idle",
          revision: 9,
          participants,
          effects: [activeSubmit, cleanupDispatching],
        }),
      ),
      step(
        "complete_runtime_cleanup",
        execution({
          status: "idle",
          revision: 9,
          participants,
          effects: [
            activeSubmit,
            {
              ...cleanupDispatching,
              status: "succeeded",
              observation: {
                agent_run_ref: "run-cleanup",
                cancel_status: "canceled",
                run_status: "canceled",
              },
            },
          ],
        }),
        true,
      ),
    ]);
    const cancelLocalRun = vi.fn(async () => "canceled" as const);
    const worker = createTaskWorker({
      workerId: "worker-success-cleanup",
      client: scripted.client,
      agentManager: {
        steerActiveTurn: vi.fn(async () => null),
        cancelLocalRun,
        cancelTrustedTurn: cancelTrustedTurnMock(),
        observeTurn: vi.fn(async () => ({
          runId: "run-cleanup",
          status: "running" as const,
        })),
        submitTrustedTurn: vi.fn(async () => {
          throw new Error("Success cleanup must not submit another turn");
        }),
      },
    });

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(scripted.transitions.map(({ transition }) => transition)).toEqual([
      "advance",
      "begin_effect_dispatch",
      "complete_runtime_cleanup",
    ]);
    expect(cancelLocalRun).toHaveBeenCalledWith(
      { kind: "alter_ego", agentId: "agent-result", taskId: "task-1" },
      "run-cleanup",
    );
    expect(scripted.remainingSteps()).toBe(0);
  });

  it("drains an active peer after attempt reconciliation settles failure", async () => {
    const participants = [
      participant("actor-result", "agent-result"),
      participant("actor-peer", "agent-peer"),
    ];
    const submitted = {
      ...completedSubmitEffect({
        id: "effect-failed-attempt",
        actorId: "actor-result",
        agentId: "agent-result",
        runId: "run-failed",
      }),
      observation: {
        participant_runs: [
          participantRun("actor-result", "agent-result", "run-failed"),
          participantRun("actor-peer", "agent-peer", "run-active-peer"),
        ],
        participant_terminals: [
          { agent_run_ref: "run-failed", status: "failed" },
        ],
      },
    } as TaskEffect;
    const failedCleanupPending = cleanupEffectFor({
      id: "effect-cleanup-failed",
      status: "pending",
      actorId: "actor-result",
      agentId: "agent-result",
      runId: "run-failed",
    });
    const failedCleanupDispatching = {
      ...failedCleanupPending,
      status: "dispatching",
    } as TaskEffect;
    const activeCleanupPending = cleanupEffectFor({
      id: "effect-cleanup-active",
      status: "pending",
      actorId: "actor-peer",
      agentId: "agent-peer",
      runId: "run-active-peer",
    });
    const activeCleanupDispatching = {
      ...activeCleanupPending,
      status: "dispatching",
    } as TaskEffect;
    const initial = execution({
      status: "running",
      participants,
      effects: [submitted],
    });
    const scripted = scriptedClient(initial, [
      step(
        "advance",
        execution({
          status: "failed",
          revision: 8,
          participants,
          effects: [submitted, failedCleanupPending, activeCleanupPending],
        }),
      ),
      step(
        "begin_effect_dispatch",
        execution({
          status: "failed",
          revision: 8,
          participants,
          effects: [submitted, failedCleanupDispatching, activeCleanupPending],
        }),
      ),
      step(
        "complete_runtime_cleanup",
        execution({
          status: "failed",
          revision: 8,
          participants,
          effects: [
            submitted,
            { ...failedCleanupDispatching, status: "succeeded" },
            activeCleanupPending,
          ],
        }),
      ),
      step(
        "begin_effect_dispatch",
        execution({
          status: "failed",
          revision: 8,
          participants,
          effects: [
            submitted,
            { ...failedCleanupDispatching, status: "succeeded" },
            activeCleanupDispatching,
          ],
        }),
      ),
      step(
        "complete_runtime_cleanup",
        execution({
          status: "failed",
          revision: 8,
          participants,
          effects: [
            submitted,
            { ...failedCleanupDispatching, status: "succeeded" },
            { ...activeCleanupDispatching, status: "succeeded" },
          ],
        }),
        true,
      ),
    ]);
    const cancelLocalRun = vi.fn(async (_target, runId: string) =>
      runId === "run-failed"
        ? ("already_terminal" as const)
        : ("canceled" as const),
    );
    const observeTurn = vi.fn(async (_target, runId: string) =>
      runId === "run-failed"
        ? {
            runId,
            status: "failed" as const,
            terminal: { type: "failed" as const, error: "attempt failed" },
          }
        : { runId, status: "running" as const },
    );
    const worker = createTaskWorker({
      workerId: "worker-failure-cleanup",
      client: scripted.client,
      agentManager: {
        steerActiveTurn: vi.fn(async () => null),
        cancelLocalRun,
        cancelTrustedTurn: cancelTrustedTurnMock(),
        observeTurn,
        submitTrustedTurn: vi.fn(async () => {
          throw new Error("Failure cleanup must not submit another turn");
        }),
      },
    });

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(scripted.transitions.map(({ transition }) => transition)).toEqual([
      "advance",
      "begin_effect_dispatch",
      "complete_runtime_cleanup",
      "begin_effect_dispatch",
      "complete_runtime_cleanup",
    ]);
    expect(cancelLocalRun).toHaveBeenCalledTimes(2);
    expect(cancelLocalRun).toHaveBeenCalledWith(
      { kind: "alter_ego", agentId: "agent-peer", taskId: "task-1" },
      "run-active-peer",
    );
    expect(scripted.remainingSteps()).toBe(0);
  });

  it("cancels and waits for a known Local Run before completing terminal cleanup", async () => {
    const cleanupPending = cleanupEffect("pending");
    const cleanupDispatching = cleanupEffect("dispatching");
    const cleanupSucceeded = {
      ...cleanupDispatching,
      status: "succeeded",
      observation: {
        agent_run_ref: "run-cleanup",
        cancel_status: "cancel_requested",
        run_status: "canceled",
      },
    } as TaskEffect;
    const initial = execution({
      status: "canceled",
      participants: [participant("actor-result", "agent-result")],
      effects: [cleanupPending],
    });
    const scripted = scriptedClient(initial, [
      step(
        "begin_effect_dispatch",
        execution({
          status: "canceled",
          participants: initial.participants,
          effects: [cleanupDispatching],
        }),
      ),
      step(
        "complete_runtime_cleanup",
        execution({
          status: "canceled",
          participants: initial.participants,
          effects: [cleanupSucceeded],
        }),
        true,
      ),
    ]);
    let observationCount = 0;
    const cancelLocalRun = vi.fn(async () => "cancel_requested" as const);
    const observeTurn = vi.fn(async () => {
      observationCount += 1;
      return observationCount === 1
        ? {
            runId: "run-cleanup",
            status: "running" as const,
          }
        : {
            runId: "run-cleanup",
            status: "canceled" as const,
            terminal: { type: "canceled" as const },
          };
    });
    const worker = createTaskWorker({
      workerId: "worker-cleanup",
      client: scripted.client,
      agentManager: {
        steerActiveTurn: vi.fn(async () => null),
        cancelLocalRun,
        cancelTrustedTurn: cancelTrustedTurnMock(),
        observeTurn,
        submitTrustedTurn: vi.fn(async () => {
          throw new Error("Terminal cleanup must not submit a turn");
        }),
      },
    });

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(cancelLocalRun).toHaveBeenCalledWith(
      { kind: "alter_ego", agentId: "agent-result", taskId: "task-1" },
      "run-cleanup",
    );
    expect(observeTurn).toHaveBeenCalledTimes(2);
    expect(scripted.transitions.at(-1)).toMatchObject({
      transition: "complete_runtime_cleanup",
      expectedControlRevision: 1,
      operationId: "root-effect-cleanup",
      payload: {
        effect_id: "effect-cleanup",
        agent_run_ref: "run-cleanup",
        cancel_status: "cancel_requested",
        run_status: "canceled",
      },
    });
    expect(scripted.remainingSteps()).toBe(0);
  });

  it("reacquires an expired dispatching cleanup effect before canceling the Local Run", async () => {
    const cleanupDispatching = cleanupEffect("dispatching");
    const initial = execution({
      status: "canceled",
      participants: [participant("actor-result", "agent-result")],
      effects: [cleanupDispatching],
    });
    const scripted = scriptedClient(initial, [
      step(
        "begin_effect_dispatch",
        execution({
          status: "canceled",
          participants: initial.participants,
          effects: [cleanupDispatching],
        }),
      ),
      step(
        "complete_runtime_cleanup",
        execution({
          status: "canceled",
          participants: initial.participants,
          effects: [
            {
              ...cleanupDispatching,
              status: "succeeded",
              observation: {
                agent_run_ref: "run-cleanup",
                cancel_status: "canceled",
                run_status: "canceled",
              },
            },
          ],
        }),
        true,
      ),
    ]);
    const cancelLocalRun = vi.fn(async () => "canceled" as const);
    const worker = createTaskWorker({
      workerId: "worker-cleanup-reclaimer",
      client: scripted.client,
      agentManager: {
        steerActiveTurn: vi.fn(async () => null),
        cancelLocalRun,
        cancelTrustedTurn: cancelTrustedTurnMock(),
        observeTurn: vi.fn(async () => {
          throw new Error("Canceled Local Run must not be observed");
        }),
        submitTrustedTurn: vi.fn(async () => {
          throw new Error("Terminal cleanup must not submit a turn");
        }),
      },
    });

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(scripted.transitions.map(({ transition }) => transition)).toEqual([
      "begin_effect_dispatch",
      "complete_runtime_cleanup",
    ]);
    expect(cancelLocalRun).toHaveBeenCalledWith(
      { kind: "alter_ego", agentId: "agent-result", taskId: "task-1" },
      "run-cleanup",
    );
    expect(scripted.remainingSteps()).toBe(0);
  });

  it("recovers a response-lost submit by Message identity before terminal cleanup", async () => {
    const originalSource = submitEffect({
      id: "effect-response-lost",
      recipients: ["actor-result"],
      messageId: "message-response-lost",
      text: "Run exactly once",
      inputManifest: { room_id: "room-task" },
      routed: true,
    });
    const source = withWhitespaceTextSegment(originalSource);
    const cleanupPending = responseLostCleanupEffect("pending", source);
    const cleanupDispatching = responseLostCleanupEffect("dispatching", source);
    const cleanupSucceeded = {
      ...cleanupDispatching,
      status: "succeeded",
      observation: {
        agent_run_ref: "run-from-message-replay",
        cancel_status: "canceled",
        run_status: "canceled",
      },
    } as TaskEffect;
    const initial = execution({
      status: "canceled",
      participants: [participant("actor-result", "agent-result")],
      effects: [{ ...source, status: "canceled" }, cleanupPending],
    });
    const scripted = scriptedClient(initial, [
      step(
        "begin_effect_dispatch",
        execution({
          status: "canceled",
          participants: initial.participants,
          effects: [{ ...source, status: "canceled" }, cleanupDispatching],
        }),
      ),
      step(
        "complete_runtime_cleanup",
        execution({
          status: "canceled",
          participants: initial.participants,
          effects: [{ ...source, status: "canceled" }, cleanupSucceeded],
        }),
        true,
      ),
    ]);
    const cancelTrustedTurn = vi.fn(async () => ({
      agentRunRef: "run-from-message-replay",
      cancelStatus: "canceled" as const,
    }));
    const cancelLocalRun = vi.fn(async () => "canceled" as const);
    const worker = createTaskWorker({
      workerId: "worker-response-lost-cleanup",
      client: scripted.client,
      agentManager: {
        steerActiveTurn: vi.fn(async () => null),
        cancelTrustedTurn,
        submitTrustedTurn: vi.fn(async () => {
          throw new Error("Terminal cleanup must not create a trusted turn");
        }),
        cancelLocalRun,
        observeTurn: vi.fn(async () => {
          throw new Error("A queued Local Run is canceled synchronously");
        }),
      },
    });

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(cancelTrustedTurn).toHaveBeenCalledWith({
      target: { kind: "alter_ego", agentId: "agent-result", taskId: "task-1" },
      messages: [
        {
          messageId: "wake-actor-result",
          rawMessage: "A new Task input is available in the shared Task Inbox.",
          segments: [
            {
              type: "text",
              content:
                "A new Task input is available in the shared Task Inbox.",
            },
          ],
          sourceInboxIds: ["meta:actor-result:task-1"],
        },
      ],
    });
    expect(cancelLocalRun).not.toHaveBeenCalled();
    expect(scripted.transitions.at(-1)).toMatchObject({
      transition: "complete_runtime_cleanup",
      operationId: "root-effect-response-lost-cleanup",
      payload: {
        effect_id: "effect-response-lost-cleanup",
        agent_run_ref: "run-from-message-replay",
        cancel_status: "canceled",
        run_status: "canceled",
      },
    });
    expect(scripted.remainingSteps()).toBe(0);
  });

  it("tombstones a response-lost submit before completing terminal cleanup", async () => {
    const source = submitEffect({
      id: "effect-never-submitted",
      recipients: ["actor-result"],
      messageId: "message-never-submitted",
      text: "Do not start after termination",
      inputManifest: { room_id: "room-task" },
      routed: true,
    });
    const cleanupPending = responseLostCleanupEffect("pending", source);
    const cleanupDispatching = responseLostCleanupEffect("dispatching", source);
    const initial = execution({
      status: "canceled",
      participants: [participant("actor-result", "agent-result")],
      effects: [{ ...source, status: "canceled" }, cleanupPending],
    });
    const scripted = scriptedClient(initial, [
      step(
        "begin_effect_dispatch",
        execution({
          status: "canceled",
          participants: initial.participants,
          effects: [{ ...source, status: "canceled" }, cleanupDispatching],
        }),
      ),
      step(
        "complete_runtime_cleanup",
        execution({
          status: "canceled",
          participants: initial.participants,
          effects: [
            { ...source, status: "canceled" },
            { ...cleanupDispatching, status: "succeeded" },
          ],
        }),
        true,
      ),
    ]);
    const worker = createTaskWorker({
      client: scripted.client,
      agentManager: {
        steerActiveTurn: vi.fn(async () => null),
        cancelTrustedTurn: vi.fn(async () => ({
          agentRunRef: "tombstoned-local-run",
          cancelStatus: "canceled" as const,
        })),
        submitTrustedTurn: vi.fn(async () => {
          throw new Error("Terminal cleanup must not create a trusted turn");
        }),
        cancelLocalRun: vi.fn(async () => {
          throw new Error("No Local Run exists to cancel");
        }),
        observeTurn: vi.fn(async () => null),
      },
    });

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(scripted.transitions.at(-1)).toMatchObject({
      transition: "complete_runtime_cleanup",
      payload: {
        effect_id: "effect-response-lost-cleanup",
        agent_run_ref: "tombstoned-local-run",
        cancel_status: "canceled",
        run_status: "canceled",
      },
    });
  });
});

const setFixtureValue = (
  root: unknown,
  path: readonly (string | number)[],
  value: unknown,
): void => {
  let current = root;
  for (const [index, key] of path.entries()) {
    const last = index === path.length - 1;
    if (typeof key === "number") {
      if (!Array.isArray(current)) {
        throw new TypeError(`Fixture path ${path.join(".")} is invalid`);
      }
      if (last) {
        current[key] = value;
        return;
      }
      current = current[key];
      continue;
    }
    if (
      typeof current !== "object" ||
      current === null ||
      Array.isArray(current)
    ) {
      throw new TypeError(`Fixture path ${path.join(".")} is invalid`);
    }
    const record = current as Record<string, unknown>;
    if (last) {
      record[key] = value;
      return;
    }
    current = record[key];
  }
  throw new TypeError("Fixture path must not be empty");
};

interface ScriptedStep {
  readonly transition: TaskWorkerTransitionInput["transition"];
  readonly response: TaskExecution;
  readonly releaseLease?: boolean;
}

const scriptedClient = (
  initial: TaskExecution,
  steps: readonly ScriptedStep[],
): {
  readonly client: TeamHubTaskWorkerClient;
  readonly transitions: TaskWorkerTransitionInput[];
  remainingSteps(): number;
} => {
  const lease = taskLease();
  const queue = [...steps];
  const transitions: TaskWorkerTransitionInput[] = [];
  return {
    transitions,
    remainingSteps: () => queue.length,
    client: {
      claim: vi.fn(async () => ({ claimed: { lease, execution: initial } })),
      get: vi.fn(async () => {
        throw new Error("Unexpected Task Worker GET");
      }),
      heartbeat: vi.fn(async () => lease),
      transition: vi.fn(async (input) => {
        // Runtime-focused scenarios script only meaningful state changes. The
        // unconditional domain drain is a read of this server fixture until it
        // has a scripted advance result.
        if (
          input.transition === "advance" &&
          queue[0]?.transition !== "advance"
        ) {
          return { lease, execution: input.execution };
        }
        transitions.push(input);
        const next = queue.shift();
        if (!next) throw new Error(`Unexpected ${input.transition} transition`);
        expect(input.transition).toBe(next.transition);
        expect(input.lease).toBe(lease);
        return next.releaseLease
          ? { execution: next.response }
          : { lease, execution: next.response };
      }),
    },
  };
};

const step = (
  transition: ScriptedStep["transition"],
  response: TaskExecution,
  releaseLease = false,
): ScriptedStep => ({ transition, response, releaseLease });

const participant = (
  actorId: string,
  agentId: string,
): TaskExecution["participants"][number] => ({
  actor_id: actorId,
  agent_id: agentId,
  execution_context_ref: {
    kind: "alter_ego",
    agentId,
    taskId: "task-1",
  },
});

const submitEffect = (input: {
  readonly id: string;
  readonly recipients: readonly string[];
  readonly messageId: string;
  readonly text: string;
  readonly segments?: readonly Readonly<Record<string, unknown>>[];
  readonly inputManifest?: Readonly<Record<string, unknown>>;
  readonly feedbackMessageId?: string;
  readonly routed?: boolean;
}): TaskEffect => {
  const publicContextMessage = (): Readonly<Record<string, unknown>> => ({
    message_id: input.messageId,
    raw_message: input.text,
    segments: input.segments ?? [{ type: "text", content: input.text }],
    author: {
      actor_id: "actor-public-author",
      kind: "human",
      display_name: "Public Author",
    },
  });
  const recipientWakes = (): readonly Readonly<Record<string, unknown>>[] =>
    input.recipients.map((actorId) => ({
      actor_id: actorId,
      author_actor_id: "actor-sponsor",
      meta_seq: 1,
      public_message_ids: [input.messageId],
      message: {
        message_id: `wake-${actorId}`,
        raw_message: "A new Task input is available in the shared Task Inbox.",
        segments: [
          {
            type: "text",
            content: "A new Task input is available in the shared Task Inbox.",
          },
        ],
      },
    }));
  const inputManifest = input.routed
    ? {
        ...(input.inputManifest ?? {}),
        public_message_ids: [input.messageId],
        public_context_message: publicContextMessage(),
        recipient_wakes: recipientWakes(),
        wake_author_actor_id: "actor-sponsor",
      }
    : input.inputManifest;
  return {
    id: input.id,
    root_operation_id: `root-${input.id}`,
    operation: "submit_agent_turn",
    status: "pending",
    dispatch_sequence: 1,
    payload: {
      attempt_id: "attempt-1",
      input_revision: 3,
      recipient_actor_ids: input.recipients,
      ...(inputManifest === undefined ? {} : { input_manifest: inputManifest }),
      ...(input.feedbackMessageId === undefined
        ? {}
        : { feedback_message_id: input.feedbackMessageId }),
      message: publicContextMessage(),
      ...(input.routed
        ? {
            public_context_message: publicContextMessage(),
            recipient_wakes: recipientWakes(),
          }
        : {}),
    },
    payload_hash: `hash-${input.id}`,
    created_at: "2030-01-01T00:00:00Z",
  };
};

const completedSubmitEffect = (input: {
  readonly id: string;
  readonly actorId: string;
  readonly agentId: string;
  readonly runId: string;
}): TaskEffect => ({
  ...submitEffect({
    id: input.id,
    recipients: [input.actorId],
    messageId: `message-${input.id}`,
    text: "Initial task",
    inputManifest: { room_id: "room-task" },
  }),
  status: "succeeded",
  observation: {
    participant_runs: [
      participantRun(input.actorId, input.agentId, input.runId),
    ],
    participant_terminals: [
      { agent_run_ref: input.runId, status: "succeeded" },
    ],
  },
});

const cleanupEffect = (status: "pending" | "dispatching"): TaskEffect =>
  cleanupEffectFor({
    id: "effect-cleanup",
    status,
    actorId: "actor-result",
    agentId: "agent-result",
    runId: "run-cleanup",
  });

const cleanupEffectFor = (input: {
  readonly id: string;
  readonly status: "pending" | "dispatching";
  readonly actorId: string;
  readonly agentId: string;
  readonly runId: string;
}): TaskEffect => ({
  id: input.id,
  root_operation_id: `root-${input.id}`,
  operation: "cleanup_runtime",
  status: input.status,
  dispatch_sequence: 1,
  payload: {
    actor_id: input.actorId,
    agent_management_id: input.agentId,
    agent_run_ref: input.runId,
    execution_context_ref: {
      kind: "alter_ego",
      agentId: input.agentId,
      taskId: "task-1",
    },
  },
  payload_hash: `hash-${input.id}`,
  created_at: "2030-01-01T00:00:00Z",
});

const responseLostCleanupEffect = (
  status: "pending" | "dispatching",
  source: TaskEffect,
): TaskEffect => ({
  id: "effect-response-lost-cleanup",
  root_operation_id: "root-effect-response-lost-cleanup",
  operation: "cleanup_runtime",
  status,
  dispatch_sequence: 1,
  payload: {
    actor_id: "actor-result",
    agent_management_id: "agent-result",
    execution_context_ref: {
      kind: "alter_ego",
      agentId: "agent-result",
      taskId: "task-1",
    },
    reconcile_submit: {
      source_effect_id: source.id,
      root_operation_id: source.root_operation_id,
      submit_payload: source.payload,
    },
  },
  payload_hash: "hash-effect-response-lost-cleanup",
  created_at: "2030-01-01T00:00:00Z",
});

const withWhitespaceTextSegment = (effect: TaskEffect): TaskEffect => {
  const payload = structuredClone(effect.payload);
  const appendSeparator = (message: unknown): void => {
    if (typeof message !== "object" || message === null) return;
    const segments = (message as { segments?: unknown }).segments;
    if (Array.isArray(segments)) {
      segments.push({ type: "text", content: " " });
    }
  };
  appendSeparator(payload.message);
  appendSeparator(payload.public_context_message);
  const manifest = payload.input_manifest;
  if (typeof manifest === "object" && manifest !== null) {
    appendSeparator(
      (manifest as { public_context_message?: unknown }).public_context_message,
    );
  }
  return { ...effect, payload };
};

const participantRun = (
  actorId: string,
  agentId: string,
  runId: string,
): Readonly<Record<string, string>> => ({
  actor_id: actorId,
  agent_management_id: agentId,
  agent_run_ref: runId,
});

const terminalObservation = (runId: string): LocalTurnObservation => ({
  runId,
  status: "succeeded",
  terminal: { type: "succeeded", finalResponse: "not Task output" },
});

const execution = (input: {
  readonly status?: TaskExecution["status"];
  readonly revision?: number;
  readonly participants: TaskExecution["participants"];
  readonly effects: TaskEffect[];
  readonly facts?: TaskExecution["execution_facts"];
  readonly desiredControl?: TaskExecution["desired_control"];
  readonly controlRevision?: number;
  readonly controlSettledRevision?: number;
}): TaskExecution => ({
  task_id: "task-1",
  generation: 1,
  status: input.status ?? "running",
  execution_revision: input.revision ?? 7,
  desired_control: input.desiredControl ?? "run",
  control_revision: input.controlRevision ?? 1,
  control_settled_revision: input.controlSettledRevision ?? 1,
  run_spec: {
    schema_version: 1,
    result_agent_actor_id: "actor-result",
    attempt_policy: {
      policy_version: 1,
      timeout_seconds: 1_800,
      max_retries: 3,
      retry_on_agent_failure: true,
      retry_on_timeout: true,
    },
  },
  participants: input.participants,
  pending_effects: input.effects,
  execution_facts: input.facts ?? [],
  execution_updated_at: "2030-01-01T00:00:00Z",
});

const taskLease = (): TaskWorkerLease => ({
  task_id: "task-1",
  worker_id: "worker-test",
  lease_token: "a".repeat(43),
  lease_generation: 1,
  lease_expires_at: "2030-01-01T00:00:15Z",
});

const cancelLocalRunMock = () => vi.fn(async () => "not_found" as const);

const cancelTrustedTurnMock = () =>
  vi.fn(async () => ({
    agentRunRef: "unused-local-run",
    cancelStatus: "not_found" as const,
  }));

describe("Task Worker idle loop", () => {
  const idleWorker = (
    claim: TeamHubTaskWorkerClient["claim"],
    pollIntervalMs = 500,
  ) =>
    createTaskWorker({
      client: {
        claim,
        get: vi.fn(),
        heartbeat: vi.fn(),
        transition: vi.fn(),
      },
      agentManager: {
        steerActiveTurn: vi.fn(async () => null),
        cancelLocalRun: cancelLocalRunMock(),
        cancelTrustedTurn: cancelTrustedTurnMock(),
        submitTrustedTurn: vi.fn(),
        observeTurn: vi.fn(),
      },
      pollIntervalMs,
      logger: { log: vi.fn(), child: vi.fn() },
    });

  it("waits the reported delay, or the idle cap without one", async () => {
    vi.useFakeTimers();
    const claim = vi
      .fn<TeamHubTaskWorkerClient["claim"]>()
      .mockResolvedValueOnce({ claimed: null, nextClaimDelayMs: 2_000 })
      .mockResolvedValue({ claimed: null });
    const worker = idleWorker(claim);
    try {
      worker.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(claim).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(claim).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(claim).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(claim).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(claim).toHaveBeenCalledTimes(3);
    } finally {
      await worker.close();
      vi.useRealTimers();
    }
  });

  it("does not lose a wake that arrives during an empty claim", async () => {
    vi.useFakeTimers();
    const current: { worker?: ReturnType<typeof idleWorker> } = {};
    const claim = vi
      .fn<TeamHubTaskWorkerClient["claim"]>()
      .mockImplementationOnce(async () => {
        current.worker!.wake();
        return { claimed: null };
      })
      .mockResolvedValue({ claimed: null });
    const worker = (current.worker = idleWorker(claim));
    try {
      worker.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(claim).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(claim).toHaveBeenCalledTimes(2);
      worker.wake();
      await vi.advanceTimersByTimeAsync(0);
      expect(claim).toHaveBeenCalledTimes(3);
    } finally {
      await worker.close();
      vi.useRealTimers();
    }
  });

  it("backs off after a failed claim and never spins on a zero delay", async () => {
    vi.useFakeTimers();
    const claim = vi
      .fn<TeamHubTaskWorkerClient["claim"]>()
      .mockRejectedValueOnce(new Error("TeamHub unavailable"))
      .mockResolvedValueOnce({ claimed: null, nextClaimDelayMs: 0 })
      .mockResolvedValue({ claimed: null });
    const worker = idleWorker(claim, 700);
    try {
      worker.start();
      await vi.advanceTimersByTimeAsync(699);
      expect(claim).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(claim).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(99);
      expect(claim).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(claim).toHaveBeenCalledTimes(3);
    } finally {
      await worker.close();
      vi.useRealTimers();
    }
  });

  it("caps a long reported delay at the idle wait", async () => {
    vi.useFakeTimers();
    const claim = vi
      .fn<TeamHubTaskWorkerClient["claim"]>()
      .mockResolvedValueOnce({ claimed: null, nextClaimDelayMs: 120_000 })
      .mockResolvedValue({ claimed: null });
    const worker = idleWorker(claim);
    try {
      worker.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(claim).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(claim).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(claim).toHaveBeenCalledTimes(2);
    } finally {
      await worker.close();
      vi.useRealTimers();
    }
  });

  it("closes promptly during the idle wait without claiming again", async () => {
    vi.useFakeTimers();
    const claim = vi
      .fn<TeamHubTaskWorkerClient["claim"]>()
      .mockResolvedValue({ claimed: null });
    const worker = idleWorker(claim);
    try {
      worker.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(claim).toHaveBeenCalledTimes(1);
      let closed = false;
      const closing = worker.close().then(() => {
        closed = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(closed).toBe(true);
      await closing;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(claim).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts a pending claim on close", async () => {
    const claim = vi.fn<TeamHubTaskWorkerClient["claim"]>(
      ({ signal }) =>
        new Promise((_, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const worker = idleWorker(claim);
    worker.start();
    await vi.waitFor(() => expect(claim).toHaveBeenCalledOnce());
    await worker.close();
    expect(claim.mock.calls[0]?.[0].signal?.aborted).toBe(true);
  });
});
