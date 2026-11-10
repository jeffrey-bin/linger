// One-shot, in-memory intent: never persisted, so reloads keep heading focus.
let requestedAnchorMessageId: string | null = null;
const listeners = new Set<() => void>();

// Every Thread open replaces the request, so a stale one never outlives it.
export function requestThreadComposerFocus(anchorMessageId: string | null) {
  requestedAnchorMessageId = anchorMessageId;
  for (const listener of listeners) listener();
}

export function subscribeThreadComposerFocus(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function threadComposerFocusRequest() {
  return requestedAnchorMessageId;
}
