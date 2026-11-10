import { once } from "node:events";
import { readFileSync } from "node:fs";
import {
  createSecureServer,
  type Http2Session,
  type ServerHttp2Stream,
} from "node:http2";
import { getCACertificates, setDefaultCACertificates } from "node:tls";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { LocalMcpRelay } from "../../../src/agent/runner-gateway/local-mcp-relay.js";
import type { AgentLogger } from "../../../src/agent/observability/agent-log.js";

const originalCertificates = getCACertificates("default");
// Public test-only credentials: trust this local fixture without disabling TLS verification.
const certificate = readFileSync(
  new URL("../fixtures/mcp-http2/localhost-cert.pem", import.meta.url),
  "utf8",
);
const key = readFileSync(
  new URL("../fixtures/mcp-http2/localhost-key.pem", import.meta.url),
);

beforeAll(() =>
  setDefaultCACertificates([...originalCertificates, certificate]),
);
afterAll(() => setDefaultCACertificates(originalCertificates));

describe("LocalMcpRelay HTTP/2 transport", () => {
  it.each(["GET", "subscriptions/listen"])(
    "completes tools/list and audited tools/call on the same session while a %s subscription stays open",
    async (subscriptionMethod) => {
      const fixture = await createFixture();
      try {
        const subscription = await fixture.send(
          subscriptionMethod === "GET" ? undefined : subscriptionMethod,
        );
        const reader = subscription.body!.getReader();
        expect(subscription.status).toBe(200);
        expect(new TextDecoder().decode((await reader.read()).value)).toContain(
          ": subscribed",
        );

        const catalog = await fixture.send("tools/list");
        expect(catalog.status).toBe(200);
        expect(await catalog.json()).toMatchObject({
          result: { tools: [{ name: "allowed_tool" }] },
        });
        const call = await fixture.send("tools/call");
        expect(call.status).toBe(200);
        expect(await call.json()).toMatchObject({
          result: { content: [{ type: "text", text: "done" }] },
        });
        expect(fixture.subscription()!.closed).toBe(false);
        expect(new Set(fixture.requestSessions).size).toBe(1);
        expect(fixture.requestSessions).toHaveLength(3);
        expect(fixture.auditLog.log).toHaveBeenCalledWith(
          "info",
          "local_mcp_relay.tool_call_started",
          expect.objectContaining({ toolName: "allowed_tool" }),
        );
        expect(fixture.auditLog.log).toHaveBeenCalledWith(
          "info",
          "local_mcp_relay.tool_call_finished",
          expect.objectContaining({ outcome: "succeeded", httpStatus: 200 }),
        );
        expect(fixture.authorizer.authorizeLocalMcpRelay).toHaveBeenCalledTimes(
          3,
        );

        fixture.subscription()!.end();
        expect((await reader.read()).done).toBe(true);
        reader.releaseLock();
      } finally {
        await fixture.dispose();
      }
    },
  );

  it("cancels one audited call without closing the subscription or blocking the next POST", async () => {
    const fixture = await createFixture({ holdToolCall: true });
    try {
      const subscription = await fixture.send();
      const reader = subscription.body!.getReader();
      await reader.read();
      const abort = new AbortController();
      const call = await fixture.send("tools/call", abort.signal);
      const body = call.text();
      abort.abort();
      await expect(body).rejects.toThrow();
      expect(fixture.auditLog.log).toHaveBeenCalledWith(
        "warn",
        "local_mcp_relay.tool_call_finished",
        expect.objectContaining({ outcome: "canceled", httpStatus: 499 }),
      );

      const catalog = await fixture.send("tools/list");
      expect(catalog.status).toBe(200);
      await catalog.json();
      expect(fixture.subscription()!.closed).toBe(false);
      expect(new Set(fixture.requestSessions).size).toBe(1);
      fixture.subscription()!.end();
      expect((await reader.read()).done).toBe(true);
      reader.releaseLock();
    } finally {
      await fixture.dispose();
    }
  });

  it("closes an active subscription and its upstream connection when the relay shuts down", async () => {
    const fixture = await createFixture();
    try {
      const subscription = await fixture.send();
      const body = subscription.text();
      const failure = expect(body).rejects.toThrow();
      const sessionClosed = once(fixture.requestSessions[0]!, "close");
      const closing = fixture.relay.close();
      expect(fixture.relay.close()).toBe(closing);
      await closing;
      await failure;
      await sessionClosed;
      expect((await fixture.send("tools/list")).status).toBe(503);
    } finally {
      await fixture.dispose();
    }
  });
});

