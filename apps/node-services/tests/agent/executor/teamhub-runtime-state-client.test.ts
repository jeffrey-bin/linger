import { describe, expect, it, vi, type Mock } from "vitest";

import { createTeamHubRuntimeStateClient } from "../../../src/agent/executor/teamhub-runtime-state-client.js";
import { requestUrlText } from "@linger/service-kit";

describe("TeamHubRuntimeStateClient retries", () => {
  it("reads deletion identity through the distinct service endpoint without caching", async () => {
    const fetchRequest = vi.fn<typeof fetch>(async () =>
      jsonResponse({ agent_id: "agent-a" }),
    );
    const client = runtimeStateClient(fetchRequest);
    await client.getDeletionSnapshot("agent-a");
    await client.getDeletionSnapshot("agent-a");
    expect(fetchRequest).toHaveBeenCalledTimes(2);
    for (const [input, init] of fetchRequest.mock.calls) {
      const url = new URL(requestUrlText(input));
      expect(url.pathname).toBe("/v0/agent-runtime/deletion-snapshot");
      expect(url.searchParams.get("agent_id")).toBe("agent-a");
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
    }
  });

  it.each([
    [new DOMException("body timed out", "TimeoutError"), true],
    [new TypeError("terminated"), true],
    [new SyntaxError("invalid JSON"), false],
  ])(
    "classifies interrupted response bodies separately from malformed JSON (%s)",
    async (failure, retryable) => {
      const fetchRequest = vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(failure);
              },
            }),
            { status: 200 },
          ),
      );
      const client = runtimeStateClient(fetchRequest);
      await expect(
        client.removeLocalComputer({
          computer_id: "runner-local",
          owner: { tenant_id: "tenant-acme", owner_actor_id: "actor-alice" },
        }),
      ).rejects.toMatchObject({ status: 200, retryable });
      expect(fetchRequest).toHaveBeenCalledOnce();
    },
  );

  it("calls the Computer connection and Run Operation endpoints", async () => {
    const placement = {
      agent_id: "agent-reviewer",
      actor_id: "actor-reviewer",
      tenant_id: "tenant-acme",
      owner_actor_id: "actor-alice",
      runtime_type: "codex" as const,
      model: "gpt-5.5",
      workspace_grant_id: "grant-owner",
      assignment_revision: "2",
    };
    const fetchRequest = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ computer_id: "computer-local" }))
      .mockResolvedValueOnce(
        jsonResponse({ computer: {}, placements: [placement] }),
      )
      .mockResolvedValueOnce(jsonResponse({ computer_id: "computer-local" }))
      .mockResolvedValueOnce(jsonResponse({ success: true }));
    const client = runtimeStateClient(fetchRequest);

    await expect(client.getLocalComputer("computer-local")).resolves.toEqual({
      computer_id: "computer-local",
    });
    await expect(
      client.connectLocalComputer({
        computer_id: "computer-local",
        owner: { tenant_id: "tenant-acme", owner_actor_id: "actor-alice" },
        credential_generation: "0",
        daemon_id: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        daemon_public_key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        identity_version: "1",
        status: "offline",
        seen_at: "2026-09-02T12:00:00Z",
        display_name: "Alice's Mac",
        runtimes: ["codex"],
        runtime_diagnostics: [],
        workspace_grants: [],
        daemon_version: "0.38.0",
      }),
    ).resolves.toMatchObject({ placements: [placement] });
    await expect(
      client.touchLocalComputer({
        computer_id: "computer-local",
        status: "online",
        seen_at: "2026-09-02T12:00:01Z",
      }),
    ).resolves.toEqual({ computer_id: "computer-local" });
    await expect(
      client.recordRunOperation({
        context_key: "context-main",
        epoch: "1",
        run_id: "run-1",
        operation_id: "operation-1",
        runtime_type: "codex",
      }),
    ).resolves.toEqual({ success: true });

    expect(
      fetchRequest.mock.calls.map(([input]) => {
        const url = new URL(String(input));
        return `${url.pathname}${url.search}`;
      }),
    ).toEqual([
      "/v0/agent-runtime/local-computer?computer_id=computer-local",
      "/v0/agent-runtime/local-computers/connect",
      "/v0/agent-runtime/local-computers/touch",
      "/v0/agent-runtime/runs/operations",
    ]);
  });
  it.each([
    { status: 500, retryable: undefined, expected: true },
    { status: 503, retryable: undefined, expected: true },
    { status: 500, retryable: false, expected: false },
    { status: 409, retryable: undefined, expected: false },
    { status: 409, retryable: true, expected: true },
  ])(
    "preserves retry policy after HTTP $status with retryable=$retryable",
    async ({ status, retryable, expected }) => {
      const fetchRequest = vi.fn(async () =>
        jsonResponse(
          {
            error: {
              code: "TEST_ERROR",
              ...(retryable === undefined ? {} : { retryable }),
            },
          },
          status,
        ),
      );
      await expect(
        runtimeStateClient(fetchRequest).getConfig("agent-reviewer"),
      ).rejects.toMatchObject({
        status,
        code: "TEST_ERROR",
        retryable: expected,
      });
      expect(fetchRequest).toHaveBeenCalledTimes(status >= 500 ? 3 : 1);
    },
  );

  it("posts a bounded Context reconciliation page", async () => {
    const fetchRequest = vi.fn().mockResolvedValue(
      jsonResponse({
        examined_count: 2,
        existing_count: 1,
        created_count: 1,
        created_context_keys: ['["meta","agent-reviewer","room","room-1"]'],
        next_cursor: "next-page",
      }),
    );
    const client = runtimeStateClient(fetchRequest);

    await expect(
      client.reconcileContexts({ limit: 1000, cursor: "current-page" }),
    ).resolves.toEqual({
      examined_count: 2,
      existing_count: 1,
      created_count: 1,
      created_context_keys: ['["meta","agent-reviewer","room","room-1"]'],
      next_cursor: "next-page",
    });
    expect(fetchRequest).toHaveBeenCalledOnce();
    expect(String(fetchRequest.mock.calls[0]?.[0])).toBe(
      "https://teamhub.example.test/v0/agent-runtime/contexts/reconcile",
    );
    expect(fetchRequest.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ limit: 1000, cursor: "current-page" }),
    });
  });

  it("retries a GET after a network failure", async () => {
    const fetchRequest = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(jsonResponse({ agent_id: "agent-reviewer" }));
    const client = runtimeStateClient(fetchRequest);

    await expect(client.getConfig("agent-reviewer")).resolves.toMatchObject({
      agent_id: "agent-reviewer",
    });
    expect(fetchRequest).toHaveBeenCalledTimes(2);
    expect(fetchRequest.mock.calls[0]?.[0]).toBe(
      fetchRequest.mock.calls[1]?.[0],
    );
  });

  it("retries the exact command after a 5xx and an interrupted 2xx body", async () => {
    const fetchRequest = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: {} }, 503))
      .mockResolvedValueOnce(interruptedJsonResponse())
      .mockResolvedValueOnce(
        jsonResponse({ created: true, context: { context_key: "context" } }),
      );
    const client = runtimeStateClient(fetchRequest);

    await expect(
      client.ensureContext({
        ref: { kind: "meta", agent_id: "agent-reviewer", room_id: "room-1" },
        target_residency: "active",
      }),
    ).resolves.toMatchObject({ created: true });

    expect(fetchRequest).toHaveBeenCalledTimes(3);
    expect(requestBodies(fetchRequest)).toEqual([
      requestBodies(fetchRequest)[0],
      requestBodies(fetchRequest)[0],
      requestBodies(fetchRequest)[0],
    ]);
  });

  it("opens the epoch with the identity the client carries", async () => {
    const fetchRequest = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ interrupted_run_ids: [], waiting_context_keys: [] }),
      );
    const client = runtimeStateClient(fetchRequest);

    await expect(client.startEpoch()).resolves.toEqual({
      interrupted_run_ids: [],
      waiting_context_keys: [],
    });
    expect(String(fetchRequest.mock.calls[0]?.[0])).toBe(
      "https://teamhub.example.test/v0/agent-runtime/epochs",
    );
    expect(fetchRequest.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ epoch: "agent-epoch-test" }),
    });
  });

  it("retries a runtime write that names the epoch", async () => {
    const fetchRequest = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: {} }, 503))
      .mockResolvedValueOnce(jsonResponse({ success: true }));
    const client = runtimeStateClient(fetchRequest);

    await client.requeueRun({
      context_key: "context",
      epoch: client.epoch,
      run_id: "run-1",
    });
    expect(fetchRequest).toHaveBeenCalledTimes(2);
    expect(requestBodies(fetchRequest)[0]).toBe(requestBodies(fetchRequest)[1]);
  });

  it("retries the idempotent Context reconciliation POST", async () => {
    const fetchRequest = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: {} }, 503))
      .mockResolvedValueOnce(
        jsonResponse({
          examined_count: 0,
          existing_count: 0,
          created_count: 0,
          created_context_keys: [],
        }),
      );
    const client = runtimeStateClient(fetchRequest);

    await expect(client.reconcileContexts({ limit: 1000 })).resolves.toEqual({
      examined_count: 0,
      existing_count: 0,
      created_count: 0,
      created_context_keys: [],
    });
    expect(fetchRequest).toHaveBeenCalledTimes(2);
    expect(requestBodies(fetchRequest)[0]).toBe(requestBodies(fetchRequest)[1]);
  });

  it("times out a stalled command response body and retries", async () => {
    const fetchRequest = vi
      .fn()
      .mockResolvedValueOnce(stalledJsonResponse())
      .mockResolvedValueOnce(
        jsonResponse({ created: false, context: { context_key: "context" } }),
      );
    const client = runtimeStateClient(fetchRequest, 20);

    await expect(
      client.ensureContext({
        ref: { kind: "meta", agent_id: "agent-reviewer", room_id: "room-1" },
        target_residency: "active",
      }),
    ).resolves.toMatchObject({ created: false });
    expect(fetchRequest).toHaveBeenCalledTimes(2);
    expect(requestBodies(fetchRequest)[0]).toBe(requestBodies(fetchRequest)[1]);
  });

  it("does not retry a non-idempotent POST on 5xx or body interruption", async () => {
    const serverFailure = vi.fn().mockResolvedValue(jsonResponse({}, 503));
    const interrupted = vi.fn().mockResolvedValue(interruptedJsonResponse());
    const input = {
      computer_id: "runner-local",
      owner: {
        tenant_id: "tenant-acme",
        owner_actor_id: "actor-alice",
      },
    };

    await expect(
      runtimeStateClient(serverFailure).removeLocalComputer(input),
    ).rejects.toMatchObject({ status: 503 });
    expect(serverFailure).toHaveBeenCalledOnce();

    await expect(
      runtimeStateClient(interrupted).removeLocalComputer(input),
    ).rejects.toMatchObject({
      status: 200,
      retryable: false,
    });
    expect(interrupted).toHaveBeenCalledOnce();
  });
});

const runtimeStateClient = (
  fetchRequest: Mock<typeof fetch>,
  requestTimeoutMs = 1_000,
) =>
  createTeamHubRuntimeStateClient({
    baseUrl: "https://teamhub.example.test",
    serviceToken: "agent-service-token",
    fetch: fetchRequest,
    epoch: "agent-epoch-test",
    requestTimeoutMs,
  });

const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

const interruptedJsonResponse = (): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"committed":'));
        controller.error(new Error("response body interrupted"));
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const stalledJsonResponse = (): Response =>
  new Response(new ReadableStream<Uint8Array>({ start() {} }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const requestBodies = (fetchRequest: ReturnType<typeof vi.fn>): unknown[] =>
  fetchRequest.mock.calls.map((call) => call[1]?.body);
