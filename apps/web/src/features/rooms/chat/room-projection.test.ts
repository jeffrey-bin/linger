import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import type {
  TeamHubMessage,
  TeamHubRoomEvent,
} from "@/features/teamhub/teamhub-types";
import { presentTeamHubMessageAttachments } from "@/features/teamhub/teamhub-runtime";
import { tenantWorkItemsDashboardQueryKey } from "@/features/work-items/work-item-queries";
import type { TeamHubWorkItem } from "@/features/teamhub/teamhub-types";

import {
  roomDocumentCommentThreadsQueryKey,
  roomMessagesQueryKey,
  roomTeamMdQueryKey,
  tenantActorsQueryKey,
  tenantAgentsQueryKey,
} from "../room-queries";
import { createHttpTeamHubClient } from "@/features/teamhub/teamhub-client";
import {
  TeamHubTestServer,
  teamHubErrorResponse,
  type TestRouteHandler,
} from "@/test/teamhub-test-server";
import { createRoomProjection } from "./room-projection";

describe("Room projection", () => {
  it("reads back only the Agent Message an event created", async () => {
    const queryClient = new QueryClient();
    const queryKey = roomMessagesQueryKey("tenant-1", "room-1");
    queryClient.setQueryData(queryKey, {
      pageParams: [undefined],
      pages: [{ items: [], page: { has_more: false } }],
    });
    const event = messageCreatedEvent();
    const message = {
      ...event.payload.message,
      attachments: [],
      message_kind: "conversation" as const,
      routine_name: "Daily anime pick",
    };
    const queryFn = vi.fn();
    const observer = new QueryObserver(queryClient, {
      queryFn,
      queryKey,
      staleTime: Infinity,
    });
    const stop = observer.subscribe(() => undefined);
    const getMessage = vi.fn<TestRouteHandler>(() => message);
    const projection = createRoomProjection({
      messages: messageClient(getMessage),
      queryClient,
      roomId: "room-1",
      tenantId: "tenant-1",
    });

    await projection.applyEvent({
      ...event,
      payload: {
        ...event.payload,
        message: { ...event.payload.message, message_kind: "conversation" },
      },
    });

    await vi.waitFor(() =>
      expect(
        queryClient.getQueryData<{ pages: { items: TeamHubMessage[] }[] }>(
          queryKey,
        )?.pages[0]?.items[0]?.routine_name,
      ).toBe("Daily anime pick"),
    );
    expect(getMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        params: { messageId: message.id, roomId: "room-1" },
      }),
    );
    expect(queryFn).not.toHaveBeenCalled();
    stop();
  });

  it("starts after the Message snapshot Room Event watermark", async () => {
    const projection = createRoomProjection({
      initialRoomSeq: 4,
      queryClient: new QueryClient(),
      roomId: "room-1",
      tenantId: "tenant-1",
    });
    const event = (roomSeq: number) => ({
      event_id: `event-${roomSeq}`,
      event_type: "room.history.compacted" as const,
      occurred_at: "2026-07-23T10:00:00Z",
      payload: {
        kind: "room.history.compacted" as const,
        removed_event_type: "legacy.event",
      },
      room_id: "room-1",
      room_seq: roomSeq,
      tenant_id: "tenant-1",
    });

    await projection.applyEvent(event(4));
    await projection.applyEvent(event(5));

    expect(projection.getLastAppliedRoomSeq()).toBe(5);
  });

  it("advances past a hidden Message placeholder without refreshing the Room", async () => {
    const queryClient = new QueryClient();
    const refetchQueries = vi.spyOn(queryClient, "refetchQueries");
    const projection = createRoomProjection({
      queryClient,
      roomId: "room-1",
      tenantId: "tenant-1",
    });

    await projection.applyEvent({
      event_id: "event-1",
      event_type: "message.hidden",
      occurred_at: "2026-10-26T10:00:00Z",
      payload: { kind: "message.hidden" },
      room_id: "room-1",
      room_seq: 1,
      tenant_id: "tenant-1",
    });

    expect(projection.getLastAppliedRoomSeq()).toBe(1);
    expect(refetchQueries).not.toHaveBeenCalled();
  });

  it("applies one committed Message once and advances only after success", async () => {
    const queryClient = new QueryClient();
    const queryKey = roomMessagesQueryKey("tenant-1", "room-1");
    queryClient.setQueryData(queryKey, {
      pageParams: [undefined],
      pages: [{ items: [], page: { has_more: false } }],
    });
    const onMessageCreated = vi.fn();
    const projection = createRoomProjection({
      onMessageCreated,
      queryClient,
      roomId: "room-1",
      tenantId: "tenant-1",
    });
    const event = {
      event_id: "event-1",
      event_type: "message.created" as const,
      occurred_at: "2026-07-23T10:00:00Z",
      payload: {
        kind: "message.created" as const,
        message: {
          author: {
            display_name: "Codex",
            id: "agent-1",
            kind: "agent" as const,
            tenant_id: "tenant-1",
          },
          attachments: [],
          created_at: "2026-07-23T10:00:00Z",
          id: "message-1",
          message_kind: "conversation" as const,
          raw_message: "Room V0 is ready for review.",
          room_id: "room-1",
          segments: [
            { content: "Room V0 is ready for review.", type: "text" as const },
          ],
          tenant_id: "tenant-1",
        },
      },
      room_id: "room-1",
      room_seq: 1,
      tenant_id: "tenant-1",
    };

    await projection.applyEvent(event);
    await projection.applyEvent(event);

    expect(projection.getLastAppliedRoomSeq()).toBe(1);
    expect(onMessageCreated).toHaveBeenCalledOnce();
    expect(onMessageCreated).toHaveBeenCalledWith(
      expect.objectContaining({ id: "message-1" }),
    );
    expect(
      queryClient.getQueryData<{
        pages: Array<{ items: TeamHubMessage[] }>;
      }>(queryKey)?.pages[0]?.items,
    ).toEqual([expect.objectContaining({ id: "message-1" })]);
    expect(
      queryClient.getQueryData<{
        pages: Array<{ items: Array<{ attachments: unknown[] }> }>;
      }>(queryKey)?.pages[0]?.items[0]?.attachments,
    ).toEqual([]);
    expect(
      presentTeamHubMessageAttachments(
        queryClient.getQueryData<{
          pages: Array<{ items: TeamHubMessage[] }>;
        }>(queryKey)?.pages[0]?.items[0] as TeamHubMessage,
      ),
    ).toEqual([]);
  });

  it("presents a managed Task result as a live Document target", () => {
    const message = {
      ...messageCreatedEvent().payload.message,
      attachments: [
        {
          document_id: "document-result",
          document_version_id: "version-result",
          source_room_id: "room-work",
          available: true,
          filename: "meeting-minutes.md",
          id: "attachment-result",
          media_type: "text/markdown",
          sha256: "a".repeat(64),
          size_bytes: 42,
        },
      ],
      room_id: "room-origin",
    } as TeamHubMessage;

    expect(presentTeamHubMessageAttachments(message)[0]?.document).toEqual({
      current_version: { id: "version-result" },
      id: "document-result",
      title: "meeting-minutes.md",
    });
  });

  it("invalidates the Tenant Dashboard when a Work Item changes", async () => {
    const queryClient = new QueryClient();
    const queryKey = tenantWorkItemsDashboardQueryKey("tenant-1");
    queryClient.setQueryData(queryKey, {
      items: [roomWorkItem()],
      page: { has_more: false },
    });
    const projection = createRoomProjection({
      queryClient,
      roomId: "room-1",
      tenantId: "tenant-1",
    });

    await projection.applyEvent({
      event_id: "event-work-item-1",
      event_type: "work_item.changed",
      occurred_at: "2026-07-29T10:00:00Z",
      payload: {
        kind: "work_item.changed",
        version: 1,
        work_item_id: "workitem-1",
      },
      room_id: "room-1",
      room_seq: 1,
      tenant_id: "tenant-1",
    });

    expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
    expect(projection.getLastAppliedRoomSeq()).toBe(1);
  });

  it("rereads team.md and announces it when an Agent publishes one", async () => {
    const queryClient = new QueryClient();
    const queryKey = roomTeamMdQueryKey("tenant-1", "room-1");
    queryClient.setQueryData(queryKey, null);
    const onTeamMdPublished = vi.fn();
    const projection = createRoomProjection({
      onTeamMdPublished,
      queryClient,
      roomId: "room-1",
      tenantId: "tenant-1",
    });

    await projection.applyEvent({
      event_id: "event-team-md-1",
      event_type: "team_md.published",
      occurred_at: "2026-11-04T10:00:00Z",
      payload: { kind: "team_md.published", revision: 1 },
      room_id: "room-1",
      room_seq: 1,
      tenant_id: "tenant-1",
    });

    expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
    expect(onTeamMdPublished).toHaveBeenCalledOnce();
    expect(projection.getLastAppliedRoomSeq()).toBe(1);
  });

  it("patches the parent Message thread summary without appending a reply", async () => {
    const queryClient = new QueryClient();
    const queryKey = roomMessagesQueryKey("tenant-1", "room-1");
    const root: TeamHubMessage = {
      ...messageCreatedEvent().payload.message,
      attachments: [],
      message_kind: "conversation",
    };
    queryClient.setQueryData(queryKey, {
      pageParams: [undefined],
      pages: [{ items: [root], page: { has_more: false } }],
    });
    const projection = createRoomProjection({
      queryClient,
      roomId: "room-1",
      tenantId: "tenant-1",
    });

    await projection.applyEvent({
      event_id: "event-thread-1",
      event_type: "message.thread_summary.updated",
      occurred_at: "2026-08-14T10:00:00Z",
      payload: {
        kind: "message.thread_summary.updated",
        message_id: root.id,
        thread: { reply_count: 1, room_id: "room-thread-1" },
      },
      room_id: "room-1",
      room_seq: 1,
      tenant_id: "tenant-1",
    });

    const items = queryClient.getQueryData<{
      pages: Array<{ items: TeamHubMessage[] }>;
    }>(queryKey)?.pages[0]?.items;
    expect(items).toHaveLength(1);
    expect(items?.[0]?.thread).toEqual({
      reply_count: 1,
      room_id: "room-thread-1",
    });
  });

  it("hydrates a newer authoritative card into its loaded Message position", async () => {
    const queryClient = new QueryClient();
    const queryKey = roomMessagesQueryKey("tenant-1", "room-1");
    queryClient.setQueryData(queryKey, {
      pageParams: [undefined],
      pages: [
        {
          items: [coordinationCardMessage(1, "pending")],
          page: { has_more: false },
        },
      ],
    });
    const authoritative = coordinationCardMessage(2, "approved");
    const getMessage = vi.fn<TestRouteHandler>(() => authoritative);
    const projection = createRoomProjection({
      messages: messageClient(getMessage),
      queryClient,
      roomId: "room-1",
      tenantId: "tenant-1",
    });

    await projection.applyEvent({
      event_id: "event-card-2",
      event_type: "card.changed",
      occurred_at: "2026-07-30T09:00:00Z",
      payload: {
        kind: "card.changed",
        message_id: "message-card-1",
        version: 2,
      },
      room_id: "room-1",
      room_seq: 1,
      tenant_id: "tenant-1",
    });

    expect(getMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { messageId: "message-card-1", roomId: "room-1" },
      }),
    );
    expect(
      queryClient.getQueryData<{
        pages: Array<{ items: TeamHubMessage[] }>;
      }>(queryKey)?.pages[0]?.items[0],
    ).toEqual(authoritative);
    expect(projection.getLastAppliedRoomSeq()).toBe(1);
  });

  it("ignores a card event that is not newer than the loaded Message", async () => {
    const queryClient = new QueryClient();
    const queryKey = roomMessagesQueryKey("tenant-1", "room-1");
    const loaded = coordinationCardMessage(2, "approved");
    queryClient.setQueryData(queryKey, {
      pageParams: [undefined],
      pages: [{ items: [loaded], page: { has_more: false } }],
    });
    const getMessage = vi.fn<TestRouteHandler>();
    const projection = createRoomProjection({
      messages: messageClient(getMessage),
      queryClient,
      roomId: "room-1",
      tenantId: "tenant-1",
    });

    await projection.applyEvent(cardChangedEvent(2));

    expect(getMessage).not.toHaveBeenCalled();
    expect(
      queryClient.getQueryData<{
        pages: Array<{ items: TeamHubMessage[] }>;
      }>(queryKey)?.pages[0]?.items,
    ).toEqual([loaded]);
    expect(projection.getLastAppliedRoomSeq()).toBe(1);
  });

  it("does not hydrate or append a card Message that is not already loaded", async () => {
    const queryClient = new QueryClient();
    const queryKey = roomMessagesQueryKey("tenant-1", "room-1");
    queryClient.setQueryData(queryKey, {
      pageParams: [undefined],
      pages: [{ items: [], page: { has_more: false } }],
    });
    const getMessage = vi.fn<TestRouteHandler>();
    const projection = createRoomProjection({
      messages: messageClient(getMessage),
      queryClient,
      roomId: "room-1",
      tenantId: "tenant-1",
    });

    await projection.applyEvent(cardChangedEvent(2));

    expect(getMessage).not.toHaveBeenCalled();
    expect(
      queryClient.getQueryData<{
        pages: Array<{ items: TeamHubMessage[] }>;
      }>(queryKey)?.pages[0]?.items,
    ).toEqual([]);
    expect(projection.getLastAppliedRoomSeq()).toBe(1);
  });

  it("does not advance its cursor when the Message request fails", async () => {
    const queryClient = new QueryClient();
    const queryKey = roomMessagesQueryKey("tenant-1", "room-1");
    const loaded = coordinationCardMessage(1, "pending");
    queryClient.setQueryData(queryKey, {
      pageParams: [undefined],
      pages: [{ items: [loaded], page: { has_more: false } }],
    });
    const getMessage = vi.fn<TestRouteHandler>(() =>
      teamHubErrorResponse(404, "MESSAGE_NOT_FOUND", "Message unavailable"),
    );
    const projection = createRoomProjection({
      messages: messageClient(getMessage),
      queryClient,
      roomId: "room-1",
      tenantId: "tenant-1",
    });

    await expect(projection.applyEvent(cardChangedEvent(2))).rejects.toThrow();

    expect(projection.getLastAppliedRoomSeq()).toBe(0);
    expect(
      queryClient.getQueryData<{
        pages: Array<{ items: TeamHubMessage[] }>;
      }>(queryKey)?.pages[0]?.items,
    ).toEqual([loaded]);
  });

  it("rejects a sequence gap without advancing its cursor", async () => {
    const projection = createRoomProjection({
      queryClient: new QueryClient(),
      roomId: "room-1",
      tenantId: "tenant-1",
    });

    await expect(
      projection.applyEvent({
        event_id: "event-2",
        event_type: "room.history.compacted",
        occurred_at: "2026-07-23T10:00:00Z",
        payload: {
          kind: "room.history.compacted",
          removed_event_type: "legacy.event",
        },
        room_id: "room-1",
        room_seq: 2,
        tenant_id: "tenant-1",
      }),
    ).rejects.toThrow("expected 1");
    expect(projection.getLastAppliedRoomSeq()).toBe(0);
  });

  it("ignores already-applied sequences without caching event identity", async () => {
    const projection = createRoomProjection({
      queryClient: new QueryClient(),
      roomId: "room-1",
      tenantId: "tenant-1",
    });
    const event = compactedEvent();

    await projection.applyEvent(event);
    await expect(
      projection.applyEvent({ ...event, event_id: "event-reused" }),
    ).resolves.toBeUndefined();
    expect(projection.getLastAppliedRoomSeq()).toBe(1);
  });

  it("advances past an unknown event kind without refreshing the Room", async () => {
    const queryClient = new QueryClient();
    const refetchQueries = vi.spyOn(queryClient, "refetchQueries");
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const projection = createRoomProjection({
      queryClient,
      roomId: "room-1",
      tenantId: "tenant-1",
    });

    // A kind a newer TeamHub added is outside the generated union.
    await projection.applyEvent({
      event_id: "event-1",
      event_type: "reaction.added",
      occurred_at: "2026-07-23T10:00:00Z",
      payload: { kind: "reaction.added" },
      room_id: "room-1",
      room_seq: 1,
      tenant_id: "tenant-1",
    } as unknown as TeamHubRoomEvent);

    expect(refetchQueries).not.toHaveBeenCalled();
    expect(invalidateQueries).not.toHaveBeenCalled();
    expect(projection.getLastAppliedRoomSeq()).toBe(1);
  });

  it("refreshes the Actor directory when a notice names a new Agent", async () => {
    const queryClient = new QueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const projection = createRoomProjection({
      queryClient,
      roomId: "room-1",
      tenantId: "tenant-1",
    });
    const event = messageCreatedEvent();
    const author = event.payload.message.author;
    await projection.applyEvent({
      ...event,
      payload: {
        ...event.payload,
        message: {
          ...event.payload.message,
          message_kind: "room_notice" as const,
          notice: {
            agent: { ...author, display_name: "Writer", id: "agent-writer" },
            type: "agent_created" as const,
          },
        },
      },
    });

    for (const queryKey of [
      tenantActorsQueryKey("tenant-1"),
      tenantAgentsQueryKey("tenant-1"),
    ]) {
      expect(invalidateQueries).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey }),
      );
    }
  });

  it("invalidates only the affected Document Comment projection", async () => {
    const queryClient = new QueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const refetchQueries = vi.spyOn(queryClient, "refetchQueries");
    const projection = createRoomProjection({
      queryClient,
      roomId: "room-1",
      tenantId: "tenant-1",
    });

    await projection.applyEvent({
      event_id: "event-comment-1",
      event_type: "document.comment.changed",
      occurred_at: "2026-08-01T00:00:00Z",
      payload: {
        change_kind: "comment_replied",
        comment_id: "comment_1",
        attention_actor_ids: ["actor_1"],
        document_id: "document_1",
        kind: "document.comment.changed",
        thread_id: "thread_1",
      },
      room_id: "room-1",
      room_seq: 1,
      tenant_id: "tenant-1",
    });

    expect(invalidateQueries).toHaveBeenCalledOnce();
    expect(invalidateQueries).toHaveBeenCalledWith({
      refetchType: "none",
      queryKey: roomDocumentCommentThreadsQueryKey(
        "tenant-1",
        "room-1",
        "document_1",
      ),
    });
    expect(refetchQueries).not.toHaveBeenCalled();
    expect(projection.getLastAppliedRoomSeq()).toBe(1);
  });

  it("revokes the active Room immediately when the current Actor is removed", async () => {
    const queryClient = new QueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const onRoomAccessInvalidated = vi.fn();
    const projection = createRoomProjection({
      currentActorId: "actor-current",
      onRoomAccessInvalidated,
      queryClient,
      roomId: "room-1",
      tenantId: "tenant-1",
    });

    await projection.applyEvent({
      event_id: "event-member-removed",
      event_type: "room.member.removed",
      occurred_at: "2026-07-23T10:00:00Z",
      payload: {
        kind: "room.member.removed",
        member: {
          actor: {
            display_name: "Current Human",
            id: "actor-current",
            kind: "human",
            tenant_id: "tenant-1",
          },
          added_by: {
            display_name: "Owner",
            id: "actor-owner",
            kind: "human",
            tenant_id: "tenant-1",
          },
          joined_at: "2026-07-23T09:00:00Z",
          role: "member",
          room_id: "room-1",
          updated_at: "2026-07-23T10:00:00Z",
        },
      },
      room_id: "room-1",
      room_seq: 1,
      tenant_id: "tenant-1",
    });

    expect(onRoomAccessInvalidated).toHaveBeenCalledOnce();
    expect(invalidateQueries).not.toHaveBeenCalled();
    expect(projection.getLastAppliedRoomSeq()).toBe(1);
  });

  it("leaves the active Room when it is deleted", async () => {
    const onRoomAccessInvalidated = vi.fn();
    const projection = createRoomProjection({
      onRoomAccessInvalidated,
      queryClient: new QueryClient(),
      roomId: "room-1",
      tenantId: "tenant-1",
    });

    await projection.applyEvent({
      event_id: "event-room-deleted",
      event_type: "room.deleted",
      occurred_at: "2026-08-06T10:00:00Z",
      payload: {
        deleted_at: "2026-08-06T10:00:00Z",
        kind: "room.deleted",
        room_id: "room-1",
      },
      room_id: "room-1",
      room_seq: 1,
      tenant_id: "tenant-1",
    });

    expect(onRoomAccessInvalidated).toHaveBeenCalledOnce();
    expect(projection.getLastAppliedRoomSeq()).toBe(1);
  });
});

