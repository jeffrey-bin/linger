import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import type { TeamHubRoomBackgroundTask } from "@/features/teamhub/teamhub-types";
import {
  BackgroundTasksIndicator,
  BackgroundTasksPill,
  runningFor,
} from "./background-tasks-indicator";

const now = Date.parse("2026-10-28T14:31:00Z");

const tasks: TeamHubRoomBackgroundTask[] = [
  {
    id: "task-1",
    title: "Summarize last week's competitor table",
    requirement: "Find last week's competitor table and write the conclusions.",
    created_at: "2026-10-28T14:05:00Z",
  },
  {
    id: "task-2",
    title: "Draft the launch email to Lena",
    requirement: "Use the November 6 launch date from the recording.",
    created_at: "2026-10-28T14:27:00Z",
  },
];

describe("BackgroundTasksPill", () => {
  it("counts running Tasks and opens a short list of what each one does", () => {
    render(<BackgroundTasksPill now={now} tasks={tasks} />);
    const pill = screen.getByRole("button", {
      name: "2 tasks running in the background",
    });
    expect(pill).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("region", { name: "Background tasks" }),
    ).toBeNull();

    fireEvent.click(pill);
    const list = screen.getByRole("region", { name: "Background tasks" });
    expect(pill).toHaveAttribute("aria-expanded", "true");
    expect(
      within(list).getByText("Summarize last week's competitor table"),
    ).toBeVisible();
    expect(
      within(list).getByText(
        "Use the November 6 launch date from the recording.",
      ),
    ).toBeVisible();
    expect(within(list).getByText("26 min")).toBeVisible();
    expect(within(list).getByText("4 min")).toBeVisible();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(
      screen.queryByRole("region", { name: "Background tasks" }),
    ).toBeNull();
    fireEvent.click(pill);
    fireEvent.pointerDown(document.body);
    expect(
      screen.queryByRole("region", { name: "Background tasks" }),
    ).toBeNull();
  });

  it("says one task in the singular", () => {
    render(<BackgroundTasksPill now={now} tasks={tasks.slice(0, 1)} />);
    expect(
      screen.getByRole("button", { name: "1 task running in the background" }),
    ).toBeVisible();
  });
});

describe("BackgroundTasksIndicator", () => {
  function renderIndicator(items: TeamHubRoomBackgroundTask[]) {
    const { client, server } = createTestTeamHubRuntime();
    const list = vi.fn(() => ({ items }));
    server.on("GET", "/v0/rooms/{roomId}/background-tasks", list);
    const view = render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <BackgroundTasksIndicator
          client={client}
          roomId="room-1"
          tenantId="tenant-1"
        />
      </QueryClientProvider>,
    );
    return { list, ...view };
  }

  it("shows nothing when no background Task runs", async () => {
    const { container, list } = renderIndicator([]);
    await waitFor(() =>
      expect(list).toHaveBeenCalledWith(
        expect.objectContaining({ params: { roomId: "room-1" } }),
      ),
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("floats the pill while Tasks run", async () => {
    renderIndicator(tasks);
    expect(
      await screen.findByRole("button", {
        name: "2 tasks running in the background",
      }),
    ).toBeVisible();
  });
});

describe("runningFor", () => {
  it("uses the coarsest unit that fits", () => {
    expect(runningFor("2026-10-28T14:30:30Z", now)).toBe("just now");
    expect(runningFor("2026-10-28T12:00:00Z", now)).toBe("2 h");
    expect(runningFor("2026-10-25T14:31:00Z", now)).toBe("3 d");
  });
});
