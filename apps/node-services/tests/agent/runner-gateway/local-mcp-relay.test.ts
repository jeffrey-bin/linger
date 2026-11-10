import { createServer, type Server } from "node:http";
import { once } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalMcpRelay } from "../../../src/agent/runner-gateway/local-mcp-relay.js";
import {
  setAgentLogOptions,
  type AgentLogger,
} from "../../../src/agent/observability/agent-log.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
  vi.useRealTimers();
  vi.unstubAllEnvs();
  setAgentLogOptions();
  vi.restoreAllMocks();
});

describe("LocalMcpRelay", () => {
  it("rejects a mixed handshake batch before dispatch when pre-accepted authority denies other methods", async () => {
    const upstream = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    const authorizer = {
      authorizeLocalMcpRelay: vi.fn(
        (options: { readonly methodClass: string }) => {
          if (options.methodClass === "other") {
            throw new Error("Operation is not accepted");
          }
        },
      ),
    };
    const relay = new LocalMcpRelay({
      publicOrigin: "https://agent.test",
      authorizer,
      auditLog: createAuditLog().logger,
    });
    const [descriptor] = relay.register({
      run: localRun("run-pre-accepted-mixed-batch"),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      servers: [
        {
          name: "teamhub",
          url: "https://teamhub.test/mcp",
          toolNames: [],
        },
      ],
    });
    if (!descriptor) throw new Error("No descriptor");

    const response = await relay.handle(
      new URL(descriptor.relay_url).pathname.split("/").at(-1)!,
      relayRequestBody(descriptor.relay_token, [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "resources/read",
          params: { uri: "file:///workspace/secret" },
        },
      ]),
    );

    expect(response.status).toBe(403);
    expect(authorizer.authorizeLocalMcpRelay).toHaveBeenCalledWith(
      expect.objectContaining({ methodClass: "other" }),
    );
    expect(upstream).not.toHaveBeenCalled();
    await relay.close();
  });

  it("records low-cardinality authorization and upstream timing without duplicating tool-call info logs", async () => {
    vi.stubEnv("AGENT_LOG_LEVEL", "debug");
    setAgentLogOptions({ format: "json" });
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const upstream = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          readonly id?: string | number;
        };
        response.setHeader("content-type", "application/json");
        if (payload.id === undefined) {
          response.writeHead(202);
          response.end();
          return;
        }
        response.end(
          JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: {} }),
        );
      });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    servers.push(upstream);
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const audit = createAuditLog();
    const relay = new LocalMcpRelay({
      publicOrigin: "https://agent.test",
      authorizer: {
        async authorizeLocalMcpRelay() {
          await new Promise((resolve) => setTimeout(resolve, 2));
        },
      },
      auditLog: audit.logger,
    });
    const [descriptor] = relay.register({
      run: localRun("run-observable"),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      servers: [
        {
          name: "teamhub",
          url: `http://127.0.0.1:${address.port}/mcp?credential=must-not-log`,
          toolNames: ["allowed_tool"],
          httpHeaders: { authorization: "Bearer upstream-secret" },
        },
      ],
    });
    if (!descriptor) throw new Error("No descriptor");
    const relayId = new URL(descriptor.relay_url).pathname.split("/").at(-1)!;
    const request = (body: unknown) =>
      relayRequestBody(descriptor.relay_token, body);

    for (const body of [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      toolCall(3, "allowed_tool"),
      { jsonrpc: "2.0", id: 4, method: "ping", params: {} },
    ]) {
      const response = await relay.handle(relayId, request(body));
      await response.text();
    }

    const entries = output.mock.calls
      .map(([line]) => JSON.parse(String(line)))
      .filter((entry) => entry.event === "local_mcp_relay.request_timing");
    expect(
      entries.map((entry) => ({
        methodClass: entry.methodClass,
        level: entry.level,
        status: entry.httpStatus,
        outcome: entry.outcome,
      })),
    ).toEqual([
      {
        methodClass: "initialize",
        level: "info",
        status: 200,
        outcome: "succeeded",
      },
      {
        methodClass: "initialized",
        level: "info",
        status: 202,
        outcome: "succeeded",
      },
      {
        methodClass: "tools_list",
        level: "info",
        status: 200,
        outcome: "succeeded",
      },
      {
        methodClass: "tools_call",
        level: "debug",
        status: 200,
        outcome: "succeeded",
      },
      {
        methodClass: "other",
        level: "debug",
        status: 200,
        outcome: "succeeded",
      },
    ]);
    for (const entry of entries) {
      expect(entry).toMatchObject({
        serverName: "teamhub",
        operationId: "operation-1",
        runId: "run-observable",
        authorizationMs: expect.any(Number),
        upstreamMs: expect.any(Number),
        totalMs: expect.any(Number),
      });
      expect(entry.authorizationMs).toBeGreaterThanOrEqual(0);
      expect(entry.upstreamMs).toBeGreaterThanOrEqual(0);
      expect(entry.totalMs).toBeGreaterThanOrEqual(
        entry.authorizationMs + entry.upstreamMs,
      );
    }
    expect(entries.filter((entry) => entry.level === "info")).toHaveLength(3);
    expect(JSON.stringify(entries)).not.toMatch(
      /must-not-log|upstream-secret|allowed_tool|arguments|Bearer|127\.0\.0\.1/,
    );
    expect(audit.started()).toHaveLength(1);
    await relay.close();
  });

  it("fences requests by token, Operation, lease, expiry, and tool allowlist", async () => {
    const upstreamRequests: Array<{
      authorization?: string;
      contentType?: string;
      method?: string;
      protocolVersion?: string;
      clientHint?: string;
      cookie?: string;
      operationId?: string;
      body: unknown;
    }> = [];
    const upstream = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        upstreamRequests.push({
          authorization: request.headers.authorization,
          contentType: request.headers["content-type"],
          method: request.method,
          protocolVersion: request.headers["mcp-protocol-version"] as string,
          clientHint: request.headers["x-client-hint"] as string,
          cookie: request.headers.cookie,
          operationId: request.headers["x-linger-operation-id"] as string,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
        response.setHeader("content-type", "application/json");
        response.setHeader("mcp-session-id", "session-1");
        response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
      });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    servers.push(upstream);
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const authorizeLocalMcpRelay = vi.fn(
      ({ operationId, executionLeaseId }) => {
        if (operationId !== "operation-1" || executionLeaseId !== "lease-1") {
          throw new Error("not active");
        }
      },
    );
    const audit = createAuditLog();
    const relay = new LocalMcpRelay({
      publicOrigin: "http://10.0.0.5:31046",
      authorizer: { authorizeLocalMcpRelay },
      auditLog: audit.logger,
    });
    const run = {
      computerId: "computer-1",
      tenantId: "tenant-1",
      agentId: "agent-1",
      executionRunRef: "run-1",
      workspaceGrantId: "workspace-1",
      runnerRevision: 1,
      executionContextKey: "context-1",
      runtimeInstanceId: "runtime-1",
      viewDigest: "a".repeat(64),
    };
    const [descriptor] = relay.register({
      run,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      servers: [
        {
          name: "private-tools",
          url: `http://127.0.0.1:${address.port}/mcp`,
          toolNames: ["allowed_tool"],
          httpHeaders: { authorization: "Bearer upstream-secret" },
        },
      ],
    });
    if (!descriptor) throw new Error("No descriptor");
    const relayId = new URL(descriptor.relay_url).pathname.split("/").at(-1)!;

    const allowed = await relay.handle(
      relayId,
      relayRequest(descriptor.relay_token, "lease-1", "allowed_tool"),
    );
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("mcp-session-id")).toBe("session-1");
    expect(await allowed.json()).toMatchObject({ id: 1, result: {} });
    expect(upstreamRequests).toEqual([
      {
        authorization: "Bearer upstream-secret",
        contentType: "application/json",
        method: "POST",
        protocolVersion: "2025-06-18",
        clientHint: "preserved",
        cookie: undefined,
        operationId: undefined,
        body: expect.objectContaining({
          method: "tools/call",
          params: { name: "allowed_tool", arguments: {} },
        }),
      },
    ]);
    expect(authorizeLocalMcpRelay).toHaveBeenCalledWith(
      expect.objectContaining({
        run,
        operationId: "operation-1",
        executionLeaseId: "lease-1",
      }),
    );
    expect(audit.started()).toEqual([
      {
        auditId: expect.any(String),
        runId: "run-1",
        operationId: "operation-1",
        serverName: "private-tools",
        toolName: "allowed_tool",
      },
    ]);
    expect(audit.finished()).toEqual([
      expect.objectContaining({
        auditId: audit.started()[0]!.auditId,
        toolName: "allowed_tool",
        outcome: "succeeded",
        httpStatus: 200,
      }),
    ]);
    expect(JSON.stringify(audit.log.mock.calls)).not.toMatch(
      /upstream-secret|Bearer|arguments/,
    );

    const forbidden = await relay.handle(
      relayId,
      relayRequest(descriptor.relay_token, "lease-1", "forbidden_tool"),
    );
    expect(forbidden.status).toBe(400);
    expect(upstreamRequests).toHaveLength(1);

    const wrongLease = await relay.handle(
      relayId,
      relayRequest(descriptor.relay_token, "lease-other", "allowed_tool"),
    );
    expect(wrongLease.status).toBe(403);

    const wrongToken = await relay.handle(
      relayId,
      relayRequest("x".repeat(32), "lease-1", "allowed_tool"),
    );
    expect(wrongToken.status).toBe(401);

    const unsupportedMethod = await relay.handle(
      relayId,
      relayTransportRequest(descriptor.relay_token, {
        method: "PATCH",
        contentType: "application/json",
      }),
    );
    expect(unsupportedMethod.status).toBe(405);
    expect(unsupportedMethod.headers.get("allow")).toBe("GET, POST, DELETE");

    const unsupportedContentType = await relay.handle(
      relayId,
      relayTransportRequest(descriptor.relay_token, {
        method: "POST",
        contentType: "text/plain",
      }),
    );
    expect(unsupportedContentType.status).toBe(415);
    expect(upstreamRequests).toHaveLength(1);

    relay.revoke(run);
    const revoked = await relay.handle(
      relayId,
      relayRequest(descriptor.relay_token, "lease-1", "allowed_tool"),
    );
    expect(revoked.status).toBe(404);
  });

  it.each(["revoke", "close", "abort", "expire"])(
    "bounds pending authorization and releases it on %s",
    async (action) => {
      if (action === "expire") {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        // Node's native timeout uses internal timers, outside Vitest's clock.
        vi.spyOn(AbortSignal, "timeout").mockImplementation((delay) => {
          const expiration = new AbortController();
          setTimeout(
            () => expiration.abort(new DOMException("Expired", "TimeoutError")),
            delay,
          );
          return expiration.signal;
        });
      }
      const audit = createAuditLog();
      const upstream = vi.spyOn(globalThis, "fetch");
      const relay = new LocalMcpRelay({
        publicOrigin: "https://agent.test",
        maxActiveRequestsPerOperation: 1,
        authorizer: {
          authorizeLocalMcpRelay: ({ signal }) =>
            new Promise<void>((_resolve, reject) => {
              if (!signal)
                throw new Error("Expected bounded authorization signal");
              if (signal.aborted) {
                reject(signal.reason);
                return;
              }
              signal.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              });
            }),
        },
        auditLog: audit.logger,
      });
      const run = localRun("run-pending");
      const [descriptor] = relay.register({
        run,
        expiresAt: new Date(
          Date.now() + (action === "expire" ? 100 : 60_000),
        ).toISOString(),
        servers: [
          {
            name: "teamhub",
            url: "https://teamhub.test/mcp",
            toolNames: ["allowed_tool"],
          },
        ],
      });
      if (!descriptor) throw new Error("No descriptor");
      const relayId = new URL(descriptor.relay_url).pathname.split("/").at(-1)!;
      const controller = new AbortController();
      const request = () =>
        new Request(
          relayRequest(descriptor.relay_token, "lease-1", "allowed_tool"),
          { signal: controller.signal },
        );
      try {
        const pending = relay.handle(relayId, request());
        expect((await relay.handle(relayId, request())).status).toBe(429);
        expect(upstream).not.toHaveBeenCalled();
        if (action === "revoke") relay.revoke(run);
        if (action === "close") await relay.close();
        if (action === "abort") controller.abort();
        if (action === "expire") await vi.advanceTimersByTimeAsync(100);
        expect((await pending).status).toBe(action === "abort" ? 400 : 403);
        expect(audit.started()).toEqual([]);
        expect(upstream).not.toHaveBeenCalled();
        if (action === "abort") {
          expect((await relay.handle(relayId, request())).status).toBe(400);
        }
      } finally {
        await relay.close();
        upstream.mockRestore();
      }
    },
  );

  it("limits concurrency across descriptors for one Operation and across the Relay", async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders();
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    servers.push(upstream);
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const relay = new LocalMcpRelay({
      publicOrigin: "http://10.0.0.5:31046",
      authorizer: { authorizeLocalMcpRelay: () => undefined },
      auditLog: createAuditLog().logger,
      maxActiveRequestsPerOperation: 2,
      maxActiveRequests: 3,
    });
    const register = (runId: string, serverNames: readonly string[]) =>
      relay.register({
        run: {
          computerId: "computer-1",
          tenantId: "tenant-1",
          agentId: "agent-1",
          executionRunRef: runId,
          workspaceGrantId: `workspace-${runId}`,
          runnerRevision: 1,
          executionContextKey: "context-1",
          runtimeInstanceId: "runtime-1",
          viewDigest: runId.padEnd(64, "a").slice(0, 64),
        },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        servers: serverNames.map((name) => ({
          name,
          url: `http://127.0.0.1:${address.port}/mcp`,
          toolNames: ["allowed_tool"],
        })),
      });
    const firstRun = register("run-1", ["a", "b", "c"]);
    const secondRun = register("run-2", ["d"]);
    const thirdRun = register("run-3", ["e"]);
    const open = (descriptor: (typeof firstRun)[number], operationId: string) =>
      relay.handle(
        new URL(descriptor.relay_url).pathname.split("/").at(-1)!,
        relayRequest(
          descriptor.relay_token,
          "lease-1",
          "allowed_tool",
          operationId,
        ),
      );

    const active = [
      await open(firstRun[0]!, "operation-1"),
      await open(firstRun[1]!, "operation-1"),
    ];
    expect(await open(firstRun[2]!, "operation-1")).toMatchObject({
      status: 429,
    });

    active.push(await open(secondRun[0]!, "operation-2"));
    expect(await open(thirdRun[0]!, "operation-3")).toMatchObject({
      status: 429,
    });

    await active[0]!.body?.cancel();
    const replacement = await open(thirdRun[0]!, "operation-3");
    expect(replacement.status).toBe(200);
    await Promise.all([
      ...active.slice(1).map((response) => response.body?.cancel()),
      replacement.body?.cancel(),
    ]);
  });

  it("reserves concurrency before streaming a bounded request body", async () => {
    const upstreamRequests = vi.fn();
    const upstream = createServer((_request, response) => {
      upstreamRequests();
      response.end();
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    servers.push(upstream);
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const audit = createAuditLog();
    const relay = new LocalMcpRelay({
      publicOrigin: "http://10.0.0.5:31046",
      authorizer: { authorizeLocalMcpRelay: () => undefined },
      auditLog: audit.logger,
      maxActiveRequestsPerOperation: 2,
      maxActiveRequests: 2,
    });
    const [descriptor] = relay.register({
      run: localRun("run-stream-body"),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      servers: [
        {
          name: "private-tools",
          url: `http://127.0.0.1:${address.port}/mcp`,
          toolNames: ["allowed_tool"],
        },
      ],
    });
    if (!descriptor) throw new Error("No descriptor");
    const relayId = new URL(descriptor.relay_url).pathname.split("/").at(-1)!;
    const first = streamingRelayRequest(descriptor.relay_token);
    const second = streamingRelayRequest(descriptor.relay_token);
    const firstResponse = relay.handle(relayId, first.request);
    const secondResponse = relay.handle(relayId, second.request);

    await expect(
      relay.handle(
        relayId,
        relayRequest(descriptor.relay_token, "lease-1", "allowed_tool"),
      ),
    ).resolves.toMatchObject({ status: 429 });
    expect(audit.started()).toEqual([]);
    expect(upstreamRequests).not.toHaveBeenCalled();

    first.abort.abort();
    second.abort.abort();
    await expect(firstResponse).resolves.toMatchObject({ status: 400 });
    await expect(secondResponse).resolves.toMatchObject({ status: 400 });

    const oversized = await relay.handle(
      relayId,
      chunkedRelayRequest(descriptor.relay_token, [
        new Uint8Array(600 * 1024),
        new Uint8Array(600 * 1024),
      ]),
    );
    expect(oversized.status).toBe(413);
    expect(audit.started()).toEqual([]);
    expect(upstreamRequests).not.toHaveBeenCalled();

    await relay.close();
    await relay.close();
    await expect(
      relay.handle(
        relayId,
        relayRequest(descriptor.relay_token, "lease-1", "allowed_tool"),
      ),
    ).resolves.toMatchObject({ status: 503 });
    expect(() =>
      relay.register({
        run: localRun("run-closed"),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        servers: [],
      }),
    ).toThrow("closed");
  });

  it("audits JSON-RPC batch outcomes by request id and rejects oversized batches", async () => {
    const upstreamRequests: unknown[] = [];
    const upstream = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        upstreamRequests.push(
          JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
        );
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify([
            {
              jsonrpc: "2.0",
              id: "second",
              result: { isError: true, content: [] },
            },
            { jsonrpc: "2.0", id: "first", result: { content: [] } },
            { jsonrpc: "2.0", id: "malformed" },
          ]),
        );
      });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    servers.push(upstream);
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const audit = createAuditLog();
    const relay = new LocalMcpRelay({
      publicOrigin: "http://10.0.0.5:31046",
      authorizer: { authorizeLocalMcpRelay: () => undefined },
      auditLog: audit.logger,
    });
    const run = localRun("run-batch");
    const [descriptor] = relay.register({
      run,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      servers: [
        {
          name: "private-tools",
          url: `http://127.0.0.1:${address.port}/mcp`,
          toolNames: ["first_tool", "second_tool", "malformed_tool"],
        },
      ],
    });
    if (!descriptor) throw new Error("No descriptor");
    const relayId = new URL(descriptor.relay_url).pathname.split("/").at(-1)!;
    const response = await relay.handle(
      relayId,
      relayRequestBody(descriptor.relay_token, [
        toolCall("first", "first_tool"),
        toolCall("second", "second_tool"),
        toolCall("malformed", "malformed_tool"),
      ]),
    );
    expect(response.status).toBe(200);
    expect(audit.finished()).toEqual([]);
    await response.json();

    const auditByTool = new Map(
      audit.started().map((call) => [call.toolName, call.auditId]),
    );
    expect(audit.finished()).toEqual([
      expect.objectContaining({
        auditId: auditByTool.get("first_tool"),
        outcome: "succeeded",
        httpStatus: 200,
      }),
      expect.objectContaining({
        auditId: auditByTool.get("second_tool"),
        outcome: "failed",
        httpStatus: 200,
      }),
      expect.objectContaining({
        auditId: auditByTool.get("malformed_tool"),
        outcome: "failed",
        httpStatus: 200,
      }),
    ]);

    audit.log.mockClear();
    const oversized = await relay.handle(
      relayId,
      relayRequestBody(
        descriptor.relay_token,
        Array.from({ length: 9 }, (_, index) =>
          toolCall(index + 1, "first_tool"),
        ),
      ),
    );
    expect(oversized.status).toBe(429);
    expect(audit.started()).toEqual([]);
    expect(upstreamRequests).toHaveLength(1);
  });

  it("keeps audit started until the response ends and records revoke as canceled", async () => {
    let upstreamResponse: import("node:http").ServerResponse | undefined;
    const upstream = createServer((_request, response) => {
      upstreamResponse = response;
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"jsonrpc":"2.0","id":1,"result":');
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    servers.push(upstream);
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const audit = createAuditLog();
    const relay = new LocalMcpRelay({
      publicOrigin: "http://10.0.0.5:31046",
      authorizer: { authorizeLocalMcpRelay: () => undefined },
      auditLog: audit.logger,
    });
    const run = localRun("run-streaming");
    const [descriptor] = relay.register({
      run,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      servers: [
        {
          name: "private-tools",
          url: `http://127.0.0.1:${address.port}/mcp`,
          toolNames: ["allowed_tool"],
        },
      ],
    });
    if (!descriptor) throw new Error("No descriptor");
    const relayId = new URL(descriptor.relay_url).pathname.split("/").at(-1)!;
    const response = await relay.handle(
      relayId,
      relayRequest(descriptor.relay_token, "lease-1", "allowed_tool"),
    );
    const body = response.text();
    await vi.waitFor(() => expect(upstreamResponse).toBeDefined());
    expect(audit.finished()).toEqual([]);

    relay.revoke(run);
    await expect(body).rejects.toThrow();
    expect(audit.finished()).toEqual([
      expect.objectContaining({ outcome: "canceled", httpStatus: 499 }),
    ]);
  });

  it("replaces a Run authority only after every MCP server is valid", async () => {
    const upstream = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    servers.push(upstream);
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const relay = new LocalMcpRelay({
      publicOrigin: "http://10.0.0.5:31046",
      authorizer: { authorizeLocalMcpRelay: () => undefined },
      auditLog: createAuditLog().logger,
    });
    const run = {
      computerId: "computer-1",
      tenantId: "tenant-1",
      agentId: "agent-1",
      executionRunRef: "run-1",
      workspaceGrantId: "workspace-1",
      runnerRevision: 1,
      executionContextKey: "context-1",
      runtimeInstanceId: "runtime-1",
      viewDigest: "a".repeat(64),
    };
    const [existing] = relay.register({
      run,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      servers: [
        {
          name: "existing",
          url: `http://127.0.0.1:${address.port}/mcp`,
          toolNames: ["allowed_tool"],
        },
      ],
    });
    if (!existing) throw new Error("No descriptor");

    expect(() =>
      relay.register({
        run,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        servers: [
          {
            name: "valid",
            url: `http://127.0.0.1:${address.port}/mcp`,
            toolNames: ["allowed_tool"],
          },
          {
            name: "invalid",
            url: "file:///tmp/not-an-mcp-server",
            toolNames: ["allowed_tool"],
          },
        ],
      }),
    ).toThrow("Local MCP Relay target is invalid");

    expect(() =>
      relay.register({
        run,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        servers: [
          {
            name: "invalid-header",
            url: `http://127.0.0.1:${address.port}/mcp`,
            toolNames: ["allowed_tool"],
            httpHeaders: { host: "untrusted.example" },
          },
        ],
      }),
    ).toThrow("target header is forbidden: host");

    const response = await relay.handle(
      new URL(existing.relay_url).pathname.split("/").at(-1)!,
      relayRequest(existing.relay_token, "lease-1", "allowed_tool"),
    );
    expect(response.status).toBe(200);
    await response.body?.cancel();
  });

  it("aborts an active upstream stream when its authority expires", async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    servers.push(upstream);
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const relay = new LocalMcpRelay({
      publicOrigin: "http://10.0.0.5:31046",
      authorizer: { authorizeLocalMcpRelay: () => undefined },
      auditLog: createAuditLog().logger,
    });
    const run = localRun("run-expiring");
    const [descriptor] = relay.register({
      run,
      expiresAt: new Date(Date.now() + 100).toISOString(),
      servers: [
        {
          name: "events",
          url: `http://127.0.0.1:${address.port}/mcp`,
          toolNames: ["allowed_tool"],
        },
      ],
    });
    if (!descriptor) throw new Error("No descriptor");
    const relayId = new URL(descriptor.relay_url).pathname.split("/").at(-1)!;

    const response = await relay.handle(
      relayId,
      relayTransportRequest(descriptor.relay_token, { method: "GET" }),
    );
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow();

    const expired = await relay.handle(
      relayId,
      relayTransportRequest(descriptor.relay_token, { method: "GET" }),
    );
    expect(expired.status).toBe(404);
  });
});

