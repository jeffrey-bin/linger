import { randomUUID } from "node:crypto";

import WebSocket from "ws";

import { historyPairs, realtimeInstructions } from "./realtime.js";
import {
  LiveSessionError,
  type LiveEvent,
  type LiveFunctionCall,
  type LiveSession,
  type LiveSetup,
  type LiveTool,
} from "./live-session.js";

// xAI Grok Voice realtime protocol (OpenAI Realtime style).
// https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech
// https://docs.x.ai/developers/rest-api-reference/inference/voice
// Server VAD owns turn ends; the worker's local VAD handles barge-in. Nothing
// here logs; callers receive stable error codes, never provider messages or
// payloads.
export interface XaiLiveConnection {
  apiKey: string;
  webSocketUrl: string;
  model: string;
  voice: string;
  reasoningEffort: "high" | "none";
  audioTransport?: "binary" | "json";
  handshakeTimeoutMs?: number;
  sessionTimeoutMs?: number;
}

/**
 * The session setup, or a promise of it: the socket opens while the caller
 * is still fetching instructions and history, so neither waits for the other.
 */
export type XaiLiveOptions = XaiLiveConnection &
  (LiveSetup | { setup: Promise<LiveSetup> });

/**
 * Grok reads tool names aloud (“let me recall that”, with the tool name in it): the model sees a plain name
 * and its calls map back to the worker's tool name.
 */
export const spokenSafeNames: Record<string, string> = {
  recall_memory: "look_up_past",
};
const workerNames = Object.fromEntries(
  Object.entries(spokenSafeNames).map(([worker, model]) => [model, worker]),
);
/** Instructions and descriptions name tools too; use the model's names. */
export function withModelNames(text: string) {
  let result = text;
  for (const [worker, model] of Object.entries(spokenSafeNames))
    result = result.replaceAll(worker, model);
  return result;
}

/**
 * Server-side tools xAI runs itself: the model searches the web for live
 * facts such as the weather in the same reply, instead of a slow hand-off.
 */
const serverTools = [{ type: "web_search" }];
const serverToolNames = new Set(serverTools.map((tool) => tool.type));

// Reply quickly. Against real and paused Chinese speech (2026-11-09) Grok's
// own default split 11 of 12 paused sentences; 400 ms sometimes ends a turn
// mid-sentence, and the split turns are joined without their repeated start.
// LiveKit's on-device end-of-turn model could not tell finished Chinese
// sentences from unfinished ones, so the silence alone decides.
const turnEndSilenceMs = 400;

const minimumSpeed = 0.7;
const maximumSpeed = 1.5;

/**
 * Lets the user change how fast the model talks. The voice itself never
 * changes, and the speed lasts for this call only.
 */
export const xaiSpeedTool: LiveTool = {
  name: "set_speed",
  description:
    "Change how fast I talk, for this call only; the next call is back to normal. Call it when the user asks me to speak faster, slower or at normal speed: 1 is normal, 0.7 slowest, 1.5 fastest, about 0.15 per step faster or slower. It applies from the next sentence; after calling it, briefly ask at the new speed whether this is OK. The voice cannot be changed; when the user wants another voice, say only the speed can be changed right now.",
  parameters: {
    type: "object",
    properties: {
      speed: { type: "number", minimum: minimumSpeed, maximum: maximumSpeed },
    },
    required: ["speed"],
  },
};

function audioConfig(transport: "binary" | "json", speed?: number) {
  return {
    input: {
      format: { type: "audio/pcm", rate: inputRate },
      ...(transport === "binary" ? { transport: "binary" } : {}),
      transcription: { model: "grok-transcribe" },
    },
    output: {
      format: { type: "audio/pcm", rate: 24_000 },
      ...(speed !== undefined ? { speed } : {}),
    },
  };
}

