import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestTeamHubRuntime,
  type TestTeamHubRuntime,
} from "@/test/teamhub-test-runtime";
import {
  teamHubErrorResponse,
  type TestRouteHandler,
  type TestRouteRequest,
} from "@/test/teamhub-test-server";
import { acceptVoice } from "@/test/teamhub-voice-routes";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubVoiceCapture,
  TeamHubVoiceSession,
  TeamHubVoiceTranscriptEvent,
} from "@/features/teamhub/teamhub-types";
import { LiveKitVoiceControlProvider } from "@/features/rooms/voice-control/voice-control-provider";
import { useVoiceControl } from "@/features/rooms/voice-control/voice-control-context";
import { VoiceFocusSurface } from "@/features/rooms/voice-control/voice-focus-surface";
import type { VoiceEventSubscription } from "@/features/teamhub/voice-event-transport";
import { teamHubData } from "@/features/teamhub/teamhub-api";

const media = vi.hoisted(() => ({ publish: vi.fn(), stop: vi.fn() }));
vi.mock("livekit-client", () => ({
  RoomEvent: {
    Reconnecting: "reconnecting",
    Reconnected: "reconnected",
    Disconnected: "disconnected",
    MediaDevicesError: "device-error",
  },
  Track: { Source: { Microphone: "microphone" } },
  createLocalAudioTrack: async () => ({
    stop: media.stop,
    mediaStreamTrack: Object.assign(new EventTarget(), {
      getSettings: () => ({ deviceId: "microphone" }),
    }),
  }),
  Room: class {
    localParticipant = {
      publishTrack: media.publish,
      unpublishTrack: async () => undefined,
    };
    on() {}
    async connect() {}
    async disconnect() {}
  },
}));

// Leaves a request pending until its caller aborts it.
const hold = ({ request }: TestRouteRequest) =>
  new Promise<never>((_resolve, reject) => {
    request.signal.addEventListener(
      "abort",
      () =>
        reject(
          request.signal.reason ?? new DOMException("Aborted", "AbortError"),
        ),
      { once: true },
    );
  });
// Reads what an accepted voice route answered, as the client would.
const answerOf = async <T,>(answer: unknown) =>
  (answer instanceof Response ? await answer.clone().json() : answer) as T;
const idempotencyKey = ({ request }: TestRouteRequest) =>
  request.headers.get("Idempotency-Key");
const credentialRequests = (runtime: TestTeamHubRuntime) =>
  runtime.server.requestsTo(
    "POST",
    "/v0/voice-sessions/{voiceSessionId}/connection-credentials",
  );
const advance = async (ms = 0) => {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
};