function compactedEvent() {
  return {
    event_id: "event-1",
    event_type: "room.history.compacted" as const,
    occurred_at: "2026-07-23T10:00:00Z",
    payload: {
      kind: "room.history.compacted" as const,
      removed_event_type: "legacy.event",
    },
    room_id: "room-1",
    room_seq: 1,
    tenant_id: "tenant-1",
  };
}

function cardChangedEvent(version: number) {
  return {
    event_id: `event-card-${version}`,
    event_type: "card.changed" as const,
    occurred_at: "2026-07-30T09:00:00Z",
    payload: {
      kind: "card.changed" as const,
      message_id: "message-card-1",
      version,
    },
    room_id: "room-1",
    room_seq: 1,
    tenant_id: "tenant-1",
  };
}

function messageCreatedEvent() {
  return {
    event_id: "event-1",
    event_type: "message.created" as const,
    occurred_at: "2026-07-23T10:00:00Z",
    payload: {
      kind: "message.created" as const,
      message: {
        author: {
          display_name: "Codex",
          id: "agent-1",
          kind: "agent" as const,
          tenant_id: "tenant-1",
        },
        attachments: [],
        created_at: "2026-07-23T10:00:00Z",
        id: "message-1",
        message_kind: "conversation" as const,
        raw_message: "Room V0 is ready for review.",
        room_id: "room-1",
        segments: [
          { content: "Room V0 is ready for review.", type: "text" as const },
        ],
        tenant_id: "tenant-1",
      },
    },
    room_id: "room-1",
    room_seq: 1,
    tenant_id: "tenant-1",
  };
}

