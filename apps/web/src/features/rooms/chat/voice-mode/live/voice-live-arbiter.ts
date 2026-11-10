import type {
  TeamHubVoiceLiveClientEvent,
  TeamHubVoiceLiveRuntimeEvent,
} from "@/features/teamhub/teamhub-types";
import type { VoiceCommandContext } from "../commands/voice-command";
import type { VoiceModeTurnSend } from "../voice-mode-session";
import {
  pageReady,
  readPageTargets,
  runPageAction,
} from "./voice-live-page-tools";
import { readVoicePage, type VoicePageState } from "./voice-page-reader";

/** The voice window keeps this many exchanges of the call. */
const transcriptLines = 200;

/** One thing said in the call, by the Human or by the assistant's voice. */
export interface VoiceLiveLine {
  id: string;
  speaker: "you" | "live";
  text: string;
  /** Still being said. */
  pending?: boolean;
}

/**
 * How long a turn waits for its whole reply, tool rounds included, before it
 * is saved anyway. The runtime says reply_done once the reply and every tool
 * round of the turn ended, so a hand-off is known before the turn is saved.
 */
export const voiceLiveTurnSettleMs = 20_000;

/** Punctuation and spacing never decide whether a turn continues. */
function comparableSpeech(text: string) {
  return text.toLowerCase().replaceAll(/[\p{P}\p{S}\s]/gu, "");
}

/** The later turn repeats the earlier one and says more. */
export function continuesTurn(earlier: string, later: string) {
  const before = comparableSpeech(earlier);
  const after = comparableSpeech(later);
  return (
    before.length >= 2 && after.length > before.length && after.includes(before)
  );
}

const pageSyncMs = 700;

export interface VoicePageSource {
  state: () => VoicePageState;
  read: () => string;
}
/** After the goodbye reply ends, voice mode closes after this short tail. */
export const endVoiceModeTailMs = 300;
/** Voice mode closes by then even if the goodbye reply never arrives. */
export const endVoiceModeCapMs = 10_000;
/** Exit or fallback waits this long for turns still being saved. */
const settleMs = 10_000;

interface LiveTurn {
  receivedAt: number;
  reply: string;
  interrupted: boolean;
  /** The reply text was first shown. */
  shown: boolean;
  heard: boolean;
  /** Settles once the turn's whole reply ended, or the turn was continued. */
  settled: Promise<void>;
  settle: () => void;
  /** What the Human said in this turn. */
  text?: string;
  /** The next turn repeated this one and said more; only that one is saved. */
  continued?: boolean;
  /** The turn's Human Message is being saved. */
  posted?: boolean;
  /** The live model answered it; otherwise a Room Agent should. */
  answered?: boolean;
  /**
   * The Human went on talking in the call before it was answered: the live
   * model answers the later turn with this one in its context.
   */
  superseded?: boolean;
}

export type VoiceLiveArbiter = ReturnType<typeof createVoiceLiveArbiter>;

/**
 * Shows the call and saves each turn the live model heard once, as the
 * Human's own words with the live marker; TeamHub decides from the turn's
 * tasks whether a Room Agent receives it. Runs the page tools the live model
 * calls. Background work reaches the live model through Voice Runtime, not
 * through this page.
 */
