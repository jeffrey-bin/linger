import { createLocalContextRuntimeBackend } from "../../../src/agent/executor/local-backend.js";
import {
  createContextRuntimeActivator,
  createContextViewSessions,
} from "../../../src/agent/executor/activation.js";
import type { LocalRuntimeSettings } from "../../../src/agent/runtime-settings.js";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, expect, it, vi } from "vitest";

import {
  createTeamHubAgentCliCredentialIssuer,
  type AgentCliCredentialIssuer,
} from "../../../src/agent/runner-gateway/agent-cli-credential-issuer.js";
import { createComputerDaemonIdentityVerifier } from "../../../src/agent/runner-gateway/daemon-identity-verifier.js";
import type { LocalComputerConnection } from "../../../src/agent/runner-gateway/local-computer-registry.js";
import {
  attachRunnerGatewayWebSocket,
  WebSocketPeer,
} from "../../../src/agent/runner-gateway/runner-gateway-websocket.js";
import { RunnerGateway } from "../../../src/agent/runner-gateway/runner-gateway.js";
import {
  createTestRunnerGateway,
  testRegistryOf,
} from "../test-support/runner-gateway.js";
import {
  createTestLocalComputerRegistry,
  testRunnerPlacement,
} from "../test-support/local-computer-registry.js";
import { createTestRunnerCredentialAuthority } from "../test-support/runner-credential-authority.js";
import type {
  RunnerOperationTarget,
  RunnerOperation,
} from "../../../src/agent/runner-gateway/runner-operation.js";

import { createBuiltinAgentFeatures } from "../../../src/agent/agent-features/builtin.js";
import { ExecutorRegistry } from "../../../src/agent/executor/registry.js";
import { createInMemoryGhostStore } from "../test-support/in-memory-ghost-store.js";
import {
  encodeExecutionContextRef,
  type ExecutionContextKey,
  type ExecutionContextRecord,
  type ExecutionContextRef,
} from "../../../src/agent/executor/context-ref.js";
import { createInMemoryExecutionContextStore } from "../test-support/in-memory-execution-context-store.js";
import { RemoteRuntimeProvider } from "../../../src/agent/runner-gateway/remote-codex-provider.js";
import type { RunEvent } from "@linger/wire-contracts/runner-gateway/types";
import type { ContextExecutor } from "../../../src/agent/executor/context-executor.js";
import { createTestFeatureAssembly } from "../test-support/executor-features.js";
import { createStandaloneExecutor } from "../test-support/standalone-executor.js";
import { TestContextRuntimeState as ContextRuntimeState } from "../test-support/context-runtime-state.js";

const execFileAsync = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const processTest =
  process.env.LINGER_GO_LOCAL_DAEMON_TEST === "1" ? it : it.skip;

// Issues from the TeamHub fixture, whose origin is known only after it listens.
/**
 * A test Gateway whose registry places an Agent on the Computer it is ensured
 * on, as TeamHub's registration row does, so a reconnect keeps its Runner.
 */
const createPlacingGateway = (
  options: Parameters<typeof createTestRunnerGateway>[0] = {},
): RunnerGateway => {
  const gateway = createTestRunnerGateway(options);
  const ensure = gateway.ensureReadyLocalAgentRunner.bind(gateway);
  gateway.ensureReadyLocalAgentRunner = (request) => {
    testRegistryOf(gateway).place(
      request.placement.computerId,
      testRunnerPlacement({
        agentId: request.agentId,
        tenantId: request.placement.tenantId,
        ownerActorId: request.placement.ownerActorId,
        runtimeType: request.placement.runtimeType,
        model: request.modelId,
        ...(request.reasoningEffort
          ? { reasoningEffort: request.reasoningEffort }
          : {}),
        workspaceGrantId: request.placement.workspaceGrantId,
        assignmentRevision: request.placement.assignmentRevision,
      }),
    );
    return ensure(request);
  };
  return gateway;
};

const fixtureAgentCliCredentialIssuer = () => {
  let bound: AgentCliCredentialIssuer | undefined;
  const current = () => {
    if (!bound) throw new Error("The TeamHub fixture is not listening yet");
    return bound;
  };
  return {
    issuer: {
      profile: (identity) => current().profile(identity),
      issue: (identity, placement) => current().issue(identity, placement),
    } satisfies AgentCliCredentialIssuer,
    bind(origin: string) {
      bound = createTeamHubAgentCliCredentialIssuer({
        baseUrl: origin,
        serviceToken: "fixture-service-token",
      });
    },
  };
};

const CONTEXT_CONTENT_SIGNING_KEY = "go-daemon-process-context-content-key";

/**
 * Serves a Gateway's Context View content on its own port, as the Agent
 * Service HTTP route does, so the Daemon pulls each View it is named. A hold
 * may keep a file request waiting.
 */
const serveContextContent = async (
  gateway: () => RunnerGateway,
  hold?: (resource: string, signal: AbortSignal) => Promise<void>,
): Promise<{ readonly publicOrigin: string; readonly signingKey: string }> => {
  const server = createServer((request, response) => {
    void (async () => {
      const match = /^\/v1\/context-content\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(
        new URL(request.url!, "http://127.0.0.1").pathname,
      );
      const content = gateway().contextViewContent;
      if (!match || !content) {
        response.writeHead(404).end();
        return;
      }
      const aborted = new AbortController();
      response.once("close", () => aborted.abort());
      if (match[2] === "files") await hold?.(match[3]!, aborted.signal);
      const result = await content.handle(
        match[1]!,
        match[2]!,
        match[3]!,
        new Request(`http://127.0.0.1${request.url}`, {
          method: request.method,
        }),
      );
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  return {
    publicOrigin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    signingKey: CONTEXT_CONTENT_SIGNING_KEY,
  };
};

/**
 * Publishes a View of the Context with a read-write playground and the given
 * read-only memory files, and returns its digest.
 */
const publishContextView = async (
  gateway: RunnerGateway,
  target: {
    readonly computerId: string;
    readonly agentId: string;
    readonly executionContextKey: string;
    readonly runtimeInstanceId: string;
  },
  memory: Readonly<Record<string, string>> = {},
): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "context-view-source-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "playground"));
  await mkdir(path.join(root, "memory"));
  for (const [name, body] of Object.entries(memory))
    await writeFile(path.join(root, "memory", name), body);
  const snapshot = await gateway.contextViewContent!.snapshot({
    computerId: target.computerId,
    plan: {
      ref: { kind: "meta", agentId: target.agentId, roomId: "room-process" },
      contextKey: target.executionContextKey as ExecutionContextKey,
      mappings: [
        {
          kind: "memory",
          sourcePath: path.join(root, "memory"),
          targetPath: "/workspace/memory",
          access: "read_only",
        },
        {
          kind: "playground",
          sourcePath: path.join(root, "playground"),
          targetPath: "/workspace/playground",
          access: "read_write",
        },
      ],
    },
    runtimeInstanceId: target.runtimeInstanceId,
    skills: [],
    signal: new AbortController().signal,
  });
  cleanups.push(async () => snapshot.release());
  return snapshot.viewDigest;
};

// Real daemon, trusted file-install protocol and standalone CLI processes;
// TeamHub HTTP and the native provider are deterministic fixtures, without PG.
processTest(
  "reads managed message history through the real Go Daemon and installed CLI",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "go-daemon-history-"));
    const lifecycle = new AbortController();
    // Bound protocol waiters before Vitest's watchdog, including cold builds.
    const signal = AbortSignal.any([
      lifecycle.signal,
      AbortSignal.timeout(105_000),
    ]);
    const binary = path.join(root, "bin", "linger-computer-daemon");
    const state = path.join(root, "state");
    const workspace = path.join(root, "workspace");
    const codex = path.join(root, "codex");
    const config = path.join(root, "computer.json");
    const computerId = "computer-history-canary";
    const tenantId = "tenant-history-canary";
    const ownerActorId = "actor-history-human";
    const agentId = "agent-history-canary";
    const roomId = "room-history-canary";
    const threadId = "thread-history-canary";
    const token = runnerToken(computerId, tenantId, ownerActorId);
    const managedToken = `th_agent_${"h".repeat(43)}`;
    const requests: Array<{ endpoint: string; body: unknown }> = [];
    const errors: unknown[] = [];
    const message = {
      message_id: "message_history_canary",
      inbox_id: `room:${roomId}`,
      author_actor_id: ownerActorId,
      author: "History Human",
      author_kind: "human",
      body: "Managed history survived outside message files",
      segments: [
        {
          type: "text",
          content: "Managed history survived outside message files",
        },
      ],
      message_kind: "conversation",
      created_at: "2026-10-01T00:00:00Z",
      context_message_ids: [],
      resource_references: [],
    };
    const readMessage = { ...message, context_messages: [] };
    const historyResponses = {
      list: {
        mode: "inbox",
        inbox_id: `room:${roomId}`,
        messages: [readMessage],
        has_more: false,
      },
      get: {
        mode: "messages",
        messages: [readMessage],
        requested_message_ids: [message.message_id],
        unavailable_message_ids: [],
        has_more: false,
      },
      thread: {
        mode: "inbox",
        inbox_id: `thread:${threadId}`,
        root: readMessage,
        messages: [readMessage],
        has_more: false,
      },
      search: { messages: [message], has_more: false },
    };
    const server = createServer((request, response) => {
      void (async () => {
        try {
          const url = new URL(request.url!, "http://localhost");
          expect(request.method).toBe("POST");
          let body = "";
          for await (const chunk of request) body += chunk;
          const input: unknown = JSON.parse(body);
          if (
            url.pathname === `/internal/agents/${agentId}/access-credentials`
          ) {
            expect(request.headers.authorization).toBe(
              "Bearer fixture-service-token",
            );
            expect(input).toEqual({
              label: "Managed Agent CLI",
              computer_id: expect.any(String),
              workspace_grant_id: expect.any(String),
            });
            response.writeHead(201, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                credential_id: "credential_history_canary",
                agent_id: agentId,
                tenant_id: tenantId,
                access_token: managedToken,
              }),
            );
            return;
          }
          expect(request.headers.authorization).toBe(`Bearer ${managedToken}`);
          expect(request.headers["x-teamhub-expected-tenant-id"]).toBe(
            tenantId,
          );
          expect(request.headers["x-teamhub-expected-agent-id"]).toBe(agentId);
          expect(request.headers["x-teamhub-context-kind"]).toBe("room");
          expect(request.headers["x-teamhub-context-id"]).toBe(roomId);
          expect(request.headers["x-teamhub-operation-id"]).toBeUndefined();
          const responses: Record<string, unknown> = {
            "/api/agent/v1/messages/read":
              input && typeof input === "object" && "message_ids" in input
                ? historyResponses.get
                : input && typeof input === "object" && "thread_id" in input
                  ? historyResponses.thread
                  : historyResponses.list,
            "/api/agent/v1/messages/search": historyResponses.search,
          };
          expect(responses[url.pathname]).toBeDefined();
          requests.push({ endpoint: url.pathname, body: input });
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(responses[url.pathname]));
        } catch (error) {
          errors.push(error);
          response.writeHead(500).end();
        }
      })();
    });
    const cliIssuer = fixtureAgentCliCredentialIssuer();
    const gateway: RunnerGateway = createPlacingGateway({
      contextContent: await serveContextContent(() => gateway),
      agentCliCredentialIssuer: cliIssuer.issuer,
      computerDaemonIdentityVerifier: createComputerDaemonIdentityVerifier(),
    });
    const handle = attachRunnerGatewayWebSocket({
      server,
      gateway,
      credentialAuthenticators: [
        createTestRunnerCredentialAuthority([
          {
            runnerId: computerId,
            token,
            credentialGeneration: 0,
            tenantOwners: [{ tenantId, ownerActorId }],
          },
        ]),
      ],
      onSessionError: (error) => errors.push(error),
    });
    let child: ChildProcess | undefined;
    try {
      await Promise.all([
        mkdir(path.dirname(binary), { recursive: true }),
        mkdir(path.join(root, "runtime", "bin"), { recursive: true }),
        mkdir(state),
        mkdir(workspace),
      ]);
      await execFileAsync(
        "go",
        ["build", "-o", binary, "./cmd/linger-computer-daemon"],
        {
          cwd: path.resolve(process.cwd(), "../computer/local-daemon"),
          signal,
          timeout: 60_000,
        },
      );
      await execFileAsync(
        process.execPath,
        [
          path.resolve(process.cwd(), "../teamhub-cli/scripts/build-cli.mjs"),
          "--outdir",
          path.join(root, "cli"),
        ],
        { signal, timeout: 15_000 },
      );
      await symlink(
        process.execPath,
        path.join(root, "runtime", "bin", "node"),
      );
      await writeFile(
        path.join(root, "cli", "teamhub"),
        '#!/bin/sh\ncli_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$cli_dir/../runtime/bin/node" --use-env-proxy "$cli_dir/teamhub.js" "$@"\n',
        { mode: 0o700 },
      );
      const fixture = path.join(root, "history-cli.cjs");
      await writeFile(
        fixture,
        `
const { spawnSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const outputs = [];
for (const [action, args] of ${JSON.stringify([
          ["list", ["message", "read", "--limit", "2", "--json"]],
          [
            "get",
            ["message", "read", "--message-ids", message.message_id, "--json"],
          ],
          [
            "thread",
            ["message", "read", "--thread", threadId, "--limit", "2", "--json"],
          ],
          [
            "search",
            [
              "message",
              "search",
              "Managed history",
              "--inbox",
              `room:${roomId}`,
              "--limit",
              "2",
              "--json",
            ],
          ],
        ])}) {
  const result = spawnSync('teamhub', args, { encoding: 'utf8', timeout: 10000 });
  if (result.error || result.status !== 0) {
    writeFileSync(${JSON.stringify(path.join(root, "cli-subprocess-failure.json"))}, JSON.stringify({ action, code: result.error?.code ?? result.status }), { mode: 0o600 });
    console.log(JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-go-canary', turn: { id: 'turn-go-canary', status: 'failed', error: { message: 'Managed CLI subprocess failed: ' + (result.error?.code ?? result.status) } } } }));
    process.exit(1);
  }
  outputs.push(JSON.parse(result.stdout));
}
console.log(JSON.stringify({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'thread-go-canary', turnId: 'turn-go-canary', item: { type: 'agentMessage', id: 'history-result', text: JSON.stringify(outputs), phase: 'final_answer' } } }));
`,
      );
      await writeFile(
        codex,
        fakeCodexScript(path.join(root, "unused-hang"))
          .replace('if [ "$steer_mode" = "1" ]; then', "if false; then")
          .replace(
            /echo '\{"jsonrpc":"2\.0","method":"item\/completed"[^\n]*"text":"done"[^\n]*'/u,
            `'${process.execPath}' '${fixture}' || exit 1`,
          ),
        { mode: 0o700 },
      );
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      cliIssuer.bind(origin);
      const credential = path.join(root, "runner-token");
      await writeFile(credential, token, { mode: 0o600 });
      await writeFile(
        config,
        JSON.stringify({
          runner_id: computerId,
          display_name: "History canary",
          gateway: {
            url: origin.replace("http:", "ws:") + "/v1/runner-gateway",
            token_file: credential,
          },
          state_directory: state,
          runtime_paths: { codex },
          workspace_grants: [
            {
              grant_id: "grant-history-canary",
              tenant_id: tenantId,
              mode: "workspace-write",
              scope: "owner",
              root_path: workspace,
            },
          ],
        }),
        { mode: 0o600 },
      );
      let stderr = "";
      child = startDaemon(
        binary,
        config,
        root,
        (value) => {
          stderr += value;
        },
        ["/usr/bin", "/bin"],
      );
      await vi.waitFor(
        () => {
          if (errors.length || child?.exitCode !== null)
            throw new Error(
              `Daemon connection failed: ${errors.map(String).join(",")}; ${stderr}`,
            );
          expect(
            connectedComputers(gateway, computerId)[0]?.status,
            stderr,
          ).toBe("online");
        },
        { timeout: 10000 },
      );
      await gateway
        .ensureReadyLocalAgentRunner({
          placement: {
            type: "local",
            tenantId,
            ownerActorId,
            computerId,
            runtimeType: "codex",
            workspaceGrantId: "grant-history-canary",
            assignmentRevision: 1,
          },
          modelId: "codex-default",
          agentId,
          signal,
        })
        .catch((error: unknown) => {
          throw new Error(`History Runner readiness failed: ${stderr}`, {
            cause: error,
          });
        });
      const context = {
        computerId,
        tenantId,
        agentId,
        runnerRevision: 1,
        workspaceGrantId: "grant-history-canary",
        executionContextKey: "context-history-canary",
        runtimeInstanceId: "runtime-history-canary",
        viewDigest: "a".repeat(64),
      };
      context.viewDigest = await publishContextView(gateway, context);
      await gateway.ensureAgentCliCredential({
        computerId,
        tenantId,
        agentId,
        runnerRevision: context.runnerRevision,
        workspaceGrantId: context.workspaceGrantId,
        signal,
      });
      const operation = await gateway.startOperation({
        tenantId,
        ownerActorId,
        runnerId: computerId,
        agentId,
        workspaceGrantId: context.workspaceGrantId,
        executionContextKey: context.executionContextKey,
        runtimeInstanceId: context.runtimeInstanceId,
        contextViewRef: { view_digest: context.viewDigest },
        request: {
          kind: "run.start",
          runtime: { type: "codex", model: "codex-default" },
          session: { threadId: "thread-go-canary" },
          session_options: {
            thread_name: "History canary",
          },
          run_context: {
            execution_run_ref: "run-history-canary",
            source_inbox_ids: ["room:" + roomId],
          },
          input: { type: "text", text: "Read managed history with CLI" },
          run_resources: { mcp_servers: [] },
          cli_run_context: {
            run_id: "run-history-canary",
            scope: { kind: "room", id: roomId },
          },
        },
      });
      const result = await within(
        operation.result,
        "managed CLI history turn",
        60_000,
        signal,
      ).catch(async (error: unknown) => {
        const diagnostic = await readFile(
          path.join(root, "cli-subprocess-failure.json"),
          "utf8",
        ).catch(() => "unavailable");
        throw new Error(`Managed history CLI failed: ${diagnostic}`, {
          cause: error,
        });
      });
      expect(result.type).toBe("run");
      if (result.type !== "run") throw new Error("Expected history Run");
      expect(JSON.parse(result.final_response)).toEqual([
        historyResponses.list,
        historyResponses.get,
        historyResponses.thread,
        historyResponses.search,
      ]);
      expect(requests).toEqual([
        {
          endpoint: "/api/agent/v1/messages/read",
          body: { inbox_id: `room:${roomId}`, limit: 2 },
        },
        {
          endpoint: "/api/agent/v1/messages/read",
          body: { message_ids: [message.message_id] },
        },
        {
          endpoint: "/api/agent/v1/messages/read",
          body: { thread_id: threadId, limit: 2 },
        },
        {
          endpoint: "/api/agent/v1/messages/search",
          body: {
            query: "Managed history",
            inbox_ids: [`room:${roomId}`],
            limit: 2,
          },
        },
      ]);
      expect(errors).toEqual([]);
      // The Context workspace is a hashed Daemon view directory under root.
      const [cliConfigPath] = (
        await execFileAsync("find", [
          root,
          "-path",
          "*/.teamhub/cli/config.json",
        ])
      ).stdout
        .trim()
        .split("\n");
      if (!cliConfigPath) throw new Error("Expected Run CLI configuration");
      const cliDirectory = path.dirname(cliConfigPath);
      const cliConfig = JSON.parse(await readFile(cliConfigPath, "utf8"));
      expect(cliConfig.profiles.runtime).toMatchObject({
        url: origin,
        tenant_id: tenantId,
        agent_id: agentId,
        scope: { kind: "room", id: roomId },
      });
      expect(
        await readFile(
          path.resolve(cliDirectory, cliConfig.profiles.runtime.token_file),
          "utf8",
        ),
      ).toBe(`${managedToken}\n`);
      expect(
        JSON.parse(await readFile(path.join(cliDirectory, "run.json"), "utf8")),
      ).toMatchObject({ run_id: "run-history-canary" });
    } finally {
      lifecycle.abort();
      try {
        if (child && child.exitCode === null && child.signalCode === null) {
          const exited = new Promise<void>((resolve) =>
            child!.once("exit", () => resolve()),
          );
          child.kill("SIGTERM");
          const forceKill = setTimeout(() => {
            try {
              process.kill(-child!.pid!, "SIGKILL");
            } catch {
              child!.kill("SIGKILL");
            }
          }, 3_000);
          try {
            await within(exited, "history daemon cleanup", 5_000);
          } finally {
            clearTimeout(forceKill);
          }
        }
      } finally {
        try {
          await handle.close();
        } finally {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
          await rm(root, { recursive: true, force: true });
        }
      }
    }
  },
  120_000,
);

