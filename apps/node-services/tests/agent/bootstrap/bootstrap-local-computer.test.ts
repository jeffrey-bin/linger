import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import {
  bootstrapAgentManager,
  type AgentManagerApplication,
} from "../../../src/agent/bootstrap/bootstrap-agent-manager.js";
import { createRunnerCredentialTestFixture } from "../test-support/runner-credential-authority.js";
import { createTestRunnerGateway } from "../test-support/runner-gateway.js";
import type {
  RuntimeConfigSnapshot,
  RuntimeContext,
} from "../../../src/agent/executor/teamhub-runtime-state-client.js";
import { runtimeDiagnostics } from "../runner-gateway/runtime-diagnostics-fixture.js";
import { createTeamHubRuntimeStateClientFake } from "../test-support/teamhub-runtime-state-client.js";
import { webSocketMessageText } from "../test-support/websocket-message-text.js";
import {
  CURRENT_RUNNER_CAPABILITIES,
  currentRunnerIdentity,
} from "../test-support/runner-capabilities.js";

const applications: AgentManagerApplication[] = [];
const sockets: WebSocket[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  await Promise.all(
    applications.splice(0).map((application) => application.close()),
  );
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Agent Service Local Computer composition", () => {
  it("accepts the Gateway connection of a Computer credential TeamHub signed", async () => {
    const dataRoot = await mkdtemp(
      path.join(os.tmpdir(), "linger-agent-local-computer-"),
    );
    temporaryDirectories.push(dataRoot);
    const runnerGateway = createTestRunnerGateway({
      heartbeatIntervalMs: 30_000,
    });
    const credentialFixture = createRunnerCredentialTestFixture();
    const credentialAuthority = credentialFixture.authority;
    let computerId = "";
    const runtimeSelections = [
      { runtimeType: "codex", model: "codex-default" },
      { runtimeType: "claude", model: "claude-default" },
    ] as const;
    const configByAgentId = new Map<string, RuntimeConfigSnapshot>();
    const contexts = new Map<string, RuntimeContext>();
    const runtimeStateClient = createTeamHubRuntimeStateClientFake({
      reconcileContexts: async () => ({
        examined_count: 0,
        existing_count: 0,
        created_count: 0,
        created_context_keys: [],
      }),
      listContexts: async (agentId) =>
        [...contexts.values()].filter(
          (context) => !agentId || context.ref.agent_id === agentId,
        ),
      ensureContext: async ({ ref, target_residency }) => {
        const contextKey =
          ref.kind === "meta"
            ? JSON.stringify(["meta", ref.agent_id, "room", ref.room_id])
            : ref.kind === "alter_ego"
              ? JSON.stringify(["alter_ego", ref.agent_id, ref.task_id])
              : JSON.stringify(["document", ref.agent_id, ref.document_id]);
        const existing = contexts.get(contextKey);
        if (existing) return { created: false, context: existing };
        const context: RuntimeContext = {
          ref,
          context_key: contextKey,
          tenant_id: "tenant-acme",
          agent_actor_id: `actor:${ref.agent_id}`,
          target_residency,
          state_revision: "1",
          next_input_sequence: "0",
        };
        contexts.set(contextKey, context);
        return { created: true, context };
      },
      getConfig: async (agentId) => {
        const existing = configByAgentId.get(agentId);
        if (existing) return existing;
        const selection = runtimeSelections[configByAgentId.size];
        if (!selection || !computerId) {
          throw new Error(`Unexpected Runtime config request for ${agentId}`);
        }
        const config = {
          agent_id: agentId,
          actor_id: `actor:${agentId}`,
          tenant_id: "tenant-acme",
          configuration_revision: "1",
          runtime_configuration_revision: "1",
          content_hash: "0".repeat(64),
          permission_review: false,
          agent: {
            name: `Local ${selection.runtimeType} Reviewer`,
            instructions: "Review the Room.",
          },
          runtime: {
            type: "local",
            model: selection.model,
            placement: {
              tenant_id: "tenant-acme",
              owner_actor_id: "actor-alice",
              computer_id: computerId,
              runtime_type: selection.runtimeType,
              workspace_grant_id: "grant-repo",
            },
          },
          resources: { skills: [], mcp_servers: [] },
        } as unknown as RuntimeConfigSnapshot;
        configByAgentId.set(agentId, config);
        return config;
      },
    });
    const application = await bootstrapAgentManager({
      contextHostRoot: path.join(dataRoot, "workspaces", "context-host"),
      roomBaseUrl: "http://room.test",

      serviceToken: "service-token",

      inboundServiceToken: "service-token",
      identityResolver: {
        resolveIdentity: async (agentId) => ({
          actorId: `actor:${agentId}`,
          agentType: "general",
          sponsor: {
            actorId: "actor:test-sponsor",
            displayName: "Test Sponsor",
          },
        }),
      },
      runnerCredentialAuthority: credentialAuthority,
      runnerGateway,
      runtimeStateClient,
      port: 0,
    });
    applications.push(application);

    // TeamHub commits the enrollment and signs the credential.
    const bundle = credentialFixture.enroll("computer_alice_mac");
    computerId = bundle.computerId;

    const socket = new WebSocket(
      `${application.address.url.replace("http://", "ws://")}/v1/runner-gateway`,
      { headers: { authorization: `Bearer ${bundle.gatewayToken}` } },
    );
    sockets.push(socket);
    await onceOpen(socket);
    socket.send(
      JSON.stringify({
        type: "runner.hello",
        platform: "darwin",
        daemon_version: "dev",
        protocol_version: "2",
        ...currentRunnerIdentity(),
        capabilities: [...CURRENT_RUNNER_CAPABILITIES],
        runner_id: bundle.computerId,
        display_name: "Alice's Mac",
        connection_nonce: "nonce-1",
        sent_at: "2026-07-30T00:00:00.000Z",
        capacity: 3,
        runtimes: ["codex", "claude"],
        runtime_diagnostics: runtimeDiagnostics({
          ready: ["codex", "claude"],
        }),
        workspace_grants: [
          {
            grant_id: "grant-repo",
            tenant_id: "tenant-acme",
            label: "Linger",
            mode: "workspace-write",
            scope: "owner",
          },
        ],
        agent_runners: [],
        active_operations: [],
      }),
    );
    await expect(onceMessage(socket)).resolves.toMatchObject({
      runner_id: bundle.computerId,
      type: "runner.welcome",
    });
  }, 10_000);
});

const onceOpen = (socket: WebSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

const onceMessage = (socket: WebSocket): Promise<unknown> =>
  new Promise((resolve, reject) => {
    socket.once("message", (data) =>
      resolve(JSON.parse(webSocketMessageText(data)) as unknown),
    );
    socket.once("error", reject);
  });
