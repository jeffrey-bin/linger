import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { type ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";

import {
  acceptRoomMessages,
  createTestTeamHubRuntime,
  type TestTeamHubRuntime,
} from "@/test/teamhub-test-runtime";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubMessage } from "@/features/teamhub/teamhub-types";
import { ThreadPanelTab } from "./thread-panel-tab";

it("keeps only the current Activity's source Thread subscribed and releases it on target changes", async () => {
  const runtime = createTestTeamHubRuntime();
  acceptRoomMessages(runtime);
  const { items } = await teamHubData(
    runtime.client.api.GET("/v0/rooms/{roomId}/messages", {
      params: { path: { roomId: "room-all" } },
    }),
  );
  const root = items.find((message) => message.id === "message-2")!;
  const otherRoot = items.find((message) => message.id === "message-3")!;
  const thread = await createThread(runtime, root);
  const otherThread = await createThread(runtime, otherRoot);
  const cleanups: Array<ReturnType<typeof vi.fn>> = [];
  const subscribe = vi
    .spyOn(runtime.runStatuses, "subscribe")
    .mockImplementation(({ onCollection }) => {
      onCollection([]);
      const cleanup = vi.fn();
      cleanups.push(cleanup);
      return cleanup;
    });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <MemoryRouter>{children}</MemoryRouter>
      </TeamHubRuntimeProvider>
    </QueryClientProvider>
  );
  const props = {
    accountId: "account-jenny",
    anchorMessage: root,
    mentionOptions: [],
    tenantId: "tenant-northstar",
    hidden: false,
    activityRoomId: undefined as string | undefined,
  };
  const { rerender, unmount } = render(<ThreadPanelTab {...props} />, {
    wrapper,
  });
  await waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
  expect(subscribe.mock.calls[0]![0].roomId).toBe(thread.room.id);
  rerender(
    <ThreadPanelTab {...props} hidden activityRoomId={thread.room.id} />,
  );
  expect(cleanups[0]).not.toHaveBeenCalled();
  expect(subscribe).toHaveBeenCalledOnce();
  rerender(
    <ThreadPanelTab {...props} hidden activityRoomId={thread.room.id} />,
  );
  expect(subscribe).toHaveBeenCalledOnce();
  rerender(
    <ThreadPanelTab {...props} hidden activityRoomId={otherThread.room.id} />,
  );
  expect(cleanups[0]).toHaveBeenCalledOnce();
  expect(subscribe).toHaveBeenCalledOnce();
  rerender(<ThreadPanelTab {...props} anchorMessage={otherRoot} />);
  await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(2));
  expect(subscribe.mock.calls[1]![0].roomId).toBe(otherThread.room.id);
  rerender(
    <ThreadPanelTab
      {...props}
      anchorMessage={otherRoot}
      hidden
      activityRoomId={otherThread.room.id}
    />,
  );
  expect(cleanups[1]).not.toHaveBeenCalled();
  rerender(<ThreadPanelTab {...props} anchorMessage={otherRoot} hidden />);
  expect(cleanups[1]).toHaveBeenCalledOnce();
  unmount();
  expect(cleanups[0]).toHaveBeenCalledOnce();
  expect(cleanups[1]).toHaveBeenCalledOnce();
});

function createThread(runtime: TestTeamHubRuntime, message: TeamHubMessage) {
  return teamHubData(
    runtime.client.api.POST("/v0/rooms/{roomId}/messages/{messageId}/thread", {
      params: { path: { roomId: message.room_id, messageId: message.id } },
    }),
  );
}
