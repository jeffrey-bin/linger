import { vi } from "vitest";

/**
 * Captures completed `agent_runtime_measurement` log entries as
 * `[execution_backend, stage, outcome, duration_ms]`. Entries that only record
 * a missing reason are excluded.
 */
export function captureRuntimeMeasurements(): {
  readonly calls: () => unknown[][];
  readonly restore: () => void;
} {
  vi.stubEnv("AGENT_LOG_LEVEL", "info");
  // The default logger prints JSON lines only in production.
  vi.stubEnv("NODE_ENV", "production");
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  return {
    calls: () =>
      output.mock.calls
        .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
        .filter(
          (entry) =>
            entry.event === "agent_runtime_measurement" &&
            entry.duration_ms !== undefined,
        )
        .map((entry) => [
          entry.execution_backend,
          entry.stage,
          entry.outcome,
          entry.duration_ms,
        ]),
    restore: () => {
      output.mockRestore();
      vi.unstubAllEnvs();
    },
  };
}
