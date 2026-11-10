// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import {
  createTeamHubEventTransport,
  type RoomRealtimeStatus,
  type RoomRealtimeSubscription,
  type TeamHubEventSignal,
} from "./event-transport";
import type { TeamHubRoomEvent } from "./teamhub-types";

describe("TeamHub event transport", () => {
  it("replays a Room from its cursor on one stream and resyncs hints on first connect", async () => {
    const { signals, sources, transport } = setup();
    const room = roomSubscriber("room-1", 4);
    const stopSignals = transport.subscribeSignals((signal) =>
      signals.push(signal),
    );
    const stopRoom = transport.subscribeRoom(room.input);

    await vi.waitFor(() => expect(sources).toHaveLength(1));
    expect(sources[0]!.url).toBe(
      "https://teamhub.example.test/v0/events?room=room-1%3A4",
    );
    expect(room.statuses).toEqual(["catching-up"]);

    sources[0]!.dispatch("room.event", roomEvent("room-1", 5));
    sources[0]!.dispatch("room.event", roomEvent("room-1", 5));
    sources[0]!.dispatch("stream.resync", { reason: "connected" });

    await vi.waitFor(() => expect(room.statuses.at(-1)).toBe("connected"));
    expect(room.applied).toEqual([5]);
    expect(signals.map((signal) => signal.type)).toEqual([
      "room.event",
      "stream.resync",
    ]);

    stopRoom();
    stopSignals();
    await vi.waitFor(() => expect(sources[0]!.close).toHaveBeenCalledOnce());
  });

  it("keeps the old stream until a Room switch replays, without a resync", async () => {
    const { signals, sources, transport } = setup();
    transport.subscribeSignals((signal) => signals.push(signal));
    const first = roomSubscriber("room-1", 2);
    const stopFirst = transport.subscribeRoom(first.input);
    await vi.waitFor(() => expect(sources).toHaveLength(1));
    sources[0]!.dispatch("stream.resync", { reason: "connected" });
    await vi.waitFor(() => expect(signals).toHaveLength(1));

    const second = roomSubscriber("room-2", 7);
    stopFirst();
    transport.subscribeRoom(second.input);
    await vi.waitFor(() => expect(sources).toHaveLength(2));
    expect(sources[1]!.url).toBe(
      "https://teamhub.example.test/v0/events?room=room-2%3A7",
    );
    // A hint committed during the swap still arrives on the old stream.
    sources[0]!.dispatch("resource.invalidated", agentsHint());
    expect(sources[0]!.close).not.toHaveBeenCalled();

    sources[1]!.dispatch("stream.resync", { reason: "connected" });
    await vi.waitFor(() => expect(sources[0]!.close).toHaveBeenCalledOnce());
    expect(second.statuses.at(-1)).toBe("connected");
    expect(signals.map((signal) => signal.type)).toEqual([
      "stream.resync",
      "resource.invalidated",
    ]);
  });

  it("replays a Room again for a subscriber that joins behind the stream", async () => {
    const { signals, sources, transport } = setup();
    transport.subscribeSignals((signal) => signals.push(signal));
    const first = roomSubscriber("room-1", 0);
    transport.subscribeRoom(first.input);
    await vi.waitFor(() => expect(sources).toHaveLength(1));
    sources[0]!.dispatch("stream.resync", { reason: "connected" });
    sources[0]!.dispatch("room.event", roomEvent("room-1", 1));
    await vi.waitFor(() => expect(first.applied).toEqual([1]));

    const second = roomSubscriber("room-1", 0);
    transport.subscribeRoom(second.input);

    await vi.waitFor(() => expect(sources).toHaveLength(2));
    expect(sources[1]!.url).toContain("room=room-1%3A0");
    sources[1]!.dispatch("room.event", roomEvent("room-1", 1));
    sources[1]!.dispatch("stream.resync", { reason: "connected" });
    await vi.waitFor(() => expect(sources[0]!.close).toHaveBeenCalledOnce());
    expect(first.applied).toEqual([1]);
    expect(second.applied).toEqual([1]);
    expect(
      signals.filter((signal) => signal.type === "stream.resync"),
    ).toHaveLength(1);
  });

  it("reconnects with the applied cursor after a failure and resyncs once", async () => {
    const { signals, sources, transport } = setup();
    transport.subscribeSignals((signal) => signals.push(signal));
    const room = roomSubscriber("room-1", 0);
    transport.subscribeRoom(room.input);
    await vi.waitFor(() => expect(sources).toHaveLength(1));
    sources[0]!.dispatch("stream.resync", { reason: "connected" });
    sources[0]!.dispatch("room.event", roomEvent("room-1", 1));
    await vi.waitFor(() => expect(room.applied).toEqual([1]));

    sources[0]!.dispatch("error", {});
    await vi.waitFor(() => expect(sources).toHaveLength(2));
    expect(room.statuses).toContain("reconnecting");
    expect(sources[1]!.url).toBe(
      "https://teamhub.example.test/v0/events?room=room-1%3A1",
    );
    sources[1]!.dispatch("stream.resync", { reason: "connected" });

    await vi.waitFor(() => expect(room.statuses.at(-1)).toBe("connected"));
    expect(
      signals.filter((signal) => signal.type === "stream.resync"),
    ).toHaveLength(2);
  });

  it("reconnects from the subscriber's cursor on a Room sequence gap", async () => {
    const { sources, transport } = setup();
    const room = roomSubscriber("room-1", 3);
    transport.subscribeRoom(room.input);
    await vi.waitFor(() => expect(sources).toHaveLength(1));

    sources[0]!.dispatch("room.event", roomEvent("room-1", 5));

    await vi.waitFor(() => expect(sources).toHaveLength(2));
    expect(room.applied).toEqual([]);
    expect(room.errors[0]?.message).toMatch(/sequence gap/);
    expect(sources[1]!.url).toContain("room=room-1%3A3");
  });

  it("tells a cursor Room about its hint and forwards every hint", async () => {
    const { signals, sources, transport } = setup();
    transport.subscribeSignals((signal) => signals.push(signal));
    const room = roomSubscriber("room-1", 0);
    transport.subscribeRoom(room.input);
    await vi.waitFor(() => expect(sources).toHaveLength(1));

    sources[0]!.dispatch("resource.invalidated", roomHint("room-1"));
    sources[0]!.dispatch("resource.invalidated", roomHint("room-other"));
    sources[0]!.dispatch("resource.invalidated", {
      id: "tenant-1",
      resource: "a-future-resource",
      tenant_id: "tenant-1",
    });

    await vi.waitFor(() => expect(signals).toHaveLength(2));
    expect(room.invalidated).toHaveBeenCalledOnce();
    expect(sources).toHaveLength(1);
  });

  it("stops for good when the Session expires", async () => {
    const onSessionExpired = vi.fn();
    const { sources, transport } = setup({ onSessionExpired });
    transport.subscribeSignals(() => undefined);
    await vi.waitFor(() => expect(sources).toHaveLength(1));

    sources[0]!.dispatch("session.expired", {});

    expect(onSessionExpired).toHaveBeenCalledWith("session-expired");
    expect(sources[0]!.close).toHaveBeenCalledOnce();
    sources[0]!.dispatch("error", {});
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sources).toHaveLength(1);
  });

  it("releases the stream while the page is inactive and resyncs on return", async () => {
    const pageActivity = new FakePageActivity(true);
    const { signals, sources, transport } = setup({ pageActivity });
    transport.subscribeSignals((signal) => signals.push(signal));
    await vi.waitFor(() => expect(sources).toHaveLength(1));
    sources[0]!.dispatch("stream.resync", { reason: "connected" });
    await vi.waitFor(() => expect(signals).toHaveLength(1));

    pageActivity.setActive(false);
    expect(sources[0]!.close).toHaveBeenCalledOnce();
    pageActivity.setActive(true);
    await vi.waitFor(() => expect(sources).toHaveLength(2));
    sources[1]!.dispatch("stream.resync", { reason: "connected" });

    await vi.waitFor(() =>
      expect(
        signals.filter((signal) => signal.type === "stream.resync"),
      ).toHaveLength(2),
    );
  });
});

