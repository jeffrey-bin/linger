import { EventEmitter } from "node:events";
import type { JobContext } from "@livekit/agents";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamHubVoiceRuntimeError } from "./live-client.js";

const rtc = vi.hoisted(() => {
  class Track {
    sid = "TR-live";
    controller!: ReadableStreamDefaultController<unknown>;
    stream = new ReadableStream({
      start: (controller) => {
        this.controller = controller;
      },
    });
    frame(value: number) {
      this.controller.enqueue({
        data: new Int16Array(320).fill(value),
        samplesPerChannel: 320,
        sampleRate: 16_000,
      });
    }
    closeAudioStreams() {}
  }
  class AudioSource {
    static last: AudioSource;
    frames: Int16Array[] = [];
    clears = 0;
    private queuedMs = 0;
    private drained: Array<() => void> = [];
    /** While held, captureFrame waits, so audio stays in the worker's queue. */
    private hold?: Promise<void>;
    private release?: () => void;
    queueFrames = false;
    get queued() {
      return this.queuedMs;
    }
    set queued(value: number) {
      this.queuedMs = value;
      if (value === 0) for (const resolve of this.drained.splice(0)) resolve();
    }
    constructor() {
      AudioSource.last = this;
    }
    get queuedDuration() {
      return this.queued;
    }
    holdFrames() {
      this.hold = new Promise((resolve) => {
        this.release = resolve;
      });
    }
    releaseFrames() {
      this.release?.();
      this.hold = undefined;
    }
    async captureFrame(frame: { data: Int16Array }) {
      await this.hold;
      this.frames.push(frame.data);
      if (this.queueFrames) this.queued += frame.data.length / 24;
    }
    async waitForPlayout() {
      if (this.queued > 0)
        await new Promise<void>((resolve) => this.drained.push(resolve));
    }
    clearQueue() {
      this.clears++;
      this.queued = 0;
    }
    async close() {}
  }
  return { Track, AudioSource };
});

const logger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@livekit/agents", () => ({
  AutoSubscribe: { AUDIO_ONLY: 1 },
  log: () => logger,
}));
vi.mock("@livekit/rtc-node", () => ({
  RemoteAudioTrack: rtc.Track,
  AudioSource: rtc.AudioSource,
  AudioStream: class {
    constructor(track: InstanceType<typeof rtc.Track>) {
      return track.stream;
    }
  },
  AudioFrame: class {
    constructor(readonly data: Int16Array) {}
  },
  LocalAudioTrack: {
    createAudioTrack: (name: string) => ({ name }),
  },
  TrackPublishOptions: class {
    constructor(readonly options: unknown) {}
  },
  RoomEvent: {
    TrackSubscribed: "subscribed",
    TrackUnsubscribed: "unsubscribed",
    TrackMuted: "muted",
    TrackUnmuted: "unmuted",
    DataReceived: "data",
    ParticipantDisconnected: "left",
    Disconnected: "disconnected",
  },
  TrackSource: { SOURCE_MICROPHONE: 1 },
}));

import { LiveSessionError, type LiveEvent } from "./live-session.js";
import {
  liveDataTopic,
  liveReplyEventId,
  liveTurnId,
  LiveVoiceWorker,
  parseLiveClientEvent,
  runToolRound,
  toDetectorRate,
  withoutRepeat,
} from "./live-worker.js";

const sessionId = "voice_session_test";
const publisher = { identity: `publisher-${sessionId}` };
const turnA = liveTurnId(sessionId, "item-a");
const turnB = liveTurnId(sessionId, "item-b");

