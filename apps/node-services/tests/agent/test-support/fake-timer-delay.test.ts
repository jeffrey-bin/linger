import { afterEach, expect, it, vi } from "vitest";
import { fakeTimerDelay } from "./fake-timer-delay.js";

afterEach(() => vi.useRealTimers());

it("resolves only at the deadline and removes the abort listener", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const resolved = vi.fn();
  const result = fakeTimerDelay(5_000, "ready", {
    signal: controller.signal,
  }).then(resolved);
  await vi.advanceTimersByTimeAsync(4_999);
  expect(resolved).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await result;
  expect(resolved).toHaveBeenCalledExactlyOnceWith("ready");
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  expect(vi.getTimerCount()).toBe(0);
});

it.each([true, false])(
  "rejects cancellation and leaves no timer (already aborted: %s)",
  async (alreadyAborted) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = new Error("cancelled");
    if (alreadyAborted) controller.abort(reason);
    const result = fakeTimerDelay(5_000, undefined, {
      signal: controller.signal,
    }).catch((error: unknown) => error);
    if (!alreadyAborted) controller.abort(reason);
    expect(await result).toMatchObject({
      name: "AbortError",
      code: "ABORT_ERR",
      cause: reason,
    });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
  },
);
