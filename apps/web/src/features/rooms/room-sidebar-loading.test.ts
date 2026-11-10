import { expect, it, vi } from "vitest";

const filePanel = vi.hoisted(() => ({ evaluated: vi.fn() }));
const sidebar = vi.hoisted(() => ({ evaluated: vi.fn() }));
vi.mock("./task-sidebar/room-task-sidebar", () => {
  sidebar.evaluated();
  return { RoomTaskSidebar: () => null };
});
vi.mock("./task-sidebar/adapters/file-panel-tab", () => {
  filePanel.evaluated();
  return { ConnectedFilePanelTab: () => null };
});

it("does not evaluate the sidebar when the Room route module loads", async () => {
  await import("./room-surface");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(sidebar.evaluated).not.toHaveBeenCalled();
});

it("does not evaluate the document editor when warming the sidebar", async () => {
  await import("./task-sidebar/task-sidebar");
  expect(filePanel.evaluated).not.toHaveBeenCalled();
});
