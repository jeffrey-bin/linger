import { describe, expect, it, vi } from "vitest";

import {
  createHttpTeamHubClient,
  TeamHubTransportError,
} from "@/features/teamhub/teamhub-client";
import type { TeamHubMessage } from "@/features/teamhub/teamhub-types";
import {
  TeamHubTestServer,
  teamHubErrorResponse,
  type TestRouteHandler,
} from "@/test/teamhub-test-server";

import { createRoomCardDecisionController } from "./room-card-decision-controller";

describe("Room card decision controller", () => {
  it("retries one Room creation decision after a failed attempt", async () => {
    const authoritative = roomCreationDecisionMessage();
    const decideDecision = vi
      .fn<TestRouteHandler>()
      .mockImplementationOnce(() => {
        throw new Error("Response was lost.");
      })
      .mockImplementation(() => authoritative);
    const onResolved = vi.fn();
    const controller = createRoomCardDecisionController({
      client: decisionClient({
        decide: decideDecision,
      }),
      onResolved,
      roomId: "room-1",
      tenantId: "tenant-1",
    });
    const action = {
      decision: "approve" as const,
      expectedVersion: 5,
      messageId: "message-card-1",
      requestId: "decision-room-1",
    };

    await expect(controller.decide(action)).rejects.toBeInstanceOf(
      TeamHubTransportError,
    );
    await expect(controller.decide(action)).resolves.toEqual(authoritative);

    expect(decideDecision).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        body: {
          decision: "approve",
          expected_version: 5,
        },
        params: { decisionId: "decision-room-1" },
      }),
    );
    expect(onResolved).toHaveBeenCalledWith(authoritative);
  });

  it("submits and resolves one Room creation decision", async () => {
    const authoritative = roomCreationDecisionMessage();
    const decideDecision = vi.fn<TestRouteHandler>(() => authoritative);
    const onResolved = vi.fn();
    const controller = createRoomCardDecisionController({
      client: decisionClient({
        decide: decideDecision,
      }),
      onResolved,
      roomId: "room-1",
      tenantId: "tenant-1",
    });

    await expect(
      controller.decide({
        decision: "approve",
        expectedVersion: 5,
        messageId: "message-card-1",
        requestId: "decision-room-1",
      }),
    ).resolves.toEqual(authoritative);

    expect(decideDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          decision: "approve",
          expected_version: 5,
        },
        params: { decisionId: "decision-room-1" },
      }),
    );
    expect(onResolved).toHaveBeenCalledWith(authoritative);
  });

  it("denies a decision with its reason and recovers an approval from a conflict", async () => {
    const denied = decisionMessage("denied", {
      comment: "Wrong recipient",
      decision: "deny",
    });
    const decideDecision = vi.fn<TestRouteHandler>(() => denied);
    const onResolved = vi.fn();
    const controller = createRoomCardDecisionController({
      client: decisionClient({
        decide: decideDecision,
      }),
      onResolved,
      roomId: "room-1",
      tenantId: "tenant-1",
    });
    await expect(
      controller.decide({
        decision: "deny",
        expectedVersion: 1,
        feedback: "Wrong recipient",
        messageId: "message-card-1",
        requestId: "decision-1",
      }),
    ).resolves.toEqual(denied);
    expect(decideDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          comment: "Wrong recipient",
          decision: "deny",
          expected_version: 1,
        },
        params: { decisionId: "decision-1" },
      }),
    );

    // Another tab approved first: the running card is the approval's result.
    const running = decisionMessage("executing", { decision: "approve" });
    const conflicted = createRoomCardDecisionController({
      client: decisionClient({
        decide: vi.fn<TestRouteHandler>(() =>
          teamHubErrorResponse(409, "CARD_CONFLICT", "Card changed."),
        ),
        getMessage: vi.fn<TestRouteHandler>(() => running),
      }),
      onResolved,
      roomId: "room-1",
      tenantId: "tenant-1",
    });
    await expect(
      conflicted.decide({
        decision: "approve",
        expectedVersion: 1,
        messageId: "message-card-1",
        requestId: "decision-1",
      }),
    ).resolves.toEqual(running);
    expect(onResolved).toHaveBeenLastCalledWith(running);
  });

  it("keeps consent bound to the selected account through authorizing and conflict recovery", async () => {
    const message = questionDecisionMessage();
    const authoritative: TeamHubMessage = {
      ...message,
      card: {
        card_type: "personal_notice",
        intent: "decision_requested",
        version: 2,
        decision_id: "decision-auth-1",
        kind: "connection_auth",
        status: "authorizing",
        title: "Use Notion",
        connection_auth: { app_key: "notion", connection_id: "notion-1" },
        answer: { decision: "approve", connection_id: "notion-1" },
        decision_owner: { id: "human-1", display_name: "Alice", kind: "human" },
        requester: { id: "agent-1", display_name: "Writer", kind: "agent" },
        decided_at: "2026-08-20T03:00:00Z",
        decided_by: { id: "human-1", display_name: "Alice", kind: "human" },
      },
    };
    const decideDecision = vi
      .fn<TestRouteHandler>()
      .mockImplementationOnce(() => {
        throw new Error("Response lost");
      })
      .mockImplementation(() => authoritative);
    const onResolved = vi.fn();
    const controller = createRoomCardDecisionController({
      client: decisionClient({
        decide: decideDecision,
      }),
      onResolved,
      roomId: "room-1",
      tenantId: "tenant-1",
    });
    const action = {
      decision: "approve" as const,
      connectionId: "notion-1",
      expectedVersion: 1,
      messageId: message.id,
      requestId: "decision-auth-1",
    };
    await expect(controller.decide(action)).rejects.toBeInstanceOf(
      TeamHubTransportError,
    );
    await expect(controller.decide(action)).resolves.toEqual(authoritative);
    expect(decideDecision).toHaveBeenLastCalledWith(
      expect.objectContaining({
        body: {
          connection_id: "notion-1",
          decision: "approve",
          expected_version: 1,
        },
        params: { decisionId: "decision-auth-1" },
      }),
    );
    await expect(
      controller.decide({ ...action, connectionId: "notion-2" }),
    ).rejects.toThrow("does not match");
  });

  it("submits and resolves one question decision", async () => {
    const authoritative = questionDecisionMessage();
    const decideDecision = vi.fn<TestRouteHandler>(() => authoritative);
    const onResolved = vi.fn();
    const controller = createRoomCardDecisionController({
      client: decisionClient({
        decide: decideDecision,
      }),
      onResolved,
      roomId: "room-1",
      tenantId: "tenant-1",
    });

    await expect(
      controller.decide({
        answers: { q1: "ship" },
        decision: "submit",
        expectedVersion: 1,
        feedback: "Looks good.",
        messageId: "message-card-1",
        requestId: "decision-question-1",
      }),
    ).resolves.toEqual(authoritative);

    expect(decideDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          answers: { q1: "ship" },
          comment: "Looks good.",
          decision: "submit",
          expected_version: 1,
        },
        params: { decisionId: "decision-question-1" },
      }),
    );
    expect(onResolved).toHaveBeenCalledWith(authoritative);
  });

  it("rejects a mismatched Room creation response without resolving it", async () => {
    const response = roomCreationDecisionMessage();
    if (!response.card) throw new Error("Invalid test fixture");
    response.card.decision_id = "decision-other";
    const onResolved = vi.fn();
    const controller = createRoomCardDecisionController({
      client: decisionClient({
        decide: vi.fn<TestRouteHandler>(() => response),
      }),
      onResolved,
      roomId: "room-1",
      tenantId: "tenant-1",
    });

    await expect(
      controller.decide({
        decision: "approve",
        expectedVersion: 5,
        messageId: "message-card-1",
        requestId: "decision-room-1",
      }),
    ).rejects.toThrow("does not match the active Room command");
    expect(onResolved).not.toHaveBeenCalled();
  });

  it("refreshes and resolves the authoritative card after a concurrent conflict", async () => {
    const authoritative = roomCreationDecisionMessage();
    if (!authoritative.card) throw new Error("Invalid test fixture");
    const getMessage = vi.fn<TestRouteHandler>(() => authoritative);
    const onResolved = vi.fn();
    const controller = createRoomCardDecisionController({
      client: decisionClient({
        decide: vi.fn<TestRouteHandler>(() =>
          teamHubErrorResponse(409, "CARD_CONFLICT", "Card changed."),
        ),
        getMessage,
      }),
      onResolved,
      roomId: "room-1",
      tenantId: "tenant-1",
    });

    await expect(
      controller.decide({
        decision: "approve",
        expectedVersion: 5,
        messageId: "message-card-1",
        requestId: "decision-room-1",
      }),
    ).resolves.toEqual(authoritative);

    expect(getMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { messageId: "message-card-1", roomId: "room-1" },
      }),
    );
    expect(onResolved).toHaveBeenCalledWith(authoritative);
  });

  it("surfaces a member who cannot decide without refreshing the card", async () => {
    const getMessage = vi.fn<TestRouteHandler>();
    const onResolved = vi.fn();
    const controller = createRoomCardDecisionController({
      client: decisionClient({
        decide: () =>
          teamHubErrorResponse(
            403,
            "FORBIDDEN",
            "Only the decision owner can decide this request.",
          ),
        getMessage,
      }),
      onResolved,
      roomId: "room-1",
      tenantId: "tenant-1",
    });

    await expect(
      controller.decide({
        decision: "approve",
        expectedVersion: 5,
        messageId: "message-card-1",
        requestId: "decision-room-1",
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Only the decision owner can decide this request.",
      status: 403,
    });

    expect(getMessage).not.toHaveBeenCalled();
    expect(onResolved).not.toHaveBeenCalled();
  });
});

