import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { runnerGatewayEnvelopeSchema } from "@linger/wire-contracts/runner-gateway/schema";

import {
  RUNNER_GATEWAY_FRAME_LIMITS,
  parseAgentToDaemonEnvelope,
  parseDaemonToAgentEnvelope,
  parseRunnerGatewayEnvelope,
} from "@linger/wire-contracts/runner-gateway/validator";
const contextExecution = {
  execution_context_key: "meta:agent-reviewer",
  runtime_instance_id: "meta:agent-reviewer",
  view_digest: "e".repeat(64),
} as const;
const contextRunContext = {
  execution_run_ref: "local-run-1",
  source_inbox_ids: ["inbox-message-1"],
} as const;
const contextViewRef = { view_digest: contextExecution.view_digest } as const;
const identity = {
  protocol_version: "2",
  host_access: "trusted" as const,
  tenant_id: "tenant-acme",
  registration_id: "registration-codex",
  assignment_revision: 2,
  runner_id: "runner-local",
  execution_context_key: contextExecution.execution_context_key,
  runtime_instance_id: contextExecution.runtime_instance_id,
  context_view_ref: contextViewRef,
  agent_id: "agent-reviewer",
  operation_id: "operation-1",
  connection_epoch: 7,
  runner_revision: 3,
  generation: 1,
  execution_lease_id: "lease-1",
  workspace_grant_id: "repo-main",
  runtime_type: "codex" as const,
};

const sessionOptions = {
  thread_name: "Reviewer",
};
const runtimeDiagnostics = [
  {
    type: "codex",
    status: "ready",
    protocol: "app-server",
    checked_at: "2026-07-27T00:00:00.000Z",
    version: "codex-cli 1.0.0",
    models: [],
  },
  {
    type: "claude",
    status: "authentication_required",
    protocol: "stream-json",
    checked_at: "2026-07-27T00:00:00.000Z",
    version: "claude-code 2.1.227",
    models: [],
    error: {
      code: "RUNTIME_AUTHENTICATION_REQUIRED",
      message: "Claude Code authentication is required",
    },
  },
] as const;
const runtime = { type: "codex" as const, model: "gpt-test" };
const session = { threadId: "thread-1" };
const input = { type: "text" as const, text: "Review this change" };
const runResources = {
  mcp_servers: [
    {
      name: "teamhub-tools",
      relay_url: "http://agent.test/internal/local-mcp/run-1",
      relay_token: "relay-token-that-is-at-least-thirty-two-bytes",
      tool_names: ["materialize_artifact"],
      expires_at: "2026-07-27T00:05:00.000Z",
    },
  ],
} as const;
const contextCommandIdentity = {
  protocol_version: "2",
  command_id: "context-command-1",
  tenant_id: identity.tenant_id,
  registration_id: identity.registration_id,
  assignment_revision: identity.assignment_revision,
  runner_id: identity.runner_id,
  agent_id: identity.agent_id,
  connection_epoch: identity.connection_epoch,
  runner_revision: identity.runner_revision,
  workspace_grant_id: identity.workspace_grant_id,
  execution_context_key: contextExecution.execution_context_key,
  runtime_instance_id: contextExecution.runtime_instance_id,
  view_digest: contextExecution.view_digest,
};
const agentRunnerIdentity = {
  protocol_version: "2",
  registration_id: identity.registration_id,
  assignment_revision: identity.assignment_revision,
  runner_id: "runner-local",
  tenant_id: "tenant-acme",
  agent_id: "agent-reviewer",
  connection_epoch: 7,
  runner_revision: 3,
};

const agentRunnerSnapshot = {
  registration_id: identity.registration_id,
  assignment_revision: identity.assignment_revision,
  runner_id: "runner-local",
  tenant_id: "tenant-acme",
  agent_id: "agent-reviewer",
  runner_revision: 3,
  state: "ready",
  runtime,
  workspace_grant_id: "repo-main",
  runner_pid: 123,
} as const;

const agentRunnerCommands = [
  {
    type: "agent_runner.ensure",
    ...agentRunnerIdentity,
    command_id: "command-runner-ensure",
    runtime,
    workspace_grant_id: "repo-main",
  },
  {
    type: "agent_runner.remove",
    ...agentRunnerIdentity,
    command_id: "command-runner-remove",
  },
  {
    type: "execute",
    kind: "cli_credential",
    ...agentRunnerIdentity,
    command_id: "command-cli-credential",
    profile: {
      url: "https://teamhub.example",
      tenant_id: "tenant-acme",
      agent_id: "agent-reviewer",
    },
    access_token: `th_agent_${"a".repeat(43)}`,
  },
] as const;

