import { describe, expect, it } from "vitest";

import type {
  TeamHubMessage,
  TeamHubRunStatus,
} from "@/features/teamhub/teamhub-types";

import { agentInfoActivityEntries } from "./agent-info-activity";

describe("agentInfoActivityEntries", () => {
  it("labels each turn with the Human question and keeps previous peer turns out", () => {
    const humanBuild = humanMessage(
      "msg-build",
      "Help me make a social card expert Agent",
      "2026-09-17T09:05:00Z",
    );
    const previousReply = agentMessage(
      "msg-previous-agent",
      "previous-agent",
      "Got it, I will build a Social Card expert Agent.",
      "2026-09-17T09:05:10Z",
      humanBuild.id,
    );
    const humanAsk = humanMessage(
      "msg-ask",
      "What can you do",
      "2026-09-17T09:31:00Z",
    );
    const agentReply = agentMessage(
      "msg-agent",
      "agent-1",
      "I am a social media card design expert.",
      "2026-09-17T09:32:00Z",
      humanAsk.id,
    );

    const entries = agentInfoActivityEntries(
      [humanBuild, previousReply, humanAsk, agentReply],
      {
        actorId: "agent-1",
        runStatuses: [
          testRunStatus(
            "run-status-previous-agent",
            "previous-agent",
            "2026-09-17T09:05:05Z",
          ),
          testRunStatus("run-status-agent", "agent-1", "2026-09-17T09:31:05Z"),
        ],
      },
    );

    expect(entries).toEqual([
      {
        createdAt: "2026-09-17T09:31:05Z",
        runStatusId: "run-status-agent",
        id: "run-status-agent",
        promptText: "What can you do",
      },
    ]);
  });

  it("keeps one activity when this Agent's reply answers the Run Status's question", () => {
    const humanBuild = humanMessage(
      "msg-build",
      "help me make a social card expert agent",
      "2026-09-17T09:03:00Z",
    );
    const previousReply = agentMessage(
      "msg-previous-agent",
      "previous-agent",
      "Got it, I will build a Social Card expert Agent.",
      "2026-09-17T09:04:00Z",
      humanBuild.id,
    );
    const humanAsk = humanMessage(
      "msg-ask",
      "What can you do",
      "2026-09-17T09:31:44Z",
    );
    const agentReply = agentMessage(
      "msg-agent",
      "agent-1",
      "I am a social media card design expert.",
      "2026-09-17T09:32:09Z",
    );

    const entries = agentInfoActivityEntries(
      [humanBuild, previousReply, humanAsk, agentReply],
      {
        actorId: "agent-1",
        runStatuses: [
          testRunStatus("run-status-agent", "agent-1", "2026-09-17T09:31:46Z"),
        ],
      },
    );

    expect(entries).toEqual([
      {
        createdAt: "2026-09-17T09:31:46Z",
        runStatusId: "run-status-agent",
        id: "run-status-agent",
        promptText: "What can you do",
      },
    ]);
  });

  it("uses this Agent's completed reply as an activity even when no Run Status is loaded", () => {
    const humanBuild = humanMessage(
      "msg-build",
      "help me make a social card expert agent",
      "2026-09-17T09:03:00Z",
    );
    const previousReply = agentMessage(
      "msg-previous-agent",
      "previous-agent",
      "Got it, I will build a Social Card expert Agent.",
      "2026-09-17T09:04:00Z",
      humanBuild.id,
    );
    const humanAsk = humanMessage(
      "msg-ask",
      "What can you do",
      "2026-09-17T09:31:44Z",
    );
    const agentReply = agentMessage(
      "msg-agent",
      "agent-1",
      "I am a social media card design expert.",
      "2026-09-17T09:32:09Z",
    );

    const entries = agentInfoActivityEntries(
      [humanBuild, previousReply, humanAsk, agentReply],
      { actorId: "agent-1", runStatuses: [] },
    );

    expect(entries).toEqual([
      {
        createdAt: "2026-09-17T09:32:09Z",
        id: "msg-agent",
        promptText: "What can you do",
      },
    ]);
  });
});

function humanMessage(
  id: string,
  body: string,
  createdAt: string,
): TeamHubMessage {
  return {
    attachments: [],
    author: {
      display_name: "Alex Doe",
      id: "human-1",
      kind: "human",
      tenant_id: "tenant-1",
    },
    created_at: createdAt,
    id,
    message_kind: "conversation",
    raw_message: body,
    room_id: "room-1",
    segments: [{ content: body, type: "text" }],
    tenant_id: "tenant-1",
  };
}

function agentMessage(
  id: string,
  actorId: string,
  body: string,
  createdAt: string,
  replyTo?: string,
): TeamHubMessage {
  return {
    attachments: [],
    author: {
      display_name: actorId === "agent-1" ? "Social Card" : "Previous Agent",
      id: actorId,
      kind: "agent",
      tenant_id: "tenant-1",
    },
    created_at: createdAt,
    id,
    message_kind: "conversation",
    raw_message: body,
    ...(replyTo ? { reply_to_message_id: replyTo } : {}),
    room_id: "room-1",
    segments: [{ content: body, type: "text" }],
    tenant_id: "tenant-1",
  };
}

function testRunStatus(
  id: string,
  agentId: string,
  createdAt: string,
): TeamHubRunStatus {
  return {
    agent: {
      display_name: agentId,
      id: agentId,
      kind: "agent",
    },
    created_at: createdAt,
    id,
    run_id: id,
    replied: false,
    revision: 1,
    room_id: "room-1",
    status: "completed",
    updated_at: createdAt,
  };
}
