import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createRunStatusTransport,
  endedRunHoldMs,
} from "./run-status-transport";
import { TeamHubError } from "./teamhub-error";
import type { TeamHubEventSignal } from "./event-transport";
import type {
  TeamHubRoomEvent,
  TeamHubRoomRunStatus,
  TeamHubRunStatus,
} from "./teamhub-types";

describe("Run status transport", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("publishes the Room snapshot, then each newer announcement", async () => {
    const harness = createHarness([run("run-1", 1)]);
    const collections = harness.subscribe();
    await vi.waitFor(() => expect(collections).toHaveLength(1));
    expect(collections[0]!.map(({ id, revision }) => [id, revision])).toEqual([
      ["run-1", 1],
    ]);

    await harness.announce(published("run-1", 3, "active"));
    await harness.announce(published("run-1", 2, "active"));
    await harness.announce(published("run-2", 0, "active"));
    await harness.announce({
      kind: "message.created",
    });

    expect(
      collections.map((items) =>
        items.map(({ id, revision }) => [id, revision]),
      ),
    ).toEqual([
      [["run-1", 1]],
      [["run-1", 3]],
      [
        ["run-1", 3],
        ["run-2", 0],
      ],
    ]);
  });

  it("maps the stop reason and keeps finished Runs until the next snapshot", async () => {
    const harness = createHarness([]);
    const collections = harness.subscribe();
    await vi.waitFor(() => expect(collections).toHaveLength(1));
    await harness.announce({
      ...published("run-1", 4, "aborted"),
      run: {
        ...published("run-1", 4, "aborted").run,
        stop_reason: "task_terminal",
      },
    });
    expect(collections.at(-1)).toEqual([
      expect.objectContaining({
        id: "run-1",
        run_id: "run-1",
        status: "aborted",
        stop_reason: "task_terminal",
      }),
    ]);
  });

  it("holds a succeeded end, then drops the Run like the snapshot", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const harness = createHarness([run("run-1", 1)]);
    const collections = harness.subscribe();
    await vi.waitFor(() => expect(collections).toHaveLength(1));
    await harness.announce(published("run-1", 4, "completed"));
    await harness.announce(published("run-2", 0, "active"));
    vi.advanceTimersByTime(endedRunHoldMs);
    // A late or replayed announcement does not bring the ended Run back.
    await harness.announce(published("run-1", 3, "active"));
    await harness.announce(published("run-1", 4, "completed"));

    expect(
      collections.map((items) => items.map(({ id, status }) => [id, status])),
    ).toEqual([
      [["run-1", "active"]],
      [["run-1", "completed"]],
      [
        ["run-1", "completed"],
        ["run-2", "active"],
      ],
      [["run-2", "active"]],
    ]);
  });

  it("drops a failed Run only after a newer Run of the same Agent", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const harness = createHarness([]);
    const collections = harness.subscribe();
    await vi.waitFor(() => expect(collections).toHaveLength(1));
    await harness.announce(published("run-1", 2, "aborted"));
    await harness.announce(published("other", 0, "active", "actor-other"));
    vi.advanceTimersByTime(endedRunHoldMs);
    await harness.announce(published("run-2", 0, "active"));
    vi.advanceTimersByTime(endedRunHoldMs);

    expect(collections.map((items) => items.map(({ id }) => id))).toEqual([
      [],
      ["run-1"],
      ["run-1", "other"],
      ["run-1", "other", "run-2"],
      ["other", "run-2"],
    ]);
  });

  it("remembers a held end that a snapshot dropped first", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const harness = createHarness([run("run-1", 1)]);
    const collections = harness.subscribe();
    await vi.waitFor(() => expect(collections).toHaveLength(1));
    await harness.announce(published("run-1", 4, "completed"));
    // The resync snapshot omits the succeeded Run during its hold.
    harness.items = [];
    harness.signal({ type: "stream.resync" });
    await vi.waitFor(() => expect(collections).toHaveLength(3));
    vi.advanceTimersByTime(endedRunHoldMs);
    // A replayed older announcement does not bring it back.
    await harness.announce(published("run-1", 3, "active"));

    expect(collections.map((items) => items.map(({ id }) => id))).toEqual([
      ["run-1"],
      ["run-1"],
      [],
    ]);
  });

  it("orders Runs by creation instant, not by timestamp text", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const harness = createHarness([]);
    const collections = harness.subscribe();
    await vi.waitFor(() => expect(collections).toHaveLength(1));
    // Go drops trailing zeros: ".12Z" is earlier than ".123Z" but sorts after.
    await harness.announce(
      published(
        "run-b",
        2,
        "aborted",
        "actor-agent",
        "2026-11-03T10:00:00.123Z",
      ),
    );
    await harness.announce(
      published(
        "run-a",
        1,
        "aborted",
        "actor-agent",
        "2026-11-03T10:00:00.12Z",
      ),
    );
    vi.advanceTimersByTime(endedRunHoldMs);

    expect(collections.at(-1)!.map(({ id }) => id)).toEqual(["run-b"]);
  });

  it("forgets the oldest released Runs past the limit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const harness = createHarness([]);
    const collections = harness.subscribe();
    await vi.waitFor(() => expect(collections).toHaveLength(1));
    for (let index = 0; index <= 256; index += 1)
      await harness.announce(published(`run-${index}`, 1, "completed"));
    vi.advanceTimersByTime(endedRunHoldMs);
    expect(collections.at(-1)).toEqual([]);

    // run-0 fell out of the record; run-1 is still remembered.
    await harness.announce(published("run-0", 1, "completed"));
    await harness.announce(published("run-1", 1, "completed"));
    expect(collections.at(-1)!.map(({ id }) => id)).toEqual(["run-0"]);
  });

  it("stops holding ended Runs once unsubscribed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const harness = createHarness([]);
    const collections: TeamHubRunStatus[][] = [];
    const unsubscribe = harness.transport.subscribe({
      onCollection: (items) => collections.push(items),
      onSessionExpired: vi.fn(),
      roomId: "room-1",
    });
    await vi.waitFor(() => expect(collections).toHaveLength(1));
    await harness.announce(published("run-1", 1, "completed"));
    unsubscribe();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps an end announced during a snapshot read that predates it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let release!: () => void;
    const harness = createHarness([run("run-1", 1)], async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const collections = harness.subscribe();
    await vi.waitFor(() => expect(harness.list).toHaveBeenCalledOnce());
    await harness.announce(published("run-1", 5, "completed"));
    expect(collections.at(-1)).toEqual([
      expect.objectContaining({ id: "run-1", status: "completed" }),
    ]);
    release();
    await vi.waitFor(() => expect(collections).toHaveLength(2));
    expect(collections[1]).toEqual([
      expect.objectContaining({ id: "run-1", status: "completed" }),
    ]);
    vi.advanceTimersByTime(endedRunHoldMs);
    expect(collections.at(-1)).toEqual([]);
  });

  it("lets a newer snapshot revision win over an older announcement", async () => {
    let release!: () => void;
    const harness = createHarness([run("run-1", 7)], async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const collections = harness.subscribe();
    await vi.waitFor(() => expect(harness.list).toHaveBeenCalledOnce());
    await harness.announce(published("run-1", 5, "active"));
    release();
    await vi.waitFor(() => expect(collections).toHaveLength(2));
    expect(collections[1]!.map(({ revision }) => revision)).toEqual([7]);
  });

  it("rereads the snapshot when the event stream resyncs", async () => {
    const harness = createHarness([run("run-1", 1)]);
    const collections = harness.subscribe();
    await vi.waitFor(() => expect(collections).toHaveLength(1));
    harness.items = [];
    harness.signal({ type: "stream.resync" });
    await vi.waitFor(() => expect(collections).toHaveLength(2));
    expect(collections[1]).toEqual([]);
    expect(harness.list).toHaveBeenCalledTimes(2);
  });

  it("retries a failed resync read until the ended Run shows", async () => {
    vi.useFakeTimers();
    try {
      let failNext = false;
      const harness = createHarness([run("run-1", 1)], async () => {
        if (failNext) {
          failNext = false;
          throw new Error("network down");
        }
      });
      const onError = vi.fn();
      const collections = harness.subscribe({ onError });
      await vi.waitFor(() => expect(collections).toHaveLength(1));
      harness.items = [{ ...run("run-1", 2), status: "completed" }];
      failNext = true;
      harness.signal({ type: "stream.resync" });
      await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
      expect(collections).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(collections).toHaveLength(2));
      expect(collections[1]).toEqual([
        expect.objectContaining({ id: "run-1", status: "completed" }),
      ]);
      expect(harness.list).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an announcement that is newer than an in-flight snapshot", async () => {
    let release!: () => void;
    const harness = createHarness([run("run-1", 1)], async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const collections = harness.subscribe();
    await vi.waitFor(() => expect(harness.list).toHaveBeenCalledOnce());
    await harness.announce(published("run-1", 5, "active"));
    release();
    await vi.waitFor(() => expect(collections.at(-1)?.[0]?.revision).toBe(5));
  });

  it("rereads the snapshot when a Room it does not follow by cursor changes", async () => {
    const harness = createHarness([run("run-1", 1)]);
    const collections = harness.subscribe();
    await vi.waitFor(() => expect(collections).toHaveLength(1));
    await harness.announce({ kind: "message.created" });
    harness.signal({
      hint: {
        id: "room-1",
        resource: "room",
        room_seq: 1,
        tenant_id: "tenant-1",
      },
      type: "resource.invalidated",
    });
    expect(harness.list).toHaveBeenCalledOnce();
    harness.items = [];
    harness.signal({
      hint: {
        id: "room-1",
        resource: "room",
        room_seq: 2,
        tenant_id: "tenant-1",
      },
      type: "resource.invalidated",
    });
    await vi.waitFor(() => expect(collections).toHaveLength(2));
    expect(collections[1]).toEqual([]);
  });

  it("ignores announcements of other Rooms", async () => {
    const harness = createHarness([]);
    const collections = harness.subscribe();
    await vi.waitFor(() => expect(collections).toHaveLength(1));
    await harness.announce(published("run-1", 1, "active"), "room-2");
    expect(collections).toHaveLength(1);
  });

  it("reports an expired session and malformed announcements", async () => {
    const onSessionExpired = vi.fn();
    const onError = vi.fn();
    const expired = createHarness([], async () => {
      throw new TeamHubError({
        code: "UNAUTHENTICATED",
        message: "Session expired",
        status: 401,
      });
    });
    expired.subscribe({ onSessionExpired });
    await vi.waitFor(() =>
      expect(onSessionExpired).toHaveBeenCalledWith("session-expired"),
    );

    const malformed = createHarness([]);
    malformed.subscribe({ onError });
    await malformed.announce({
      kind: "agent_run.status_changed",
      run: { run_id: "run-1", room_id: "other-room" },
    });
    expect(onError).toHaveBeenCalledOnce();
  });
});

