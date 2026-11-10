import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router";

import {
  acceptRoomMessages,
  createTestTeamHubRuntime,
} from "@/test/teamhub-test-runtime";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubActorRef,
  TeamHubMessage,
} from "@/features/teamhub/teamhub-types";

import { ThreadPanelTab } from "./thread-panel-tab";

const codex: TeamHubActorRef = {
  display_name: "Codex",
  id: "actor-codex",
  kind: "agent",
  tenant_id: "tenant-northstar",
};

function message(id: string, body: string): TeamHubMessage {
  return {
    attachments: [],
    author: codex,
    created_at: "2026-07-23T10:00:00Z",
    id,
    message_kind: "conversation",
    raw_message: body,
    room_id: "room-all",
    segments: [{ content: body, type: "text" }],
    tenant_id: "tenant-northstar",
  };
}

describe("panel adapters", () => {
  it("Thread shows composer and omits the Files section", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptRoomMessages(runtime);

    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <TeamHubRuntimeProvider runtime={runtime}>
          <MemoryRouter>
            <ThreadPanelTab
              accountId="account-jenny"
              anchorMessage={message("msg-a", "Alpha task")}
              mentionOptions={[codex]}
              tenantId="tenant-northstar"
            />
          </MemoryRouter>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );

    const threadTab = screen.getByTestId("panel-tab-thread-msg-a");
    expect(threadTab).toHaveClass("h-full", "app-work-surface");
    expect(await screen.findByLabelText("Reply in Thread")).toBeVisible();
    expect(screen.queryByText("Room Files")).toBeNull();
    expect(screen.queryByRole("button", { name: "Close Thread" })).toBeNull();
  });
});