const agentRunnerResponses = [
  {
    type: "agent_runner.state",
    state: "ready",
    ...agentRunnerIdentity,
    command_id: "command-runner-ensure",
    runner_pid: 123,
  },
  {
    type: "agent_runner.state",
    state: "ready",
    ...agentRunnerIdentity,
    command_id: "command-runner-ensure",
    runner_pid: 123,
    cli_credential: {
      sha256: "a".repeat(64),
      assignment_revision: 1,
      profile: {
        url: "https://teamhub.example",
        tenant_id: "tenant-acme",
        agent_id: "agent-reviewer",
      },
    },
  },
  {
    type: "agent_runner.state",
    state: "removed",
    ...agentRunnerIdentity,
    command_id: "command-runner-remove",
  },
  {
    type: "agent_runner.state",
    state: "failed",
    ...agentRunnerIdentity,
    command_id: "command-runner-ensure",
    error: {
      code: "runtime_unavailable",
      message: "The configured runtime is unavailable",
      retryable: true,
    },
  },
  {
    type: "executed",
    kind: "cli_credential",
    outcome: "succeeded",
    ...agentRunnerIdentity,
    command_id: "command-cli-credential",
    sha256: "a".repeat(64),
  },
  {
    type: "executed",
    kind: "cli_credential",
    outcome: "failed",
    ...agentRunnerIdentity,
    command_id: "command-cli-credential",
    error: {
      code: "AGENT_CLI_CREDENTIAL_FAILED",
      message: "TeamHub CLI credential profile does not match its Agent",
      retryable: false,
    },
  },
] as const;

const sessionCompact = {
  type: "execute",
  kind: "session_compact",
  command_id: "command-compact",
  compact_id: "compact-1",
  protocol_version: "2",
  runner_id: "runner-local",
  connection_epoch: 7,
  agent_id: "agent-reviewer",
  runtime_type: "codex",
  execution_context_key: contextExecution.execution_context_key,
  instructions: "Keep open task ids.",
} as const;

const sessionCompacted = {
  type: "executed",
  kind: "session_compact",
  command_id: "command-compact",
  runner_id: "runner-local",
  compact_id: "compact-1",
  execution_context_key: contextExecution.execution_context_key,
  outcome: "compacted",
  pre_tokens: 120_000,
  duration_ms: 2_400,
} as const;

const modelInvoke = {
  type: "execute",
  kind: "model_invoke",
  command_id: "command-invoke",
  invoke_id: "invoke-1",
  protocol_version: "2",
  runner_id: "runner-local",
  connection_epoch: 7,
  tenant_id: "tenant-local",
  owner_actor_id: "human-owner",
  agent_id: "agent-another-me",
  runtime_type: "codex",
  mode: "structured",
  reasoning_effort: "low",
  instructions: "Summarize the day.",
  input: "Notes",
  output_schema: {
    type: "object",
    properties: { summary: { type: "string" } },
    required: ["summary"],
    additionalProperties: false,
  },
  timeout_ms: 120_000,
} as const;

const modelInvoked = {
  type: "executed",
  kind: "model_invoke",
  command_id: "command-invoke",
  runner_id: "runner-local",
  invoke_id: "invoke-1",
  outcome: "completed",
  text: '{"summary":"A quiet day."}',
  model: "fixture-model",
  runtime_version: "0.166.0",
  usage: { input_tokens: 13_000, cached_input_tokens: 0, output_tokens: 20 },
  duration_ms: 11_000,
} as const;

const computerPermissionIdentity = {
  protocol_version: "2",
  command_id: "command-computer-permission",
  runner_id: "runner-local",
  tenant_id: "tenant-acme",
  owner_actor_id: "actor-owner",
  connection_epoch: 7,
  expires_at: "2026-07-27T00:00:30.000Z",
} as const;
const computerPermission = {
  type: "execute",
  kind: "computer_permission",
  ...computerPermissionIdentity,
  action: "prompt",
  subject: "linger",
  permission: "screen_recording",
} as const;
const computerPermissionOutcomes = [
  {
    type: "executed",
    kind: "computer_permission",
    outcome: "succeeded",
    ...computerPermissionIdentity,
    action: "prompt",
    status: {
      platform: "darwin",
      host: "desktop",
      subjects: [
        {
          subject: "linger",
          permissions: [
            {
              id: "screen_recording",
              state: "denied",
              prompt: "available",
              relaunch_required: true,
            },
          ],
        },
      ],
    },
  },
  {
    type: "executed",
    kind: "computer_permission",
    outcome: "failed",
    ...computerPermissionIdentity,
    action: "relaunch",
    error: {
      code: "COMPUTER_PERMISSION_RELAUNCH_UNAVAILABLE",
      message: "Linger is not running this Computer",
      retryable: false,
    },
  },
] as const;

const operationStart = (request: object, suffix: string) => ({
  type: "operation.start",
  ...identity,
  command_id: `command-${suffix}`,
  request,
});

const requestFixtures = [
  {
    kind: "run.start",
    runtime,
    session_options: sessionOptions,
    session,
    input,
    run_context: contextRunContext,
    run_resources: runResources,
  },
] as const;

const contextCommands = [
  {
    type: "execute",
    kind: "debug_history",
    ...contextCommandIdentity,
    command_id: "debug-command-1",
    request: {
      runtime,
      session,
    },
  },
] as const;

const contextResponses = [
  {
    type: "executed",
    kind: "debug_history",
    ...contextCommandIdentity,
    command_id: "debug-command-1",
    result: {
      status: "available",
      provider_kind: "codex",
      source: "codex_rollout",
      snapshot: {
        id: "snapshot-1",
        thread_id: "thread-1",
        captured_at: "2026-08-24T12:00:00.000Z",
        record_count: 1,
        tail_state: "clean",
      },
      instructions: {
        status: "available",
        source: "codex_rollout",
        blocks: [],
      },
      records: [
        {
          ordinal: 0,
          category: "lifecycle",
          native_type: "session_meta",
          native_record: { type: "session_meta" },
          redacted_fields: [],
        },
      ],
    },
  },
] as const;

