import type { QueryClient } from "@tanstack/react-query";
import { TeamHubError } from "@/features/teamhub/teamhub-error";

import { safeAuthenticationReturnTo } from "@/features/auth/authentication-return-to";
import { clearLocalAuthenticatedState } from "@/features/auth/local-authenticated-state";
import {
  teamHubAuthenticationSignals,
  type TeamHubAuthenticationReason,
  type TeamHubAuthenticationSignals,
} from "@/features/teamhub/teamhub-authentication";

export function startTeamHubAuthenticationRuntime({
  currentLocation,
  navigate,
  probeSession,
  queryClient,
  signals = teamHubAuthenticationSignals,
}: {
  currentLocation?: () => { pathname: string; search: string };
  navigate: (to: string, options: { replace: boolean }) => Promise<void> | void;
  probeSession?: () => Promise<void>;
  queryClient: QueryClient;
  signals?: TeamHubAuthenticationSignals;
}) {
  let probe: Promise<void> | null = null;
  let generation = 0;

  const invalidate = (reason: TeamHubAuthenticationReason) => {
    clearLocalAuthenticatedState(queryClient);
    const location = currentLocation?.();
    const returnTo = location
      ? safeAuthenticationReturnTo(
          location.pathname === "/login"
            ? new URLSearchParams(location.search).get("return_to")
            : `${location.pathname}${location.search}`,
        )
      : null;
    const params = new URLSearchParams({ reason });
    if (returnTo) params.set("return_to", returnTo);
    void navigate(`/login?${params.toString()}`, { replace: true });
  };

  const unsubscribe = signals.subscribe((kind) => {
    if (kind === "authenticated") {
      generation += 1;
      clearLocalAuthenticatedState(queryClient);
      void navigate("/", { replace: true });
      return;
    }

    if (!probeSession) {
      invalidate("session-expired");
      return;
    }
    if (probe) {
      return;
    }

    const probeGeneration = generation;
    probe = (async () => {
      try {
        await probeSession();
      } catch (error) {
        if (
          probeGeneration === generation &&
          error instanceof TeamHubError &&
          error.status === 401
        ) {
          invalidate("session-expired");
        }
      } finally {
        probe = null;
      }
    })();
  });

  return () => {
    generation += 1;
    unsubscribe();
  };
}