function Probe() {
  const voice = useVoiceControl();
  useEffect(() => {
    void (voice.enable as (automatic: boolean) => Promise<void>)(true).catch(
      () => undefined,
    );
  }, [voice.enable]);
  return (
    <>
      <output aria-label="capture-state">{voice.captureState.status}</output>
      <output aria-label="capture-id">
        {"capture" in voice.captureState ? voice.captureState.capture?.id : ""}
      </output>
      <output aria-label="listener-state">{voice.listenerStatus}</output>
      <output aria-label="feed-state">{voice.transcriptStatus}</output>
      <output aria-label="visible-count">{voice.transcriptItems.length}</output>
      <button onClick={() => void voice.disable()}>Disable voice</button>
      <button onClick={() => void voice.enable()}>Enable voice</button>
      <button onClick={() => void voice.startCapture()}>Start capture</button>
      <VoiceFocusSurface onExit={() => undefined} />
    </>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  localStorage.setItem(
    "linger.voice.device.tenant-northstar",
    JSON.stringify({
      deviceId: "microphone",
      groupId: "desk",
      label: "Fixture",
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function setup(
  configure?: (
    runtime: TestTeamHubRuntime,
    voice: ReturnType<typeof acceptVoice>,
  ) => void,
  expectedListener = "listening",
) {
  const runtime = createTestTeamHubRuntime();
  const voice = acceptVoice(runtime);

  configure?.(runtime, voice);
  render(
    <TeamHubRuntimeProvider runtime={runtime}>
      <MemoryRouter>
        <LiveKitVoiceControlProvider tenantId="tenant-northstar">
          <Probe />
        </LiveKitVoiceControlProvider>
      </MemoryRouter>
    </TeamHubRuntimeProvider>,
  );
  await advance();
  expect(screen.getByLabelText("listener-state")).toHaveTextContent(
    expectedListener,
  );
  return runtime;
}

describe("first partial capture boundaries", () => {
  async function prepareFirstUtterance({ mediaStartDelayMs = 0 } = {}) {
    const feed = {
      items: [] as TeamHubVoiceTranscriptEvent[],
      partial_transcript: "",
      partial_start_offset_ms: 0,
      partial_end_offset_ms: 0 as number | undefined,
    };
    let requestedStart = 0;
    const runtime = await setup((runtime, voice) => {
      const start = voice(
        "POST",
        "/v0/voice-sessions/{voiceSessionId}/captures",
      );
      const read = voice("GET", "/v0/voice-captures/{captureSessionId}");
      const project = async (answer: unknown) => {
        const capture = await answerOf<TeamHubVoiceCapture>(answer);
        const session = await teamHubData(
          runtime.client.api.GET("/v0/rooms/{roomId}/voice-sessions", {
            params: { path: { roomId: capture.room_id } },
          }),
        );
        requestedStart =
          Date.parse(capture.created_at) - Date.parse(session.created_at);
        return {
          ...capture,
          requested_start_offset_ms: requestedStart,
          created_at: new Date(
            Date.parse(capture.created_at) + mediaStartDelayMs,
          ).toISOString(),
        };
      };
      runtime.server
        .on(
          "POST",
          "/v0/voice-sessions/{voiceSessionId}/captures",
          async (request) => project(await start(request)),
        )
        .on("GET", "/v0/voice-captures/{captureSessionId}", async (request) =>
          project(await read(request)),
        )
        .on(
          "GET",
          "/v0/voice-sessions/{voiceSessionId}/transcript-events",
          () => ({ ...feed }),
        );
    });
    await advance(2_000);
    fireEvent.click(screen.getByRole("button", { name: "Start capture" }));
    await advance();
    const capture = await teamHubData(
      runtime.client.api.GET("/v0/voice-captures/{captureSessionId}", {
        params: {
          path: {
            captureSessionId: screen.getByLabelText("capture-id").textContent,
          },
        },
      }),
    );
    expect(requestedStart).toBeGreaterThan(100);
    expect(screen.getByLabelText("visible-count")).toHaveTextContent("0");
    return { feed, capture, requestedStart };
  }

  it("shows the first partial before any final exists", async () => {
    const { feed, requestedStart } = await prepareFirstUtterance();
    feed.partial_transcript = "First sentence still being spoken";
    feed.partial_start_offset_ms = requestedStart + 100;
    feed.partial_end_offset_ms = requestedStart + 1_500;
    await advance(500);
    expect(screen.getByText(feed.partial_transcript)).toBeVisible();
    expect(screen.getByLabelText("visible-count")).toHaveTextContent("0");
  });

  it("keeps a growing boundary-crossing first partial visible, then replaces it with final", async () => {
    const { feed, capture, requestedStart } = await prepareFirstUtterance();
    feed.partial_start_offset_ms = requestedStart - 100;
    for (const end of [1_500, 6_500, 12_500]) {
      feed.partial_transcript = `Ongoing first sentence ${end}`;
      feed.partial_end_offset_ms = requestedStart + end;
      await advance(500);
      expect(screen.getByText(feed.partial_transcript)).toBeVisible();
      expect(screen.getByLabelText("visible-count")).toHaveTextContent("0");
    }
    const lastPartial = feed.partial_transcript;
    feed.items = [
      {
        id: "first-confirmed",
        event_id: "first-confirmed",
        voice_session_id: capture.voice_session_id,
        capture_session_id: capture.id,
        kind: "speech",
        lane: "live",
        media_epoch: 0,
        text: "Confirmed full first sentence",
        start_offset_ms: requestedStart - 100,
        end_offset_ms: requestedStart + 15_000,
        accepted_at: capture.created_at,
        updated_at: capture.created_at,
      },
    ];
    await advance(500);
    expect(screen.getByText("Confirmed full first sentence")).toBeVisible();
    expect(screen.queryByText(lastPartial)).not.toBeInTheDocument();
    feed.partial_transcript = "Live text of the next sentence";
    feed.partial_start_offset_ms = requestedStart + 15_000;
    feed.partial_end_offset_ms = requestedStart + 16_000;
    await advance(500);
    expect(screen.getByText(feed.partial_transcript)).toBeVisible();
  });

  it("uses the original request boundary before delayed recorder start alignment", async () => {
    const { feed, requestedStart } = await prepareFirstUtterance({
      mediaStartDelayMs: 5_000,
    });
    feed.partial_transcript = "First sentence while media prepares";
    feed.partial_start_offset_ms = requestedStart + 100;
    feed.partial_end_offset_ms = requestedStart + 1_500;
    await advance(500);
    expect(screen.getByText(feed.partial_transcript)).toBeVisible();
    expect(screen.getByLabelText("visible-count")).toHaveTextContent("0");
  });

  it.each([-1, 0])(
    "rejects an old partial ending %d ms from the new capture boundary",
    async (endDelta) => {
      const { feed, requestedStart } = await prepareFirstUtterance();
      feed.partial_transcript = "Late fragment from the old recording";
      feed.partial_start_offset_ms = requestedStart - 1_000;
      feed.partial_end_offset_ms = requestedStart + endDelta;
      await advance(500);
      expect(
        screen.queryByText(feed.partial_transcript),
      ).not.toBeInTheDocument();
      feed.partial_transcript = "First sentence of the current recording";
      feed.partial_start_offset_ms = requestedStart - 100;
      feed.partial_end_offset_ms = requestedStart + 1_000;
      await advance(500);
      expect(screen.getByText(feed.partial_transcript)).toBeVisible();
    },
  );

  it("retains conservative start-boundary filtering when the partial end is missing", async () => {
    const { feed, requestedStart } = await prepareFirstUtterance();
    feed.partial_transcript = "Old fragment without an end";
    feed.partial_start_offset_ms = requestedStart - 100;
    feed.partial_end_offset_ms = undefined;
    await advance(500);
    expect(screen.queryByText(feed.partial_transcript)).not.toBeInTheDocument();
    feed.partial_transcript = "New fragment without an end";
    feed.partial_start_offset_ms = requestedStart + 100;
    await advance(500);
    expect(screen.getByText(feed.partial_transcript)).toBeVisible();
  });
});

describe("automatic voice policy connection recovery", () => {
  it("recovers a five-second policy timeout before creating one publisher", async () => {
    const signals: AbortSignal[] = [];
    let reads = 0;
    const runtime = await setup((runtime) => {
      runtime.server.on(
        "GET",
        "/v0/tenants/{tenantId}/voice-media-policy",
        (request) => {
          reads++;
          signals.push(request.request.signal);
          if (reads === 1) return hold(request);
          return { voice_media_supported: true };
        },
      );
    }, "enabling");
    await advance(5_000);
    expect(signals[0]?.aborted).toBe(true);
    expect(screen.getByLabelText("listener-state")).toHaveTextContent(
      "enabling",
    );
    expect(credentialRequests(runtime)).toHaveLength(0);
    expect(media.publish).not.toHaveBeenCalled();
    await advance(499);
    expect(reads).toBe(1);
    await advance(1);
    expect(reads).toBe(2);
    expect(screen.getByLabelText("listener-state")).toHaveTextContent(
      "listening",
    );
    expect(credentialRequests(runtime)).toHaveLength(1);
    expect(media.publish).toHaveBeenCalledOnce();
    await advance(10_000);
    expect(reads).toBe(2);
    expect(media.publish).toHaveBeenCalledOnce();
  });

  it("does not retry a policy authorization rejection", async () => {
    const readPolicy = vi.fn(() =>
      teamHubErrorResponse(403, "FORBIDDEN", "Policy access denied"),
    );
    const runtime = await setup((runtime) => {
      runtime.server.on(
        "GET",
        "/v0/tenants/{tenantId}/voice-media-policy",
        readPolicy,
      );
    }, "error");
    await advance(60_000);
    expect(readPolicy).toHaveBeenCalledOnce();
    expect(credentialRequests(runtime)).toHaveLength(0);
    expect(media.publish).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Policy access denied");
  });

  it("keeps repeated policy timeouts within the overall connection budget", async () => {
    const signals: AbortSignal[] = [];
    const runtime = await setup((runtime) => {
      runtime.server.on(
        "GET",
        "/v0/tenants/{tenantId}/voice-media-policy",
        (request) => {
          signals.push(request.request.signal);
          return hold(request);
        },
      );
    }, "enabling");
    await advance(44_999);
    expect(signals.length).toBeGreaterThan(1);
    expect(screen.getByLabelText("listener-state")).toHaveTextContent(
      "enabling",
    );
    await advance(1);
    expect(screen.getByLabelText("listener-state")).toHaveTextContent("error");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Microphone connection timed out",
    );
    const attempts = signals.length;
    await advance(60_000);
    expect(signals).toHaveLength(attempts);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(credentialRequests(runtime)).toHaveLength(0);
    expect(media.publish).not.toHaveBeenCalled();
  });

  it.each(["request", "retry delay"] as const)(
    "cancels a pending policy %s on unmount without publishing later",
    async (phase) => {
      const signals: AbortSignal[] = [];
      const runtime = await setup((runtime) => {
        runtime.server.on(
          "GET",
          "/v0/tenants/{tenantId}/voice-media-policy",
          (request) => {
            signals.push(request.request.signal);
            return hold(request);
          },
        );
      }, "enabling");
      if (phase === "retry delay") {
        await advance(5_000);
        expect(screen.getByLabelText("listener-state")).toHaveTextContent(
          "enabling",
        );
      }
      cleanup();
      await advance(60_000);
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(true);
      expect(credentialRequests(runtime)).toHaveLength(0);
      expect(media.publish).not.toHaveBeenCalled();
    },
  );

  it("keeps listening disabled when the user cancels a policy retry", async () => {
    const readPolicy = vi.fn(hold);
    await setup((runtime) => {
      runtime.server.on(
        "GET",
        "/v0/tenants/{tenantId}/voice-media-policy",
        readPolicy,
      );
    }, "enabling");
    await advance(5_000);
    fireEvent.click(screen.getByRole("button", { name: "Disable voice" }));
    await advance(60_000);
    expect(readPolicy).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("listener-state")).toHaveTextContent(
      "disabled",
    );
    expect(media.publish).not.toHaveBeenCalled();
  });
});

async function setupObservedTranscript() {
  const state: {
    capture?: TeamHubVoiceCapture;
    incomplete: boolean;
    partial: string;
    partialStartMs: number;
    partialEndMs: number;
    sessionCreatedAt: number;
    feedReads: number;
    items: TeamHubVoiceTranscriptEvent[];
  } = {
    incomplete: false,
    partial: "Unconfirmed fragment",
    partialStartMs: 1_000,
    partialEndMs: 2_000,
    sessionCreatedAt: 0,
    feedReads: 0,
    items: [],
  };
  const runtime = await setup((runtime, voice) => {
    const read = voice("GET", "/v0/voice-captures/{captureSessionId}");
    runtime.server
      .on(
        "GET",
        "/v0/voice-sessions/{voiceSessionId}/transcript-events",
        ({ query }) => {
          state.feedReads++;
          const after = state.items.findIndex(
            (item) => item.id === query.get("after_id"),
          );
          return {
            items: state.items.slice(after + 1),
            partial_transcript: state.partial,
            partial_start_offset_ms: state.partialStartMs,
            partial_end_offset_ms: state.partialEndMs,
          };
        },
      )
      .on("GET", "/v0/voice-captures/{captureSessionId}", async (request) => {
        state.capture = await answerOf<TeamHubVoiceCapture>(
          await read(request),
        );
        return {
          ...state.capture,
          last_failure_code: state.incomplete
            ? "transcript_incomplete"
            : undefined,
        };
      });
  });
  fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
  await advance();
  const capture = state.capture!;
  state.sessionCreatedAt = Date.parse(
    (
      await teamHubData(
        runtime.client.api.GET("/v0/rooms/{roomId}/voice-sessions", {
          params: { path: { roomId: capture.room_id } },
        }),
      )
    ).created_at,
  );
  state.items = [
    {
      id: "confirmed-before-stall",
      event_id: "confirmed-before-stall",
      voice_session_id: capture.voice_session_id,
      capture_session_id: capture.id,
      kind: "speech",
      lane: "live",
      media_epoch: 0,
      text: "Confirmed content",
      start_offset_ms: 0,
      end_offset_ms: 1_000,
      accepted_at: capture.created_at,
      updated_at: capture.created_at,
    },
  ];
  await advance(500);
  expect(screen.getByText(state.partial)).toBeVisible();
  return state;
}

describe("continuous voice pending HTTP diagnosis", () => {
  it("keeps partial progress monotonic without renewing stale display time", async () => {
    const state = await setupObservedTranscript();
    state.partial = "Latest current fragment";
    state.partialEndMs = 3_000;
    await advance(500);
    expect(screen.getByText("Latest current fragment")).toBeVisible();
    await advance(6_000);
    state.partial = "Late old fragment";
    state.partialEndMs = 2_900;
    await advance(500);
    expect(screen.queryByText(state.partial)).not.toBeInTheDocument();
    expect(screen.getByText("Latest current fragment")).toBeVisible();
    await advance(4_000);
    expect(
      screen.queryByText("Latest current fragment"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(state.partial)).not.toBeInTheDocument();
    state.partial = "Valid revision at the same boundary";
    state.partialEndMs = 3_000;
    await advance(500);
    expect(screen.getByText(state.partial)).toBeVisible();
    expect(screen.getByText("Confirmed content")).toBeVisible();
  });

  it.each(["empty", "final"] as const)(
    "does not reopen partial progress closed by %s",
    async (close) => {
      const state = await setupObservedTranscript();
      const closed = state.partial;
      if (close === "empty") state.partial = "";
      else
        state.items.push({
          ...state.items[0]!,
          id: "accepted-current-final",
          event_id: "accepted-current-final",
          text: "Completed full sentence",
          start_offset_ms: 1_000,
          end_offset_ms: state.partialEndMs,
        });
      await advance(500);
      expect(screen.queryByText(closed)).not.toBeInTheDocument();
      state.partial = closed;
      await advance(500);
      expect(screen.queryByText(closed)).not.toBeInTheDocument();
      if (close === "final")
        expect(screen.getByText("Completed full sentence")).toBeVisible();
      state.partial = "Next new fragment";
      state.partialEndMs += 100;
      await advance(500);
      expect(screen.getByText(state.partial)).toBeVisible();
    },
  );

  it("replaces a sentence partial with its final without hiding a later repeated sentence", async () => {
    const state = await setupObservedTranscript();
    const text = "Please confirm this schedule";
    state.partial = text;
    await advance(500);
    expect(screen.getAllByText(text)).toHaveLength(1);
    state.items.push({
      ...state.items[0]!,
      id: "first-sentence-final",
      event_id: "first-sentence-final",
      text,
      start_offset_ms: state.partialStartMs,
      end_offset_ms: state.partialEndMs,
    });
    await advance(500);
    expect(screen.getAllByText(text)).toHaveLength(1);
    expect(screen.getByLabelText("visible-count")).toHaveTextContent("2");
    await advance(500);
    expect(screen.getAllByText(text)).toHaveLength(1);
    state.partialStartMs = 2_500;
    state.partialEndMs = 3_500;
    await advance(500);
    expect(screen.getAllByText(text)).toHaveLength(2);
    state.items.push({
      ...state.items[0]!,
      id: "repeated-sentence-final",
      event_id: "repeated-sentence-final",
      text,
      start_offset_ms: state.partialStartMs,
      end_offset_ms: state.partialEndMs,
    });
    await advance(500);
    expect(screen.getAllByText(text)).toHaveLength(2);
    expect(screen.getByLabelText("visible-count")).toHaveTextContent("3");
  });

  it("resets the partial watermark for a new Capture", async () => {
    const state = await setupObservedTranscript();
    state.partial = "High-water mark of the previous recording";
    state.partialEndMs = 90_000;
    await advance(500);
    expect(screen.getByText(state.partial)).toBeVisible();
    clickStop();
    await advance();
    expect(
      screen.getByRole("button", { name: "Start recording" }),
    ).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Enable voice" }));
    await advance();
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    await advance();
    state.partial = "Separate fragment of the new recording";
    state.partialStartMs = Date.now() - state.sessionCreatedAt + 100;
    state.partialEndMs = state.partialStartMs + 100;
    await advance(500);
    expect(screen.getByText(state.partial)).toBeVisible();
    expect(
      screen.queryByText("High-water mark of the previous recording"),
    ).not.toBeInTheDocument();
  });

  it("does not let successful HTTP hide an incomplete recording transcript", async () => {
    const state = await setupObservedTranscript();
    const reads = state.feedReads;
    state.incomplete = true;
    await advance(1_000);
    const warning =
      "Some transcript segments are unconfirmed. Recording continues; recovery will be attempted after stopping.";
    expect(screen.getByText(warning)).toBeVisible();
    await advance(2_000);
    expect(state.feedReads).toBeGreaterThan(reads + 1);
    expect(screen.getByText(warning)).toBeVisible();
    state.items.push({
      ...state.items[0]!,
      id: "confirmed-after-stall",
      event_id: "confirmed-after-stall",
      text: "Later confirmed content",
      start_offset_ms: 2_000,
      end_offset_ms: 3_000,
      accepted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    state.partial = "New fragment being updated";
    state.partialEndMs = 4_000;
    await advance(500);
    expect(screen.getByText("Confirmed content")).toBeVisible();
    expect(screen.getByText("Later confirmed content")).toBeVisible();
    expect(screen.getByText(state.partial)).toBeVisible();
    expect(screen.getByText(warning)).toBeVisible();
    expect(screen.getByLabelText("capture-state")).toHaveTextContent(
      "recording",
    );
    expect(
      screen.getByRole("button", { name: /^(Stop|Close) recording$/ }),
    ).toBeEnabled();
    expect(media.stop).not.toHaveBeenCalled();
  });

  it("expires a stale partial without treating silence as failure and shows new progress immediately", async () => {
    const state = await setupObservedTranscript();
    const originalPartial = state.partial;
    await advance(15_000);
    expect(screen.queryByText(originalPartial)).not.toBeInTheDocument();
    expect(screen.getByText("Confirmed content")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "Some transcript segments are unconfirmed. Recording continues; recovery will be attempted after stopping.",
      ),
    ).not.toBeInTheDocument();
    await advance(1_000);
    expect(screen.queryByText(originalPartial)).not.toBeInTheDocument();
    state.partialEndMs += 320;
    await advance(500);
    expect(screen.getByText(originalPartial)).toBeVisible();
    await advance(6_000);
    state.partial = "New fragment after advancing";
    await advance(500);
    expect(screen.getByText(state.partial)).toBeVisible();
    await advance(5_000);
    expect(screen.getByText(state.partial)).toBeVisible();
    expect(screen.getByText("Confirmed content")).toBeVisible();
    const readsAtUnmount = state.feedReads;
    cleanup();
    await advance();
    expect(vi.getTimerCount()).toBe(0);
    await advance(15_000);
    expect(state.feedReads).toBe(readsAtUnmount);
  });

  it.each(["retryable", "permanent"] as const)(
    "does not confirm a new Start from an older recovering Capture after a %s failure",
    async (failure) => {
      const state: {
        old?: TeamHubVoiceCapture;
        recovering: boolean;
        keys: string[];
        bodies: string[];
        created: number;
      } = { recovering: false, keys: [], bodies: [], created: 0 };
      await setup((runtime, voice) => {
        const originalStart = voice(
          "POST",
          "/v0/voice-sessions/{voiceSessionId}/captures",
        );
        const originalActive = voice(
          "GET",
          "/v0/rooms/{roomId}/active-voice-capture",
        );
        const originalRead = voice(
          "GET",
          "/v0/voice-captures/{captureSessionId}",
        );
        const older = () => ({
          ...state.old!,
          status: "recovering" as const,
          transcript_recovery_status: "pending" as const,
        });
        runtime.server
          .on(
            "POST",
            "/v0/voice-sessions/{voiceSessionId}/captures",
            async (request) => {
              if (state.recovering) {
                state.keys.push(idempotencyKey(request)!);
                state.bodies.push(JSON.stringify(request.body));
                if (failure === "permanent")
                  return teamHubErrorResponse(
                    400,
                    "INVALID_START",
                    "New Start rejected",
                  );
                if (state.keys.length === 1) return hold(request);
                state.created++;
              }
              const capture = await answerOf<TeamHubVoiceCapture>(
                await originalStart(request),
              );
              state.old ??= capture;
              return capture;
            },
          )
          .on(
            "GET",
            "/v0/rooms/{roomId}/active-voice-capture",
            async (request) => {
              const active = await answerOf<TeamHubVoiceCapture | null>(
                await originalActive(request),
              );
              // Production's active query returns an old recovery while no newer live Capture exists.
              return active ?? (state.recovering ? older() : null);
            },
          )
          .on("GET", "/v0/voice-captures/{captureSessionId}", (request) =>
            state.recovering &&
            request.params.captureSessionId === state.old?.id
              ? older()
              : originalRead(request),
          );
      });
      fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
      await advance();
      state.recovering = true;
      clickStop();
      await advance();
      expect(screen.getByLabelText("capture-state")).toHaveTextContent(
        "recovering",
      );
      expect(
        screen.queryByRole("button", { name: "Start recording" }),
      ).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Enable voice" }));
      await advance();
      fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
      await advance(failure === "retryable" ? 5_500 : 0);
      if (failure === "retryable") {
        expect(state.keys).toHaveLength(2);
        expect(state.bodies[1]).toBe(state.bodies[0]);
        expect(state.created).toBe(1);
        expect(screen.getByLabelText("capture-id")).not.toHaveTextContent(
          state.old!.id,
        );
        expect(screen.getByLabelText("capture-state")).toHaveTextContent(
          "recording",
        );
      } else {
        expect(screen.getByRole("alert")).toHaveTextContent(
          "New Start rejected",
        );
        expect(
          screen.getByRole("button", { name: "Start recording" }),
        ).toBeEnabled();
        await advance(10_000);
        expect(state.keys).toHaveLength(1);
        expect(state.created).toBe(0);
        expect(screen.getByLabelText("capture-id")).toHaveTextContent(
          state.old!.id,
        );
      }
    },
  );

  it("recovers the next live transcript after one feed GET remains pending", async () => {
    let enabled = false;
    let held = false;
    let latest: TeamHubVoiceTranscriptEvent[] = [];
    const requests: { path: string; signal: boolean }[] = [];
    const runtime = await setup((runtime) => {
      runtime.server.on(
        "GET",
        "/v0/voice-sessions/{voiceSessionId}/transcript-events",
        (request) => {
          requests.push({
            path: request.request.url,
            signal: Boolean(request.request.signal),
          });
          if (enabled && !held) {
            held = true;
            return hold(request);
          }
          return { items: latest };
        },
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    await advance();
    const target = await teamHubData(
      runtime.client.api.GET("/v0/tenants/{tenantId}/another-me", {
        params: { path: { tenantId: "tenant-northstar" } },
      }),
    );
    const capture = (await teamHubData(
      runtime.client.api.GET("/v0/rooms/{roomId}/active-voice-capture", {
        params: { path: { roomId: target.room_id! } },
      }),
    ))!;
    enabled = true;
    await advance(500);
    const before = requests.length;
    latest = [
      {
        id: "later-final",
        event_id: "later-final",
        capture_session_id: capture.id,
        voice_session_id: capture.voice_session_id,
        kind: "speech",
        lane: "live",
        media_epoch: 0,
        text: "fixture latest speech",
        start_offset_ms: 0,
        end_offset_ms: 1000,
        accepted_at: capture.created_at,
        updated_at: capture.created_at,
      },
    ];
    await advance(60_000);
    expect(requests.length).toBeGreaterThan(before);
    expect(requests.every((request) => request.signal)).toBe(true);
    expect(screen.getByLabelText("visible-count")).toHaveTextContent("1");
  });

  it("finishes Saving after one finalizing Capture GET remains pending", async () => {
    let finalizing = false;
    let held = false;
    const reads: boolean[] = [];
    await setup((runtime, voice) => {
      const originalRead = voice(
        "GET",
        "/v0/voice-captures/{captureSessionId}",
      );
      const originalStop = voice(
        "POST",
        "/v0/voice-captures/{captureSessionId}/stop",
      );
      runtime.server
        .on("GET", "/v0/voice-captures/{captureSessionId}", (request) => {
          reads.push(Boolean(request.request.signal));
          if (finalizing && !held) {
            held = true;
            return hold(request);
          }
          return originalRead(request);
        })
        .on("POST", "/v0/voice-captures/{captureSessionId}/stop", (request) => {
          finalizing = true;
          return originalStop(request);
        });
    });
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    await advance();
    clickStop();
    await advance();
    const before = reads.length;
    await advance(60_000);
    expect(reads.length).toBeGreaterThan(before);
    expect(reads.every(Boolean)).toBe(true);
    expect(screen.getByLabelText("capture-state")).toHaveTextContent(
      "completed",
    );
  });

  it("reconciles a manual Start accepted on the server while its POST response remains pending", async () => {
    let accepted = false;
    let reads = 0;
    let signal = false;
    await setup((runtime, voice) => {
      const originalStart = voice(
        "POST",
        "/v0/voice-sessions/{voiceSessionId}/captures",
      );
      const originalActive = voice(
        "GET",
        "/v0/rooms/{roomId}/active-voice-capture",
      );
      runtime.server
        .on("GET", "/v0/rooms/{roomId}/active-voice-capture", (request) => {
          reads++;
          return originalActive(request);
        })
        .on(
          "POST",
          "/v0/voice-sessions/{voiceSessionId}/captures",
          async (request) => {
            await originalStart(request);
            accepted = true;
            signal = Boolean(request.request.signal);
            return hold(request);
          },
        );
    });
    const before = reads;
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    await advance();
    expect(accepted).toBe(true);
    await advance(60_000);
    expect(reads).toBeGreaterThan(before);
    expect(signal).toBe(true);
    expect(screen.getByLabelText("capture-state")).toHaveTextContent(
      "recording",
    );
  });

  it("control: a hung active poll does not defeat a successful manual Stop and a separate finalizing poll", async () => {
    let reads = 0;
    await setup((runtime, voice) => {
      const originalRead = voice(
        "GET",
        "/v0/voice-captures/{captureSessionId}",
      );
      runtime.server.on(
        "GET",
        "/v0/voice-captures/{captureSessionId}",
        (request) => (++reads === 1 ? hold(request) : originalRead(request)),
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    await advance();
    expect(reads).toBe(1);
    clickStop();
    await advance();
    expect(screen.getByLabelText("capture-state")).toHaveTextContent(
      "completed",
    );
  });

  it("retries an unconfirmed Start when no Capture is visible yet", async () => {
    const keys: (string | null)[] = [];
    let created = 0;
    await setup((runtime, voice) => {
      const originalStart = voice(
        "POST",
        "/v0/voice-sessions/{voiceSessionId}/captures",
      );
      runtime.server.on(
        "POST",
        "/v0/voice-sessions/{voiceSessionId}/captures",
        (request) => {
          keys.push(idempotencyKey(request));
          if (keys.length === 1) return hold(request);
          created++;
          return originalStart(request);
        },
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    await advance(5_500);
    expect(keys).toHaveLength(2);
    expect(created).toBe(1);
    expect(screen.getByLabelText("capture-state")).toHaveTextContent(
      "recording",
    );
  });

  it("adopts the live Capture when a retried Start conflicts with the first one", async () => {
    let attempts = 0;
    let created = 0;
    await setup((runtime, voice) => {
      const originalStart = voice(
        "POST",
        "/v0/voice-sessions/{voiceSessionId}/captures",
      );
      runtime.server.on(
        "POST",
        "/v0/voice-sessions/{voiceSessionId}/captures",
        async (request) => {
          attempts++;
          if (attempts === 1) return hold(request);
          // The timed-out first Start commits after the recovery read.
          created++;
          await originalStart(request);
          return teamHubErrorResponse(
            409,
            "VOICE_CAPTURE_CONFLICT",
            "A Capture is active",
          );
        },
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    await advance(5_500);
    expect(attempts).toBe(2);
    expect(created).toBe(1);
    expect(screen.getByLabelText("capture-state")).toHaveTextContent(
      "recording",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["feed", "capture", "start", "stop"] as const)(
    "cancels pending %s HTTP on unmount except bounded stop cleanup",
    async (resource) => {
      const signals: AbortSignal[] = [];
      const pending = (request: TestRouteRequest) => {
        signals.push(request.request.signal);
        return hold(request);
      };
      await setup((runtime) => {
        if (resource === "feed")
          runtime.server.on(
            "GET",
            "/v0/voice-sessions/{voiceSessionId}/transcript-events",
            pending,
          );
        if (resource === "capture")
          runtime.server.on(
            "GET",
            "/v0/voice-captures/{captureSessionId}",
            pending,
          );
        if (resource === "start")
          runtime.server.on(
            "POST",
            "/v0/voice-sessions/{voiceSessionId}/captures",
            pending,
          );
        if (resource === "stop")
          runtime.server.on(
            "POST",
            "/v0/voice-captures/{captureSessionId}/stop",
            pending,
          );
      });
      if (resource !== "feed") {
        fireEvent.click(
          screen.getByRole("button", { name: "Start recording" }),
        );
        await advance();
      }
      if (resource === "stop") clickStop();
      await advance();
      expect(signals).toHaveLength(1);
      cleanup();
      await advance(90_000);
      expect(signals[0]?.aborted).toBe(true);
      if (resource === "stop") {
        expect(signals.length).toBeLessThanOrEqual(9);
        expect(media.publish).toHaveBeenCalledOnce();
        const attempts = signals.length;
        await advance(90_000);
        expect(signals).toHaveLength(attempts);
      } else {
        expect(signals).toHaveLength(1);
      }
    },
  );

  it("clears recovery feedback after a permanent Start rejection", async () => {
    await setup((runtime) => {
      runtime.server.on(
        "POST",
        "/v0/voice-sessions/{voiceSessionId}/captures",
        () => teamHubErrorResponse(400, "INVALID_START", "Start rejected"),
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    await advance();
    expect(screen.getByRole("alert")).toHaveTextContent("Start rejected");
    expect(
      screen.queryByText(
        "Reconnecting recording status; waiting for server confirmation",
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Start recording" }),
    ).toBeEnabled();
  });

  it("does not overwrite a newer Capture with a late manual Start response", async () => {
    let oldCapture!: TeamHubVoiceCapture;
    let acknowledge!: () => void;
    let events!: VoiceEventSubscription;
    let serverStart!: TestRouteHandler;
    const runtime = await setup((runtime, voice) => {
      serverStart = voice(
        "POST",
        "/v0/voice-sessions/{voiceSessionId}/captures",
      );
      const subscribe = runtime.voiceEvents!.subscribe;
      runtime.voiceEvents = {
        subscribe: (input) => {
          events = input;
          return subscribe(input);
        },
      };
      runtime.server.on(
        "POST",
        "/v0/voice-sessions/{voiceSessionId}/captures",
        async (request) => {
          oldCapture = await answerOf<TeamHubVoiceCapture>(
            await serverStart(request),
          );
          return new Promise((resolve) => {
            acknowledge = () => resolve(oldCapture);
          });
        },
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    await advance();
    await teamHubData(
      runtime.client.api.POST("/v0/voice-captures/{captureSessionId}/stop", {
        params: { path: { captureSessionId: oldCapture.id } },
      }),
    );
    await advance(1);
    // Starts the newer Capture on the server, past the held route.
    const newer = await answerOf<TeamHubVoiceCapture>(
      await serverStart({
        body: { room_id: oldCapture.room_id, start_offset_ms: 1 },
        params: { voiceSessionId: oldCapture.voice_session_id },
        query: new URLSearchParams(),
        request: new Request("https://voice.test/"),
      }),
    );
    act(() =>
      events.onEvents({
        next_cursor: `${newer.voice_session_id}:1`,
        has_more: false,
        items: [
          {
            kind: "capture",
            capture: newer,
          },
        ],
      }),
    );
    await advance(500);
    expect(screen.getByLabelText("capture-id")).toHaveTextContent(newer.id);
    await act(async () => acknowledge());
    await advance();
    expect(screen.getByLabelText("capture-id")).toHaveTextContent(newer.id);
    expect(screen.getByLabelText("capture-state")).toHaveTextContent(
      "recording",
    );
  });

  it("retries a pre-accept hung Stop during departure", async () => {
    const keys: (string | null)[] = [];
    let stopsAccepted = 0;
    await setup((runtime, voice) => {
      const originalStop = voice(
        "POST",
        "/v0/voice-captures/{captureSessionId}/stop",
      );
      runtime.server.on(
        "POST",
        "/v0/voice-captures/{captureSessionId}/stop",
        (request) => {
          keys.push(idempotencyKey(request));
          if (keys.length === 1) return hold(request);
          stopsAccepted++;
          return originalStop(request);
        },
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    await advance();
    clickStop();
    await advance(6_000);
    expect(keys).toHaveLength(2);
    expect(stopsAccepted).toBe(1);
    expect(screen.getByLabelText("capture-state")).toHaveTextContent(
      "completed",
    );
  });
});

describe("Start waits for the input-ready handshake", () => {
  it("keeps Capture pending until the published input is ready", async () => {
    let readyReads = 0;
    const runtime = await setup((runtime, voice) => {
      const read = voice("GET", "/v0/voice-sessions/{voiceSessionId}");
      // The Runtime confirms input a few polls after the browser publishes.
      runtime.server.on(
        "GET",
        "/v0/voice-sessions/{voiceSessionId}",
        async (request) => {
          const session = await answerOf<TeamHubVoiceSession>(
            await read(request),
          );
          readyReads++;
          return readyReads > 3
            ? session
            : {
                ...session,
                input_ready_generation: session.credential_generation + 99,
              };
        },
      );
    }, "enabling");
    const starts = () =>
      runtime.server.requestsTo(
        "POST",
        "/v0/voice-sessions/{voiceSessionId}/captures",
      );

    fireEvent.click(screen.getByRole("button", { name: "Start capture" }));
    await advance();
    // A published local track must not let the recorder outrun ASR input.
    expect(screen.getByLabelText("listener-state")).toHaveTextContent(
      "enabling",
    );
    expect(starts()).toHaveLength(0);
    await advance(1_000);
    expect(screen.getByLabelText("listener-state")).toHaveTextContent(
      "listening",
    );
    expect(starts()).toHaveLength(1);
    expect(screen.getByLabelText("capture-state")).toHaveTextContent(
      "recording",
    );
  });
});

/** Stops the recording, confirming in the window when it asks first. */
function clickStop() {
  fireEvent.click(
    screen.getByRole("button", { name: /^(Stop|Close) recording$/ }),
  );
  const confirm = screen.queryByRole("button", { name: "Stop & save" });
  if (confirm) fireEvent.click(confirm);
}