const agentToDaemonFixtures = [
  {
    type: "runner.welcome",
    protocol_version: "2",
    runner_id: "runner-local",
    connection_id: "connection-1",
    connection_epoch: 7,
    heartbeat_interval_ms: 10_000,
    reconcile_operation_ids: ["operation-1"],
  },
  ...requestFixtures.map((request, index) =>
    operationStart(request, `start-${index}`),
  ),
  {
    type: "operation.input",
    ...identity,
    input_context_view_ref: contextViewRef,
    command_id: "command-context-input",
    expected_turn_id: "turn-context-1",
    input,
  },
  {
    type: "cancel",
    target: "operation",
    ...identity,
    command_id: "command-cancel",
    reason: "operator requested stop",
  },
  {
    type: "operation.ack",
    ...identity,
    command_id: "command-ack",
    through_seq: 4,
  },
  ...agentRunnerCommands,
  ...contextCommands,
  sessionCompact,
  modelInvoke,
  computerPermission,
] as const;

const runEventFixtures = [
  { type: "run.started", turn_id: "turn-1" },
  { type: "status.changed", status: "thinking" },
  {
    type: "plan.updated",
    explanation: "Follow the critical path",
    steps: [
      { content: "Inspect", status: "completed" },
      { content: "Implement", status: "in_progress" },
      { content: "Verify", status: "pending" },
      { content: "Discarded option", status: "canceled" },
    ],
  },
  { type: "message.delta", message_id: "message-1", delta: "Done" },
  {
    type: "tool.called",
    call_id: "call-1",
    tool_name: "shell",
    input: { command: "git status" },
  },
  {
    type: "tool.returned",
    call_id: "call-1",
    tool_name: "shell",
    output: { exit_code: 0 },
    is_error: false,
    observed_at_unix_ms: 1_700_000_000_500,
  },
  {
    type: "model.responded",
    started_at_unix_ms: 1_700_000_000_000,
    first_item_at_unix_ms: 1_700_000_000_400,
    responded_at_unix_ms: 1_700_000_001_000,
    granularity: "block",
    model: "fixture-model",
    message_id: "msg_1",
    usage: { input: 3, cache_read: 2, cache_write: 0, output: 5, reasoning: 1 },
    agent: { id: "toolu_1", parent_call_id: "toolu_1" },
  },
  { type: "file.created", path: "created.txt" },
  { type: "file.updated", path: "updated.txt" },
  { type: "file.deleted", path: "deleted.txt" },
  { type: "run.completed" },
  { type: "run.failed", message: "fixture failure" },
] as const;

const resultFixtures = [
  { type: "run", final_response: "Done", session },
] as const;

const daemonToAgentFixtures = [
  {
    type: "runner.hello",
    protocol_version: "2",
    daemon_version: "0.43.0",
    platform: "darwin",
    runner_id: "runner-local",
    connection_nonce: "nonce-1",
    sent_at: "2026-07-27T00:00:00.000Z",
    daemon_identity: {
      daemon_id: "A".repeat(43),
      public_key: Buffer.alloc(32).toString("base64"),
      identity_version: 1,
      proof: Buffer.alloc(64).toString("base64"),
    },
    runtime_registrations: [],
    capabilities: ["browser_connection", "computer_permissions"],
    capacity: 2,
    runtimes: ["codex", "claude"],
    runtime_diagnostics: runtimeDiagnostics,
    workspace_grants: [
      {
        grant_id: "repo-main",
        tenant_id: "tenant-acme",
        mode: "workspace-write",
      },
    ],
    agent_runners: [agentRunnerSnapshot],
    active_operations: [
      {
        protocol_version: "2",
        host_access: "trusted",
        tenant_id: "tenant-acme",
        registration_id: identity.registration_id,
        assignment_revision: identity.assignment_revision,
        runner_id: "runner-local",
        execution_context_key: contextExecution.execution_context_key,
        runtime_instance_id: contextExecution.runtime_instance_id,
        context_view_ref: contextViewRef,
        agent_id: "agent-reviewer",
        operation_id: "operation-1",
        connection_epoch: 7,
        runner_revision: 3,
        generation: 1,
        execution_lease_id: "lease-1",
        workspace_grant_id: "repo-main",
        runtime_type: "codex",
        kind: "run.start",
        last_emitted_seq: 3,
        last_acked_seq: 2,
      },
    ],
  },
  {
    type: "runner.heartbeat",
    protocol_version: "2",
    runner_id: "runner-local",
    sent_at: "2026-07-27T00:00:01.000Z",
    active_operation_ids: ["operation-1"],
  },
  {
    type: "runner.runtime_diagnostics",
    protocol_version: "2",
    runner_id: "runner-local",
    sent_at: "2026-07-27T00:00:02.000Z",
    revision: 1,
    runtime_diagnostics: runtimeDiagnostics,
  },
  {
    type: "operation.accepted",
    ...identity,
    seq: 1,
    command_id: "command-start-1",
    runner_pid: 123,
    runtime_pid: 124,
    session,
  },
  ...runEventFixtures.map((event, index) => ({
    type: "operation.event",
    ...identity,
    seq: index + 1,
    event,
  })),
  {
    type: "operation.input_result",
    outcome: "accepted",
    ...identity,
    seq: 12,
    command_id: "command-input",
    turn_id: "turn-1",
  },
  {
    type: "operation.input_result",
    outcome: "rejected",
    ...identity,
    seq: 13,
    command_id: "command-stale-input",
    expected_turn_id: "turn-stale",
    actual_turn_id: "turn-1",
    effect: "definitely_not_applied",
    reason: "target_mismatch",
    message: "The active turn does not match the input target",
  },
  ...resultFixtures.map((result, index) => ({
    type: "operation.completed",
    ...identity,
    seq: index + 20,
    result,
  })),
  {
    type: "operation.failed",
    ...identity,
    seq: 30,
    error: {
      code: "runtime_failed",
      message: "fixture failure",
      retryable: false,
    },
  },
  {
    type: "operation.cancelled",
    ...identity,
    seq: 31,
    reason: "operator requested stop",
  },
  ...agentRunnerResponses,
  ...contextResponses,
  sessionCompacted,
  modelInvoked,
  ...computerPermissionOutcomes,
] as const;