const maximumQueuedEvents = 2_048;
const maximumQueuedBytes = 8 << 20;
const maximumSendBuffer = 1 << 20;
// xAI's native rate. Real speech resampled to 16 kHz lost words: 21.7% MER
// against 15.2% at 24 kHz through the same Opus path (2026-11-09).
export const liveInputRate = 24_000;
const inputRate = liveInputRate;
// Appended on mute so server VAD closes the turn.
const muteSilence = Buffer.alloc(inputRate * 0.7 * 2);

// Grok sometimes writes a tool call as words instead of calling it, in a
// GLM-style markup (`<tool_call>name<arg_key>k</arg_key><arg_value>v…`) or
// as JSON, and would say it aloud.
const markupStart = "<tool_call>";
const markupEnd = "</tool_call>";

/**
 * The call in a tool call written as words, mapped to a known tool; values
 * of non-string parameters are read as JSON, as the markup writes them.
 */
export function textCall(
  body: string,
  tools: ReadonlyMap<string, LiveTool>,
): Omit<LiveFunctionCall, "callId"> | undefined {
  const written = body.trim();
  let name: unknown;
  let args: Record<string, unknown> = {};
  if (written.startsWith("{")) {
    try {
      const call = JSON.parse(written) as {
        name?: unknown;
        arguments?: unknown;
      };
      const value =
        typeof call.arguments === "string"
          ? (JSON.parse(call.arguments) as unknown)
          : (call.arguments ?? {});
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      name = call.name;
      args = value as Record<string, unknown>;
    } catch {
      return;
    }
  } else {
    name = written.split("<", 1)[0]!.trim();
    for (const [, key, value] of written.matchAll(
      /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g,
    ))
      args[key!.trim()] = value;
  }
  if (typeof name !== "string") return;
  const tool = tools.get(workerNames[name] ?? name);
  if (!tool) return;
  const properties = (tool.parameters.properties ?? {}) as Record<
    string,
    { type?: unknown }
  >;
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== "string" || properties[key]?.type === "string")
      continue;
    try {
      args[key] = JSON.parse(value) as unknown;
    } catch {
      /* Kept as written. */
    }
  }
  return { name: tool.name, arguments: JSON.stringify(args) };
}

interface Response {
  id: string;
  /** An update composed with tell(). */
  update: boolean;
  /** Whether it may call tools; an update said with tell() may not. */
  tools: boolean;
  audioStarted: boolean;
  canceled: boolean;
  /** The assistant item this response speaks, for truncation. */
  itemId?: string;
  /** Words that may begin a tool call written out, held with their audio. */
  held: string;
  heldAudio: Int16Array[];
  /** A tool call being written out, up to its closing tag. */
  markup?: string;
  /** It wrote a tool call out: nothing more of it is said or shown. */
  silenced: boolean;
  /** Asked for after a call written as words could not run. */
  retry: boolean;
  /** It called a tool before it ended. */
  called: boolean;
}

export const cutOffNote =
  "The user cut your last reply off before you called any tool: nothing it said you would do (starting a task, sending, opening, changing) has been done. If they still want it, call the tool now.";

export class XaiLiveSession implements LiveSession {
  readonly #audioTransport: "binary" | "json";
  private readonly queue: LiveEvent[] = [];
  private queuedBytes = 0;
  private readonly waiters: Array<() => void> = [];
  private ended = false;
  private closing = false;
  private failure?: LiveSessionError;
  private muted = false;
  private audioCarry = Buffer.alloc(0);
  private response?: Response;
  /**
   * Responses the server creates for tell() calls, and for the results of
   * their tool calls, oldest first: whether each may call tools.
   */
  private readonly pendingUpdates: boolean[] = [];
  /** Calls an update made; the response to their results is the update too. */
  private readonly updateCalls = new Set<string>();
  /** The round whose results are coming back holds an update's calls. */
  private updateRound = false;
  /** The session's tools by worker name, for calls written as words. */
  private tools = new Map<string, LiveTool>();
  /** Calls the model wrote as words, by call ID: their worker tool names. */
  private readonly textCalls = new Map<string, string>();
  /** The next response is the retry of a call written as words. */
  private retrying = false;
  /** The assistant item whose audio plays last, for truncation. */
  private playingItemId?: string;
  /** Calls handed to the worker whose outputs have not come back yet. */
  private readonly pendingCalls = new Set<string>();
  private responseWanted = false;
  /** Input items whose transcript the worker already received as final. */
  private readonly completedInputs = new Set<string>();
  private readonly inputTexts = new Map<string, string>();
  private lastInputId?: string;

