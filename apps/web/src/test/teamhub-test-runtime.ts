/* oxlint-disable react-doctor/async-await-in-loop -- Room Event replay applies each event before the next room_seq. */
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { createHttpTeamHubClient } from "@/features/teamhub/teamhub-client";
import type { RunStatusTransport } from "@/features/teamhub/run-status-transport";
import type {
  TeamHubEventSignal,
  TeamHubEventTransport,
} from "@/features/teamhub/event-transport";
import type { TeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubDocument,
  TeamHubDocumentPage,
  TeamHubDocumentPlacementNode,
  TeamHubMessage,
  TeamHubMessageCreateInput,
  TeamHubMyDocumentTree,
  TeamHubRoomCreateInput,
  TeamHubRoomEvent,
  TeamHubRoomListItem,
  TeamHubRoomRunStatus,
  TeamHubRunStatus,
  TeamHubTenantAgentCreateInput,
  TeamHubTenantAgentUpdateInput,
  TeamHubVoiceTranscriptEventPage,
} from "@/features/teamhub/teamhub-types";
import type { VoiceEventTransport } from "@/features/teamhub/voice-event-transport";
import { VoiceRequestScope } from "@/features/teamhub/voice-request-scope";
import { voicePollRetryDelay } from "@/features/rooms/voice-control/voice-poll-retry";

import {
  actorRef,
  createTeamHubTestSeed,
  messageEvent,
  seedProfile,
  seedProfileMarkdown,
  seedTeamMd,
  type TeamHubTestSeed,
  type TestTenantAgent,
} from "./teamhub-seed";
import { teamHubErrorResponse, TeamHubTestServer } from "./teamhub-test-server";

export interface TestTeamHubRuntime extends TeamHubRuntime {
  events: TestEventTransport;
  seed: TeamHubTestSeed;
  server: TeamHubTestServer;
}

export interface TestEventTransport extends TeamHubEventTransport {
  /** Appends a Room Event to the seed and delivers it to subscribers. */
  emitRoomEvent(event: TeamHubRoomEvent): void;
  emitSignal(signal: TeamHubEventSignal): void;
}

/**
 * A TeamHubRuntime whose real HTTP client talks to an in-process
 * TeamHubTestServer. The server answers the seed's reads; every write a test
 * depends on is declared with `runtime.server.on(...)`.
 */
export function createTestTeamHubRuntime(
  seed: TeamHubTestSeed = createTeamHubTestSeed(),
): TestTeamHubRuntime {
  const server = new TeamHubTestServer();
  installSeedRoutes(server, seed);
  const client = createHttpTeamHubClient({
    fetchRequest: server.fetch,
    onAuthenticationRequired: () => undefined,
    xhrFactory: server.xhrFactory,
  });
  const runStatuses: RunStatusTransport = {
    subscribe(input) {
      let disposed = false;
      void client.listRoomRunStatuses(input.roomId).then(
        (result) => {
          if (!disposed) input.onCollection(result.items);
        },
        (error: unknown) => {
          if (!disposed)
            input.onError?.(
              error instanceof Error ? error : new Error(String(error)),
            );
        },
      );
      return () => {
        disposed = true;
      };
    },
  };
  return {
    client,
    documentRuntimeUrl: "ws://document-runtime.test/document-collaboration",
    events: createTestEventTransport(seed),
    runStatuses,
    seed,
    server,
    voiceEvents: createPollingVoiceEventTransport(client),
  };
}

/** Accepts Agent registrations: each POST adds an online Agent to the seed. */
export function acceptTenantAgentCreation(runtime: TestTeamHubRuntime) {
  const { seed } = runtime;
  let next = 0;
  runtime.server.on(
    "POST",
    "/v0/tenants/{tenantId}/agents",
    ({ body, params }) => {
      const input = body as TeamHubTenantAgentCreateInput;
      const now = new Date().toISOString();
      const actor = {
        created_at: now,
        display_name: input.name,
        handle: `@agent_${++next}`,
        id: `actor-agent-${next}`,
        kind: "agent" as const,
        tenant_id: params.tenantId!,
      };
      const registration: TestTenantAgent = {
        actor,
        agent_management_id: `agent-management-${next}`,
        agent_type: input.agent_type ?? "general",
        availability: {
          active_task_count: 0,
          label: "Online",
          status: "online",
        },
        configuration_revision: 1,
        created_at: now,
        created_by: actorRef(seed.identity.actors[0]!),
        description: input.description ?? "",
        instructions: input.instructions,
        runtime: input.runtime,
        skill_bindings: input.skill_bindings ?? [],
        updated_at: now,
        visibility_scope: input.visibility_scope ?? "sponsor",
      };
      seed.actors.push(actor);
      seed.tenantAgents.push(registration);
      return Response.json(registration, { status: 202 });
    },
  );
}

/**
 * Accepts the Sponsor's Agent edits, avatar changes, and removal, with
 * TeamHub's configuration CAS and Another Me profile rules.
 */
