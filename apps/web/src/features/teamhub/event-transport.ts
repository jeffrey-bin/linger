/* oxlint-disable react-doctor/async-await-in-loop -- Room Events are applied in room_seq order. */
import {
  openEventStream,
  type EventStreamConnection,
  type EventStreamOptions,
} from "./event-stream";
import {
  reportTeamHubAuthenticationRequired,
  type TeamHubAuthenticationReason,
} from "./teamhub-authentication";
import { teamHubUrl } from "./teamhub-api";
import { resolveTeamHubBaseUrl } from "./teamhub-base-url";
import type {
  TeamHubInvalidationResource,
  TeamHubResourceInvalidation,
  TeamHubRoomEvent,
} from "./teamhub-types";

// The browser's single business SSE, GET /v0/events. Displayed
// Rooms ride on it as room_seq cursors that TeamHub replays and then follows;
// every other change arrives as an identity-only invalidation hint.

export type RoomRealtimeStatus =
  | "catching-up"
  | "connected"
  | "offline"
  | "reconnecting";

export interface RoomRealtimeSubscription {
  applyEvent: (event: TeamHubRoomEvent) => Promise<void> | void;
  getLastAppliedRoomSeq: () => number;
  onError?: (error: Error) => void;
  // The Room's summary, read state, or the Account's access to it changed;
  // the subscriber rereads the Room to learn which.
  onRoomInvalidated: () => void;
  onStatusChange?: (status: RoomRealtimeStatus) => void;
  roomId: string;
}

export type TeamHubEventSignal =
  // A Room Event of a subscribed Room, after its subscribers applied it.
  | { event: TeamHubRoomEvent; type: "room.event" }
  | { hint: TeamHubResourceInvalidation; type: "resource.invalidated" }
  // Hints before this point may be missing: refetch every displayed
  // hint-scoped resource once.
  | { type: "stream.resync" };

export interface TeamHubEventTransport {
  subscribeRoom(input: RoomRealtimeSubscription): () => void;
  subscribeSignals(listener: (signal: TeamHubEventSignal) => void): () => void;
}

// TeamHub accepts at most this many Room cursors on one connection.
const MAXIMUM_ROOM_CURSORS = 50;
const invalidationResources = {
  agents: true,
  "another-me": true,
  computers: true,
  connections: true,
  directory: true,
  document: true,
  "document-access": true,
  room: true,
  "work-items": true,
} satisfies Record<TeamHubInvalidationResource, true>;

interface RoomEntry {
  caughtUp: boolean;
  input: RoomRealtimeSubscription;
  status?: RoomRealtimeStatus;
}

// One /v0/events stream with a fixed set of Room cursors. Changing the
// displayed Rooms opens a successor and keeps this stream open until the
// successor has replayed, so no hint is lost across the swap.
interface StreamHandle {
  close: () => void;
  // The predecessor kept open while this stream replays.
  covering?: StreamHandle;
  // A connection of this stream failed or paused since it last replayed.
  lost: boolean;
  // The current connection finished its replay.
  ready: boolean;
  roomIds: ReadonlySet<string>;
}

