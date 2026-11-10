import { useSyncExternalStore } from "react";

/**
 * Whether the Recording window is open and how. It sits above the routes, so
 * moving between Rooms, documents, or settings only changes what is behind
 * it. `autoStart` asks the window to start recording as soon as it opens.
 */
export interface RecordingWindowState {
  open: boolean;
  minimized: boolean;
  autoStart: boolean;
  /**
   * The floating window was closed to end the recording; nothing shows while
   * stopping, so the window does not reappear in the page first.
   */
  ending: boolean;
}

const closed: RecordingWindowState = {
  open: false,
  minimized: false,
  autoStart: false,
  ending: false,
};
let state = closed;
const listeners = new Set<() => void>();

function publish(next: RecordingWindowState) {
  state = next;
  for (const listener of listeners) listener();
}

export function openRecordingWindow({ autoStart = false } = {}) {
  publish({ open: true, minimized: false, autoStart, ending: false });
}

/** Collapses the window to its control bar; the recording keeps going. */
export function minimizeRecordingWindow() {
  publish({
    ...state,
    open: true,
    minimized: true,
    autoStart: false,
    ending: false,
  });
}

/** Opens the drawer under the control bar again. */
export function expandRecordingWindow() {
  publish({ ...state, open: true, minimized: false, ending: false });
}

/** Hides the window while the recording it was closed on is stopping. */
export function endRecordingWindow() {
  publish({ ...state, autoStart: false, ending: true });
}

/**
 * The window asked to start recording once; after that start, opening the
 * window again (or moving it between the page and its floating window) must
 * never start another recording on its own.
 */
export function consumeRecordingAutoStart() {
  if (state.autoStart) publish({ ...state, autoStart: false });
}

export function closeRecordingWindow() {
  publish(closed);
}

export function useRecordingWindow() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => closed,
  );
}

export function resetRecordingWindowForTest() {
  state = closed;
  listeners.clear();
}
