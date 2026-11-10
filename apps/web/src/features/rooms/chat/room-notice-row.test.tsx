import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type {
  TeamHubActorRef,
  TeamHubMessage,
} from "@/features/teamhub/teamhub-types";

import { RoomNoticeRow } from "./room-notice-row";
import { orderRoomMessages } from "./use-room-conversation";

const nova: TeamHubActorRef = {
  display_name: "Nova",
  id: "actor_nova",
  kind: "agent",
  tenant_id: "tenant-1",
};
const reviewer: TeamHubActorRef = {
  display_name: "Release Reviewer",
  id: "actor_reviewer",
  kind: "agent",
  tenant_id: "tenant-1",
};
const leo: TeamHubActorRef = {
  display_name: "Leo",
  id: "actor_leo",
  kind: "human",
  tenant_id: "tenant-1",
};

function notice(
  author: TeamHubActorRef,
  value: TeamHubMessage["notice"],
): TeamHubMessage {
  return {
    attachments: [],
    author,
    created_at: "2026-10-28T08:00:00Z",
    id: "message-notice",
    message_kind: "room_notice",
    notice: value,
    raw_message: "Fallback line.",
    room_id: "room-1",
    segments: [{ content: "Fallback line.", type: "text" }],
    tenant_id: "tenant-1",
  };
}

function renderNotice(
  message: TeamHubMessage,
  options: {
    currentActorId?: string;
    onOpenDirectChat?: (actorId: string) => void;
    onOpenProfile?: (actorId: string) => void;
  } = {},
) {
  const onOpenProfile = options.onOpenProfile ?? vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RoomNoticeRow
        currentActorId={options.currentActorId}
        message={message}
        onOpenDirectChat={options.onOpenDirectChat}
        onOpenProfile={onOpenProfile}
      />
    </QueryClientProvider>,
  );
  return screen.getByRole("note");
}

describe("RoomNoticeRow", () => {
  it("announces an Agent created here and opens its profile", () => {
    const onOpenProfile = vi.fn();
    const row = renderNotice(
      notice(nova, { agent: reviewer, type: "agent_created" }),
      { onOpenProfile },
    );
    expect(row).toHaveTextContent(
      "Nova created Release Reviewer and added it to this Room",
    );
    fireEvent.click(screen.getByRole("button", { name: "View profile" }));
    expect(onOpenProfile).toHaveBeenCalledWith(reviewer.id);
  });

  it("names the approver of an Agent created after approval", () => {
    const onOpenDirectChat = vi.fn();
    const created = notice(nova, {
      agent: reviewer,
      approved_by: leo,
      type: "agent_created",
    });
    const row = renderNotice(created, {
      currentActorId: leo.id,
      onOpenDirectChat,
    });
    expect(row).toHaveTextContent(
      "Nova created Release Reviewer after your approval",
    );
    fireEvent.click(screen.getByRole("button", { name: "Open direct chat" }));
    expect(onOpenDirectChat).toHaveBeenCalledWith(reviewer.id);
  });

  it("names another approver and falls back to the profile without direct chats", () => {
    const row = renderNotice(
      notice(nova, {
        agent: reviewer,
        approved_by: leo,
        type: "agent_created",
      }),
      { currentActorId: "actor_mia" },
    );
    expect(row).toHaveTextContent("after Leo's approval");
    expect(screen.getByRole("button", { name: "View profile" })).toBeVisible();
  });

  it("announces a new member without links", () => {
    const row = renderNotice(
      notice(leo, { member: reviewer, type: "member_added" }),
    );
    expect(row).toHaveTextContent("Leo added Release Reviewer to this Room");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows an Agent setting up its own identity", () => {
    const row = renderNotice(
      notice(reviewer, {
        agent: reviewer,
        changes: [
          { after: "Release Reviewer", before: "New Agent", field: "name" },
        ],
        initialized: true,
        instructions_changed: true,
        type: "agent_profile_changed",
      }),
    );
    expect(row).toHaveTextContent(
      "New Agent set up its identity as Release Reviewer",
    );
  });

  it("keeps the changes of an identity update folded until asked", () => {
    const onOpenProfile = vi.fn();
    const row = renderNotice(
      notice(nova, {
        agent: reviewer,
        changes: [
          {
            after: "Release & QA Reviewer",
            before: "Release Reviewer",
            field: "name",
          },
        ],
        initialized: false,
        instructions_changed: true,
        type: "agent_profile_changed",
      }),
      { onOpenProfile },
    );
    expect(row).toHaveTextContent(
      "Nova updated Release Reviewer · name, instructions",
    );
    const toggle = screen.getByRole("button", { name: "Show changes" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Release & QA Reviewer")).toBeNull();

    fireEvent.click(toggle);
    expect(
      screen.getByRole("button", { name: "Hide changes" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Release & QA Reviewer").tagName).toBe("INS");
    expect(screen.getByText("Instructions updated")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "View in Agent Info" }));
    expect(onOpenProfile).toHaveBeenCalledWith(reviewer.id);
  });

  it("reads a notice before the Message written with it", () => {
    const admitted = notice(leo, { member: reviewer, type: "member_added" });
    const message: TeamHubMessage = {
      ...admitted,
      id: "a-message",
      message_kind: "conversation",
      notice: undefined,
    };
    const ordered = orderRoomMessages([{ items: [message, admitted] }]);
    expect(ordered.map((item) => item.id)).toEqual([admitted.id, message.id]);
  });

  it("shows the plain line for a notice it does not know", () => {
    const unknown = notice(nova, {
      type: "future_notice",
    } as unknown as TeamHubMessage["notice"]);
    expect(renderNotice(unknown)).toHaveTextContent("Fallback line.");
  });
});
