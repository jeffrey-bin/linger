import { afterEach, describe, expect, it, vi } from "vitest";
import {
  teamHubErrorResponse,
  TeamHubTestServer,
} from "@/test/teamhub-test-server";
import { createHttpTeamHubClient } from "./teamhub-client";
import { TeamHubError } from "./teamhub-error";
import { createVoiceEventTransport } from "./voice-event-transport";
import type { TeamHubVoiceEventPage } from "./teamhub-types";

class Source {
  listeners = new Map<string, ((event: MessageEvent) => void)[]>();
  close = vi.fn();
  constructor(readonly url: string) {}
  addEventListener(name: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  emit(name: string, data: unknown = {}) {
    for (const listener of this.listeners.get(name) ?? [])
      listener({ data: JSON.stringify(data) } as MessageEvent);
  }
}
const empty = (cursor = "voice:0"): TeamHubVoiceEventPage => ({
  items: [],
  next_cursor: cursor,
  has_more: false,
});
const change = (position: number, hasMore = false): TeamHubVoiceEventPage => ({
  items: [{ kind: "transcript" }],
  next_cursor: `voice:${position}`,
  has_more: hasMore,
});
function setup(
  snapshot = "voice:0",
  prepare?: (client: {
    listVoiceTranscriptEvents: ReturnType<typeof vi.fn>;
    listVoiceEvents: ReturnType<typeof vi.fn>;
  }) => void,
  random = () => 1,
) {
  vi.useFakeTimers();
  const sources: Source[] = [];
  const client = {
    listVoiceTranscriptEvents: vi
      .fn()
      .mockResolvedValue({ items: [], event_cursor: snapshot }),
    listVoiceEvents: vi
      .fn()
      .mockImplementation((_id, cursor) => Promise.resolve(empty(cursor))),
  };
  prepare?.(client);
  const server = new TeamHubTestServer()
    .on(
      "GET",
      "/v0/voice-sessions/{voiceSessionId}/transcript-events",
      ({ params, query, request }) => {
        const id = query.get("after_id");
        const updatedAt = query.get("after_updated_at");
        return answer(() =>
          client.listVoiceTranscriptEvents(
            params.voiceSessionId,
            id && updatedAt ? { id, updatedAt } : undefined,
            { signal: request.signal },
          ),
        );
      },
    )
    .on(
      "GET",
      "/v0/voice-sessions/{voiceSessionId}/events",
      ({ params, query, request }) =>
        answer(() =>
          client.listVoiceEvents(
            params.voiceSessionId,
            query.get("after") ?? undefined,
            { signal: request.signal },
          ),
        ),
    );
  const { api } = createHttpTeamHubClient({
    baseUrl: "https://voice.test",
    fetchRequest: server.fetch,
    onAuthenticationRequired: () => undefined,
  });
  const input = {
    voiceSessionId: "voice",
    onEvents: vi.fn(),
    onTranscriptPage: vi.fn(),
    onMode: vi.fn(),
    onAccessLost: vi.fn(),
  };
  const transport = createVoiceEventTransport({
    client: { api },
    baseUrl: "https://voice.test/api",
    random,
    eventSourceFactory: (url, init) => {
      expect(init.withCredentials).toBe(true);
      const source = new Source(url);
      sources.push(source);
      return source;
    },
  });
  const close = transport.subscribe(input);
  return { sources, client, input, close, transport };
}
// The read doubles record each request as the transport's reads; a TeamHub
// error they reject with is answered as its error envelope.
async function answer(read: () => Promise<unknown>) {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof TeamHubError)) throw error;
    return teamHubErrorResponse(error.status, error.code, error.message);
  }
}
afterEach(() => {
  vi.useRealTimers();
});

