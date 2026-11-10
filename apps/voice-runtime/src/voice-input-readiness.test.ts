import { describe, expect, it, vi } from "vitest";
import { waitForVoiceInputReady } from "../acceptance/voice-input-readiness.js";

describe("acceptance input readiness", () => {
  it("retries transient HTTP errors before the current input is ready", async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("provider restarting"), { status: 502 }),
      )
      .mockResolvedValue({ input_ready_generation: 1 });
    await waitForVoiceInputReady(read, 1, 1_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("does not retry a forbidden session", async () => {
    const error = Object.assign(new Error("membership revoked"), {
      status: 403,
    });
    const read = vi.fn().mockRejectedValue(error);
    await expect(waitForVoiceInputReady(read, 1)).rejects.toBe(error);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("aborts a stalled read without exceeding the total budget", async () => {
    let aborted = false;
    const read = async (signal: AbortSignal) => {
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        ),
      );
      return { input_ready_generation: 0 };
    };
    await expect(waitForVoiceInputReady(read, 1, 30)).rejects.toThrow(
      "did not acknowledge",
    );
    expect(aborted).toBe(true);
  });
});