class FakeSession {
  private queue: LiveEvent[] = [];
  private waiters: Array<() => void> = [];
  private failure?: Error;
  private ended = false;
  audio: Int16Array[] = [];
  appendAudio = (frame: Int16Array) => void this.audio.push(frame);
  mute = vi.fn();
  unmute = vi.fn();
  closeTurn = vi.fn();
  cancel = vi.fn();
  respond = vi.fn();
  truncate = vi.fn();
  tell = vi.fn();
  note = vi.fn();
  sendToolResults = vi.fn();
  setSpeed = vi.fn((speed: number) => speed <= 1.5);
  close = vi.fn(async () => this.end());
  emit(...events: LiveEvent[]) {
    this.queue.push(...events);
    this.wake();
  }
  fail(error: Error) {
    this.failure = error;
    this.end();
  }
  private end() {
    this.ended = true;
    this.wake();
  }
  private wake() {
    for (const resolve of this.waiters.splice(0)) resolve();
  }
  async *events() {
    for (;;) {
      const event = this.queue.shift();
      if (event) {
        yield event;
        continue;
      }
      if (this.ended) break;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    if (this.failure) throw this.failure;
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
});

interface Task {
  task_id: string;
  goal: string;
  surface: "workspace" | "web" | "desktop" | "apps";
  started_in_this_call: boolean;
  state:
    | "pending"
    | "working"
    | "waiting_for_approval"
    | "reported"
    | "failed"
    | "canceled";
  replies: Array<{ message_id: string; text: string }>;
}

async function harness(
  options: {
    toolTimeoutMs?: number;
    providerOpening?: Promise<void>;
    beforeReady?: (state: {
      track: InstanceType<typeof rtc.Track>;
      readyAttributes: () => unknown[];
    }) => Promise<void>;
    toolOutput?: (call: { name: string; arguments: string }) => string;
    updateGapMs?: number;
    userFirstMs?: number;
    tasksPollMs?: number;
    browserStepBudgetMs?: number;
  } = {},
) {
  const sessions: FakeSession[] = [];
  const setups: unknown[] = [];
  let tasks: Task[] = [];
  let alerts: Array<{ alert_id: string; text: string }> = [];
  let hint: (() => void) | undefined;
  const client = {
    reportObservation: vi.fn(async (event: { event_id: string }) => ({
      event_id: event.event_id,
      status: "accepted" as const,
    })),
    getLiveContext: vi.fn(async () => ({
      room_id: "room",
      agent_name: "agent",
      instructions: "instructions",
      history: [
        { role: "user" as const, text: "earlier" },
        { role: "assistant" as const, text: "answer" },
      ],
      tools: [{ name: "start_task", description: "d", parameters: {} }],
    })),
    reportLiveReply: vi.fn(async (reply: { event_id: string }) => ({
      event_id: reply.event_id,
      status: "accepted" as const,
    })),
    executeLiveToolCall: vi.fn(
      async (call: { call_id: string; name: string; arguments: string }) => ({
        call_id: call.call_id,
        output:
          options.toolOutput?.(call) ??
          (call.name === "page_action"
            ? '{"status":"admitted"}'
            : '{"result":"business"}'),
      }),
    ),
    listLiveTasks: vi.fn(async () => ({ tasks, alerts })),
    // The hint stream stays open; hint() is TeamHub's push of a change.
    watchLiveTasks: vi.fn(
      (_id: string, changed: () => void, signal: AbortSignal) => {
        hint = changed;
        return new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve()),
        );
      },
    ),
  };
  const published: Array<Record<string, unknown>> = [];
  const publishOptions: unknown[] = [];
  const localParticipant = {
    setAttributes: vi.fn<(attributes: Record<string, string>) => Promise<void>>(
      async () => undefined,
    ),
    publishTrack: vi.fn(async () => ({})),
    publishData: vi.fn(async (payload: Uint8Array, opts: unknown) => {
      published.push(JSON.parse(new TextDecoder().decode(payload)));
      publishOptions.push(opts);
    }),
  };
  const room = Object.assign(new EventEmitter(), {
    remoteParticipants: new Map(),
    localParticipant,
  });
  let shutdownCallback!: () => Promise<void>;
  const ctx = {
    room,
    job: {
      room: { name: `voice-${sessionId}` },
      metadata: JSON.stringify({
        voice_session_created_at: new Date(Date.now() - 1_000).toISOString(),
        voice_purpose: "chat_live",
      }),
    },
    connect: vi.fn(async () => undefined),
    addShutdownCallback: (callback: () => Promise<void>) => {
      shutdownCallback = callback;
    },
    shutdown: vi.fn(),
  } as unknown as JobContext;
  const worker = new LiveVoiceWorker(
    client,
    async (setup) => {
      setups.push(await setup);
      const session = new FakeSession();
      sessions.push(session);
      await options.providerOpening;
      return session;
    },
    {
      toolTimeoutMs: options.toolTimeoutMs ?? 2_000,
      replyRetryBudgetMs: 5_000,
      reconnectDelayMs: () => 0,
      tasksPollMs: options.tasksPollMs ?? 10,
      browserStepBudgetMs: options.browserStepBudgetMs,
      updateStartTimeoutMs: 200,
      updateGapMs: options.updateGapMs ?? 0,
      userFirstMs: options.userFirstMs ?? 0,
      openDetector: async () => {
        let through = 0;
        return {
          async pushPCM(frame: Int16Array) {
            through += 512;
            return [{ throughSample: through, speech: frame[0] === 1 }];
          },
          close: () => undefined,
        };
      },
    },
  );
  const running = worker.run(ctx);
  const track = new rtc.Track();
  room.emit(
    "subscribed",
    track,
    { source: 1 },
    { ...publisher, attributes: { "linger.voice_generation": "1" } },
  );
  await options.beforeReady?.({
    track,
    readyAttributes: () =>
      localParticipant.setAttributes.mock.calls.map((call) => call[0]),
  });
  await running;
  const send = (event: Record<string, unknown>, from = publisher) =>
    room.emit(
      "data",
      new TextEncoder().encode(JSON.stringify(event)),
      from,
      0,
      liveDataTopic,
    );
  const ofType = (type: string) =>
    published.filter((event) => event.type === type);
  return {
    sessions,
    session: () => sessions.at(-1)!,
    setups,
    client,
    room,
    ctx,
    track,
    source: () => rtc.AudioSource.last,
    published,
    publishOptions,
    localParticipant,
    ofType,
    send,
    setTasks: (next: Task[]) => {
      tasks = next;
    },
    setAlerts: (next: typeof alerts) => {
      alerts = next;
    },
    hint: () => hint?.(),
    shutdown: () => shutdownCallback(),
  };
}

type Test = Awaited<ReturnType<typeof harness>>;

const pcm = (samples: number, value = 3000) =>
  new Int16Array(samples).fill(value);
const silence = (samples: number) => new Int16Array(samples);

/** A finished user turn whose reply started with text and 40 ms of audio. */
async function answeredTurn(test: Test, text = "reply ") {
  test
    .session()
    .emit(
      { type: "transcript_completed", itemId: "item-a", text: "question" },
      { type: "response_started" },
      { type: "text_delta", text, update: false },
      { type: "audio_started", update: false },
      { type: "audio_delta", pcm: pcm(960) },
    );
  await vi.waitFor(() => expect(test.ofType("reply_delta")).toHaveLength(1));
}

/** A start_task call in the reply under way. */
async function startTask(test: Test, goal = "Research three vendors' pricing") {
  test.session().emit({
    type: "function_calls",
    update: false,
    calls: [
      {
        callId: "call-start",
        name: "start_task",
        arguments: JSON.stringify({ goal, surface: "workspace" }),
      },
    ],
  });
  await vi.waitFor(() =>
    expect(test.session().sendToolResults).toHaveBeenCalledOnce(),
  );
}

describe("parseLiveClientEvent", () => {
  const encode = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value));
  it("accepts tool results and context only", () => {
    expect(
      parseLiveClientEvent(
        encode({ type: "tool_result", call_id: "c1", text: "{}" }),
      ),
    ).toEqual({ type: "tool_result", call_id: "c1", text: "{}" });
    expect(
      parseLiveClientEvent(
        encode({ type: "context", text: "On the Pocket Note page" }),
      ),
    ).toEqual({ type: "context", text: "On the Pocket Note page" });
    for (const type of ["verdict", "speak", "result", "announce", "feedback"])
      expect(
        parseLiveClientEvent(encode({ type, turn_id: "t", text: "x" })),
      ).toBeUndefined();
    expect(parseLiveClientEvent(new TextEncoder().encode("{"))).toBeUndefined();
  });
});

describe("runToolRound", () => {
  it("runs page steps in order and skips the rest after a step that is not done", async () => {
    const order: string[] = [];
    const outputs = await runToolRound(
      [
        {
          callId: "1",
          name: "page_action",
          arguments: '{"action":"open_room"}',
        },
        { callId: "2", name: "recall_memory", arguments: "{}" },
        { callId: "3", name: "page_action", arguments: '{"action":"click"}' },
        { callId: "4", name: "page_action", arguments: '{"action":"scroll"}' },
      ],
      async (call) => {
        order.push(call.callId);
        if (call.callId === "3") return '{"status":"not_found"}';
        return call.name === "page_action" ? '{"status":"done"}' : "{}";
      },
    );
    expect(order.filter((id) => id !== "2")).toEqual(["1", "3"]);
    expect(JSON.parse(outputs[3]!)).toMatchObject({ status: "skipped" });
  });
});