processTest(
  "connects the real Go Local Computer Daemon through Registration reconciliation",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "linger-go-daemon-"));
    const localDaemonRoot = path.resolve(
      process.cwd(),
      "../computer/local-daemon",
    );
    const binary = path.join(root, "linger-computer-daemon");
    await execFileAsync(
      "go",
      ["build", "-o", binary, "./cmd/linger-computer-daemon"],
      {
        cwd: localDaemonRoot,
      },
    );
    const computerId = "computer-go-canary";
    const tenantId = "tenant-acme";
    const ownerActorId = "actor-alice";
    const token = runnerToken(computerId, tenantId, ownerActorId);
    // TeamHub binds the Daemon Identity and records the hello on connect.
    const connections: LocalComputerConnection[] = [];
    const boundDaemonIds = new Set<string>();
    const computerRegistry = createTestLocalComputerRegistry();
    const recordConnection = computerRegistry.connect.bind(computerRegistry);
    computerRegistry.connect = async (connection) => {
      connections.push(connection);
      boundDaemonIds.add(connection.hello.daemon_identity.daemon_id);
      return recordConnection(connection);
    };
    const gateway: RunnerGateway = createPlacingGateway({
      contextContent: await serveContextContent(() => gateway),
      heartbeatIntervalMs: 1_000,
      computerRegistry,
      computerDaemonIdentityVerifier: createComputerDaemonIdentityVerifier(),
    });
    // Observe the production handshake and frames without changing either peer.
    const diagnosticFailures: unknown[] = [];
    const acceptConnection = gateway.acceptConnection.bind(gateway);
    const acceptObserver = vi
      .spyOn(gateway, "acceptConnection")
      .mockImplementation(async (principal, hello, peer) => {
        const connection = await acceptConnection(principal, hello, peer);
        const receive = connection.receive.bind(connection);
        vi.spyOn(connection, "receive").mockImplementation((envelope) => {
          if (envelope.type === "operation.failed")
            diagnosticFailures.push(envelope);
          return receive(envelope);
        });
        return connection;
      });
    cleanups.push(async () => {
      acceptObserver.mockRestore();
    });
    const server = createServer((_request, response) => {
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const sessionErrors: unknown[] = [];
    const credentials = [
      {
        runnerId: computerId,
        token,
        credentialGeneration: 0,
        tenantOwners: [{ tenantId, ownerActorId }],
      },
    ];
    let handle = attachRunnerGatewayWebSocket({
      server,
      gateway,
      credentialAuthenticators: [
        createTestRunnerCredentialAuthority(credentials),
      ],
      onSessionError: (error) => sessionErrors.push(error),
    });
    cleanups.push(async () => {
      await handle.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const port = (server.address() as AddressInfo).port;
    const state = path.join(root, "state");
    const workspace = path.join(root, "workspace");
    await Promise.all([
      mkdir(state, { mode: 0o700 }),
      mkdir(workspace, { mode: 0o700 }),
      mkdir(path.join(root, ".agents", "skills", "go-canary-skill"), {
        mode: 0o700,
        recursive: true,
      }),
    ]);
    await writeFile(
      path.join(root, ".agents", "skills", "go-canary-skill", "SKILL.md"),
      "---\nname: go-canary-skill\ndescription: Go daemon canary\n---\n",
      { mode: 0o600 },
    );
    const codex = path.join(root, "codex");
    const claude = path.join(root, "claude");
    const managedService = path.join(root, "managed-service");
    const hangMarker = path.join(root, "hang-mode");
    await writeFile(codex, fakeCodexScript(hangMarker), {
      mode: 0o700,
    });
    await writeFile(claude, fakeClaudeScript(), { mode: 0o700 });
    // The synthetic CLI owns authentication; isolate the macOS Keychain probe.
    await writeFile(path.join(root, "security"), "#!/bin/sh\nexit 44\n", {
      mode: 0o700,
    });
    await writeFile(
      managedService,
      "#!/bin/sh\ntrap 'exit 0' TERM\nwhile :; do /bin/sleep 1; done\n",
      { mode: 0o700 },
    );
    const credential = path.join(root, "runner-token");
    await writeFile(credential, token, { mode: 0o600 });
    const config = path.join(root, "computer.json");
    await writeFile(
      config,
      JSON.stringify({
        runner_id: computerId,
        display_name: "Go Canary",
        gateway: {
          url: `ws://127.0.0.1:${port}/v1/runner-gateway`,
          token_file: credential,
        },
        state_directory: state,
        runtime_paths: { codex, claude },
        workspace_grants: [
          {
            grant_id: "grant-go-canary",
            tenant_id: tenantId,
            root_path: workspace,
            mode: "workspace-write",
            scope: "owner",
          },
        ],
      }),
      { mode: 0o600 },
    );
    await chmod(config, 0o600);
    let stderr = "";
    let child = startDaemon(binary, config, root, (value) => {
      stderr += value;
    });
    cleanups.push(async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    });

    await vi.waitFor(
      () => {
        if (child.exitCode !== null) {
          throw new Error(
            `Go daemon exited with ${String(child.exitCode)}; stderr: ${stderr}`,
          );
        }
        if (sessionErrors.length > 0) {
          throw new Error(
            `Runner session failed: ${sessionErrors.map(String).join("; ")}; daemon stderr: ${stderr}`,
          );
        }
        const registrations = connections.at(-1)?.hello.runtime_registrations;
        expect(registrations).toHaveLength(3);
        const claude = registrations?.find(
          ({ provider_type }) => provider_type === "claude",
        );
        expect(
          claude?.status,
          JSON.stringify(claude?.runtime_diagnostics),
        ).toBe("online");
        expect(connectedComputers(gateway, computerId)).toEqual([
          expect.objectContaining({
            computerId,
            status: "online",
          }),
        ]);
      },
      { timeout: 20_000, interval: 100 },
    );
    await expect(readControlStatus(state)).resolves.toMatchObject({
      launch_nonce: "go-canary-launch",
      computer_id: computerId,
      state: "running",
      gateway_state: "connected",
      active_operations: 0,
    });
    const firstDaemonOwner = await readDaemonOwner(state);
    expect(firstDaemonOwner).toMatchObject({
      pid: child.pid,
      processGroupId: child.pid,
    });
    expect(firstDaemonOwner.startTime.length).toBeGreaterThan(0);
    expect(firstDaemonOwner.nonce.length).toBeGreaterThan(0);
    const skillExpiresAt = new Date(Date.now() + 60_000).toISOString();
    const skillScan = await gateway
      .scanLocalSkills({
        tenantId,
        ownerActorId,
        computerId,
        commandId: "scan-go-local-skill",
        scanId: "scan-go-local-skill",
        runtimeType: "codex",
        expiresAt: skillExpiresAt,
      })
      .catch((error: unknown) => {
        throw new Error(
          `Local Skill scan failed; session errors: ${sessionErrors.map(String).join("; ")}; daemon stderr: ${stderr}`,
          { cause: error },
        );
      });
    expect(skillScan.items).toEqual([
      expect.objectContaining({
        name: "go-canary-skill",
        importability: "ready",
      }),
    ]);
    await gateway.ensureReadyLocalAgentRunner({
      placement: {
        type: "local",
        tenantId,
        ownerActorId,
        computerId,
        runtimeType: "codex",
        workspaceGrantId: "grant-go-canary",
        assignmentRevision: 1,
      },
      modelId: "codex-default",
      agentId: "agent-go-canary",
    });
    // Every Operation runs in an applied Context View of its own Context.
    const applyCanaryView = async (
      agentId: string,
      executionContextKey: string,
    ) => {
      const context = {
        computerId,
        tenantId,
        agentId,
        runnerRevision: 1,
        workspaceGrantId: "grant-go-canary",
        executionContextKey,
        runtimeInstanceId: `runtime-${executionContextKey}`,
        viewDigest: "a".repeat(64),
      };
      context.viewDigest = await publishContextView(gateway, context);
      return {
        executionContextKey,
        runtimeInstanceId: context.runtimeInstanceId,
        contextViewRef: { view_digest: context.viewDigest },
      };
    };
    const goCanary = await applyCanaryView(
      "agent-go-canary",
      "context-go-canary",
    );
    // A retained thread: the steer flow runs on a resumed native thread.
    const initialCodexSession = { session: { threadId: "thread-go-canary" } };

    const steerable = await gateway.startOperation({
      tenantId,
      ownerActorId,
      runnerId: computerId,
      ...goCanary,
      agentId: "agent-go-canary",
      workspaceGrantId: "grant-go-canary",
      request: {
        kind: "run.start",
        runtime: { type: "codex", model: "codex-default" },
        session_options: {
          thread_name: "Go Canary Steer",
        },
        session: initialCodexSession.session,
        input: { type: "text", text: "Start the review" },
        run_context: {
          execution_run_ref: "run-go-canary-steer",
          source_inbox_ids: ["room:room-go-canary"],
        },
        run_resources: { mcp_servers: [] },
      },
    });
    const steerEvents = steerable.events[Symbol.asyncIterator]();
    await expect(
      within(steerEvents.next(), "active Codex turn"),
    ).resolves.toMatchObject({
      done: false,
      value: { type: "run.started", turn_id: "turn-go-canary" },
    });
    // Session checkpoint changes must not mutate the retained start. Drop the
    // real WebSocket while the native process waits, and submit input offline.
    initialCodexSession.session.threadId = "checkpoint-after-start";
    await handle.close();
    const offlineInput = steerable.input({
      expectedTurnId: "turn-go-canary",
      input: { type: "text", text: "Focus on the tests" },
    });
    handle = attachRunnerGatewayWebSocket({
      server,
      gateway,
      credentialAuthenticators: [
        createTestRunnerCredentialAuthority(credentials),
      ],
      onSessionError: (error) => sessionErrors.push(error),
    });
    const steerAck = await within(
      offlineInput,
      "Operation input acknowledgement after reconnect",
    ).catch((error: unknown) => {
      throw new Error(`Operation input failed; daemon stderr: ${stderr}`, {
        cause: error,
      });
    });
    expect(steerAck).toEqual({ turnId: "turn-go-canary" });
    const steeredResult = await within(steerable.result, "steered terminal");
    expect(steeredResult).toMatchObject({
      type: "run",
      final_response: "done",
      session: { threadId: "thread-go-canary" },
    });
    expect(
      (await readFile(`${codex}.turn-starts`, "utf8")).trim().split("\n"),
    ).toEqual(["turn-go-canary"]);
    if (steeredResult.type !== "run") {
      throw new Error("Expected Codex run result");
    }
    await gateway.ensureReadyLocalAgentRunner({
      placement: {
        type: "local",
        tenantId,
        ownerActorId,
        computerId,
        runtimeType: "claude",
        workspaceGrantId: "grant-go-canary",
        assignmentRevision: 1,
      },
      modelId: "claude-default",
      agentId: "agent-claude-canary",
    });
    const claudeCanary = await applyCanaryView(
      "agent-claude-canary",
      "context-claude-canary",
    );
    // The Agent allocates the Claude session UUID; the first run.start creates it.
    const initialClaudeSession = {
      session: {
        provider: "claude",
        sessionId: randomUUID(),
        lingerMaterialized: false,
      },
    };
    const claudeSubmittedAt = performance.now();
    const claudeRun = await gateway.startOperation({
      tenantId,
      ownerActorId,
      runnerId: computerId,
      ...claudeCanary,
      agentId: "agent-claude-canary",
      workspaceGrantId: "grant-go-canary",
      request: {
        kind: "run.start",
        runtime: { type: "claude" },
        session_options: {
          thread_name: "Claude Canary",
        },
        session: initialClaudeSession.session,
        input: { type: "text", text: "Continue" },
        run_context: {
          execution_run_ref: "run-claude-canary",
          source_inbox_ids: ["room:room-claude-canary"],
        },
        run_resources: { mcp_servers: [] },
      },
    });
    const claudeEvents = claudeRun.events[Symbol.asyncIterator]();
    const firstClaudeEvent = await within(
      claudeEvents.next(),
      "Claude run start",
    );
    if (firstClaudeEvent.done) {
      const result = await claudeRun.result.catch((error: unknown) =>
        String(error),
      );
      throw new Error(
        `Claude fixture closed before start: ${JSON.stringify(result)}; daemon stderr: ${stderr}`,
      );
    }
    const firstClaudeEventAt = performance.now();
    await expect(Promise.resolve(firstClaudeEvent)).resolves.toMatchObject({
      done: false,
      value: { type: "run.started", turn_id: expect.any(String) },
    });
    await expect(claudeRun.result).resolves.toMatchObject({
      type: "run",
      final_response: "claude done",
      session: {
        provider: "claude",
        sessionId: initialClaudeSession.session.sessionId,
        lingerMaterialized: true,
      },
    });
    const claudeResultAt = performance.now();
    // run.started comes at init, so it lands well before the slow model
    // response that the result waits for.
    expect(firstClaudeEventAt - claudeSubmittedAt).toBeLessThan(
      claudeResultAt - claudeSubmittedAt - 700,
    );
    const laterClaudeEventTypes: string[] = [];
    for (;;) {
      const next = await within(claudeEvents.next(), "Claude run events");
      if (next.done) break;
      laterClaudeEventTypes.push(next.value.type);
    }
    expect(laterClaudeEventTypes).not.toContain("run.started");
    const firstDeltaIndex = laterClaudeEventTypes.indexOf("message.delta");
    expect(firstDeltaIndex).toBeGreaterThanOrEqual(0);

    const callsBeforeReconnect = connections.length;
    await handle.close();
    sessionErrors.length = 0;
    handle = attachRunnerGatewayWebSocket({
      server,
      gateway,
      credentialAuthenticators: [
        createTestRunnerCredentialAuthority(credentials),
      ],
      onSessionError: (error) => sessionErrors.push(error),
    });
    await vi.waitFor(
      () => {
        expect(connections.length).toBeGreaterThan(callsBeforeReconnect);
        expect(connectedComputers(gateway, computerId)[0]?.status).toBe(
          "online",
        );
      },
      { timeout: 5_000, interval: 100 },
    );
    await vi.waitFor(
      async () => {
        await expect(readControlStatus(state)).resolves.toMatchObject({
          gateway_state: "connected",
        });
      },
      { timeout: 10_000, interval: 100 },
    );
    await writeFile(hangMarker, "hang\n", { mode: 0o600 });
    const cancellationTarget: RunnerOperationTarget = {
      tenantId,
      ownerActorId,
      runnerId: computerId,
      ...goCanary,
      agentId: "agent-go-canary",
      workspaceGrantId: "grant-go-canary",
      request: {
        kind: "run.start",
        runtime: { type: "codex", model: "codex-default" },
        session_options: {
          thread_name: "Go Canary Cancellation",
        },
        session: steeredResult.session,
        input: { type: "text", text: "Wait for cancellation" },
        run_context: {
          execution_run_ref: "run-go-canary-cancel",
          source_inbox_ids: ["room:room-go-canary"],
        },
        run_resources: { mcp_servers: [] },
      },
    };
    // Real Go Daemon -> real welcome -> native failure with its diagnostics.
    const failureFrame = JSON.stringify({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        threadId: "thread-go-canary",
        turn: {
          id: "turn-go-canary",
          status: "failed",
          error: {
            message: "fixture provider failure",
            codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } },
          },
        },
      },
    });
    await writeFile(
      codex,
      fakeCodexScript(hangMarker).replace(
        `if [ -f '${hangMarker}' ]; then`,
        `echo '${failureFrame}'\nexit 0\nif [ -f '${hangMarker}' ]; then`,
      ),
      { mode: 0o700 },
    );
    try {
      const failed = await gateway.startOperation(cancellationTarget);
      await expect(
        within(failed.result, "negotiated failure diagnostics"),
      ).rejects.toMatchObject({
        name: "RuntimeExecutionError",
        diagnostics: { code: "httpConnectionFailed", statusCode: 429 },
      });
      expect(diagnosticFailures).toContainEqual(
        expect.objectContaining({
          type: "operation.failed",
          error: expect.objectContaining({
            diagnostics: { code: "httpConnectionFailed", statusCode: 429 },
          }),
        }),
      );
    } finally {
      await writeFile(codex, fakeCodexScript(hangMarker), { mode: 0o700 });
    }

    // #195: real Go process cleanup -> negotiated Gateway error -> same-home
    // retry. The native fixture is deterministic; the separate live acceptance
    // must also prove resident reuse and the TeamHub/PG terminal.
    await writeFile(`${hangMarker}.pids`, "", { mode: 0o600 });
    const killed = await gateway.startOperation(cancellationTarget);
    const killedResult = killed.result.catch((error: unknown) => error);
    let killedPid = 0;
    await vi.waitFor(
      async () => {
        const pids = (await readFile(`${hangMarker}.pids`, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(Number);
        expect(pids).toHaveLength(1);
        killedPid = pids[0]!;
        expect(killedPid).toBeGreaterThan(0);
      },
      { timeout: 10_000, interval: 50 },
    );
    process.kill(killedPid, "SIGTERM");
    expect(
      await within(killedResult, "external SIGTERM cleanup"),
    ).toMatchObject({
      name: "RuntimeExecutionError",
      failure: { code: "execution_failed", runtime_type: "codex" },
      diagnostics: { signal: "SIGTERM" },
    });
    expect(diagnosticFailures).toContainEqual(
      expect.objectContaining({
        operation_id: killed.operationId,
        error: expect.objectContaining({
          code: "RUNTIME_EXECUTION_FAILED",
          message: "codex process exited",
          diagnostics: { signal: "SIGTERM" },
        }),
      }),
    );
    await writeFile(
      codex,
      fakeCodexScript(hangMarker)
        .replace(`if [ -f '${hangMarker}' ]; then`, "if false; then")
        .replace("steer_mode=1", "steer_mode=0"),
      { mode: 0o700 },
    );
    try {
      const retry = await gateway.startOperation(cancellationTarget);
      await expect(
        within(retry.result, "same-home retry after SIGTERM"),
      ).resolves.toMatchObject({ type: "run" });
    } finally {
      await writeFile(codex, fakeCodexScript(hangMarker), { mode: 0o700 });
    }

    let cancellable:
      | Awaited<ReturnType<RunnerGateway["startOperation"]>>
      | undefined;
    await vi.waitFor(
      async () => {
        if (sessionErrors.length > 0) {
          throw new Error(sessionErrors.map(String).join("; "));
        }
        cancellable ??= await gateway.startOperation(cancellationTarget);
        expect(cancellable).toBeDefined();
      },
      { timeout: 5_000, interval: 100 },
    );
    if (!cancellable) throw new Error("Cancellable Operation was not admitted");
    await vi.waitFor(
      async () => {
        await expect(readFile(`${hangMarker}.started`, "utf8")).resolves.toBe(
          "turn-go-canary\n",
        );
      },
      { timeout: 10_000, interval: 50 },
    );
    // Same Agent, distinct Context: a sibling Run must start without waiting
    // for or cancelling the held Run. Both use their own Context Runtime home.
    const goSibling = await applyCanaryView(
      "agent-go-canary",
      "context-go-sibling",
    );
    const sibling = await within(
      gateway.startOperation({
        tenantId,
        ownerActorId,
        runnerId: computerId,
        ...goSibling,
        agentId: "agent-go-canary",
        workspaceGrantId: "grant-go-canary",
        request: {
          kind: "run.start",
          runtime: { type: "codex", model: "codex-default" },
          session_options: {
            thread_name: "Sibling Context",
          },
          session: { threadId: "" },
          input: { type: "text", text: "Sibling" },
          run_context: {
            execution_run_ref: "run-go-sibling",
            source_inbox_ids: ["room:room-go-canary"],
          },
          run_resources: { mcp_servers: [] },
        },
      }),
      "Concurrent sibling Context admission",
    );
    await expect(
      within(
        sibling.events[Symbol.asyncIterator]().next(),
        "Sibling run start",
      ),
    ).resolves.toMatchObject({ done: false, value: { type: "run.started" } });
    await within(sibling.cancel("sibling started"), "Sibling cancellation");
    await expect(
      within(sibling.result, "Sibling cancelled terminal"),
    ).rejects.toMatchObject({ code: "cancelled" });
    await within(
      cancellable.cancel("canary cancellation"),
      "Operation cancellation",
    ).catch((error: unknown) => {
      throw new Error(
        `Operation cancellation failed; daemon stderr: ${stderr}`,
        { cause: error },
      );
    });
    await expect(
      within(cancellable.result, "cancelled terminal"),
    ).rejects.toMatchObject({
      name: "RunnerOperationError",
      code: "cancelled",
    });

    await writeFile(`${hangMarker}.cleanup-error`, "fail cleanup\n", {
      mode: 0o600,
    });
    const unconfirmed = await gateway.startOperation(cancellationTarget);
    const unconfirmedEvents = unconfirmed.events[Symbol.asyncIterator]();
    await within(unconfirmedEvents.next(), "unconfirmed run start");
    await within(
      unconfirmed.cancel("unconfirmed cleanup test"),
      "unconfirmed cancellation",
    );
    await expect(
      within(unconfirmed.result, "unconfirmed terminal"),
    ).rejects.toMatchObject({
      name: "RunnerOperationError",
      code: "RUNTIME_CLEANUP_UNCONFIRMED",
      retryable: false,
    });
    await rm(`${hangMarker}.cleanup-error`);

    const service = (await controlRequest(state, "POST", "/services", {
      name: "preview",
      command: managedService,
      args: [],
      cwd: workspace,
    })) as { name: string; pid: number; state: string };
    expect(service).toMatchObject({ name: "preview", state: "running" });
    const servicePid = service.pid;
    expect(typeof servicePid).toBe("number");

    const callsBeforeRestart = connections.length;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await expect(
      readFile(path.join(state, "daemon.lock", "owner.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    child = startDaemon(binary, config, root, (value) => {
      stderr += value;
    });
    await vi.waitFor(
      () => {
        expect(connections.length).toBeGreaterThan(callsBeforeRestart);
        expect(connectedComputers(gateway, computerId)[0]?.status).toBe(
          "online",
        );
      },
      { timeout: 5_000, interval: 100 },
    );
    await vi.waitFor(
      async () => {
        await expect(readControlStatus(state)).resolves.toMatchObject({
          gateway_state: "connected",
          reconciled: true,
        });
      },
      { timeout: 10_000, interval: 100 },
    );
    const restartedDaemonOwner = await readDaemonOwner(state);
    expect(restartedDaemonOwner).toMatchObject({
      pid: child.pid,
      processGroupId: child.pid,
    });
    expect(restartedDaemonOwner.nonce).not.toBe(firstDaemonOwner.nonce);
    await expect(controlRequest(state, "GET", "/services")).resolves.toEqual([
      expect.objectContaining({ name: "preview", pid: servicePid }),
    ]);
    await expect(
      controlRequest(state, "POST", "/services/preview/stop"),
    ).resolves.toMatchObject({ name: "preview", pid: servicePid });
    const cancellationRequest = cancellationTarget.request;
    if (cancellationRequest.kind !== "run.start") {
      throw new Error("Cancellation target is not a Run");
    }
    const interruptedTarget: RunnerOperationTarget = {
      ...cancellationTarget,
      request: {
        ...cancellationRequest,
        run_context: {
          ...cancellationRequest.run_context,
          execution_run_ref: "run-go-canary-interrupted",
        },
      },
    };
    const interrupted = await gateway.startOperation(interruptedTarget);
    const interruptedEvents = interrupted.events[Symbol.asyncIterator]();
    await expect(
      within(interruptedEvents.next(), "interrupted Codex run start"),
    ).resolves.toMatchObject({
      done: false,
      value: { type: "run.started", turn_id: "turn-go-canary" },
    });
    // The fake Codex appends its PID to this file when it hangs. Wait until the
    // interrupted run's process is alive, so the orphan check below is meaningful.
    let codexPids: number[] = [];
    await vi.waitFor(
      async () => {
        codexPids = (await readFile(`${hangMarker}.pids`, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(Number);
        const alive = [];
        for (const pid of codexPids) {
          if (!(await processGone(pid))) alive.push(pid);
        }
        expect(alive.length).toBeGreaterThan(0);
      },
      { timeout: 10_000, interval: 50 },
    );
    const interruptedDaemonExit = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    process.kill(-child.pid!, "SIGKILL");
    await interruptedDaemonExit;
    const callsBeforeCrashRecovery = connections.length;
    child = startDaemon(binary, config, root, (value) => {
      stderr += value;
    });
    await vi.waitFor(
      async () => {
        expect(connections.length).toBeGreaterThan(callsBeforeCrashRecovery);
        await expect(readControlStatus(state)).resolves.toMatchObject({
          gateway_state: "connected",
        });
      },
      { timeout: 10_000, interval: 100 },
    );
    await expect(interrupted.result).rejects.toMatchObject({
      name: "RunnerOperationError",
      code: "DAEMON_RESTARTED",
      retryable: false,
    });
    const crashRecoveredDaemonOwner = await readDaemonOwner(state);
    expect(crashRecoveredDaemonOwner).toMatchObject({
      pid: child.pid,
      processGroupId: child.pid,
    });
    expect(crashRecoveredDaemonOwner.nonce).not.toBe(
      restartedDaemonOwner.nonce,
    );
    // Codex runs in its own process group, so the Daemon group SIGKILL does not
    // reach it. The restarted Daemon must reap every Codex process it orphaned.
    await vi.waitFor(
      async () => {
        for (const pid of codexPids) {
          await expect(processGone(pid)).resolves.toBe(true);
        }
      },
      { timeout: 10_000, interval: 100 },
    );
    expect(boundDaemonIds.size).toBe(1);
    expect(sessionErrors).toEqual([]);
    await expect(readdir(path.join(state, "operation-tmp"))).resolves.toEqual(
      [],
    );
    const runtimeHomes = await readdir(
      path.join(state, "runtime-homes", "codex"),
    );
    expect(runtimeHomes).toHaveLength(2);
    const diagnostics = (
      await Promise.all(
        runtimeHomes.map((home) =>
          readFile(
            path.join(
              state,
              "runtime-homes",
              "codex",
              home,
              "runner-diagnostics.log",
            ),
            "utf8",
          ),
        ),
      )
    ).flatMap((content) =>
      content
        .trim()
        .split("\n")
        .map((line): { status?: string; phase?: string; pid?: string } =>
          JSON.parse(line),
        ),
    );
    expect(diagnostics.some((row) => row.status === "completed")).toBe(true);
    const cleanedProcesses = diagnostics.filter(
      (row) => row.phase === "cleanup" && row.pid,
    );
    expect(cleanedProcesses.length).toBeGreaterThan(0);
    for (const row of cleanedProcesses) {
      expect(() => process.kill(Number(row.pid), 0)).toThrowError(
        expect.objectContaining({ code: "ESRCH" }),
      );
    }
    const restartedDaemonExit = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    // The Daemon leads its process group (asserted above).
    process.kill(-crashRecoveredDaemonOwner.processGroupId, "SIGTERM");
    await restartedDaemonExit;
    const callsBeforeOrphanRecovery = connections.length;
    child = startDaemon(binary, config, root, (value) => {
      stderr += value;
    });
    await vi.waitFor(
      async () => {
        expect(connections.length).toBeGreaterThan(callsBeforeOrphanRecovery);
        await expect(readControlStatus(state)).resolves.toMatchObject({
          gateway_state: "connected",
        });
      },
      { timeout: 10_000, interval: 100 },
    );
    const recoveredDaemonOwner = await readDaemonOwner(state);
    expect(recoveredDaemonOwner).toMatchObject({
      pid: child.pid,
      processGroupId: child.pid,
    });
    expect(recoveredDaemonOwner.nonce).not.toBe(
      crashRecoveredDaemonOwner.nonce,
    );
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  },
  45_000,
);

processTest(
  "prepares a suspended Codex thread from an input accepted before reactivation, then starts it through the real Go Daemon",
  async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "linger-context-reconnect-"),
    );
    // The Daemon finds the bundled TeamHub CLI at <binary dir>/../cli.
    const binary = path.join(root, "bin", "linger-computer-daemon");
    const state = path.join(root, "state");
    const workspace = path.join(root, "workspace");
    const computerId = "computer-context-reconnect";
    const tenantId = "tenant-acme";
    const ownerActorId = "actor-alice";
    const token = runnerToken(computerId, tenantId, ownerActorId);
    const credential = path.join(root, "credential");
    const codex = path.join(root, "codex");
    const config = path.join(root, "computer.json");
    const agentId = "agent-same-connection";
    const issuedCredentials: string[] = [];
    const cliIssuer = fixtureAgentCliCredentialIssuer();
    const gateway: RunnerGateway = createPlacingGateway({
      contextContent: await serveContextContent(() => gateway),
      agentCliCredentialIssuer: cliIssuer.issuer,
      computerDaemonIdentityVerifier: createComputerDaemonIdentityVerifier(),
    });
    // The same HTTP origin serves the TeamHub credential issuance fixture.
    const server = createServer((request, response) => {
      void (async () => {
        if (
          request.method === "POST" &&
          request.url === `/internal/agents/${agentId}/access-credentials`
        ) {
          for await (const _chunk of request) {
            // The issuance body is not part of this scenario.
          }
          const accessToken = `th_agent_${String(issuedCredentials.length + 1).padStart(43, "b")}`;
          issuedCredentials.push(accessToken);
          response.writeHead(201, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              credential_id: `credential_${issuedCredentials.length}`,
              agent_id: agentId,
              tenant_id: tenantId,
              access_token: accessToken,
              expires_at: new Date(
                Date.now() + 48 * 60 * 60 * 1000,
              ).toISOString(),
            }),
          );
          return;
        }
        response.writeHead(404).end();
      })();
    });
    const sendSpy = vi.spyOn(WebSocketPeer.prototype, "send");
    const outboundTypes = (from = 0) =>
      sendSpy.mock.calls
        .slice(from)
        .map(([envelope]) =>
          envelope.type === "operation.start"
            ? `run:${envelope.request.kind}`
            : "kind" in envelope
              ? `${envelope.type}:${envelope.kind}`
              : "target" in envelope
                ? `${envelope.type}:${envelope.target}`
                : envelope.type,
        );
    const sessionErrors: unknown[] = [];
    const attach = () =>
      attachRunnerGatewayWebSocket({
        server,
        gateway,
        credentialAuthenticators: [
          createTestRunnerCredentialAuthority([
            {
              runnerId: computerId,
              token,
              credentialGeneration: 0,
              tenantOwners: [{ tenantId, ownerActorId }],
            },
          ]),
        ],
        onSessionError: (error) => sessionErrors.push(error),
      });
    const handle = attach();
    let child: ChildProcess | undefined;
    let shell: ContextExecutor<LocalRuntimeSettings> | undefined;
    try {
      await execFileAsync(
        "go",
        ["build", "-o", binary, "./cmd/linger-computer-daemon"],
        { cwd: path.resolve(process.cwd(), "../computer/local-daemon") },
      );
      await mkdir(state, { mode: 0o700 });
      await mkdir(workspace, { mode: 0o700 });
      await mkdir(path.join(root, "runtime", "bin"), { recursive: true });
      await execFileAsync(
        process.execPath,
        [
          path.resolve(process.cwd(), "../teamhub-cli/scripts/build-cli.mjs"),
          "--outdir",
          path.join(root, "cli"),
        ],
        { timeout: 15_000 },
      );
      await symlink(
        process.execPath,
        path.join(root, "runtime", "bin", "node"),
      );
      await writeFile(
        path.join(root, "cli", "teamhub"),
        '#!/bin/sh\ncli_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$cli_dir/../runtime/bin/node" --use-env-proxy "$cli_dir/teamhub.js" "$@"\n',
        { mode: 0o700 },
      );
      await writeFile(path.join(workspace, "unpublished.txt"), "local work");
      await writeFile(credential, token, { mode: 0o600 });
      // Parking and adoption need the full app-server fixture; the shared shell
      // fake is linear and cannot answer a resident's second thread request.
      const codexFixture = path.resolve(
        process.cwd(),
        "../../scripts/test-fixtures/codex-app-server-fixture.mjs",
      );
      await writeFile(
        codex,
        `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 0.100.0"; exit 0; fi
case "$CODEX_HOME" in
  */runtime-homes/codex/*) ;;
  *)
    read line
    echo '{"jsonrpc":"2.0","id":1,"result":{"userAgent":"codex-canary"}}'
    if read initialized && read request; then
      case "$request" in
        *'"method":"model/list"'*)
          echo '{"id":2,"result":{"data":[{"id":"codex-default","model":"codex-default","displayName":"Codex default","isDefault":true}],"nextCursor":null}}'
          ;;
        *) echo '{"id":2,"result":{"account":null,"requiresOpenaiAuth":false}}' ;;
      esac
    fi
    exit 0
    ;;
esac
echo spawn >> "$0.spawns"
echo $$ >> "$0.pids"
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(codexFixture)} --persist-threads "$@"
`,
        { mode: 0o700 },
      );
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const port = (server.address() as AddressInfo).port;
      await writeFile(
        config,
        JSON.stringify({
          runner_id: computerId,
          display_name: "Context reconnect",
          gateway: {
            url: `ws://127.0.0.1:${port}/v1/runner-gateway`,
            token_file: credential,
          },
          state_directory: state,
          runtime_paths: { codex },
          workspace_grants: [
            {
              grant_id: "grant-go-canary",
              tenant_id: tenantId,
              mode: "workspace-write",
              scope: "owner",
              root_path: workspace,
            },
          ],
        }),
        { mode: 0o600 },
      );
      let stderr = "";
      child = startDaemon(binary, config, root, (value) => {
        stderr += value;
      });
      await vi.waitFor(
        async () => {
          if (child!.exitCode !== null || sessionErrors.length > 0)
            throw new Error(
              `Daemon failed: ${sessionErrors.map(String).join("; ")}; ${stderr}`,
            );
          await expect(readControlStatus(state)).resolves.toMatchObject({
            gateway_state: "connected",
            reconciled: true,
          });
          expect(connectedComputers(gateway, computerId)).toEqual([
            expect.objectContaining({ computerId, status: "online" }),
          ]);
        },
        { timeout: 10_000, interval: 50 },
      );
      const ref = { kind: "meta", agentId, roomId: "room-1" } as const;
      const contextKey = encodeExecutionContextRef(ref);
      await gateway.ensureReadyLocalAgentRunner({
        placement: {
          type: "local",
          computerId,
          tenantId,
          ownerActorId,
          runtimeType: "codex",
          workspaceGrantId: "grant-go-canary",
          assignmentRevision: 1,
        },
        modelId: "codex-default",
        agentId,
      });
      const origin = `http://127.0.0.1:${port}`;
      cliIssuer.bind(origin);
      const backend = createLocalContextRuntimeBackend({
        gateway,
        teamhubFiles: {
          baseUrl: origin,
          serviceToken: "fixture-service-token",
        },
        contextViewContent: gateway.contextViewContent!,
        mcpRelay: { register: () => [], rebind() {}, revoke() {} },
      });
      const logger = {
        child() {
          return this;
        },
        log() {},
      };
      const activator = createContextRuntimeActivator({
        contextHost: {
          async prepareRuntimeView() {
            return { ref, contextKey, mappings: [] };
          },
          async releaseRuntimeView() {},
        },
        viewSessions: createContextViewSessions(),
        resolveBackend: () => backend,
        logger,
        features: createBuiltinAgentFeatures({ services: { logger } }),
      });
      shell = await createStandaloneExecutor<LocalRuntimeSettings>({
        activator,
        stateFactory: async (input) =>
          new ContextRuntimeState({
            databasePath: path.join(root, "agent-state", "runtime.sqlite"),
            ref: input.ref,
          }),
        options: {
          ref,
          tenantId,
          actorId: ownerActorId,
          agent: { name: "Idle canary", instructions: "Fixture only" },
          runtime: {
            type: "local",
            model: "codex-default",
            placement: {
              type: "local",
              computerId,
              tenantId,
              ownerActorId,
              runtimeType: "codex",
              workspaceGrantId: "grant-go-canary",
              assignmentRevision: 1,
            },
          },
          resources: { skills: [], mcpServers: [] },
          features: createTestFeatureAssembly({
            ref,
            actorId: ownerActorId,
          }).ports,
        },
      });
      await shell.start();
      const run = await shell.submitTrustedTurn([
        {
          messageId: "idle-run",
          rawMessage: "Finish fixture",
          segments: [{ type: "text", content: "Finish fixture" }],
        },
      ]);
      await vi
        .waitFor(
          async () =>
            expect(await shell!.observeTurn(run.runId)).toMatchObject({
              status: "succeeded",
            }),
          { timeout: 15_000, interval: 50 },
        )
        .catch(async (error: unknown) => {
          throw new Error(
            `First run did not succeed: ${JSON.stringify(await shell!.observeTurn(run.runId))}; stderr=${stderr}; sessionErrors=${sessionErrors.map(String).join("; ")}`,
            { cause: error },
          );
        });
      expect(
        outboundTypes().filter((type) => type === "execute:cli_credential"),
      ).toHaveLength(1);
      expect(issuedCredentials).toHaveLength(1);
      const firstRunStart = sendSpy.mock.calls
        .map(([envelope]) => envelope)
        .find(
          (envelope) =>
            envelope.type === "operation.start" &&
            envelope.request.kind === "run.start",
        );
      expect(firstRunStart).toMatchObject({
        request: { cli_run_context: { scope: { kind: "room", id: "room-1" } } },
      });
      // The Context workspace is a hashed Daemon view directory under root.
      const [cliConfigPath] = (
        await execFileAsync("find", [
          root,
          "-path",
          "*/.teamhub/cli/config.json",
        ])
      ).stdout
        .trim()
        .split("\n");
      if (!cliConfigPath) throw new Error("Expected Run CLI configuration");
      const cliDirectory = path.dirname(cliConfigPath);
      const cliConfig = JSON.parse(await readFile(cliConfigPath, "utf8"));
      expect(cliConfig.profiles.runtime).toMatchObject({
        url: origin,
        tenant_id: tenantId,
        agent_id: agentId,
        scope: { kind: "room", id: "room-1" },
      });
      expect(
        await readFile(
          path.resolve(cliDirectory, cliConfig.profiles.runtime.token_file),
          "utf8",
        ),
      ).toBe(`${issuedCredentials[0]}\n`);
      expect(sessionErrors).toEqual([]);

      await expect(shell.trySuspendAfterIdle(0)).resolves.toEqual({
        status: "suspended",
      });
      const spawnCount = async () =>
        (await readFile(`${codex}.spawns`, "utf8").catch(() => ""))
          .trim()
          .split("\n")
          .filter(Boolean).length;
      // Suspend sends the Computer nothing: the Context's Codex process stays
      // parked, bounded by the Daemon's resident cap, for the next activation.
      const spawnsBeforeColdMessage = await spawnCount();
      const beforeReactivation = sendSpy.mock.calls.length;
      const stderrBeforeColdMessage = stderr.length;
      // The input is accepted while suspended; the following resume activates
      // with an accepted input, so the Agent prepares the Codex thread first.
      const second = await shell.submitTrustedTurn([
        {
          messageId: "idle-run-again",
          rawMessage: "Finish again",
          segments: [{ type: "text", content: "Finish again" }],
        },
      ]);
      await shell.start();
      await vi
        .waitFor(
          async () =>
            expect(await shell!.observeTurn(second.runId)).toMatchObject({
              status: "succeeded",
            }),
          { timeout: 15_000, interval: 50 },
        )
        .catch(async (error: unknown) => {
          throw new Error(
            `Cold run did not succeed: ${JSON.stringify(await shell!.observeTurn(second.runId))}; stderr=${stderr}; sessionErrors=${sessionErrors.map(String).join("; ")}`,
            { cause: error },
          );
        });
      expect(
        outboundTypes(beforeReactivation).filter(
          (type) => type !== "operation.ack",
        ),
      ).toEqual(["prepare:provider", "run:run.start"]);
      expect(issuedCredentials).toHaveLength(1);
      expect(sessionErrors).toEqual([]);
      // The parked process serves the cold message: the prepare finds it ready
      // and the run.start adopts it instead of spawning another process.
      expect((await spawnCount()) - spawnsBeforeColdMessage).toBe(0);
      expect(await spawnCount()).toBe(1);
      const coldLog = stderr.slice(stderrBeforeColdMessage);
      const prepareReceived =
        /runner\.provider\.prepare phase=received prepare_id=(\S+)/.exec(
          coldLog,
        );
      if (!prepareReceived) throw new Error(`No prepare receipt: ${coldLog}`);
      const prepareId = prepareReceived[1];
      const operationStart = coldLog.indexOf(
        "runner.operation.start phase=received",
      );
      expect(operationStart).toBeGreaterThan(prepareReceived.index);
      await vi.waitFor(
        () =>
          expect(stderr).toContain(
            `runner.provider.prepare phase=already_ready prepare_id=${prepareId}`,
          ),
        { timeout: 10_000, interval: 50 },
      );
    } finally {
      sendSpy.mockRestore();
      await shell?.stop().catch(() => undefined);
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) =>
          child!.once("exit", () => resolve()),
        );
        child.kill("SIGTERM");
        await exited;
      }
      await handle.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