describe("voice SSE and HTTP recovery", () => {
  it("bootstraps the transcript once and starts the feed at its snapshot cursor", async () => {
    const { client, sources, input, close } = setup("voice:1");
    await vi.advanceTimersByTimeAsync(0);
    expect(input.onTranscriptPage).toHaveBeenCalledWith({
      items: [],
      event_cursor: "voice:1",
    });
    expect(client.listVoiceEvents).not.toHaveBeenCalled();
    const url = new URL(sources[0]!.url);
    expect(url.pathname).toBe("/api/v0/voice-sessions/voice/events/stream");
    expect(url.searchParams.get("after")).toBe("voice:1");
    sources[0]!.emit("voice.events", change(1));
    sources[0]!.emit("voice.events", change(2));
    sources[0]!.emit("voice.events", change(1));
    sources[0]!.emit("voice.ready");
    expect(input.onEvents.mock.calls.map(([page]) => page.next_cursor)).toEqual(
      ["voice:1", "voice:2"],
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.listVoiceTranscriptEvents).toHaveBeenCalledTimes(1);
    expect(client.listVoiceEvents).not.toHaveBeenCalled();
    expect(input.onMode).toHaveBeenLastCalledWith("sse");
    close();
    expect(sources[0]!.close).toHaveBeenCalledTimes(1);
  });

  it("skips a voice event kind it does not know and still advances the cursor", async () => {
    const { client, sources, input, close } = setup();
    await vi.advanceTimersByTimeAsync(0);
    sources[0]!.emit("voice.events", {
      items: [
        { kind: "capture", cursor: "voice:1" },
        { kind: "future_kind", cursor: "voice:2" },
      ],
      next_cursor: "voice:2",
      has_more: false,
    });
    sources[0]!.emit("voice.ready");
    expect(input.onEvents).toHaveBeenCalledTimes(1);
    expect(input.onEvents.mock.calls[0]![0].items).toEqual([
      { kind: "capture", cursor: "voice:1" },
    ]);
    expect(input.onMode).toHaveBeenLastCalledWith("sse");
    client.listVoiceEvents.mockResolvedValueOnce(empty("voice:2"));
    sources[0]!.emit("error");
    await vi.advanceTimersByTimeAsync(0);
    expect(client.listVoiceEvents).toHaveBeenLastCalledWith(
      "voice",
      "voice:2",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    close();
  });

  it("falls back on disconnect, reads only the event feed, then reconnects without accepting old source events", async () => {
    const { client, sources, input, close } = setup();
    await vi.advanceTimersByTimeAsync(0);
    sources[0]!.emit("voice.events", change(2));
    sources[0]!.emit("voice.ready");
    client.listVoiceEvents.mockResolvedValueOnce(change(3));
    sources[0]!.emit("error");
    sources[0]!.emit("voice.events", change(99));
    await vi.advanceTimersByTimeAsync(0);
    expect(client.listVoiceEvents).toHaveBeenLastCalledWith(
      "voice",
      "voice:2",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(input.onEvents.mock.calls.map(([page]) => page.next_cursor)).toEqual(
      ["voice:2", "voice:3"],
    );
    await vi.advanceTimersByTimeAsync(5_000);
    // The transcript is never paged again.
    expect(client.listVoiceTranscriptEvents).toHaveBeenCalledTimes(1);
    expect(sources).toHaveLength(2);
    expect(new URL(sources[1]!.url).searchParams.get("after")).toBe("voice:3");
    sources[1]!.emit("voice.ready");
    const reads = client.listVoiceEvents.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(client.listVoiceEvents).toHaveBeenCalledTimes(reads);
    close();
  });

  it("does not advance the transcript cursor for partial snapshots, and recovers a silent stream", async () => {
    const { sources, input, client, close } = setup();
    await vi.advanceTimersByTimeAsync(0);
    sources[0]!.emit("voice.events", change(8));
    sources[0]!.emit("voice.ready");
    for (let n = 0; n < 50; n++)
      sources[0]!.emit("voice.partial", {
        items: [],
        partial_transcript: `latest ${n}`,
      });
    expect(input.onTranscriptPage).toHaveBeenLastCalledWith({
      items: [],
      partial_transcript: "latest 49",
    });
    sources[0]!.emit("voice.partial", { items: [] });
    await vi.advanceTimersByTimeAsync(15_001);
    expect(sources[0]!.close).toHaveBeenCalledTimes(1);
    expect(client.listVoiceEvents).toHaveBeenLastCalledWith(
      "voice",
      "voice:8",
      expect.anything(),
    );
    close();
  });

  it("cleans pending reads on identity replacement and terminates on permission loss", async () => {
    const { client, sources, input, close, transport } = setup();
    await vi.advanceTimersByTimeAsync(0);
    close();
    const next = {
      ...input,
      voiceSessionId: "next",
      onTranscriptPage: vi.fn(),
      onEvents: vi.fn(),
    };
    client.listVoiceTranscriptEvents.mockResolvedValue({
      items: [],
      event_cursor: "next:0",
    });
    const stopNext = transport.subscribe(next);
    await vi.advanceTimersByTimeAsync(0);
    sources[0]!.emit("voice.events", change(2));
    expect(next.onEvents).not.toHaveBeenCalled();
    sources[1]!.emit("access.revoked");
    expect(next.onAccessLost).toHaveBeenCalledTimes(1);
    const reads = client.listVoiceTranscriptEvents.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.listVoiceTranscriptEvents).toHaveBeenCalledTimes(reads);
    stopNext();
  });

  it("uses HTTP when SSE cannot flush its first frame and when the feed temporarily fails", async () => {
    const { sources, input, client, close } = setup();
    await vi.advanceTimersByTimeAsync(0);
    client.listVoiceEvents.mockRejectedValueOnce(new TypeError("offline"));
    await vi.advanceTimersByTimeAsync(3_001);
    expect(input.onMode).toHaveBeenLastCalledWith("recovering");
    expect(sources[0]!.close).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(input.onMode).toHaveBeenLastCalledWith("polling");
    close();
  });

  it("retries a failed bootstrap and treats a missing feed as lost access", async () => {
    const { sources, input, client, close } = setup("voice:0", (client) =>
      client.listVoiceTranscriptEvents.mockRejectedValueOnce(
        new TypeError("offline"),
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(input.onMode).toHaveBeenLastCalledWith("recovering");
    expect(sources).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(client.listVoiceTranscriptEvents).toHaveBeenCalledTimes(2);
    expect(sources).toHaveLength(1);
    client.listVoiceEvents.mockRejectedValueOnce(
      new TeamHubError({ code: "NOT_FOUND", message: "gone", status: 404 }),
    );
    sources[0]!.emit("error");
    await vi.advanceTimersByTimeAsync(0);
    expect(input.onAccessLost).toHaveBeenCalledOnce();
    close();
  });

  it("retries with the shared jittered backoff", async () => {
    const { client, close } = setup(
      "voice:0",
      (client) =>
        client.listVoiceTranscriptEvents
          .mockRejectedValueOnce(new TypeError("offline"))
          .mockRejectedValueOnce(new TypeError("offline")),
      () => 0,
    );
    await vi.advanceTimersByTimeAsync(249);
    expect(client.listVoiceTranscriptEvents).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.listVoiceTranscriptEvents).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(499);
    expect(client.listVoiceTranscriptEvents).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.listVoiceTranscriptEvents).toHaveBeenCalledTimes(3);
    close();
  });

  it("delivers a repeated session or Capture snapshot only when it changed, never an older one", async () => {
    const { client, input, close } = setup("voice:4");
    const snapshot = (
      status: string,
      updatedAt = status === "recording"
        ? "2026-01-01T00:00:01Z"
        : "2026-01-01T00:00:02Z",
    ): TeamHubVoiceEventPage => ({
      items: [
        {
          kind: "capture",
          capture: { id: "capture", status, updated_at: updatedAt },
        } as TeamHubVoiceEventPage["items"][number],
        {
          kind: "session",
          session: {
            id: "voice",
            status: "connected",
            updated_at: "2026-01-01T00:00:00Z",
          },
        } as TeamHubVoiceEventPage["items"][number],
      ],
      next_cursor: "voice:4",
      has_more: false,
    });
    client.listVoiceEvents
      .mockResolvedValueOnce(snapshot("recording"))
      .mockResolvedValueOnce(snapshot("recording"))
      .mockResolvedValueOnce(snapshot("finalizing"))
      // A catch-up read before the finalizing page that resolves after it.
      .mockResolvedValueOnce(snapshot("recording"));
    for (let read = 0; read < 4; read++)
      await close.catchUp(new AbortController().signal);
    expect(
      input.onEvents.mock.calls.map(([page]) =>
        page.items.map(
          (item: TeamHubVoiceEventPage["items"][number]) =>
            item.capture?.status ?? item.session?.status,
        ),
      ),
    ).toEqual([["recording", "connected"], ["finalizing"]]);
    close();
  });

  it("catches up every page after the cursor on request", async () => {
    const { client, input, close } = setup("voice:4");
    client.listVoiceEvents
      .mockResolvedValueOnce(change(5, true))
      .mockResolvedValueOnce(change(6));
    await close.catchUp(new AbortController().signal);
    expect(client.listVoiceEvents).toHaveBeenNthCalledWith(
      1,
      "voice",
      "voice:4",
      expect.anything(),
    );
    expect(input.onEvents.mock.calls.map(([page]) => page.next_cursor)).toEqual(
      ["voice:5", "voice:6"],
    );
    close();
    await expect(
      close.catchUp(new AbortController().signal),
    ).rejects.toBeDefined();
  });
});
