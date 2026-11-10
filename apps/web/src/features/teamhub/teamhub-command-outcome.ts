import { TeamHubError } from "./teamhub-client";

export interface TeamHubCommandFailure {
  kind: "failed" | "unknown";
  message: string;
}

/**
 * `retryNote` tells the user what a retry does when the outcome is unknown:
 * a write that carries an Idempotency-Key replays the same intent, while
 * TeamHub answers a repeat of any other write as its contract describes.
 */
export function classifyTeamHubCommandFailure(
  error: unknown,
  uncertainOutcome: string,
  retryNote: string,
): TeamHubCommandFailure {
  if (error instanceof TeamHubError) {
    return { kind: "failed", message: error.message };
  }

  return {
    kind: "unknown",
    message: `TeamHub did not confirm whether ${uncertainOutcome}. ${retryNote}`,
  };
}