const relayRequest = (
  token: string,
  lease: string,
  tool: string,
  operationId = "operation-1",
): Request =>
  new Request("http://agent.test/v1/local-mcp-relay/relay", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
      "x-client-hint": "preserved",
      cookie: "must-not-cross-relay=1",
      "x-linger-operation-id": operationId,
      "x-linger-execution-lease-id": lease,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: {} },
    }),
  });

const relayTransportRequest = (
  token: string,
  options: { readonly method: string; readonly contentType?: string },
): Request =>
  new Request("http://agent.test/v1/local-mcp-relay/relay", {
    method: options.method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.contentType ? { "content-type": options.contentType } : {}),
      "x-linger-operation-id": "operation-1",
      "x-linger-execution-lease-id": "lease-1",
    },
    ...(options.method === "POST" || options.method === "PATCH"
      ? { body: "{}" }
      : {}),
  });

const relayRequestBody = (token: string, body: unknown): Request =>
  new Request("http://agent.test/v1/local-mcp-relay/relay", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-linger-operation-id": "operation-1",
      "x-linger-execution-lease-id": "lease-1",
    },
    body: JSON.stringify(body),
  });

const streamingRelayRequest = (token: string) => {
  const abort = new AbortController();
  return {
    abort,
    request: chunkedRelayRequest(token, [new Uint8Array([123])], {
      close: false,
      signal: abort.signal,
    }),
  };
};