export function acceptTenantAgentUpdates(runtime: TestTeamHubRuntime) {
  const { seed } = runtime;
  const sponsored = (agentId: string) => {
    const agent = seed.tenantAgents.find((item) => item.actor.id === agentId);
    if (!agent) return teamHubErrorResponse(404, "AGENT_NOT_FOUND");
    if (agent.created_by.id !== seed.identity.actors[0]!.id)
      return teamHubErrorResponse(403, "AGENT_SPONSOR_REQUIRED");
    return agent;
  };
  const replace = (agent: TestTenantAgent) => {
    seed.tenantAgents = seed.tenantAgents.map((item) =>
      item.actor.id === agent.actor.id ? agent : item,
    );
    seed.actors = seed.actors.map((actor) =>
      actor.id === agent.actor.id ? agent.actor : actor,
    );
    return agent;
  };
  runtime.server
    .on(
      "PATCH",
      "/v0/tenants/{tenantId}/agents/{agentId}",
      ({ body, params }) => {
        const current = sponsored(params.agentId!);
        if (current instanceof Response) return current;
        const input = body as TeamHubTenantAgentUpdateInput;
        // Another Me may be renamed; its description and instructions stay
        // product-owned.
        if (
          current.agent_type === "anotherme" &&
          (input.description !== undefined || input.instructions !== undefined)
        )
          return teamHubErrorResponse(409, "AGENT_UPDATE_UNAVAILABLE");
        if (
          current.configuration_revision !==
          input.expected_configuration_revision
        )
          return teamHubErrorResponse(409, "AGENT_CONFIGURATION_CONFLICT");
        return replace({
          ...current,
          actor: {
            ...current.actor,
            display_name: input.name?.trim() ?? current.actor.display_name,
          },
          configuration_revision: current.configuration_revision + 1,
          description: input.description?.trim() ?? current.description,
          instructions: input.instructions ?? current.instructions,
          runtime: input.runtime ?? current.runtime,
          updated_at: new Date().toISOString(),
        });
      },
    )
    .on(
      "PUT",
      "/v0/tenants/{tenantId}/agents/{agentId}/avatar",
      ({ body, params }) => {
        const current = sponsored(params.agentId!);
        if (current instanceof Response) return current;
        if (current.agent_type === "anotherme")
          return teamHubErrorResponse(409, "AGENT_UPDATE_UNAVAILABLE");
        const input = body as { avatar_image?: string; avatar_key: string };
        const { avatar_image_url: previous, ...rest } = current;
        // The data URL stands in for the image URL TeamHub would serve.
        const image =
          input.avatar_image === undefined ? previous : input.avatar_image;
        return replace({
          ...rest,
          avatar_key: input.avatar_key,
          ...(image ? { avatar_image_url: image } : {}),
          updated_at: new Date().toISOString(),
        });
      },
    )
    .on("DELETE", "/v0/tenants/{tenantId}/agents/{agentId}", ({ params }) => {
      const current = sponsored(params.agentId!);
      if (current instanceof Response) return current;
      const agentId = current.actor.id;
      seed.tenantAgents = seed.tenantAgents.filter(
        (item) => item.actor.id !== agentId,
      );
      seed.actors = seed.actors.filter((actor) => actor.id !== agentId);
      // The Sponsor's Direct Room goes with its Agent.
      seed.rooms = seed.rooms.filter(
        (room) => !(room.kind === "direct" && room.direct_peer?.id === agentId),
      );
      for (const [roomId, members] of seed.membersByRoom)
        seed.membersByRoom.set(
          roomId,
          members.filter((member) => member.actor.id !== agentId),
        );
    });
}

/** Opens Direct Rooms: an Agent's existing Direct Room, or a new one. */
export function acceptDirectRooms(runtime: TestTeamHubRuntime) {
  const { seed } = runtime;
  let next = 0;
  runtime.server.on(
    "POST",
    "/v0/tenants/{tenantId}/direct-rooms",
    ({ body, params }) => {
      const peerId = (body as { peer_actor_id: string }).peer_actor_id;
      const existing = seed.directRoomIdByPeerActor.get(peerId);
      if (existing) return seed.rooms.find((room) => room.id === existing);
      const peer = seed.actors.find((actor) => actor.id === peerId);
      if (!peer || peer.kind !== "agent")
        return teamHubErrorResponse(404, "AGENT_NOT_FOUND");
      const owner = seed.identity.actors[0]!;
      const now = new Date().toISOString();
      const room: TeamHubRoomListItem = {
        created_at: now,
        created_by: actorRef(owner),
        description: `Direct collaboration with ${peer.display_name}.`,
        direct_peer: actorRef(peer),
        direct_peer_active: true,
        id: `room-dm-${++next}`,
        kind: "direct",
        latest_room_seq: 1,
        name: peer.display_name,
        read_through_room_seq: 1,
        tenant_id: params.tenantId!,
        unread_mention_count: 0,
        unread_message_count: 0,
        updated_at: now,
      };
      seed.rooms.push(room);
      seed.directRoomIdByPeerActor.set(peerId, room.id);
      seed.messagesByRoom.set(room.id, []);
      seed.eventsByRoom.set(room.id, []);
      seed.membersByRoom.set(
        room.id,
        [owner, peer].map((actor, index) => ({
          actor: actorRef(actor),
          added_by: actorRef(owner),
          joined_at: now,
          role: index === 0 ? ("owner" as const) : ("member" as const),
          room_id: room.id,
          updated_at: now,
        })),
      );
      return room;
    },
  );
}

/** Accepts Room creation: each POST adds a Room the current Human owns. */
export function acceptRoomCreation(runtime: TestTeamHubRuntime) {
  const { seed } = runtime;
  let next = 0;
  runtime.server.on(
    "POST",
    "/v0/tenants/{tenantId}/rooms",
    ({ body, params }) => {
      const input = body as TeamHubRoomCreateInput;
      const owner = actorRef(seed.identity.actors[0]!);
      const now = new Date().toISOString();
      const room: TeamHubRoomListItem = {
        created_at: now,
        created_by: owner,
        description: input.description,
        id: `room-created-${++next}`,
        kind: "room",
        latest_room_seq: 0,
        name: input.name,
        read_through_room_seq: 0,
        tenant_id: params.tenantId!,
        unread_mention_count: 0,
        unread_message_count: 0,
        updated_at: now,
      };
      seed.rooms.push(room);
      seed.messagesByRoom.set(room.id, []);
      seed.eventsByRoom.set(room.id, []);
      seed.membersByRoom.set(room.id, [
        {
          actor: owner,
          added_by: owner,
          joined_at: now,
          role: "owner",
          room_id: room.id,
          updated_at: now,
        },
      ]);
      return Response.json(room, { status: 201 });
    },
  );
}

/** Accepts Room metadata updates and Room deletion. */
export function acceptRoomUpdates(runtime: TestTeamHubRuntime) {
  const { seed } = runtime;
  runtime.server
    .on("PATCH", "/v0/rooms/{roomId}", ({ body, params }) => {
      const index = seed.rooms.findIndex((room) => room.id === params.roomId);
      if (index < 0) return teamHubErrorResponse(404, "ROOM_NOT_FOUND");
      const updated = {
        ...seed.rooms[index]!,
        ...(body as Partial<TeamHubRoomListItem>),
        updated_at: new Date().toISOString(),
      };
      seed.rooms[index] = updated;
      return updated;
    })
    .on("DELETE", "/v0/rooms/{roomId}", ({ params }) => {
      seed.rooms = seed.rooms.filter((room) => room.id !== params.roomId);
      seed.membersByRoom.delete(params.roomId!);
      seed.eventsByRoom.delete(params.roomId!);
    });
}

