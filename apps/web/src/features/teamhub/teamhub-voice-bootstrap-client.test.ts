import { sentRequests } from "./teamhub-client-test-support";
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { teamHubData } from "./teamhub-api";
import { createHttpTeamHubClient } from "./teamhub-client";
import { requestUrlText } from "@linger/service-kit";

describe("voice HTTP cancellation", () => {
  it("keeps stop and close requests alive during page departure", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ id: "voice" }),
    );
    const client = createHttpTeamHubClient({
      baseUrl: "http://localhost:8080",
      fetchRequest: fetcher,
    });
    const signal = new AbortController().signal;
    await teamHubData(
      client.api.POST("/v0/voice-captures/{captureSessionId}/stop", {
        params: { path: { captureSessionId: "capture/a" } },
        signal,
        keepalive: true,
      }),
    );
    await teamHubData(
      client.api.DELETE("/v0/voice-sessions/{voiceSessionId}", {
        params: { path: { voiceSessionId: "voice/a" } },
        signal,
        keepalive: true,
      }),
    );
    expect((await sentRequests(fetcher))[0]?.[1]).toMatchObject({
      method: "POST",
      keepalive: true,
    });
    expect((await sentRequests(fetcher))[1]?.[1]).toMatchObject({
      method: "DELETE",
      keepalive: true,
    });
    expect(
      new Headers((await sentRequests(fetcher))[1]?.[1]?.headers).get(
        "Idempotency-Key",
      ),
    ).toBeNull();
  });

  it.each([
    "policy",
    "voice-capture",
    "active-capture",
    "feed",
    "start",
    "stop",
    "retry-transcript",
  ] as const)("aborts the real pending %s HTTP transport", async (resource) => {
    let received!: () => void;
    const requestReceived = new Promise<void>((resolve) => {
      received = resolve;
    });
    const paths: string[] = [];
    const server = createServer((request) => {
      paths.push(request.url ?? "");
      received();
      // Deliberately leave the response pending until the caller aborts.
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing local HTTP port");
    const transport = vi.fn<typeof fetch>((...args) => fetch(...args));
    const client = createHttpTeamHubClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      fetchRequest: transport,
    });
    const controller = new AbortController();
    const signal = controller.signal;
    const capture = { params: { path: { captureSessionId: "capture/a" } } };
    const reads = {
      policy: () =>
        teamHubData(
          client.api.GET("/v0/tenants/{tenantId}/voice-media-policy", {
            params: { path: { tenantId: "tenant/a" } },
            signal,
          }),
        ),
      "voice-capture": () =>
        teamHubData(
          client.api.GET("/v0/voice-captures/{captureSessionId}", {
            ...capture,
            signal,
          }),
        ),
      "active-capture": () =>
        teamHubData(
          client.api.GET("/v0/rooms/{roomId}/active-voice-capture", {
            params: { path: { roomId: "room/a" } },
            signal,
          }),
        ),
      feed: () =>
        teamHubData(
          client.api.GET(
            "/v0/voice-sessions/{voiceSessionId}/transcript-events",
            {
              params: { path: { voiceSessionId: "voice/a" }, query: {} },
              signal,
            },
          ),
        ),
      start: () =>
        teamHubData(
          client.api.POST("/v0/voice-sessions/{voiceSessionId}/captures", {
            params: { path: { voiceSessionId: "voice/a" } },
            body: { room_id: "room/a", start_offset_ms: 0 },
            signal,
          }),
        ),
      stop: () =>
        teamHubData(
          client.api.POST("/v0/voice-captures/{captureSessionId}/stop", {
            ...capture,
            signal,
          }),
        ),
      "retry-transcript": () =>
        teamHubData(
          client.api.POST(
            "/v0/voice-captures/{captureSessionId}/transcript-recovery/retry",
            { ...capture, signal },
          ),
        ),
    };
    const read = reads[resource]();
    const outcome = read.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      const [sent] = transport.mock.calls[0] ?? [];
      if (!(sent instanceof Request)) throw new Error("Expected a Request");
      if (resource === "start" || resource === "stop") {
        expect(sent.method).toBe("POST");
        expect(sent.headers.get("Idempotency-Key")).toBeNull();
      }
      await requestReceived;
      controller.abort();
      expect(sent.signal.aborted).toBe(true);
      expect(await outcome).toMatchObject({ name: "AbortError" });
      expect(paths).toEqual([
        {
          policy: "/v0/tenants/tenant%2Fa/voice-media-policy",
          "voice-capture": "/v0/voice-captures/capture%2Fa",
          "active-capture": "/v0/rooms/room%2Fa/active-voice-capture",
          feed: "/v0/voice-sessions/voice%2Fa/transcript-events",
          start: "/v0/voice-sessions/voice%2Fa/captures",
          stop: "/v0/voice-captures/capture%2Fa/stop",
          "retry-transcript":
            "/v0/voice-captures/capture%2Fa/transcript-recovery/retry",
        }[resource],
      ]);
    } finally {
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await outcome;
    }
  });
});

it("returns null when the Room has no active Capture", async () => {
  const transport = vi.fn<typeof fetch>(
    async () =>
      new Response("null", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  const client = createHttpTeamHubClient({
    baseUrl: "http://voice.test",
    fetchRequest: transport,
  });
  await expect(
    teamHubData(
      client.api.GET("/v0/rooms/{roomId}/active-voice-capture", {
        params: { path: { roomId: "room/a" } },
      }),
    ),
  ).resolves.toBeNull();
  expect(requestUrlText(transport.mock.calls[0]?.[0])).toMatch(
    /\/v0\/rooms\/room%2Fa\/active-voice-capture$/,
  );
});
