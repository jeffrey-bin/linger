import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { Suspense } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";

import {
  createTestTeamHubRuntime,
  type TestTeamHubRuntime,
} from "@/test/teamhub-test-runtime";
import {
  teamHubErrorResponse,
  type TestRouteHandler,
} from "@/test/teamhub-test-server";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";

import type {
  TeamHubWorkItem,
  TeamHubWorkItemPage,
} from "@/features/teamhub/teamhub-types";
import { tenantWorkItemTargetQueryKey } from "./work-item-queries";
import { WorkItemsPage } from "./work-items-page";

describe("Dashboard page", () => {
  it("renders the authoritative lifecycle as a five-column read-only board", async () => {
    const runtime = await testRuntime();
    const identity = runtime.seed.identity;
    const human = identity.actors[0]!;
    seedWorkItems(runtime, [
      workItem(human, { id: "workitem-todo", title: "Plan release" }),
      workItem(human, {
        id: "workitem-progress",
        state: "in_progress",
        title: "Implement release",
      }),
      workItem(human, {
        id: "workitem-done",
        resolution: "completed",
        state: "resolved",
        title: "Verify release",
      }),
      workItem(human, {
        id: "workitem-closed",
        resolution: "not_planned",
        state: "resolved",
        title: "Retire old release",
      }),
    ]);

    renderPage(runtime);

    expect(
      await screen.findByRole("heading", { name: "Dashboard" }),
    ).toBeVisible();
    expect(
      within(screen.getByRole("region", { name: "Todo" })).getByText(
        "Plan release",
      ),
    ).toBeVisible();
    expect(
      within(screen.getByRole("region", { name: "In progress" })).getByText(
        "Implement release",
      ),
    ).toBeVisible();
    expect(
      within(screen.getByRole("region", { name: "Done" })).getByText(
        "Verify release",
      ),
    ).toBeVisible();
    expect(
      within(screen.getByRole("region", { name: "Closed" })).getByText(
        "Retire old release",
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Create Work Item" }),
    ).not.toBeInTheDocument();
  });

  it("keeps Task deep links focused without rendering a detail surface", async () => {
    const runtime = await testRuntime();
    const identity = runtime.seed.identity;
    const human = identity.actors[0]!;
    const item = workItem(human, {
      id: "workitem-linked",
      kind: "task",
      state: "in_progress",
      title: "Linked task",
    });
    seedWorkItems(runtime, [item]);

    renderPage(runtime, "/t/tenant-northstar/dashboard/workitem-linked");

    const card = await screen.findByRole("link", { name: /Linked task/ });
    expect(card).toHaveAttribute("aria-current", "location");
    expect(card).toHaveFocus();
    expect(screen.queryByText("Task status")).not.toBeInTheDocument();
    expect(screen.queryByText("Current phase")).not.toBeInTheDocument();
    expect(screen.queryByText("Delivery result")).not.toBeInTheDocument();
  });

  it("does not expose Work Item mutation controls", async () => {
    const runtime = await testRuntime();
    const identity = runtime.seed.identity;
    const human = identity.actors[0]!;
    seedWorkItems(runtime, [workItem(human)]);

    renderPage(runtime);
    await screen.findByText("Fix login failure");

    expect(
      screen.queryByRole("button", {
        name: /create|edit|archive|assign(?:ment)?|comment|start (?:agent )?run|cancel (?:agent )?run/i,
      }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("shows Room, creator, and assignee identity without actor filters", async () => {
    const runtime = await testRuntime();
    const identity = runtime.seed.identity;
    const human = identity.actors[0]!;
    const actors = runtime.seed.actors;
    const agent = actors.find((actor) => actor.id === "actor-codex")!;
    seedWorkItems(runtime, [
      workItem(human, {
        assignees: [
          {
            actor: agent,
            assigned_at: "2026-07-30T00:00:00Z",
            assigned_by: human,
          },
        ],
        origin_room_id: "room-all",
        priority: "high",
        title: "Ship release",
      }),
    ]);

    renderPage(runtime);

    const card = await screen.findByRole("link", { name: /Ship release/ });
    expect(within(card).getByText("High")).toBeVisible();
    expect(within(card).getByText("Jenny Bin")).toBeVisible();
    expect(
      within(card).getByRole("group", { name: "Assigned to Codex" }),
    ).toBeVisible();
    expect(
      within(card).getByRole("img", { name: "Codex avatar" }),
    ).toBeVisible();
    expect(within(card).queryByText(/Creator:/)).not.toBeInTheDocument();
    expect(within(card).queryByText(/Assignees:/)).not.toBeInTheDocument();
    expect(within(card).getByText("#all")).toBeVisible();
    expect(within(card).getByText("Jul 30, 2026")).toBeVisible();
    expect(within(card).getByText("Todo")).toBeVisible();
  });

  it("wraps an unbroken Work Item title inside its card", async () => {
    const runtime = await testRuntime();
    const identity = runtime.seed.identity;
    const human = identity.actors[0]!;
    const title = "UnbrokenWorkItemTitle".repeat(12);
    seedWorkItems(runtime, [workItem(human, { title })]);

    renderPage(runtime);

    expect(await screen.findByText(title)).toHaveClass(
      "[overflow-wrap:anywhere]",
    );
  });

  it("filters the complete board only by Room and preserves that filter in deep links", async () => {
    const runtime = await testRuntime();
    const identity = runtime.seed.identity;
    const human = identity.actors[0]!;
    const actors = runtime.seed.actors;
    const agent = actors.find((actor) => actor.id === "actor-codex")!;
    seedWorkItems(runtime, [
      workItem(human, {
        assignees: [
          {
            actor: agent,
            assigned_at: "2026-07-30T00:00:00Z",
            assigned_by: human,
          },
        ],
        id: "workitem-human",
        origin_room_id: "room-all",
        title: "Human-owned work",
      }),
      workItem(agent, {
        assignees: [
          {
            actor: human,
            assigned_at: "2026-07-30T00:00:00Z",
            assigned_by: human,
          },
        ],
        id: "workitem-agent",
        origin_room_id: "room-gtm-launch",
        title: "Agent-owned work",
      }),
    ]);

    renderPage(runtime);
    await screen.findByText("Human-owned work");

    expect(screen.queryByLabelText("Creator")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Assignee")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Room"));
    fireEvent.click(await screen.findByRole("option", { name: "#gtm-launch" }));

    expect(screen.getByText("Agent-owned work")).toBeVisible();
    expect(screen.queryByText("Human-owned work")).not.toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent(
      "/t/tenant-northstar/dashboard?room=room-gtm-launch",
    );

    fireEvent.click(screen.getByRole("link", { name: /Agent-owned work/ }));

    expect(screen.getByTestId("location")).toHaveTextContent(
      "/t/tenant-northstar/dashboard/workitem-agent?room=room-gtm-launch",
    );
    expect(await screen.findByLabelText("Room")).toHaveValue("room-gtm-launch");
  });

  it("ignores legacy actor filters and drops them from Work Item deep links", async () => {
    const runtime = await testRuntime();
    const identity = runtime.seed.identity;
    const human = identity.actors[0]!;
    const actors = runtime.seed.actors;
    const agent = actors.find((actor) => actor.id === "actor-codex")!;
    seedWorkItems(runtime, [
      workItem(human, {
        assignees: [
          {
            actor: agent,
            assigned_at: "2026-07-30T00:00:00Z",
            assigned_by: human,
          },
        ],
        id: "workitem-human",
        origin_room_id: "room-all",
        title: "Human-created work",
      }),
      workItem(agent, {
        assignees: [
          {
            actor: human,
            assigned_at: "2026-07-30T00:00:00Z",
            assigned_by: human,
          },
        ],
        id: "workitem-agent",
        origin_room_id: "room-gtm-launch",
        title: "Agent-created work",
      }),
    ]);

    renderPage(
      runtime,
      "/t/tenant-northstar/dashboard?creator=missing-creator&assignee=missing-assignee&room=room-all",
    );
    await screen.findByText("Human-created work");

    expect(screen.queryByLabelText("Creator")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Assignee")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Room")).toHaveValue("room-all");
    expect(screen.getByText("1 of 2 items")).toBeVisible();
    expect(screen.getByText("Human-created work")).toBeVisible();
    expect(screen.queryByText("Agent-created work")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: /Human-created work/ }));

    expect(screen.getByTestId("location")).toHaveTextContent(
      "/t/tenant-northstar/dashboard/workitem-human?room=room-all",
    );
  });

  it("reuses the Dashboard deep link and focuses the highlighted Work Item", async () => {
    const runtime = await testRuntime();
    const identity = runtime.seed.identity;
    const human = identity.actors[0]!;
    seedWorkItems(runtime, [
      workItem(human, { id: "workitem-focus", title: "Focused work" }),
    ]);

    renderPage(runtime, "/t/tenant-northstar/dashboard/workitem-focus");

    const focused = await screen.findByRole("link", { name: /Focused work/ });
    expect(screen.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    expect(focused).toHaveAttribute("aria-current", "location");
    expect(focused).toHaveFocus();
  });

  it("keeps newer Dashboard state when a focused detail response is stale", async () => {
    const runtime = await testRuntime();
    const identity = runtime.seed.identity;
    const human = identity.actors[0]!;
    const current = workItem(human, {
      id: "workitem-focus",
      resolution: "completed",
      state: "resolved",
      title: "Current completed work",
      version: 2,
    });
    seedWorkItems(runtime, [current]);
    runtime.server.on("GET", WORK_ITEM_PATH, () =>
      workItem(human, {
        id: current.id,
        state: "open",
        title: "Stale open work",
        version: 1,
      }),
    );

    renderPage(runtime, "/t/tenant-northstar/dashboard/workitem-focus");

    const done = await screen.findByRole("region", { name: "Done" });
    expect(within(done).getByText("Current completed work")).toBeVisible();
    expect(screen.queryByText("Stale open work")).not.toBeInTheDocument();
  });

  it("loads a deep-linked archived Work Item that is absent from the default list", async () => {
    const runtime = await testRuntime();
    const identity = runtime.seed.identity;
    const human = identity.actors[0]!;
    const focusedItem = workItem(human, {
      archived_at: "2026-07-30T09:00:00Z",
      id: "workitem-archived",
      title: "Archived focused work",
    });
    seedWorkItems(runtime, []);
    runtime.server.on("GET", WORK_ITEM_PATH, () => focusedItem);

    renderPage(runtime, "/t/tenant-northstar/dashboard/workitem-archived");

    const focused = await screen.findByRole("link", {
      name: /Archived focused work/,
    });
    expect(focused).toHaveAttribute("aria-current", "location");
    expect(focused).toHaveFocus();
    expect(screen.getByText("1 item")).toBeVisible();
  });

  it("focuses a deep-linked Work Item after Dashboard data arrives", async () => {
    const runtime = await testRuntime();
    const identity = runtime.seed.identity;
    const human = identity.actors[0]!;
    const page = deferred<TeamHubWorkItemPage>();
    seedWorkItems(runtime, []);
    runtime.server
      .on("GET", WORK_ITEM_PATH, () =>
        workItem(human, {
          id: "workitem-delayed",
          title: "Delayed work",
        }),
      )
      .on("GET", WORK_ITEMS_PATH, () => page.promise);

    renderPage(runtime, "/t/tenant-northstar/dashboard/workitem-delayed");
    expect(
      await screen.findByRole("status", { name: "Loading Dashboard" }),
    ).toBeVisible();

    await act(async () => {
      page.resolve({
        items: [
          workItem(human, {
            id: "workitem-delayed",
            title: "Delayed work",
          }),
        ],
        page: { has_more: false },
      });
    });

    const focused = await screen.findByRole("link", { name: /Delayed work/ });
    expect(focused).toHaveAttribute("aria-current", "location");
    expect(focused).toHaveFocus();
  });

  it("keeps Closed records recoverable when the column is collapsed", async () => {
    const runtime = await testRuntime();
    const identity = runtime.seed.identity;
    const human = identity.actors[0]!;
    seedWorkItems(runtime, [
      workItem(human, {
        resolution: "duplicate",
        state: "resolved",
        title: "Duplicate work",
      }),
    ]);

    renderPage(runtime);
    await screen.findByText("Duplicate work");

    fireEvent.click(screen.getByRole("button", { name: "Collapse closed" }));
    expect(screen.queryByText("Duplicate work")).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Closed" })).getByText("1"),
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Expand closed" }));
    expect(screen.getByText("Duplicate work")).toBeVisible();
  });

  it("shows an explicit empty state for a Tenant without Work Items", async () => {
    const runtime = await testRuntime();
    seedWorkItems(runtime, []);

    renderPage(runtime);

    expect(await screen.findByText("No Work Items yet")).toBeVisible();
    expect(screen.getByText("0 items")).toBeVisible();
  });

  it("shows an accessible Dashboard loading state", async () => {
    const runtime = await testRuntime();
    seedWorkItems(runtime, []);
    runtime.server.on(
      "GET",
      WORK_ITEMS_PATH,
      () => new Promise(() => undefined),
    );

    renderPage(runtime);

    expect(
      await screen.findByRole("status", { name: "Loading Dashboard" }),
    ).toBeVisible();
  });

  it("keeps a failed Dashboard query visible and retries it", async () => {
    const runtime = await testRuntime();
    const identity = runtime.seed.identity;
    const human = identity.actors[0]!;
    seedWorkItems(runtime, []);
    const list = vi
      .fn<TestRouteHandler>()
      .mockReturnValueOnce(
        teamHubErrorResponse(
          503,
          "TEAMHUB_UNAVAILABLE",
          "TeamHub could not load Work Items.",
        ),
      )
      .mockReturnValueOnce({
        items: [workItem(human, { title: "Recovered work" })],
        page: { has_more: false },
      });
    runtime.server.on("GET", WORK_ITEMS_PATH, list);

    renderPage(runtime);

    expect(
      await screen.findByRole("heading", { name: "Dashboard unavailable" }),
    ).toBeVisible();
    expect(
      screen.getByText("TeamHub could not load Work Items."),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Recovered work")).toBeVisible();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("disables retry while a failed focused detail is refetching", async () => {
    const runtime = await testRuntime();
    const identity = runtime.seed.identity;
    const human = identity.actors[0]!;
    const item = workItem(human, { id: "workitem-focus" });
    const retry = deferred<TeamHubWorkItem>();
    seedWorkItems(runtime, [item]);
    const get = vi
      .fn<TestRouteHandler>()
      .mockReturnValueOnce(item)
      .mockReturnValueOnce(
        teamHubErrorResponse(
          503,
          "TEAMHUB_UNAVAILABLE",
          "TeamHub could not load the focused Work Item.",
        ),
      )
      .mockReturnValueOnce(retry.promise);
    runtime.server.on("GET", WORK_ITEM_PATH, get);
    const queryClient = renderPage(
      runtime,
      "/t/tenant-northstar/dashboard/workitem-focus",
    );
    await screen.findByText("Fix login failure");
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: tenantWorkItemTargetQueryKey(
          "tenant-northstar",
          "workitem-focus",
        ),
      });
    });
    await screen.findByText("TeamHub could not load the focused Work Item.");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    const tryingAgain = await screen.findByRole("button", {
      name: "Trying again…",
    });
    expect(tryingAgain).toBeDisabled();
    await act(async () => retry.resolve(item));
    expect(await screen.findByText("Fix login failure")).toBeVisible();
    expect(get).toHaveBeenCalledTimes(3);
  });

  it("distinguishes a forbidden Dashboard from a transport failure", async () => {
    const runtime = await testRuntime();
    seedWorkItems(runtime, []);
    runtime.server.on("GET", WORK_ITEMS_PATH, () =>
      teamHubErrorResponse(
        403,
        "FORBIDDEN",
        "This Tenant Dashboard is not available to you.",
      ),
    );

    renderPage(runtime);

    expect(
      await screen.findByRole("heading", { name: "Access denied" }),
    ).toBeVisible();
    expect(
      screen.getByText("This Tenant Dashboard is not available to you."),
    ).toBeVisible();
  });
});