processTest(
  "a Claude presence prepare reaches the real Go Daemon with run_context, and the following run adopts that process",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "linger-presence-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    // The Daemon finds the TeamHub CLI at ../cli beside its binary. The fake
    // Claude never runs it; it only has to exist for the CLI environment.
    const binary = path.join(root, "bin", "linger-computer-daemon");
    await mkdir(path.join(root, "cli"), { recursive: true });
    await writeFile(path.join(root, "cli", "teamhub"), "#!/bin/sh\nexit 0\n", {
      mode: 0o700,
    });
    await execFileAsync(
      "go",
      ["build", "-o", binary, "./cmd/linger-computer-daemon"],
      { cwd: path.resolve(process.cwd(), "../computer/local-daemon") },
    );
    const computerId = "computer-presence";
    const tenantId = "tenant-acme";
    const ownerActorId = "actor-alice";
    const agentId = "agent-presence";
    const token = runnerToken(computerId, tenantId, ownerActorId);
    const cliIssuer = fixtureAgentCliCredentialIssuer();
    const gateway: RunnerGateway = createPlacingGateway({
      contextContent: await serveContextContent(() => gateway),
      agentCliCredentialIssuer: cliIssuer.issuer,
      computerDaemonIdentityVerifier: createComputerDaemonIdentityVerifier(),
    });
    // The same HTTP origin serves the TeamHub credential issuance fixture.
    const server = createServer((request, response) => {
      void (async () => {
        if (
          request.method === "POST" &&
          request.url === `/internal/agents/${agentId}/access-credentials`
        ) {
          for await (const _chunk of request) {
            // The issuance body is not part of this scenario.
          }
          response.writeHead(201, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              credential_id: "credential_presence",
              agent_id: agentId,
              tenant_id: tenantId,
              access_token: `th_agent_${"p".repeat(43)}`,
              expires_at: new Date(
                Date.now() + 48 * 60 * 60 * 1000,
              ).toISOString(),
            }),
          );
          return;
        }
        response.writeHead(404).end();
      })();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const sessionErrors: unknown[] = [];
    const handle = attachRunnerGatewayWebSocket({
      server,
      gateway,
      credentialAuthenticators: [
        createTestRunnerCredentialAuthority([
          {
            runnerId: computerId,
            token,
            credentialGeneration: 0,
            tenantOwners: [{ tenantId, ownerActorId }],
          },
        ]),
      ],
      onSessionError: (error) => sessionErrors.push(error),
    });
    cleanups.push(async () => {
      await handle.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const sendSpy = vi.spyOn(WebSocketPeer.prototype, "send");
    cleanups.push(async () => sendSpy.mockRestore());
    const port = (server.address() as AddressInfo).port;
    cliIssuer.bind(`http://127.0.0.1:${port}`);
    const state = path.join(root, "state");
    const workspace = path.join(root, "workspace");
    await mkdir(state, { mode: 0o700 });
    await mkdir(workspace, { mode: 0o700 });
    // The shared fake Claude, wrapped to count the session processes it starts
    // and record whether each one saw the TeamHub CLI profile.
    const claude = path.join(root, "claude");
    await writeFile(`${claude}-fake`, fakeClaudeScript(), { mode: 0o700 });
    await writeFile(
      claude,
      `#!/bin/sh
for argument in "$@"; do
  case "$argument" in --session-id|--resume) echo "spawn profile=$TEAMHUB_PROFILE" >> "$0.spawns" ;; esac
done
exec "$0-fake" "$@"
`,
      { mode: 0o700 },
    );
    await writeFile(path.join(root, "security"), "#!/bin/sh\nexit 44\n", {
      mode: 0o700,
    });
    const credential = path.join(root, "runner-token");
    await writeFile(credential, token, { mode: 0o600 });
    const config = path.join(root, "computer.json");
    await writeFile(
      config,
      JSON.stringify({
        runner_id: computerId,
        display_name: "Presence",
        gateway: {
          url: `ws://127.0.0.1:${port}/v1/runner-gateway`,
          token_file: credential,
        },
        state_directory: state,
        runtime_paths: { claude },
        workspace_grants: [
          {
            grant_id: "grant-presence",
            tenant_id: tenantId,
            root_path: workspace,
            mode: "workspace-write",
            scope: "owner",
          },
        ],
      }),
      { mode: 0o600 },
    );
    let stderr = "";
    const child = startDaemon(binary, config, root, (value) => {
      stderr += value;
    });
    cleanups.push(async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    });
    await vi.waitFor(
      () => {
        if (child.exitCode !== null || sessionErrors.length > 0)
          throw new Error(
            `Daemon failed: ${sessionErrors.map(String).join("; ")}; ${stderr}`,
          );
        expect(connectedComputers(gateway, computerId)).toEqual([
          expect.objectContaining({ computerId, status: "online" }),
        ]);
      },
      { timeout: 20_000, interval: 100 },
    );
    await gateway.ensureReadyLocalAgentRunner({
      placement: {
        type: "local",
        tenantId,
        ownerActorId,
        computerId,
        runtimeType: "claude",
        workspaceGrantId: "grant-presence",
        assignmentRevision: 1,
      },
      modelId: "claude-default",
      agentId,
    });
    const context = {
      computerId,
      tenantId,
      agentId,
      runnerRevision: 1,
      workspaceGrantId: "grant-presence",
      executionContextKey: "context-presence",
      runtimeInstanceId: "runtime-context-presence",
      viewDigest: "a".repeat(64),
    };
    context.viewDigest = await publishContextView(gateway, context);
    const contextViewRef = { view_digest: context.viewDigest };
    const provider = new RemoteRuntimeProvider({
      dispatcher: gateway,
      target: {
        tenantId,
        ownerActorId,
        runnerId: computerId,
        agentId,
        workspaceGrantId: context.workspaceGrantId,
        executionContextKey: context.executionContextKey,
        runtimeInstanceId: context.runtimeInstanceId,
        contextViewRef,
      },
      runtime: { type: "claude", model: "claude-default" },
      // A reviewed Run: its prepare must carry the same authorization flags.
      onPermissionReview: async () => ({}),
      // No credential is installed before presence: the prepare must wait for it.
      beforePresencePrepare: (signal) =>
        gateway.ensureAgentCliCredential({
          computerId,
          tenantId,
          agentId,
          runnerRevision: context.runnerRevision,
          workspaceGrantId: context.workspaceGrantId,
          signal,
        }),
      contextRunResources: {
        currentContextViewRef: () => contextViewRef,
        resolve: async () => ({ mcp_servers: [] }),
      },
    });
    cleanups.push(() => provider.close());
    const session = await provider.createSession({
      workingDirectory: workspace,
      threadName: "Presence",
      sandboxMode: "workspace-write",
      resources: { mcpServers: [] },
    });

    provider.prepareForPresence(session);
    const envelopes = () => sendSpy.mock.calls.map(([envelope]) => envelope);
    const prepare = await vi.waitFor(
      () => {
        const found = envelopes().find(
          (envelope) =>
            envelope.type === "prepare" && envelope.target === "provider",
        );
        if (!found) throw new Error("No provider.prepare yet");
        return found;
      },
      { timeout: 10_000, interval: 50 },
    );
    // The prestarted process must see the CLI credential the Run uses.
    const credentialPut = envelopes().findIndex(
      (envelope) =>
        envelope.type === "execute" && envelope.kind === "cli_credential",
    );
    expect(credentialPut).toBeGreaterThanOrEqual(0);
    expect(credentialPut).toBeLessThan(envelopes().indexOf(prepare));
    expect(prepare).toMatchObject({
      runtime_type: "claude",
      session,
      run_context: { permission_review: true },
    });
    if (prepare?.type !== "prepare" || prepare?.target !== "provider")
      throw new Error("Expected a provider.prepare");
    await vi.waitFor(
      () =>
        expect(stderr).toContain(
          `runner.provider.prepare phase=ready prepare_id=${prepare.prepare_id}`,
        ),
      { timeout: 10_000, interval: 50 },
    );

    const run = await provider.startRun(
      session,
      {
        type: "text",
        text: "hello",
        cliRunContext: {
          run_id: "run-presence",
          scope: { kind: "room", id: "room-presence" },
        },
      },
      {
        runContext: {
          executionRunRef: "run-presence",
          sourceInboxIds: ["room:room-presence"],
        },
      },
    );
    await within(run.wait(), "presence-prepared Claude run", 15_000);
    // Resident events go to the Runtime home's diagnostics log.
    const diagnostics = (
      await Promise.all(
        (
          await execFileAsync("find", [root, "-name", "runner-diagnostics.log"])
        ).stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((file) => readFile(file, "utf8")),
      )
    ).join("");
    expect(diagnostics).toContain("claude resident adopted");
    expect(diagnostics).not.toContain("claude resident recycled");
    const spawns = (await readFile(`${claude}.spawns`, "utf8"))
      .trim()
      .split("\n");
    // The single, prestarted process already had the Agent CLI environment.
    expect(spawns).toEqual(["spawn profile=runtime"]);
    expect(sessionErrors).toEqual([]);
  },
  60_000,
);

