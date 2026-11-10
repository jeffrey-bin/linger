import { QueryClient } from "@tanstack/react-query";
import {
  matchRoutes,
  RouterContextProvider,
  type LoaderFunction,
  type RouteObject,
} from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { teamHubErrorResponse } from "@/test/teamhub-test-server";
import { teamHubSessionQueryKey } from "@/features/rooms/room-queries";

import { createAppRoutes } from "./router";

afterEach(() => vi.useRealTimers());

describe("Web app route contract", () => {
  it("bounds an unresponsive landing loader without letting its late failure clear a new Session", async () => {
    vi.useFakeTimers();
    const runtime = createTestTeamHubRuntime();
    runtime.server.on("GET", "/v0/session", () => ({ id: "current" }));
    let respondLate!: (response: Response) => void;
    runtime.server.on(
      "GET",
      "/v0/tenants",
      () =>
        new Promise((resolve) => {
          respondLate = resolve;
        }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const loader = createAppRoutes(queryClient, runtime).find(
      (route) => route.path === "/",
    )!.loader as LoaderFunction;
    const result = Promise.resolve(
      loader({
        request: new Request("http://localhost/"),
        url: new URL("http://localhost/"),
        pattern: "/",
        params: {},
        context: new RouterContextProvider(),
      }),
    );
    const assertion = expect(result).rejects.toMatchObject({
      code: "AUTHENTICATION_TIMEOUT",
      status: 408,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    queryClient.setQueryData(teamHubSessionQueryKey, { id: "new-session" });
    respondLate(teamHubErrorResponse(401, "UNAUTHENTICATED", "old request"));
    await vi.advanceTimersByTimeAsync(0);
    expect(queryClient.getQueryData(teamHubSessionQueryKey)).toEqual({
      id: "new-session",
    });
    queryClient.clear();
  });

  it("mounts the Room-first Product Client surfaces", () => {
    const paths = routePaths();

    expect(paths).toEqual(
      expect.arrayContaining([
        "/",
        "/login",
        "/oauth/composio-complete",
        "/t/:tenantId",
        "rooms",
        "rooms/:roomId",
        "chat",
        "profile",
        "dashboard/:workItemId",
        "documents/:documentId",
        "settings",
        "account",
        "security",
        "wiki/:collection?",
        "meetings",
      ]),
    );
  });

  it("keeps Work Item links and Room chat reachable", () => {
    const routes = createAppRoutes(
      new QueryClient(),
      createTestTeamHubRuntime(),
    );
    expect(
      matchRoutes(routes, "/t/tenant-a/dashboard/work-item-a")?.at(-1)?.route
        .path,
    ).toBe("dashboard/:workItemId");
    expect(
      matchRoutes(routes, "/t/tenant-a/rooms/room-a/chat")?.at(-1)?.route.path,
    ).toBe("chat");
  });

  it("mounts My Documents, Shared with me, and Wiki below Library", () => {
    const tenantRoute = createAppRoutes(
      new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      createTestTeamHubRuntime(),
    ).find((route) => route.path === "/t/:tenantId");

    // Library sits in the pathless Workspace layout beside opened Documents.
    const workspace = tenantRoute?.children?.find((route) =>
      route.children?.some((child) => child.path === "documents/:documentId"),
    );
    const library = workspace?.children?.find(
      (route) => route.path === "library",
    );
    expect(library?.children?.map((route) => route.path)).toEqual(
      expect.arrayContaining([
        "my-documents",
        "shared-with-me",
        "wiki/:collection?",
        "meetings",
      ]),
    );
    expect(routePaths().some((path) => path.includes("artifact"))).toBe(false);
  });

  it("opens every unified Document through one stable identity route", () => {
    expect(routePaths()).toContain("documents/:documentId");
  });
});

function routePaths() {
  const routes = createAppRoutes(
    new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    createTestTeamHubRuntime(),
  );

  return flattenRoutes(routes)
    .map((route) => route.path)
    .filter((path): path is string => typeof path === "string");
}

function flattenRoutes(routes: RouteObject[]): RouteObject[] {
  return routes.flatMap((route) => [
    route,
    ...(route.children ? flattenRoutes(route.children) : []),
  ]);
}
