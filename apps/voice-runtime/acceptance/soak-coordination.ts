import { createInterface } from "node:readline";

/** The concurrent runner releases each phase only after every publisher is ready. */
export async function waitForSoakGate(
  phase: "start" | "stop",
  parent: AbortSignal,
) {
  parent.throwIfAborted();
  if (process.env.VOICE_SOAK_COORDINATED !== "1") return;
  const signal = AbortSignal.any([parent, AbortSignal.timeout(60_000)]);
  const lines = createInterface({ input: process.stdin });
  let cleanup = () => {};
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      const close = () =>
        reject(new Error("Concurrent soak coordinator disconnected"));
      const line = (value: string) => {
        if (value === phase) resolve();
        else reject(new Error("Unexpected concurrent soak phase"));
      };
      signal.addEventListener("abort", abort, { once: true });
      lines.once("close", close);
      lines.once("line", line);
      console.log(JSON.stringify({ status: "barrier-ready", phase }));
      // Cleanup lives on promise settlement, before closing readline below.
      cleanup = () => {
        signal.removeEventListener("abort", abort);
        lines.removeListener("close", close);
        lines.removeListener("line", line);
      };
    });
  } finally {
    cleanup();
    lines.close();
    process.stdin.pause();
  }
}