// Process-level Operation recovery. The real Go Daemon and websocket run
// normally; the execution store stands in for TeamHub. "Killing" the Agent
// Service closes its websocket handle and drops its RunnerGateway, so every
// in-memory Operation is lost while the store and the Daemon survive.

type CodexMode = "fast" | "hang" | "hang-message" | "interruptible-message";

interface SentCommand {
  readonly type: string;
  readonly at: number;
  readonly command: Record<string, unknown>;
}

const deltaText = (event: RunEvent): string | undefined =>
  event.type === "message.delta" ? event.delta : undefined;

const codexMessageLine = (id: string, text: string): string =>
  `echo '${JSON.stringify({
    jsonrpc: "2.0",
    method: "item/completed",
    params: {
      threadId: "thread-go-canary",
      turnId: "turn-go-canary",
      item: { type: "agentMessage", id, text, phase: "commentary" },
    },
  })}'`;

// "hang" releases when its marker file is removed and then completes normally.
// "interruptible-message" hangs in the interrupt-aware loop of fakeCodexScript.
const processCodexScript = (hang: string, mode: CodexMode): string => {
  const script = fakeCodexScript(hang);
  const message = mode.endsWith("message")
    ? codexMessageLine("message-partial", "partial")
    : "";
  // A Context run has no steer reply to read; skip that branch as line ~336 does.
  if (mode === "fast")
    return script.replace('if [ "$steer_mode" = "1" ]; then', "if false; then");
  if (mode === "interruptible-message")
    return script.replace(
      `if [ -f '${hang}' ]; then`,
      `if [ -f '${hang}' ]; then\n${message}`,
    );
  return script.replace(
    `if [ -f '${hang}' ]; then`,
    `${message}\necho turn-go-canary > '${hang}.started'\nwhile [ -f '${hang}' ]; do sleep 0.05; done\nsteer_mode=0\nif false; then`,
  );
};