describe("LiveVoiceWorker user transcript", () => {
  it("shows the live model's transcript and uses it as the turn text", async () => {
    const test = await harness();
    test
      .session()
      .emit(
        { type: "speech_started", itemId: "item-a" },
        { type: "transcript_delta", itemId: "item-a", text: "Switch to" },
      );
    await vi.waitFor(() =>
      expect(test.ofType("user_partial")).toEqual([
        { type: "user_partial", turn_id: turnA, text: "Switch to" },
      ]),
    );
    test.session().emit({
      type: "transcript_completed",
      itemId: "item-a",
      text: "Switch to the product review",
    });
    await vi.waitFor(() =>
      expect(test.ofType("user_turn")).toEqual([
        {
          type: "user_turn",
          turn_id: turnA,
          text: "Switch to the product review",
        },
      ]),
    );
    await test.shutdown();
  });
});

describe("LiveVoiceWorker", () => {
  it("opens the provider with context, tools and history and announces readiness", async () => {
    const test = await harness();
    expect(test.localParticipant.publishTrack).toHaveBeenCalledWith(
      { name: "linger-live-reply" },
      expect.anything(),
    );
    expect(test.setups[0]).toMatchObject({
      instructions: "instructions",
      history: [
        { role: "user", text: "earlier" },
        { role: "assistant", text: "answer" },
      ],
    });
    expect(
      (test.setups[0] as { tools: Array<{ name: string }> }).tools.map(
        (tool) => tool.name,
      ),
    ).toEqual([
      "start_task",
      "end_voice_mode",
      "read_page",
      "page_action",
      "set_speed",
    ]);
    test.track.frame(0);
    await vi.waitFor(() => expect(test.session().audio).toHaveLength(1));
    await vi.waitFor(() =>
      expect(test.localParticipant.setAttributes).toHaveBeenCalledWith(
        expect.objectContaining({
          "linger.voice_ready_generation": "1",
          "linger.voice_ready_track": "TR-live",
          "linger.voice_purpose": "chat_live",
        }),
      ),
    );
    await test.shutdown();
    expect(test.session().close).toHaveBeenCalledOnce();
  });

  it("waits for the provider even when PCM has already arrived", async () => {
    let ready!: () => void;
    const providerOpening = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const test = await harness({
      providerOpening,
      beforeReady: async ({ track, readyAttributes }) => {
        track.frame(0);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(readyAttributes()).toEqual([]);
        ready();
      },
    });
    await vi.waitFor(() =>
      expect(test.localParticipant.setAttributes).toHaveBeenCalledWith(
        expect.objectContaining({ "linger.voice_ready_generation": "1" }),
      ),
    );
    await test.shutdown();
  });

  it("fails within a bounded deadline if an input track never produces PCM", async () => {
    vi.useFakeTimers();
    const test = await harness();
    await vi.advanceTimersByTimeAsync(10_001);
    expect(test.ofType("session_failure")).toEqual([
      { type: "session_failure", code: "live_input_timeout" },
    ]);
    expect(test.ctx.shutdown).toHaveBeenCalledOnce();
    await test.shutdown();
  });

  it("plays the reply at once, says the turn is done after it, and saves it once", async () => {
    const test = await harness();
    await answeredTurn(test);
    expect(test.ofType("user_turn")).toEqual([
      { type: "user_turn", turn_id: turnA, text: "question" },
    ]);
    expect(test.publishOptions[0]).toEqual({
      reliable: true,
      topic: liveDataTopic,
      destination_identities: [publisher.identity],
    });
    await vi.waitFor(() => expect(test.source().frames).toHaveLength(2));
    test
      .session()
      .emit(
        { type: "text_delta", text: "done", update: false },
        { type: "audio_delta", pcm: pcm(480) },
        { type: "response_finished", canceled: false },
      );
    await vi.waitFor(() =>
      expect(test.client.reportLiveReply).toHaveBeenCalledOnce(),
    );
    // rtc-node reads each frame's whole backing buffer, ignoring view offsets.
    for (const frame of test.source().frames)
      expect(frame.buffer.byteLength).toBe(frame.byteLength);
    expect(test.ofType("reply_done")).toEqual([
      { type: "reply_done", turn_id: turnA, text: "reply done" },
    ]);
    expect(test.client.reportLiveReply.mock.calls[0]![0]).toEqual({
      event_id: liveReplyEventId(sessionId, turnA),
      voice_session_id: sessionId,
      turn_id: turnA,
      text: "reply done",
    });
    await test.shutdown();
    expect(test.client.reportLiveReply).toHaveBeenCalledOnce();
  });

  it("says a turn is done only after its tool rounds, so the browser saves it after any hand-off", async () => {
    const test = await harness({
      toolOutput: () => '{"status":"started","task_id":"t1"}',
    });
    await answeredTurn(test, "Let me check.");
    // The filler's audio ends before the call arrives in the same response.
    test.session().emit({ type: "audio_done" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(test.ofType("reply_done")).toHaveLength(0);
    await startTask(test);
    expect(test.ofType("reply_done")).toHaveLength(0);
    test.session().emit({ type: "response_finished", canceled: false });
    await vi.waitFor(() => expect(test.ofType("reply_done")).toHaveLength(1));
    // The model already said it is on it: no second line for the hand-off.
    expect(test.session().sendToolResults).toHaveBeenCalledWith(
      [{ callId: "call-start", output: '{"status":"started","task_id":"t1"}' }],
      { reply: false },
    );
    expect(test.client.executeLiveToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ name: "start_task", turn_id: turnA }),
      expect.anything(),
    );
    await test.shutdown();
  });

  it("calls tools in the turn the user just started, before its transcript is final", async () => {
    const test = await harness({
      toolOutput: () => '{"status":"sent"}',
    });
    await answeredTurn(test, "Shall I send it?");
    test.session().emit({ type: "response_finished", canceled: false });
    // The yes: the reply and its call come before the transcript completes.
    test.session().emit(
      { type: "speech_started", itemId: "item-b" },
      { type: "response_started" },
      {
        type: "function_calls",
        update: false,
        calls: [
          {
            callId: "call-send",
            name: "send_slack",
            arguments: JSON.stringify({ text: "hi", confirmed: true }),
          },
        ],
      },
    );
    await vi.waitFor(() =>
      expect(test.client.executeLiveToolCall).toHaveBeenCalledWith(
        expect.objectContaining({ name: "send_slack", turn_id: turnB }),
        expect.anything(),
      ),
    );
    await test.shutdown();
  });

  it("judges a call after a slow tool by the turn the user spoke in meanwhile", async () => {
    const test = await harness();
    let answer: (output: string) => void = () => undefined;
    test.client.executeLiveToolCall.mockImplementationOnce(
      (call: { call_id: string }) =>
        new Promise((resolve) => {
          answer = (output) => resolve({ call_id: call.call_id, output });
        }),
    );
    await answeredTurn(test, "Send it?");
    const send = (callId: string) => ({
      type: "function_calls" as const,
      update: false,
      calls: [
        {
          callId,
          name: "send_email_canvas",
          arguments: '{"document_id":"d","confirmed":true}',
        },
      ],
    });
    // The question takes long to prepare; the user says yes meanwhile.
    test.session().emit(send("call-ask"));
    await vi.waitFor(() =>
      expect(test.client.executeLiveToolCall).toHaveBeenCalledOnce(),
    );
    test.session().emit({ type: "speech_started", itemId: "item-b" });
    answer('{"status":"needs_confirmation","summary":"Send it"}');
    await vi.waitFor(() =>
      expect(test.session().sendToolResults).toHaveBeenCalled(),
    );
    // The same reply now sends: in the turn of the user's yes, not the ask's.
    test.session().emit(send("call-yes"));
    await vi.waitFor(() =>
      expect(test.client.executeLiveToolCall).toHaveBeenLastCalledWith(
        expect.objectContaining({ call_id: "call-yes", turn_id: turnB }),
        expect.anything(),
      ),
    );
    expect(test.client.executeLiveToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ call_id: "call-ask", turn_id: turnA }),
      expect.anything(),
    );
    await test.shutdown();
  });

  it("waits for a write the user said yes to past the usual tool budget", async () => {
    const test = await harness({ toolTimeoutMs: 50 });
    // TeamHub answers in 150 ms; the client gives up when the signal aborts.
    test.client.executeLiveToolCall.mockImplementation(
      (call: { call_id: string }, signal?: AbortSignal) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () =>
              resolve({ call_id: call.call_id, output: '{"status":"sent"}' }),
            150,
          );
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(signal.reason);
          });
        }),
    );
    await answeredTurn(test, "OK, sent.");
    const send = (callId: string, confirmed: boolean) =>
      test.session().emit({
        type: "function_calls",
        update: false,
        calls: [
          {
            callId,
            name: "send_slack",
            arguments: JSON.stringify({ text: "hi", confirmed }),
          },
        ],
      });
    send("call-ask", false);
    await vi.waitFor(() =>
      expect(test.session().sendToolResults).toHaveBeenCalledWith(
        [{ callId: "call-ask", output: '{"error":"tool_failed"}' }],
        expect.anything(),
      ),
    );
    send("call-yes", true);
    await vi.waitFor(() =>
      expect(test.session().sendToolResults).toHaveBeenCalledWith(
        [{ callId: "call-yes", output: '{"status":"sent"}' }],
        expect.anything(),
      ),
    );
    await test.shutdown();
  });

  it("lets the model finish a line it broke off before starting work", async () => {
    const test = await harness({
      toolOutput: () => '{"status":"started","task_id":"t1"}',
    });
    await answeredTurn(test, "Well, for selling pet supplies overseas,");
    await startTask(test);
    expect(test.session().sendToolResults).toHaveBeenCalledWith(
      [{ callId: "call-start", output: '{"status":"started","task_id":"t1"}' }],
      { reply: true },
    );
    await test.shutdown();
  });

  it("answers a refused hand-off and tracks no task", async () => {
    const test = await harness({
      toolOutput: () => '{"error":"no_computer"}',
    });
    test.session().emit(
      {
        type: "transcript_completed",
        itemId: "item-a",
        text: "Check my WeChat",
      },
      { type: "response_started" },
    );
    await vi.waitFor(() => expect(test.ofType("user_turn")).toHaveLength(1));
    await startTask(test);
    expect(test.session().sendToolResults).toHaveBeenCalledWith(
      [{ callId: "call-start", output: '{"error":"no_computer"}' }],
      { reply: true },
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(test.session().tell).not.toHaveBeenCalled();
    await test.shutdown();
  });

  it("asks the browser to read and operate the page", async () => {
    const test = await harness();
    await answeredTurn(test);
    test.session().emit({
      type: "function_calls",
      update: false,
      calls: [
        {
          callId: "p1",
          name: "page_action",
          arguments: '{"action":"click","target":"e1"}',
        },
        { callId: "r1", name: "read_page", arguments: '{"focus":"Wang"}' },
      ],
    });
    await vi.waitFor(() => expect(test.ofType("tool_request")).toHaveLength(2));
    expect(test.ofType("tool_request")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "page_action",
          call_id: "p1",
          text: '{"action":"click","target":"e1","confirmed":false}',
        }),
        expect.objectContaining({
          tool: "read_page",
          call_id: "r1",
          text: "Wang",
        }),
      ]),
    );
    test.send({
      type: "tool_result",
      call_id: "p1",
      text: '{"status":"done"}',
    });
    test.send({ type: "tool_result", call_id: "r1", text: '{"page":"..."}' });
    await vi.waitFor(() =>
      expect(test.session().sendToolResults).toHaveBeenCalledOnce(),
    );
    expect(test.session().sendToolResults.mock.calls[0]![1]).toEqual({
      reply: true,
    });
    await test.shutdown();
  });

  it("clicks a risky target only after the user's yes in a later turn, once", async () => {
    const test = await harness();
    const click = (turn: string, callId: string) => {
      test.session().emit(
        { type: "transcript_completed", itemId: turn, text: "Click send" },
        { type: "response_started" },
        {
          type: "function_calls",
          update: false,
          calls: [
            {
              callId,
              name: "page_action",
              arguments: '{"action":"click","target":"Send","confirmed":true}',
            },
          ],
        },
      );
    };
    const forwarded = async (
      callId: string,
      output = '{"status":"needs_confirmation"}',
    ) => {
      await vi.waitFor(() =>
        expect(
          test.ofType("tool_request").some((event) => event.call_id === callId),
        ).toBe(true),
      );
      const request = test
        .ofType("tool_request")
        .find((event) => event.call_id === callId)!;
      test.send({ type: "tool_result", call_id: callId, text: output });
      await vi.waitFor(() =>
        expect(test.session().sendToolResults).toHaveBeenCalledWith(
          [{ callId, output }],
          expect.anything(),
        ),
      );
      test.session().emit({ type: "response_finished", canceled: false });
      return JSON.parse(String(request.text)).confirmed;
    };
    click("item-a", "p1");
    // The model's own yes in the turn that asked is not the user's.
    expect(await forwarded("p1")).toBe(false);
    click("item-b", "p2");
    expect(await forwarded("p2", '{"status":"done"}')).toBe(true);
    click("item-c", "p3");
    expect(await forwarded("p3")).toBe(false);
    await test.shutdown();
  });

  it("keeps talking through a slow local browser step and tells its page later", async () => {
    const test = await harness({ browserStepBudgetMs: 20 });
    let finish: (output: string) => void = () => undefined;
    test.client.executeLiveToolCall.mockImplementationOnce(
      (call: { call_id: string }) =>
        new Promise((resolve) => {
          finish = (output) => resolve({ call_id: call.call_id, output });
        }),
    );
    await answeredTurn(test);
    test.session().emit({
      type: "function_calls",
      update: false,
      calls: [
        {
          callId: "b1",
          name: "computer_browser",
          arguments: '{"action":"open","url":"jd.com"}',
        },
      ],
    });
    await vi.waitFor(() =>
      expect(test.session().sendToolResults).toHaveBeenCalledOnce(),
    );
    expect(
      test.session().sendToolResults.mock.calls[0]![0][0].output,
    ).toContain("still_working");
    test.session().emit({ type: "response_finished", canceled: false });
    finish('{"page":"JD home page [ref=e1]"}');
    await vi.waitFor(() =>
      expect(
        test
          .session()
          .note.mock.calls.some((call) =>
            String(call[0]).includes("JD home page"),
          ),
      ).toBe(true),
    );
    await vi.waitFor(() => expect(test.session().tell).toHaveBeenCalledOnce());
    expect(test.session().tell.mock.calls[0]![0]).toContain(
      "local browser step you were waiting for has finished",
    );
    await test.shutdown();
  });

  it("changes the reply speed for this call only and keeps it across a reconnect", async () => {
    const test = await harness();
    await answeredTurn(test);
    test.session().emit({
      type: "function_calls",
      update: false,
      calls: [{ callId: "s1", name: "set_speed", arguments: '{"speed":1.2}' }],
    });
    await vi.waitFor(() =>
      expect(test.session().setSpeed).toHaveBeenCalledWith(1.2),
    );
    test.session().fail(new LiveSessionError("live_socket_closed", true));
    await vi.waitFor(() => expect(test.sessions).toHaveLength(2));
    await vi.waitFor(() =>
      expect(test.session().setSpeed).toHaveBeenCalledWith(1.2),
    );
    await test.shutdown();
  });

  it("pauses the reply for local speech and stops it when server VAD confirms", async () => {
    const test = await harness();
    await answeredTurn(test);
    await vi.waitFor(() => expect(test.source().frames).toHaveLength(2));
    // Both frames are still in the track's queue, unheard.
    test.source().queued = 400;
    // The fake VAD hears 32 ms of speech per frame; 200 ms pauses the reply.
    for (let index = 0; index < 6; index++) test.track.frame(1);
    await vi.waitFor(() => expect(test.session().audio).toHaveLength(6));
    expect(test.source().clears).toBe(0);
    test.track.frame(1);
    await vi.waitFor(() => expect(test.source().clears).toBe(1));
    expect(test.ofType("reply_interrupted")).toHaveLength(0);
    expect(test.session().cancel).not.toHaveBeenCalled();
    test.session().emit({ type: "speech_started", itemId: "item-b" });
    await vi.waitFor(() =>
      expect(test.ofType("reply_interrupted")).toHaveLength(1),
    );
    expect(test.session().cancel).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(test.client.reportLiveReply).toHaveBeenCalledOnce(),
    );
    expect(test.client.reportLiveReply.mock.calls[0]![0]).toMatchObject({
      text: "reply",
      interrupted: true,
    });
    // Neither the audio the pause held nor audio still in flight from the
    // cancelled response is played.
    test.session().emit({ type: "audio_delta", pcm: pcm(480) });
    await test.shutdown();
    expect(test.source().frames).toHaveLength(2);
  });

  it("resumes an unconfirmed pause where the listener stopped hearing, and pauses that reply no more", async () => {
    const test = await harness();
    await answeredTurn(test);
    await vi.waitFor(() => expect(test.source().frames).toHaveLength(2));
    const played = test.source().frames.slice();
    test.source().queued = 400;
    for (let index = 0; index < 7; index++) test.track.frame(1);
    await vi.waitFor(() => expect(test.source().clears).toBe(1));
    // 400 ms of local quiet, such as the end of the reply's own echo.
    for (let index = 0; index < 12; index++) test.track.frame(0);
    await vi.waitFor(() => expect(test.session().audio).toHaveLength(19));
    expect(test.source().frames).toHaveLength(2);
    test.track.frame(0);
    await vi.waitFor(() => expect(test.source().frames).toHaveLength(4));
    expect(test.source().frames.slice(2)).toEqual(played);
    // More of the same reply, and more local speech over it: only server
    // VAD stops this reply now.
    test.session().emit({ type: "audio_delta", pcm: pcm(960) });
    await vi.waitFor(() => expect(test.source().frames).toHaveLength(6));
    test.source().queued = 400;
    for (let index = 0; index < 12; index++) test.track.frame(1);
    // The microphone onset held while gated goes out too; count the speech.
    await vi.waitFor(() =>
      expect(
        test.session().audio.filter((frame) => frame[0] === 1),
      ).toHaveLength(19),
    );
    expect(test.source().clears).toBe(1);
    expect(test.ofType("reply_interrupted")).toHaveLength(0);
    expect(test.session().cancel).not.toHaveBeenCalled();
    await test.shutdown();
  });

  it("sends silence after a moment of local quiet and the held onset when speech resumes", async () => {
    const test = await harness();
    const start = test.session().audio.length;
    const frames = async (value: number, count: number) => {
      const sent = test.session().audio.length;
      for (let index = 0; index < count; index++) test.track.frame(value);
      await vi.waitFor(() =>
        expect(test.session().audio.length).toBeGreaterThanOrEqual(
          sent + count,
        ),
      );
    };
    // The fake detector hears speech in frames of 1; 2 is room noise. Each
    // frame is one 512-sample window, so the tenth quiet one passes 300 ms.
    await frames(1, 5);
    await frames(2, 12);
    await frames(1, 1);
    const sent = test
      .session()
      .audio.slice(start)
      .map((frame) => frame[0]);
    expect(sent).toEqual([
      ...Array(5).fill(1),
      ...Array(9).fill(2),
      ...Array(3).fill(0),
      // The noise held while gated goes first, then the speech.
      ...Array(3).fill(2),
      1,
    ]);
    expect(test.session().audio.at(-5)).toEqual(new Int16Array(320));
    await test.shutdown();
  });
  it("asks for a reply when server VAD ends a turn and none starts", async () => {
    vi.useFakeTimers();
    const test = await harness();
    test.session().emit({
      type: "transcript_completed",
      itemId: "item-a",
      text: "Let me think, check today's schedule for me",
    });
    await vi.advanceTimersByTimeAsync(2_400);
    expect(test.session().respond).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(test.session().respond).toHaveBeenCalledOnce();
    // A turn the model answers needs no nudge.
    test
      .session()
      .emit(
        { type: "transcript_completed", itemId: "item-b", text: "What else" },
        { type: "response_started" },
      );
    await vi.advanceTimersByTimeAsync(3_000);
    expect(test.session().respond).toHaveBeenCalledOnce();
    await test.shutdown();
  });

  it("retries a reply report while the Human turn is not yet saved", async () => {
    const test = await harness();
    test.client.reportLiveReply
      .mockRejectedValueOnce(new TeamHubVoiceRuntimeError(409))
      .mockResolvedValueOnce({ event_id: "e", status: "accepted" });
    await answeredTurn(test);
    test.session().emit({ type: "response_finished", canceled: false });
    await vi.waitFor(
      () => expect(test.client.reportLiveReply).toHaveBeenCalledTimes(2),
      { timeout: 2_000 },
    );
    await test.shutdown();
  });

  it("forwards page context from the publisher only, as a note", async () => {
    const test = await harness();
    test.send({ type: "context", text: "On the Pocket Note page" });
    test.send(
      { type: "context", text: "Impostor" },
      { identity: "someone-else" },
    );
    await vi.waitFor(() => expect(test.session().note).toHaveBeenCalledOnce());
    expect(test.session().note).toHaveBeenCalledWith("On the Pocket Note page");
    await test.shutdown();
  });

  it("forwards publisher microphone mute state only", async () => {
    const test = await harness();
    test.room.emit("muted", { source: 1 }, { identity: "someone-else" });
    test.room.emit("muted", { source: 1 }, publisher);
    test.room.emit("unmuted", { source: 1 }, publisher);
    expect(test.session().mute).toHaveBeenCalledOnce();
    expect(test.session().unmute).toHaveBeenCalledOnce();
    await test.shutdown();
  });

  it("reconnects once on a transient loss and fails the session after that", async () => {
    const test = await harness();
    test.session().fail(new LiveSessionError("live_socket_closed", true));
    await vi.waitFor(() => expect(test.sessions).toHaveLength(2));
    test.session().fail(new LiveSessionError("live_socket_closed", true));
    await vi.waitFor(() =>
      expect(test.ofType("session_failure")).toEqual([
        { type: "session_failure", code: "live_socket_closed" },
      ]),
    );
    await test.shutdown();
  });

  it("ends the job when the publisher leaves", async () => {
    const test = await harness();
    test.room.emit("left", publisher);
    expect(test.ctx.shutdown).toHaveBeenCalledWith("voice publisher left");
    await test.shutdown();
  });
});