function roomCreationDecisionMessage(): TeamHubMessage {
  const owner = {
    display_name: "Alice",
    id: "human-1",
    kind: "human" as const,
  };
  return {
    attachments: [],
    author: {
      display_name: "Codex",
      id: "agent-1",
      kind: "agent",
      tenant_id: "tenant-1",
    },
    card: {
      answer: { decision: "approve" },
      card_type: "personal_notice",
      decided_at: "2026-07-30T09:00:00Z",
      decided_by: owner,
      decision_id: "decision-room-1",
      decision_owner: owner,
      intent: "decision_requested",
      kind: "room_creation",
      requester: { display_name: "Codex", id: "agent-1", kind: "agent" },
      room_creation: {
        created_room_id: "room-work-1",
        initial_message_segments: [
          { content: "Start the incident Room.", type: "text" },
        ],
        member_ids: ["human-owner"],
        name: "incident-room",
        origin_room_id: "room-1",
      },
      status: "succeeded",
      title: "Request to create a collaboration room: incident-room",
      version: 6,
    },
    created_at: "2026-07-30T08:00:00Z",
    id: "message-card-1",
    message_kind: "conversation",
    raw_message: "Request to create a collaboration room: incident-room",
    room_id: "room-1",
    segments: [
      {
        content: "Request to create a collaboration room: incident-room",
        type: "text",
      },
    ],
    tenant_id: "tenant-1",
  };
}