const withoutProperty = (
  value: object,
  property: string,
): Record<string, unknown> => {
  const copy = { ...value } as Record<string, unknown>;
  delete copy[property];
  return copy;
};

const invalidRequestFixtures = requestFixtures.map((request, index) =>
  operationStart(
    withoutProperty(request, "run_context"),
    `invalid-request-${index}`,
  ),
);

const invalidRunEventFixtures = runEventFixtures.map((event, index) => ({
  type: "operation.event",
  ...identity,
  seq: index + 1,
  event:
    event.type === "run.started"
      ? withoutProperty(event, "turn_id")
      : event.type === "run.completed"
        ? { ...event, unexpected: true }
        : withoutProperty(
            event,
            event.type === "message.delta"
              ? "delta"
              : event.type === "status.changed"
                ? "status"
                : event.type === "plan.updated"
                  ? "steps"
                  : event.type === "tool.called"
                    ? "input"
                    : event.type === "tool.returned"
                      ? "output"
                      : event.type === "model.responded"
                        ? "usage"
                        : event.type === "run.failed"
                          ? "message"
                          : "path",
          ),
}));

const invalidResultFixtures = resultFixtures.map((result, index) => ({
  type: "operation.completed",
  ...identity,
  seq: index + 1,
  result: withoutProperty(result, "final_response"),
}));