async function testRuntime() {
  const runtime = createTestTeamHubRuntime();

  return runtime;
}

function renderPage(
  runtime: ReturnType<typeof createTestTeamHubRuntime>,
  initialEntry = "/t/tenant-northstar/dashboard",
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Suspense fallback={<p>Loading...</p>}>
            <Routes>
              <Route
                element={<WorkItemsPage />}
                path="/t/:tenantId/dashboard"
              />
              <Route
                element={<WorkItemsPage />}
                path="/t/:tenantId/dashboard/:workItemId"
              />
            </Routes>
            <LocationProbe />
          </Suspense>
        </MemoryRouter>
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname}
      {location.search}
    </output>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function workItem(
  actor: TeamHubWorkItem["created_by"],
  override: Partial<TeamHubWorkItem> = {},
): TeamHubWorkItem {
  return {
    assignees: [],
    created_at: "2026-07-30T00:00:00Z",
    created_by: actor,
    description: "Email login returns 500.",
    explicit_access_grants: [],
    id: "workitem-login",
    kind: "issue",
    number: 42,
    priority: "high",
    referenced_actors: [],
    state: "open",
    tenant_id: "tenant-northstar",
    title: "Fix login failure",
    updated_at: "2026-07-30T00:00:00Z",
    updated_by: actor,
    version: 1,
    ...override,
  };
}

const WORK_ITEMS_PATH = "/v0/tenants/{tenantId}/work-items";
const WORK_ITEM_PATH = "/v0/work-items/{workItemId}";

/** Serves these Work Items from the test server. */
function seedWorkItems(runtime: TestTeamHubRuntime, items: TeamHubWorkItem[]) {
  runtime.seed.workItems = items;
}
