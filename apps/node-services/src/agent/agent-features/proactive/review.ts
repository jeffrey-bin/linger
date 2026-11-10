import type { ProactiveClient } from "./client.js";
import { promptOpenItems } from "./judge.js";
import { renderProactiveDecideWake } from "./prompt.js";

/** At most this many pending windows are reviewed per accepted input. */
const MAX_WINDOWS_PER_REVIEW = 3;

export interface ReviewDeps {
  readonly client: ProactiveClient;
  readonly now?: () => Date;
}

export interface ReviewOutcome {
  readonly judgedCount: number;
}

/**
 * Hands each complete window of twenty to AnotherMe, which judges and acts
 * in one Run, and marks it judged. A failure leaves the window unjudged so
 * the next accepted input tries it again; the wake itself waits in TeamHub
 * until the Room has been quiet for three minutes.
 */
export async function reviewRoom(
  deps: ReviewDeps,
  roomId: string,
  agentId: string,
  signal?: AbortSignal,
): Promise<readonly ReviewOutcome[]> {
  const outcomes: ReviewOutcome[] = [];
  for (let index = 0; index < MAX_WINDOWS_PER_REVIEW; index++) {
    const window = await deps.client.window(roomId, agentId, signal);
    if (!window) break;
    const now = deps.now?.() ?? new Date();
    await deps.client.queueWake(
      roomId,
      agentId,
      renderProactiveDecideWake(
        window.messages,
        window.guideline.specific,
        promptOpenItems(window.open_items, now),
      ),
    );
    outcomes.push({ judgedCount: window.judged_count });
    if (!(await deps.client.finish(roomId, agentId, window.judged_count)))
      break;
  }
  return outcomes;
}
