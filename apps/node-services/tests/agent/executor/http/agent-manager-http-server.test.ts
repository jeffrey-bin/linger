import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentDebugInspectionApi,
  AgentDeletionOptions,
  AgentManagerApi,
} from "../../../../src/agent/executor/agent-manager-api.js";
import type { RunCancellationStatus } from "../../../../src/agent/executor/types.js";
import {
  snapshotGhost,
  type Ghost,
  type GhostRegistration,
} from "../../../../src/agent/executor/ghost.js";
import {
  createAgentManagerHttpServer,
  type AgentManagerHttpServerAddress,
  type AgentManagerHttpServerHandle,
} from "../../../../src/agent/executor/http/agent-manager-http-server.js";
import type { LocalAgentRunnerManagement } from "../../../../src/agent/runner-gateway/local-computer-management.js";
import type { ExecutionContextRef } from "../../../../src/agent/executor/context-ref.js";
import {
  ModelCallError,
  type ModelCall,
} from "../../../../src/runtime-model-call.js";
import { stubModelCall } from "../../../model-call-stub.js";
import { createTestRunnerGateway } from "../../test-support/runner-gateway.js";

interface TestRuntimeSettings {
  type: "codex";
  model: string;
  placement: {
    type: "local";
    tenantId: string;
    ownerActorId: string;
    computerId: string;
    runtimeType: "codex";
    workspaceGrantId: string;
    assignmentRevision: number;
  };
}

const localRuntime: TestRuntimeSettings = {
  type: "codex",
  model: "gpt-test",
  placement: {
    type: "local",
    tenantId: "tenant-test",
    ownerActorId: "actor-owner",
    computerId: "computer-a",
    runtimeType: "codex",
    workspaceGrantId: "grant-a",
    assignmentRevision: 1,
  },
};

class RecordingApi implements AgentManagerApi<TestRuntimeSettings> {
  readonly ghosts = new Map<string, Ghost<TestRuntimeSettings>>();
  readonly refreshes: string[] = [];
  readonly deletions: string[] = [];
  error: Error | undefined;

  async cancelLocalRun(): Promise<RunCancellationStatus> {
    return "not_found";
  }

  async getGhost(
    agentId: string,
  ): Promise<Readonly<Ghost<TestRuntimeSettings>> | null> {
    if (this.error) {
      throw this.error;
    }
    return this.ghosts.get(agentId) ?? null;
  }

  async refreshAgent(
    agentId: string,
  ): Promise<Readonly<Ghost<TestRuntimeSettings>> | null> {
    if (this.error) {
      throw this.error;
    }
    this.refreshes.push(agentId);
    return this.ghosts.get(agentId) ?? null;
  }

  async deleteAgent(
    agentId: string,
    options: AgentDeletionOptions = {},
  ): Promise<"deleted" | "not_found"> {
    if (this.error) {
      throw this.error;
    }
    this.deletions.push(agentId);
    if (!this.ghosts.has(agentId)) return "not_found";
    await options.beforeIdentityRemoval?.();
    return this.ghosts.delete(agentId) ? "deleted" : "not_found";
  }
}

class RecordingDebugApi
  extends RecordingApi
  implements AgentDebugInspectionApi
{
  readonly histories: string[] = [];
  readonly historyRefs: ExecutionContextRef[] = [];
  readonly historyOptions: unknown[] = [];

  async inspectDebugContextHistory(
    ref: ExecutionContextRef,
    options: import("../../../../src/agent/executor/history.js").RuntimeHistoryOptions,
  ) {
    this.histories.push(ref.agentId);
    this.historyRefs.push(ref);
    this.historyOptions.push(options);
    if (ref.agentId === "agent-bob")
      return {
        status: "available" as const,
        providerKind: "codex" as const,
        source: "codex_rollout" as const,
        snapshot: {
          id: "bob-empty",
          threadId: "bob",
          capturedAt: new Date().toISOString(),
          recordCount: 0,
          tailState: "clean" as const,
        },
        instructions: {
          status: "available" as const,
          source: "codex_rollout" as const,
          blocks: [] as const,
        },
        records: [] as const,
      };
    return {
      status: "available" as const,
      providerKind: "codex" as const,
      source: "codex_rollout" as const,
      snapshot: {
        id: "snapshot-debug-1",
        threadId: "thread-debug-1",
        capturedAt: "2026-08-24T12:00:00.000Z",
        recordCount: 1,
        tailState: "clean" as const,
      },
      instructions: {
        status: "available" as const,
        source: "codex_rollout" as const,
        blocks: [
          {
            recordOrdinal: 0,
            recordType: "session_meta" as const,
            field: "base_instructions" as const,
            text: "Debug instructions",
          },
        ],
      },
      records: [
        {
          ordinal: 1,
          turnId: "turn-debug-1",
          category: "tool_result" as const,
          nativeType: "response_item.custom_tool_call_output",
          toolCallId: "call-debug-1",
          nativeRecord: {
            type: "response_item",
            payload: {
              type: "custom_tool_call_output",
              call_id: "call-debug-1",
              output: "Debug result",
            },
          },
          redactedFields: [],
        },
      ],
      previousCursor: "cursor-debug-1",
    };
  }
}

