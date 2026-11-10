import { afterEach, describe, expect, it, vi } from "vitest";
import { watchJob } from "./api.js";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("installation job event stream", () => {
  it("resumes from the last sequence after a disconnect, ignores duplicates, and handles split CRLF and snapshots", async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    const controller = new AbortController();
    const received: number[] = [];
    const heartbeat = vi.fn();
    const fetchMock = vi.fn(async (_url: string, _options?: RequestInit) => {
      void _url;
      void _options;
      const second = fetchMock.mock.calls.length > 1;
      const frames = second
        ? [
            'data: {"jobId":"job","sequence":8,"kind":"snapshot","message":"restored"}\n\n',
          ]
        : [
            ": heartbeat\r",
            '\n\r\ndata: {"jobId":"job","sequence":4,"kind":"log","message":"duplicate"}\r\n\r\ndata: {"jobId":"job","sequence":6,"kind":"log","message":"update"}\r',
            "\n\r\n",
          ];
      return new Response(
        new ReadableStream({
          start(stream) {
            for (const frame of frames) stream.enqueue(encoder.encode(frame));
            stream.close();
          },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const watched = watchJob(
      "job",
      4,
      controller.signal,
      (event) => {
        received.push(event.sequence);
        if (event.sequence === 8) controller.abort();
      },
      vi.fn(),
      heartbeat,
    );
    await vi.advanceTimersByTimeAsync(1600);
    await watched;
    expect(received).toEqual([6, 8]);
    expect(heartbeat).toHaveBeenCalled();
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { "Last-Event-ID": "4" },
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: { "Last-Event-ID": "6" },
    });
    expect(
      fetchMock.mock.calls.every(([url]) => !String(url).includes("cancel")),
    ).toBe(true);
  });
});
