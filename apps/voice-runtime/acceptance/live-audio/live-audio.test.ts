// Audio-path acceptance for Live Voice Mode. The real LiveVoiceWorker, xAI
// session and Silero barge-in VAD run against speech synthesized with macOS
// `say`, streamed in real time like a microphone; LiveKit is replaced by a track and an output that plays in real
// time, and TeamHub by in-memory tasks and tool results. It measures what
// text runs cannot: turns cut by pauses, swallowed turns, barge-in, and when
// background updates are actually heard. Results go to
// .linger-runtime/live-audio/; only aggregated metrics are printed.
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { JobContext } from "@livekit/agents";
import { afterAll, describe, it, vi } from "vitest";

const rtc = vi.hoisted(() => {
  const now = () => performance.now();
  class Track {
    sid = "TR-mic";
    controller!: ReadableStreamDefaultController<unknown>;
    stream = new ReadableStream({
      start: (controller) => {
        this.controller = controller;
      },
    });
    push(data: Int16Array) {
      this.controller.enqueue({
        data,
        samplesPerChannel: data.length,
        sampleRate: 16_000,
        channels: 1,
      });
    }
    closeAudioStreams() {}
  }
  /** Plays what it is given in real time, keeping a short lead like rtc-node. */
  class AudioSource {
    playEnd = now();
    frames: Array<{ start: number; end: number; loud: boolean }> = [];
    clears: number[] = [];
    private waiters: Array<() => void> = [];
    get queuedDuration() {
      return Math.max(0, this.playEnd - now());
    }
    async captureFrame(frame: { data: Int16Array }) {
      const start = Math.max(now(), this.playEnd);
      this.playEnd = start + frame.data.length / 24;
      let sum = 0;
      for (const sample of frame.data) sum += sample * sample;
      const loud = Math.sqrt(sum / frame.data.length) > 350;
      this.frames.push({ start, end: this.playEnd, loud });
      const lead = this.playEnd - now() - 200;
      if (lead > 0) await new Promise((resolve) => setTimeout(resolve, lead));
    }
    async waitForPlayout() {
      const wait = this.playEnd - now();
      if (wait <= 0) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, wait);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    clearQueue() {
      const at = now();
      this.clears.push(at);
      this.frames = this.frames.filter((frame) => frame.start < at);
      const last = this.frames.at(-1);
      if (last && last.end > at) last.end = at;
      this.playEnd = at;
      for (const wake of this.waiters.splice(0)) wake();
    }
    async close() {}
  }
  return { Track, AudioSource, now };
});

