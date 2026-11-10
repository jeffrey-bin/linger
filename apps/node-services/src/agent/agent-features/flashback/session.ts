import { randomUUID } from "node:crypto";

import type { AgentLogger } from "../../observability/agent-log.js";
import type { Message } from "../../executor/types.js";
import type {
  FeatureSubmitOptions,
  FeatureSubmitResult,
} from "../contracts.js";
import type { Flashback, FlashbackSuggestion } from "../../../flashback.js";
import { renderFlashbackContext } from "./prompt.js";

/** How a session reaches the Context instance whose input it reacts to. */
export interface FlashbackContextPorts {
  /** The run claimed or executing in this Context, if any. */
  activeRunId(): string | undefined;
  /** Adds the message to the running turn without interrupting it. */
  readonly steer?: (
    runId: string,
    message: Message,
    options?: FeatureSubmitOptions,
  ) => Promise<FeatureSubmitResult>;
  /** Starts a follow-up turn after the reply is done. */
  followUp(
    message: Message,
    options?: FeatureSubmitOptions,
  ): Promise<FeatureSubmitResult>;
}

export interface FlashbackSettings {
  /** A finished reply may get a follow-up only this soon after the input. */
  readonly followUpWindowMs: number;
  /** A follow-up turn costs a model run, so it needs a stronger recall. */
  readonly followUpMinScore: number;
  /** How long to wait for the run of an accepted input to be claimed. */
  readonly claimWaitMs: number;
}

export const DEFAULT_FLASHBACK_SETTINGS: FlashbackSettings = {
  followUpWindowMs: 60_000,
  followUpMinScore: 0.6,
  claimWaitMs: 3_000,
};

/**
 * One bound Context instance's recall state: recalling an earlier
 * conversation for an Another Me without delaying its reply. The suggestion
 * is fetched beside the run; when it arrives it is steered into the running
 * turn, or, when the reply is already done, a strong one may start a short
 * follow-up turn, but only if no newer input arrived meanwhile. Late, weak,
 * or stale suggestions are dropped, and only a durably accepted flashback
 * is recorded against Memory's budgets.
 *
 * The acceptance generation, stable inputId replay dedup, and in-flight
 * result attribution all belong to this instance: a same-ref Context
 * replacement binds a fresh session, while Runtime suspend keeps it.
 */
export class FlashbackSession {
  /** Acceptance generation for this instance; a later input stales recalls. */
  #accepted = 0;
  readonly #seenInputIds = new Set<string>();

  constructor(
    private readonly client: Flashback,
    private readonly logger: AgentLogger,
    private readonly settings: FlashbackSettings = DEFAULT_FLASHBACK_SETTINGS,
  ) {}

  /**
   * Notes one durable acceptance; returns false for a replayed stable
   * inputId, which was already counted and must not stale or recall again.
   */
  noteAccepted(inputId: string): boolean {
    if (this.#seenInputIds.has(inputId)) return false;
    this.#seenInputIds.add(inputId);
    this.#accepted += 1;
    return true;
  }

  /** Starts a recall for input the represented Human wrote; never throws. */
  recall(input: {
    /** Invalidation of the bound Context instance this recall belongs to. */
    readonly signal: AbortSignal;
    readonly tenantId: string;
    readonly ownerActorId: string;
    readonly roomId?: string;
    readonly text: string;
    readonly ports: FlashbackContextPorts;
  }): Promise<void> {
    const sequence = this.#accepted;
    const acceptedAt = Date.now();
    return this.#recall(input, sequence, acceptedAt).catch((error: unknown) => {
      // An invalidated instance dropping its late result is expected.
      if (!input.signal.aborted)
        this.logger.log("warn", "flashback.failed", { error });
    });
  }

  async #recall(
    input: Parameters<FlashbackSession["recall"]>[0],
    sequence: number,
    acceptedAt: number,
  ): Promise<void> {
    const { suggestion } = await this.client.suggest({
      tenant_id: input.tenantId,
      owner_actor_id: input.ownerActorId,
      ...(input.roomId ? { room_id: input.roomId } : {}),
      text: input.text.slice(0, 8000),
    });
    if (!suggestion) return;
    const stale = () => input.signal.aborted || this.#accepted !== sequence;
    const log = (outcome: string) =>
      this.logger.log("info", "flashback.outcome", {
        outcome,
        episode: suggestion.episode,
        score: suggestion.score,
        via: suggestion.cue.via,
        latencyMs: Date.now() - acceptedAt,
      });
    if (stale()) return log("stale");

    const runId = await this.#claimedRun(input.ports, input.signal);
    if (stale()) return log("stale");
    // canSubmit re-checks staleness at the submission fence so a newer input
    // accepted during the async wait still voids this suggestion.
    const submitOptions = { canSubmit: () => !stale() };
    if (runId && input.ports.steer) {
      const submission = await input.ports.steer(
        runId,
        flashbackMessage(suggestion, "during_reply", input.roomId),
        submitOptions,
      );
      if (submission.status === "skipped") return log("stale");
      log("steered");
    } else if (runId) {
      return log("busy_without_steer");
    } else if (
      Date.now() - acceptedAt <= this.settings.followUpWindowMs &&
      suggestion.score >= this.settings.followUpMinScore
    ) {
      const submission = await input.ports.followUp(
        flashbackMessage(suggestion, "after_reply", input.roomId),
        submitOptions,
      );
      if (submission.status === "skipped") return log("stale");
      log("follow_up");
    } else {
      return log("dropped");
    }
    // An invalidated instance drops the late result's record too; a still
    // bound instance records the durably accepted suggestion.
    if (input.signal.aborted) return log("stale");
    await this.client
      .record({
        tenant_id: input.tenantId,
        owner_actor_id: input.ownerActorId,
        ...(input.roomId ? { room_id: input.roomId } : {}),
        episode: suggestion.episode,
        cue_id: suggestion.cue.id,
      })
      .catch((error: unknown) =>
        this.logger.log("warn", "flashback.record_failed", { error }),
      );
  }

  /** The run for the input, once claimed; none when the reply is done. */
  async #claimedRun(ports: FlashbackContextPorts, signal: AbortSignal) {
    const deadline = Date.now() + this.settings.claimWaitMs;
    for (;;) {
      if (signal.aborted) return undefined;
      const runId = ports.activeRunId();
      if (runId || Date.now() >= deadline) return runId;
      await sleep(200, signal);
    }
  }
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (signal.aborted) done();
    else signal.addEventListener("abort", done, { once: true });
  });

const flashbackMessage = (
  suggestion: FlashbackSuggestion,
  delivery: Parameters<typeof renderFlashbackContext>[1],
  roomId: string | undefined,
): Message => {
  const rawMessage = renderFlashbackContext(suggestion, delivery);
  return {
    messageId: `flashback-${randomUUID()}`,
    rawMessage,
    segments: [{ type: "text", content: rawMessage }],
    // A follow-up shows the Room activity indicator like any reply.
    ...(delivery === "after_reply" && roomId
      ? { sourceInboxIds: [`room:${roomId}`] }
      : {}),
  };
};
