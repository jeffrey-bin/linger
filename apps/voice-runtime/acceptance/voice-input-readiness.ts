import { setTimeout as delay } from "node:timers/promises";
import type { components } from "@linger/wire-contracts/teamhub-public/types";

type VoiceInputReadiness = Pick<
  components["schemas"]["VoiceSession"],
  "input_ready_generation"
>;

export async function waitForVoiceInputReady(
  read: (signal: AbortSignal) => Promise<VoiceInputReadiness>,
  generation: number,
  timeoutMs = 45_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const attempt = new AbortController();
    const timer = setTimeout(
      () => attempt.abort(),
      Math.min(5_000, deadline - Date.now()),
    );
    let session: VoiceInputReadiness | undefined;
    try {
      session = await read(attempt.signal);
    } catch (error) {
      const status =
        error instanceof Error && "status" in error ? Number(error.status) : 0;
      if (
        !attempt.signal.aborted &&
        !(error instanceof TypeError) &&
        status !== 429 &&
        !(Number.isInteger(status) && status >= 500 && status < 600)
      )
        throw error;
    } finally {
      clearTimeout(timer);
    }
    if (Date.now() >= deadline) break;
    if (session && session.input_ready_generation === undefined)
      throw new Error("Backend does not expose Voice input readiness");
    if (session?.input_ready_generation === generation) return;
    const remaining = deadline - Date.now();
    if (remaining > 0) await delay(Math.min(200, remaining));
  }
  throw new Error("Voice Runtime did not acknowledge the current publisher");
}