/** Accepts Room membership writes: PUT adds or updates a member, DELETE removes one. */
export function acceptRoomMembers(runtime: TestTeamHubRuntime) {
  const { seed } = runtime;
  runtime.server
    .on("PUT", "/v0/rooms/{roomId}/members/{actorId}", ({ body, params }) => {
      const actor = seed.actors.find((item) => item.id === params.actorId);
      if (!actor) return teamHubErrorResponse(404, "ACTOR_NOT_FOUND");
      const members = seed.membersByRoom.get(params.roomId!) ?? [];
      const now = new Date().toISOString();
      const member = {
        actor: actorRef(actor),
        added_by: actorRef(seed.identity.actors[0]!),
        joined_at: now,
        role: (body as { role: "member" | "owner" }).role,
        room_id: params.roomId!,
        updated_at: now,
      };
      seed.membersByRoom.set(params.roomId!, [
        ...members.filter((item) => item.actor.id !== actor.id),
        member,
      ]);
      return member;
    })
    .on("DELETE", "/v0/rooms/{roomId}/members/{actorId}", ({ params }) => {
      seed.membersByRoom.set(
        params.roomId!,
        (seed.membersByRoom.get(params.roomId!) ?? []).filter(
          (member) => member.actor.id !== params.actorId,
        ),
      );
    });
}

/**
 * Accepts Messages and Threads. A Message is appended to the seed and its
 * event emitted; a Thread reply also updates its root's Thread summary.
 */
export function acceptRoomMessages(runtime: TestTeamHubRuntime) {
  const { seed } = runtime;
  let next = 0;
  const emit = (event: Omit<TeamHubRoomEvent, "room_seq">) =>
    runtime.events.emitRoomEvent({
      ...event,
      room_seq: latestRoomSeq(seed, event.room_id) + 1,
    });
  runtime.server.on(
    "POST",
    "/v0/rooms/{roomId}/messages",
    ({ body, params }) => {
      const input = body as TeamHubMessageCreateInput;
      const roomId = params.roomId!;
      const room = seed.rooms.find((candidate) => candidate.id === roomId);
      if (!room) return teamHubErrorResponse(404, "ROOM_NOT_FOUND");
      const messages = seed.messagesByRoom.get(roomId) ?? [];
      const message: TeamHubMessage = {
        attachments: [],
        author: actorRef(seed.identity.actors[0]!),
        created_at: new Date().toISOString(),
        id: `message-sent-${++next}`,
        message_kind: "conversation",
        raw_message: input.raw_message,
        room_id: roomId,
        segments: input.segments,
        tenant_id: seed.tenant.id,
        ...(input.context_message_ids?.length
          ? {
              context_messages: input.context_message_ids.flatMap((id) =>
                messages
                  .filter((candidate) => candidate.id === id)
                  .map((source) => ({
                    author: source.author,
                    created_at: source.created_at,
                    message_id: source.id,
                    raw_message: source.raw_message,
                    segments: source.segments,
                  })),
              ),
            }
          : {}),
      };
      seed.messagesByRoom.set(roomId, [...messages, message]);
      runtime.events.emitRoomEvent(
        messageEvent(message, latestRoomSeq(seed, roomId) + 1),
      );
      const root =
        room.kind === "thread" && room.parent_room_id
          ? seed.messagesByRoom
              .get(room.parent_room_id)
              ?.find((candidate) => candidate.id === room.root_message_id)
          : undefined;
      if (root && room.parent_room_id) {
        const replies = seed.messagesByRoom.get(roomId) ?? [];
        root.thread = {
          latest_reply_at: message.created_at,
          latest_reply_authors: [message.author],
          reply_count: replies.length,
          room_id: roomId,
        };
        emit({
          event_id: `event-thread-${message.id}`,
          event_type: "message.thread_summary.updated",
          occurred_at: message.created_at,
          payload: {
            kind: "message.thread_summary.updated",
            message_id: root.id,
            thread: root.thread,
          },
          room_id: room.parent_room_id,
          tenant_id: seed.tenant.id,
        });
      }
      return Response.json(message, { status: 201 });
    },
  );
  runtime.server.on(
    "POST",
    "/v0/rooms/{roomId}/messages/{messageId}/thread",
    ({ params }) => {
      const parent = seed.rooms.find((room) => room.id === params.roomId);
      if (!parent) return teamHubErrorResponse(404, "ROOM_NOT_FOUND");
      const existing = seed.rooms.find(
        (room) =>
          room.kind === "thread" &&
          room.parent_room_id === params.roomId &&
          room.root_message_id === params.messageId,
      );
      if (existing) return { room: existing };
      const root = seed.messagesByRoom
        .get(params.roomId!)
        ?.find((message) => message.id === params.messageId);
      if (!root) return teamHubErrorResponse(404, "MESSAGE_NOT_FOUND");
      const now = new Date().toISOString();
      const thread: TeamHubRoomListItem = {
        created_at: now,
        created_by: actorRef(seed.identity.actors[0]!),
        description: parent.description,
        id: `room-thread-${++next}`,
        kind: "thread",
        latest_room_seq: 0,
        name: `${parent.name} Thread`,
        parent_room_id: parent.id,
        read_through_room_seq: 0,
        root_message_id: root.id,
        tenant_id: parent.tenant_id,
        unread_mention_count: 0,
        unread_message_count: 0,
        updated_at: now,
      };
      seed.rooms.push(thread);
      seed.messagesByRoom.set(thread.id, []);
      seed.eventsByRoom.set(thread.id, []);
      root.thread = { reply_count: 0, room_id: thread.id };
      return { room: thread };
    },
  );
}

function latestRoomSeq(seed: TeamHubTestSeed, roomId: string) {
  return seed.eventsByRoom.get(roomId)?.at(-1)?.room_seq ?? 0;
}

