import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeTeamHubCliConfiguration } from "../../../src/agent/executor/local-backend.js";

const HOUR = 60 * 60 * 1000;
const signal = () => new AbortController().signal;
const input = { type: "text" as const, text: "hello" };

afterEach(() => vi.useRealTimers());

describe("active Runtime CLI configuration", () => {
  it("ensures the credential before run.start and passes the scoped run context", async () => {
    const ensure = vi.fn(async (_signal: AbortSignal) => undefined);
    const runtime = createRuntimeTeamHubCliConfiguration({
      buildRunContext: ({ runId }) => ({
        run_id: runId,
        scope: { kind: "room", id: "room_one" },
      }),
      ensure,
    });
    runtime.setActiveRunContext({ runId: "run_one", sourceInboxIds: [] });
    expect(
      (await runtime.prepareRunInput(input, signal())).cliRunContext,
    ).toEqual({ run_id: "run_one", scope: { kind: "room", id: "room_one" } });
    expect(ensure).toHaveBeenCalledOnce();
  });

  it("asks the Gateway again for every Run input", async () => {
    // The Gateway sends nothing while the Computer holds the credential.
    const ensure = vi.fn(async (_signal: AbortSignal) => undefined);
    const runtime = createRuntimeTeamHubCliConfiguration({ ensure });
    runtime.setActiveRunContext({ runId: "run_one", sourceInboxIds: [] });
    await runtime.prepareRunInput(input, signal());
    await runtime.prepareRunInput(input, signal());
    expect(ensure).toHaveBeenCalledTimes(2);
  });

  it("never renews the credential on a timer during a long Run", async () => {
    vi.useFakeTimers();
    const ensure = vi.fn(async (_signal: AbortSignal) => undefined);
    const runtime = createRuntimeTeamHubCliConfiguration({ ensure });
    runtime.setActiveRunContext({ runId: "run_one", sourceInboxIds: [] });
    await vi.advanceTimersByTimeAsync(100 * HOUR);
    expect(ensure).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails the Run input when the Gateway cannot provide a usable credential", async () => {
    const refusal = Object.assign(new Error("Runner refused"), {
      retryable: false,
    });
    const runtime = createRuntimeTeamHubCliConfiguration({
      ensure: async () => {
        throw refusal;
      },
    });
    runtime.setActiveRunContext({ runId: "run_one", sourceInboxIds: [] });
    await expect(runtime.prepareRunInput(input, signal())).rejects.toBe(
      refusal,
    );
  });
});