vi.mock("@livekit/agents", () => ({
  AutoSubscribe: { AUDIO_ONLY: 1 },
  log: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
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
    createAudioTrack: (
      name: string,
      source: InstanceType<typeof rtc.AudioSource>,
    ) => ({ name, source }),
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

import { liveDataTopic, LiveVoiceWorker } from "../../src/live-worker.js";
import { SileroSpeechActivityDetector } from "../../src/voice-activity.js";
import { XaiLiveSession } from "../../src/xai-live.js";

const env = process.env;
// A key of its own keeps test traffic off the one real Live calls use.
const apiKey =
  env.XAI_TEST_API_KEY || env.VOICE_RUNTIME_XAI_LIVE_API_KEY || env.XAI_API_KEY;
const contextFile = env.LIVE_CONTEXT_FILE;
const reps = Number(env.LIVE_AUDIO_REPS || 1);
const only = env.LIVE_AUDIO_ONLY ?? "";
const sessionId = "voice_session_audio";
const publisher = { identity: `publisher-${sessionId}` };

const ttsDir = mkdtempSync(join(tmpdir(), "live-audio-"));
const ttsCache = new Map<string, Int16Array>();
/** The words as 16 kHz mono PCM, spoken by a Mandarin system voice. */
function speech(text: string) {
  let pcm = ttsCache.get(text);
  if (!pcm) {
    const aiff = join(ttsDir, `${ttsCache.size}.aiff`);
    execFileSync("say", ["-v", "Samantha", "-o", aiff, text]);
    const raw = execFileSync(
      "ffmpeg",
      [
        "-loglevel",
        "error",
        "-i",
        aiff,
        "-f",
        "s16le",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-",
      ],
      { maxBuffer: 1 << 26 },
    );
    pcm = new Int16Array(raw.buffer, raw.byteOffset, raw.length / 2).slice();
    ttsCache.set(text, pcm);
  }
  return pcm;
}

interface Task {
  task_id: string;
  started_in_this_call: boolean;
  goal: string;
  surface: "workspace" | "web" | "desktop" | "apps";
  state: "pending" | "working" | "reported" | "failed" | "canceled";
  replies: Array<{ message_id: string; text: string }>;
  steps?: string[];
}
interface Entry {
  t: number;
  kind: string;
  [key: string]: unknown;
}

const page =
  "Page: Product weekly sync (/rooms/r_123)\n[1] Wang (10:12): I updated the budget sheet, everyone check page three";

/** One live call driven by a scripted microphone. */
class Call {
  readonly t0 = rtc.now();
  readonly log: Entry[] = [];
  readonly tasks: Task[] = [];
  alerts: Array<{ alert_id: string; text: string }> = [];
  /** The worker's hint callback: TeamHub's push of a change. */
  changed?: () => void;
  private mic: Int16Array[] = [];
  private pump?: ReturnType<typeof setInterval>;
  private source?: InstanceType<typeof rtc.AudioSource>;
  private shutdown?: () => Promise<void>;
  private room = Object.assign(new EventEmitter(), {
    remoteParticipants: new Map(),
    localParticipant: {
      setAttributes: async () => undefined,
      publishTrack: async (track: {
        source: InstanceType<typeof rtc.AudioSource>;
      }) => {
        this.source = track.source;
        return {};
      },
      publishData: async (payload: Uint8Array) =>
        this.onPublished(JSON.parse(new TextDecoder().decode(payload))),
    },
  });

  at() {
    return Math.round(rtc.now() - this.t0);
  }
  note(kind: string, data: Record<string, unknown> = {}) {
    this.log.push({ t: this.at(), kind, ...data });
  }

  async open() {
    const context = JSON.parse(readFileSync(contextFile!, "utf8")) as {
      instructions: string;
      tools: unknown[];
    };
    let nextTask = 1;
    const client = {
      reportObservation: async (event: { event_id: string }) => ({
        event_id: event.event_id,
        status: "accepted" as const,
      }),
      getLiveContext: async () => ({
        room_id: "room",
        agent_name: "Lev",
        instructions: context.instructions,
        history: [],
        tools: context.tools,
      }),
      reportLiveReply: async (reply: { event_id: string }) => ({
        event_id: reply.event_id,
        status: "accepted" as const,
      }),
      executeLiveToolCall: async (call: {
        call_id: string;
        name: string;
        arguments: string;
      }) => {
        const args = JSON.parse(call.arguments || "{}") as Record<
          string,
          string
        >;
        this.note("tool", { name: call.name, args });
        return {
          call_id: call.call_id,
          output: JSON.stringify(
            this.tool(call.name, args, () => `t${nextTask++}`),
          ),
        };
      },
      listLiveTasks: async () => ({ tasks: this.tasks, alerts: this.alerts }),
      // Like TeamHub, hint every change at once.
      watchLiveTasks: (
        _id: string,
        changed: () => void,
        signal: AbortSignal,
      ) => {
        this.changed = changed;
        changed();
        return new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve()),
        );
      },
    };
    const worker = new LiveVoiceWorker(
      client as never,
      async (setup) => {
        const session = await XaiLiveSession.open({
          apiKey: apiKey!,
          webSocketUrl:
            env.VOICE_RUNTIME_XAI_LIVE_WEBSOCKET_URL ||
            "wss://api.x.ai/v1/realtime",
          model: env.VOICE_RUNTIME_XAI_LIVE_MODEL || "grok-voice-3.0",
          voice: env.VOICE_RUNTIME_XAI_LIVE_VOICE || "ara",
          reasoningEffort: "high",
          setup,
        });
        // Compares another end-of-turn silence without changing the runtime.
        if (env.LIVE_AUDIO_VAD_MS)
          (session as unknown as { send(event: unknown): void }).send({
            type: "session.update",
            session: {
              turn_detection: {
                type: "server_vad",
                silence_duration_ms: Number(env.LIVE_AUDIO_VAD_MS),
              },
            },
          });
        // Provider events that decide turns and replies, for the timeline.
        (session as unknown as { socket: EventEmitter }).socket.on(
          "message",
          (raw: unknown, binary: boolean) => {
            if (binary) return;
            const event = JSON.parse(String(raw)) as Record<string, unknown> & {
              response?: { status?: string };
            };
            if (
              /^(input_audio_buffer\.speech_(started|stopped)|response\.(created|done|output_audio_transcript\.done)|error)$/.test(
                String(event.type),
              )
            )
              this.note("xai", {
                event: event.type,
                ...(event.response?.status
                  ? { status: event.response.status }
                  : {}),
                ...(event.type === "error"
                  ? { error: JSON.stringify(event.error).slice(0, 200) }
                  : {}),
                ...(typeof event.transcript === "string"
                  ? { transcript: event.transcript }
                  : {}),
              });
          },
        );
        const spied = session as unknown as Record<
          string,
          (...args: unknown[]) => unknown
        >;
        for (const method of ["truncate", "tell", "cancel", "respond"]) {
          const original = spied[method]!.bind(session);
          spied[method] = (...args: unknown[]) => {
            this.note(method, {
              args: args.map((arg) => String(arg).slice(0, 400)),
            });
            return original(...args);
          };
        }
        return session;
      },
      { startedAt: Date.now() },
    );
    const ctx = {
      room: this.room,
      job: {
        room: { name: `voice-${sessionId}` },
        metadata: JSON.stringify({
          voice_session_created_at: new Date().toISOString(),
          voice_purpose: "chat_live",
        }),
      },
      connect: async () => undefined,
      addShutdownCallback: (callback: () => Promise<void>) => {
        this.shutdown = callback;
      },
      shutdown: () => undefined,
    } as unknown as JobContext;
    const running = worker.run(ctx);
    const track = new rtc.Track();
    this.room.emit(
      "subscribed",
      track,
      { source: 1 },
      {
        ...publisher,
        attributes: { "linger.voice_generation": "1" },
      },
    );
    // A microphone sends 20 ms frames all the time, silence included.
    let sent = 0;
    const start = rtc.now();
    this.pump = setInterval(() => {
      const due = Math.floor((rtc.now() - start) / 20);
      for (; sent < due; sent++)
        track.push(this.mic.shift() ?? new Int16Array(320));
    }, 10);
    await running;
    await this.wait(
      () =>
        this.log.some((entry) => entry.kind === "ready") ||
        this.source !== undefined,
      15_000,
    );
    await sleep(1_500);
    this.note("ready");
  }

  private tool(
    name: string,
    args: Record<string, string>,
    nextId: () => string,
  ) {
    switch (name) {
      case "start_task": {
        const task_id = nextId();
        this.tasks.push({
          task_id,
          started_in_this_call: true,
          goal: args.goal ?? "",
          surface: (args.surface ?? "workspace") as Task["surface"],
          state: "working",
          replies: [],
        });
        return { status: "started", task_id };
      }
      case "reply_to_task":
        return { status: "passed_on", task_id: args.task_id };
      case "cancel_task":
        return { status: "canceled" };
      case "list_tasks":
        return {
          tasks: this.tasks.map(({ task_id, goal, state }) => ({
            task_id,
            goal,
            state,
          })),
          background_tasks: [],
        };
      case "recall_memory":
        return {
          status: "found",
          bullets: [
            "At the Oct 22 Product weekly sync we set the Q4 launch for December 10; Ray Zhao owns the canary plan",
          ],
        };
      case "append_pocket_note":
        return { status: "saved" };
      case "send_message":
        return {
          status: "needs_confirmation",
          summary: `Will send as you: ${args.text ?? ""}`,
        };
      default:
        return { status: "ok", results: [] };
    }
  }

  private onPublished(event: Record<string, unknown>) {
    const { type } = event;
    if (type === "user_partial") return;
    this.note(String(type), {
      ...(event.speech_id ? { speech: event.speech_id } : {}),
      ...(typeof event.text === "string" ? { text: event.text } : {}),
      ...(event.tool ? { tool: event.tool } : {}),
    });
    if (type !== "tool_request") return;
    const result =
      event.tool === "read_page"
        ? { status: "ok", page, clickable: "e1 Pocket Note" }
        : { status: "done" };
    setTimeout(() => {
      this.room.emit(
        "data",
        new TextEncoder().encode(
          JSON.stringify({
            type: "tool_result",
            call_id: event.call_id,
            text: JSON.stringify(result),
          }),
        ),
        publisher,
        0,
        liveDataTopic,
      );
    }, 50);
  }

  /** Speaks the segments (text, or a silent gap in ms) and resolves when done. */
  async say(...segments: Array<string | number>) {
    this.note("mic_start", {
      text: segments.filter((s) => typeof s === "string").join(" … "),
    });
    for (const segment of segments) {
      const pcm =
        typeof segment === "number"
          ? new Int16Array(segment * 16)
          : speech(segment);
      for (let offset = 0; offset < pcm.length; offset += 320) {
        const frame = new Int16Array(320);
        frame.set(pcm.subarray(offset, offset + 320));
        this.mic.push(frame);
      }
    }
    await this.wait(() => this.mic.length === 0, 60_000);
    this.note("mic_end");
  }

  /** Loud output frames, as heard (cleared audio is dropped). */
  heard() {
    return (this.source?.frames ?? [])
      .filter((frame) => frame.loud)
      .map((frame) => ({
        start: frame.start - this.t0,
        end: frame.end - this.t0,
      }));
  }
  firstSoundAfter(t: number) {
    return this.heard().find((frame) => frame.start >= t)?.start;
  }
  /** Seconds of sound heard in [from, to). */
  soundBetween(from: number, to = Infinity) {
    return (
      this.heard().reduce(
        (sum, frame) =>
          frame.start >= from && frame.start < to
            ? sum + (frame.end - frame.start)
            : sum,
        0,
      ) / 1000
    );
  }
  playing() {
    return (this.source?.queuedDuration ?? 0) > 0;
  }
  /** Waits until the line has been quiet for `quietMs` (output and replies). */
  async settle(quietMs = 2_500, limitMs = 60_000) {
    const deadline = rtc.now() + limitMs;
    let quietSince = rtc.now();
    while (rtc.now() < deadline) {
      const last = this.log.at(-1)?.t ?? 0;
      if (this.playing() || this.at() - last < 300) quietSince = rtc.now();
      if (rtc.now() - quietSince >= quietMs) return;
      await sleep(100);
    }
  }
  async wait(done: () => boolean, limitMs: number) {
    const deadline = rtc.now() + limitMs;
    while (!done()) {
      if (rtc.now() > deadline) return false;
      await sleep(50);
    }
    return true;
  }
  entries(kind: string, from = 0) {
    return this.log.filter((entry) => entry.kind === kind && entry.t >= from);
  }
  /** The live voice's words in replies (and updates) finished after `from`. */
  said(from = 0, update?: boolean) {
    return this.entries("reply_done", from)
      .filter((entry) =>
        update === undefined ? true : Boolean(entry.speech) === update,
      )
      .map((entry) => (typeof entry.text === "string" ? entry.text : ""))
      .join(" ");
  }
  tools(from = 0) {
    return this.entries("tool", from).map(
      (entry) =>
        entry as Entry & { name: string; args: Record<string, string> },
    );
  }
  async close() {
    clearInterval(this.pump);
    await this.shutdown?.().catch(() => undefined);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Result {
  scenario: string;
  rep: number;
  metrics: Record<string, unknown>;
  log: Entry[];
}
const results: Result[] = [];

const slackAlert = {
  alert_id: "a1",
  text: "source: slack; kind: mention\n<event>\nLisa @you in #sales: can I get the quote before end of day? The client is pushing.\n</event>",
};

const pricingReply =
  '## Competitor pricing\n1. **Notion** Plus 10 dollars/user/month, Business 15, AI adds 8.\n2. **Linear** Basic 8, Business 14, Enterprise on request.\n3. **Feishu** Standard free, Business 50 yuan/user/month.\nConclusion: around 12 dollars is competitive for us; the comparison table is in "Competitor pricing comparison".';

function finish(call: Call, id: string) {
  const task = call.tasks.find((item) => item.task_id === id);
  if (!task) return false;
  task.state = "reported";
  task.replies.push({
    message_id: `m-${id}-${task.replies.length}`,
    text: pricingReply,
  });
  call.note("task_done", { id });
  call.changed?.();
  return true;
}

/** Replies that began while the user was still speaking. */
function talkedOver(call: Call, from: number, to: number) {
  return (
    call.heard().filter((frame) => frame.start > from && frame.start < to)
      .length > 0
  );
}

const scenarios: Record<
  string,
  (call: Call) => Promise<Record<string, unknown>>
> = {
  // Turn latency and hand-off from real speech.
  async delegate(call) {
    await call.say("Research pricing for Notion, Linear and Feishu for me");
    const end = call.at();
    await call.settle();
    const first = call.firstSoundAfter(end);
    return {
      firstSoundMs: first === undefined ? null : Math.round(first - end),
      startedTask: call.tools().some((tool) => tool.name === "start_task"),
      answered: first !== undefined,
    };
  },
  // A mid-sentence pause must not cut the request in two or lose its end.
  async pause(call) {
    const start = call.at();
    await call.say(
      "Note in Pocket Note",
      1_200,
      "a meeting with Ray Zhao at three tomorrow afternoon",
    );
    const end = call.at();
    await call.settle();
    const notes = call
      .tools()
      .filter((tool) => tool.name === "append_pocket_note");
    return {
      talkedOver: talkedOver(call, start, end),
      kept: notes.some((tool) =>
        /three|3 ?pm|3:00|15/i.test(JSON.stringify(tool.args)),
      ),
      notes: notes.length,
      answered: call.firstSoundAfter(end) !== undefined,
    };
  },
  // A thinking pause before the real request.
  async think(call) {
    const start = call.at();
    await call.say(
      "Um, let me think",
      1_800,
      "what is the weather in Shanghai today",
    );
    const end = call.at();
    await call.settle();
    const said = call.said(start);
    return {
      talkedOver: talkedOver(call, start, end),
      answeredWeather: /degree|sunny|rain|cloud|weather/i.test(said),
      answered: call.firstSoundAfter(end) !== undefined,
    };
  },
  // A result arriving while nobody talks is said at once.
  async idleResult(call) {
    await call.say("Research pricing for Notion, Linear and Feishu for me");
    await call.settle();
    const done = call.at();
    const ok = finish(call, "t1");
    await call.settle(3_000);
    const first = call.firstSoundAfter(done);
    return {
      startedTask: ok,
      resultHeardMs: first === undefined ? null : Math.round(first - done),
      resultSec: +call.soundBetween(done).toFixed(1),
      factsAll:
        /Notion|notion/i.test(call.said(done)) &&
        /feishu/i.test(call.said(done)),
      truncated: call.entries("truncate", done).length,
    };
  },
  // A result arriving during a long answer waits for it and follows it.
  async afterLongAnswer(call) {
    await call.say("Research pricing for Notion, Linear and Feishu for me");
    await call.settle();
    await call.say(
      "Why do so many SaaS products charge per seat? Explain in detail",
    );
    const asked = call.at();
    await call.wait(() => call.firstSoundAfter(asked) !== undefined, 20_000);
    await sleep(2_500);
    const done = call.at();
    finish(call, "t1");
    await call.settle(3_000, 90_000);
    const update = call.entries("speech_started", done)[0];
    const updateText = call.said(done, true);
    return {
      startedTask: call.tasks.length > 0,
      updateHeardMs: update ? update.t - done : null,
      truncated: call.entries("truncate", done).length > 0,
      bridge: /^(by the way|oh|also|btw|quick update)/i.test(updateText.trim()),
      updateSec: update ? +call.soundBetween(update.t).toFixed(1) : 0,
    };
  },
  // The user talks over the live voice; it stops at once.
  async bargeIn(call) {
    await call.say(
      "Explain in detail why so many SaaS products charge per seat",
    );
    const asked = call.at();
    await call.wait(() => call.firstSoundAfter(asked) !== undefined, 20_000);
    await sleep(3_000);
    const start = call.at();
    await call.say("Wait, stop for a moment");
    const end = call.at();
    await call.settle();
    const lastOld = call
      .heard()
      .filter((frame) => frame.start < end)
      .at(-1);
    return {
      interrupted: call.entries("reply_interrupted", start).length > 0,
      stopAfterSpeechMs: lastOld
        ? Math.max(0, Math.round(lastOld.end - start))
        : null,
      responded: call.firstSoundAfter(end) !== undefined,
    };
  },
  // An event from the user's apps is said, then acted on when asked.
  async alert(call) {
    const at = call.at();
    call.alerts = [slackAlert];
    call.changed?.();
    await call.wait(
      () => call.entries("speech_started", at).length > 0,
      12_000,
    );
    await call.settle();
    const heard = call.firstSoundAfter(at);
    const said = call.said(at);
    const asked = call.at();
    await call.say("Reply that she will have it before 5 pm");
    await call.settle(4_000);
    return {
      answered: call.firstSoundAfter(asked) !== undefined,
      alertHeardMs: heard === undefined ? null : Math.round(heard - at),
      namesWho: /Lisa/i.test(said),
      replyRouted:
        call.tools().some((tool) => tool.name === "start_task") ||
        /\?\s*$/.test(call.said(asked)),
    };
  },
  // An event arriving while the user talks waits for their turn, and
  // their turn is still answered.
  async alertWhileTalking(call) {
    const start = call.at();
    const talking = call.say(
      "I am thinking about hiking this weekend, do you think the weather is good",
    );
    await sleep(800);
    call.alerts = [slackAlert];
    call.changed?.();
    await talking;
    const end = call.at();
    await call.wait(
      () => call.entries("speech_started", start).length > 0,
      15_000,
    );
    await call.settle(4_000);
    return {
      talkedOver: talkedOver(call, start, end),
      turnAnswered:
        call.said(end, false).length > 0 ||
        /weather/i.test(call.said(start, true)),
      alertSaid: /Lisa|quote/i.test(call.said(start, true)),
    };
  },
};

describe.skipIf(!apiKey || !contextFile)("live audio", () => {
  SileroSpeechActivityDetector.prewarm();
  afterAll(() => {
    const dir = resolve(
      import.meta.dirname,
      "../../../../.linger-runtime/live-audio",
    );
    mkdirSync(dir, { recursive: true });
    const file = join(
      dir,
      `${new Date().toISOString().replace(/[:]/g, "-")}.json`,
    );
    writeFileSync(file, JSON.stringify(results, null, 1));
    const byScenario = new Map<string, Result[]>();
    for (const result of results)
      byScenario.set(result.scenario, [
        ...(byScenario.get(result.scenario) ?? []),
        result,
      ]);
    for (const [scenario, runs] of byScenario) {
      const keys = [
        ...new Set(runs.flatMap((run) => Object.keys(run.metrics))),
      ];
      const summary = keys.map((key) => {
        const values = runs.map((run) => run.metrics[key]);
        if (values.every((value) => typeof value === "boolean"))
          return `${key} ${values.filter(Boolean).length}/${values.length}`;
        return `${key} ${values.join("|")}`;
      });
      process.stdout.write(
        `${scenario} (${runs.length}): ${summary.join("; ")}\n`,
      );
    }
    process.stdout.write(`Timelines: ${file}\n`);
  });
  for (const [name, run] of Object.entries(scenarios))
    for (let rep = 0; rep < reps; rep++)
      it.skipIf(only !== "" && !only.split(",").includes(name)).concurrent(
        `${name} #${rep}`,
        async () => {
          const call = new Call();
          try {
            await call.open();
            const metrics = await run(call);
            results.push({ scenario: name, rep, metrics, log: call.log });
          } catch (error) {
            results.push({
              scenario: name,
              rep,
              metrics: { error: String(error) },
              log: call.log,
            });
          } finally {
            await call.close();
          }
        },
      );
});