function createTestEventTransport(seed: TeamHubTestSeed): TestEventTransport {
  const roomListeners = new Map<
    string,
    Set<(event: TeamHubRoomEvent) => void>
  >();
  const signalListeners = new Set<(signal: TeamHubEventSignal) => void>();
  return {
    emitRoomEvent(event) {
      seed.eventsByRoom.set(event.room_id, [
        ...(seed.eventsByRoom.get(event.room_id) ?? []),
        event,
      ]);
      for (const listener of roomListeners.get(event.room_id) ?? [])
        listener(event);
    },
    emitSignal(signal) {
      for (const listener of signalListeners) listener(signal);
    },
    subscribeSignals(listener) {
      signalListeners.add(listener);
      return () => signalListeners.delete(listener);
    },
    subscribeRoom(subscription) {
      let disposed = false;
      let replayComplete = false;
      const buffered: TeamHubRoomEvent[] = [];
      let liveEventQueue = Promise.resolve();
      const apply = async (event: TeamHubRoomEvent) => {
        if (!disposed && event.room_seq > subscription.getLastAppliedRoomSeq())
          await subscription.applyEvent(event);
      };
      const reportError = (error: unknown) => {
        subscription.onError?.(
          error instanceof Error ? error : new Error("Realtime failed."),
        );
      };
      const listener = (event: TeamHubRoomEvent) => {
        if (replayComplete) {
          liveEventQueue = liveEventQueue
            .then(() => apply(event))
            .catch(reportError);
        } else {
          buffered.push(event);
        }
      };
      const listeners = roomListeners.get(subscription.roomId) ?? new Set();
      listeners.add(listener);
      roomListeners.set(subscription.roomId, listeners);
      subscription.onStatusChange?.("catching-up");
      void (async () => {
        try {
          for (const event of seed.eventsByRoom.get(subscription.roomId) ?? [])
            await apply(event);
          while (buffered.length) {
            for (const event of buffered
              .splice(0)
              .sort((first, second) => first.room_seq - second.room_seq))
              await apply(event);
          }
          replayComplete = true;
          subscription.onStatusChange?.("connected");
        } catch (error) {
          reportError(error);
        }
      })();
      return () => {
        disposed = true;
        listeners.delete(listener);
      };
    },
  };
}

// The test server keeps no event log, so the transcript feed is polled with
// the live transport's per-request budget.
function createPollingVoiceEventTransport(
  client: TeamHubRuntime["client"],
): VoiceEventTransport {
  return {
    subscribe(input) {
      const requests = new VoiceRequestScope();
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cursor: { id: string; updatedAt: string } | undefined;
      let failures = 0;
      const read = async (signal: AbortSignal) => {
        const page = await requests.run(
          (requestSignal) =>
            teamHubData(
              client.api.GET(
                "/v0/voice-sessions/{voiceSessionId}/transcript-events",
                {
                  params: {
                    path: { voiceSessionId: input.voiceSessionId },
                    query: {
                      after_updated_at: cursor?.updatedAt,
                      after_id: cursor?.id,
                    },
                  },
                  signal: requestSignal,
                },
              ),
            ),
          signal,
        );
        if (controller.signal.aborted) return page;
        input.onTranscriptPage(page);
        const last = page.items.at(-1);
        if (last) cursor = { id: last.id, updatedAt: last.updated_at };
        return page;
      };
      const poll = () => {
        read(controller.signal).then(
          (page) => {
            if (controller.signal.aborted) return;
            failures = 0;
            timer = setTimeout(poll, page.items.length === 100 ? 0 : 500);
          },
          () => {
            if (controller.signal.aborted) return;
            input.onMode("recovering");
            timer = setTimeout(poll, voicePollRetryDelay(++failures));
          },
        );
      };
      poll();
      return Object.assign(
        () => {
          controller.abort();
          clearTimeout(timer);
        },
        {
          async catchUp(signal: AbortSignal) {
            const both = AbortSignal.any([controller.signal, signal]);
            let page: TeamHubVoiceTranscriptEventPage;
            do page = await read(both);
            while (page.items.length === 100);
          },
        },
      );
    },
  };
}

function page<T>(items: T[]) {
  return { items, page: { has_more: false } };
}

function notFound(code: string) {
  return teamHubErrorResponse(404, code);
}

