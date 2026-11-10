/** The whole process's budget from the first SIGINT or SIGTERM to exit. */
export const SHUTDOWN_TIMEOUT_MS = 95_000;

/** Reports when one shutdown phase starts and how it ends. */
export type ShutdownProgress = (
  phase: string,
  state: "started" | "completed" | "failed",
) => void;

/**
 * Runs once after shutdown, inside the same deadline, with the time left in
 * a bounded diagnostic budget. A drain must not turn success into failure.
 */
export type ExitDrain = (budgetMs: number) => Promise<unknown>;

export interface ProcessControl {
  /** Aborts when the first SIGINT or SIGTERM arrives. */
  readonly signal: AbortSignal;
  readonly progress: ShutdownProgress;
  /** Registers a drain that runs after the application closes or fails. */
  onExit(drain: ExitDrain): void;
}

// Install before the first startup await. The timer deliberately stays ref'ed:
// unresolved promises alone do not keep Node alive long enough to clean up.
export const runServiceProcess = async (
  start: (control: ProcessControl) => Promise<{ close(): Promise<void> }>,
  timeoutMs: number,
): Promise<void> => {
  const controller = new AbortController();
  let resolveStopping!: () => void;
  const stopping = new Promise<void>((resolve) => {
    resolveStopping = resolve;
  });
  const pending = new Set<string>(["startup"]);
  const phaseStartedAt = new Map<string, number>();
  const drains: ExitDrain[] = [];
  const interrupted = new Error("Process shutdown requested");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: number | undefined;
  const progress: ShutdownProgress = (phase, state) => {
    if (state === "started") {
      pending.add(phase);
      phaseStartedAt.set(phase, performance.now());
    } else pending.delete(phase);
    const durationMs = Math.round(
      performance.now() - (phaseStartedAt.get(phase) ?? performance.now()),
    );
    console.log(
      JSON.stringify({ event: "shutdown.phase", phase, state, durationMs }),
    );
  };
  // Later signals are ignored: cleanup always finishes or hits the deadline.
  const stop = (): void => {
    if (controller.signal.aborted) return;
    deadline = performance.now() + timeoutMs;
    console.log(JSON.stringify({ event: "shutdown.requested", timeoutMs }));
    timer = setTimeout(() => {
      console.error(
        JSON.stringify({ event: "shutdown.timeout", pending: [...pending] }),
      );
      process.exit(1);
    }, timeoutMs);
    controller.abort(interrupted);
    resolveStopping();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let exitCode = 0;
  let starting = true;
  try {
    const application = await start({
      signal: controller.signal,
      progress,
      onExit: (drain) => drains.push(drain),
    });
    starting = false;
    pending.delete("startup");
    await stopping;
    pending.add("application");
    try {
      await application.close();
    } finally {
      pending.delete("application");
    }
  } catch (error) {
    if (
      error !== interrupted &&
      !(
        starting &&
        controller.signal.aborted &&
        error instanceof Error &&
        error.name === "AbortError"
      )
    ) {
      exitCode = 1;
      console.error("Node Services startup or shutdown failed", error);
    }
  } finally {
    if (timer) clearTimeout(timer);
    // Business shutdown is complete. A diagnostic drain must not turn success
    // into failure or start a fresh budget beyond the original deadline.
    const remaining =
      deadline === undefined
        ? 1_000
        : Math.max(0, deadline - performance.now());
    await Promise.all(
      drains.map((drain) =>
        drain(Math.min(1_000, remaining)).catch(() => undefined),
      ),
    );
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  console.log(JSON.stringify({ event: "shutdown.complete", exitCode }));
  process.exit(exitCode);
};
