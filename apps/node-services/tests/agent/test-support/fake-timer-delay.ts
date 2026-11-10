import type { TimerOptions } from "node:timers";

/** Test-only bridge from Promise timers to Vitest's controllable global clock. */
export function fakeTimerDelay<T = void>(
  milliseconds: number,
  value?: T,
  { signal }: Pick<TimerOptions, "signal"> = {},
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const abortError = () =>
      Object.assign(
        new Error("The operation was aborted", { cause: signal?.reason }),
        {
          name: "AbortError",
          code: "ABORT_ERR",
        },
      );
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve(value);
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
