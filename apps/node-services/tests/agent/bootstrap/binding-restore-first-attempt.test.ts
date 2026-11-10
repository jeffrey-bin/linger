import { describe, expect, it, vi } from "vitest";
import { restorePersistedBindings } from "../../../src/agent/bootstrap/binding-restore.js";
import type { AgentLogger } from "../../../src/agent/observability/agent-log.js";

const logger: AgentLogger = {
  log: vi.fn(),
  child() {
    return logger;
  },
};

describe("restorePersistedBindings first attempt", () => {
  it("reports the first attempt once when it succeeds", async () => {
    const onFirstAttemptSettled = vi.fn();
    const restore = vi.fn(async () => undefined);
    await restorePersistedBindings(
      { restore },
      new AbortController().signal,
      logger,
      { onFirstAttemptSettled },
    );
    expect(onFirstAttemptSettled).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it("reports the first attempt once when it fails without retry", async () => {
    const onFirstAttemptSettled = vi.fn();
    const restore = vi.fn(async () => {
      throw new Error("corrupt binding");
    });
    await restorePersistedBindings(
      { restore },
      new AbortController().signal,
      logger,
      { onFirstAttemptSettled },
    );
    expect(onFirstAttemptSettled).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledTimes(1);
  });
});
