import { expect, it, vi } from "vitest";
import { createRuntimeContextRefresh } from "../../../src/agent/bootstrap/runtime-context-refresh.js";

it("drains the running refresh and discards pending work and retry timers on close", async () => {
  vi.useFakeTimers();
  let reject!: (error: Error) => void;
  const refresh = vi.fn(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      }),
  );
  const scheduler = createRuntimeContextRefresh(refresh);
  try {
    scheduler.request();
    scheduler.request();
    let closed = false;
    const closing = scheduler.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    reject(new Error("shutdown"));
    await closing;
    scheduler.request();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledOnce();
  } finally {
    await scheduler.close();
    vi.useRealTimers();
  }
});
