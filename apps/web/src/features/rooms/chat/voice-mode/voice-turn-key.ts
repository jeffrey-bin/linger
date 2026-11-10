/** One key per turn, so a retried send never creates a second Message. */
export function voiceTurnIdempotencyKey(eventId: string) {
  return `voice-mode:${eventId}`;
}
