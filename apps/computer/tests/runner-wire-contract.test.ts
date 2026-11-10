import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { runnerGatewayEnvelopeSchema } from "@linger/wire-contracts/runner-gateway/schema";
import {
  parseAgentToDaemonEnvelope,
  parseDaemonToAgentEnvelope,
} from "@linger/wire-contracts/runner-gateway/validator";
import { expect, it } from "vitest";

const assignment = {
  protocol_version: "2",
  tenant_id: "tenant-1",
  runner_id: "computer-1",
  agent_id: "agent-1",
  registration_id: "registration-1",
  assignment_revision: 1,
  connection_epoch: 1,
  runner_revision: 1,
};
const viewRef = { view_digest: "a".repeat(64) };
const context = {
  ...assignment,
  protocol_version: "2",
  command_id: "context-1",
  workspace_grant_id: "grant-1",
  execution_context_key: "meta:agent-1",
  runtime_instance_id: "runtime-1",
  view_digest: viewRef.view_digest,
};
const operation = {
  ...assignment,
  host_access: "trusted",
  operation_id: "operation-1",
  generation: 1,
  execution_lease_id: "lease-1",
  workspace_grant_id: "grant-1",
  runtime_type: "codex",
  execution_context_key: context.execution_context_key,
  runtime_instance_id: context.runtime_instance_id,
  context_view_ref: viewRef,
};
const runtime = { type: "codex", model: "fixture-model" };
const sessionOptions = { thread_name: "Wire contract" };
const session = { threadId: "thread-1" };
const input = { type: "text", text: "Continue" };
const localCapability = {
  protocol_version: "2",
  command_id: "capability-1",
  runner_id: assignment.runner_id,
  tenant_id: assignment.tenant_id,
  owner_actor_id: "owner-1",
  connection_epoch: 1,
  expires_at: "2026-11-01T00:00:00Z",
};

const agentFrames = [
  {
    type: "execute",
    kind: "computer_tool",
    protocol_version: "2",
    command_id: "live-tools-1",
    runner_id: "computer-1",
    connection_epoch: 1,
    tenant_id: "tenant-1",
    owner_actor_id: "owner-1",
    agent_id: "agent-1",
    tool_session_id: "voice-1",
    server: "task_files",
    tool_name: "list_files",
    arguments: {},
    deadline_ms: 60_000,
    task_scope: {
      version: 1,
      tenant_id: "tenant-1",
      agent_id: "agent-1",
      origin_room_id: "room-1",
      role: "alter_ego",
      task_id: "task-1",
    },
  },
  {
    type: "runner.welcome",
    protocol_version: "2",
    runner_id: assignment.runner_id,
    connection_id: "connection-1",
    connection_epoch: 1,
    heartbeat_interval_ms: 10_000,
    reconcile_operation_ids: [],
    context_content_url: "https://agent.example/v1/context-content/token",
  },
  {
    type: "runner.reconciled",
    protocol_version: "2",
    runner_id: assignment.runner_id,
    connection_epoch: 1,
  },
  {
    type: "runtime.registration.snapshot",
    protocol_version: "2",
    command_id: "registration-1",
    runner_id: assignment.runner_id,
    connection_epoch: 1,
    registrations: [],
  },
  {
    type: "agent_runner.ensure",
    ...assignment,
    command_id: "ensure-1",
    runtime,
    workspace_grant_id: "grant-1",
  },
  { type: "agent_runner.remove", ...assignment, command_id: "remove-1" },
  {
    type: "execute",
    kind: "cli_credential",
    ...assignment,
    command_id: "credential-1",
    profile: {
      url: "https://teamhub.example",
      tenant_id: assignment.tenant_id,
      agent_id: assignment.agent_id,
    },
    access_token: `th_agent_${"a".repeat(43)}`,
  },
  {
    type: "execute",
    kind: "debug_history",
    ...context,
    request: { runtime, session },
  },
  {
    type: "execute",
    kind: "skills_scan",
    ...localCapability,
    scan_id: "scan-1",
    runtime_type: "codex",
  },
  {
    type: "execute",
    kind: "browser_connect",
    ...localCapability,
    action: "status",
  },
  {
    type: "execute",
    kind: "computer_permission",
    ...localCapability,
    action: "prompt",
    subject: "linger",
    permission: "screen_recording",
  },
  {
    type: "prepare",
    target: "operation",
    ...operation,
    command_id: "prepare-1",
    runtime,
    session_options: sessionOptions,
    session,
    mcp_relays: [],
  },
  {
    type: "prepare",
    target: "provider",
    ...assignment,
    host_access: "trusted",
    command_id: "provider-1",
    prepare_id: "prepare-provider-1",
    workspace_grant_id: operation.workspace_grant_id,
    runtime_type: operation.runtime_type,
    execution_context_key: operation.execution_context_key,
    runtime_instance_id: operation.runtime_instance_id,
    context_view_ref: viewRef,
    runtime,
    session_options: sessionOptions,
    session,
  },
  {
    type: "execute",
    kind: "session_compact",
    protocol_version: "2",
    command_id: "compact-1",
    compact_id: "compact-session-1",
    runner_id: assignment.runner_id,
    connection_epoch: 1,
    agent_id: assignment.agent_id,
    runtime_type: "claude",
    execution_context_key: operation.execution_context_key,
    instructions: "Keep the open questions.",
  },
  {
    type: "execute",
    kind: "model_invoke",
    protocol_version: "2",
    command_id: "invoke-command-1",
    invoke_id: "invoke-1",
    runner_id: assignment.runner_id,
    connection_epoch: 1,
    tenant_id: "tenant-1",
    owner_actor_id: "owner-1",
    agent_id: assignment.agent_id,
    runtime_type: "codex",
    mode: "workspace",
    reasoning_effort: "medium",
    input: "Write the pages.",
    workspace_files: [{ path: "raw/notes.md", content_base64: "bm90ZXM=" }],
    timeout_ms: 4 * 60 * 60_000,
  },
  ...[
    {
      kind: "run.start",
      runtime,
      session_options: sessionOptions,
      session,
      input,
      run_context: {
        execution_run_ref: "run-1",
        source_inbox_ids: ["inbox-1"],
      },
      run_resources: { mcp_servers: [] },
    },
  ].map((request) => ({
    type: "operation.start",
    ...operation,
    command_id: `start-${request.kind}`,
    request,
  })),
  {
    type: "operation.input",
    ...operation,
    command_id: "input-1",
    expected_turn_id: "turn-1",
    input_context_view_ref: viewRef,
    input,
  },
  {
    type: "cancel",
    target: "operation",
    ...operation,
    command_id: "cancel-1",
    reason: "Canceled by fixture",
  },
  {
    type: "operation.ack",
    ...operation,
    command_id: "ack-1",
    through_seq: 1,
  },
].map(parseAgentToDaemonEnvelope);

