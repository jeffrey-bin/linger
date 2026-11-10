import { describe, expect, it, vi } from "vitest";

import { createHttpTeamHubClient } from "@/features/teamhub/teamhub-client";
import type { TeamHubMessage } from "@/features/teamhub/teamhub-types";
import {
  TeamHubTestServer,
  teamHubErrorResponse,
  type TestRouteHandler,
} from "@/test/teamhub-test-server";

import { createRoomCardDecisionController } from "./room-card-decision-controller";

describe("Room card decision business conflicts", () => {
  it("preserves a same-version conflict on every retry", async () => {
    const conflict = {
      code: "CARD_CONFLICT",
      message: "Work Room ownership changed.",
      status: 409,
    };
    const decideDecision = vi.fn<TestRouteHandler>(() =>
      teamHubErrorResponse(conflict.status, conflict.code, conflict.message),
    );
    const onResolved = vi.fn();
    const controller = createRoomCardDecisionController({
      client: decisionClient({
        decide: decideDecision,
        getMessage: vi.fn<TestRouteHandler>(() => pendingRoomCreationMessage()),
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

    await expect(controller.decide(action)).rejects.toMatchObject(conflict);
    await expect(controller.decide(action)).rejects.toMatchObject(conflict);

    expect(decideDecision).toHaveBeenCalledTimes(2);
    expect(onResolved).not.toHaveBeenCalled();
  });

  it("rejects an authoritative conflict response from another Tenant", async () => {
    const message = pendingRoomCreationMessage();
    message.tenant_id = "tenant-other";
    const onResolved = vi.fn();
    const controller = createRoomCardDecisionController({
      client: decisionClient({
        decide: vi.fn<TestRouteHandler>(() =>
          teamHubErrorResponse(409, "CARD_CONFLICT", "Card changed."),
        ),
        getMessage: vi.fn<TestRouteHandler>(() => message),
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

  it("refreshes a newer pending card but keeps the decision retryable", async () => {
    const conflict = {
      code: "CARD_CONFLICT",
      message: "Card changed.",
      status: 409,
    };
    const authoritative = pendingRoomCreationMessage();
    authoritative.card!.version = 6;
    const decideDecision = vi.fn<TestRouteHandler>(() =>
      teamHubErrorResponse(conflict.status, conflict.code, conflict.message),
    );
    const onResolved = vi.fn();
    const controller = createRoomCardDecisionController({
      client: decisionClient({
        decide: decideDecision,
        getMessage: vi.fn<TestRouteHandler>(() => authoritative),
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

    await expect(controller.decide(action)).rejects.toMatchObject(conflict);
    await expect(controller.decide(action)).rejects.toMatchObject(conflict);

    expect(onResolved).toHaveBeenCalledTimes(2);
    expect(onResolved).toHaveBeenNthCalledWith(1, authoritative);
    expect(decideDecision).toHaveBeenCalledTimes(2);
  });

  it("refreshes an opposite terminal decision without reporting success", async () => {
    const conflict = {
      code: "CARD_CONFLICT",
      message: "Card changed.",
      status: 409,
    };
    const authoritative = pendingRoomCreationMessage();
    if (!authoritative.card) throw new Error("Invalid test fixture");
    authoritative.card.status = "denied";
    authoritative.card.answer = {
      comment: "Use the existing Room.",
      decision: "deny",
    };
    authoritative.card.decided_at = "2026-07-30T09:00:00Z";
    authoritative.card.decided_by = human("human-1", "Alice");
    authoritative.card.version = 6;
    const onResolved = vi.fn();
    const controller = createRoomCardDecisionController({
      client: decisionClient({
        decide: () =>
          teamHubErrorResponse(
            conflict.status,
            conflict.code,
            conflict.message,
          ),
        getMessage: vi.fn<TestRouteHandler>(() => authoritative),
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
    ).rejects.toMatchObject(conflict);
    expect(onResolved).toHaveBeenCalledWith(authoritative);
  });
});

function pendingRoomCreationMessage(): TeamHubMessage {
  const owner = human("human-1", "Alice");
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
      decision_id: "decision-room-1",
      status: "pending",
      decision_owner: owner,
      intent: "decision_requested",
      kind: "room_creation",
      requester: { display_name: "Codex", id: "agent-1", kind: "agent" },
      title: "Request to create a collaboration room: incident-room",
      room_creation: {
        initial_message_segments: [
          { content: "Start the incident Room.", type: "text" },
        ],
        member_ids: ["human-owner"],
        name: "incident-room",
        origin_room_id: "room-1",
      },
      version: 5,
    },
    created_at: "2026-07-30T08:00:00Z",
    id: "message-card-1",
    message_kind: "conversation",
    raw_message: "Issue #42 coordination requested",
    room_id: "room-1",
    segments: [{ content: "Issue #42 coordination requested", type: "text" }],
    tenant_id: "tenant-1",
  };
}

function human(id: string, displayName: string) {
  return {
    display_name: displayName,
    id,
    kind: "human" as const,
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