function installSeedRoutes(server: TeamHubTestServer, seed: TeamHubTestSeed) {
  const findRoom = (roomId: string) =>
    seed.rooms.find((room) => room.id === roomId);
  const currentActor = () => seed.identity.actors[0]!;
  let previewSessions = 0;

  server
    .on("GET", "/v0/session", () => ({
      account_id: seed.identity.account.id,
      created_at: "2026-10-15T00:00:00Z",
      expires_at: "2026-10-16T00:00:00Z",
      id: "session-test",
      identity: seed.identity,
    }))
    .on("GET", "/v0/me", () => seed.identity)
    .on("GET", "/v0/tenants", () => ({ items: [seed.tenant] }))
    .on("GET", "/v0/tenants/{tenantId}", ({ params }) =>
      params.tenantId === seed.tenant.id
        ? seed.tenant
        : notFound("TENANT_NOT_FOUND"),
    )
    .on("GET", "/v0/tenants/{tenantId}/actors", () => page(seed.actors))
    .on("GET", "/v0/tenants/{tenantId}/actors/{actorId}", ({ params }) => {
      const actor = seed.actors.find((item) => item.id === params.actorId);
      return actor ?? notFound("ACTOR_NOT_FOUND");
    })
    .on("GET", "/v0/tenants/{tenantId}/account-profile", () => ({
      bio: "",
      bio_user_managed: false,
      email: seed.identity.account.email,
      name: currentActor().display_name,
      name_user_managed: false,
      organization: "",
      organization_user_managed: false,
    }))
    .on("GET", "/v0/tenants/{tenantId}/agents", () => page(seed.tenantAgents))
    .on("GET", "/v0/tenants/{tenantId}/agent-availability", () =>
      page(
        seed.tenantAgents.map((agent) => ({
          actor_id: agent.actor.id,
          availability: agent.availability,
          ...(agent.local_runtime_status
            ? { local_runtime_status: agent.local_runtime_status }
            : {}),
        })),
      ),
    )
    .on(
      "GET",
      "/v0/tenants/{tenantId}/agents/{agentId}/skill-bindings",
      ({ params }) => {
        const agent = seed.tenantAgents.find(
          (item) => item.actor.id === params.agentId,
        );
        if (!agent) return notFound("AGENT_NOT_FOUND");
        return {
          agent_actor_id: agent.actor.id,
          binding_version: 1,
          items: agent.skill_bindings.flatMap((item) =>
            item.is_default
              ? []
              : [
                  {
                    agent_actor_id: agent.actor.id,
                    binding_version: 1,
                    config: {},
                    enabled: true,
                    id: `binding-${agent.actor.id}-${item.skill_id}`,
                    skill: {
                      manifest_version: item.manifest_version,
                      skill_id: item.skill_id,
                    },
                    tenant_id: params.tenantId,
                    updated_at: agent.updated_at,
                    updated_by_actor_id: agent.created_by.id,
                  },
                ],
          ),
        };
      },
    )
    .on("GET", "/v0/tenants/{tenantId}/skill-manifests", () =>
      page(seed.skillManifests),
    )
    .on("GET", "/v0/tenants/{tenantId}/local-computers", () => ({
      items: seed.localComputers,
    }))
    .on("GET", "/v0/tenants/{tenantId}/agent-templates", () => ({
      items: seed.agentTemplates,
    }))
    .on(
      "GET",
      "/v0/tenants/{tenantId}/agent-templates/{templateId}/skill-imports",
      () => ({ items: [] }),
    )
    .on("GET", "/v0/tenants/{tenantId}/another-me", () => {
      const agent = seed.tenantAgents.find(
        (candidate) => candidate.agent_type === "anotherme",
      );
      return agent
        ? { agent_actor_id: agent.actor.id, room_id: "room-another-me" }
        : {};
    })
    .on("GET", "/v0/tenants/{tenantId}/room-activity", () => ({
      failed_room_ids: [],
      running_room_ids: [],
    }))
    .on("GET", "/v0/tenants/{tenantId}/rooms", ({ params }) => {
      const actorId = seed.identity.actors.find(
        (actor) => actor.tenant_id === params.tenantId,
      )?.id;
      return page(
        seed.rooms
          .filter((room) => {
            if (room.tenant_id !== params.tenantId || !actorId) return false;
            if (room.kind === "thread")
              return actorCanListThread(seed, room, actorId);
            return (seed.membersByRoom.get(room.id) ?? []).some(
              (member) => member.actor.id === actorId,
            );
          })
          .map((room) => ({
            ...room,
            member_preview: (
              seed.membersByRoom.get(room.parent_room_id ?? room.id) ?? []
            )
              .slice(0, 9)
              .map((member) => member.actor),
          })),
      );
    })
    .on(
      "GET",
      "/v0/rooms/{roomId}",
      ({ params }) => findRoom(params.roomId!) ?? notFound("ROOM_NOT_FOUND"),
    )
    .on("GET", "/v0/rooms/{roomId}/members", ({ params }) => {
      const room = findRoom(params.roomId!);
      if (!room) return notFound("ROOM_NOT_FOUND");
      const source =
        room.kind === "thread" && room.parent_room_id
          ? room.parent_room_id
          : room.id;
      return page(
        (seed.membersByRoom.get(source) ?? []).map((member) => ({
          ...member,
          room_id: room.id,
        })),
      );
    })
    .on("GET", "/v0/rooms/{roomId}/messages", ({ params, query }) => {
      if (!findRoom(params.roomId!)) return notFound("ROOM_NOT_FOUND");
      const all = seed.messagesByRoom.get(params.roomId!) ?? [];
      const cursor = query.get("cursor");
      const cursorIndex = cursor
        ? all.findIndex((message) => message.id === cursor)
        : all.length;
      const eligible = all.slice(0, cursorIndex < 0 ? 0 : cursorIndex);
      const items = eligible.slice(-Number(query.get("limit") ?? 50));
      const hasMore = eligible.length > items.length;
      return {
        items,
        page: {
          has_more: hasMore,
          ...(hasMore && items[0] ? { next_cursor: items[0].id } : {}),
        },
        snapshot_room_seq: latestRoomSeq(seed, params.roomId!),
      };
    })
    .on("GET", "/v0/rooms/{roomId}/messages/{messageId}", ({ params }) => {
      const message = seed.messagesByRoom
        .get(params.roomId!)
        ?.find((item) => item.id === params.messageId);
      return message ?? notFound("MESSAGE_NOT_FOUND");
    })
    .on("GET", "/v0/rooms/{roomId}/events", ({ params, query }) => {
      if (!findRoom(params.roomId!)) return notFound("ROOM_NOT_FOUND");
      const all = seed.eventsByRoom.get(params.roomId!) ?? [];
      const after = Number(query.get("after") ?? 0);
      const items = all
        .filter((event) => event.room_seq > after)
        .slice(0, Number(query.get("limit") ?? 200));
      return {
        has_more: all.some(
          (event) => event.room_seq > (items.at(-1)?.room_seq ?? after),
        ),
        items,
        latest_room_seq: all.at(-1)?.room_seq ?? 0,
      };
    })
    .on("GET", "/v0/rooms/{roomId}/run-statuses", ({ params }) => ({
      items: (seed.runStatusesByRoom.get(params.roomId!) ?? []).map(
        wireRunStatus,
      ),
    }))
    .on("GET", "/v0/rooms/{roomId}/background-tasks", () => ({ items: [] }))
    .on("GET", "/v0/rooms/{roomId}/routines", () => page([]))
    .on("GET", "/v0/rooms/{roomId}/messages/{messageId}/activities", () => ({
      has_native_turn: false,
      provider_kind: "codex",
      records: [],
      status: "unavailable",
      truncated: false,
    }))
    .on(
      "GET",
      "/v0/tenants/{tenantId}/local-computers/{computerId}/browser-connection",
      () => ({ mode: "isolated", platform: "darwin", state: "isolated" }),
    )
    .on(
      "GET",
      "/v0/tenants/{tenantId}/personal-wiki/graph",
      () =>
        new Response("<!doctype html><title>Graph</title>", {
          headers: { "content-type": "text/html" },
        }),
    )
    .on("GET", "/v0/documents/{documentId}/link-share", () =>
      notFound("DOCUMENT_LINK_SHARE_NOT_FOUND"),
    )
    .on("GET", "/v0/documents/{documentId}/comment-threads", () => page([]))
    .on("GET", "/v0/documents/{documentId}/agent-mention-candidates", () =>
      page([]),
    )
    .on(
      "GET",
      "/v0/rooms/{roomId}/runtime-presentation-runs",
      ({ params, query }) => {
        const runId = query.get("run_id");
        const messageIds = new Set(query.getAll("message_id"));
        return {
          items: (seed.runStatusesByRoom.get(params.roomId!) ?? [])
            .filter((status) =>
              runId
                ? status.run_id === runId
                : status.status === "active" ||
                  (
                    seed.runtimePresentationEventsByRunStatusId.get(
                      status.id,
                    ) ?? []
                  ).some(
                    (record) =>
                      record.message_id !== undefined &&
                      messageIds.has(record.message_id),
                  ),
            )
            .map(wireRunStatus),
        };
      },
    )
    .on(
      "GET",
      "/v0/rooms/{roomId}/runs/{runId}/runtime-presentation-events",
      ({ params, query }) => {
        const status = (seed.runStatusesByRoom.get(params.roomId!) ?? []).find(
          (candidate) =>
            candidate.run_id === params.runId || candidate.id === params.runId,
        );
        if (!status) return notFound("RUN_NOT_FOUND");
        const records =
          seed.runtimePresentationEventsByRunStatusId.get(status.id) ?? [];
        const after = BigInt(query.get("after") ?? "0");
        const eligible = records.filter(
          (record) => BigInt(record.event_ordinal) > after,
        );
        const items = eligible.slice(0, Number(query.get("limit") ?? 200));
        return {
          has_more: eligible.length > items.length,
          items,
          published_through_ordinal: records.at(-1)?.event_ordinal ?? "0",
        };
      },
    )
    .on("GET", "/v0/rooms/{roomId}/documents", ({ params }) =>
      page(
        [...seed.documents.values()]
          .filter(
            (document) =>
              document.status === "active" &&
              document.from.some(
                (binding) =>
                  binding.binding_kind === "room" &&
                  binding.context_id === params.roomId,
              ),
          )
          .sort(
            (left, right) =>
              Date.parse(right.updated_at) - Date.parse(left.updated_at) ||
              left.id.localeCompare(right.id),
          ),
      ),
    )
    .on(
      "GET",
      "/v0/documents/{documentId}",
      ({ params }) =>
        seed.documents.get(params.documentId!) ?? notFound("NOT_FOUND"),
    )
    .on("POST", "/v0/documents/{documentId}/open", ({ params }) => {
      const document = seed.documents.get(params.documentId!);
      if (!document) return notFound("NOT_FOUND");
      const credential =
        document.format === "blocknote" &&
        document.representation_format !== "html" &&
        document.draft_capability !== "none"
          ? collaborationCredential(
              document,
              document.draft_capability === "read",
            )
          : undefined;
      return {
        document,
        ...(credential ? { collaboration_credential: credential } : {}),
      };
    })
    .on(
      "POST",
      "/v0/documents/{documentId}/collaboration-credentials",
      ({ params }) => {
        const document = seed.documents.get(params.documentId!);
        return (
          (document && collaborationCredential(document, false)) ??
          notFound("NOT_FOUND")
        );
      },
    )
    .on(
      "POST",
      "/v0/documents/{documentId}/read-session-credentials",
      ({ params }) => {
        const document = seed.documents.get(params.documentId!);
        return (
          (document && collaborationCredential(document, true)) ??
          notFound("NOT_FOUND")
        );
      },
    )
    .on("GET", "/v0/documents/{documentId}/versions", ({ params }) => {
      if (!seed.documents.has(params.documentId!)) return notFound("NOT_FOUND");
      return page(
        [...seed.documentVersions.values()]
          .filter((version) => version.document_id === params.documentId)
          .sort((left, right) => right.version_number - left.version_number),
      );
    })
    .on("GET", "/v0/documents/{documentId}/history", () => page([]))
    .on(
      "GET",
      "/v0/document-versions/{documentVersionId}",
      ({ params }) =>
        seed.documentVersions.get(params.documentVersionId!) ??
        notFound("NOT_FOUND"),
    )
    .on(
      "GET",
      "/v0/document-versions/{documentVersionId}/content",
      ({ params }) => versionContent(seed, params.documentVersionId!),
    )
    // An ordinary Document downloads as its current Version.
    .on("GET", "/v0/documents/{documentId}/downloads", ({ params }) => {
      const versionId = seed.documents.get(params.documentId!)?.current_version
        ?.id;
      return versionId
        ? versionContent(seed, versionId)
        : notFound("NOT_FOUND");
    })
    .on(
      "POST",
      "/v0/document-versions/{documentVersionId}/preview-sessions",
      ({ params, request }) => {
        const version = seed.documentVersions.get(params.documentVersionId!);
        if (!version) return notFound("NOT_FOUND");
        return {
          expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
          preview_url: new URL(
            `/v0/document-previews/preview-${++previewSessions}/${encodeURIComponent(version.filename)}`,
            request.url,
          ).toString(),
        };
      },
    )
    .on("GET", "/v0/tenants/{tenantId}/me/document-tree", () =>
      myDocumentTree(seed),
    )
    .on(
      "GET",
      "/v0/tenants/{tenantId}/me/shared-document-tree",
      ({ params }) => {
        const actor = seed.identity.actors.find(
          (candidate) => candidate.tenant_id === params.tenantId,
        );
        return {
          items: [...seed.documents.values()].flatMap(
            (document): TeamHubDocumentPlacementNode[] =>
              document.tenant_id !== params.tenantId ||
              document.status !== "active" ||
              document.owner.id === actor?.id ||
              !document.capabilities.read
                ? []
                : [
                    {
                      created_at: document.created_at,
                      document: {
                        ...documentTreeSummary(document),
                        access_sources: document.access_v2?.sources ?? [],
                      },
                      document_id: document.id,
                      id: `shared-document-${document.id}`,
                      node_kind: "document",
                      sort_key: document.id,
                      updated_at: document.updated_at,
                    },
                  ],
          ),
        };
      },
    )
    .on("GET", "/v0/library/documents", ({ query }) => {
      const actorId = currentActor().id;
      const view = query.get("view");
      const placed = new Set(
        myDocumentTree(seed).items.flatMap((item) =>
          item.node_kind === "document" ? [item.document_id] : [],
        ),
      );
      return documentPage(
        [...seed.documents.values()].filter((document) => {
          if (document.status !== "active") return false;
          const owned = document.owner.id === actorId;
          if (view === "owned") return owned;
          if (view === "shareable")
            return owned || document.capabilities.manage;
          if (view === "shared") return !owned;
          if (view === "unfiled") return owned && !placed.has(document.id);
          return true;
        }),
        query,
      );
    })
    .on("GET", "/v0/library/documents/search", ({ query }) => {
      const text = (query.get("q") ?? "").trim().toLocaleLowerCase();
      return documentPage(
        [...seed.documents.values()].filter(
          (document) =>
            document.status === "active" &&
            [
              document.title,
              document.owner.display_name,
              document.creator.display_name,
            ].some((value) => value.toLocaleLowerCase().includes(text)),
        ),
        query,
      );
    })
    .on(
      "GET",
      "/v0/tenants/{tenantId}/personal-wiki/documents",
      ({ params, query }) =>
        documentPage(
          [...seed.documents.values()].filter(
            (document) =>
              document.tenant_id === params.tenantId &&
              document.status === "active" &&
              document.from.some(
                (source) =>
                  source.binding_kind === "wiki_source" ||
                  source.binding_kind === "wiki_page",
              ),
          ),
          query,
        ),
    )
    .on("GET", "/v0/tenants/{tenantId}/personal-wiki", ({ params }) => ({
      created_at: "2026-08-23T00:00:00.000Z",
      id: `wiki-${params.tenantId}`,
      owner_actor_id: currentActor().id,
      published_generation: 1,
      state: "idle",
      tenant_id: params.tenantId,
      updated_at: "2026-08-23T00:00:00.000Z",
    }))
    .on("GET", "/v0/tenants/{tenantId}/memory", () => ({ items: [] }))
    .on("GET", "/v0/tenants/{tenantId}/me/pocket-notes", () => ({
      items: [],
      page: { has_more: false },
      today: new Date().toISOString().slice(0, 10),
    }))
    .on("GET", "/v0/tenants/{tenantId}/voice-media-policy", () => ({
      voice_media_supported: true,
    }))
    .on("GET", "/v0/tenants/{tenantId}/work-items", ({ query }) =>
      page(
        seed.workItems.filter(
          (item) => query.get("archived") === "true" || !item.archived_at,
        ),
      ),
    )
    .on(
      "GET",
      "/v0/work-items/{workItemId}",
      ({ params }) =>
        seed.workItems.find((item) => item.id === params.workItemId) ??
        notFound("WORK_ITEM_NOT_FOUND"),
    )
    .on("GET", "/v0/rooms/{roomId}/team-md", ({ params }) =>
      params.roomId === "room-all" ? seedTeamMd : notFound("NOT_FOUND"),
    )
    .on("GET", "/v0/tenants/{tenantId}/personal-profile", ({ params }) => {
      const revision = {
        created_at: "2026-08-11T08:00:00.000Z",
        id: "personal-profile-revision-seed",
        markdown: seedProfileMarkdown,
        profile: seedProfile,
        prompt_version: "user-profile-v1",
        tenant_id: params.tenantId,
      };
      return { current: revision, has_more: false, history: [revision] };
    })
    .on("GET", "/v0/tenants/{tenantId}/personal-profile-generations", () => ({
      items: [],
    }))
    .on("GET", "/v0/tenants/{tenantId}/personal-insights", () => ({
      items: [
        {
          created_at: "2026-08-11T08:00:00.000Z",
          dimension: "Communication style",
          id: "personal-insight-seed",
          statement:
            "You prefer direct evidence and clear ownership before a team commits to a plan.",
        },
      ],
    }))
    .on("GET", "/v0/external-apps", () => ({
      apps: seed.externalSources.apps,
      provider_configured: true,
      provider_key: { can_save: true, source: "stored" },
    }))
    .on("GET", "/v0/external-connections", () => ({
      connections: seed.externalSources.connections,
    }))
    .on(
      "GET",
      "/v0/external-connections/{externalConnectionId}",
      ({ params }) =>
        externalConnection(seed, params.externalConnectionId!) ??
        notFound("EXTERNAL_CONNECTION_NOT_FOUND"),
    )
    .on(
      "GET",
      "/v0/external-connections/{externalConnectionId}/agent-grants",
      ({ params }) =>
        externalConnection(seed, params.externalConnectionId!)
          ? {
              agents:
                seed.externalSources.agentAccess.get(
                  params.externalConnectionId!,
                ) ?? [],
            }
          : notFound("EXTERNAL_CONNECTION_NOT_FOUND"),
    )
    .on(
      "GET",
      "/v0/external-connections/{externalConnectionId}/slack/conversations",
      ({ params, query }) =>
        providerPage(
          seed,
          params,
          query,
          "slack",
          seed.externalSources.conversations,
          (conversations, next_cursor) => ({ conversations, next_cursor }),
        ),
    )
    .on(
      "GET",
      "/v0/external-connections/{externalConnectionId}/discord/channels",
      ({ params, query }) =>
        providerPage(
          seed,
          params,
          query,
          "discord",
          seed.externalSources.discordChannels,
          (channels) => ({ channels }),
        ),
    )
    .on(
      "GET",
      "/v0/external-connections/{externalConnectionId}/github/repositories",
      ({ params, query }) =>
        providerPage(
          seed,
          params,
          query,
          "github",
          seed.externalSources.githubRepositories,
          (repositories, next_cursor) => ({ next_cursor, repositories }),
        ),
    )
    .on(
      "GET",
      "/v0/external-connections/{externalConnectionId}/notion/resources",
      ({ params, query }) =>
        providerPage(
          seed,
          params,
          query,
          "notion",
          seed.externalSources.notionResources,
          (resources, next_cursor) => ({ next_cursor, resources }),
        ),
    )
    .on(
      "GET",
      "/v0/external-connections/{externalConnectionId}/google-calendar/calendars",
      ({ params, query }) =>
        providerPage(
          seed,
          params,
          query,
          "google_calendar",
          seed.externalSources.googleCalendars,
          (calendars, next_page_token) => ({ calendars, next_page_token }),
        ),
    )
    // Ambient writes every mounted Room sends; tests assert them through
    // `server.requests` when they matter.
    .on("POST", "/v0/rooms/{roomId}/presence", () => undefined)
    .on("PUT", "/v0/rooms/{roomId}/read-state", ({ body, params }) => ({
      read_through_room_seq: (body as { through_room_seq: number })
        .through_room_seq,
      room_id: params.roomId,
      updated_at: new Date().toISOString(),
    }));
}

