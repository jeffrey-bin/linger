import { createServer, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTeamHubRuntimeStateClient,
  withRuntimeConfigTimingContext,
} from "../../../src/agent/executor/teamhub-runtime-state-client.js";
import * as agentLog from "../../../src/agent/observability/agent-log.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  agentLog.setAgentLogOptions();
});

const captureEvents = () => {
  vi.stubEnv("AGENT_LOG_LEVEL", "info");
  agentLog.setAgentLogOptions({ format: "json" });
  const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
  return () =>
    output.mock.calls
      .map(([line]) => JSON.parse(String(line)))
      .filter((entry) => entry.event.startsWith("runtime_config.get_config_"));
};

const fixture = async (respond: (response: ServerResponse) => void) => {
  const server = createServer((_request, response) => respond(response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP port");
  return {
    client: createTeamHubRuntimeStateClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      serviceToken: "private-service-token",
      requestTimeoutMs: 1_000,
    }),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

describe("Runtime config HTTP timing", () => {
  it("completes only after the real HTTP body and config JSON are read", async () => {
    const events = captureEvents();
    let finishBody!: () => void;
    const http = await fixture((response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"agent_id":"agent-1",');
      finishBody = () =>
        response.end('"agent":{"instructions":"private-business-body"}}');
    });
    try {
      const reading = http.client.getConfig("agent-1");
      await vi.waitFor(() => expect(finishBody).toBeTypeOf("function"));
      expect(events()).toEqual([]);
      finishBody();
      await expect(reading).resolves.toEqual({
        agent_id: "agent-1",
        agent: { instructions: "private-business-body" },
      });
      expect(events()).toHaveLength(1);
      const [completed] = events();
      expect(completed).toMatchObject({
        event: "runtime_config.get_config_completed",
        agentId: "agent-1",
        phase: "unscoped",
        method: "GET",
        endpoint: "getConfig",
        outcome: "success",
        attemptCount: 1,
        httpStatus: 200,
      });
      expect(completed.configReadId).toBeTypeOf("string");
      expect(completed.configTraceId).toBe(completed.configReadId);
      expect(Date.parse(completed.startedAt)).toBeLessThanOrEqual(
        Date.parse(completed.time),
      );
      expect(completed.durationMs).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(events())).not.toMatch(
        /private-service-token|private-business-body/u,
      );
    } finally {
      finishBody?.();
      await http.close();
    }
  });

  it("records actual retry attempts without changing the HTTP error", async () => {
    const events = captureEvents();
    let attempts = 0;
    const http = await fixture((response) => {
      attempts += 1;
      response.writeHead(503, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { code: "UNAVAILABLE", retryable: false } }),
      );
    });
    try {
      await expect(http.client.getConfig("agent-1")).rejects.toMatchObject({
        status: 503,
        code: "UNAVAILABLE",
        retryable: false,
      });
      expect(attempts).toBe(3);
      expect(events()).toHaveLength(1);
      expect(events()[0]).toMatchObject({
        outcome: "failed",
        attemptCount: 3,
        httpStatus: 503,
      });
    } finally {
      await http.close();
    }
  });

  it("records cancellation without retrying or altering the cancellation error", async () => {
    const events = captureEvents();
    let entered = false;
    const http = await fixture((response) => {
      entered = true;
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"agent_id":');
    });
    const controller = new AbortController();
    try {
      const reading = http.client.getConfig(
        "agent-1",
        undefined,
        controller.signal,
      );
      const rejected = expect(reading).rejects.toMatchObject({
        status: null,
        retryable: true,
      });
      await vi.waitFor(() => expect(entered).toBe(true));
      controller.abort(new Error("private-abort-reason"));
      await rejected;
      expect(events()).toHaveLength(1);
      expect(events()[0]).toMatchObject({
        outcome: "cancelled",
        attemptCount: 1,
      });
      expect(JSON.stringify(events())).not.toContain("private-abort-reason");
    } finally {
      controller.abort();
      await http.close();
    }
  });

  it("records config JSON decode failures without changing retry policy", async () => {
    const events = captureEvents();
    const http = await fixture((response) => response.end("invalid JSON"));
    try {
      await expect(http.client.getConfig("agent-1")).rejects.toMatchObject({
        status: 200,
        retryable: false,
      });
      expect(events()).toHaveLength(1);
      expect(events()[0]).toMatchObject({
        outcome: "failed",
        httpStatus: 200,
        attemptCount: 1,
      });
    } finally {
      await http.close();
    }
  });

  it("keeps concurrent phase, context, and retry counts isolated", async () => {
    const events = captureEvents();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstAttempts = 0;
    const fetchRequest = vi.fn(async (input) => {
      const agentId = new URL(String(input)).searchParams.get("agent_id");
      if (agentId === "agent-a") {
        firstAttempts += 1;
        if (firstAttempts === 1) return Response.json({}, { status: 503 });
        await gate;
      }
      return Response.json({ agent_id: agentId });
    });
    const client = createTeamHubRuntimeStateClient({
      baseUrl: "https://teamhub.example.test",
      serviceToken: "test",
      fetch: fetchRequest,
    });
    const first = withRuntimeConfigTimingContext(
      {
        agentId: "agent-a",
        contextKey: "context-a",
        contextKind: "meta",
        phase: "create",
      },
      () => client.getConfig("agent-a"),
    );
    try {
      await withRuntimeConfigTimingContext(
        {
          agentId: "agent-b",
          contextKey: "context-b",
          contextKind: "meta",
          phase: "preaccept",
        },
        () => client.getConfig("agent-b"),
      );
      expect(
        events().filter(({ event }) => event.endsWith("completed")),
      ).toHaveLength(1);
      release();
      await first;
      const completed = events().filter(({ event }) =>
        event.endsWith("completed"),
      );
      expect(completed).toEqual([
        expect.objectContaining({
          agentId: "agent-b",
          contextKey: "context-b",
          phase: "preaccept",
          attemptCount: 1,
        }),
        expect.objectContaining({
          agentId: "agent-a",
          contextKey: "context-a",
          phase: "create",
          attemptCount: 2,
        }),
      ]);
      expect(completed[0].configTraceId).not.toBe(completed[1].configTraceId);
    } finally {
      release();
      await first;
    }
  });

  it("keeps successful output and HTTP failures unchanged when the log sink throws", async () => {
    vi.stubEnv("AGENT_LOG_LEVEL", "info");
    const output = vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("sink failed");
    });
    const fetchRequest = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ agent_id: "agent-1" }))
      .mockResolvedValueOnce(
        Response.json({ error: { code: "MISSING" } }, { status: 404 }),
      );
    const client = createTeamHubRuntimeStateClient({
      baseUrl: "https://teamhub.example.test",
      serviceToken: "private-service-token",
      fetch: fetchRequest,
    });
    await expect(client.getConfig("agent-1")).resolves.toEqual({
      agent_id: "agent-1",
    });
    await expect(client.getConfig("agent-1")).rejects.toMatchObject({
      status: 404,
      code: "MISSING",
      retryable: false,
    });
    expect(fetchRequest).toHaveBeenCalledTimes(2);
    expect(output).toHaveBeenCalledTimes(2);
  });

  it("keeps the request result unchanged when the timing observer throws", async () => {
    const observer = vi
      .spyOn(agentLog, "logAgentEvent")
      .mockImplementation(() => {
        throw new Error("observer failed");
      });
    const client = createTeamHubRuntimeStateClient({
      baseUrl: "https://teamhub.example.test",
      serviceToken: "test",
      fetch: async () => Response.json({ agent_id: "agent-1" }),
    });
    await expect(client.getConfig("agent-1")).resolves.toEqual({
      agent_id: "agent-1",
    });
    expect(observer).toHaveBeenCalledTimes(1);
  });
});