export function createTeamHubEventTransport(
  options: EventStreamOptions & {
    baseUrl?: string;
    onSessionExpired?: (reason: TeamHubAuthenticationReason) => void;
  },
): TeamHubEventTransport {
  const baseUrl = resolveTeamHubBaseUrl(options.baseUrl);
  const onSessionExpired =
    options.onSessionExpired ?? reportTeamHubAuthenticationRequired;
  const rooms = new Map<string, Set<RoomEntry>>();
  // The highest room_seq signaled per Room; overlapping streams repeat events.
  const signaledRoomSeq = new Map<string, number>();
  const signalListeners = new Set<(signal: TeamHubEventSignal) => void>();
  let current: StreamHandle | undefined;
  let waiting: "offline" | "reconnecting" | undefined;
  let reconcileScheduled = false;
  // A new Room subscriber replays from its own cursor on a fresh connection.
  let replayNeeded = false;
  let queue = Promise.resolve();

  const signal = (next: TeamHubEventSignal) => {
    for (const listener of [...signalListeners]) listener(next);
  };

  const publishStatus = () => {
    for (const entries of rooms.values()) {
      for (const entry of entries) {
        const status =
          waiting ?? (entry.caughtUp ? "connected" : "catching-up");
        if (status === entry.status) continue;
        entry.status = status;
        entry.input.onStatusChange?.(status);
      }
    }
  };

  const reportError = (error: Error) => {
    for (const entries of rooms.values()) {
      for (const entry of entries) entry.input.onError?.(error);
    }
  };

  const roomCursor = (roomId: string) => {
    let cursor: number | undefined;
    for (const entry of rooms.get(roomId) ?? []) {
      const applied = entry.input.getLastAppliedRoomSeq();
      cursor = cursor === undefined ? applied : Math.min(cursor, applied);
    }
    return cursor;
  };

  const receiveRoomEvent = async (handle: StreamHandle, data: string) => {
    const event = parseRoomEvent(data);
    if (!handle.roomIds.has(event.room_id)) return;
    for (const entry of [...(rooms.get(event.room_id) ?? [])]) {
      const cursor = entry.input.getLastAppliedRoomSeq();
      if (event.room_seq <= cursor) continue;
      if (event.room_seq !== cursor + 1) {
        // The reconnect replays from the subscriber's own cursor.
        throw new Error(
          `Room Event sequence gap: expected ${cursor + 1}, received ${event.room_seq}.`,
        );
      }
      await entry.input.applyEvent(event);
    }
    if (event.room_seq > (signaledRoomSeq.get(event.room_id) ?? 0)) {
      signaledRoomSeq.set(event.room_id, event.room_seq);
      signal({ event, type: "room.event" });
    }
  };

  const receiveHint = (handle: StreamHandle, data: string) => {
    const hint = parseInvalidation(data);
    // A resource type this client does not know, such as one a newer TeamHub
    // added, names nothing it displays.
    if (!hint) return;
    if (hint.resource === "room" && handle.roomIds.has(hint.id)) {
      for (const entry of [...(rooms.get(hint.id) ?? [])]) {
        entry.input.onRoomInvalidated();
      }
    }
    signal({ hint, type: "resource.invalidated" });
  };

  const receiveResync = (
    handle: StreamHandle,
    data: string,
    connection: EventStreamConnection,
  ) => {
    if (parseResyncReason(data) === "hints_lost") {
      signal({ type: "stream.resync" });
      return;
    }
    if (handle !== current) {
      // A retiring stream that reconnected may have missed hints; the
      // successor resyncs instead of trusting it.
      handle.lost = true;
      handle.close();
      return;
    }
    const covering = handle.covering;
    const covered =
      !handle.lost &&
      covering !== undefined &&
      covering.ready &&
      !covering.lost;
    handle.covering = undefined;
    covering?.close();
    handle.ready = true;
    handle.lost = false;
    connection.resetBackoff();
    waiting = undefined;
    for (const roomId of handle.roomIds) {
      for (const entry of rooms.get(roomId) ?? []) entry.caughtUp = true;
    }
    publishStatus();
    if (!covered) signal({ type: "stream.resync" });
  };

  const open = (roomIds: ReadonlySet<string>) => {
    const previous = current;
    let covering: StreamHandle | undefined;
    if (previous?.ready && !previous.lost) {
      covering = previous;
    } else {
      covering = previous?.covering;
      if (previous) previous.covering = undefined;
      previous?.close();
    }
    const handle: StreamHandle = {
      close: () => undefined,
      covering,
      lost: false,
      ready: false,
      roomIds,
    };
    current = handle;
    const enqueue = (
      connection: EventStreamConnection,
      operation: () => Promise<void> | void,
    ) => {
      queue = queue
        .then(() => (connection.isCurrent() ? operation() : undefined))
        .catch((error: unknown) => connection.fail(asEventStreamError(error)));
    };
    handle.close = openEventStream(options, {
      closedMessage: "TeamHub event stream closed.",
      events: {
        "resource.invalidated": (data, connection) =>
          enqueue(connection, () => receiveHint(handle, data)),
        "room.event": (data, connection) =>
          enqueue(connection, () => receiveRoomEvent(handle, data)),
        "stream.resync": (data, connection) =>
          enqueue(connection, () => receiveResync(handle, data, connection)),
      },
      onError: reportError,
      onSessionExpired,
      onWaiting(state) {
        handle.ready = false;
        handle.lost = true;
        if (handle !== current) {
          // A retiring stream is never reconnected; its successor resyncs.
          queueMicrotask(() => handle.close());
          return;
        }
        waiting = state;
        for (const entries of rooms.values()) {
          for (const entry of entries) entry.caughtUp = false;
        }
        publishStatus();
      },
      prepare(_connection, reconnecting) {
        handle.ready = false;
        if (reconnecting) {
          handle.lost = true;
          if (handle === current && waiting === undefined) {
            waiting = "reconnecting";
            publishStatus();
          }
        }
        const url = teamHubUrl(baseUrl, "/v0/events");
        for (const roomId of handle.roomIds) {
          const cursor = roomCursor(roomId);
          if (cursor !== undefined) {
            url.searchParams.append("room", `${roomId}:${cursor}`);
          }
        }
        return url;
      },
    });
  };

  const closeAll = () => {
    const handle = current;
    current = undefined;
    waiting = undefined;
    handle?.covering?.close();
    handle?.close();
  };

  const reconcile = () => {
    reconcileScheduled = false;
    if (rooms.size === 0 && signalListeners.size === 0) {
      closeAll();
      return;
    }
    const roomIds = new Set([...rooms.keys()].slice(-MAXIMUM_ROOM_CURSORS));
    if (!replayNeeded && current && sameMembers(current.roomIds, roomIds)) {
      return;
    }
    replayNeeded = false;
    open(roomIds);
  };

  const scheduleReconcile = () => {
    if (reconcileScheduled) return;
    reconcileScheduled = true;
    // Subscriptions changed in one render settle into one connection.
    queueMicrotask(reconcile);
  };

  return {
    subscribeRoom(input) {
      const entry: RoomEntry = { caughtUp: false, input };
      const entries = rooms.get(input.roomId) ?? new Set();
      entries.add(entry);
      rooms.set(input.roomId, entries);
      publishStatus();
      replayNeeded = true;
      scheduleReconcile();
      return () => {
        entries.delete(entry);
        if (entries.size === 0 && rooms.get(input.roomId) === entries) {
          rooms.delete(input.roomId);
          signaledRoomSeq.delete(input.roomId);
        }
        scheduleReconcile();
      };
    },
    subscribeSignals(listener) {
      signalListeners.add(listener);
      scheduleReconcile();
      return () => {
        signalListeners.delete(listener);
        scheduleReconcile();
      };
    },
  };
}

function sameMembers(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  return left.size === right.size && [...left].every((id) => right.has(id));
}

// TeamHub's /v0/events payloads follow the generated contract; the client
// trusts their shape and only skips what it does not know.
function parseRoomEvent(data: string) {
  return JSON.parse(data) as TeamHubRoomEvent;
}

function parseInvalidation(
  data: string,
): TeamHubResourceInvalidation | undefined {
  const hint = JSON.parse(data) as TeamHubResourceInvalidation;
  return Object.hasOwn(invalidationResources, hint.resource) ? hint : undefined;
}

function parseResyncReason(data: string) {
  return (JSON.parse(data) as { reason: "connected" | "hints_lost" }).reason;
}

function asEventStreamError(error: unknown) {
  return error instanceof Error
    ? error
    : new Error("TeamHub event stream synchronization failed.");
}