function questionDecisionMessage(): TeamHubMessage {
  const owner = {
    display_name: "Alice",
    id: "human-1",
    kind: "human" as const,
  };
  return {
    attachments: [],
    author: {
      display_name: "Codex",
      id: "agent-1",
      kind: "agent",
      tenant_id: "tenant-1",
    },
    card: {
      card_type: "personal_notice",
      decided_at: "2026-08-20T03:00:00Z",
      decided_by: owner,
      decision_id: "decision-question-1",
      decision_owner: owner,
      intent: "decision_requested",
      kind: "question",
      question: {
        questions: [
          {
            id: "ship",
            input: "radio",
            options: [{ id: "yes", label: "Yes" }],
            prompt: "Ship it?",
          },
        ],
      },
      requester: {
        display_name: "Codex",
        id: "agent-1",
        kind: "agent",
      },
      status: "answered",
      answer: {
        answers: { ship: "Yes" },
        comment: "Looks good.",
        decision: "submit",
      },
      title: "Ship the release?",
      version: 2,
    },
    created_at: "2026-08-20T02:00:00Z",
    id: "message-card-1",
    message_kind: "conversation",
    raw_message: "Needs a decision",
    room_id: "room-1",
    segments: [{ content: "Needs a decision", type: "text" }],
    tenant_id: "tenant-1",
  };
}

function decisionMessage(
  status: "denied" | "executing",
  answer: { comment?: string; decision: "approve" | "deny" },
): TeamHubMessage {
  const owner = {
    display_name: "Alice",
    id: "human-1",
    kind: "human" as const,
  };
  return {
    attachments: [],
    author: {
      display_name: "Codex",
      id: "agent-1",
      kind: "agent",
      tenant_id: "tenant-1",
    },
    card: {
      agent_change: {
        action: "create",
        agent_name: "Researcher",
        changes: [{ after: "Researcher", field: "name" }],
      },
      answer,
      card_type: "personal_notice",
      decided_at: "2026-07-30T09:00:00Z",
      decided_by: owner,
      decision_id: "decision-1",
      decision_owner: owner,
      expires_at: "2026-07-31T09:00:00Z",
      intent: "decision_requested",
      kind: "agent_change",
      requester: { display_name: "Codex", id: "agent-1", kind: "agent" },
      status,
      title: "Create Agent “Researcher”",
      version: 2,
    },
    created_at: "2026-07-30T08:00:00Z",
    id: "message-card-1",
    message_kind: "conversation",
    raw_message: "@Alice Approval needed",
    room_id: "room-1",
    segments: [],
    tenant_id: "tenant-1",
  };
}

function decisionClient(routes: {
  decide?: TestRouteHandler;
  getMessage?: TestRouteHandler;
}) {
  const server = new TeamHubTestServer();
  if (routes.decide)
    server.on("POST", "/v0/decisions/{decisionId}", routes.decide);
  if (routes.getMessage)
    server.on(
      "GET",
      "/v0/rooms/{roomId}/messages/{messageId}",
      routes.getMessage,
    );
  const { api } = createHttpTeamHubClient({
    fetchRequest: server.fetch,
    onAuthenticationRequired: () => undefined,
  });
  return { api };
}
