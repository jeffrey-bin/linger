import { fetchDouble } from "@/features/teamhub/teamhub-client-test-support";
import { describe, expect, it, vi } from "vitest";
import { waitForVoiceInputReady } from "./voice-input-readiness";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { createHttpTeamHubClient } from "@/features/teamhub/teamhub-client";
import {
  TeamHubError,
  TeamHubTransportError,
} from "@/features/teamhub/teamhub-error";

describe("voice input readiness", () => {
  it("aborts a hanging HTTP read within the remaining total budget", async () => {
    vi.useFakeTimers();
    let attempt: AbortSignal | undefined;
    const fetchRequest = vi.fn<typeof fetch>(async (_input, options) => {
      const signal = options?.signal;
      if (!signal) throw new Error("Missing readiness request signal");
      attempt = signal;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    });
    const client = createHttpTeamHubClient({
      baseUrl: "http://voice.test",
      fetchRequest: fetchDouble((url, init) => fetchRequest(url, init)),
    });
    try {
      const result = expect(
        waitForVoiceInputReady(
          (signal) =>
            teamHubData(
              client.api.GET("/v0/voice-sessions/{voiceSessionId}", {
                params: { path: { voiceSessionId: "voice" } },
                signal,
              }),
            ),
          1,
          () => true,
          400,
        ),
      ).rejects.toThrow("did not become ready");
      await vi.advanceTimersByTimeAsync(400);
      await result;
      expect(attempt?.aborted).toBe(true);
      expect(fetchRequest).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers from transport and temporary provider errors while waiting", async () => {
    vi.useFakeTimers();
    try {
      const read = vi
        .fn()
        .mockRejectedValueOnce(new TeamHubTransportError("network interrupted"))
        .mockRejectedValueOnce(
          new TeamHubError({
            status: 502,
            code: "DEPENDENCY_UNAVAILABLE",
            message: "provider restarting",
          }),
        )
        .mockResolvedValue({ input_ready_generation: 2 });
      const result = waitForVoiceInputReady(read, 2, () => true).then(
        () => true,
        (error) => error,
      );
      await vi.advanceTimersByTimeAsync(400);
      expect(await result).toBe(true);
      expect(read).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry rejected Room access", async () => {
    const error = new TeamHubError({
      status: 403,
      code: "FORBIDDEN",
      message: "membership revoked",
    });
    const read = vi.fn().mockRejectedValue(error);
    await expect(waitForVoiceInputReady(read, 2, () => true)).rejects.toBe(
      error,
    );
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("waits for the current publisher instead of accepting an older consumer", async () => {
    vi.useFakeTimers();
    const read = vi
      .fn()
      .mockResolvedValueOnce({ input_ready_generation: 1 })
      .mockResolvedValue({ input_ready_generation: 2 });
    try {
      const result = waitForVoiceInputReady(read, 2, () => true);
      await vi.advanceTimersByTimeAsync(200);
      await result;
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not enable a superseded connection after a late response", async () => {
    let current = true;
    const read = async () => {
      current = false;
      return { input_ready_generation: 1 };
    };
    await expect(
      waitForVoiceInputReady(read, 1, () => current),
    ).rejects.toThrow("superseded");
  });

  it("bounds a consumer that never becomes ready", async () => {
    vi.useFakeTimers();
    try {
      const result = expect(
        waitForVoiceInputReady(
          async () => ({ input_ready_generation: 0 }),
          1,
          () => true,
          400,
        ),
      ).rejects.toThrow("did not become ready");
      await vi.advanceTimersByTimeAsync(400);
      await result;
    } finally {
      vi.useRealTimers();
    }
  });
});
