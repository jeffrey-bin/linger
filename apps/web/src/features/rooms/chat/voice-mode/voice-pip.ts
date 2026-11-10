import { useSyncExternalStore } from "react";

/** Chrome and Edge 116+ only; TypeScript's DOM library does not declare it yet. */
interface DocumentPictureInPicture {
  requestWindow(options?: { height?: number; width?: number }): Promise<Window>;
}

/** Voice Mode and Recording never run together; each asks for its own window. */
export type VoicePipOwner = "voice-mode" | "recording";

// About each page window's size when it opens; the Human drags it bigger and
// the browser remembers that size.
const pipSizes = {
  "voice-mode": { height: 240, width: 320 },
  recording: { height: 720, width: 420 },
} satisfies Record<VoicePipOwner, { height: number; width: number }>;

let pip: { owner: VoicePipOwner; window: Window } | undefined;
const listeners = new Set<() => void>();
const closedByHuman = new Set<(owner: VoicePipOwner) => void>();

function api(): DocumentPictureInPicture | undefined {
  return (
    window as Window & { documentPictureInPicture?: DocumentPictureInPicture }
  ).documentPictureInPicture;
}

function publish(next: typeof pip) {
  pip = next;
  for (const listener of listeners) listener();
}

/**
 * Opens the always-on-top window a voice window moves into, so it stays
 * visible over other tabs and apps and can be dragged anywhere on the desktop.
 * The browser allows this only inside a click, so call it synchronously from
 * the click handler. Resolves undefined when the browser refuses.
 */
export async function openVoicePip(
  owner: VoicePipOwner,
): Promise<Window | undefined> {
  const pictureInPicture = api();
  if (!pictureInPicture) return undefined;
  // The browser allows one such window per tab; the newest owner takes it.
  if (pip?.owner === owner) return pip.window;
  if (pip) closeVoicePip(pip.owner);
  try {
    const opened = await pictureInPicture.requestWindow(pipSizes[owner]);
    const stopMirroring = mirrorStyles(opened.document);
    opened.addEventListener("pagehide", () => {
      stopMirroring();
      if (pip?.window !== opened) return;
      // Closed from the window's own close button rather than from the page.
      publish(undefined);
      for (const listener of closedByHuman) listener(owner);
    });
    publish({ owner, window: opened });
    return opened;
  } catch {
    return undefined;
  }
}

export function closeVoicePip(owner: VoicePipOwner) {
  if (pip?.owner !== owner) return;
  const current = pip.window;
  publish(undefined);
  current.close();
}

/** Runs when the Human closes this owner's window with the desktop's button. */
export function onVoicePipClosedByHuman(
  owner: VoicePipOwner,
  listener: () => void,
) {
  const forOwner = (closed: VoicePipOwner) => {
    if (closed === owner) listener();
  };
  closedByHuman.add(forOwner);
  return () => {
    closedByHuman.delete(forOwner);
  };
}

/** This owner's picture-in-picture window, if its voice window lives there. */
export function useVoicePip(owner: VoicePipOwner) {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (pip?.owner === owner ? pip.window : undefined),
    () => undefined,
  );
}

/**
 * Copies the page's styles and theme into the new window, including styles a
 * lazily loaded chunk adds later, so the window looks the same in both places.
 */
function mirrorStyles(target: Document) {
  const root = document.documentElement;
  for (const { name, value } of Array.from(root.attributes))
    target.documentElement.setAttribute(name, value);
  const copy = (node: Node) => {
    if (
      node instanceof HTMLStyleElement ||
      (node instanceof HTMLLinkElement && node.rel === "stylesheet")
    )
      target.head.append(node.cloneNode(true));
  };
  document.head.childNodes.forEach(copy);
  target.body.style.margin = "0";
  const observer = new MutationObserver((records) => {
    for (const record of records) record.addedNodes.forEach(copy);
  });
  observer.observe(document.head, { childList: true });
  return () => observer.disconnect();
}

export function resetVoicePipForTest() {
  pip = undefined;
  listeners.clear();
  closedByHuman.clear();
}