export function createVoiceLiveArbiter(options: {
  /** The open live session, once its data channel is usable. */
  voiceSessionId: () => string | undefined;
  active: () => boolean;
  send: (event: TeamHubVoiceLiveClientEvent) => void;
  context: VoiceCommandContext;
  prepare: (text: string, eventId: string) => VoiceModeTurnSend;
  /** This call's exchanges, in the order they were said. */
  onTranscript: (lines: readonly VoiceLiveLine[]) => void;
  /** The page the Human sees; when given, where they are is kept in sync. */
  page?: VoicePageSource;
}) {
  let disposed = false;
  const page = options.page;
  const send = (event: TeamHubVoiceLiveClientEvent) => {
    if (disposed || !options.active()) return false;
    options.send(event);
    return true;
  };
  /** The last page state the live model was told about. */
  let toldPage: string | undefined;
  let seenPage: string | undefined;
  // A changed page is told once it holds still for one tick, so a burst of
  // changes while navigating becomes one update. Only where the Human is:
  // what a page says is read on request.
  const pageSync =
    page &&
    setInterval(() => {
      const state = page.state();
      if (state.key === toldPage) return;
      if (state.key !== seenPage) {
        seenPage = state.key;
        return;
      }
      if (
        send({
          type: "context",
          text: `The user is now looking at this page in the app (where they are, not material to answer from):\n${state.text}`,
        })
      )
        toldPage = state.key;
    }, pageSyncMs);
  const turns = new Map<string, LiveTurn>();
  // Captions and speech may precede the final user turn. Creating this display
  // state does not save anything.
  const ensureTurn = (turnId: string) => {
    const existing = turns.get(turnId);
    if (existing) return existing;
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const turn: LiveTurn = {
      receivedAt: now(),
      reply: "",
      interrupted: false,
      shown: false,
      heard: false,
      settled,
      settle,
    };
    turns.set(turnId, turn);
    if (turns.size > transcriptLines) turns.delete(turns.keys().next().value!);
    return turn;
  };
  const pending = new Set<Promise<unknown>>();
  const track = <T>(work: Promise<T>) => {
    pending.add(work);
    void work.finally(() => pending.delete(work)).catch(() => undefined);
    return work;
  };
  // Lines are added as they are said, so nothing saved later or by another
  // writer reorders them.
  const transcript: VoiceLiveLine[] = [];
  const writeLine = (line: VoiceLiveLine) => {
    if (disposed || !options.active()) return;
    const index = transcript.findIndex((item) => item.id === line.id);
    if (index >= 0) transcript[index] = line;
    else {
      const replyIndex =
        line.speaker === "you"
          ? transcript.findIndex((item) => item.id === `${line.id}:reply`)
          : -1;
      if (replyIndex >= 0) transcript.splice(replyIndex, 0, line);
      else transcript.push(line);
    }
    transcript.splice(0, Math.max(0, transcript.length - transcriptLines));
    options.onTranscript([...transcript]);
  };
  const showReply = (turnId: string, turn: LiveTurn, saying: boolean) => {
    if (!turn.reply) return;
    writeLine({
      id: `${turnId}:reply`,
      speaker: "live",
      text: turn.reply,
      ...(saying ? { pending: true } : {}),
    });
    if (turn.shown) return;
    turn.shown = true;
    logVoiceLiveMetric("first_subtitle_ms", now() - turn.receivedAt);
  };
  /** Background updates the runtime said, by their speech ID. */
  const updates = new Map<string, string>();

  let endAfterTurn: string | undefined;
  let endTimer: ReturnType<typeof setTimeout> | undefined;
  let ended = false;
  const endVoiceMode = () => {
    clearTimeout(endTimer);
    if (ended || disposed) return;
    ended = true;
    options.context.exitVoiceMode();
  };
  let latestTurnId: string | undefined;
  const pageActions = new Set<string>();
  const toolRequest = async (event: TeamHubVoiceLiveRuntimeEvent) => {
    const callId = event.call_id;
    if (!callId) return;
    const text = event.text?.trim() ?? "";
    const reply = (result: Record<string, unknown>) =>
      send({
        type: "tool_result",
        call_id: callId,
        text: JSON.stringify(result),
      });
    try {
      if (event.tool === "read_page") {
        // A list still loading would read as an empty page.
        await pageReady();
        return reply({
          status: "ok",
          page: (page?.read ?? readVoicePage)(),
          clickable: readPageTargets(
            options.context,
            // Runtime's placeholder when the model gave no focus.
            text.replace(/^visible page$/u, ""),
          ),
        });
      }
      if (event.tool === "end_voice_mode") {
        // The live model says its own goodbye; voice mode ends once that
        // reply is heard (or after a short cap if it never comes).
        endAfterTurn = event.turn_id ?? latestTurnId;
        clearTimeout(endTimer);
        endTimer = setTimeout(endVoiceMode, endVoiceModeCapMs);
        return reply({
          status: "done",
          detail:
            "Voice mode ends after your goodbye. Now say a very short goodbye in the user's language.",
        });
      }
      if (event.tool === "page_action") {
        if (disposed || !options.active() || pageActions.has(callId))
          return reply({ status: "outcome_unknown" });
        pageActions.add(callId);
        if (!text) return reply({ status: "failed", detail: "Empty request." });
        const result = await runPageAction(
          JSON.parse(text) as Record<string, unknown>,
          options.context,
          () => !disposed && options.active(),
        );
        return reply({ ...result });
      }
      return reply({ status: "failed", detail: "Unknown tool." });
    } catch (error) {
      reply({
        status: "outcome_unknown",
        detail: error instanceof Error ? error.message : "The action failed.",
      });
    }
  };

  return {
    /** Shows a turn as soon as it is heard; returns its one-time save. */
    prepareTurn(turnId: string, text: string) {
      writeLine({ id: turnId, speaker: "you", text });
      const sendTurn = options.prepare(text, turnId);
      const previous = latestTurnId ? turns.get(latestTurnId) : undefined;
      if (
        previous &&
        !previous.posted &&
        previous.text !== undefined &&
        continuesTurn(previous.text, text)
      ) {
        previous.continued = true;
        previous.settle();
      } else if (previous && !previous.posted) previous.superseded = true;
      latestTurnId = turnId;
      const turn = ensureTurn(turnId);
      turn.text = text;
      const heardBy = options.active() ? options.voiceSessionId() : undefined;
      const sendHeardTurn = () =>
        track(
          (async () => {
            // Saved once the whole reply ended, so TeamHub already knows
            // whether the live model handed this turn to a task.
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([
              turn.settled,
              new Promise((resolve) => {
                timer = setTimeout(resolve, voiceLiveTurnSettleMs);
              }),
            ]);
            clearTimeout(timer);
            // A turn the Human goes on with is saved once, as the longer turn.
            if (turn.continued) return;
            turn.posted = true;
            // A turn the live session never answered, such as one heard as
            // it failed, goes to the Room Agent as an ordinary Message.
            await sendTurn(
              heardBy && (turn.answered || turn.superseded)
                ? { voice_session_id: heardBy, turn_id: turnId }
                : undefined,
            );
          })(),
        );
      // The words stay shown until the turn is saved.
      return Object.assign(sendHeardTurn, { keepsText: true });
    },
    receive(event: TeamHubVoiceLiveRuntimeEvent) {
      if (disposed || !options.active()) return;
      // A background update the runtime said has its own bubble, filled with
      // the words actually spoken.
      if (event.speech_id) {
        const id = event.speech_id;
        if (event.type === "speech_started") updates.set(id, event.text ?? "");
        if (!updates.has(id)) return;
        if (event.type === "reply_delta")
          updates.set(id, updates.get(id)! + (event.text ?? ""));
        else if (event.type === "reply_done" && event.text)
          updates.set(id, event.text);
        const words = updates.get(id)!;
        if (words) writeLine({ id, speaker: "live", text: words });
        if (event.type === "reply_done" || event.type === "reply_interrupted")
          updates.delete(id);
        return;
      }
      if (event.type === "user_partial") {
        if (event.turn_id) ensureTurn(event.turn_id);
        return;
      }
      if (event.type === "tool_request") {
        void toolRequest(event);
        return;
      }
      // Leave once the goodbye has actually been heard: the Runtime says so
      // when that turn's reply audio has drained from the reply track.
      if (
        endAfterTurn &&
        event.turn_id === endAfterTurn &&
        (event.type === "playout_done" || event.type === "reply_interrupted")
      ) {
        clearTimeout(endTimer);
        endTimer = setTimeout(endVoiceMode, endVoiceModeTailMs);
      }
      if (event.type === "playout_done" || !event.turn_id) return;
      const turn =
        event.type === "reply_delta" || event.type === "reply_done"
          ? ensureTurn(event.turn_id)
          : turns.get(event.turn_id);
      if (!turn) return;
      turn.answered = true;
      if (event.type === "reply_interrupted") {
        turn.interrupted = true;
        turn.settle();
        showReply(event.turn_id, turn, false);
        return;
      }
      if (event.type === "reply_done") {
        turn.settle();
        if (!turn.interrupted && event.text) turn.reply = event.text;
        showReply(event.turn_id, turn, false);
        return;
      }
      if (turn.interrupted) return;
      if (event.type === "reply_delta") {
        turn.reply += event.text ?? "";
        showReply(event.turn_id, turn, true);
      }
    },
    /** The reply playback just became audible. */
    audible() {
      for (const turn of [...turns.values()].reverse())
        if (!turn.heard) {
          turn.heard = true;
          logVoiceLiveMetric("first_audible_ms", now() - turn.receivedAt);
          return;
        }
    },
    /** Waits, bounded, for turns still being saved. */
    async settle() {
      for (const turn of turns.values()) turn.settle();
      await Promise.race([
        Promise.allSettled([...pending]),
        new Promise((resolve) => setTimeout(resolve, settleMs)),
      ]);
    },
    dispose() {
      disposed = true;
      // Turns still waiting are saved now, as whatever they became.
      for (const turn of turns.values()) turn.settle();
      clearTimeout(endTimer);
      if (pageSync) clearInterval(pageSync);
    },
  };
}

const now = () => performance.now();

/** Numbers only: how long a turn waited for its first subtitle or sound. */
function logVoiceLiveMetric(name: string, milliseconds: number) {
  if (import.meta.env.MODE !== "test")
    console.debug("[voice-live]", name, Math.round(milliseconds));
}