const chunkedRelayRequest = (
  token: string,
  chunks: readonly Uint8Array[],
  options: { close?: boolean; signal?: AbortSignal } = {},
): Request =>
  new Request("http://agent.test/v1/local-mcp-relay/relay", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-linger-operation-id": "operation-1",
      "x-linger-execution-lease-id": "lease-1",
    },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        if (options.close !== false) controller.close();
      },
    }),
    signal: options.signal,
    duplex: "half",
  } as RequestInit & { duplex: "half" });

const toolCall = (id: string | number, name: string) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: {} },
});

const localRun = (runId: string) => ({
  computerId: "computer-1",
  tenantId: "tenant-1",
  agentId: "agent-1",
  executionRunRef: runId,
  workspaceGrantId: `workspace-${runId}`,
  runnerRevision: 1,
  executionContextKey: "context-1",
  runtimeInstanceId: "runtime-1",
  viewDigest: runId.padEnd(64, "a").slice(0, 64),
});

const createAuditLog = () => {
  const log = vi.fn<AgentLogger["log"]>();
  const logger: AgentLogger = { log, child: () => logger };
  const fields = (event: string) =>
    log.mock.calls
      .filter(([, name]) => name === event)
      .map(([, , entry]) => entry as Readonly<Record<string, string>>);
  return {
    log,
    logger,
    started: () => fields("local_mcp_relay.tool_call_started"),
    finished: () => fields("local_mcp_relay.tool_call_finished"),
  };
};
