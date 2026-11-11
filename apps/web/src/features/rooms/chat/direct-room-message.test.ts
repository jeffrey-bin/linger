import { describe, expect, it } from "vitest";

import type { TeamHubMessage } from "@/features/teamhub/teamhub-types";

import {
  composeDirectRoomMessage,
  createDirectRoomMessagePresenter,
  presentDirectRoomMessage,
} from "./direct-room-message";

const peer = {
  display_name: "Research Agent",
  id: "actor-agent",
  kind: "agent" as const,
  tenant_id: "tenant-a",
};

describe("Direct Room Message compatibility", () => {
  it("injects the peer Mention into the existing Message composition", () => {
    expect(
      composeDirectRoomMessage(
        { body: "Review this", files: [], mentions: [] },
        peer,
      ),
    ).toEqual({
      body: "@Research Agent Review this",
      files: [],
      mentions: [peer],
    });
  });

  it("hides only the synthetic leading peer Mention from Human Messages", () => {
    const message = directMessage();
    const presented = presentDirectRoomMessage(message, peer);
    expect(presented.raw_message).toBe("Review this");
    expect(presented.raw_message).toBe("Review this");
    expect(presented.segments).toEqual([
      { content: "Review this", type: "text" },
    ]);
    expect(
      presentDirectRoomMessage(
        { ...message, author: { ...message.author, kind: "agent" } },
        peer,
      ).raw_message,
    ).toBe("@Research Agent Review this");
    expect(
      presentDirectRoomMessage(
        {
          ...message,
          segments: [{ content: message.raw_message, type: "text" }],
        },
        peer,
      ).raw_message,
    ).toBe("@Research Agent Review this");
  });

  it("presents an unchanged Human Message as the same object", () => {
    const message = directMessage();
    const present = createDirectRoomMessagePresenter(peer);
    const presented = present(message);
    expect(presented).not.toBe(message);
    expect(present(message)).toBe(presented);
    expect(present({ ...message })).not.toBe(presented);
  });

  it("hides a leading peer Mention that TeamHub separates with a newline", () => {
    const presented = presentDirectRoomMessage(
      {
        ...directMessage(),
        raw_message:
          "@Previous Agent\nBuild me an agent that drafts replies using my Gmail",
        segments: [
          {
            content: "@Previous Agent",
            target: peer.id,
            target_type: "agent",
            type: "reference",
          },
          {
            content: "\nBuild me an agent that drafts replies using my Gmail",
            type: "text",
          },
        ],
      },
      { ...peer, display_name: "Previous Agent" },
    );
    expect(presented.raw_message).toBe(
      "Build me an agent that drafts replies using my Gmail",
    );
    expect(presented.segments).toEqual([
      {
        content: "Build me an agent that drafts replies using my Gmail",
        type: "text",
      },
    ]);
  });
});

function directMessage(): TeamHubMessage {
  return {
    attachments: [],
    author: {
      display_name: "Jenny",
      id: "actor-human",
      kind: "human",
      tenant_id: "tenant-a",
    },
    created_at: "2026-08-06T00:00:00Z",
    id: "message-1",
    message_kind: "conversation",
    raw_message: "@Research Agent Review this",
    room_id: "room-direct",
    segments: [
      {
        content: "@Research Agent",
        target: peer.id,
        target_type: "agent",
        type: "reference",
      },
      { content: " Review this", type: "text" },
    ],
    tenant_id: "tenant-a",
  };
}