function externalConnection(seed: TeamHubTestSeed, connectionId: string) {
  return seed.externalSources.connections.find(
    (connection) => connection.id === connectionId,
  );
}

/** One offset page of a provider's listing, as TeamHub pages them. */
function providerPage<Item>(
  seed: TeamHubTestSeed,
  params: Record<string, string>,
  query: URLSearchParams,
  provider: string,
  all: Item[],
  render: (items: Item[], next: string | undefined) => unknown,
) {
  const connection = externalConnection(seed, params.externalConnectionId!);
  if (connection?.provider !== provider)
    return notFound(`${provider.toUpperCase()}_CONNECTION_NOT_FOUND`);
  const offset = Number(query.get("cursor") ?? query.get("page_token") ?? 0);
  const limit = Number(query.get("limit") ?? 50);
  return render(
    all.slice(offset, offset + limit),
    offset + limit < all.length ? String(offset + limit) : undefined,
  );
}

function wireRunStatus(status: TeamHubRunStatus): TeamHubRoomRunStatus {
  return {
    agent: status.agent,
    created_at: status.created_at,
    event_ordinal: status.revision,
    replied: status.replied,
    room_id: status.room_id,
    run_id: status.run_id,
    status: status.status,
    ...(status.stop_reason === undefined
      ? {}
      : { stop_reason: status.stop_reason }),
    updated_at: status.updated_at,
  };
}