describe("LiveVoiceWorker background work", () => {
  const started = () => '{"status":"started","task_id":"t1"}';
  const done = (text = "Notion is 10 dollars, Linear is 8 dollars."): Task => ({
    task_id: "t1",
    started_in_this_call: true,
    goal: "Research three vendors' pricing",
    surface: "workspace",
    state: "reported",
    replies: [{ message_id: "m1", text }],
  });

  /** A turn whose quiet hand-off already finished, with nothing playing. */
  async function handedOff(test: Test) {
    await answeredTurn(test, "Let me check.");
    await startTask(test);
    test.session().emit({ type: "response_finished", canceled: false });
    await vi.waitFor(() => expect(test.ofType("reply_done")).toHaveLength(1));
    await vi.waitFor(() =>
      expect(test.client.listLiveTasks).toHaveBeenCalled(),
    );
  }

  it("tells an approval wait without the usual pause, a report after it", async () => {
    const test = await harness({ toolOutput: started, updateGapMs: 60_000 });
    await handedOff(test);
    test.setTasks([{ ...done(), state: "waiting_for_approval", replies: [] }]);
    await vi.waitFor(() => expect(test.session().tell).toHaveBeenCalledOnce());
    expect(test.session().tell.mock.calls[0]![0]).toContain("approve");
    test.setTasks([done()]);
    await new Promise((resolve) => setTimeout(resolve, 80));
    // The report waits for the pause after the last words.
    expect(test.session().tell).toHaveBeenCalledOnce();
    await test.shutdown();
  });

  it("stops the Live foreground when TeamHub fences its lease", async () => {
    const test = await harness();
    test.client.listLiveTasks.mockRejectedValue(
      new TeamHubVoiceRuntimeError(404),
    );
    test.hint();
    await vi.waitFor(() =>
      expect(test.ofType("session_failure")).toContainEqual(
        expect.objectContaining({ code: "live_lease_lost" }),
      ),
    );
    expect(test.ctx.shutdown).toHaveBeenCalled();
  });

  it("reads the tasks the moment TeamHub hints a change", async () => {
    const test = await harness({ toolOutput: started, tasksPollMs: 60_000 });
    await handedOff(test);
    const reads = test.client.listLiveTasks.mock.calls.length;
    test.setTasks([done()]);
    test.hint();
    await vi.waitFor(() =>
      expect(test.client.listLiveTasks.mock.calls.length).toBeGreaterThan(
        reads,
      ),
    );
    await vi.waitFor(() => expect(test.session().note).toHaveBeenCalledOnce());
    await test.shutdown();
  });

  it("notes every report and tells it at once for the live voice to judge", async () => {
    const test = await harness({ toolOutput: started });
    await handedOff(test);
    const scan = {
      message_id: "r0",
      text: "Log in with Feishu by scanning the QR code",
    };
    test.setTasks([{ ...done(), replies: [scan] }]);
    await vi.waitFor(() => expect(test.session().note).toHaveBeenCalledOnce());
    expect(test.session().note.mock.calls[0]![0]).toContain(
      "scanning the QR code",
    );
    expect(test.session().note.mock.calls[0]![0]).toContain(
      "not something the user said",
    );
    await vi.waitFor(() => expect(test.session().tell).toHaveBeenCalledOnce());
    expect(test.session().tell.mock.calls[0]![0]).toContain(
      "ask them that plainly",
    );
    expect(test.session().tell.mock.calls[0]![0]).toContain(
      "You finished saying something else a moment ago",
    );
    // The same report again adds nothing; each report is told once.
    test.setTasks([{ ...done(), replies: [scan] }]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(test.session().note).toHaveBeenCalledOnce();
    expect(test.session().tell).toHaveBeenCalledOnce();
    // Its words get their own bubble, apart from the turn's reply.
    test.session().emit(
      {
        type: "text_delta",
        text: "By the way, the pricing is ready.",
        update: true,
      },
      { type: "audio_started", update: true },
      { type: "audio_delta", pcm: pcm(480) },
      { type: "response_finished", canceled: false },
    );
    await vi.waitFor(() =>
      expect(test.ofType("speech_started")).toHaveLength(1),
    );
    await vi.waitFor(() =>
      expect(test.ofType("reply_done").at(-1)).toMatchObject({
        speech_id: test.ofType("speech_started")[0]!.speech_id,
        text: "By the way, the pricing is ready.",
      }),
    );
    expect(test.client.reportLiveReply).toHaveBeenCalledOnce();
    await test.shutdown();
  });

  it("tells a report that first reads and publishes its result as one update, once", async () => {
    const test = await harness({
      toolOutput: (call) =>
        call.name === "start_task" ? started() : '{"status":"delivered"}',
    });
    await handedOff(test);
    const turnReplies = test.ofType("reply_done").length;
    test.setTasks([done()]);
    await vi.waitFor(() => expect(test.session().tell).toHaveBeenCalledOnce());
    // The update's first response only publishes the result.
    test.session().emit(
      {
        type: "function_calls",
        update: true,
        calls: [
          { callId: "publish", name: "publish_task_result", arguments: "{}" },
        ],
      },
      { type: "response_finished", canceled: false },
    );
    await vi.waitFor(() =>
      expect(test.session().sendToolResults).toHaveBeenLastCalledWith(
        [{ callId: "publish", output: '{"status":"delivered"}' }],
        { reply: true },
      ),
    );
    // Its words come after the results, later than an update that never
    // started would be given up (a publication can upload files for long).
    await new Promise((resolve) => setTimeout(resolve, 400));
    test.session().emit(
      {
        type: "text_delta",
        text: "Done, Notion is 10 dollars.",
        update: true,
      },
      { type: "audio_started", update: true },
      { type: "audio_delta", pcm: pcm(480) },
      { type: "response_finished", canceled: false },
    );
    await vi.waitFor(() =>
      expect(test.ofType("reply_done").at(-1)).toMatchObject({
        speech_id: test.ofType("speech_started")[0]!.speech_id,
        text: "Done, Notion is 10 dollars.",
      }),
    );
    // Told once, and the earlier turn's answer is not ended again.
    expect(test.session().tell).toHaveBeenCalledOnce();
    expect(test.ofType("speech_started")).toHaveLength(1);
    expect(test.ofType("reply_done")).toHaveLength(turnReplies + 1);
    await test.shutdown();
  });

  it("follows a short answer once it was heard and a short pause passed", async () => {
    const test = await harness({ toolOutput: started, updateGapMs: 300 });
    await handedOff(test);
    // A new short exchange is playing when the result lands.
    test.source().holdFrames();
    test.session().emit(
      {
        type: "transcript_completed",
        itemId: "item-b",
        text: "What day is it",
      },
      { type: "response_started" },
      { type: "text_delta", text: "Monday.", update: false },
      { type: "audio_started", update: false },
      { type: "audio_delta", pcm: pcm(24_000) },
      { type: "response_finished", canceled: false },
    );
    await vi.waitFor(() => expect(test.ofType("reply_done")).toHaveLength(2));
    test.setTasks([done()]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(test.session().tell).not.toHaveBeenCalled();
    test.source().releaseFrames();
    const heard = Date.now();
    await vi.waitFor(() => expect(test.session().tell).toHaveBeenCalledOnce());
    expect(Date.now() - heard).toBeGreaterThanOrEqual(250);
    expect(test.session().tell.mock.calls[0]![0]).toContain(
      "You finished saying something else a moment ago",
    );
    expect(test.session().cancel).not.toHaveBeenCalled();
    await test.shutdown();
  });

  it("waits for a long answer to end before saying a finished task", async () => {
    const test = await harness({ toolOutput: started });
    await handedOff(test);
    test.source().holdFrames();
    test.session().emit(
      {
        type: "transcript_completed",
        itemId: "item-b",
        text: "Tell me about per-seat pricing",
      },
      { type: "response_started" },
      { type: "text_delta", text: "First sentence.", update: false },
      { type: "audio_started", update: false },
      { type: "audio_delta", pcm: pcm(24_000) },
      { type: "audio_delta", pcm: silence(4_800) },
      { type: "audio_delta", pcm: pcm(240_000) },
    );
    await vi.waitFor(() => expect(test.ofType("reply_delta")).toHaveLength(1));
    test.setTasks([done()]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(test.session().tell).not.toHaveBeenCalled();
    test.session().emit({ type: "response_finished", canceled: false });
    // Still being heard: the update waits for the end of the audio.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(test.session().tell).not.toHaveBeenCalled();
    test.source().releaseFrames();
    await vi.waitFor(() => expect(test.session().tell).toHaveBeenCalledOnce());
    expect(test.session().tell.mock.calls[0]![0]).toContain(
      "You finished saying something else a moment ago",
    );
    expect(test.session().cancel).not.toHaveBeenCalled();
    await test.shutdown();
  });

  it("says a failed task right after the answer under way, never cutting it", async () => {
    const test = await harness({ toolOutput: started });
    await handedOff(test);
    test.source().holdFrames();
    test.session().emit(
      {
        type: "transcript_completed",
        itemId: "item-b",
        text: "What day is it",
      },
      { type: "response_started" },
      { type: "text_delta", text: "Today is Monday,", update: false },
      { type: "audio_started", update: false },
      { type: "audio_delta", pcm: pcm(12_000) },
      { type: "audio_delta", pcm: silence(4_800) },
      { type: "audio_delta", pcm: pcm(12_000) },
    );
    await vi.waitFor(() => expect(test.ofType("reply_delta")).toHaveLength(2));
    test.setTasks([{ ...done(), state: "failed", replies: [] }]);
    // Its rest, such as a search result, would be lost if cut now.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(test.session().tell).not.toHaveBeenCalled();
    test.session().emit({ type: "response_finished", canceled: false });
    // Still being heard: the update waits for the end of the audio.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(test.session().tell).not.toHaveBeenCalled();
    test.source().releaseFrames();
    await vi.waitFor(() => expect(test.session().tell).toHaveBeenCalledOnce());
    expect(test.session().tell.mock.calls[0]![0]).toContain(
      "stopped without finishing",
    );
    expect(test.session().tell.mock.calls[0]![0]).toContain(
      "You finished saying something else a moment ago",
    );
    expect(test.session().cancel).not.toHaveBeenCalled();
    await test.shutdown();
  });

  it("tells an update again when the provider never started it, then gives it up", async () => {
    const test = await harness();
    test.setAlerts([{ alert_id: "a1", text: "Lisa @you" }]);
    await vi.waitFor(
      () => expect(test.session().tell).toHaveBeenCalledTimes(3),
      {
        timeout: 3_000,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(test.session().tell).toHaveBeenCalledTimes(3);
    await test.shutdown();
  });

  it("says an event that comes before the user said anything", async () => {
    const test = await harness();
    test.setAlerts([{ alert_id: "a1", text: "Lisa @you" }]);
    await vi.waitFor(() => expect(test.session().tell).toHaveBeenCalledOnce());
    test
      .session()
      .emit(
        { type: "text_delta", text: "Lisa is looking for you.", update: true },
        { type: "audio_started", update: true },
        { type: "audio_delta", pcm: pcm(960) },
      );
    await vi.waitFor(() =>
      expect(test.ofType("speech_started")).toEqual([
        expect.objectContaining({ text: "Lisa is looking for you." }),
      ]),
    );
    await test.shutdown();
  });

  it("does not ask again for a reply the provider started before the transcript", async () => {
    const test = await harness();
    test.session().emit(
      { type: "speech_started", itemId: "item-a" },
      { type: "response_started" },
      {
        type: "transcript_completed",
        itemId: "item-a",
        text: "Reply to her for me",
      },
    );
    await vi.waitFor(() => expect(test.ofType("user_turn")).toHaveLength(1));
    // Past the wait for a swallowed turn.
    await new Promise((resolve) => setTimeout(resolve, 2_800));
    expect(test.session().respond).not.toHaveBeenCalled();
    await test.shutdown();
  }, 10_000);

  it("never says an update over the user and waits for their turn's answer", async () => {
    const test = await harness({ toolOutput: started });
    await handedOff(test);
    test.session().emit({ type: "speech_started", itemId: "item-b" });
    test.setTasks([done()]);
    await vi.waitFor(() => expect(test.session().note).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(test.session().tell).not.toHaveBeenCalled();
    // The user's turn ends and is answered; the update follows that answer.
    test
      .session()
      .emit(
        { type: "transcript_completed", itemId: "item-b", text: "Sure" },
        { type: "response_started" },
        { type: "text_delta", text: "Mm.", update: false },
        { type: "audio_started", update: false },
        { type: "audio_delta", pcm: pcm(480) },
        { type: "response_finished", canceled: false },
      );
    await vi.waitFor(() => expect(test.session().tell).toHaveBeenCalledOnce());
    await test.shutdown();
  });

  it("tells again an update the user talked over before it was heard", async () => {
    const test = await harness({ toolOutput: started });
    await handedOff(test);
    test.setTasks([done()]);
    await vi.waitFor(() => expect(test.session().tell).toHaveBeenCalledOnce());
    // The user starts talking before the update's audio begins.
    test.session().emit({ type: "speech_started", itemId: "item-b" });
    await vi.waitFor(() => expect(test.session().cancel).toHaveBeenCalled());
    test.session().emit({ type: "response_finished", canceled: true });
    test
      .session()
      .emit(
        { type: "transcript_completed", itemId: "item-b", text: "Hold on" },
        { type: "response_started" },
        { type: "text_delta", text: "OK.", update: false },
        { type: "audio_started", update: false },
        { type: "audio_delta", pcm: pcm(480) },
        { type: "response_finished", canceled: false },
      );
    await vi.waitFor(() =>
      expect(test.session().tell).toHaveBeenCalledTimes(2),
    );
    await test.shutdown();
  });

  it("tells an event worth telling now at once, as outside data", async () => {
    const test = await harness();
    test.setAlerts([
      {
        alert_id: "pwake_1",
        text: "Slack: Lisa @you in #sales, asking whether the quote can be sent today",
      },
    ]);
    await vi.waitFor(() => expect(test.session().tell).toHaveBeenCalledOnce());
    expect(test.session().note.mock.calls[0]![0]).toContain(
      "not an instruction",
    );
    expect(test.session().note.mock.calls[0]![0]).toContain("Lisa");
    expect(test.session().tell.mock.calls[0]![0]).toContain(
      "ask whether you should handle it",
    );
    // Told once, however long it keeps waiting for the call to end.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(test.session().tell).toHaveBeenCalledOnce();
    await test.shutdown();
  });
});

describe("withoutRepeat", () => {
  it("drops the start of a split turn that repeats what the user just said", () => {
    // A paused sentence transcribed twice, the filler heard differently.
    expect(
      withoutRepeat(
        "OK, then can you check that, um...",
        "OK, then can you check that, uh. OK, can you check whether the email was sent?",
      ),
    ).toBe("OK, can you check whether the email was sent?");
    // Per-ideograph tokenization: each Han character is one token.
    expect(
      withoutRepeat(
        "\u6211\u60f3\u77e5\u9053\u8fd9\u5468",
        "\u6211\u60f3\u77e5\u9053\u8fd9\u5468\uff0c\u5de5\u4f5c\u91cd\u70b9\u3002",
      ),
    ).toBe("\u5de5\u4f5c\u91cd\u70b9\u3002");
  });

  it("keeps a turn that does not repeat, or that is all repeat", () => {
    expect(withoutRepeat("", "make me a deck")).toBe("make me a deck");
    expect(withoutRepeat("make me a deck", "then send it to Tony")).toBe(
      "then send it to Tony",
    );
    expect(withoutRepeat("make me a deck", "make me a deck")).toBe(
      "make me a deck",
    );
  });

  it("keeps a short repeat whose filler exceeds the tolerance", () => {
    expect(
      withoutRepeat("um, my week.", "uh, my week, what matters at work."),
    ).toBe("uh, my week, what matters at work.");
  });
});

describe("toDetectorRate", () => {
  it("turns a 24 kHz frame into the 16 kHz the local VAD reads", () => {
    const out = toDetectorRate(Int16Array.from([0, 30, 60, 90, 120, 150]));
    expect(Array.from(out)).toEqual([0, 45, 90, 135]);
    expect(toDetectorRate(new Int16Array(480))).toHaveLength(320);
  });
});