const openProcessHarness = async (mode: CodexMode) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "operation-recovery-"));
  const binary = path.join(root, "daemon");
  const state = path.join(root, "state");
  const workspace = path.join(root, "workspace");
  const computerId = "computer-recovery";
  const tenantId = "tenant-acme";
  const ownerActorId = "actor-alice";
  const agentId = "agent-recovery";
  const token = runnerToken(computerId, tenantId, ownerActorId);
  const credential = path.join(root, "credential");
  const codex = path.join(root, "codex");
  const config = path.join(root, "config.json");
  const hang = path.join(root, "hang");
  const context = {
    computerId,
    tenantId,
    agentId,
    runnerRevision: 1,
    workspaceGrantId: "grant-go-canary",
    executionContextKey: "context-recovery",
    runtimeInstanceId: "runtime-recovery",
    viewDigest: "a".repeat(64),
  };
  // A second Context of the same Agent, for scenarios that run two Contexts at once.
  const secondContext = {
    ...context,
    executionContextKey: "context-second",
    runtimeInstanceId: "runtime-second",
    viewDigest: "c".repeat(64),
  };
  const placement = {
    type: "local" as const,
    tenantId,
    ownerActorId,
    computerId,
    runtimeType: "codex" as const,
    workspaceGrantId: "grant-go-canary",
    assignmentRevision: 1,
  };
  const sent: SentCommand[] = [];
  const errors: unknown[] = [];
  const dropped: string[] = [];
  let holdFile:
    | ((resource: string, signal: AbortSignal) => Promise<void>)
    | undefined;
  let incomingHook:
    | ((envelope: Record<string, unknown>) => boolean)
    | undefined;
  let outgoingHook: ((command: Record<string, unknown>) => boolean) | undefined;
  let peer: { close(code: number, reason: string): void } | undefined;
  const contextContent = await serveContextContent(
    () => gateway,
    (resource, signal) => holdFile?.(resource, signal) ?? Promise.resolve(),
  );
  const createGateway = (): RunnerGateway =>
    createPlacingGateway({
      contextContent,
      computerDaemonIdentityVerifier: createComputerDaemonIdentityVerifier(),
    });
  const server = createServer();
  const attach = (gateway: RunnerGateway) => {
    const accept = gateway.acceptConnection.bind(gateway);
    vi.spyOn(gateway, "acceptConnection").mockImplementation(
      async (principal, hello, transport) => {
        const connection = await accept(principal, hello, {
          close: (code, reason) => transport.close(code, reason),
          send: async (command) => {
            const record = command as unknown as Record<string, unknown>;
            if (outgoingHook?.(record)) {
              dropped.push(String(record.type));
              return;
            }
            sent.push({
              type: String(record.type),
              at: performance.now(),
              command: record,
            });
            await transport.send(command);
          },
        });
        peer = transport;
        const receive = connection.receive.bind(connection);
        connection.receive = async (envelope) => {
          const record = envelope as unknown as Record<string, unknown>;
          if (incomingHook?.(record)) {
            dropped.push(String(record.type));
            return;
          }
          return receive(envelope);
        };
        return connection;
      },
    );
    return attachRunnerGatewayWebSocket({
      server,
      gateway,
      credentialAuthenticators: [
        createTestRunnerCredentialAuthority([
          {
            runnerId: computerId,
            token,
            credentialGeneration: 0,
            tenantOwners: [{ tenantId, ownerActorId }],
          },
        ]),
      ],
      onSessionError: (error) => errors.push(error),
    });
  };
  const gateway = createGateway();
  const handle = attach(gateway);
  let child: ChildProcess | undefined;
  let daemonStderr = "";

  const waitOnline = async (target: RunnerGateway) => {
    await vi.waitFor(
      () => {
        if (errors.length)
          throw new Error(`${errors.map(String).join(",")}; ${daemonStderr}`);
        expect(connectedComputers(target, computerId)[0]?.status).toBe(
          "online",
        );
      },
      { timeout: 60_000 },
    );
  };
  const startDaemonProcess = (): void => {
    child = startDaemon(binary, config, root, (value) => {
      daemonStderr += value;
    });
  };
  const stopDaemon = async (
    signal: "SIGTERM" | "SIGKILL" = "SIGTERM",
  ): Promise<void> => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) =>
        child!.once("exit", () => resolve()),
      );
      child.kill(signal);
      await exited;
    }
  };
  const turnStarts = (): Promise<string[]> =>
    readFile(`${codex}.turn-starts`, "utf8").then(
      (text) => text.trim().split("\n").filter(Boolean),
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );

  const admission = (
    fence: number,
    target: typeof context = context,
    threadId = "thread-go-canary",
  ) =>
    gateway.startOperation({
      tenantId,
      ownerActorId,
      runnerId: computerId,
      agentId,
      workspaceGrantId: target.workspaceGrantId,
      executionContextKey: target.executionContextKey,
      runtimeInstanceId: target.runtimeInstanceId,
      executionEpoch: `old-cloud-${fence}`,
      contextViewRef: { view_digest: target.viewDigest },
      request: {
        kind: "run.start",
        runtime: { type: "codex", model: "codex-default" },
        session: { threadId },
        session_options: {
          thread_name: "Recovery fixture",
        },
        run_context: {
          execution_run_ref: "same-run",
          source_inbox_ids: ["inbox-1"],
        },
        input: { type: "text", text: "execute only once" },
        run_resources: { mcp_servers: [] },
      },
    });

  const h = {
    root,
    state,
    codex,
    hang,
    sent,
    errors,
    dropped,
    get gateway() {
      return gateway;
    },
    get handle() {
      return handle;
    },
    get peer() {
      return peer;
    },
    set incomingHook(value: typeof incomingHook) {
      incomingHook = value;
    },
    set outgoingHook(value: typeof outgoingHook) {
      outgoingHook = value;
    },
    /** Holds each Context file request the Daemon makes until it resolves. */
    set holdFile(value: typeof holdFile) {
      holdFile = value;
    },
    turnStarts,
    contexts: { primary: context, second: secondContext },
    /** Makes the Agent Runner ready without applying any Context View. */
    async ensureRunner(): Promise<void> {
      await gateway.ensureReadyLocalAgentRunner({
        placement,
        modelId: "codex-default",
        agentId,
      });
    },
    /** Publishes a View of one of this harness's Contexts. */
    async applyContext(
      target: typeof context,
      memory: Readonly<Record<string, string>> = {},
    ): Promise<string> {
      target.viewDigest = await publishContextView(gateway, target, memory);
      return target.viewDigest;
    },
    /** Starts a Run on a Context, naming its published View. */
    startRun(target: typeof context, fence = 1) {
      return admission(fence, target);
    },
    /** Starts the first Run of a Context: no thread yet, so threadId is "". */
    startFreshRun(fence = 1) {
      return admission(fence, context, "");
    },
    /** Starts the Daemon, waits until this Gateway sees the Computer online. */
    async boot(): Promise<void> {
      await execFileAsync(
        "go",
        ["build", "-o", binary, "./cmd/linger-computer-daemon"],
        { cwd: path.resolve(process.cwd(), "../computer/local-daemon") },
      );
      await mkdir(state);
      await mkdir(workspace);
      await writeFile(credential, token, { mode: 0o600 });
      await writeFile(codex, processCodexScript(hang, mode), { mode: 0o700 });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      await writeFile(
        config,
        JSON.stringify({
          runner_id: computerId,
          display_name: "Recovery fixture",
          gateway: {
            url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/runner-gateway`,
            token_file: credential,
          },
          state_directory: state,
          runtime_paths: { codex },
          workspace_grants: [
            {
              grant_id: "grant-go-canary",
              tenant_id: tenantId,
              mode: "workspace-write",
              scope: "owner",
              root_path: workspace,
            },
          ],
        }),
        { mode: 0o600 },
      );
      startDaemonProcess();
      await waitOnline(gateway);
    },
    /** Admits a fresh Run on the current Gateway (ordinary first admission). */
    async admit(fence = 1): Promise<RunnerOperation> {
      await gateway.ensureReadyLocalAgentRunner({
        placement,
        modelId: "codex-default",
        agentId,
      });
      context.viewDigest = await publishContextView(gateway, context);
      return admission(fence);
    },
    /** Drops the Agent Service: close the websocket and the in-memory Gateway. */
    async kill(): Promise<void> {
      await handle.close();
      peer = undefined;
    },
    /**
     * Waits until the Daemon runs no Operation, then stops it. The terminal
     * reaches the handle before the Daemon forgets the Operation, so poll.
     */
    async drainedOperations(): Promise<{ readonly running: number }> {
      const read = async () => ({
        running: Number(
          ((await readControlStatus(state)) as { active_operations?: number })
            .active_operations ?? 0,
        ),
      });
      const deadline = performance.now() + 15_000;
      let drained = await read();
      while (drained.running && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        drained = await read();
      }
      await stopDaemon();
      return drained;
    },
    /**
     * Restarts the Daemon process with the same config and state. SIGKILL models a
     * crash; SIGTERM is a graceful stop that cancels the running turn first.
     */
    async restartDaemon(
      signal: "SIGTERM" | "SIGKILL" = "SIGTERM",
    ): Promise<void> {
      await stopDaemon(signal);
      startDaemonProcess();
      await waitOnline(gateway);
    },
    async close(): Promise<void> {
      await stopDaemon();
      await rm(hang, { force: true });
      await handle.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
  return h;
};

type ProcessHarness = Awaited<ReturnType<typeof openProcessHarness>>;

const withProcessHarness = async (
  mode: CodexMode,
  body: (h: ProcessHarness) => Promise<void>,
): Promise<void> => {
  const h = await openProcessHarness(mode);
  try {
    await h.boot();
    await body(h);
  } finally {
    await h.close();
  }
};

const seen = (
  events: ReturnType<typeof observeOperationEvents>,
  type: RunEvent["type"],
) => events.received.filter((entry) => entry.event.type === type).length;

// Every scenario asserts one native turn, one terminal observed across the old
// and recovered handles, no duplicate delivery to a single consumer, a terminal
// persisted once, and a drained Daemon ledger. The old handle's consumer died
// with its Gateway, so run.started reaches each consumer once, not the whole
// process once.

processTest(
  "a brand-new Codex thread names after turn/start: run.started does not wait for the delayed thread/name/set reply",
  async () => {
    await withProcessHarness("fast", async (h) => {
      await h.ensureRunner();
      await h.applyContext(h.contexts.primary);
      // The fake Codex reads thread/name/set after turn/started and replies after 2s.
      await writeFile(`${h.codex}.name-delay`, "2s\n", { mode: 0o600 });
      const startedAt = performance.now();
      const operation = await h.startFreshRun();
      const events = observeOperationEvents(operation);
      const result = await within(operation.result, "brand-new Codex Run");
      await events.done;
      const started = events.received.find(
        (entry) => entry.event.type === "run.started",
      );
      expect(started).toBeDefined();
      // Harness budget: the delayed name reply is 2s, so run.started must land well before it.
      expect(started!.at - startedAt).toBeLessThan(1500);
      expect(result).toMatchObject({
        type: "run",
        final_response: "done",
        session: {
          threadId: "thread-go-canary",
        },
      });
      const methods = (await readFile(`${h.codex}.methods`, "utf8"))
        .trim()
        .split("\n");
      expect(methods).toEqual(
        expect.arrayContaining([
          "thread/start",
          "turn/start",
          "thread/name/set",
        ]),
      );
      expect(methods.indexOf("thread/start")).toBeLessThan(
        methods.indexOf("turn/start"),
      );
      expect(methods.indexOf("turn/start")).toBeLessThan(
        methods.indexOf("thread/name/set"),
      );
      expect(await h.turnStarts()).toEqual(["turn-go-canary"]);
    });
  },
  180_000,
);

processTest(
  "cancels a brand-new Codex Run while its deferred thread/name/set is pending, then the Context runs again",
  async () => {
    await withProcessHarness("fast", async (h) => {
      await h.ensureRunner();
      await h.applyContext(h.contexts.primary);
      // The name reply is held 2s, so the cancel lands while the fixture sleeps in read_thread_name.
      await writeFile(`${h.codex}.name-delay`, "2s\n", { mode: 0o600 });
      const operation = await h.startFreshRun();
      const events = observeOperationEvents(operation);
      await vi.waitFor(
        () => {
          expect(
            events.received.some((entry) => entry.event.type === "run.started"),
          ).toBe(true);
        },
        { timeout: 10_000 },
      );
      await within(
        operation.cancel("fresh run cancellation"),
        "Operation cancellation",
      );
      // Harness budget: the Daemon must end the process tree although turn/interrupt goes unanswered.
      await expect(
        within(operation.result, "cancelled terminal", 20_000),
      ).rejects.toMatchObject({
        code: "cancelled",
        message: "fresh run cancellation",
      });
      await events.done;
      expect(await h.turnStarts()).toEqual(["turn-go-canary"]);
      const pids = (await readFile(`${h.codex}.pids`, "utf8"))
        .trim()
        .split("\n")
        .map(Number);
      expect(pids.length).toBeGreaterThan(0);
      await vi.waitFor(
        async () => {
          for (const pid of pids) expect(await processGone(pid)).toBe(true);
        },
        { timeout: 10_000 },
      );
      // Remove the hold so the same Context's next fresh Run completes normally.
      await rm(`${h.codex}.name-delay`);
      const next = await h.startFreshRun(2);
      await expect(next.result).resolves.toMatchObject({
        type: "run",
        final_response: "done",
      });
    });
  },
  180_000,
);

processTest(
  "R1 Daemon restart mid-run: one terminal, no second native turn, Operations drained",
  async () => {
    await withProcessHarness("hang-message", async (h) => {
      await writeFile(h.hang, "wait");
      const operation = await h.admit(1);
      const events = observeOperationEvents(operation);
      await vi.waitFor(() => expect(seen(events, "run.started")).toBe(1), {
        timeout: 60_000,
      });
      await h.restartDaemon("SIGKILL");
      await expect(operation.result).rejects.toMatchObject({
        code: "DAEMON_RESTARTED",
        retryable: false,
      });
      await rm(h.hang);
      await events.done;
      expect(seen(events, "run.started")).toBe(1);
      expect(await h.turnStarts()).toEqual(["turn-go-canary"]);
      expect(await h.drainedOperations()).toEqual({ running: 0 });
    });
  },
  180_000,
);

processTest(
  "R2 Gateway transport loss mid-run: the Daemon reconnects to the same Gateway without duplicates",
  async () => {
    await withProcessHarness("hang-message", async (h) => {
      await writeFile(h.hang, "wait");
      const operation = await h.admit(1);
      void operation.result.catch(() => undefined);
      const events = observeOperationEvents(operation);
      await vi.waitFor(
        () =>
          expect(events.received.map((e) => deltaText(e.event))).toContain(
            "partial",
          ),
        { timeout: 60_000 },
      );
      const welcomesBefore = h.sent.filter(
        (entry) => entry.type === "runner.welcome",
      ).length;
      h.peer!.close(1012, "injected transport loss");
      await vi.waitFor(
        () =>
          expect(
            h.sent.filter((entry) => entry.type === "runner.welcome").length,
          ).toBeGreaterThan(welcomesBefore),
        { timeout: 60_000 },
      );
      await rm(h.hang);
      await expect(operation.result).resolves.toMatchObject({
        type: "run",
        final_response: "done",
      });
      await events.done;
      const texts = events.received
        .map((e) => deltaText(e.event))
        .filter(Boolean);
      expect(texts.filter((text) => text === "partial")).toHaveLength(1);
      expect(seen(events, "run.started")).toBe(1);
      expect(await h.turnStarts()).toEqual(["turn-go-canary"]);
      expect(await h.drainedOperations()).toEqual({ running: 0 });
    });
  },
  180_000,
);

processTest(
  "cancels revoked Manager Contexts through the real Go Daemon while a sibling keeps running",
  async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "go-daemon-manager-revocation-"),
    );
    const binary = path.join(root, "linger-computer-daemon");
    const state = path.join(root, "state");
    const workspace = path.join(root, "workspace");
    const hangMarker = path.join(root, "hang");
    const codex = path.join(root, "codex");
    const credential = path.join(root, "token");
    const config = path.join(root, "computer.json");
    const computerId = "computer-manager-revocation";
    const tenantId = "tenant-manager-revocation";
    const ownerActorId = "actor-manager-human";
    const token = runnerToken(computerId, tenantId, ownerActorId);
    const gateway: RunnerGateway = createPlacingGateway({
      contextContent: await serveContextContent(() => gateway),
      computerDaemonIdentityVerifier: createComputerDaemonIdentityVerifier(),
    });
    const server = createServer();
    const sessionErrors: unknown[] = [];
    const handle = attachRunnerGatewayWebSocket({
      server,
      gateway,
      credentialAuthenticators: [
        createTestRunnerCredentialAuthority([
          {
            runnerId: computerId,
            token,
            credentialGeneration: 0,
            tenantOwners: [{ tenantId, ownerActorId }],
          },
        ]),
      ],
      onSessionError: (error) => sessionErrors.push(error),
    });
    let child: ChildProcess | undefined;
    try {
      await execFileAsync(
        "go",
        ["build", "-o", binary, "./cmd/linger-computer-daemon"],
        {
          cwd: path.resolve(process.cwd(), "../computer/local-daemon"),
        },
      );
      await Promise.all([mkdir(state), mkdir(workspace)]);
      await writeFile(credential, token, { mode: 0o600 });
      await writeFile(hangMarker, "wait");
      await writeFile(`${hangMarker}.pids`, "");
      await writeFile(codex, fakeCodexScript(hangMarker), { mode: 0o700 });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      await writeFile(
        config,
        JSON.stringify({
          runner_id: computerId,
          display_name: "Manager revocation fixture",
          gateway: {
            url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/runner-gateway`,
            token_file: credential,
          },
          state_directory: state,
          runtime_paths: { codex },
          workspace_grants: [
            {
              grant_id: "grant-go-canary",
              tenant_id: tenantId,
              mode: "workspace-write",
              scope: "owner",
              root_path: workspace,
            },
          ],
        }),
        { mode: 0o600 },
      );
      let stderr = "";
      child = startDaemon(binary, config, root, (value) => {
        stderr += value;
      });
      await vi.waitFor(
        () => {
          if (sessionErrors.length)
            throw new Error(
              `${sessionErrors.map(String).join(",")}; ${stderr}`,
            );
          expect(connectedComputers(gateway, computerId)[0]?.status).toBe(
            "online",
          );
        },
        { timeout: 10_000, interval: 50 },
      );
      await gateway.ensureReadyLocalAgentRunner({
        placement: {
          type: "local",
          tenantId,
          ownerActorId,
          computerId,
          runtimeType: "codex",
          workspaceGrantId: "grant-go-canary",
          assignmentRevision: 1,
        },
        modelId: "codex-default",
        agentId: "agent-go-canary",
      });
      await verifyManagerRevocationThroughGoDaemon({
        gateway,
        root,
        workspace,
        hangMarker,
        computerId,
        tenantId,
        ownerActorId,
      });
      expect(sessionErrors).toEqual([]);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) =>
          child!.once("exit", () => resolve()),
        );
        child.kill("SIGTERM");
        await within(exited, "Manager fixture daemon exit");
      }
      await handle.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
  45_000,
);

