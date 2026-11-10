// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  TeamHubTestServer,
  type TestRouteRequest,
} from "@/test/teamhub-test-server";

import {
  createBrowserRealtimeActivity,
  createBrowserTeamHubRuntime,
  resolveDocumentRuntimeUrl,
} from "./browser-teamhub-runtime";

describe("browser TeamHub runtime", () => {
  it("uses the same-origin Document Runtime", () => {
    const runtime = createBrowserTeamHubRuntime();

    expect(runtime.documentRuntimeUrl).toMatch(
      /^ws:\/\/localhost(?::\d+)?\/document-collaboration$/,
    );
  });
});

describe("Browser realtime activity", () => {
  it("keeps the realtime owner across transient window blur and focus", () => {
    const activity = createBrowserRealtimeActivity({ lockManager: undefined });
    const listener = vi.fn();
    activity.subscribe(listener);

    globalThis.dispatchEvent(new Event("blur"));
    globalThis.dispatchEvent(new Event("focus"));

    expect(activity.isActive()).toBe(true);
    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps both transports on only the most recently active tab", async () => {
    const locks = new FakeRealtimeLockNetwork();
    const firstAttention = new FakeRealtimePageAttention(true);
    const secondAttention = new FakeRealtimePageAttention(true);
    const first = createBrowserRealtimeActivity({
      attention: firstAttention,
      lockManager: locks.createManager(),
    });
    const firstAccount = vi.fn();
    const firstDraft = vi.fn();
    first.subscribe(firstAccount);
    first.subscribe(firstDraft);
    expect(first.isActive()).toBe(true);

    const second = createBrowserRealtimeActivity({
      attention: secondAttention,
      lockManager: locks.createManager(),
    });
    await vi.waitFor(() => expect(first.isActive()).toBe(false));
    expect(second.isActive()).toBe(true);
    expect(firstAccount).toHaveBeenCalledWith(false);
    expect(firstDraft).toHaveBeenCalledWith(false);

    firstAttention.signal(true);
    expect(first.isActive()).toBe(true);
    await vi.waitFor(() => expect(second.isActive()).toBe(false));
  });
});

describe("resolveDocumentRuntimeUrl", () => {
  it("uses one same-origin WebSocket path", () => {
    expect(
      resolveDocumentRuntimeUrl(
        new URL("https://workspace.example.test/rooms/one"),
      ),
    ).toBe("wss://workspace.example.test/document-collaboration");
    expect(
      resolveDocumentRuntimeUrl(new URL("http://10.0.0.5:31405/rooms")),
    ).toBe("ws://10.0.0.5:31405/document-collaboration");
  });
});

class FakeRealtimeLockNetwork {
  private holder?: { reject: (error: Error) => void };

  createManager() {
    return {
      request: (
        _name: string,
        _options: { mode: "exclusive"; steal: true },
        callback: () => Promise<void>,
      ) => {
        this.holder?.reject(new DOMException("Lock stolen", "AbortError"));
        let holder: { reject: (error: Error) => void };
        const request = new Promise<void>((resolve, reject) => {
          holder = { reject };
          this.holder = holder;
          void callback().then(() => {
            if (this.holder === holder) this.holder = undefined;
            resolve();
          }, reject);
        });
        return request;
      },
    };
  }
}

class FakeRealtimePageAttention {
  private readonly listeners = new Set<(foreground: boolean) => void>();

  constructor(private foreground: boolean) {}

  isForeground = () => this.foreground;

  signal(foreground: boolean) {
    this.foreground = foreground;
    for (const listener of this.listeners) listener(foreground);
  }

  subscribe = (listener: (foreground: boolean) => void) => {
    this.listeners.add(listener);
  };
}

it("does not open a lazy voice subscription after cleanup and aborts the active one", async () => {
  let signal: AbortSignal | undefined;
  const read = vi.fn(({ request }: TestRouteRequest) => {
    signal = request.signal;
    return new Promise(() => {});
  });
  const server = new TeamHubTestServer().on(
    "GET",
    "/v0/voice-sessions/{voiceSessionId}/transcript-events",
    read,
  );
  vi.stubGlobal("fetch", server.fetch);
  const runtime = createBrowserTeamHubRuntime();
  const input = {
    voiceSessionId: "voice_test",
    onEvents: vi.fn(),
    onTranscriptPage: vi.fn(),
    onMode: vi.fn(),
    onAccessLost: vi.fn(),
  };
  const cancelled = runtime.voiceEvents!.subscribe(input);
  cancelled();
  await vi.dynamicImportSettled();
  expect(read).not.toHaveBeenCalled();
  const active = runtime.voiceEvents!.subscribe(input);
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  active();
  expect(signal?.aborted).toBe(true);
  vi.unstubAllGlobals();
});
