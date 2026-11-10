import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

import type { DecisionMessageCard } from "./decision-card";
import { RoomMessageCard } from "./room-message-card";

describe("Room Message card renderer", () => {
  it("lets a Room member approve a workspace Agent Room creation proposal", async () => {
    const onDecision = vi.fn();
    render(
      <MemoryRouter>
        <RoomMessageCard
          roomId="room-1"
          actorDisplayNames={{ "human-2": "Bob" }}
          card={roomCreationCard({
            room_creation: {
              description: "Collect the original notes.",
              initial_message_segments: [
                { content: "Add notes here.", type: "text" },
              ],
              member_ids: ["human-2"],
              name: "Interview coordination",
              origin_room_id: "room-origin",
            },
            title:
              "Request to create a collaboration room: Interview coordination",
          })}
          currentActorId="human-2"
          messageId="message-create-2"
          onDecision={onDecision}
          roomMemberDecisionAllowed
          tenantId="tenant-1"
        />
      </MemoryRouter>,
    );

    const card = await screen.findByRole("region", { name: "Room creation" });
    // The title heads the box; the row is the Room.
    expect(
      within(card).getByRole("heading", {
        level: 3,
        name: "Request to create a collaboration room: Interview coordination",
      }),
    ).toBeVisible();
    expect(document.querySelector(".card-prompt")).toBeNull();
    const row = within(card).getByRole("button", { expanded: false });
    expect(row).toHaveTextContent("New Room Interview coordination");
    expect(row).toHaveTextContent("1 member · Bob");
    fireEvent.click(row);
    // The details ease open, fading in on the next frame.
    await vi.waitFor(() =>
      expect(within(card).getByText("Add notes here.")).toBeVisible(),
    );
    fireEvent.click(within(card).getByRole("button", { name: "Create Room" }));
    expect(onDecision).toHaveBeenCalledWith({
      decision: "approve",
      expectedVersion: 1,
      messageId: "message-create-2",
      requestId: "decision-room-1",
    });
  });

  it("lets only the decision owner decide without workspace scope", async () => {
    render(
      <MemoryRouter>
        <RoomMessageCard
          roomId="room-1"
          card={roomCreationCard({})}
          currentActorId="human-2"
          messageId="message-1"
          onDecision={vi.fn()}
          tenantId="tenant-1"
        />
      </MemoryRouter>,
    );

    const card = await screen.findByRole("region", { name: "Room creation" });
    expect(screen.queryByText(/Waiting for Alice/)).toBeNull();
    expect(
      within(card).queryByRole("button", { name: "Create Room" }),
    ).toBeNull();
    expect(
      within(card).queryByRole("group", { name: "Approval actions" }),
    ).toBeNull();
  });

  it("asks for a reason before denying a Room creation", async () => {
    const onDecision = vi.fn();
    render(
      <MemoryRouter>
        <RoomMessageCard
          roomId="room-1"
          card={roomCreationCard({ version: 2 })}
          currentActorId="human-1"
          messageId="message-1"
          onDecision={onDecision}
          tenantId="tenant-1"
        />
      </MemoryRouter>,
    );

    const card = await screen.findByRole("region", { name: "Room creation" });
    fireEvent.click(within(card).getByRole("button", { name: "Don't create" }));
    expect(onDecision).not.toHaveBeenCalled();
    const submit = within(card).getByRole("button", {
      name: "Deny with this reason",
    });
    expect(submit).toBeDisabled();
    fireEvent.change(
      within(card).getByRole("textbox", { name: "Reason for denying" }),
      { target: { value: "Use the existing Room." } },
    );
    fireEvent.click(submit);
    expect(onDecision).toHaveBeenCalledWith({
      decision: "deny",
      expectedVersion: 2,
      feedback: "Use the existing Room.",
      messageId: "message-1",
      requestId: "decision-room-1",
    });
  });

  it("links to the created Room from an approved Room creation card", async () => {
    render(
      <MemoryRouter>
        <RoomMessageCard
          roomId="room-1"
          card={roomCreationCard({
            answer: { decision: "approve" },
            decided_at: "2026-07-30T09:00:00Z",
            decided_by: human("human-1", "Alice"),
            room_creation: {
              created_room_id: "room-created-1",
              initial_message_segments: [
                { content: "Start the incident Room.", type: "text" },
              ],
              member_ids: ["human-2"],
              name: "incident-room",
              origin_room_id: "room-origin",
            },
            status: "succeeded",
            version: 3,
          })}
          currentActorId="human-1"
          messageId="message-1"
          onDecision={vi.fn()}
          tenantId="tenant-1"
        />
      </MemoryRouter>,
    );

    const card = await screen.findByRole("region", { name: "Room creation" });
    expect(within(card).getByText("Created")).toBeVisible();
    expect(
      within(card).getByRole("button", { expanded: false }),
    ).toHaveTextContent("New Room incident-room");
    expect(
      within(card).getByRole("link", { name: "Open Room" }),
    ).toHaveAttribute("href", "/t/tenant-1/rooms/room-created-1/chat");
    expect(
      within(card).queryByRole("button", { name: "Create Room" }),
    ).toBeNull();
    expect(screen.queryByText(/approved this/)).toBeNull();
  });

  it("shows a Room creation's in-progress, denied, failed and expired lines", async () => {
    const decided = {
      decided_at: "2026-07-30T09:00:00Z",
      decided_by: human("human-1", "Alice"),
    };
    const cases: [Partial<DecisionMessageCard>, string, string][] = [
      [
        { ...decided, answer: { decision: "approve" }, status: "executing" },
        "Creating…",
        "text-app-muted",
      ],
      [
        {
          ...decided,
          answer: { comment: "Use the existing Room.", decision: "deny" },
          status: "denied",
        },
        "Not created · “Use the existing Room.”",
        "text-app-muted",
      ],
      [
        {
          ...decided,
          answer: { decision: "approve" },
          outcome: "The name is taken.",
          status: "failed",
        },
        "Failed: The name is taken.",
        "text-app-danger",
      ],
      [{ status: "expired" }, "Expired", "text-app-muted"],
    ];
    for (const [overrides, done, tone] of cases) {
      const { unmount } = render(
        <MemoryRouter>
          <RoomMessageCard
            roomId="room-1"
            card={roomCreationCard(overrides)}
            currentActorId="human-1"
            messageId="message-1"
            onDecision={vi.fn()}
            tenantId="tenant-1"
          />
        </MemoryRouter>,
      );
      const card = await screen.findByRole("region", { name: "Room creation" });
      const line = within(card).getByText(done);
      expect(line.closest("p")?.querySelector("svg")).toHaveClass(tone);
      expect(
        within(card).queryByRole("link", { name: "Open Room" }),
      ).toBeNull();
      expect(
        within(card).queryByRole("group", { name: "Approval actions" }),
      ).toBeNull();
      unmount();
    }
  });

  it("renders a decision card with its kind's view", async () => {
    render(
      <MemoryRouter>
        <RoomMessageCard
          roomId="room-1"
          card={{
            card_type: "personal_notice",
            connector_write: {
              account: "alice@example.com",
              app: "slack",
              input: '{"channel":"C1","markdown_text":"**Shipped**"}',
              kind: "message",
              message: {
                body: "**Shipped**",
                destination: "Slack C1",
                format: "markdown",
              },
              title: "Send a Slack message",
              tool: "SLACK_SEND_MESSAGE",
            },
            decision_id: "decision-1",
            decision_owner: human("human-1", "Alice"),
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
            intent: "decision_requested",
            kind: "connector_write",
            requester: { display_name: "Nova", id: "agent-1", kind: "agent" },
            status: "pending",
            title: "Send a Slack message",
            version: 1,
          }}
          currentActorId="human-1"
          messageId="message-1"
          onDecision={vi.fn()}
          tenantId="tenant-1"
        />
      </MemoryRouter>,
    );

    const card = await screen.findByRole("region", {
      name: "Confirmation request",
    });
    fireEvent.click(within(card).getByRole("button", { expanded: false }));
    expect(within(card).getByText("Shipped").tagName).toBe("STRONG");
    expect(within(card).getByRole("button", { name: "Send" })).toBeVisible();
  });

  it("wraps every user-controlled long-text field inside a narrow card", async () => {
    const name = "UnbrokenName".repeat(20);
    const description = "UnbrokenDescription".repeat(80);
    render(
      <MemoryRouter>
        <RoomMessageCard
          roomId="room-1"
          card={roomCreationCard({
            room_creation: {
              description,
              initial_message_segments: [
                { content: "Start the incident Room.", type: "text" },
              ],
              member_ids: ["human-2"],
              name,
              origin_room_id: "room-origin",
            },
            title: `Request to create a collaboration room: ${name}`,
            version: 2,
          })}
          currentActorId="human-2"
          messageId="message-1"
          onDecision={vi.fn()}
          tenantId="tenant-1"
        />
      </MemoryRouter>,
    );

    const card = await screen.findByRole("region", { name: "Room creation" });
    expect(
      within(card).getByRole("heading", {
        level: 3,
        name: `Request to create a collaboration room: ${name}`,
      }),
    ).toHaveClass("[overflow-wrap:anywhere]");
    expect(document.querySelector(".card-prompt")).toBeNull();
    // The row truncates the Room name on one line instead.
    expect(screen.getByText(`New Room ${name}`)).toHaveClass("truncate");
  });
});

function roomCreationCard(
  overrides: Partial<DecisionMessageCard>,
): DecisionMessageCard {
  return {
    card_type: "personal_notice",
    decision_id: "decision-room-1",
    decision_owner: human("human-1", "Alice"),
    intent: "decision_requested",
    kind: "room_creation",
    requester: { display_name: "Codex", id: "agent-1", kind: "agent" },
    room_creation: {
      initial_message_segments: [
        { content: "Start the incident Room.", type: "text" },
      ],
      member_ids: ["human-2"],
      name: "incident-room",
      origin_room_id: "room-origin",
    },
    status: "pending",
    title: "Request to create a collaboration room: incident-room",
    version: 1,
    ...overrides,
  };
}

function human(id: string, displayName: string) {
  return {
    display_name: displayName,
    id,
    kind: "human" as const,
  };
}
