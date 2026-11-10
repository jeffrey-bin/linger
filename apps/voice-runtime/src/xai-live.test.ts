import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import type { LiveEvent } from "./live-session.js";
import { cutOffNote, XaiLiveSession } from "./xai-live.js";

type Sent = Record<string, unknown>;
const servers: WebSocketServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function fakeProvider(
  options: { reject?: number; rejectUpdate?: boolean } = {},
) {
  const server = new WebSocketServer({
    port: 0,
    host: "127.0.0.1",
    verifyClient: (_info, done) =>
      options.reject ? done(false, options.reject) : done(true),
  });
  servers.push(server);
  await once(server, "listening");
  const sent: Sent[] = [];
  const requests: { url?: string; authorization?: string }[] = [];
  const sockets: WebSocket[] = [];
  server.on("connection", (socket, request) => {
    requests.push({
      url: request.url,
      authorization: request.headers.authorization,
    });
    sockets.push(socket);
    socket.on("message", (raw, binary) => {
      // Input audio arrives as raw PCM binary frames.
      if (binary) {
        sent.push({ type: "binary", bytes: (raw as Buffer).byteLength });
        return;
      }
      const message = JSON.parse(
        Array.isArray(raw)
          ? Buffer.concat(raw).toString("utf8")
          : raw instanceof ArrayBuffer
            ? Buffer.from(raw).toString("utf8")
            : raw.toString("utf8"),
      ) as Sent;
      sent.push(message);
      if (message.type === "session.update")
        socket.send(
          JSON.stringify(
            options.rejectUpdate
              ? { type: "error", error: { code: "invalid_config" } }
              : { type: "session.updated" },
          ),
        );
    });
  });
  const emit = (...events: Sent[]) => {
    for (const event of events) sockets[0]!.send(JSON.stringify(event));
  };
  return {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/realtime`,
    sent,
    requests,
    emit,
  };
}

const open = (
  url: string,
  history: { role: "user" | "assistant"; text: string }[] = [],
) =>
  XaiLiveSession.open({
    apiKey: "xai-secret",
    webSocketUrl: url,
    model: "grok-voice-3.0",
    voice: "eve",
    reasoningEffort: "none",
    instructions: "be brief",
    tools: [
      { name: "lookup", description: "d", parameters: { type: "object" } },
    ],
    history,
  });

async function collect(session: XaiLiveSession, count: number) {
  const events: LiveEvent[] = [];
  for await (const event of session.events()) {
    events.push(event);
    if (events.length === count) break;
  }
  return events;
}

const pcmBase64 = (...samples: number[]) =>
  Buffer.from(Int16Array.from(samples).buffer).toString("base64");

const waitForSent = async (sent: Sent[], count: number) => {
  for (let i = 0; i < 100 && sent.length < count; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
};

describe("XaiLiveSession", () => {
  it("uses JSON audio for microphone and mute frames", async () => {
    const provider = await fakeProvider();
    const session = await XaiLiveSession.open({
      apiKey: "gateway-secret",
      webSocketUrl: provider.url,
      model: "grok-voice-3.0",
      voice: "eve",
      reasoningEffort: "high",
      audioTransport: "json",
      instructions: "be brief",
      tools: [],
      history: [],
    });
    const samples = Int16Array.from([99, 1, -2, 88]);
    session.appendAudio(samples.subarray(1, 3));
    session.mute();
    session.appendAudio(samples);
    session.unmute();
    session.appendAudio(Int16Array.from([3]));
    expect(session.setSpeed(1.2)).toBe(true);
    provider.emit({ type: "ping" });
    await waitForSent(provider.sent, 6);
    expect(provider.sent.map((event) => event.type)).toEqual([
      "session.update",
      "input_audio_buffer.append",
      "input_audio_buffer.append",
      "input_audio_buffer.append",
      "session.update",
      "pong",
    ]);
    expect(provider.sent[1]).toEqual({
      type: "input_audio_buffer.append",
      audio: pcmBase64(1, -2),
    });
    expect(Buffer.from(String(provider.sent[2]!.audio), "base64")).toEqual(
      Buffer.alloc(33_600),
    );
    expect(provider.sent[3]!.audio).toBe(pcmBase64(3));
    for (const index of [0, 4]) {
      expect(provider.sent[index]).toMatchObject({
        session: {
          audio: {
            input: { format: { type: "audio/pcm", rate: 24_000 } },
            output: { format: { type: "audio/pcm", rate: 24_000 } },
          },
        },
      });
      expect(JSON.stringify(provider.sent[index])).not.toContain('"binary"');
    }
    expect(provider.sent[4]).toMatchObject({
      session: { audio: { output: { speed: 1.2 } } },
    });
    await session.close();
  });

  it("shows the model a plain name for recall_memory and maps calls back", async () => {
    const provider = await fakeProvider();
    const session = await XaiLiveSession.open({
      apiKey: "xai-secret",
      webSocketUrl: provider.url,
      model: "grok-voice-3.0",
      voice: "eve",
      reasoningEffort: "high",
      instructions: "Call recall_memory first",
      tools: [
        {
          name: "recall_memory",
          description: "Use recall_memory to look up the past",
          parameters: { type: "object" },
        },
      ],
      history: [],
    });
    await waitForSent(provider.sent, 1);
    const update = provider.sent[0]!.session as {
      instructions: string;
      tools: Array<{ name: string; description: string }>;
    };
    expect(JSON.stringify(update)).not.toContain("recall");
    expect(update.tools[0]).toMatchObject({
      name: "look_up_past",
      description: "Use look_up_past to look up the past",
    });
    const events = collect(session, 2);
    provider.emit(
      { type: "response.created", response: { id: "r1" } },
      {
        type: "response.function_call_arguments.done",
        call_id: "c1",
        name: "look_up_past",
        arguments: '{"query":"Rain Zhao"}',
      },
    );
    expect(await events).toEqual([
      { type: "response_started" },
      {
        type: "function_calls",
        update: false,
        calls: [
          {
            callId: "c1",
            name: "recall_memory",
            arguments: '{"query":"Rain Zhao"}',
          },
        ],
      },
    ]);
    await session.close();
  });

  it("configures the model, voice, server VAD, tools and history", async () => {
    const provider = await fakeProvider();
    const session = await open(provider.url, [
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
    ]);
    await waitForSent(provider.sent, 3);
    expect(provider.requests[0]).toEqual({
      url: "/v1/realtime?model=grok-voice-3.0",
      authorization: "Bearer xai-secret",
    });
    const update = provider.sent[0]!.session as Record<string, unknown>;
    expect(update.instructions).toContain("be brief");
    expect(update).toMatchObject({
      voice: "eve",
      reasoning: { effort: "none" },
      turn_detection: { type: "server_vad", silence_duration_ms: 400 },
      tools: [{ type: "function", name: "lookup" }, { type: "web_search" }],
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24_000 },
          transport: "binary",
          transcription: { model: "grok-transcribe" },
        },
        output: { format: { type: "audio/pcm", rate: 24_000 } },
      },
    });
    expect(provider.sent.slice(1).map((event) => event.item)).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hi" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hello" }],
      },
    ]);
    await session.close();
  });

  it("maps rejected handshakes and configurations to stable codes", async () => {
    const rejected = await fakeProvider({ reject: 401 });
    await expect(open(rejected.url)).rejects.toMatchObject({
      code: "live_http_401",
      transient: false,
    });
    const invalid = await fakeProvider({ rejectUpdate: true });
    await expect(open(invalid.url)).rejects.toMatchObject({
      code: "live_session_rejected",
    });
  });

  it("completes the input before its reply and splits audio across deltas", async () => {
    const provider = await fakeProvider();
    const session = await open(provider.url);
    const events = collect(session, 8);
    const odd = Buffer.from(Int16Array.from([1, 2]).buffer);
    provider.emit(
      { type: "input_audio_buffer.speech_started", item_id: "u1" },
      {
        type: "conversation.item.input_audio_transcription.updated",
        item_id: "u1",
        transcript: "Check",
      },
      // An interim segment is not the final transcript.
      {
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "u1",
        transcript: "Check",
        status: "in_progress",
      },
      { type: "response.created", response: { id: "r1" } },
      {
        type: "response.output_audio.delta",
        delta: odd.subarray(0, 3).toString("base64"),
      },
      {
        type: "response.output_audio.delta",
        delta: odd.subarray(3).toString("base64"),
      },
      { type: "response.output_audio_transcript.delta", delta: "OK" },
      // The settled transcript arrives after the reply already started.
      {
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "u1",
        transcript: "Check the schedule",
        status: "completed",
      },
      { type: "response.output_audio.done" },
      { type: "response.done", response: { status: "completed" } },
    );
    expect(await events).toEqual([
      { type: "speech_started", itemId: "u1" },
      { type: "transcript_delta", itemId: "u1", text: "Check" },
      { type: "response_started" },
      { type: "transcript_completed", itemId: "u1", text: "Check" },
      { type: "audio_started", update: false },
      { type: "audio_delta", pcm: Int16Array.from([1]) },
      { type: "audio_delta", pcm: Int16Array.from([2]) },
      { type: "text_delta", text: "OK", update: false },
    ]);
    await session.close();
  });

  it("answers a round of tool calls with one response after the reply ends", async () => {
    const provider = await fakeProvider();
    const session = await open(provider.url);
    const events = collect(session, 3);
    provider.emit(
      { type: "response.created", response: { id: "r1" } },
      {
        type: "response.function_call_arguments.done",
        call_id: "c1",
        name: "lookup",
        arguments: '{"q":1}',
      },
      {
        type: "response.function_call_arguments.done",
        call_id: "c2",
        name: "lookup",
        arguments: "",
      },
    );
    expect(await events).toEqual([
      { type: "response_started" },
      {
        type: "function_calls",
        update: false,
        calls: [{ callId: "c1", name: "lookup", arguments: '{"q":1}' }],
      },
      {
        type: "function_calls",
        update: false,
        calls: [{ callId: "c2", name: "lookup", arguments: "{}" }],
      },
    ]);
    session.sendToolResults([{ callId: "c1", output: "a" }]);
    session.sendToolResults([{ callId: "c2", output: "b" }]);
    await waitForSent(provider.sent, 3);
    // The reply is still active, so the response request waits for it.
    expect(provider.sent.slice(1).map((event) => event.type)).toEqual([
      "conversation.item.create",
      "conversation.item.create",
    ]);
    provider.emit({ type: "response.done", response: { status: "completed" } });
    await waitForSent(provider.sent, 4);
    expect(provider.sent.at(-1)).toEqual({ type: "response.create" });
    await session.close();
  });

  it("adds quiet tool results without asking for another reply", async () => {
    const provider = await fakeProvider();
    const session = await open(provider.url);
    const events = collect(session, 2);
    provider.emit(
      { type: "response.created", response: { id: "r1" } },
      {
        type: "response.function_call_arguments.done",
        call_id: "c1",
        name: "lookup",
        arguments: "{}",
      },
    );
    await events;
    session.sendToolResults([{ callId: "c1", output: "a" }], { reply: false });
    provider.emit({ type: "response.done", response: { status: "completed" } });
    await waitForSent(provider.sent, 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(provider.sent.slice(1).map((event) => event.type)).toEqual([
      "conversation.item.create",
    ]);
    await session.close();
  });

  it("runs a tool call written as words and never says or shows it", async () => {
    const provider = await fakeProvider();
    const session = await open(provider.url);
    const events = collect(session, 6);
    provider.emit(
      { type: "response.created", response: { id: "r1" } },
      { type: "response.output_audio.delta", delta: pcmBase64(1) },
      {
        type: "response.output_audio_transcript.delta",
        delta: "OK, checking.<tool",
      },
      // Audio while the words may still begin a call waits with them.
      { type: "response.output_audio.delta", delta: pcmBase64(2) },
      {
        type: "response.output_audio_transcript.delta",
        delta:
          "_call>lookup<arg_key>q</arg_key><arg_value>weather</arg_value><arg_key>n</arg_key><arg_value>2</arg_value></tool_call>",
      },
      { type: "response.output_audio.delta", delta: pcmBase64(3) },
      { type: "response.output_audio_transcript.delta", delta: "Done" },
      { type: "response.done", response: { status: "completed" } },
    );
    // Neither the call nor anything after it is said or shown.
    expect(await events).toEqual([
      { type: "response_started" },
      { type: "audio_started", update: false },
      { type: "audio_delta", pcm: Int16Array.from([1]) },
      { type: "text_delta", text: "OK, checking.", update: false },
      {
        type: "function_calls",
        update: false,
        calls: [
          {
            callId: expect.stringMatching(/^text_call_/),
            name: "lookup",
            arguments: '{"q":"weather","n":2}',
          },
        ],
      },
      { type: "response_finished", canceled: false },
    ]);
    await session.close();
  });

  it("lets an angle bracket that begins no call through with its audio", async () => {
    const provider = await fakeProvider();
    const session = await open(provider.url);
    const events = collect(session, 6);
    provider.emit(
      { type: "response.created", response: { id: "r1" } },
      { type: "response.output_audio_transcript.delta", delta: "1<" },
      { type: "response.output_audio.delta", delta: pcmBase64(4) },
      { type: "response.output_audio_transcript.delta", delta: "2 is right" },
      { type: "response.done", response: { status: "completed" } },
    );
    expect(await events).toEqual([
      { type: "response_started" },
      { type: "text_delta", text: "1", update: false },
      { type: "text_delta", text: "<2 is right", update: false },
      { type: "audio_started", update: false },
      { type: "audio_delta", pcm: Int16Array.from([4]) },
      { type: "response_finished", canceled: false },
    ]);
    await session.close();
  });

  it("answers a call written as words with its result as context", async () => {
    const provider = await fakeProvider();
    const session = await open(provider.url);
    const events = collect(session, 2);
    provider.emit(
      { type: "response.created", response: { id: "r1" } },
      {
        type: "response.output_text.delta",
        delta: '<tool_call>{"name":"lookup","arguments":{"q":"x"}}</tool_call>',
      },
    );
    const [, calls] = await events;
    const callId =
      calls?.type === "function_calls" ? calls.calls[0]!.callId : "";
    session.sendToolResults([{ callId, output: '{"status":"started"}' }]);
    provider.emit({ type: "response.done", response: { status: "completed" } });
    await waitForSent(provider.sent, 3);
    expect(provider.sent.slice(1)).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "system",
          content: [
            {
              type: "input_text",
              text: expect.stringContaining(
                'You wrote a lookup call as words instead of calling the tool. It was run as a call and none of it was said or shown. Its result: {"status":"started"}',
              ),
            },
          ],
        },
      },
      { type: "response.create" },
    ]);
    await session.close();
  });

  it("asks once more when a call written as words cannot run", async () => {
    const provider = await fakeProvider();
    const session = await open(provider.url);
    const unknown =
      "<tool_call>web_search<arg_key>q</arg_key><arg_value>x</arg_value></tool_call>";
    provider.emit(
      { type: "response.created", response: { id: "r1" } },
      { type: "response.output_audio_transcript.delta", delta: unknown },
      { type: "response.done", response: { status: "completed" } },
    );
    await waitForSent(provider.sent, 3);
    expect(provider.sent.slice(1).map((event) => event.type)).toEqual([
      "conversation.item.create",
      "response.create",
    ]);
    // The retry itself gets no further retry.
    provider.emit(
      { type: "response.created", response: { id: "r2" } },
      { type: "response.output_audio_transcript.delta", delta: unknown },
      { type: "response.done", response: { status: "completed" } },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(provider.sent).toHaveLength(3);
    await session.close();
  });

  it("never runs a call an update without tools wrote as words", async () => {
    const provider = await fakeProvider();
    const session = await open(provider.url);
    session.tell("A result arrived.");
    const events = collect(session, 2);
    provider.emit(
      { type: "response.created", response: { id: "r1" } },
      {
        type: "response.output_audio_transcript.delta",
        delta: "By the way<tool_call>lookup</tool_call>",
      },
      { type: "response.done", response: { status: "completed" } },
    );
    expect(await events).toEqual([
      { type: "text_delta", text: "By the way", update: true },
      { type: "response_finished", canceled: false },
    ]);
    await session.close();
  });

  it("answers an update's tool round as the same update", async () => {
    const provider = await fakeProvider();
    const session = await open(provider.url);
    session.tell("A report arrived.", true);
    const first = collect(session, 2);
    provider.emit(
      { type: "response.created", response: { id: "r1" } },
      {
        type: "response.function_call_arguments.done",
        call_id: "c1",
        name: "lookup",
        arguments: "{}",
      },
      { type: "response.done", response: { status: "completed" } },
    );
    expect(await first).toEqual([
      {
        type: "function_calls",
        update: true,
        calls: [{ callId: "c1", name: "lookup", arguments: "{}" }],
      },
      { type: "response_finished", canceled: false },
    ]);
    session.sendToolResults([{ callId: "c1", output: "ok" }]);
    await waitForSent(provider.sent, 5);
    expect(provider.sent.at(-1)).toEqual({ type: "response.create" });
    const second = collect(session, 1);
    provider.emit(
      { type: "response.created", response: { id: "r2" } },
      { type: "response.output_audio_transcript.delta", delta: "All checked." },
    );
    // The response after the results speaks for the update, not a turn.
    expect(await second).toEqual([
      { type: "text_delta", text: "All checked.", update: true },
    ]);
    await session.close();
  });

  it("drops output after a local cancel and truncates what was heard", async () => {
    const provider = await fakeProvider();
    const session = await open(provider.url);
    const events = collect(session, 4);
    provider.emit(
      { type: "response.created", response: { id: "r1" } },
      {
        type: "response.output_item.added",
        item: { id: "item_a", type: "message", role: "assistant" },
      },
      { type: "response.output_audio.delta", delta: pcmBase64(5) },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    session.cancel();
    session.truncate(1234.4);
    provider.emit(
      { type: "response.output_audio.delta", delta: pcmBase64(6) },
      { type: "response.done", response: { status: "cancelled" } },
    );
    expect(await events).toEqual([
      { type: "response_started" },
      { type: "audio_started", update: false },
      { type: "audio_delta", pcm: Int16Array.from([5]) },
      { type: "response_finished", canceled: true },
    ]);
    // The reply was cut off before any tool call: the model is told so.
    expect(provider.sent.slice(-3)).toEqual([
      { type: "response.cancel" },
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: `[system] ${cutOffNote}` }],
        },
      },
      {
        type: "conversation.item.truncate",
        item_id: "item_a",
        content_index: 0,
        audio_end_ms: 1234,
      },
    ]);
    await session.close();
  });

  it("says nothing more when a cut-off reply already called its tool", async () => {
    const provider = await fakeProvider();
    const session = await open(provider.url);
    const events = collect(session, 3);
    provider.emit(
      { type: "response.created", response: { id: "r1" } },
      {
        type: "response.function_call_arguments.done",
        call_id: "c1",
        name: "start_task",
        arguments: '{"goal":"Check NBA news","surface":"web"}',
      },
      { type: "response.output_audio.delta", delta: pcmBase64(5) },
    );
    await events;
    session.cancel();
    await waitForSent(provider.sent, 3);
    expect(provider.sent.at(-1)).toEqual({ type: "response.cancel" });
    await session.close();
  });

  it("adds context as a system item that never reads as the user", async () => {
    const provider = await fakeProvider();
    const session = await open(provider.url);
    session.note("Material: the weekly report draft is in the document");
    await waitForSent(provider.sent, 2);
    expect(provider.sent.slice(1)).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "system",
          content: [
            {
              type: "input_text",
              text: "Material: the weekly report draft is in the document",
            },
          ],
        },
      },
    ]);
    await session.close();
  });

  it("asks for a reply when server VAD ended a turn without one", async () => {
    const provider = await fakeProvider();
    const session = await open(provider.url);
    session.respond();
    await waitForSent(provider.sent, 2);
    expect(provider.sent.at(-1)).toEqual({ type: "response.create" });
    await session.close();
  });

  it("tells an update in the model's own words, from a system note and without tools", async () => {
    const provider = await fakeProvider();
    const session = await open(provider.url);
    session.tell("A result arrived.");
    await waitForSent(provider.sent, 3);
    expect(provider.sent.slice(1, 3)).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "[system] A result arrived." }],
        },
      },
      { type: "response.create", response: { tool_choice: "none" } },
    ]);
    const events = collect(session, 2);
    provider.emit(
      { type: "response.created", response: { id: "r1" } },
      // Words can precede the audio; they still belong to the update.
      { type: "response.output_audio_transcript.delta", delta: "By the way" },
      { type: "response.output_audio.delta", delta: pcmBase64(5) },
    );
    expect(await events).toEqual([
      { type: "text_delta", text: "By the way", update: true },
      { type: "audio_started", update: true },
    ]);
    await session.close();
  });

  it("closes a muted turn with silence and stops sending audio", async () => {
    const provider = await fakeProvider();
    const session = await open(provider.url);
    session.appendAudio(Int16Array.from([7]));
    session.mute();
    session.appendAudio(Int16Array.from([8]));
    session.unmute();
    session.appendAudio(Int16Array.from([9]));
    await waitForSent(provider.sent, 4);
    expect(provider.sent.slice(1)).toEqual([
      { type: "binary", bytes: 2 },
      { type: "binary", bytes: 33_600 },
      { type: "binary", bytes: 2 },
    ]);
    await session.close();
  });

  it("speaks an update after an answered input, and answers the next input", async () => {
    const provider = await fakeProvider();
    const session = await open(provider.url);
    const answered = collect(session, 3);
    provider.emit(
      { type: "input_audio_buffer.speech_started", item_id: "u1" },
      { type: "response.created", response: { id: "r1" } },
      { type: "response.done", response: { id: "r1", status: "completed" } },
    );
    expect(await answered).toEqual([
      { type: "speech_started", itemId: "u1" },
      { type: "response_started" },
      { type: "response_finished", canceled: false },
    ]);
    // A report arrives: its answer is asked for, so it is never canceled.
    session.tell("A task finished.");
    await waitForSent(provider.sent, 3);
    const told = collect(session, 2);
    provider.emit(
      { type: "response.created", response: { id: "r2" } },
      {
        type: "response.output_audio_transcript.delta",
        response_id: "r2",
        delta: "Done.",
      },
      { type: "response.done", response: { id: "r2", status: "completed" } },
    );
    expect(await told).toEqual([
      { type: "text_delta", text: "Done.", update: true },
      { type: "response_finished", canceled: false },
    ]);
    // The user's next words get an answer of their own, not one taken for
    // the report.
    const next = collect(session, 4);
    provider.emit(
      { type: "input_audio_buffer.speech_started", item_id: "u2" },
      { type: "response.created", response: { id: "r3" } },
      {
        type: "response.output_audio_transcript.delta",
        response_id: "r3",
        delta: "Yes.",
      },
    );
    expect(await next).toEqual([
      { type: "speech_started", itemId: "u2" },
      { type: "response_started" },
      { type: "transcript_completed", itemId: "u2", text: "" },
      { type: "text_delta", text: "Yes.", update: false },
    ]);
    expect(
      provider.sent.some((event) => event.type === "response.cancel"),
    ).toBe(false);
    await session.close();
  });

  it("connects before the setup arrives and configures it once it does", async () => {
    const provider = await fakeProvider();
    let resolveSetup!: (setup: {
      instructions: string;
      tools: [];
      history: [];
    }) => void;
    const opening = XaiLiveSession.open({
      apiKey: "xai-secret",
      webSocketUrl: provider.url,
      model: "grok-voice-3.0",
      voice: "eve",
      reasoningEffort: "high",
      setup: new Promise((resolve) => (resolveSetup = resolve)),
    });
    for (let i = 0; i < 100 && !provider.requests.length; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(provider.requests).toHaveLength(1);
    expect(provider.sent).toEqual([]);
    resolveSetup({ instructions: "late context", tools: [], history: [] });
    const session = await opening;
    const update = provider.sent[0]!.session as Record<string, unknown>;
    expect(update.instructions).toContain("late context");
    expect(update.voice).toBe("eve");
    await session.close();
  });

  it("closes the socket when the setup fails", async () => {
    const provider = await fakeProvider();
    await expect(
      XaiLiveSession.open({
        apiKey: "xai-secret",
        webSocketUrl: provider.url,
        model: "grok-voice-3.0",
        voice: "eve",
        reasoningEffort: "high",
        setup: Promise.reject(new Error("context unavailable")),
      }),
    ).rejects.toThrow("context unavailable");
    expect(provider.sent).toEqual([]);
  });

  it("changes the reply speed mid-session and rejects out-of-range values", async () => {
    const provider = await fakeProvider();
    const session = await open(provider.url);
    expect(session.setSpeed(1.3)).toBe(true);
    expect(session.setSpeed(2)).toBe(false);
    expect(session.setSpeed(Number.NaN)).toBe(false);
    await waitForSent(provider.sent, 2);
    const updates = provider.sent.filter((e) => e.type === "session.update");
    expect(updates.slice(1)).toEqual([
      {
        type: "session.update",
        session: {
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24_000 },
              transport: "binary",
              transcription: { model: "grok-transcribe" },
            },
            output: { format: { type: "audio/pcm", rate: 24_000 }, speed: 1.3 },
          },
        },
      },
    ]);
    await session.close();
  });

  it("fails transiently when the provider drops the socket", async () => {
    const provider = await fakeProvider();
    const session = await open(provider.url);
    const consumed = collect(session, 1);
    for (const server of servers)
      for (const client of server.clients) client.terminate();
    await expect(consumed).rejects.toMatchObject({
      code: "live_socket_closed",
      transient: true,
    });
  });

  it("keeps why the provider closed the socket", async () => {
    const provider = await fakeProvider();
    const session = await open(provider.url);
    const consumed = collect(session, 1);
    for (const server of servers)
      for (const client of server.clients)
        client.close(4000, "session idle too long");
    await expect(consumed).rejects.toMatchObject({
      code: "live_socket_closed",
      transient: true,
      detail: "4000 session idle too long",
    });
  });
});
