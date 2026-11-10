import { useSyncExternalStore } from "react";

/** What a spoken screen command just did; it fades after a few seconds. */
let voiceNotice: string | undefined;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  for (const listener of listeners) listener();
}

export function showVoiceNotice(text: string) {
  voiceNotice = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    voiceNotice = undefined;
    notify();
  }, 4_000);
  notify();
}

export function useVoiceNotice() {
  return useSyncExternalStore(
    subscribe,
    () => voiceNotice,
    () => undefined,
  );
}
