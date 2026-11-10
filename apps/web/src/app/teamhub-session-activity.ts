import type { QueryClient } from "@tanstack/react-query";

import { teamHubSessionQueryKey } from "@/features/rooms/room-queries";
import { reportTeamHubAuthenticationRequired } from "@/features/teamhub/teamhub-authentication";
import { TeamHubError } from "@/features/teamhub/teamhub-error";
import type { TeamHubSession } from "@/features/teamhub/teamhub-types";

// No heartbeat timer: an unattended tab must not keep a Session alive.
export function startTeamHubSessionActivity({
  queryClient,
  renewSession,
  document: page = document,
  window: browser = window,
  now = Date.now,
}: {
  queryClient: QueryClient;
  renewSession: () => Promise<TeamHubSession>;
  document?: Document;
  window?: Window;
  now?: () => number;
}) {
  let sessionId: string | undefined;
  let nextAttempt = 0;
  let pending = false;
  let stopped = false;
  let generation = 0;

  const activity = () => {
    if (
      stopped ||
      !sessionId ||
      page.visibilityState !== "visible" ||
      pending ||
      now() < nextAttempt
    )
      return;
    pending = true;
    nextAttempt = now() + 5 * 60_000;
    const attemptGeneration = generation;
    const attemptSessionId = sessionId;
    void renewSession()
      .then((session) => {
        if (
          stopped ||
          generation !== attemptGeneration ||
          session.id !== attemptSessionId
        )
          return;
        queryClient.setQueryData(teamHubSessionQueryKey, session);
      })
      .catch((error: unknown) => {
        if (stopped || generation !== attemptGeneration) return;
        nextAttempt = now() + 30_000;
        if (error instanceof TeamHubError && error.status === 401) {
          reportTeamHubAuthenticationRequired();
        }
        // Offline/5xx is not proof of logout. The next user activity can retry.
      })
      .finally(() => {
        pending = false;
      });
  };

  const syncSession = () => {
    const current = queryClient.getQueryData<TeamHubSession>(
      teamHubSessionQueryKey,
    )?.id;
    if (current === sessionId) return;
    sessionId = current;
    generation += 1;
    nextAttempt = 0;
    activity();
  };
  const unsubscribe = queryClient.getQueryCache().subscribe(syncSession);
  for (const event of [
    "pointerdown",
    "keydown",
    "wheel",
    "visibilitychange",
  ] as const) {
    page.addEventListener(event, activity, { passive: true });
  }
  browser.addEventListener("focus", activity);
  syncSession();

  return () => {
    stopped = true;
    unsubscribe();
    for (const event of [
      "pointerdown",
      "keydown",
      "wheel",
      "visibilitychange",
    ] as const) {
      page.removeEventListener(event, activity);
    }
    browser.removeEventListener("focus", activity);
  };
}
