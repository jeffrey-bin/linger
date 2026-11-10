import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import type { TestRouteHandler } from "@/test/teamhub-test-server";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { TeamHubError } from "@/features/teamhub/teamhub-error";
import type { RunStatusSubscription } from "@/features/teamhub/run-status-transport";
import type {
  TeamHubRunStatus,
  TeamHubTaskActivityPage,
  TeamHubTaskExecution,
} from "@/features/teamhub/teamhub-types";
import { TaskActivitiesPanelTab } from "./task-activities-panel-tab";

const stamp = "2026-10-09T09:00:00Z";
function runStatus(
  id: string,
  status: TeamHubRunStatus["status"] = "completed",
  revision = 2,
): TeamHubRunStatus {
  return {
    id,
    run_id: id,
    room_id: "room-all",
    agent: { id: "agent-codex", kind: "agent", display_name: id },
    status,
    replied: false,
    revision,
    created_at: stamp,
    updated_at: stamp,
  };
}
const execution: TeamHubTaskExecution = {
  task_id: "task-a",
  generation: 1,
  status: "running",
  execution_revision: 1,
  desired_control: "run",
  control_revision: 0,
  control_settled_revision: 0,
  run_spec: {
    schema_version: 1,
    result_agent_actor_id: "agent-codex",
    attempt_policy: {
      policy_version: 1,
      timeout_seconds: 60,
      max_retries: 0,
      retry_on_agent_failure: false,
      retry_on_timeout: false,
    },
  },
  execution_updated_at: stamp,
};
async function setup(page: TeamHubTaskActivityPage) {
  const runtime = createTestTeamHubRuntime();

  const actor = {
    id: "actor-jenny",
    tenant_id: "tenant-northstar",
    kind: "human" as const,
    display_name: "Jenny",
  };
  runtime.server.on("GET", "/v0/work-items/{workItemId}", ({ params }) => ({
    id: params.workItemId,
    tenant_id: "tenant-northstar",
    number: 17,
    kind: "task",
    title: `Task ${params.workItemId}`,
    description: "Inspect the workspace",
    referenced_actors: [],
    priority: "medium",
    state: "in_progress",
    version: 1,
    created_by: actor,
    updated_by: actor,
    assignees: [],
    explicit_access_grants: [],
    work_room_id: "room-all",
    created_at: stamp,
    updated_at: stamp,
  }));
  const getExecution = vi.fn<TestRouteHandler>(() => execution);
  runtime.server.on("GET", "/v0/tasks/{taskId}/execution", getExecution);
  const list = vi
    .spyOn(runtime.client.workItems, "listActivities")
    .mockResolvedValue(page);
  const events = vi.fn<TestRouteHandler>(({ params, query }) => ({
    has_more: false,
    published_through_ordinal: "1",
    items:
      query.get("after") === "1"
        ? []
        : [
            {
              event_ordinal: "1",
              segment_id: params.runId,
              event: {
                type: "activity.started",
                activity_id: "same-tool-id",
                kind: "command",
                title: "Checking workspace",
              },
            },
          ],
  }));
  runtime.server.on(
    "GET",
    "/v0/rooms/{roomId}/runs/{runId}/runtime-presentation-events",
    events,
  );
  const subscriptions: Array<
    RunStatusSubscription & { cleanup: ReturnType<typeof vi.fn> }
  > = [];
  const testRuntime = {
    ...runtime,
    runStatuses: {
      subscribe(input: RunStatusSubscription) {
        const cleanup = vi.fn();
        subscriptions.push({ ...input, cleanup });
        return cleanup;
      },
    },
  };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function view(hidden = false, taskId = "task-a") {
    return (
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={testRuntime}>
          <MemoryRouter>
            <TaskActivitiesPanelTab
              hidden={hidden}
              taskId={taskId}
              tenantId="tenant-northstar"
            />
          </MemoryRouter>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    );
  }
  return { view, list, events, getExecution, subscriptions, runtime };
}