function roomWorkItem(): TeamHubWorkItem {
  const creator = {
    display_name: "Codex",
    id: "agent-1",
    kind: "agent" as const,
    tenant_id: "tenant-1",
  };
  return {
    assignees: [],
    created_at: "2026-07-29T10:00:00Z",
    created_by: creator,
    description: "Email login returns 500.",
    explicit_access_grants: [],
    id: "workitem-1",
    kind: "issue",
    number: 42,
    origin_room_id: "room-1",
    priority: "high",
    referenced_actors: [],
    state: "open",
    tenant_id: "tenant-1",
    title: "Fix login failure",
    updated_at: "2026-07-29T10:00:00Z",
    updated_by: creator,
    version: 1,
  };
}

function coordinationCardMessage(
  version: number,
  coordinationStatus: "approved" | "pending",
): TeamHubMessage {
  const agent = {
    display_name: "Codex",
    id: "agent-1",
    kind: "agent" as const,
    tenant_id: "tenant-1",
  };
  const owner = {
    display_name: "Alice",
    id: "human-1",
    kind: "human" as const,
    tenant_id: "tenant-1",
  };
  const pending = {
    card_type: "personal_notice" as const,
    decision_id: "coordination-1",
    decision_owner: owner,
    intent: "decision_requested" as const,
    kind: "room_creation" as const,
    requester: { display_name: "Codex", id: "agent-1", kind: "agent" as const },
    title: "Request to create a collaboration room",
    room_creation: {
      initial_message_segments: [
        { content: "Start the incident review.", type: "text" as const },
      ],
      member_ids: ["agent-1", "human-1"],
      name: "incident-review",
      origin_room_id: "room-1",
    },
    version,
  };
  const card =
    coordinationStatus === "approved"
      ? {
          ...pending,
          status: "succeeded" as const,
          answer: { decision: "approve" as const },
          room_creation: {
            ...pending.room_creation,
            created_room_id: "room-incident-review",
          },
          decided_at: "2026-07-30T09:00:00Z",
          decided_by: owner,
        }
      : { ...pending, status: "pending" as const };
  return {
    attachments: [],
    author: agent,
    card,
    created_at: "2026-07-30T08:00:00Z",
    id: "message-card-1",
    message_kind: "conversation",
    raw_message: "Issue #42 coordination requested",
    room_id: "room-1",
    segments: [
      { content: "Issue #42 coordination requested", type: "text" as const },
    ],
    tenant_id: "tenant-1",
  };
}

function messageClient(getMessage: TestRouteHandler) {
  const server = new TeamHubTestServer().on(
    "GET",
    "/v0/rooms/{roomId}/messages/{messageId}",
    getMessage,
  );
  const { api } = createHttpTeamHubClient({
    fetchRequest: server.fetch,
    onAuthenticationRequired: () => undefined,
  });
  return { api };
}
