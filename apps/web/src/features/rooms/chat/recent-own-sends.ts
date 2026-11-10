/**
 * When this browser started showing each Message it just sent, by Message id.
 * The committed row continues the sending row's entrance from there instead
 * of jumping to its settled size.
 */
const startedAt = new Map<string, number>();

export function rememberOwnSend(messageId: string, sentAt: number) {
  startedAt.set(messageId, sentAt);
}

export function ownSendStartedAt(messageId: string): number | undefined {
  return startedAt.get(messageId);
}
