import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import type { TeamHubWorkItem } from "@/features/teamhub/teamhub-types";
import {
  tenantAgentWorkItemsQueryKey,
  tenantAgentWorkItemsQueryOptions,
  tenantWorkItemTargetQueryKey,
  tenantWorkItemTargetQueryOptions,
  tenantWorkItemsDashboardQueryKey,
  tenantWorkItemsDashboardQueryOptions,
} from "./work-item-queries";

describe("Work Item Dashboard query", () => {
  it("lists Tenant-visible Work Items assigned to one Agent", async () => {
    const assigned = workItem({
      assignees: [
        {
          actor: agentActor(),
          assigned_at: "2026-07-30T08:00:00Z",
          assigned_by: humanActor(),
        },
      ],
      id: "workitem-assigned",
    });
    const unrelated = workItem({ id: "workitem-unrelated", number: 2 });
    const runtime = createTestTeamHubRuntime();
    runtime.server.on("GET", WORK_ITEMS_PATH, () => ({
      items: [assigned, unrelated],
      page: { has_more: false },
    }));
    const queryClient = new QueryClient();

    await expect(
      queryClient.fetchQuery(
        tenantAgentWorkItemsQueryOptions(runtime.client, "tenant-a", "agent-1"),
      ),
    ).resolves.toEqual({
      items: [assigned],
      page: { has_more: false },
    });
    expect(workItemListRequests(runtime)).toEqual([
      {
        path: "/v0/tenants/tenant-a/work-items",
        query: { limit: "200", scope: "tenant" },
      },
    ]);
    expect(
      tenantAgentWorkItemsQueryOptions(runtime.client, "tenant-a", "agent-1")
        .queryKey,
    ).toEqual(tenantAgentWorkItemsQueryKey("tenant-a", "agent-1"));
  });

  it("collects every bounded cursor page without requesting archived Work Items", async () => {
    const first = workItem({ id: "workitem-1", number: 1 });
    const second = workItem({
      archived_at: "2026-07-30T09:00:00Z",
      id: "workitem-2",
      number: 2,
    });
    const runtime = createTestTeamHubRuntime();
    runtime.server.on("GET", WORK_ITEMS_PATH, ({ query }) =>
      query.get("cursor") === "next-page"
        ? { items: [second], page: { has_more: false } }
        : {
            items: [first],
            page: { has_more: true, next_cursor: "next-page" },
          },
    );
    const queryClient = new QueryClient();

    await expect(
      queryClient.fetchQuery(
        tenantWorkItemsDashboardQueryOptions(runtime.client, "tenant-a"),
      ),
    ).resolves.toEqual({
      items: [first, second],
      page: { has_more: false },
    });
    expect(workItemListRequests(runtime)).toEqual([
      {
        path: "/v0/tenants/tenant-a/work-items",
        query: { limit: "200", scope: "personal" },
      },
      {
        path: "/v0/tenants/tenant-a/work-items",
        query: { cursor: "next-page", limit: "200", scope: "personal" },
      },
    ]);
  });

  it("excludes archived Work Items from the Dashboard list", async () => {
    const active = workItem({ id: "workitem-active", number: 1 });
    const archived = workItem({
      archived_at: "2026-07-30T09:00:00Z",
      id: "workitem-archived",
      number: 2,
    });

    const result = await new QueryClient().fetchQuery(
      tenantWorkItemsDashboardQueryOptions(
        workItemClient([active, archived]),
        "tenant-a",
      ),
    );

    expect(result.items).toEqual([active]);
  });

  it("rejects a Work Item from another Tenant", async () => {
    const runtime = createTestTeamHubRuntime();
    runtime.server.on("GET", WORK_ITEMS_PATH, () => ({
      items: [workItem({ tenant_id: "tenant-b" })],
      page: { has_more: false },
    }));

    await expect(
      new QueryClient().fetchQuery(
        tenantWorkItemsDashboardQueryOptions(runtime.client, "tenant-a"),
      ),
    ).rejects.toThrow("does not match the active Tenant");
  });

  it("uses one Tenant-scoped cache with visible-only polling", () => {
    const options = tenantWorkItemsDashboardQueryOptions(
      createTestTeamHubRuntime().client,
      "tenant-a",
    );

    expect(options.queryKey).toEqual(
      tenantWorkItemsDashboardQueryKey("tenant-a"),
    );
    expect(options.refetchInterval).toBeUndefined();
    expect(options.refetchOnWindowFocus).toBe(true);
    expect(options.staleTime).toBe(0);
  });

  it("loads and Tenant-validates a deep-linked Work Item", async () => {
    const item = workItem();
    const runtime = createTestTeamHubRuntime();
    const get = vi.fn(() => item);
    runtime.server.on("GET", "/v0/work-items/{workItemId}", get);
    const queryClient = new QueryClient();

    await expect(
      queryClient.fetchQuery(
        tenantWorkItemTargetQueryOptions(runtime.client, "tenant-a", item.id),
      ),
    ).resolves.toEqual(item);
    expect(get).toHaveBeenCalledWith(
      expect.objectContaining({ params: { workItemId: item.id } }),
    );
    expect(
      tenantWorkItemTargetQueryOptions(runtime.client, "tenant-a", item.id)
        .queryKey,
    ).toEqual(tenantWorkItemTargetQueryKey("tenant-a", item.id));
  });

  it("rejects a deep-linked Work Item outside the active Tenant", async () => {
    const runtime = createTestTeamHubRuntime();
    runtime.server.on("GET", "/v0/work-items/{workItemId}", () =>
      workItem({ tenant_id: "tenant-b" }),
    );

    await expect(
      new QueryClient().fetchQuery(
        tenantWorkItemTargetQueryOptions(
          runtime.client,
          "tenant-a",
          "workitem-1",
        ),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});

function workItem(override: Partial<TeamHubWorkItem> = {}): TeamHubWorkItem {
  const actor = agentActor();
  return {
    assignees: [],
    created_at: "2026-07-30T08:00:00Z",
    created_by: actor,
    description: "Email login returns 500.",
    explicit_access_grants: [],
    id: "workitem-1",
    kind: "issue",
    number: 1,
    priority: "high",
    referenced_actors: [],
    state: "in_progress",
    tenant_id: "tenant-a",
    title: "Fix login failure",
    updated_at: "2026-07-30T08:00:00Z",
    updated_by: actor,
    version: 1,
    ...override,
  };
}

function agentActor() {
  return {
    display_name: "Codex",
    id: "agent-1",
    kind: "agent" as const,
    tenant_id: "tenant-a",
  };
}

function humanActor() {
  return {
    display_name: "Jenny",
    id: "human-1",
    kind: "human" as const,
    tenant_id: "tenant-a",
  };
}

function workItemClient(items: TeamHubWorkItem[]) {
  const runtime = createTestTeamHubRuntime();
  runtime.seed.workItems = items;
  return runtime.client;
}

const WORK_ITEMS_PATH = "/v0/tenants/{tenantId}/work-items";

function workItemListRequests(
  runtime: ReturnType<typeof createTestTeamHubRuntime>,
) {
  return runtime.server.requestsTo("GET", WORK_ITEMS_PATH).map((request) => {
    const url = new URL(request.url);
    return {
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
    };
  });
}