// The constant fields that tell the shapes of one message type apart.
const DISCRIMINATORS = ["type", "target", "kind", "state", "outcome"] as const;

const constants = (schema: unknown): Record<string, unknown> => {
  if (typeof schema !== "object" || schema === null) return {};
  const result: Record<string, unknown> = {};
  if ("allOf" in schema && Array.isArray(schema.allOf)) {
    for (const part of schema.allOf) {
      const ref =
        typeof part === "object" && part !== null && "$ref" in part
          ? String(part.$ref).split("/").at(-1)
          : undefined;
      Object.assign(
        result,
        constants(
          ref
            ? (runnerGatewayEnvelopeSchema.$defs as Record<string, unknown>)[
                ref
              ]
            : part,
        ),
      );
    }
  }
  if ("properties" in schema) {
    const properties = schema.properties as Record<string, unknown>;
    for (const key of DISCRIMINATORS) {
      const property = properties[key];
      if (
        typeof property === "object" &&
        property !== null &&
        "const" in property
      )
        result[key] = property.const;
    }
  }
  return result;
};

// Every message shape of one direction, by schema name.
const messageShapes = (
  direction: "AgentToDaemonEnvelope" | "DaemonToAgentEnvelope",
) =>
  runnerGatewayEnvelopeSchema.$defs[direction].oneOf.map(({ $ref }) => {
    const name = $ref.split("/").at(-1)!;
    return {
      name,
      constants: constants(
        (runnerGatewayEnvelopeSchema.$defs as Record<string, unknown>)[name],
      ),
    };
  });

const shapesOf = (
  direction: "AgentToDaemonEnvelope" | "DaemonToAgentEnvelope",
  frames: readonly object[],
): string[] =>
  [
    ...new Set(
      frames.map((frame) => {
        const shape = messageShapes(direction).find(({ constants: fixed }) =>
          Object.entries(fixed).every(
            ([key, value]) => (frame as Record<string, unknown>)[key] === value,
          ),
        );
        if (!shape)
          throw new Error(`Unknown Runner frame: ${JSON.stringify(frame)}`);
        return shape.name;
      }),
    ),
  ].sort();

const allShapes = (
  direction: "AgentToDaemonEnvelope" | "DaemonToAgentEnvelope",
): string[] =>
  messageShapes(direction)
    .map(({ name }) => name)
    .sort();

it.skipIf(process.platform === "win32")(
  "cross-validates every Runner frame through the Go transport and generated contract",
  async () => {
    expect(shapesOf("AgentToDaemonEnvelope", agentFrames)).toEqual(
      allShapes("AgentToDaemonEnvelope"),
    );
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "runner-wire-"));
    const agentFile = path.join(fixtureRoot, "agent.json");
    const daemonFile = path.join(fixtureRoot, "daemon.json");
    try {
      await writeFile(agentFile, JSON.stringify(agentFrames), { mode: 0o600 });
      await promisify(execFile)(
        "go",
        [
          "test",
          "./internal/linger/transport",
          "-run",
          "^TestRunnerWireContractFixtures$",
          "-count=1",
        ],
        {
          cwd: fileURLToPath(new URL("../local-daemon/", import.meta.url)),
          env: {
            ...process.env,
            LINGER_RUNNER_WIRE_AGENT_FIXTURE: agentFile,
            LINGER_RUNNER_WIRE_DAEMON_FIXTURE: daemonFile,
          },
          timeout: 120_000,
        },
      ).catch((error: Error & { stdout?: string; stderr?: string }) => {
        throw new Error(
          [error.message, error.stdout, error.stderr]
            .filter(Boolean)
            .join("\n"),
          { cause: error },
        );
      });
      const daemonFrames = JSON.parse(await readFile(daemonFile, "utf8")).map(
        parseDaemonToAgentEnvelope,
      ) as ReturnType<typeof parseDaemonToAgentEnvelope>[];
      expect(shapesOf("DaemonToAgentEnvelope", daemonFrames)).toEqual(
        allShapes("DaemonToAgentEnvelope"),
      );
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  },
  130_000,
);
