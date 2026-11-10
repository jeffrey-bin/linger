import { sentRequests } from "@/features/teamhub/teamhub-client-test-support";
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpTeamHubClient } from "@/features/teamhub/teamhub-client";
import { authenticationOperation } from "./authentication-operation";
import { teamHubData } from "@/features/teamhub/teamhub-api";

afterEach(() => vi.useRealTimers());
describe("authentication deadline at the HTTP boundary", () => {
  it("does not broadcast an expired Session from a cancelled response body", async () => {
    vi.useFakeTimers();
    let responseBody!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        responseBody = controller;
      },
    });
    const onAuthenticationRequired = vi.fn();
    const client = createHttpTeamHubClient({
      fetchRequest: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(body, { status: 401 })),
      onAuthenticationRequired,
    });
    const parent = new AbortController();
    const pending = authenticationOperation(parent.signal, (signal) =>
      teamHubData(
        client.api.GET("/v0/tenants/{tenantId}/voice-media-policy", {
          params: { path: { tenantId: "old-tenant" } },
          signal,
        }),
      ),
    );
    const assertion = expect(pending).rejects.toMatchObject({ status: 408 });
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    responseBody.enqueue(
      new TextEncoder().encode(
        '{"code":"UNAUTHENTICATED","message":"old response"}',
      ),
    );
    responseBody.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(onAuthenticationRequired).not.toHaveBeenCalled();
  });
  it("bounds an unfinished Session response body after successful HTTP headers", async () => {
    vi.useFakeTimers();
    let responseBody!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        responseBody = controller;
      },
    });
    const fetchRequest = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(body, { status: 200 }));
    const client = createHttpTeamHubClient({ fetchRequest });
    const parent = new AbortController();
    const pending = authenticationOperation(parent.signal, (signal) =>
      teamHubData(client.api.GET("/v0/session", { signal })),
    );
    const assertion = expect(pending).rejects.toMatchObject({
      code: "AUTHENTICATION_TIMEOUT",
      status: 408,
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect((await sentRequests(fetchRequest))[0]?.[1]?.signal?.aborted).toBe(
      false,
    );
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect((await sentRequests(fetchRequest))[0]?.[1]?.signal?.aborted).toBe(
      true,
    );
    responseBody.enqueue(new TextEncoder().encode('{"id":"too-late"}'));
    responseBody.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels transport when its owner is removed", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let transportSignal!: AbortSignal;
    const pending = authenticationOperation(controller.signal, (signal) => {
      transportSignal = signal;
      return new Promise(() => {});
    });
    const assertion = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await assertion;
    expect(transportSignal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