describe("Task activity panel", () => {
  it("prioritizes the active run over 50 collapsed historical runs, then loads only expanded history", async () => {
    const test = await setup({
      work_room_id: "room-all",
      active_items: [runStatus("active-agent", "active", 1)],
      history_items: Array.from({ length: 50 }, (_, i) =>
        runStatus(`history-${i}`),
      ),
    });
    const mounted = render(test.view());
    await waitFor(() => expect(test.events).toHaveBeenCalledTimes(1));
    expect(test.events.mock.calls[0]?.[0].params.runId).toBe("active-agent");
    fireEvent.click(screen.getByRole("button", { name: /history-49/ }));
    await waitFor(() => expect(test.events).toHaveBeenCalledTimes(2));
    expect(test.events.mock.calls[1]?.[0].params.runId).toBe("history-49");
    expect(await screen.findByText("Unconfirmed")).toBeVisible();
    expect(screen.getAllByLabelText("In progress")).toHaveLength(1);
    mounted.unmount();
    expect(test.subscriptions[0]?.cleanup).toHaveBeenCalledOnce();
  });

  it("refreshes on empty reconnect snapshots without resubscribing on UI changes, and stops when hidden", async () => {
    const test = await setup({
      work_room_id: "room-all",
      active_items: [runStatus("active-agent", "active", 1)],
      history_items: [],
    });
    const mounted = render(test.view());
    await waitFor(() => expect(test.subscriptions).toHaveLength(1));
    await waitFor(() => expect(test.events).toHaveBeenCalledTimes(1));
    test.list.mockResolvedValue({
      work_room_id: "room-all",
      active_items: [],
      history_items: [runStatus("active-agent", "aborted", 2)],
    });
    act(() => test.subscriptions[0]?.onCollection([]));
    await screen.findByText(/Interrupted/);
    expect(screen.queryByLabelText("In progress")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    mounted.rerender(test.view());
    expect(test.subscriptions).toHaveLength(1);
    expect(test.subscriptions[0]?.cleanup).not.toHaveBeenCalled();
    mounted.rerender(test.view(true));
    expect(test.subscriptions[0]?.cleanup).toHaveBeenCalledOnce();
    mounted.rerender(test.view(false, "task-b"));
    await waitFor(() => expect(test.subscriptions).toHaveLength(2));
    mounted.unmount();
    expect(test.subscriptions[1]?.cleanup).toHaveBeenCalledOnce();
  });

  it("ends activity after Task terminal cleanup without marking unfinished tools successful", async () => {
    const test = await setup({
      work_room_id: "room-all",
      active_items: [],
      history_items: [
        { ...runStatus("task-agent", "aborted"), stop_reason: "task_terminal" },
      ],
    });
    test.getExecution.mockReturnValue({
      ...execution,
      status: "idle",
    });
    const mounted = render(test.view());
    const group = await screen.findByRole("button", {
      name: /task-agent.*Ended/,
    });
    expect(screen.queryByText(/Interrupted/)).toBeNull();
    fireEvent.click(group);
    expect(await screen.findByText("Unconfirmed")).toBeVisible();
    expect(screen.queryByLabelText("In progress")).toBeNull();
    mounted.unmount();
  });

  it("preserves historical run states while the Task waits for approval", async () => {
    const test = await setup({
      work_room_id: "room-all",
      active_items: [runStatus("paused-agent", "active")],
      history_items: [
        runStatus("ended-agent"),
        runStatus("interrupted-agent", "aborted"),
      ],
    });
    test.getExecution.mockReturnValue({
      ...execution,
      status: "waiting_for_approval",
    });
    const mounted = render(test.view());
    expect(
      await screen.findByRole("button", { name: /paused-agent.*Paused/ }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: /ended-agent.*Ended/ }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: /interrupted-agent.*Interrupted/ }),
    ).toBeVisible();
    expect(screen.queryByLabelText("In progress")).toBeNull();
    mounted.unmount();
  });

  it("keeps Task status visible without subscribing when Room activity access is denied", async () => {
    const test = await setup({
      active_items: [],
      history_items: [],
    });
    test.list.mockRejectedValue(
      new TeamHubError({
        code: "NOT_FOUND",
        message: "Not found",
        status: 404,
      }),
    );
    const mounted = render(test.view());
    expect(await screen.findByText(/do not have access/)).toBeVisible();
    expect(screen.getByText("Running", { exact: true })).toBeVisible();
    expect(test.subscriptions).toHaveLength(0);
    expect(test.events).not.toHaveBeenCalled();
    mounted.unmount();
  });
});