function run(id: string, revision: number): TeamHubRunStatus {
  return {
    agent: { display_name: "Codex", id: "actor-agent", kind: "agent" },
    created_at: "2026-11-03T10:00:00Z",
    id,
    replied: false,
    revision,
    room_id: "room-1",
    run_id: id,
    status: "active",
    updated_at: "2026-11-03T10:00:00Z",
  };
}

function published(
  id: string,
  ordinal: number,
  status: TeamHubRoomRunStatus["status"],
  agentId = "actor-agent",
  createdAt = "2026-11-03T10:00:00Z",
): { kind: string; run: TeamHubRoomRunStatus } {
  return {
    kind: "agent_run.status_changed",
    run: {
      agent: { display_name: "Codex", id: agentId, kind: "agent" },
      created_at: createdAt,
      event_ordinal: ordinal,
      replied: false,
      room_id: "room-1",
      run_id: id,
      status,
      updated_at: "2026-11-03T10:00:01Z",
    },
  };
}

function createHarness(
  initial: TeamHubRunStatus[],
  beforeList: () => Promise<void> = async () => undefined,
) {
  const signalListeners = new Set<(signal: TeamHubEventSignal) => void>();
  const harness = {
    items: initial,
    list: vi.fn(async () => {
      await beforeList();
      return { items: harness.items };
    }),
    async announce(
      payload: { kind: string; [key: string]: unknown },
      roomId = "room-1",
    ) {
      harness.signal({
        event: {
          event_id: "event-1",
          event_type: payload.kind,
          occurred_at: "2026-11-03T10:00:01Z",
          payload,
          room_id: roomId,
          room_seq: 1,
          tenant_id: "tenant-1",
        } as TeamHubRoomEvent,
        type: "room.event",
      });
      await Promise.resolve();
    },
    signal(signal: TeamHubEventSignal) {
      for (const listener of signalListeners) listener(signal);
    },
    subscribe(
      handlers: {
        onError?: (error: Error) => void;
        onSessionExpired?: (reason: "session-expired") => void;
      } = {},
    ) {
      const collections: TeamHubRunStatus[][] = [];
      transport.subscribe({
        onCollection: (items) => collections.push(items),
        onError: handlers.onError,
        onSessionExpired: handlers.onSessionExpired ?? vi.fn(),
        roomId: "room-1",
      });
      return collections;
    },
  };
  const transport = createRunStatusTransport({
    client: { listRoomRunStatuses: harness.list },
    events: {
      subscribeSignals(listener) {
        signalListeners.add(listener);
        return () => signalListeners.delete(listener);
      },
    },
  });
  return Object.assign(harness, { transport });
}
