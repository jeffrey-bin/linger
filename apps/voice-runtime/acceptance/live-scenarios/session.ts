// One Grok Voice session configured like production (TeamHub instructions and
// tools, the worker's own tools, server web_search, server VAD 300 ms) and
// driven with text turns, so scenarios measure the model and its orchestration.
import { readFileSync } from "node:fs";
import WebSocket from "ws";

import {
  browserTools,
  pageActionTool,
  sentenceEnded,
} from "../../src/live-worker.js";
import {
  taskNote,
  updateCue,
  type UpdateCue,
  type UpdateEntry,
} from "../../src/live-prompts.js";
import type { LiveTool } from "../../src/live-session.js";
import { realtimeInstructions } from "../../src/realtime.js";
import {
  cutOffNote,
  spokenSafeNames,
  withModelNames,
  xaiSpeedTool,
} from "../../src/xai-live.js";

export interface Call {
  name: string;
  args: Record<string, unknown>;
}
export interface Reply {
  text: string;
  calls: Call[];
  firstAudioMs?: number;
  firstCallMs?: number;
  audioSec: number;
  startedAt: number;
}
export type Mock = (call: Call) => unknown;
export type Update = UpdateCue & { replies: string[] };

type Event = Record<string, unknown> & { type?: string };

const workerNames = Object.fromEntries(
  Object.entries(spokenSafeNames).map(([worker, model]) => [model, worker]),
);

export function loadContext(path: string) {
  const context = JSON.parse(readFileSync(path, "utf8")) as {
    instructions: string;
    tools: LiveTool[];
  };
  const tools = [
    ...context.tools,
    ...browserTools,
    pageActionTool,
    xaiSpeedTool,
  ];
  return {
    tools,
    instructions: withModelNames(
      realtimeInstructions(context.instructions, [
        ...tools,
        { name: "web_search" },
      ]),
    ),
  };
}

