const voicePollRetryDelaysMs = [500, 1_000, 2_000, 5_000] as const;

export function voicePollRetryDelay(consecutiveFailures: number) {
  const index = Math.min(
    Math.max(0, consecutiveFailures - 1),
    voicePollRetryDelaysMs.length - 1,
  );
  return voicePollRetryDelaysMs[index] ?? voicePollRetryDelaysMs[0];
}
