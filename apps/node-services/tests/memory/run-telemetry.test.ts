import { describe, expect, it, vi } from "vitest";

import {
  memoryScheduleRunLevel,
  recordSubjectFailure,
  writeMemoryLog,
} from "../../src/memory/run-telemetry.js";

function captureStderr(work: () => void): unknown[] {
  const writes: unknown[] = [];
  const write = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk) => {
      writes.push(JSON.parse(String(chunk)));
      return true;
    });
  try {
    work();
    return writes;
  } finally {
    write.mockRestore();
  }
}

describe("Memory structured logs", () => {
  it("marks isolated subject failures as ERROR", () => {
    expect(
      captureStderr(() =>
        recordSubjectFailure({
          error: "graph failed",
          memory_subject_key: "agent_bad",
        }),
      ),
    ).toMatchObject([
      {
        event: "memory_subject_refresh_failed",
        level: "error",
        error: "graph failed",
        memory_subject_key: "agent_bad",
      },
    ]);
  });

  it("keeps a clean hourly run as INFO and raises skipped or failed runs to ERROR", () => {
    expect(memoryScheduleRunLevel({ status: "succeeded" })).toBe("INFO");
    expect(
      memoryScheduleRunLevel({
        status: "succeeded",
        subjectFailures: [{ memory_subject_key: "agent_bad" }],
      }),
    ).toBe("ERROR");
    expect(memoryScheduleRunLevel({ status: "failed" })).toBe("ERROR");
    expect(
      captureStderr(() =>
        writeMemoryLog(
          "memory_schedule_run",
          { status: "succeeded", skippedPageCount: 1 },
          "ERROR",
        ),
      ),
    ).toMatchObject([
      {
        event: "memory_schedule_run",
        level: "error",
        status: "succeeded",
        skippedPageCount: 1,
      },
    ]);
  });
});