describe("Runner Gateway contract", () => {
  it("requires protocol 2 trusted-host Operations and carries the update target", () => {
    const hello = parseDaemonToAgentEnvelope({
      ...daemonToAgentFixtures[0],
      active_operations: [],
    });
    expect(hello).toMatchObject({
      type: "runner.hello",
      protocol_version: "2",
      capabilities: ["browser_connection", "computer_permissions"],
    });
    for (const capability of ["turn", "self_update_v2"]) {
      expect(() =>
        parseDaemonToAgentEnvelope({ ...hello, capabilities: [capability] }),
      ).toThrow("Invalid Runner Gateway envelope");
    }

    const archive = { sha256: "a".repeat(64), size: 1 };
    const targetRelease = {
      targets: { "linux-x64": { app: archive, deps: archive } },
    };
    expect(
      parseAgentToDaemonEnvelope({
        ...agentToDaemonFixtures[0],
        target_release: targetRelease,
      }),
    ).toMatchObject({ type: "runner.welcome", target_release: targetRelease });
    expect(() =>
      parseAgentToDaemonEnvelope({
        ...agentToDaemonFixtures[0],
        target_release: {
          ...targetRelease,
          targets: { "freebsd-x64": { app: archive, deps: archive } },
        },
      }),
    ).toThrow();

    const trustedOperation = {
      ...operationStart(requestFixtures[0], "trusted-host"),
      protocol_version: "2",
      host_access: "trusted",
    };
    expect(parseAgentToDaemonEnvelope(trustedOperation)).toMatchObject({
      type: "operation.start",
      protocol_version: "2",
      host_access: "trusted",
    });

    const active = {
      ...withoutProperty(
        withoutProperty(withoutProperty(trustedOperation, "type"), "request"),
        "command_id",
      ),
      kind: "run.start",
      last_emitted_seq: 2,
      last_acked_seq: 1,
    };
    const reconnect = { ...hello, active_operations: [active] };
    expect(parseDaemonToAgentEnvelope(reconnect)).toMatchObject({
      active_operations: [{ host_access: "trusted" }],
    });
    for (const invalid of [
      withoutProperty(active, "host_access"),
      { ...active, host_access: "managed" },
      { ...active, protocol_version: "1.2" },
      { ...active, unexpected: true },
      { ...active, last_acked_seq: 3 },
    ]) {
      expect(() =>
        parseDaemonToAgentEnvelope({
          ...reconnect,
          active_operations: [invalid],
        }),
      ).toThrow("Invalid Runner Gateway envelope");
    }

    expect(() =>
      parseAgentToDaemonEnvelope({
        ...operationStart(requestFixtures[0], "older-protocol"),
        protocol_version: "1.2",
      }),
    ).toThrow("Invalid Runner Gateway envelope");
  });

  it("requires the current Runtime Assignment and trusted host identity on Operations", () => {
    const operations = [
      ...agentToDaemonFixtures,
      ...daemonToAgentFixtures,
    ].filter(({ type }) => type.startsWith("operation."));
    for (const envelope of operations) {
      for (const field of [
        "registration_id",
        "assignment_revision",
        "host_access",
      ]) {
        expect(() =>
          parseRunnerGatewayEnvelope(withoutProperty(envelope, field)),
        ).toThrow("Invalid Runner Gateway envelope");
      }
      for (const protocol_version of ["1.0", "1.1"]) {
        expect(() =>
          parseRunnerGatewayEnvelope({ ...envelope, protocol_version }),
        ).toThrow("Invalid Runner Gateway envelope");
      }
    }
    const hello = daemonToAgentFixtures[0];
    for (const field of ["registration_id", "assignment_revision"]) {
      expect(() =>
        parseDaemonToAgentEnvelope({
          ...hello,
          active_operations: [
            withoutProperty(hello.active_operations[0], field),
          ],
        }),
      ).toThrow("Invalid Runner Gateway envelope");
    }
  });

  it("requires registered live Context control while preserving detached history inspection", () => {
    for (const envelope of [...contextCommands, ...contextResponses]) {
      expect(envelope.protocol_version).toBe("2");
      for (const field of ["registration_id", "assignment_revision"]) {
        expect(() =>
          parseRunnerGatewayEnvelope(withoutProperty(envelope, field)),
        ).toThrow("Invalid Runner Gateway envelope");
      }
    }
    const detached = Object.fromEntries(
      Object.entries(contextCommands.at(-1)!).filter(
        ([field]) =>
          ![
            "registration_id",
            "assignment_revision",
            "runner_revision",
            "view_digest",
          ].includes(field),
      ),
    );
    expect(
      parseAgentToDaemonEnvelope({ ...detached, detached_history: true }),
    ).toMatchObject({
      type: "execute",
      kind: "debug_history",
      detached_history: true,
    });
  });

  it("requires registered live Agent Runner commands and preserves unfenced removal", () => {
    const live = [...agentRunnerCommands, ...agentRunnerResponses].filter(
      (envelope) =>
        envelope.type !== "agent_runner.remove" &&
        !("state" in envelope && envelope.state !== "ready"),
    );
    for (const envelope of live) {
      for (const field of ["registration_id", "assignment_revision"]) {
        expect(() =>
          parseRunnerGatewayEnvelope(withoutProperty(envelope, field)),
        ).toThrow("Invalid Runner Gateway envelope");
      }
    }
    const removed = withoutProperty(
      withoutProperty(agentRunnerCommands[1], "registration_id"),
      "assignment_revision",
    );
    expect(parseAgentToDaemonEnvelope(removed)).toMatchObject({
      type: "agent_runner.remove",
    });
  });

  it("accepts every Agent-to-Daemon command and operation request kind", () => {
    for (const envelope of agentToDaemonFixtures) {
      expect(parseAgentToDaemonEnvelope(envelope)).toEqual(envelope);
      expect(parseRunnerGatewayEnvelope(envelope)).toEqual(envelope);
    }
  });

  it("accepts every Daemon-to-Agent event, run event, and result kind", () => {
    for (const envelope of daemonToAgentFixtures) {
      expect(parseDaemonToAgentEnvelope(envelope)).toEqual(envelope);
      expect(parseRunnerGatewayEnvelope(envelope)).toEqual(envelope);
    }
  });

  it.each([
    ["linger_instruction_snapshot", "system_prompt_append"],
    ["attachment.prompt_snapshot", "systemPrompt"],
    ["future_provider_instruction", "future_field"],
    ["r".repeat(256), "f".repeat(256)],
  ])(
    "accepts dynamic Debug instruction sources %s / %s",
    (recordType, field) => {
      const response = contextResponses.at(-1)!;
      const envelope = {
        ...response,
        result: {
          ...response.result,
          provider_kind: "claude",
          source: "claude_transcript",
          instructions: {
            status: "available",
            source: "claude_transcript",
            blocks: [
              {
                record_ordinal: 0,
                record_type: recordType,
                field,
                text: "Persisted prompt",
              },
            ],
          },
        },
      };
      expect(parseDaemonToAgentEnvelope(envelope)).toEqual(envelope);
    },
  );

  it.each(["record_type", "field"])(
    "keeps Debug instruction %s bounded and typed",
    (property) => {
      const response = contextResponses.at(-1)!;
      for (const invalid of ["", "x".repeat(257), 12, null, {}]) {
        expect(() =>
          parseDaemonToAgentEnvelope({
            ...response,
            result: {
              ...response.result,
              instructions: {
                status: "available",
                source: "codex_rollout",
                blocks: [
                  {
                    record_ordinal: 0,
                    record_type: "session_meta",
                    field: "base_instructions",
                    text: "Persisted prompt",
                    [property]: invalid,
                  },
                ],
              },
            },
          }),
        ).toThrow("Invalid Runner Gateway envelope");
      }
    },
  );

  it("rejects every envelope sent in the wrong protocol direction", () => {
    for (const envelope of agentToDaemonFixtures) {
      expect(() => parseDaemonToAgentEnvelope(envelope)).toThrow(
        "DaemonToAgentEnvelope",
      );
    }
    for (const envelope of daemonToAgentFixtures) {
      expect(() => parseAgentToDaemonEnvelope(envelope)).toThrow(
        "AgentToDaemonEnvelope",
      );
    }
  });

  it("rejects a malformed fixture for every command, request, event, and result variant", () => {
    const malformed = [
      ...agentToDaemonFixtures.map((envelope) =>
        withoutProperty(envelope, "type"),
      ),
      ...daemonToAgentFixtures.map((envelope) =>
        withoutProperty(envelope, "type"),
      ),
      ...invalidRequestFixtures,
      ...invalidRunEventFixtures,
      ...invalidResultFixtures,
    ];

    for (const envelope of malformed) {
      expect(() => parseRunnerGatewayEnvelope(envelope)).toThrow(
        "Invalid Runner Gateway envelope",
      );
    }
  });

  it("rejects unknown versions, arbitrary paths, invalid identities, and sequences", () => {
    const invalid = [
      {
        ...daemonToAgentFixtures[1],
        protocol_version: "2.0",
      },
      {
        ...operationStart(requestFixtures[0], "path"),
        workspace_path: "/tmp/not-allowed",
      },
      {
        ...operationStart(requestFixtures[0], "room-v10"),
        protocol_version: "1.0",
      },
      {
        ...operationStart(requestFixtures[0], "context-v10"),
        protocol_version: "1.0",
      },
      {
        ...operationStart(requestFixtures[0], "context-room"),
        room_id: "room-main",
      },
      withoutProperty(
        agentToDaemonFixtures.find(
          (fixture) => fixture.command_id === "command-context-input",
        )!,
        "input_context_view_ref",
      ),
      withoutProperty(
        operationStart(requestFixtures[0], "no-context"),
        "execution_context_key",
      ),
      {
        ...daemonToAgentFixtures[2],
        runner_id: "contains a space",
      },
      {
        type: "operation.event",
        ...identity,
        seq: 0,
        event: { type: "run.started", turn_id: "turn-1" },
      },
      { type: "unknown", protocol_version: "1.0" },
    ];

    for (const envelope of invalid) {
      expect(() => parseRunnerGatewayEnvelope(envelope)).toThrow(
        "Invalid Runner Gateway envelope",
      );
    }
  });

  it("rejects retired sandbox options, runtime mismatch, missing command id, and impossible reconnect state", () => {
    const invalid = [
      operationStart(
        {
          ...requestFixtures[0],
          session_options: {
            ...sessionOptions,
            sandbox_mode: "danger-full-access",
          },
        },
        "unsafe-sandbox",
      ),
      {
        ...operationStart(requestFixtures[0], "runtime-mismatch"),
        runtime_type: "claude",
      },
      withoutProperty(agentToDaemonFixtures.at(-1)!, "command_id"),
      withoutProperty(
        daemonToAgentFixtures.find(
          (fixture) => fixture.type === "operation.accepted",
        )!,
        "seq",
      ),
      withoutProperty(
        daemonToAgentFixtures.find(
          (fixture) =>
            fixture.type === "operation.input_result" &&
            fixture.outcome === "accepted",
        )!,
        "seq",
      ),
      withoutProperty(
        daemonToAgentFixtures.find(
          (fixture) =>
            fixture.type === "operation.input_result" &&
            fixture.outcome === "rejected",
        )!,
        "seq",
      ),
      {
        ...daemonToAgentFixtures[0],
        sent_at: "not-a-time",
      },
      {
        ...daemonToAgentFixtures[0],
        active_operations: [
          {
            ...daemonToAgentFixtures[0].active_operations[0],
            last_emitted_seq: 1,
            last_acked_seq: 2,
          },
        ],
      },
      {
        ...daemonToAgentFixtures[0],
        active_operations: [
          {
            ...daemonToAgentFixtures[0].active_operations[0],
            runner_id: "runner-other",
          },
        ],
      },
      {
        ...daemonToAgentFixtures[0],
        agent_runners: [
          {
            ...agentRunnerSnapshot,
            runner_id: "runner-other",
          },
        ],
      },
      {
        ...daemonToAgentFixtures[0],
        agent_runners: [agentRunnerSnapshot, agentRunnerSnapshot],
      },
      {
        ...daemonToAgentFixtures.find(
          (fixture) => fixture.type === "operation.accepted",
        )!,
        seq: Number.MAX_SAFE_INTEGER + 1,
      },
      {
        ...agentToDaemonFixtures[2],
        generation: Number.MAX_SAFE_INTEGER + 1,
      },
    ];

    for (const [index, envelope] of invalid.entries()) {
      expect(
        () => parseRunnerGatewayEnvelope(envelope),
        `invalid reconnect envelope #${index}`,
      ).toThrow("Invalid Runner Gateway envelope");
    }
  });

  it("requires fencing identity on every Agent Runner command and response", () => {
    for (const field of [
      "runner_id",
      "tenant_id",
      "agent_id",
      "connection_epoch",
      "runner_revision",
    ]) {
      for (const envelope of [
        ...agentRunnerCommands,
        ...agentRunnerResponses,
      ]) {
        expect(() =>
          parseRunnerGatewayEnvelope(withoutProperty(envelope, field)),
        ).toThrow("Invalid Runner Gateway envelope");
      }
    }
  });

  it("requires runtime and workspace grant on self-contained Agent Runner desired commands", () => {
    for (const field of ["runtime", "workspace_grant_id"]) {
      expect(() =>
        parseAgentToDaemonEnvelope(
          withoutProperty(agentRunnerCommands[0], field),
        ),
      ).toThrow("Invalid Runner Gateway envelope");
    }

    expect(() =>
      parseAgentToDaemonEnvelope({
        ...agentRunnerCommands[1],
        runtime,
        workspace_grant_id: "repo-main",
      }),
    ).toThrow("Invalid Runner Gateway envelope");
  });

  it("accepts native session compaction only for a parked Codex or Claude process", () => {
    expect(
      parseAgentToDaemonEnvelope(
        withoutProperty(sessionCompact, "instructions"),
      ),
    ).toMatchObject({ type: "execute", kind: "session_compact" });
    for (const invalid of [
      { ...sessionCompact, runtime_type: "pi" },
      { ...sessionCompact, protocol_version: "1.2" },
      { ...sessionCompact, instructions: "" },
      { ...sessionCompact, instructions: "x".repeat(8_193) },
      { ...sessionCompact, session: session },
    ]) {
      expect(() => parseAgentToDaemonEnvelope(invalid)).toThrow(
        "Invalid Runner Gateway envelope",
      );
    }
    for (const outcome of ["nothing_to_compact", "no_process", "canceled"]) {
      expect(
        parseDaemonToAgentEnvelope({
          ...withoutProperty(sessionCompacted, "pre_tokens"),
          outcome,
        }),
      ).toMatchObject({ outcome });
    }
    expect(
      parseDaemonToAgentEnvelope({
        ...sessionCompacted,
        outcome: "failed",
        reason: "Runtime compaction failed",
      }),
    ).toMatchObject({ outcome: "failed" });
    for (const invalid of [
      { ...sessionCompacted, outcome: "interrupted" },
      { ...sessionCompacted, reason: "x".repeat(513) },
      { ...sessionCompacted, session: session },
    ]) {
      expect(() => parseDaemonToAgentEnvelope(invalid)).toThrow(
        "Invalid Runner Gateway envelope",
      );
    }
  });

  it("accepts one-shot model invocations on Codex or Claude only", () => {
    expect(
      parseAgentToDaemonEnvelope({ ...modelInvoke, timeout_ms: 14_400_000 }),
    ).toMatchObject({ timeout_ms: 14_400_000 });
    expect(
      parseAgentToDaemonEnvelope({
        ...withoutProperty(
          withoutProperty(modelInvoke, "instructions"),
          "output_schema",
        ),
        mode: "workspace",
        runtime_type: "claude",
        workspace_files: [{ path: "raw/notes.md", content_base64: "bm90ZXM=" }],
      }),
    ).toMatchObject({
      type: "execute",
      kind: "model_invoke",
      mode: "workspace",
    });
    for (const invalid of [
      { ...modelInvoke, runtime_type: "pi" },
      { ...modelInvoke, protocol_version: "1.2" },
      { ...modelInvoke, mode: "agent" },
      { ...modelInvoke, reasoning_effort: "xhigh" },
      { ...modelInvoke, input: "" },
      { ...modelInvoke, timeout_ms: 999 },
      { ...modelInvoke, timeout_ms: 14_400_001 },
      { ...modelInvoke, model: "gpt-5" },
      { ...modelInvoke, execution_context_key: "context-1" },
      withoutProperty(modelInvoke, "owner_actor_id"),
      withoutProperty(modelInvoke, "reasoning_effort"),
      {
        ...modelInvoke,
        workspace_files: [{ path: "", content_base64: "" }],
      },
    ]) {
      expect(() => parseAgentToDaemonEnvelope(invalid)).toThrow(
        "Invalid Runner Gateway envelope",
      );
    }
    for (const outcome of [
      "timed_out",
      "canceled",
      "unavailable",
      "runtime_unavailable",
      "auth_required",
      "runtime_incompatible",
      "failed",
    ]) {
      expect(
        parseDaemonToAgentEnvelope({
          type: "executed",
          kind: "model_invoke",
          command_id: "command-invoke",
          runner_id: "runner-local",
          invoke_id: "invoke-1",
          outcome,
          reason: "Model invocation did not complete",
          duration_ms: 1,
        }),
      ).toMatchObject({ outcome });
    }
    for (const invalid of [
      { ...modelInvoked, outcome: "compacted" },
      { ...modelInvoked, reason: "x".repeat(513) },
      { ...modelInvoked, usage: { input_tokens: 1 } },
      { ...modelInvoked, text: "x".repeat(1_048_577) },
    ]) {
      expect(() => parseDaemonToAgentEnvelope(invalid)).toThrow(
        "Invalid Runner Gateway envelope",
      );
    }
  });

  it("accepts only well-formed Agent CLI credential pushes", () => {
    const put = agentRunnerCommands[2];
    expect(() => parseAgentToDaemonEnvelope(put)).not.toThrow();
    for (const invalid of [
      { ...put, access_token: "th_user_" + "a".repeat(43) },
      { ...put, access_token: `th_agent_${"a".repeat(42)}` },
      { ...put, purpose: "business" },
      { ...put, profile: { ...put.profile, url: "ftp://teamhub.example" } },
    ]) {
      expect(() => parseAgentToDaemonEnvelope(invalid)).toThrow(
        "Invalid Runner Gateway envelope",
      );
    }
  });

  it("keeps remote Agent Runner messages free of host execution authority", () => {
    for (const field of [
      "executable",
      "path",
      "credential",
      "executable_path",
      "runtime_path",
      "credential_path",
    ]) {
      expect(() =>
        parseAgentToDaemonEnvelope({
          ...agentRunnerCommands[0],
          [field]: "/tmp/remote-authority",
        }),
      ).toThrow("Invalid Runner Gateway envelope");
      expect(() =>
        parseDaemonToAgentEnvelope({
          ...daemonToAgentFixtures[0],
          agent_runners: [
            {
              ...agentRunnerSnapshot,
              [field]: "/tmp/remote-authority",
            },
          ],
        }),
      ).toThrow("Invalid Runner Gateway envelope");
    }
  });

  it("accepts large textual tool results within the frame budget without relaxing tool inputs", () => {
    const envelope = {
      type: "operation.event",
      ...identity,
      seq: 17,
      event: {
        type: "tool.returned",
        call_id: "call-large-output",
        tool_name: "exec_command",
        output: "x".repeat(311_431),
        is_error: false,
      },
    };
    expect(parseDaemonToAgentEnvelope(envelope)).toEqual(envelope);
    expect(() =>
      parseDaemonToAgentEnvelope({
        ...envelope,
        event: { ...envelope.event, output: { text: envelope.event.output } },
      }),
    ).toThrow("Invalid Runner Gateway envelope");
    expect(() =>
      parseDaemonToAgentEnvelope({
        ...envelope,
        event: {
          type: "tool.called",
          call_id: "call-large-input",
          tool_name: "exec_command",
          input: envelope.event.output,
        },
      }),
    ).toThrow("Invalid Runner Gateway envelope");
  });

  it("enforces byte, depth, collection, and total-node frame limits", () => {
    const eventWithOutput = (output: unknown) => ({
      type: "operation.event",
      ...identity,
      seq: 1,
      event: {
        type: "tool.returned",
        call_id: "call-1",
        tool_name: "shell",
        output,
        is_error: false,
      },
    });
    let tooDeep: unknown = null;
    for (
      let depth = 0;
      depth <= RUNNER_GATEWAY_FRAME_LIMITS.maxDepth;
      depth += 1
    ) {
      tooDeep = { value: tooDeep };
    }
    const tooManyNodes = Array.from(
      { length: RUNNER_GATEWAY_FRAME_LIMITS.maxArrayItems },
      () => Array.from({ length: 64 }, () => null),
    );
    const invalid = [
      eventWithOutput("x".repeat(RUNNER_GATEWAY_FRAME_LIMITS.maxBytes)),
      eventWithOutput(tooDeep),
      eventWithOutput(
        Array.from(
          { length: RUNNER_GATEWAY_FRAME_LIMITS.maxArrayItems + 1 },
          () => null,
        ),
      ),
      eventWithOutput(
        Object.fromEntries(
          Array.from(
            {
              length: RUNNER_GATEWAY_FRAME_LIMITS.maxObjectProperties + 1,
            },
            (_, index) => [`key-${index}`, null],
          ),
        ),
      ),
      eventWithOutput(tooManyNodes),
    ];

    for (const envelope of invalid) {
      expect(() => parseDaemonToAgentEnvelope(envelope)).toThrow(
        "Invalid Runner Gateway envelope",
      );
    }
  });
});