  private constructor(
    private readonly socket: WebSocket,
    audioTransport: "binary" | "json" = "binary",
  ) {
    this.#audioTransport = audioTransport;
    socket.on("message", (raw, binary) => {
      if (binary) return;
      let event: unknown;
      try {
        event = JSON.parse(
          Array.isArray(raw)
            ? Buffer.concat(raw).toString("utf8")
            : raw instanceof ArrayBuffer
              ? Buffer.from(raw).toString("utf8")
              : raw.toString("utf8"),
        );
      } catch {
        return void this.fail("live_invalid_frame", false);
      }
      if (!event || typeof event !== "object" || Array.isArray(event))
        return void this.fail("live_invalid_frame", false);
      this.handle(event as Record<string, unknown>);
    });
    socket.on("close", (code: number, reason: Buffer) => {
      if (this.closing) this.end();
      // The close code and reason say why xAI ended the session; they never
      // carry call audio or words.
      else
        this.fail(
          "live_socket_closed",
          true,
          `${code} ${reason.toString("utf8").replace(/\s+/g, " ").slice(0, 120)}`.trim(),
        );
    });
    socket.on("error", () => undefined);
  }

  static async open(options: XaiLiveOptions): Promise<XaiLiveSession> {
    const url = new URL(options.webSocketUrl);
    url.searchParams.set("model", options.model);
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${options.apiKey}` },
      handshakeTimeout: options.handshakeTimeoutMs ?? 5_000,
    });
    // Fetched in parallel with the handshake; awaited once the socket is open.
    const setup: Promise<LiveSetup> =
      "setup" in options ? options.setup : Promise.resolve(options);
    setup.catch(() => undefined);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("unexpected-response", (_request, response) => {
          const status = response.statusCode ?? 0;
          response.resume();
          reject(
            new LiveSessionError(
              `live_http_${status}`,
              status === 429 || status >= 500,
            ),
          );
        });
        socket.once("error", (error) =>
          reject(
            new LiveSessionError(
              /timed? ?out/i.test(error.message)
                ? "live_connect_timeout"
                : "live_connect_failed",
              true,
            ),
          ),
        );
      });
    } catch (error) {
      socket.terminate();
      throw error;
    }
    const session = new XaiLiveSession(socket, options.audioTransport);
    try {
      await session.configure({ ...options, ...(await setup) });
    } catch (error) {
      socket.terminate();
      throw error;
    }
    return session;
  }

  private async configure(options: XaiLiveConnection & LiveSetup) {
    this.tools = new Map(options.tools.map((tool) => [tool.name, tool]));
    const updated = new Promise<void>((resolve, reject) => {
      const settle = (error?: LiveSessionError) => {
        clearTimeout(timer);
        this.socket.off("message", onMessage);
        this.socket.off("close", onClose);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(
        () => settle(new LiveSessionError("live_session_timeout", true)),
        options.sessionTimeoutMs ?? 8_000,
      );
      const onMessage = (raw: WebSocket.RawData) => {
        try {
          const type = (
            JSON.parse(
              Array.isArray(raw)
                ? Buffer.concat(raw).toString("utf8")
                : raw instanceof ArrayBuffer
                  ? Buffer.from(raw).toString("utf8")
                  : raw.toString("utf8"),
            ) as { type?: unknown }
          ).type;
          if (type === "session.updated") settle();
          // An invalid configuration is reported as an error event.
          if (type === "error")
            settle(new LiveSessionError("live_session_rejected", false));
        } catch {
          /* The session handler reports malformed frames. */
        }
      };
      const onClose = () =>
        settle(
          this.failure ?? new LiveSessionError("live_socket_closed", true),
        );
      this.socket.on("message", onMessage);
      this.socket.on("close", onClose);
    });
    this.send({
      type: "session.update",
      session: {
        instructions: withModelNames(
          realtimeInstructions(options.instructions, [
            ...options.tools,
            ...serverTools.map((tool) => ({ name: tool.type })),
          ]),
        ),
        voice: options.voice,
        reasoning: { effort: options.reasoningEffort },
        turn_detection: {
          type: "server_vad",
          silence_duration_ms: turnEndSilenceMs,
        },
        tools: [
          ...options.tools.map((tool) => ({
            type: "function",
            ...tool,
            name: spokenSafeNames[tool.name] ?? tool.name,
            description: withModelNames(tool.description),
          })),
          ...serverTools,
        ],
        audio: audioConfig(this.#audioTransport),
      },
    });
    await updated;
    for (const message of historyPairs(options.history))
      this.send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: message.role,
          content: [
            {
              type: message.role === "user" ? "input_text" : "output_text",
              text: message.text,
            },
          ],
        },
      });
  }

  appendAudio(frame: Int16Array) {
    if (this.muted) return;
    this.#sendAudio(
      Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength),
    );
  }

  mute() {
    if (this.muted) return;
    this.#sendAudio(muteSilence);
    this.muted = true;
  }

  unmute() {
    this.muted = false;
  }

  cancel() {
    const response = this.response;
    if (!response || response.canceled) return;
    // Deltas still in flight for this response are dropped locally.
    response.canceled = true;
    this.send({ type: "response.cancel" });
    // Grok speaks before it calls a tool: a reply cut off while speaking
    // never made the call it announced, though the model remembers saying it.
    // Marked as the user's, like tell(): Grok weighs a system item less.
    if (response.tools && response.audioStarted && !response.called)
      this.send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: `[system] ${cutOffNote}` }],
        },
      });
  }

  /** Asks for a reply when server VAD ended a turn without starting one. */
  respond() {
    this.requestResponse();
  }

  truncate(audioMs: number) {
    if (!this.playingItemId) return;
    this.send({
      type: "conversation.item.truncate",
      item_id: this.playingItemId,
      content_index: 0,
      audio_end_ms: Math.max(0, Math.round(audioMs)),
    });
  }

  /**
   * The cue joins the conversation right before the reply as a marked user
   * item: as response instructions or a system item, Grok answered the
   * latest user turn again instead. It is never saved or shown.
   */
  tell(cue: string, allowTools = false) {
    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `[system] ${cue}` }],
      },
    });
    this.pendingUpdates.push(allowTools);
    this.send({
      type: "response.create",
      response: { tool_choice: allowTools ? "auto" : "none" },
    });
  }

  /** Takes effect at the next response; the one playing keeps its speed. */
  setSpeed(speed: number) {
    if (!(speed >= minimumSpeed && speed <= maximumSpeed)) return false;
    // The whole audio block, so no partial update resets the formats.
    this.send({
      type: "session.update",
      session: { audio: audioConfig(this.#audioTransport, speed) },
    });
    return true;
  }

  /**
   * Adds application context without generating speech. A system item never
   * reads as something the user said, and needs no reply.
   */
  note(text: string) {
    this.system(text);
  }

  private system(text: string) {
    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "system",
        content: [{ type: "input_text", text }],
      },
    });
  }

  sendToolResults(
    results: Array<{ callId: string; output: string }>,
    { reply = true }: { reply?: boolean } = {},
  ) {
    for (const result of results) {
      this.pendingCalls.delete(result.callId);
      if (this.updateCalls.delete(result.callId)) this.updateRound = true;
      // A call written as words has no call item to answer; its result is
      // context, with a reminder of how to call.
      const written = this.textCalls.get(result.callId);
      if (written !== undefined) {
        this.textCalls.delete(result.callId);
        this.system(
          `You wrote a ${spokenSafeNames[written] ?? written} call as words instead of calling the tool. It was run as a call and none of it was said or shown. Its result: ${result.output}\nCall tools only as function calls, never in words or angle brackets.`,
        );
        continue;
      }
      this.send({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: result.callId,
          output: result.output,
        },
      });
    }
    // One response answers every call of a round; an update's round is
    // answered by the update, which goes on in its own words.
    if (results.length === 0 || this.pendingCalls.size > 0) return;
    const update = this.updateRound;
    this.updateRound = false;
    if (!reply) return;
    if (update) this.pendingUpdates.push(true);
    this.requestResponse();
  }

  async *events(): AsyncIterable<LiveEvent> {
    for (;;) {
      const event = this.queue.shift();
      if (event) {
        this.queuedBytes -= eventBytes(event);
        yield event;
        continue;
      }
      if (this.ended) break;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    if (this.failure) throw this.failure;
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    this.socket.close(1000);
    this.end();
  }

  private requestResponse() {
    if (this.response) this.responseWanted = true;
    else this.send({ type: "response.create" });
  }

  #sendAudio(pcm: Buffer) {
    this.send(
      this.#audioTransport === "json"
        ? { type: "input_audio_buffer.append", audio: pcm.toString("base64") }
        : pcm,
    );
  }

  private handle(event: Record<string, unknown>) {
    const text = (key: string) =>
      typeof event[key] === "string" ? event[key] : "";
    switch (event.type) {
      case "ping":
        this.send({ type: "pong" });
        return;
      case "input_audio_buffer.speech_started": {
        const itemId = text("item_id");
        this.lastInputId = itemId;
        return this.push({ type: "speech_started", itemId });
      }
      case "conversation.item.input_audio_transcription.updated": {
        const itemId = text("item_id");
        if (this.completedInputs.has(itemId)) return;
        this.inputTexts.set(itemId, text("transcript"));
        // The transcript is cumulative, as the worker's partial is.
        return this.push({
          type: "transcript_delta",
          itemId,
          text: text("transcript"),
        });
      }
      case "conversation.item.input_audio_transcription.completed": {
        const itemId = text("item_id");
        this.inputTexts.set(itemId, text("transcript"));
        // Interim segments also arrive as "completed" while still in progress.
        if (event.status === "completed") this.completeInput(itemId);
        return;
      }
      case "response.created": {
        const response = event.response as Record<string, unknown> | undefined;
        const update = this.pendingUpdates.length > 0;
        const tools = update ? this.pendingUpdates.shift()! : true;
        // A server-started reply supersedes calls nobody answers any more.
        if (!update) this.pendingCalls.clear();
        this.response = {
          id: typeof response?.id === "string" ? response.id : "",
          update,
          tools,
          audioStarted: false,
          canceled: false,
          held: "",
          heldAudio: [],
          silenced: false,
          retry: this.retrying,
          called: false,
        };
        this.retrying = false;
        this.audioCarry = Buffer.alloc(0);
        if (!update) this.push({ type: "response_started" });
        return;
      }
      case "response.output_item.added": {
        const item = event.item as Record<string, unknown> | undefined;
        if (
          this.response &&
          item?.type === "message" &&
          typeof item.id === "string"
        )
          this.response.itemId = item.id;
        return;
      }
      case "response.output_audio.delta": {
        const response = this.outputResponse();
        if (!response || response.silenced) return;
        // A delta may end inside a sample; carry that byte to the next one.
        const bytes = Buffer.concat([
          this.audioCarry,
          Buffer.from(text("delta"), "base64"),
        ]);
        const pcm = new Int16Array(bytes.length >> 1);
        Buffer.from(pcm.buffer).set(bytes.subarray(0, pcm.length * 2));
        this.audioCarry = bytes.subarray(pcm.length * 2);
        if (pcm.length === 0) return;
        if (response.held) response.heldAudio.push(pcm);
        else this.pushAudio(response, pcm);
        return;
      }
      case "response.output_audio.done":
        if (this.outputResponse()?.audioStarted)
          this.push({ type: "audio_done" });
        return;
      case "response.output_audio_transcript.delta":
      case "response.output_text.delta":
      case "response.text.delta": {
        const response = this.outputResponse();
        if (!response || !text("delta")) return;
        return this.screen(response, text("delta"));
      }
      case "response.function_call_arguments.done": {
        const response = this.outputResponse();
        // Server-side tools already ran on xAI's side within this reply.
        if (!response || serverToolNames.has(text("name"))) return;
        const call: LiveFunctionCall = {
          callId: text("call_id"),
          name: workerNames[text("name")] ?? text("name"),
          arguments: text("arguments") || "{}",
        };
        if (!call.callId || !call.name) return;
        return this.handOver(response, call);
      }
      case "response.done": {
        const response = this.response;
        this.response = undefined;
        const status = (event.response as Record<string, unknown> | undefined)
          ?.status;
        const canceled = response?.canceled === true || status === "cancelled";
        if (response && !canceled) {
          // A call written out to the end without its closing tag still runs.
          if (response.markup !== undefined)
            this.runTextCall(response, response.markup);
          else this.release(response);
        }
        this.push({ type: "response_finished", canceled });
        if (this.responseWanted && this.pendingCalls.size === 0) {
          this.responseWanted = false;
          this.send({ type: "response.create" });
        }
        return;
      }
      case "error": {
        const error = (event.error ?? event) as Record<string, unknown>;
        const raw =
          typeof error.code === "string"
            ? error.code
            : typeof error.type === "string"
              ? error.type
              : "";
        const code = /^[A-Za-z0-9_.-]{1,32}$/.test(raw) ? raw : "unknown";
        // The reason names the request it rejected, such as a response
        // asked for while another is active; it never carries call audio.
        const detail =
          typeof error.message === "string"
            ? error.message.replace(/\s+/g, " ").slice(0, 200)
            : "";
        return this.push({ type: "provider_error", code, detail });
      }
    }
  }

  /**
   * The response that may emit output now, or none once it was canceled. A
   * reply to the latest input settles that input's transcript first, since
   * the worker binds replies to the turn it last completed.
   */
  private outputResponse() {
    const response = this.response;
    if (!response || response.canceled) return undefined;
    if (!response.update && this.lastInputId)
      this.completeInput(this.lastInputId);
    return response;
  }

  /**
   * Passes the words of a response on, except a tool call written out:
   * words that may begin one wait with their audio until it is clear; a
   * call written out runs as a call, and the rest of the response is never
   * said or shown.
   */
  private screen(response: Response, delta: string) {
    let rest = response.held + delta;
    response.held = "";
    let said = "";
    while (rest) {
      if (response.markup !== undefined) {
        const written = response.markup + rest;
        const end = written.indexOf(markupEnd);
        if (end < 0) {
          response.markup = written;
          break;
        }
        response.markup = undefined;
        this.runTextCall(response, written.slice(0, end));
        rest = written.slice(end + markupEnd.length);
        continue;
      }
      const at = rest.indexOf("<");
      const plain = at < 0 ? rest : rest.slice(0, at);
      if (!response.silenced) said += plain;
      rest = rest.slice(plain.length);
      if (rest.startsWith(markupStart)) {
        if (said) this.pushText(response, said);
        said = "";
        response.silenced = true;
        response.heldAudio = [];
        response.markup = "";
        rest = rest.slice(markupStart.length);
      } else if (rest && markupStart.startsWith(rest)) {
        response.held = rest;
        rest = "";
      } else if (rest) {
        if (!response.silenced) said += "<";
        rest = rest.slice(1);
      }
    }
    if (said) this.pushText(response, said);
    if (!response.held) this.release(response);
  }

  /** Lets held words and audio through once they are not a call. */
  private release(response: Response) {
    if (response.silenced) return;
    if (response.held) this.pushText(response, response.held);
    response.held = "";
    for (const pcm of response.heldAudio.splice(0))
      this.pushAudio(response, pcm);
  }

  private pushText(response: Response, text: string) {
    // Words can precede the audio; they still belong to an update.
    this.push({ type: "text_delta", text, update: response.update });
  }

  private pushAudio(response: Response, pcm: Int16Array) {
    if (!response.audioStarted) {
      response.audioStarted = true;
      this.playingItemId = response.itemId;
      this.push({ type: "audio_started", update: response.update });
    }
    this.push({ type: "audio_delta", pcm });
  }

  /** Runs a call written as words, when it names a tool this reply may use. */
  private runTextCall(response: Response, body: string) {
    if (!response.tools) return;
    const call = textCall(body, this.tools);
    if (!call) {
      // Nothing ran, so the user would hear only the words before it. One
      // more reply gets the chance to call the tool properly.
      if (response.retry || this.retrying) return;
      this.system(
        "Your last reply wrote a tool call as words instead of calling the tool, so nothing ran and none of it was said. Call the tool now as a function call, without words first; never write a call in words or angle brackets.",
      );
      this.retrying = true;
      if (response.update) this.pendingUpdates.push(true);
      this.requestResponse();
      return;
    }
    const callId = `text_call_${randomUUID()}`;
    this.textCalls.set(callId, call.name);
    this.handOver(response, { callId, ...call });
  }

  /** Hands a call to the worker, as part of the reply or update under way. */
  private handOver(response: Response, call: LiveFunctionCall) {
    response.called = true;
    this.pendingCalls.add(call.callId);
    if (response.update) this.updateCalls.add(call.callId);
    this.push({
      type: "function_calls",
      calls: [call],
      update: response.update,
    });
  }

  private completeInput(itemId: string) {
    if (this.completedInputs.has(itemId)) return;
    this.completedInputs.add(itemId);
    const text = this.inputTexts.get(itemId) ?? "";
    this.inputTexts.delete(itemId);
    if (this.completedInputs.size > 64)
      this.completedInputs.delete(this.completedInputs.values().next().value!);
    this.push({ type: "transcript_completed", itemId, text });
  }

  /** A JSON event, or raw PCM input sent as one binary frame. */
  private send(event: Record<string, unknown> | Buffer) {
    if (this.closing || this.socket.readyState !== WebSocket.OPEN) return;
    if (this.socket.bufferedAmount > maximumSendBuffer) {
      this.fail("live_send_backlog", true);
      this.socket.terminate();
      return;
    }
    if (Buffer.isBuffer(event)) this.socket.send(event, { binary: true });
    else this.socket.send(JSON.stringify(event));
  }

  private push(event: LiveEvent) {
    if (this.ended) return;
    const size = eventBytes(event);
    if (
      this.queue.length >= maximumQueuedEvents ||
      this.queuedBytes + size > maximumQueuedBytes
    ) {
      this.fail("live_event_backlog", false);
      this.socket.terminate();
      return;
    }
    this.queue.push(event);
    this.queuedBytes += size;
    this.wake();
  }

  private fail(code: string, transient: boolean, detail = "") {
    if (this.ended) return;
    this.failure = new LiveSessionError(code, transient, detail);
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.end();
  }

  private end() {
    this.ended = true;
    this.wake();
  }

  private wake() {
    for (const resolve of this.waiters.splice(0)) resolve();
  }
}

const eventBytes = (event: LiveEvent) =>
  event.type === "audio_delta"
    ? event.pcm.byteLength
    : "text" in event
      ? event.text.length * 2 + 64
      : 64;
