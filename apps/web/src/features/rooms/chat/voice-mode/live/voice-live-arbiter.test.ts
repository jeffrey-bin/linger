import { afterEach, describe, expect, it, vi } from "vitest";

import type { TeamHubVoiceLiveClientEvent } from "@/features/teamhub/teamhub-types";
import type { VoiceCommandContext } from "../commands/voice-command";
import {
  continuesTurn,
  createVoiceLiveArbiter,
  endVoiceModeTailMs,
  voiceLiveTurnSettleMs,
  type VoiceLiveLine,
  type VoicePageSource,
} from "./voice-live-arbiter";

const pageTools = vi.hoisted(() => ({ runs: [] as unknown[] }));
vi.mock("./voice-live-page-tools", () => ({
  pageReady: async () => undefined,
  readPageTargets: () => "e1 Pocket Note",
  runPageAction: vi.fn(async (request: unknown) => {
    pageTools.runs.push(request);
    return { status: "done" };
  }),
}));

afterEach(() => {
  vi.useRealTimers();
  pageTools.runs = [];
});

function fixture(page?: VoicePageSource) {
  const sent: TeamHubVoiceLiveClientEvent[] = [];
  const posts: Array<{ text: string; eventId: string; marker?: unknown }> = [];
  const exits: number[] = [];
  let transcript: readonly VoiceLiveLine[] = [];
  const arbiter = createVoiceLiveArbiter({
    voiceSessionId: () => "live-session",
    active: () => true,
    send: (event) => sent.push(event),
    context: {
      roomId: "agent-room",
      exitVoiceMode: () => exits.push(1),
    } as unknown as VoiceCommandContext,
    prepare: (text, eventId) => async (marker) => {
      posts.push({ text, eventId, ...(marker ? { marker } : {}) });
    },
    onTranscript: (lines) => {
      transcript = lines;
    },
    ...(page ? { page } : {}),
  });
  return {
    arbiter,
    posts,
    sent,
    exits,
    transcript: () => transcript,
    liveTexts: () =>
      transcript
        .filter((line) => line.speaker === "live")
        .map((line) => line.text),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("voice live arbiter", () => {
  it("saves a turn as the Human's own words once its whole reply ended", async () => {
    const f = fixture();
    const save = f.arbiter.prepareTurn("lt_1", "Research the pricing for me");
    expect(save.keepsText).toBe(true);
    void save();
    f.arbiter.receive({
      type: "reply_delta",
      turn_id: "lt_1",
      text: "OK, let me check.",
    });
    await settle();
    // The reply's tool rounds, such as a hand-off, are not over yet.
    expect(f.posts).toEqual([]);
    f.arbiter.receive({
      type: "reply_done",
      turn_id: "lt_1",
      text: "OK, let me check.",
    });
    await vi.waitFor(() =>
      expect(f.posts).toEqual([
        {
          text: "Research the pricing for me",
          eventId: "lt_1",
          marker: { voice_session_id: "live-session", turn_id: "lt_1" },
        },
      ]),
    );
    expect(f.transcript()).toEqual([
      { id: "lt_1", speaker: "you", text: "Research the pricing for me" },
      { id: "lt_1:reply", speaker: "live", text: "OK, let me check." },
    ]);
  });

  it("never saves the live model's words as the Human's", async () => {
    const f = fixture();
    void f.arbiter.prepareTurn("lt_1", "Look at this")();
    f.arbiter.receive({
      type: "tool_request",
      turn_id: "lt_1",
      call_id: "c1",
      tool: "page_action",
      text: '{"action":"click","target":"e1"}',
    });
    f.arbiter.receive({
      type: "reply_done",
      turn_id: "lt_1",
      text: "Opened it for you",
    });
    await vi.waitFor(() => expect(f.posts).toHaveLength(1));
    expect(f.posts.map((post) => post.text)).toEqual(["Look at this"]);
  });

  it("saves a turn whose reply never ends after a bounded wait", async () => {
    vi.useFakeTimers();
    const f = fixture();
    void f.arbiter.prepareTurn("lt_1", "You there?")();
    await vi.advanceTimersByTimeAsync(voiceLiveTurnSettleMs - 1);
    expect(f.posts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.posts).toHaveLength(1);
  });

  it("saves an interrupted turn at once", async () => {
    const f = fixture();
    void f.arbiter.prepareTurn("lt_1", "Tell me")();
    f.arbiter.receive({ type: "reply_delta", turn_id: "lt_1", text: "First" });
    f.arbiter.receive({ type: "reply_interrupted", turn_id: "lt_1" });
    await vi.waitFor(() => expect(f.posts).toHaveLength(1));
    expect(f.liveTexts()).toEqual(["First"]);
  });

  it("keeps a turn the Human went on from with the call, away from Room Agents", async () => {
    vi.useFakeTimers();
    const f = fixture();
    void f.arbiter.prepareTurn("lt_1", "Look at the group made earlier")();
    void f.arbiter.prepareTurn("lt_2", "then jump to the chat window")();
    f.arbiter.receive({ type: "reply_done", turn_id: "lt_2", text: "Done" });
    await vi.advanceTimersByTimeAsync(voiceLiveTurnSettleMs);
    expect(f.posts).toEqual([
      {
        text: "then jump to the chat window",
        eventId: "lt_2",
        marker: { voice_session_id: "live-session", turn_id: "lt_2" },
      },
      {
        text: "Look at the group made earlier",
        eventId: "lt_1",
        marker: { voice_session_id: "live-session", turn_id: "lt_1" },
      },
    ]);
  });

  it("saves only the longer turn when the Human goes on with the same sentence", async () => {
    const f = fixture();
    void f.arbiter.prepareTurn("lt_1", "Note for me")();
    void f.arbiter.prepareTurn(
      "lt_2",
      "Note for me a meeting at three tomorrow",
    )();
    f.arbiter.receive({ type: "reply_done", turn_id: "lt_2", text: "Noted" });
    await vi.waitFor(() => expect(f.posts).toHaveLength(1));
    expect(f.posts[0]!.text).toBe("Note for me a meeting at three tomorrow");
    expect(continuesTurn("Note for me.", "Note for me, tomorrow")).toBe(true);
    expect(continuesTurn("O", "OK")).toBe(false);
  });

  it("reads and operates the page for the live model", async () => {
    const f = fixture({
      state: () => ({ key: "a", text: "Page: Pocket Note" }),
      read: () => "Page body",
    });
    f.arbiter.receive({
      type: "tool_request",
      turn_id: "lt_1",
      call_id: "r1",
      tool: "read_page",
      text: "Wang",
    });
    f.arbiter.receive({
      type: "tool_request",
      turn_id: "lt_1",
      call_id: "p1",
      tool: "page_action",
      text: '{"action":"scroll","target":"down"}',
    });
    await vi.waitFor(() =>
      expect(
        f.sent.filter((event) => event.type === "tool_result"),
      ).toHaveLength(2),
    );
    const results = Object.fromEntries(
      f.sent
        .filter((event) => event.type === "tool_result")
        .map((event) => [event.call_id, JSON.parse(event.text!)]),
    );
    expect(results.r1).toEqual({
      status: "ok",
      page: "Page body",
      clickable: "e1 Pocket Note",
    });
    expect(results.p1).toEqual({ status: "done" });
    expect(pageTools.runs).toEqual([{ action: "scroll", target: "down" }]);
    f.arbiter.dispose();
  });

  it("ends Voice Mode once the goodbye was heard", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.arbiter.receive({
      type: "tool_request",
      turn_id: "lt_9",
      call_id: "e1",
      tool: "end_voice_mode",
      text: "end",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.exits).toEqual([]);
    f.arbiter.receive({ type: "playout_done", turn_id: "lt_9" });
    await vi.advanceTimersByTimeAsync(endVoiceModeTailMs);
    expect(f.exits).toEqual([1]);
  });

  it("shows a background update in its own bubble with the words actually said", () => {
    const f = fixture();
    void f.arbiter.prepareTurn("lt_1", "What day is it")();
    f.arbiter.receive({
      type: "reply_delta",
      turn_id: "lt_1",
      text: "Monday.",
    });
    f.arbiter.receive({
      type: "speech_started",
      turn_id: "lt_1",
      speech_id: "update_1",
      text: "",
    });
    f.arbiter.receive({
      type: "reply_delta",
      turn_id: "lt_1",
      speech_id: "update_1",
      text: "By the way, ",
    });
    f.arbiter.receive({
      type: "reply_delta",
      turn_id: "lt_1",
      speech_id: "update_1",
      text: "the pricing is ready.",
    });
    f.arbiter.receive({
      type: "reply_done",
      turn_id: "lt_1",
      speech_id: "update_1",
      text: "By the way, the pricing is ready.",
    });
    expect(f.liveTexts()).toEqual([
      "Monday.",
      "By the way, the pricing is ready.",
    ]);
    // An update's words never become the turn's reply.
    f.arbiter.receive({ type: "reply_done", turn_id: "lt_1", text: "Monday." });
    expect(f.liveTexts()).toEqual([
      "Monday.",
      "By the way, the pricing is ready.",
    ]);
  });

  it("tells the live model only where the Human is, once the page holds still", async () => {
    vi.useFakeTimers();
    let state = {
      key: "wiki",
      text: "Page: Wiki · Lev8 product plan (/wiki/lev8)",
    };
    const f = fixture({ state: () => state, read: () => "" });
    await vi.advanceTimersByTimeAsync(1_400);
    const contexts = f.sent.filter((event) => event.type === "context");
    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.text).toContain("not material to answer from");
    expect(contexts[0]!.text).toContain("Lev8 product plan");
    state = { key: "wiki", text: state.text };
    await vi.advanceTimersByTimeAsync(1_400);
    expect(f.sent.filter((event) => event.type === "context")).toHaveLength(1);
    f.arbiter.dispose();
  });
});