describe("failure diagnostics rolling upgrade", () => {
  const envelope = JSON.parse(
    readFileSync(
      new URL(
        "../contracts/runner-gateway/fixtures/failure-diagnostics.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const oldError = { ...envelope.error };
  delete oldError.diagnostics;

  it("proves the pre-195 error schema rejects diagnostics", () => {
    const schema = JSON.parse(JSON.stringify(runnerGatewayEnvelopeSchema));
    // OperationFailed.error from b782317de, before diagnostics was added.
    schema.$defs.OperationFailed.allOf[1].properties.error = {
      type: "object",
      additionalProperties: false,
      required: ["code", "message", "retryable"],
      properties: {
        code: { $ref: "#/$defs/Id" },
        message: { type: "string", minLength: 1, maxLength: 4000 },
        retryable: { type: "boolean" },
        failure: { $ref: "#/$defs/RuntimeExecutionFailure" },
      },
    };
    const wireRequire = createRequire(
      import.meta.resolve("@linger/wire-contracts/runner-gateway/validator"),
    );
    const { Ajv2020 } = wireRequire("ajv/dist/2020.js");
    const addFormats = wireRequire("ajv-formats");
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    ajv.addSchema(schema);
    const validate = ajv.compile({
      $ref: schema.$id + "#/$defs/OperationFailed",
    });
    expect(validate({ ...envelope, error: oldError })).toBe(true);
    expect(validate(envelope)).toBe(false);
    expect(validate.errors).toContainEqual(
      expect.objectContaining({
        instancePath: "/error",
        keyword: "additionalProperties",
        params: { additionalProperty: "diagnostics" },
      }),
    );
  });

  it("accepts explicit diagnostics and absent diagnostics in the new schema", () => {
    expect(parseDaemonToAgentEnvelope(envelope)).toEqual(envelope);
    expect(
      parseDaemonToAgentEnvelope({ ...envelope, error: oldError }),
    ).toEqual({ ...envelope, error: oldError });
  });

  it.each([
    { statusCode: 99 },
    { statusCode: 600 },
    { statusCode: 429.5 },
    { exitCode: 2147483648 },
    { signal: "killed" },
    { code: "raw error text" },
    { message: "private text" },
  ])(
    "rejects invalid diagnostics %j without loosening the schema",
    (invalid) => {
      expect(() =>
        parseDaemonToAgentEnvelope({
          ...envelope,
          error: { ...envelope.error, diagnostics: invalid },
        }),
      ).toThrow();
    },
  );

  it("continues rejecting unknown error fields", () => {
    expect(() =>
      parseDaemonToAgentEnvelope({
        ...envelope,
        error: { ...envelope.error, unexpected: true },
      }),
    ).toThrow();
  });
});