// Two Contexts of one Agent on the real Go Daemon. Context A's file download is
// held open by a local server, so the scenario proves Context B still gets its
// Run admitted and started while A is blocked, and A completes once released.
processTest(
  "runs a second Context while the first Context's file download is held",
  async () => {
    await withProcessHarness("fast", async (h) => {
      try {
        const requests: string[] = [];
        const releases: Array<() => void> = [];
        h.holdFile = (resource, signal) =>
          new Promise<void>((resolve) => {
            requests.push(resource);
            releases.push(resolve);
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        await h.ensureRunner();
        await h.applyContext(h.contexts.second, { "held.txt": "held file" });
        const slow = await h.startRun(h.contexts.second);
        const slowEvents = observeOperationEvents(slow);
        await vi.waitFor(() => expect(requests).toHaveLength(1), {
          timeout: 60_000,
          interval: 20,
        });

        // The first Context has no files, so its start must not wait behind the held download.
        await h.applyContext(h.contexts.primary);
        const run = await h.startRun(h.contexts.primary);
        const events = observeOperationEvents(run);
        await vi.waitFor(() => expect(seen(events, "run.started")).toBe(1), {
          timeout: 60_000,
        });
        expect(seen(slowEvents, "run.started")).toBe(0);

        for (const release of releases.splice(0)) release();
        await expect(slow.result).resolves.toMatchObject({ type: "run" });
        await expect(run.result).resolves.toMatchObject({ type: "run" });
        await Promise.all([events.done, slowEvents.done]);
      } finally {
        // Projected Context files are read-only; make the state tree removable before cleanup.
        await execFileAsync("chmod", ["-R", "u+rwX", h.root]);
      }
    });
  },
  180_000,
);

// Context authority and Local Run persistence here are deterministic fixtures,
// not PostgreSQL or a real model. The Manager, RuntimeShell, remote provider,
// Gateway, WebSocket, Go Daemon and native provider subprocess are real.
async function verifyManagerRevocationThroughGoDaemon(options: {
  gateway: RunnerGateway;
  root: string;
  workspace: string;
  hangMarker: string;
  computerId: string;
  tenantId: string;
  ownerActorId: string;
}): Promise<void> {
  const {
    gateway,
    root,
    workspace,
    hangMarker,
    computerId,
    tenantId,
    ownerActorId,
  } = options;
  interface LocalRuntime {
    type: "local";
    placement: { runtimeType: "codex"; computerId: string };
  }
  const nativePids = async (): Promise<number[]> =>
    (await readFile(`${hangMarker}.pids`, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(Number);
  const processExists = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  };
  const operations = new Map<string, RunnerOperation>();
  const dispatch = gateway.startOperation.bind(gateway);
  const interception = vi
    .spyOn(gateway, "startOperation")
    .mockImplementation(async (target) => {
      const operation = await dispatch(target);
      if (target.request.kind === "run.start" && target.executionContextKey) {
        operations.set(target.executionContextKey, operation);
        // A terminal error may arrive before the revocation assertion attaches.
        void operation.result.catch(() => undefined);
      }
      return operation;
    });
  try {
    for (const reason of ["suspended", "lease_loss"] as const) {
      const agentId = "agent-go-canary";
      const refs: ExecutionContextRef[] = [
        { kind: "meta", agentId, roomId: `manager-${reason}-revoked` },
        { kind: "meta", agentId, roomId: `manager-${reason}-sibling` },
      ];
      const contextStore = createInMemoryExecutionContextStore();
      const changeListeners = new Set<
        (record: Readonly<ExecutionContextRecord>) => void
      >();
      const fenceListeners = new Set<
        (ref: Readonly<ExecutionContextRef>) => void
      >();
      contextStore.subscribe = (listener) => {
        changeListeners.add(listener);
        return () => {
          changeListeners.delete(listener);
        };
      };
      contextStore.subscribeUnbind = (listener) => {
        fenceListeners.add(listener);
        return () => {
          fenceListeners.delete(listener);
        };
      };
      for (const ref of refs) await contextStore.ensure(ref, "active");
      const ghostStore = createInMemoryGhostStore<LocalRuntime>();
      await ghostStore.insert({
        tenantId,
        agentId,
        actorId: `actor-${agentId}`,
        revision: "1",
        agent: {
          name: "Manager canary",
          instructions: "Keep running until cancelled",
        },
        runtime: {
          type: "local",
          placement: { runtimeType: "codex", computerId },
        },
        resources: { skills: [], mcpServers: [] },
      });
      const states = new Map<string, ContextRuntimeState>();
      const providers: RemoteRuntimeProvider[] = [];
      const manager = new ExecutorRegistry<LocalRuntime>({
        ghostStore,
        contextStore,
        identityResolver: {
          resolveIdentity: async () => ({
            actorId: `actor-${agentId}`,
            agentType: "general",
            sponsor: {
              actorId: ownerActorId,
              displayName: "Deterministic fixture owner",
            },
          }),
        },
        executorServices: {
          activator: {
            async activate(request) {
              const key = encodeExecutionContextRef(request.ref);
              const context = {
                computerId,
                tenantId,
                agentId,
                runnerRevision: 1,
                workspaceGrantId: "grant-go-canary",
                executionContextKey: key,
                runtimeInstanceId: `runtime-manager-${reason}`,
                viewDigest: "a".repeat(64),
              };
              context.viewDigest = await publishContextView(gateway, context);
              const contextViewRef = { view_digest: context.viewDigest };
              const provider = new RemoteRuntimeProvider({
                dispatcher: gateway,
                target: {
                  tenantId,
                  ownerActorId,
                  runnerId: computerId,
                  agentId,
                  workspaceGrantId: context.workspaceGrantId,
                  executionContextKey: key,
                  runtimeInstanceId: context.runtimeInstanceId,
                  contextViewRef,
                },
                runtime: { type: "codex", model: "codex-default" },
                contextRunResources: {
                  currentContextViewRef: () => contextViewRef,
                  resolve: async () => ({ mcp_servers: [] }),
                },
              });
              providers.push(provider);
              const sessionSpec = {
                workingDirectory: workspace,
                threadName: request.agent.name,
                sandboxMode: "workspace-write" as const,
                resources: { mcpServers: [] },
              };
              return {
                ref: request.ref,
                provider,
                runtimeName: "codex",
                sessionSpec,
                runtimeSession: await provider.createSession(sessionSpec),
                setActiveRunContext() {},
                deactivate: async () => {
                  await provider.close();
                },
              };
            },
          },
          stateFactory: async (input) => {
            const key = encodeExecutionContextRef(input.ref);
            const stateRoot = path.join(
              root,
              `manager-${reason}`,
              createHash("sha256").update(key).digest("hex"),
            );
            const state = Object.assign(
              new ContextRuntimeState({
                databasePath: path.join(stateRoot, "runtime.sqlite"),
                ref: input.ref,
              }),
              {
                executionFence: async () => ({
                  instance_id: "manager-canary-service",
                  token: 1,
                }),
              },
            );
            states.set(key, state);
            return state;
          },
        },
        features: createBuiltinAgentFeatures({
          services: {
            logger: {
              log() {},
              child() {
                return this;
              },
            },
          },
        }),
        shouldPrepareContext: () => false,
      });
      try {
        await manager.restore();
        const runPids: number[] = [];
        for (const [index, ref] of refs.entries()) {
          const previousPids = await nativePids();
          await manager.submitTrustedTurn({
            target: ref,
            messages: [
              {
                messageId: `manager-${reason}-${index}`,
                rawMessage: "Keep executing",
                segments: [{ type: "text", content: "Keep executing" }],
              },
            ],
          });
          await vi.waitFor(
            async () => {
              const newPids = (await nativePids()).filter(
                (pid) => !previousPids.includes(pid),
              );
              expect(newPids).toHaveLength(1);
              runPids[index] = newPids[0]!;
              expect(processExists(runPids[index])).toBe(true);
              expect(
                states.get(encodeExecutionContextRef(ref))!.hasPendingWork(),
              ).toBe(true);
            },
            { timeout: 10_000, interval: 50 },
          );
        }
        const revoked = refs[0]!;
        const sibling = refs[1]!;
        const revokedOperation = operations.get(
          encodeExecutionContextRef(revoked),
        )!;
        const siblingOperation = operations.get(
          encodeExecutionContextRef(sibling),
        )!;
        expect(revokedOperation).toBeDefined();
        expect(siblingOperation).toBeDefined();
        let siblingTerminal = false;
        void siblingOperation.result
          .finally(() => {
            siblingTerminal = true;
          })
          .catch(() => undefined);
        if (reason === "suspended") {
          await contextStore.setTargetResidency(revoked, "suspended");
          const record = (await contextStore.get(revoked))!;
          for (const listener of changeListeners) listener(record);
        } else {
          for (const listener of fenceListeners) listener(revoked);
        }
        await expect(
          within(revokedOperation.result, `Manager ${reason} terminal`),
        ).rejects.toMatchObject({
          name: "RunnerOperationError",
          code: "cancelled",
        });
        await vi.waitFor(() => expect(processExists(runPids[0]!)).toBe(false), {
          timeout: 5_000,
          interval: 50,
        });
        expect(processExists(runPids[1]!)).toBe(true);
        expect(
          states.get(encodeExecutionContextRef(sibling))!.hasPendingWork(),
        ).toBe(true);
        expect(siblingTerminal).toBe(false);
      } finally {
        // Explicit cleanup bounds a red run. Revocation itself must never call
        // this test cleanup.
        await Promise.all(providers.map((provider) => provider.close()));
        await manager.close();
        await Promise.all(
          [...operations.values()].map((operation) =>
            operation.cancel("fixture cleanup").catch(() => undefined),
          ),
        );
      }
    }
  } finally {
    interception.mockRestore();
  }
}

// Consumes a handle's event stream in the background, timestamping each event
// as it is pushed downstream. A single consumer, like the Shell.
const observeOperationEvents = (operation: RunnerOperation) => {
  const received: Array<{ readonly event: RunEvent; readonly at: number }> = [];
  const done = (async () => {
    for await (const event of operation.events)
      received.push({ event, at: performance.now() });
  })().catch(() => undefined);
  return { received, done };
};

const fakeCodexScript = (hangMarker: string): string => `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 0.100.0"; exit 0; fi
case "$CODEX_HOME" in
  */runtime-homes/codex/*) ;;
  *)
    read line
    echo '{"jsonrpc":"2.0","id":1,"result":{"userAgent":"codex-canary"}}'
    if read initialized && read request; then
      case "$request" in
        *'"method":"model/list"'*)
          echo '{"id":2,"result":{"data":[{"id":"codex-default","model":"codex-default","displayName":"Codex default","isDefault":true}],"nextCursor":null}}'
          ;;
        *) echo '{"id":2,"result":{"account":null,"requiresOpenaiAuth":false}}' ;;
      esac
    fi
    exit 0
    ;;
esac
echo spawn >> "$0.spawns"
echo $$ >> "$0.pids"
record_method() {
  method=$(printf '%s' "$line" | /usr/bin/sed -n 's/.*"method":"\\([^"]*\\)".*/\\1/p')
  if [ -n "$method" ]; then echo "$method" >> "$0.methods"; fi
}
read_request() {
  while IFS= read -r line; do
    record_method
    request_id=$(printf '%s' "$line" | /usr/bin/sed -n 's/.*"id":\\([0-9]*\\).*/\\1/p')
    case "$line" in
      *'"method":"config/read"'*)
        reply '{"config":{"features":{"memories":false,"memory_tool":false}}}'
        ;;
      *'"method":"thread/name/set"'*)
        # The Daemon names new threads after turn/start, so a name can arrive at any read.
        reply '{}'
        ;;
      *) return 0 ;;
    esac
  done
  return 1
}
# Reads the deferred name after turn/started. The reply waits 2s when name-delay exists.
read_thread_name() {
  while IFS= read -r line; do
    record_method
    request_id=$(printf '%s' "$line" | /usr/bin/sed -n 's/.*"id":\\([0-9]*\\).*/\\1/p')
    case "$line" in
      *'"method":"thread/name/set"'*)
        /bin/sleep 2
        reply '{}'
        return 0
        ;;
    esac
  done
  return 1
}
reply() {
  printf '{"jsonrpc":"2.0","id":%s,"result":%s}\\n' "$request_id" "$1"
}
read line
record_method
echo '{"jsonrpc":"2.0","id":1,"result":{}}'
read line
record_method
read_request
reply '{"thread":{"id":"thread-go-canary"}}'
# Only a resumed thread gets the steer read; a new thread may see thread/name/set instead.
case "$line" in
  *'"method":"thread/resume"'*) steer_mode=1 ;;
  *) steer_mode=0 ;;
esac
if ! read_request; then exit 0; fi
reply '{}'
echo 'turn-go-canary' >> "$0.turn-starts"
echo '{"jsonrpc":"2.0","method":"turn/started","params":{"threadId":"thread-go-canary","turn":{"id":"turn-go-canary"}}}'
if [ -f '${hangMarker}' ]; then
  echo 'turn-go-canary' > '${hangMarker}.started'
  echo "$$" >> '${hangMarker}.pids'
  if [ -f '${hangMarker}.cleanup-error' ]; then
    echo '{"jsonrpc":"2.0","method":"item/started","params":{"threadId":"thread-go-canary","turnId":"turn-go-canary","item":{"type":"commandExecution","id":"command-cleanup-error","command":"sleep 90"}}}'
  fi
  while read_request; do
    case "$line" in
      *'"method":"turn/interrupt"'*)
        printf '{"id":%s,"result":{}}\\n' "$request_id"
        echo '{"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"thread-go-canary","turn":{"id":"turn-go-canary","status":"interrupted"}}}'
        ;;
      *'"method":"thread/backgroundTerminals/list"'*)
        printf '{"id":%s,"error":{"code":-32601,"message":"cleanup unavailable"}}\\n' "$request_id"
        ;;
    esac
  done
  exit 0
fi
if [ "$steer_mode" = "1" ]; then
  read_request
  reply '{"turnId":"turn-go-canary"}'
fi
if [ -f "$0.name-delay" ]; then
  read_thread_name
fi
echo '{"jsonrpc":"2.0","method":"item/completed","params":{"threadId":"thread-go-canary","turnId":"turn-go-canary","item":{"type":"agentMessage","id":"message-go-canary","text":"done","phase":"final_answer"}}}'
echo '{"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"thread-go-canary","turn":{"id":"turn-go-canary","status":"completed"}}}'
`;

const fakeClaudeScript = (): string => `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.282 (Claude Code)"; exit 0; fi
if [ "$1 $2 $3" = "auth status --json" ]; then echo '{"loggedIn":true}'; exit 0; fi
session_id=""
previous=""
for argument in "$@"; do
  if [ "$previous" = "--session-id" ] || [ "$previous" = "--resume" ]; then session_id="$argument"; fi
  previous="$argument"
done
if [ -z "$session_id" ]; then
  read initialize
  case "$initialize" in
    *linger-catalog*)
      echo '{"type":"control_response","response":{"subtype":"success","request_id":"linger-catalog","response":{"models":[{"value":"claude-default","displayName":"Claude default"}]}}}'
      ;;
    *) echo '{"type":"control_response","response":{"subtype":"success","request_id":"linger-computer-doctor"}}' ;;
  esac
  exit 0
fi
read line
case "$line" in
  *'"type":"control_request"'*)
    echo '{"type":"control_response","response":{"subtype":"success","request_id":"linger-session-restore"}}'
    if ! read line; then exit 0; fi
    ;;
esac
turn_id=\${line#*'"uuid":"'}
turn_id=\${turn_id%%'"'*}
# Real CLI order: init as soon as input is read, the replay echo only after
# the slow model response, then assistant text and the result.
echo '{"type":"system","subtype":"init","session_id":"'"$session_id"'"}'
/bin/sleep 1
echo '{"type":"user","isReplay":true,"uuid":"'"$turn_id"'","session_id":"'"$session_id"'"}'
echo '{"type":"assistant","message":{"id":"msg-claude-canary","content":[{"type":"text","text":"claude done"}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"session_id":"'"$session_id"'","result":"claude done"}'
`;

const startDaemon = (
  binary: string,
  config: string,
  root: string,
  onStderr: (value: string) => void,
  pathEntries: readonly string[] = [],
): ChildProcess => {
  const child = spawn(binary, ["--config", config], {
    detached: true,
    env: {
      PATH: [root, ...pathEntries].join(path.delimiter),
      HOME: root,
      LINGER_DAEMON_LAUNCH_NONCE: "go-canary-launch",
    },
  });
  child.stderr?.on("data", (chunk: Buffer) => onStderr(chunk.toString("utf8")));
  return child;
};

/**
 * Reports whether a PID has exited. A zombie (state Z) has no live code left to
 * run, so it counts as gone; ps prints nothing once the PID is fully reaped.
 */
const processGone = async (pid: number): Promise<boolean> => {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw error;
  }
  const stat = await execFileAsync("ps", ["-o", "stat=", "-p", String(pid)])
    .then(({ stdout }) => stdout.trim())
    .catch(() => "");
  return stat === "" || stat.startsWith("Z");
};

const within = async <T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 10_000,
  signal?: AbortSignal,
): Promise<T> => {
  signal?.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}`)),
          timeoutMs,
        );
        if (signal) {
          onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        }
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
};

const readControlStatus = async (
  stateDirectory: string,
): Promise<Record<string, unknown>> =>
  (await controlRequest(stateDirectory, "GET", "/status")) as Record<
    string,
    unknown
  >;

const readDaemonOwner = async (
  stateDirectory: string,
): Promise<{
  readonly pid: number;
  readonly processGroupId: number;
  readonly startTime: string;
  readonly nonce: string;
}> =>
  JSON.parse(
    await readFile(
      path.join(stateDirectory, "daemon.lock", "owner.json"),
      "utf8",
    ),
  ) as {
    readonly pid: number;
    readonly processGroupId: number;
    readonly startTime: string;
    readonly nonce: string;
  };

const controlRequest = async (
  stateDirectory: string,
  method: "GET" | "POST",
  requestPath: string,
  body?: Record<string, unknown>,
): Promise<unknown> => {
  const colocated = path.join(path.resolve(stateDirectory), "control.sock");
  const socketPath =
    Buffer.byteLength(colocated) <= 100
      ? colocated
      : path.join(
          "/tmp",
          `sx-c-${String(process.getuid?.())}-${createHash("sha256")
            .update(path.resolve(stateDirectory))
            .digest("hex")}`,
          "control.sock",
        );
  return await new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        method,
        path: requestPath,
        socketPath,
        ...(body ? { headers: { "content-type": "application/json" } } : {}),
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          try {
            const envelope = JSON.parse(
              Buffer.concat(chunks).toString("utf8"),
            ) as { ok: boolean; data: Record<string, unknown> };
            if (!envelope.ok) throw new Error("Control status failed");
            resolve(envelope.data);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    outgoing.once("error", reject);
    outgoing.end(body ? JSON.stringify(body) : undefined);
  });
};

const runnerToken = (
  computerId: string,
  tenantId: string,
  ownerActorId: string,
): string => {
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      runner_id: computerId,
      tenant_owners: [{ tenant_id: tenantId, owner_actor_id: ownerActorId }],
    }),
  ).toString("base64url");
  return `sr1.${payload}.test-signature`;
};

// The Gateway's own view of a connected Computer; TeamHub owns the listing.
function connectedComputers(
  gateway: Pick<RunnerGateway, "isLocalComputerExecutionReady">,
  computerId: string,
): { computerId: string; status: "online" }[] {
  return gateway.isLocalComputerExecutionReady(computerId)
    ? [{ computerId, status: "online" }]
    : [];
}