export class Session {
  private readonly inbox: Event[] = [];
  private wake?: () => void;
  /** What the user said last, handed to update cues as the worker does. */
  private lastWords?: string;

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (raw, binary) => {
      if (binary) return;
      this.inbox.push(
        JSON.parse(
          Array.isArray(raw)
            ? Buffer.concat(raw).toString("utf8")
            : raw instanceof ArrayBuffer
              ? Buffer.from(raw).toString("utf8")
              : raw.toString("utf8"),
        ) as Event,
      );
      this.wake?.();
    });
  }

  static async open(apiKey: string, context: ReturnType<typeof loadContext>) {
    const url = new URL("wss://api.x.ai/v1/realtime");
    url.searchParams.set("model", "grok-voice-3.0");
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    const session = new Session(socket);
    session.send({
      type: "session.update",
      session: {
        instructions: context.instructions,
        voice: "ara",
        // Production runs high; LIVE_REASONING=none compares the other level.
        reasoning: {
          effort: process.env.LIVE_REASONING === "none" ? "none" : "high",
        },
        turn_detection: { type: "server_vad", silence_duration_ms: 300 },
        tools: [
          ...context.tools.map((tool) => ({
            type: "function",
            ...tool,
            name: spokenSafeNames[tool.name] ?? tool.name,
            description: withModelNames(tool.description),
          })),
          { type: "web_search" },
        ],
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 16000 },
            transcription: { model: "grok-transcribe" },
          },
          output: { format: { type: "audio/pcm", rate: 24000 } },
        },
      },
    });
    for (;;) {
      const event = await session.next();
      if (event.type === "session.updated") return session;
      if (event.type === "error") throw new Error("session rejected");
    }
  }

  private send(event: unknown) {
    this.socket.send(JSON.stringify(event));
  }

  private async next(timeoutMs = 90_000) {
    const deadline = Date.now() + timeoutMs;
    while (this.inbox.length === 0) {
      if (Date.now() > deadline) throw new Error("timeout");
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        setTimeout(resolve, 200);
      });
    }
    return this.inbox.shift()!;
  }

  private item(role: "user" | "system", text: string) {
    this.send({
      type: "conversation.item.create",
      item: { type: "message", role, content: [{ type: "input_text", text }] },
    });
  }

  /** Context exactly as the worker adds it: a system item. */
  note(text: string) {
    this.item("system", text);
  }

  /** Background results and the composed update, as the worker says them. */
  /**
   * An update as the worker tells it: a report may first read and publish
   * its result. What the update said, across its tool rounds.
   */
  async update(updates: Update[], at: UpdateEntry, mock: Mock): Promise<Reply> {
    for (const update of updates)
      update.replies.forEach((reply, index) =>
        this.note(
          taskNote(
            update.taskId,
            update.goal,
            index + 1,
            update.replies.length,
            reply,
          ),
        ),
      );
    this.item("user", `[system] ${updateCue(updates, at, this.lastWords)}`);
    const tools = updates.some((update) => update.kind === "report");
    this.send({
      type: "response.create",
      response: { tool_choice: tools ? "auto" : "none" },
    });
    const replies = await this.rounds(mock);
    const first = replies[0]!;
    const audible = replies.find((reply) => reply.firstAudioMs !== undefined);
    return {
      text: replies.map((reply) => reply.text).join(""),
      calls: replies.flatMap((reply) => reply.calls),
      audioSec: replies.reduce((sum, reply) => sum + reply.audioSec, 0),
      startedAt: first.startedAt,
      ...(audible
        ? {
            firstAudioMs:
              audible.startedAt - first.startedAt + audible.firstAudioMs!,
          }
        : {}),
      ...(first.firstCallMs !== undefined
        ? { firstCallMs: first.firstCallMs }
        : {}),
    };
  }

  /** An urgent event, said the way the worker says it while nobody talks. */
  alert() {
    this.item(
      "user",
      `[system] ${updateCue([{ taskId: "alert", goal: "", kind: "alert" }], { kind: "idle" }, this.lastWords)}`,
    );
    this.send({ type: "response.create", response: { tool_choice: "none" } });
  }

  /** One response to response.done, with the calls it made. */
  async readReply() {
    const startedAt = Date.now();
    const reply: Reply = { text: "", calls: [], audioSec: 0, startedAt };
    const callIds: Array<{ id: string; call: Call }> = [];
    for (;;) {
      const event = await this.next();
      const ms = Date.now() - startedAt;
      if (event.type === "response.output_audio_transcript.delta")
        reply.text += typeof event.delta === "string" ? event.delta : "";
      else if (event.type === "response.output_audio.delta") {
        reply.firstAudioMs ??= ms;
        reply.audioSec +=
          Buffer.from(
            typeof event.delta === "string" ? event.delta : "",
            "base64",
          ).length /
          2 /
          24000;
      } else if (event.type === "response.function_call_arguments.done") {
        reply.firstCallMs ??= ms;
        const name = workerNames[String(event.name)] ?? String(event.name);
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(
            typeof event.arguments === "string" ? event.arguments : "{}",
          ) as Record<string, unknown>;
        } catch {
          args = {};
        }
        reply.calls.push({ name, args });
        if (name !== "web_search")
          callIds.push({ id: String(event.call_id), call: { name, args } });
      } else if (event.type === "response.done") return { reply, callIds };
    }
  }

  /** A user turn and its tool rounds, quiet after work the model announced. */
  async turn(text: string, mock: Mock) {
    this.lastWords = text;
    this.item("user", text);
    this.send({ type: "response.create" });
    return this.rounds(mock);
  }

  /**
   * A user turn whose reply the user cuts off once it starts speaking, as a
   * local barge-in does: calls after that are never made, and the worker
   * notes it (LIVE_CUT_OFF_NOTE=off leaves the note out).
   */
  async cutOff(text: string) {
    this.item("user", text);
    this.send({ type: "response.create" });
    const startedAt = Date.now();
    const reply: Reply = { text: "", calls: [], audioSec: 0, startedAt };
    let canceled = false;
    for (;;) {
      const event = await this.next();
      if (event.type === "response.output_audio_transcript.delta" && !canceled)
        reply.text += typeof event.delta === "string" ? event.delta : "";
      else if (event.type === "response.output_audio.delta" && !canceled) {
        reply.firstAudioMs ??= Date.now() - startedAt;
        reply.audioSec +=
          Buffer.from(String(event.delta), "base64").length / 2 / 24000;
        // Cut off a moment into its words, as a short "OK" does.
        if (reply.audioSec < 0.8) continue;
        canceled = true;
        this.send({ type: "response.cancel" });
      } else if (
        event.type === "response.function_call_arguments.done" &&
        !canceled
      )
        reply.calls.push({
          name: workerNames[String(event.name)] ?? String(event.name),
          args: {},
        });
      else if (event.type === "response.done") break;
    }
    if (
      canceled &&
      reply.calls.length === 0 &&
      process.env.LIVE_CUT_OFF_NOTE !== "off"
    )
      this.item("user", `[system] ${cutOffNote}`);
    return reply;
  }

  /** A response and its tool rounds, quiet after work the model announced. */
  private async rounds(mock: Mock) {
    const replies: Reply[] = [];
    for (let round = 0; round < 6; round++) {
      const { reply, callIds } = await this.readReply();
      replies.push(reply);
      if (callIds.length === 0) break;
      const outputs = callIds.map(({ call }) => mock(call));
      callIds.forEach(({ id }, index) =>
        this.send({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: id,
            output: JSON.stringify(outputs[index]),
          },
        }),
      );
      const settled = (call: Call, output: unknown) => {
        const status = (output as { status?: unknown } | undefined)?.status;
        return (
          call.name === "end_voice_mode" ||
          ((call.name === "start_task" || call.name === "reply_to_task") &&
            (status === "started" || status === "passed_on"))
        );
      };
      if (
        sentenceEnded(reply.text) &&
        callIds.every(({ call }, index) => settled(call, outputs[index]))
      )
        break;
      this.send({ type: "response.create" });
    }
    return replies;
  }

  close() {
    this.socket.close();
  }
}
