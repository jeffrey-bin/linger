import { describe, expect, it } from "vitest";

import { voicePollRetryDelay } from "./voice-poll-retry";

describe("voicePollRetryDelay", () => {
  it.each([
    [0, 500],
    [1, 500],
    [2, 1_000],
    [3, 2_000],
    [4, 5_000],
    [100, 5_000],
  ])("bounds failure %i at %ims", (failureCount, expectedDelay) => {
    expect(voicePollRetryDelay(failureCount)).toBe(expectedDelay);
  });
});
