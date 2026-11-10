import { AsyncLocalStorage } from "node:async_hooks";

import { createJsonLogger, type JsonLogger } from "@linger/service-kit/node";

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- needs an implicit index signature
export type MemorySubjectFailure = {
  readonly error: string;
  readonly memory_subject_key: string;
};

export interface MemoryWikiRefresh {
  readonly id?: string;
  readonly memory_subject_key: string;
  readonly status: string;
}

export type MemoryLogLevel = "ERROR" | "INFO";

export const memorySubjectFailureLog = new AsyncLocalStorage<
  MemorySubjectFailure[]
>();
export const memoryWikiRefreshLog = new AsyncLocalStorage<
  MemoryWikiRefresh[]
>();

// Memory modules log through the host's role logger once the service starts;
// CLIs and tests keep the stderr default.
let logger: JsonLogger = createJsonLogger({ service: "node-services" }).child({
  role: "memory",
});

export function setMemoryLogger(next: JsonLogger): void {
  logger = next;
}

export const memoryLogger = (): JsonLogger => logger;

export function writeMemoryLog(
  event: string,
  fields: Record<string, unknown> = {},
  level: MemoryLogLevel = "INFO",
): void {
  logger.log(level === "ERROR" ? "error" : "info", event, fields);
}

export function recordSubjectFailure(failure: MemorySubjectFailure): void {
  memorySubjectFailureLog.getStore()?.push(failure);
  writeMemoryLog("memory_subject_refresh_failed", failure, "ERROR");
}

// A refresh receipt keeps its latest outcome, so a run that only skipped a
// failed refresh never reads as a published Wiki.
export function recordWikiRefresh(refresh: MemoryWikiRefresh): void {
  const values = memoryWikiRefreshLog.getStore();
  if (!values) return;
  const index = values.findIndex(
    (value) =>
      value.memory_subject_key === refresh.memory_subject_key &&
      (refresh.id
        ? value.id === refresh.id
        : !value.id && value.status === refresh.status),
  );
  if (index === -1) values.push(refresh);
  else values[index] = refresh;
}

export function memoryScheduleRunLevel(run: {
  readonly status: "failed" | "running" | "succeeded";
  readonly subjectFailures?: readonly unknown[];
}): MemoryLogLevel {
  if (run.status === "failed") return "ERROR";
  if ((run.subjectFailures?.length ?? 0) > 0) return "ERROR";
  return "INFO";
}
