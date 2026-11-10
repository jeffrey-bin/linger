import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import {
  createMemoryRouter,
  RouterProvider,
  Outlet,
  useParams,
} from "react-router";

import { vi } from "vitest";

import {
  createTestTeamHubRuntime,
  type TestTeamHubRuntime,
} from "@/test/teamhub-test-runtime";
import type { TestRouteHandler } from "@/test/teamhub-test-server";
import { WikiFileTree } from "./knowledge-sidebar-trees";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubDocument,
  TeamHubPersonalWiki,
} from "@/features/teamhub/teamhub-types";

import { WikiHomePage } from "./wiki-home-page";

export async function loggedInWikiRuntime() {
  const runtime = createTestTeamHubRuntime();

  return runtime;
}

export function renderWikiSurfaces(
  runtime: ReturnType<typeof createTestTeamHubRuntime>,
  initialEntry = "/t/tenant-northstar/library/wiki?tab=wiki",
) {
  window.sessionStorage.setItem(
    "linger:library-owned-collapsed:v2:tenant-northstar",
    "false",
  );
  const router = createMemoryRouter(
    [
      {
        element: (
          <>
            <WikiTestFiles />
            <Outlet />
          </>
        ),
        errorElement: <p role="alert">Workspace route unavailable.</p>,
        children: [
          {
            element: <WikiHomePage />,
            errorElement: <p role="alert">Wiki route unavailable.</p>,
            path: "/t/:tenantId/library/wiki",
          },
          {
            element: <div>Shared Document editor</div>,
            errorElement: <p role="alert">Document route unavailable.</p>,
            path: "/t/:tenantId/documents/:documentId",
          },
        ],
      },
    ],
    { initialEntries: [initialEntry] },
  );
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <RouterProvider router={router} />
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
  return { queryClient, router, ...view };
}

export function wikiDocument(
  id: string,
  title: string,
  bindingKind: "wiki_page" | "wiki_source",
  ownerKind: "agent" | "human" = bindingKind === "wiki_page"
    ? "agent"
    : "human",
): TeamHubDocument {
  const timestamp = "2026-08-23T00:00:00.000Z";
  const owner = {
    display_name: ownerKind === "agent" ? "Wiki Agent" : "Jenny",
    id: ownerKind === "agent" ? "actor-agent" : "actor-human",
    kind: ownerKind,
    tenant_id: "tenant-northstar",
  };
  return {
    capabilities: {
      comment: bindingKind === "wiki_page",
      delete: bindingKind === "wiki_source",
      duplicate: true,
      export: true,
      manage: bindingKind === "wiki_source",
      read: true,
      use_as_context: true,
      write: true,
    },
    created_at: timestamp,
    creator: owner,
    current_version: null,
    can_edit_native_content: bindingKind === "wiki_page",
    draft_capability: bindingKind === "wiki_page" ? "write" : "none",
    format: bindingKind === "wiki_page" ? "blocknote" : "markdown",
    representation_format: "markdown",
    from: [
      {
        binding_kind: bindingKind,
        context_id: "wiki-jenny",
        label: "Personal Wiki",
      },
    ],
    id,
    owner,
    status: "active",
    tenant_id: "tenant-northstar",
    title,
    updated_at: timestamp,
  };
}

export function wikiStatus(
  overrides: Partial<TeamHubPersonalWiki> = {},
): TeamHubPersonalWiki {
  const timestamp = "2026-08-23T00:00:00.000Z";
  return {
    created_at: timestamp,
    id: "wiki-jenny",
    owner_actor_id: "actor-human",
    published_generation: 1,
    state: "idle",
    tenant_id: "tenant-northstar",
    updated_at: timestamp,
    ...overrides,
  };
}

/**
 * Answers the Personal Wiki Document list with a mock the test configures;
 * each call receives the request, so `query.get("cursor")` reads the page.
 */
export function serveWikiDocuments(runtime: TestTeamHubRuntime) {
  const handler = vi.fn<TestRouteHandler>();
  runtime.server.on(
    "GET",
    "/v0/tenants/{tenantId}/personal-wiki/documents",
    handler,
  );
  return handler;
}

/** Answers the Personal Wiki status with a mock the test configures. */
export function serveWikiStatus(runtime: TestTeamHubRuntime) {
  const handler = vi.fn<TestRouteHandler>();
  runtime.server.on("GET", "/v0/tenants/{tenantId}/personal-wiki", handler);
  return handler;
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function WikiTestFiles() {
  return <WikiFileTree tenantId={useParams().tenantId!} />;
}