async function versionContent(seed: TeamHubTestSeed, versionId: string) {
  const version = seed.documentVersions.get(versionId);
  const content = seed.documentVersionContents.get(versionId);
  if (!version || !content) return notFound("NOT_FOUND");
  // jsdom Blobs are not Fetch body sources, so send their bytes.
  return new Response(await content.arrayBuffer(), {
    headers: {
      "content-type": version.media_type,
      "x-content-sha256": version.sha256,
    },
  });
}

/** A Document Runtime credential, issued when the Document allows the access. */
function collaborationCredential(document: TeamHubDocument, readOnly: boolean) {
  const allowed =
    document.status === "active" &&
    document.format === "blocknote" &&
    (readOnly
      ? document.capabilities.read && document.draft_capability !== "none"
      : document.capabilities.write && document.draft_capability === "write");
  if (!allowed) return undefined;
  return {
    collaboration_credential: `test-${readOnly ? "read" : "write"}-credential:${document.id}`,
    document_id: document.id,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
}

function myDocumentTree(seed: TeamHubTestSeed): TeamHubMyDocumentTree {
  if (seed.documentTree)
    return {
      // Like TeamHub, the tree lists only active Documents.
      items: seed.documentTree.items.flatMap<TeamHubDocumentPlacementNode>(
        (item) => {
          if (item.node_kind === "folder") return [item];
          const document = seed.documents.get(item.document_id);
          if (!document) return [item];
          return document.status === "active"
            ? [{ ...item, document: documentTreeSummary(document) }]
            : [];
        },
      ),
    };
  return {
    items: [...seed.documents.values()]
      .filter(
        (document) =>
          document.status === "active" &&
          seed.identity.actors.some((actor) => actor.id === document.owner.id),
      )
      .map((document) => ({
        created_at: document.created_at,
        document: documentTreeSummary(document),
        document_id: document.id,
        id: `placement-${document.id}`,
        node_kind: "document" as const,
        sort_key: document.id,
        updated_at: document.updated_at,
      })),
  };
}

function documentTreeSummary(document: TeamHubDocument) {
  return {
    can_edit_native_content:
      document.format === "blocknote" && document.draft_capability !== "none",
    capabilities: document.capabilities,
    format: document.format,
    id: document.id,
    owner: document.owner,
    representation_format: document.representation_format,
    status: document.status,
    title: document.title,
    updated_at: document.updated_at,
  };
}

function documentPage(
  values: TeamHubDocument[],
  query: URLSearchParams,
): TeamHubDocumentPage {
  const sorted = [...values].sort(
    (left, right) =>
      right.updated_at.localeCompare(left.updated_at) ||
      right.id.localeCompare(left.id),
  );
  const cursor = query.get("cursor");
  const cursorIndex = cursor
    ? sorted.findIndex((item) => item.id === cursor)
    : -1;
  const remaining = sorted.slice(cursorIndex + 1);
  const items = remaining.slice(0, Number(query.get("limit") ?? 50));
  const hasMore = remaining.length > items.length;
  return {
    items,
    page: {
      has_more: hasMore,
      ...(hasMore ? { next_cursor: items.at(-1)!.id } : {}),
    },
  };
}

function actorCanListThread(
  seed: TeamHubTestSeed,
  room: TeamHubRoomListItem,
  actorId: string,
) {
  if (
    !room.parent_room_id ||
    !(seed.membersByRoom.get(room.parent_room_id) ?? []).some(
      (member) => member.actor.id === actorId,
    )
  )
    return false;
  return (seed.messagesByRoom.get(room.id) ?? []).some(
    (message) =>
      message.author.id === actorId ||
      message.segments.some(
        (segment) =>
          segment.type === "reference" &&
          "target" in segment &&
          segment.target === actorId,
      ),
  );
}
