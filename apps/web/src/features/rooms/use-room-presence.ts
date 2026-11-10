import { useEffect } from "react";

import { teamHubDone } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";

/** TeamHub drops repeats inside the same window. */
const PRESENCE_RESEND_MS = 15_000;
/** Shorter than the 30-second unused preparation window, so it never lapses. */
export const PRESENCE_HEARTBEAT_MS = 20_000;
/** A visible Room with no input for this long stops sending presence hints. */
export const PRESENCE_ACTIVITY_WINDOW_MS = 5 * 60_000;
/** The first hint waits this long so quick pass-through visits send nothing. */
export const PRESENCE_FIRST_HINT_DWELL_MS = 1_200;

const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "focusin"] as const;

const isEditable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLInputElement);

/**
 * Tells TeamHub that a person is in the Room, so the Room's Agents start
 * pre-activation on their Local Computers before the message is sent. The
 * first hint goes out once the Room has been visible for about 1.2 seconds, or
 * immediately when typing starts. Later hints repeat every 20 seconds while the
 * page is visible and the person was active in the last five minutes. The
 * heartbeat also prepares again after a Run or an Agent Service restart. The
 * hint is best effort and never blocks the Room.
 */
export function useRoomPresence(
  client: Pick<TeamHubClient, "api">,
  roomId: string,
) {
  useEffect(() => {
    let sentAt = Number.NEGATIVE_INFINITY;
    let activeAt = Date.now();
    let dwellTimer: number | undefined;
    const notify = () => {
      sentAt = Date.now();
      teamHubDone(
        client.api.POST("/v0/rooms/{roomId}/presence", {
          params: { path: { roomId } },
        }),
      ).catch(() => {
        // A lost hint only means the next message starts the Runtime itself.
      });
    };
    const onActivity = (event: Event) => {
      activeAt = Date.now();
      if (event.type !== "focusin" || !isEditable(event.target)) return;
      window.clearTimeout(dwellTimer);
      dwellTimer = undefined;
      if (Date.now() - sentAt < PRESENCE_RESEND_MS) return;
      notify();
    };
    const heartbeat = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - activeAt > PRESENCE_ACTIVITY_WINDOW_MS) return;
      notify();
    }, PRESENCE_HEARTBEAT_MS);
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      activeAt = Date.now();
      // The pending dwell timer owns the first hint.
      if (dwellTimer !== undefined) return;
      if (Date.now() - sentAt >= PRESENCE_RESEND_MS) notify();
    };
    dwellTimer = window.setTimeout(() => {
      dwellTimer = undefined;
      if (document.visibilityState === "visible") notify();
    }, PRESENCE_FIRST_HINT_DWELL_MS);
    for (const type of ACTIVITY_EVENTS)
      document.addEventListener(type, onActivity, { passive: true });
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(dwellTimer);
      window.clearInterval(heartbeat);
      for (const type of ACTIVITY_EVENTS)
        document.removeEventListener(type, onActivity);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [client, roomId]);
}