function setup(
  options: {
    onSessionExpired?: () => void;
    pageActivity?: FakePageActivity;
  } = {},
) {
  const sources: FakeEventSource[] = [];
  const signals: TeamHubEventSignal[] = [];
  const transport = createTeamHubEventTransport({
    baseUrl: "https://teamhub.example.test/",
    eventSourceFactory: (url) => {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source;
    },
    network: { isOnline: () => true, subscribeOnline: () => () => undefined },
    onSessionExpired: options.onSessionExpired ?? vi.fn(),
    pageActivity: options.pageActivity,
    random: () => 0,
    reconnectDelayMs: 1,
  });
  return { signals, sources, transport };
}

function roomSubscriber(roomId: string, initialRoomSeq: number) {
  let lastApplied = initialRoomSeq;
  const applied: number[] = [];
  const errors: Error[] = [];
  const statuses: RoomRealtimeStatus[] = [];
  const invalidated = vi.fn();
  const input: RoomRealtimeSubscription = {
    applyEvent: (event) => {
      applied.push(event.room_seq);
      lastApplied = event.room_seq;
    },
    getLastAppliedRoomSeq: () => lastApplied,
    onError: (error) => errors.push(error),
    onRoomInvalidated: invalidated,
    onStatusChange: (status) => statuses.push(status),
    roomId,
  };
  return { applied, errors, input, invalidated, statuses };
}

function roomEvent(roomId: string, roomSeq: number): TeamHubRoomEvent {
  return {
    event_id: `event-${roomId}-${roomSeq}`,
    event_type: "message.hidden",
    occurred_at: "2026-11-03T10:00:00Z",
    payload: { kind: "message.hidden" },
    room_id: roomId,
    room_seq: roomSeq,
    tenant_id: "tenant-1",
  };
}

function roomHint(roomId: string) {
  return { id: roomId, resource: "room", room_seq: 9, tenant_id: "tenant-1" };
}

function agentsHint() {
  return { id: "tenant-1", resource: "agents", tenant_id: "tenant-1" };
}

class FakeEventSource {
  readonly close = vi.fn();
  private readonly listeners = new Map<
    string,
    Array<(event: MessageEvent) => void>
  >();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string, data: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) } as MessageEvent);
    }
  }
}

class FakePageActivity {
  private readonly listeners = new Set<(active: boolean) => void>();

  constructor(private active: boolean) {}

  isActive = () => this.active;

  setActive(active: boolean) {
    this.active = active;
    for (const listener of this.listeners) listener(active);
  }

  subscribe = (listener: (active: boolean) => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}
