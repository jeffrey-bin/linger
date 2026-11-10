import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import {
  readTeamHubError,
  TeamHubError,
  TeamHubTransportError,
} from "@/features/teamhub/teamhub-error";
import { useComposerDocumentOptions } from "./use-composer-document-options";
import { useRoomMentionOptions } from "./use-room-mention-options";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const emptyPage = { items: [], page: { has_more: false } };

/** Answers a catalog read so the client fails with `error`'s kind. */
function failWith(error: Error) {
  if (error instanceof TeamHubTransportError)
    throw new TypeError("Failed to fetch");
  if (error instanceof TeamHubError)
    return Response.json(
      {
        error: {
          code: error.code,
          message: error.message,
          request_id: "test-catalog",
          retryable: error.retryable,
        },
      },
      { status: error.status },
    );
  // jsdom's DOMException is not an Error, as a browser abort is, so the client
  // would report it as a transport failure.
  if (error.name === "AbortError")
    throw Object.assign(new Error(error.message), { name: "AbortError" });
  // An unreadable body fails outside TeamHub's error mapping, like a scope
  // mismatch.
  return new Response("{", {
    headers: { "content-type": "application/json" },
  });
}

async function setup(error: Error, recover = true) {
  const runtime = createTestTeamHubRuntime();

  const routes = [
    "/v0/tenants/{tenantId}/agents",
    "/v0/tenants/{tenantId}/agent-availability",
    "/v0/library/documents",
    "/v0/library/documents/search",
  ] as const;
  const handlers = routes.map((path) => {
    const handler = vi.fn((): unknown => failWith(error));
    if (recover)
      handler
        .mockImplementationOnce(() => failWith(error))
        .mockImplementation(() => emptyPage);
    runtime.server.on("GET", path, handler);
    return handler;
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  vi.useFakeTimers();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    () => {
      const mentions = useRoomMentionOptions({
        client: runtime.client,
        members: { items: [], page: { has_more: false } },
        tenantId: "tenant-northstar",
      });
      const docs = useComposerDocumentOptions({
        client: runtime.client,
        draftDocumentIds: [],
        roomDocuments: [],
        tenantId: "tenant-northstar",
      });
      // Read status during render so Query subscribes to terminal error changes,
      // even when a failed request leaves data unchanged.
      return {
        mentions,
        docs,
        agentDirectoryStatus: mentions.agentDirectory.status,
        agentAvailabilityStatus: mentions.agentAvailability.status,
        shareableDocumentsStatus: docs.shareableDocuments.status,
      };
    },
    { wrapper },
  );
  await act(async () => {
    hook.result.current.docs.onDocumentQueryChange("plan");
    await vi.advanceTimersByTimeAsync(200);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  return { ...hook, client, handlers, spies: handlers };
}

it.each([502, 503, 504, "transport"])(
  "recovers Room catalogs after transient %s without manual retry",
  async (kind) => {
    const error =
      kind === "transport"
        ? new TeamHubTransportError("connection failed")
        : await readTeamHubError(
            new Response("<h1>Upstream unavailable</h1>", {
              status: Number(kind),
              headers: { "content-type": "text/html" },
            }),
          );
    const { result, spies, client, unmount } = await setup(error);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(2);
    expect(result.current.agentDirectoryStatus).toBe("success");
    expect(result.current.agentAvailabilityStatus).toBe("success");
    expect(result.current.shareableDocumentsStatus).toBe("success");
    unmount();
    client.clear();
  },
);

it("stops after two retries and permits a manual retry", async () => {
  const { result, handlers, spies, client, unmount } = await setup(
    new TeamHubError({ code: "HTTP_502", message: "gateway", status: 502 }),
    false,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  for (const spy of spies) expect(spy).toHaveBeenCalledTimes(3);
  expect(result.current.agentDirectoryStatus).toBe("error");
  expect(result.current.shareableDocumentsStatus).toBe("error");
  handlers[0]!.mockImplementation(() => emptyPage);
  await act(async () => {
    await result.current.mentions.agentDirectory.refetch();
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(spies[0]).toHaveBeenCalledTimes(4);
  expect(result.current.agentDirectoryStatus).toBe("success");
  unmount();
  client.clear();
});

it.each([401, 403, 404, 409, 429, 500, "schema", "abort"])(
  "does not retry permanent or unsupported failure %s",
  async (kind) => {
    const error =
      kind === "schema"
        ? new Error("scope mismatch")
        : kind === "abort"
          ? new DOMException("aborted", "AbortError")
          : new TeamHubError({
              code: "FAILED",
              message: "failed",
              status: Number(kind),
              retryable: true,
            });
    const { spies, client, unmount } = await setup(error, false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
    unmount();
    client.clear();
  },
);

it("does not retry a search TeamHub stopped at its time limit", async () => {
  const { spies, client, unmount } = await setup(
    new TeamHubError({
      code: "SEARCH_TIMEOUT",
      message: "search took too long",
      status: 503,
    }),
    false,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
  unmount();
  client.clear();
});

it("cancels pending catalog retries on unmount", async () => {
  const { spies, client, unmount } = await setup(
    new TeamHubTransportError("offline"),
    false,
  );
  unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
  client.clear();
});