const registration: GhostRegistration<TestRuntimeSettings> = {
  tenantId: "tenant-test",
  revision: "revision-1",
  agent: {
    name: "Reviewer",
    instructions: "Review Room messages.",
  },
  runtime: localRuntime,
  resources: { skills: [], mcpServers: [] },
};

const servers: AgentManagerHttpServerHandle[] = [];
const serviceToken = "agent-manager-test-token";

const authorizedFetch = (
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> => {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${serviceToken}`);
  return fetch(input, { ...init, headers });
};

const startServer = async (
  api: AgentManagerApi<TestRuntimeSettings> & Partial<AgentDebugInspectionApi>,
) => {
  const server = createAgentManagerHttpServer({
    api,
    localComputerManagement: new AcceptingLocalComputerManagement(),
    serviceToken,
    port: 0,
  });
  servers.push(server);
  return { server, address: await server.start() };
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("AgentManager HTTP adapter", () => {
  it("answers a model call as an object or as text", async () => {
    const modelCall: ModelCall = stubModelCall({
      call: vi.fn<ModelCall["call"]>(async () => ({
        output: { approve: true },
        model: "gpt-runtime-default",
      })),
      text: vi.fn<ModelCall["text"]>(async () => ({
        output: "Hello.",
        model: "claude",
      })),
    });
    const post = (url: string, body: unknown) =>
      authorizedFetch(`${url}/v1/model-calls`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["approve"],
      properties: { approve: { type: "boolean" } },
    };
    const without = createAgentManagerHttpServer({
      api: new RecordingApi(),
      serviceToken,
      port: 0,
    });
    servers.push(without);
    const work = { kind: "profile", key: "profile:generation-1" };
    const unavailable = await post((await without.start()).url, {
      ...work,
      input: "x",
      timeoutMs: 1_000,
    });
    expect(unavailable.status).toBe(503);
    expect(JSON.stringify(await unavailable.json())).toContain(
      "LOCAL_RUNTIME_UNAVAILABLE",
    );
    const server = createAgentManagerHttpServer({
      api: new RecordingApi(),
      serviceToken,
      port: 0,
      modelCall,
    });
    servers.push(server);
    const { url } = await server.start();

    const structured = await post(url, {
      kind: "approval",
      key: "approval:review-1",
      owner: { tenantId: "tenant-1", ownerActorId: "owner-1" },
      effort: "medium",
      instructions: "Decide.",
      input: "May I?",
      output: { name: "decision", schema },
      timeoutMs: 30_000,
      sessionKey: "permission-review:abc",
      runOperationId: "operation-1",
    });
    expect(structured.status).toBe(200);
    expect(await structured.json()).toEqual({
      model: "gpt-runtime-default",
      output: { approve: true },
    });
    expect(modelCall.call).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "approval",
        key: "approval:review-1",
        owner: { tenantId: "tenant-1", ownerActorId: "owner-1" },
        effort: "medium",
        instructions: "Decide.",
        input: "May I?",
        schemaName: "decision",
        outputSchema: schema,
        timeoutMs: 30_000,
        sessionKey: "permission-review:abc",
        runOperationId: "operation-1",
      }),
    );

    // Skill-based prompts such as the Profile one exceed 200,000 characters.
    const longInstructions = await post(url, {
      ...work,
      instructions: "i".repeat(250_000),
      input: "x",
      output: { name: "decision", schema },
      timeoutMs: 1_000,
    });
    expect(longInstructions.status).toBe(200);

    // Without timeoutMs the kind's default applies.
    const text = await post(url, { ...work, input: "Say hello." });
    expect(await text.json()).toEqual({ model: "claude", text: "Hello." });
    expect(modelCall.text).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ timeoutMs: expect.anything() }),
    );

    for (const invalid of [
      { ...work, input: "x", timeoutMs: 999 },
      { ...work, input: "x", effort: "xhigh" },
      { ...work, input: "x", route: [{ use: "m" }] },
      { ...work, input: "x", priority: "interactive" },
      { kind: "chat", key: "k", input: "x" },
      { kind: "profile", input: "x" },
      { ...work, key: "k".repeat(301), input: "x" },
      { ...work, input: "x".repeat(1_000_001) },
      {
        ...work,
        instructions: "i".repeat(800_000),
        input: "x".repeat(200_001),
      },
      { ...work, input: "x", output: { name: "a b", schema } },
      { ...work, input: "x", sessionKey: "" },
      // Only an approval names the Run it reviews.
      { ...work, input: "x", runOperationId: "operation-1" },
      { kind: "approval", key: "k", input: "x", runOperationId: "" },
    ])
      expect((await post(url, invalid)).status).toBe(400);
  });

  it.each([
    ["computer_offline", 503, "LOCAL_COMPUTER_OFFLINE"],
    ["pending", 503, "MODEL_CALL_PENDING"],
    ["runtime_unavailable", 503, "LOCAL_RUNTIME_UNAVAILABLE"],
    ["owner_unresolved", 409, "MODEL_OWNER_UNRESOLVED"],
    ["timed_out", 504, "MODEL_CALL_TIMED_OUT"],
    ["invalid_output", 502, "MODEL_OUTPUT_INVALID"],
    ["failed", 502, "MODEL_CALL_FAILED"],
  ] as const)(
    "answers a %s model call with %i %s",
    async (kind, status, code) => {
      const server = createAgentManagerHttpServer({
        api: new RecordingApi(),
        serviceToken,
        port: 0,
        modelCall: stubModelCall({
          text: async () => {
            throw new ModelCallError(kind, "model call failed");
          },
        }),
      });
      servers.push(server);
      const response = await authorizedFetch(
        `${(await server.start()).url}/v1/model-calls`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "memory", key: "k", input: "x" }),
        },
      );
      expect(response.status).toBe(status);
      const body = (await response.json()) as {
        error: { code: string; retryable?: boolean };
      };
      expect(body.error.code).toBe(code);
      const later = kind === "computer_offline" || kind === "pending";
      expect(response.headers.get("retry-after")).toBe(later ? "60" : null);
      expect(body.error.retryable ?? false).toBe(later);
    },
  );

  it("renders a proactive event's rules only with a judge and a valid request", async () => {
    const judge = vi.fn(async () => ({
      instructions: "[Proactive event: decide yourself]",
    }));
    const request = {
      specific: ["clients → remind directly"],
      openItems: [
        { content: "Wait for Lisa to reply with the quote" },
        { content: "Meet the client", dueAt: "2026-10-23T07:00:00Z" },
      ],
    };
    const post = (url: string, body: unknown) =>
      fetch(`${url}/v1/proactive-events:judge`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${serviceToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const without = createAgentManagerHttpServer({
      api: new RecordingApi(),
      serviceToken,
      port: 0,
    });
    servers.push(without);
    expect((await post((await without.start()).url, request)).status).toBe(503);
    const server = createAgentManagerHttpServer({
      api: new RecordingApi(),
      serviceToken,
      port: 0,
      proactiveEvents: { judge },
    });
    servers.push(server);
    const { url } = await server.start();
    const judged = await post(url, request);
    expect(judged.status).toBe(200);
    expect(await judged.json()).toEqual({
      instructions: "[Proactive event: decide yourself]",
    });
    expect(judge).toHaveBeenCalledWith(request);
    const manyItems = {
      ...request,
      openItems: Array.from({ length: 1000 }, () => ({
        content: "€✓".repeat(100),
      })),
    };
    expect((await post(url, manyItems)).status).toBe(200);
    expect(judge).toHaveBeenLastCalledWith(manyItems);
    for (const invalid of [
      { ...request, event: { source: "gmail" } },
      { ...request, specific: ["x".repeat(201)] },
      { ...request, openItems: [{ content: "" }] },
      { ...request, openItems: [{ content: "x", dueAt: "soon" }] },
      { specific: [] },
    ])
      expect((await post(url, invalid)).status).toBe(400);
    expect(judge).toHaveBeenCalledTimes(2);
  });

  it("cancels the exact Room Context Run and rejects invalid or unauthenticated targets", async () => {
    const api = new RecordingApi();
    const cancel = vi.fn().mockResolvedValue("cancel_requested");
    const { address } = await startServer(
      Object.assign(api, { cancelLocalRun: cancel }),
    );
    const body = {
      request_id: "cancel-1",
      run_id: "local-run-1",
      context_ref: { kind: "meta", agent_id: "agent-1", room_id: "room-1" },
    };
    const send = (payload: unknown, authenticated = true) =>
      fetch(`${address.url}/v1/agent-runs/local-run-1/cancel`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authenticated ? { authorization: `Bearer ${serviceToken}` } : {}),
        },
        body: JSON.stringify(payload),
      });
    expect((await send(body, false)).status).toBe(401);
    expect(cancel).not.toHaveBeenCalled();
    const { room_id: _roomId, ...roomlessRef } = body.context_ref;
    expect(
      (
        await send({
          ...body,
          context_ref: roomlessRef,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await send({
          ...body,
          context_ref: { ...body.context_ref, room_id: "" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await send({
          ...body,
          context_ref: { ...body.context_ref, extra: true },
        })
      ).status,
    ).toBe(400);
    const response = await send(body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      run_id: "local-run-1",
      status: "cancel_requested",
    });
    expect(cancel).toHaveBeenCalledWith(
      { kind: "meta", agentId: "agent-1", roomId: "room-1" },
      "local-run-1",
    );
    cancel.mockResolvedValueOnce("already_terminal");
    expect(await (await send(body)).json()).toEqual({
      run_id: "local-run-1",
      status: "already_terminal",
    });
    cancel.mockResolvedValueOnce("not_found");
    expect((await send(body)).status).toBe(404);
  });

  it("keeps authenticated Run control channels available while draining", async () => {
    const server = createAgentManagerHttpServer({
      api: new RecordingApi(),
      serviceToken,

      port: 0,
      localMcpRelay: { handle: async () => new Response("run-control") },
    });
    servers.push(server);
    const address = await server.start();
    await server.drain();
    const control = await fetch(
      `${address.url}/v1/local-mcp-relay/existing-run`,
    );
    expect(await control.text()).toBe("run-control");
    expect((await fetch(`${address.url}/readyz`)).status).toBe(503);
  });

  it("rejects new business requests while draining without resetting an admitted request", async () => {
    const api = new RecordingApi();
    const entered = deferred();
    const release = deferred();
    api.refreshAgent = async () => {
      entered.resolve();
      await release.promise;
      return null;
    };
    const { server, address } = await startServer(api);
    expect(typeof server.drain).toBe("function");
    const request = fetch(
      `${address.url}/v1/agents/agent-1/registration-changes`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${serviceToken}` },
      },
    );
    await entered.promise;
    let drained = false;
    const draining = server.drain().then(() => {
      drained = true;
    });
    expect((await fetch(`${address.url}/healthz`)).status).toBe(200);
    expect((await fetch(`${address.url}/readyz`)).status).toBe(503);
    expect(
      (
        await fetch(`${address.url}/v1/model-calls`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${serviceToken}`,
            "content-type": "application/json",
          },
          body: "{}",
        })
      ).status,
    ).toBe(503);
    expect(drained).toBe(false);
    release.resolve();
    expect((await request).status).toBe(204);
    await draining;
  });
  it("preserves Room-scoped Meta identity in Agent Debug requests", async () => {
    const api = new RecordingDebugApi();
    api.ghosts.set(
      "agent-1",
      snapshotGhost({ ...registration, agentId: "agent-1" }),
    );
    const { address } = await startServer(api);
    const roomTarget = {
      tenant_id: "tenant-test",
      context_key: JSON.stringify(["meta", "agent-1", "room", "room-1"]),
      ref: { kind: "meta", agent_id: "agent-1", room_id: "room-1" },
    };

    const response = await authorizedFetch(
      `${address.url}/v1/agent-debug/history:read`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(roomTarget),
      },
    );

    expect(response.status).toBe(200);
    expect(api.historyRefs).toEqual([
      { kind: "meta", agentId: "agent-1", roomId: "room-1" },
    ]);
  });

  it("preserves Document identity in Agent Debug requests", async () => {
    const api = new RecordingDebugApi();
    api.ghosts.set(
      "agent-1",
      snapshotGhost({ ...registration, agentId: "agent-1" }),
    );
    const { address } = await startServer(api);
    const documentTarget = {
      tenant_id: "tenant-test",
      context_key: JSON.stringify(["document", "agent-1", "document-1"]),
      ref: {
        kind: "document",
        agent_id: "agent-1",
        document_id: "document-1",
      },
    };

    const response = await authorizedFetch(
      `${address.url}/v1/agent-debug/history:read`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(documentTarget),
      },
    );

    expect(response.status).toBe(200);
    expect(api.historyRefs).toEqual([
      { kind: "document", agentId: "agent-1", documentId: "document-1" },
    ]);
  });

  it("serves Runtime History behind service and Tenant authority", async () => {
    const api = new RecordingDebugApi();
    api.ghosts.set(
      "agent-1",
      snapshotGhost({ ...registration, agentId: "agent-1" }),
    );
    const { address } = await startServer(api);
    const target = {
      tenant_id: "tenant-test",
      context_key: JSON.stringify(["meta", "agent-1", "room", "room-1"]),
      ref: { kind: "meta", agent_id: "agent-1", room_id: "room-1" },
    };
    const post = (route: string, body: unknown, authenticated = true) =>
      (authenticated ? authorizedFetch : fetch)(`${address.url}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const unauthorized = await post(
      "/v1/agent-debug/history:read",
      target,
      false,
    );
    expect(unauthorized.status).toBe(401);
    expect(api.histories).toEqual([]);

    const history = await post("/v1/agent-debug/history:read", {
      ...target,
      cursor: "cursor-request-1",
      limit: 50,
    });
    expect(history.status).toBe(200);
    expect(await history.json()).toEqual({
      status: "available",
      provider_kind: "codex",
      source: "codex_rollout",
      snapshot: {
        id: "snapshot-debug-1",
        thread_id: "thread-debug-1",
        captured_at: "2026-08-24T12:00:00.000Z",
        record_count: 1,
        tail_state: "clean",
      },
      instructions: {
        status: "available",
        source: "codex_rollout",
        blocks: [
          {
            record_ordinal: 0,
            record_type: "session_meta",
            field: "base_instructions",
            text: "Debug instructions",
          },
        ],
      },
      records: [
        {
          ordinal: 1,
          turn_id: "turn-debug-1",
          category: "tool_result",
          native_type: "response_item.custom_tool_call_output",
          tool_call_id: "call-debug-1",
          native_record: {
            type: "response_item",
            payload: {
              type: "custom_tool_call_output",
              call_id: "call-debug-1",
              output: "Debug result",
            },
          },
          redacted_fields: [],
        },
      ],
      previous_cursor: "cursor-debug-1",
    });
    expect(api.historyOptions[0]).toMatchObject({
      cursor: "cursor-request-1",
      limit: 50,
    });

    const crossedTenant = await post("/v1/agent-debug/history:read", {
      ...target,
      tenant_id: "tenant-other",
    });
    expect(crossedTenant.status).toBe(404);
    expect(api.histories).toEqual(["agent-1"]);
  });

  it("serves capability-authenticated Local Context transport during restoration", async () => {
    const gateway = createTestRunnerGateway({
      contextContent: {
        publicOrigin: "https://agent.test",
        signingKey: "k".repeat(32),
      },
    });
    const contextFileHandle = vi
      .spyOn(gateway.contextViewContent!, "handle")
      .mockImplementation(
        async (_token, kind, id) => new Response(`${kind}:${id}`),
      );
    const relayHandle = vi.fn(
      async (relayId: string) => new Response(`relay:${relayId}`),
    );
    let restorationProbe: Promise<readonly [Response, Response]> | undefined;
    const server = createAgentManagerHttpServer({
      api: new RecordingApi(),

      serviceToken,
      port: 0,
      runnerGateway: gateway,
      localMcpRelay: { handle: relayHandle },
      async beforeReady(address) {
        restorationProbe = Promise.all([
          fetch(
            `${address.url}/v1/context-content/token/files/${"a".repeat(64)}`,
          ),
          fetch(`${address.url}/v1/local-mcp-relay/relay-1`, {
            method: "POST",
          }),
        ]);
        await restorationProbe;
      },
    });
    servers.push(server);
    await server.start();

    if (!restorationProbe) throw new Error("Restoration probe did not run");
    const [file, relay] = await restorationProbe;
    expect(await file.text()).toBe(`files:${"a".repeat(64)}`);
    expect(await relay.text()).toBe("relay:relay-1");
    expect(contextFileHandle).toHaveBeenCalledWith(
      "token",
      "files",
      "a".repeat(64),
      expect.any(Request),
    );
    expect(relayHandle).toHaveBeenCalledWith("relay-1", expect.any(Request));
  });

  it("applies a registration change: an active Agent is refreshed, a revoked one deleted", async () => {
    const api = new RecordingApi();
    api.ghosts.set(
      "agent-1",
      snapshotGhost({
        ...registration,
        agentId: "agent-1",
        revision: "2",
        agent: { name: "Builder", instructions: "Build changes." },
        runtime: localRuntime,
      }),
    );
    const { address } = await startServer(api);
    const notify = (agentId: string) =>
      authorizedFetch(
        `${address.url}/v1/agents/${agentId}/registration-changes`,
        { method: "POST" },
      );

    expect((await notify("agent-1")).status).toBe(204);
    expect(api.refreshes).toEqual(["agent-1"]);
    expect(api.deletions).toEqual([]);
    expect(api.ghosts.has("agent-1")).toBe(true);

    expect((await notify("agent-revoked")).status).toBe(204);
    expect((await notify("agent-revoked")).status).toBe(204);
    expect(api.deletions).toEqual(["agent-revoked", "agent-revoked"]);
  });

  it("keeps health public and requires the service bearer for management routes", async () => {
    const { address } = await startServer(new RecordingApi());

    const health = await fetch(`${address.url}/healthz`);
    const management = await fetch(`${address.url}/v1/model-calls`, {
      method: "POST",
    });

    expect(health.status).toBe(200);
    expect(management.status).toBe(401);
    await expect(management.json()).resolves.toMatchObject({
      error: {
        code: "UNAUTHENTICATED",
        request_id: expect.stringMatching(/^request_[a-f0-9]{32}$/),
      },
    });
  });

  it("reports dependency readiness separately from process health", async () => {
    let dependenciesReady = false;
    const server = createAgentManagerHttpServer({
      api: new RecordingApi(),

      operationalReadiness: async () =>
        dependenciesReady
          ? { ready: true }
          : { ready: false, reason: "teamhub_unavailable" },
      serviceToken,
      port: 0,
    });
    servers.push(server);
    const address = await server.start();

    const health = await fetch(`${address.url}/healthz`);
    const unavailable = await fetch(`${address.url}/readyz`);
    expect(health.status).toBe(200);
    expect((await fetch(`${address.url}/startupz`)).status).toBe(200);
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({
      reason: "teamhub_unavailable",
      status: "not_ready",
    });

    dependenciesReady = true;
    const ready = await fetch(`${address.url}/readyz`);
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toEqual({ status: "ok" });
  });

  it("keeps readiness and management unavailable while process health stays live during restoration", async () => {
    let releaseRestore!: () => void;
    const restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    let exposeAddress!: (address: AgentManagerHttpServerAddress) => void;
    const listening = new Promise<AgentManagerHttpServerAddress>((resolve) => {
      exposeAddress = resolve;
    });
    const server = createAgentManagerHttpServer({
      api: new RecordingApi(),
      beforeReady: async (address) => {
        exposeAddress(address);
        await restoreGate;
      },
      modelCall: stubModelCall(),
      serviceToken,
      port: 0,
    });
    servers.push(server);
    const starting = server.start();
    const address = await listening;

    const healthWhileRestoring = await fetch(`${address.url}/healthz`);
    const readinessWhileRestoring = await fetch(`${address.url}/readyz`);
    const callModel = () =>
      authorizedFetch(`${address.url}/v1/model-calls`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    const modelsWhileRestoring = await callModel();
    expect(healthWhileRestoring.status).toBe(200);
    expect((await fetch(`${address.url}/startupz`)).status).toBe(503);
    expect(readinessWhileRestoring.status).toBe(503);
    expect(modelsWhileRestoring.status).toBe(503);
    await expect(healthWhileRestoring.json()).resolves.toEqual({
      status: "ok",
    });
    await expect(readinessWhileRestoring.json()).resolves.toEqual({
      reason: "starting",
      status: "not_ready",
    });

    releaseRestore();
    await expect(starting).resolves.toEqual(address);
    await expect(fetch(`${address.url}/healthz`)).resolves.toMatchObject({
      status: 200,
    });
    await expect(fetch(`${address.url}/readyz`)).resolves.toMatchObject({
      status: 200,
    });
    // Past the restoration gate, the empty request reaches validation.
    await expect(callModel()).resolves.toMatchObject({ status: 400 });
  });

  it("aborts a blocked restoration and closes the listener", async () => {
    let exposeAddress!: (address: AgentManagerHttpServerAddress) => void;
    const listening = new Promise<AgentManagerHttpServerAddress>((resolve) => {
      exposeAddress = resolve;
    });
    const server = createAgentManagerHttpServer({
      api: new RecordingApi(),
      beforeReady: async (address) => {
        exposeAddress(address);
        await new Promise<void>(() => undefined);
      },

      serviceToken,
      port: 0,
    });
    servers.push(server);
    const starting = server.start();
    const address = await listening;

    await expect(server.close()).resolves.toBeUndefined();
    await expect(starting).rejects.toMatchObject({ name: "AbortError" });
    await expect(fetch(`${address.url}/healthz`)).rejects.toThrow();
  });

  it("closes the listener and becomes terminal when restoration fails", async () => {
    let exposeAddress!: (address: AgentManagerHttpServerAddress) => void;
    const listening = new Promise<AgentManagerHttpServerAddress>((resolve) => {
      exposeAddress = resolve;
    });
    const server = createAgentManagerHttpServer({
      api: new RecordingApi(),
      beforeReady: async (address) => {
        exposeAddress(address);
        throw new Error("restore failed");
      },

      serviceToken,
      port: 0,
    });
    servers.push(server);
    const starting = server.start();
    const address = await listening;

    await expect(starting).rejects.toThrow("restore failed");
    await expect(server.start()).rejects.toThrow(
      "cannot restart after readiness failed",
    );
    await expect(fetch(`${address.url}/healthz`)).rejects.toThrow();
  });

  it("rejects bodies larger than 64 KiB", async () => {
    const api = new RecordingDebugApi();
    const { address } = await startServer(api);
    const response = await authorizedFetch(
      `${address.url}/v1/agent-debug/history:read`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ padding: "x".repeat(64 * 1024) }),
      },
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "PAYLOAD_TOO_LARGE",
        message: "Request body must not exceed 65536 bytes",
        request_id: expect.stringMatching(/^request_[a-f0-9]{32}$/),
      },
    });
  });

  it("maps core errors and returns explicit 404 and 405 responses", async () => {
    const api = new RecordingApi();
    const { address } = await startServer(api);

    const missing = await fetch(`${address.url}/missing`);
    expect(missing.status).toBe(404);

    const registrationChanges = `${address.url}/v1/agents/agent-a/registration-changes`;
    const wrongMethod = await authorizedFetch(registrationChanges, {
      method: "GET",
    });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST");

    for (const [code, expectedStatus] of [
      ["manager_closed", 503],
      ["identity_unavailable", 503],
      ["identity_resolution_failed", 500],
    ] as const) {
      api.error = Object.assign(new Error(code), { code });
      const response = await authorizedFetch(registrationChanges, {
        method: "POST",
      });
      expect(response.status).toBe(expectedStatus);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: code.toUpperCase() },
      });
    }
  });
});

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class AcceptingLocalComputerManagement implements LocalAgentRunnerManagement {
  removeLocalComputer(): void {}

  runLocalComputerMutation<T>(
    _computerId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return operation();
  }

  requireLocalPlacement() {
    return { id: "codex-default", label: "Codex default" };
  }

  async ensureReadyLocalAgentRunner(): Promise<number> {
    return 1;
  }

  async noteAgentPlacement(): Promise<void> {}

  async finalizeDeletedLocalAgentRunner(): Promise<void> {}
}