const createFixture = async (options: { holdToolCall?: boolean } = {}) => {
  const sessions = new Set<Http2Session>();
  const streams = new Set<ServerHttp2Stream>();
  const requestSessions: Http2Session[] = [];
  let subscription: ServerHttp2Stream | undefined;
  const subscribe = (stream: ServerHttp2Stream) => {
    subscription = stream;
    stream.respond({ ":status": 200, "content-type": "text/event-stream" });
    stream.write(": subscribed\n\n");
  };
  const upstream = createSecureServer({ key, cert: certificate });
  upstream.on("session", (session) => {
    sessions.add(session);
    session.on("error", () => {});
    session.on("close", () => sessions.delete(session));
  });
  upstream.on("stream", (stream: ServerHttp2Stream, headers) => {
    streams.add(stream);
    stream.on("error", () => {});
    stream.on("close", () => streams.delete(stream));
    requestSessions.push(stream.session!);
    expect(headers.authorization).toBe("Bearer upstream-test-credential");
    expect(headers["x-linger-operation-id"]).toBeUndefined();
    if (headers[":method"] === "GET") {
      subscribe(stream);
      return;
    }
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        id: number;
        method: string;
      };
      if (request.method === "subscriptions/listen") {
        subscribe(stream);
        return;
      }
      stream.respond({ ":status": 200, "content-type": "application/json" });
      if (request.method === "tools/call" && options.holdToolCall) {
        stream.write('{"jsonrpc":"2.0","id":1,"result":');
        return;
      }
      stream.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result:
            request.method === "tools/list"
              ? { tools: [{ name: "allowed_tool" }] }
              : { content: [{ type: "text", text: "done" }] },
        }),
      );
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("No address");
  const auditLog: AgentLogger & { log: ReturnType<typeof vi.fn> } = {
    log: vi.fn<AgentLogger["log"]>(),
    child: () => auditLog,
  };
  const authorizer = { authorizeLocalMcpRelay: vi.fn(() => {}) };
  const relay = new LocalMcpRelay({
    publicOrigin: "https://agent.test",
    authorizer,
    auditLog,
  });
  const [descriptor] = relay.register({
    run: {
      computerId: "computer-1",
      tenantId: "tenant-1",
      agentId: "agent-1",
      executionRunRef: "run-1",
      workspaceGrantId: "workspace-1",
      runnerRevision: 1,
      executionContextKey: "context-1",
      runtimeInstanceId: "runtime-1",
      viewDigest: "a".repeat(64),
    },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    servers: [
      {
        name: "http2-tools",
        url: `https://127.0.0.1:${address.port}/mcp`,
        toolNames: ["allowed_tool"],
        httpHeaders: { authorization: "Bearer upstream-test-credential" },
      },
    ],
  });
  if (!descriptor) throw new Error("No descriptor");
  const relayId = new URL(descriptor.relay_url).pathname.split("/").at(-1)!;
  return {
    relay,
    auditLog,
    authorizer,
    requestSessions,
    upstreamUrl: `https://127.0.0.1:${address.port}/mcp`,
    subscription: () => subscription,
    send: (
      method?: string,
      signal = method
        ? AbortSignal.timeout(1_500)
        : new AbortController().signal,
    ) =>
      relay.handle(
        relayId,
        new Request(descriptor.relay_url, {
          method: method ? "POST" : "GET",
          headers: {
            authorization: `Bearer ${descriptor.relay_token}`,
            "content-type": "application/json",
            "x-linger-operation-id": "operation-1",
            "x-linger-execution-lease-id": "lease-1",
          },
          signal,
          ...(method
            ? {
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  method,
                  ...(method === "tools/call"
                    ? { params: { name: "allowed_tool", arguments: {} } }
                    : {}),
                }),
              }
            : {}),
        }),
      ),
    dispose: async () => {
      for (const stream of streams) stream.end();
      await relay.close();
      for (const session of sessions) session.destroy();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    },
  };
};
