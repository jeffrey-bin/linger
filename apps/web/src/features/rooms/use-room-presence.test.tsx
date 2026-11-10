import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createHttpTeamHubClient } from "@/features/teamhub/teamhub-client";
import {
  teamHubErrorResponse,
  TeamHubTestServer,
  type TestRouteHandler,
} from "@/test/teamhub-test-server";
import {
  PRESENCE_ACTIVITY_WINDOW_MS,
  PRESENCE_FIRST_HINT_DWELL_MS,
  PRESENCE_HEARTBEAT_MS,
  useRoomPresence,
} from "./use-room-presence";

function presenceClient(respond: TestRouteHandler = () => undefined) {
  const server = new TeamHubTestServer();
  server.on("POST", "/v0/rooms/{roomId}/presence", respond);
  const client = createHttpTeamHubClient({
    fetchRequest: server.fetch,
    onAuthenticationRequired: () => undefined,
  });
  const hintedRooms = () =>
    server
      .requestsTo("POST", "/v0/rooms/{roomId}/presence")
      .map((request) => new URL(request.url).pathname.split("/")[3]);
  return { client, hintedRooms };
}

describe("useRoomPresence", () => {
  let visibility: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("visible");
  });

  afterEach(() => {
    visibility.mockRestore();
    vi.useRealTimers();
  });

  it("reports the opened Room once after the dwell and ignores unrelated rerenders", () => {
    const { client, hintedRooms } = presenceClient();
    const { rerender, unmount } = renderHook(
      ({ roomId }) => useRoomPresence(client, roomId),
      { initialProps: { roomId: "room-a", unrelated: 0 } },
    );
    expect(hintedRooms()).toEqual([]);

    vi.advanceTimersByTime(PRESENCE_FIRST_HINT_DWELL_MS);
    rerender({ roomId: "room-a", unrelated: 1 });
    expect(hintedRooms()).toEqual(["room-a"]);

    rerender({ roomId: "room-b", unrelated: 1 });
    vi.advanceTimersByTime(PRESENCE_FIRST_HINT_DWELL_MS);
    unmount();
    expect(hintedRooms()).toEqual(["room-a", "room-b"]);
  });

  it("keeps the Room usable when the hint fails", async () => {
    const { client, hintedRooms } = presenceClient(() =>
      teamHubErrorResponse(503, "OFFLINE"),
    );
    renderHook(() => useRoomPresence(client, "room-a"));
    vi.advanceTimersByTime(PRESENCE_FIRST_HINT_DWELL_MS);
    await vi.waitFor(() => expect(hintedRooms()).toHaveLength(1));
  });

  it("sends nothing when the Room is left before the dwell elapses", () => {
    const { client, hintedRooms } = presenceClient();
    const { unmount } = renderHook(() => useRoomPresence(client, "room-a"));
    vi.advanceTimersByTime(PRESENCE_FIRST_HINT_DWELL_MS - 1);
    unmount();
    vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS * 3);
    expect(hintedRooms()).toEqual([]);
  });

  it("restarts the dwell for a new Room without hinting the old one", () => {
    const { client, hintedRooms } = presenceClient();
    const { rerender } = renderHook(
      ({ roomId }) => useRoomPresence(client, roomId),
      { initialProps: { roomId: "room-a" } },
    );
    vi.advanceTimersByTime(PRESENCE_FIRST_HINT_DWELL_MS - 1);
    rerender({ roomId: "room-b" });
    vi.advanceTimersByTime(PRESENCE_FIRST_HINT_DWELL_MS - 1);
    expect(hintedRooms()).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(hintedRooms()).toEqual(["room-b"]);
  });

  it("waits for the page to be visible when the dwell expires hidden", () => {
    const { client, hintedRooms } = presenceClient();
    visibility.mockReturnValue("hidden");
    renderHook(() => useRoomPresence(client, "room-a"));
    vi.advanceTimersByTime(PRESENCE_FIRST_HINT_DWELL_MS);
    expect(hintedRooms()).toEqual([]);

    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(hintedRooms()).toEqual(["room-a"]);
  });

  it("does not send on becoming visible while the dwell is still pending", () => {
    const { client, hintedRooms } = presenceClient();
    visibility.mockReturnValue("hidden");
    renderHook(() => useRoomPresence(client, "room-a"));
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(hintedRooms()).toEqual([]);

    vi.advanceTimersByTime(PRESENCE_FIRST_HINT_DWELL_MS);
    expect(hintedRooms()).toHaveLength(1);
  });

  it("sends immediately when typing starts during the dwell, once only", () => {
    const { client, hintedRooms } = presenceClient();
    renderHook(() => useRoomPresence(client, "room-a"));
    const editor = document.createElement("textarea");
    document.body.append(editor);
    try {
      editor.focus();
      expect(hintedRooms()).toHaveLength(1);

      vi.advanceTimersByTime(PRESENCE_FIRST_HINT_DWELL_MS);
      expect(hintedRooms()).toHaveLength(1);
    } finally {
      editor.remove();
    }
  });

  it("reports again when the user starts typing after the resend window", () => {
    const { client, hintedRooms } = presenceClient();
    const { unmount } = renderHook(() => useRoomPresence(client, "room-a"));
    const editor = document.createElement("textarea");
    document.body.append(editor);
    editor.focus();
    expect(hintedRooms()).toHaveLength(1);

    editor.blur();
    vi.advanceTimersByTime(15_000);
    document.body.focus();
    editor.focus();
    expect(hintedRooms()).toHaveLength(2);

    unmount();
    editor.blur();
    vi.advanceTimersByTime(15_000);
    editor.focus();
    expect(hintedRooms()).toHaveLength(2);
    editor.remove();
  });

  it("keeps reporting while the person is active and stops when they leave", () => {
    const { client, hintedRooms } = presenceClient();
    const { unmount } = renderHook(() => useRoomPresence(client, "room-a"));
    // The first hint after the dwell, then one per heartbeat.
    vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS * 3);
    expect(hintedRooms()).toHaveLength(4);

    // A hidden tab sends no presence hints.
    visibility.mockReturnValue("hidden");
    vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS * 3);
    expect(hintedRooms()).toHaveLength(4);

    // A visible but untouched Room stops after the activity window.
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    const afterReturn = hintedRooms().length;
    vi.advanceTimersByTime(
      PRESENCE_ACTIVITY_WINDOW_MS + PRESENCE_HEARTBEAT_MS * 3,
    );
    const settled = hintedRooms().length;
    expect(settled).toBeGreaterThan(afterReturn);
    vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS * 3);
    expect(hintedRooms()).toHaveLength(settled);

    // Any input resumes the heartbeat.
    document.dispatchEvent(new Event("keydown"));
    vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS);
    expect(hintedRooms()).toHaveLength(settled + 1);

    unmount();
    vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS * 3);
    expect(hintedRooms()).toHaveLength(settled + 1);
  });
});
