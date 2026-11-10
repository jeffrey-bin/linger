import type { TeamHubVoiceSession } from "@/features/teamhub/teamhub-types";
import {
  TeamHubError,
  TeamHubTransportError,
} from "@/features/teamhub/teamhub-error";

export async function waitForVoiceInputReady(
  read: (
    signal: AbortSignal,
  ) => Promise<Pick<TeamHubVoiceSession, "input_ready_generation">>,
  generation: number,
  isCurrent: () => boolean,
  timeoutMs = 30_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isCurrent()) throw new Error("Voice input connection was superseded");
    const attempt = new AbortController();
    const timer = setTimeout(
      () => attempt.abort(),
      Math.min(5_000, deadline - Date.now()),
    );
    let session:
      | Pick<TeamHubVoiceSession, "input_ready_generation">
      | undefined;
    try {
      session = await read(attempt.signal);
    } catch (error) {
      if (
        !attempt.signal.aborted &&
        !(error instanceof TeamHubTransportError) &&
        !(
          error instanceof TeamHubError &&
          (error.status === 429 || error.status >= 500)
        )
      )
        throw error;
    } finally {
      clearTimeout(timer);
    }
    if (!isCurrent()) throw new Error("Voice input connection was superseded");
    if (Date.now() >= deadline) break;
    if (session?.input_ready_generation === generation) return;
    const remaining = deadline - Date.now();
    if (remaining > 0)
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(200, remaining)),
      );
  }
  throw new Error("Voice input did not become ready");
}
