import { useEffect, useState } from "react";

import { teamHubData } from "@/features/teamhub/teamhub-api";
import { useOptionalTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubVoiceMediaPolicy } from "@/features/teamhub/teamhub-types";

/**
 * The Voice media policy of `tenantId`, undefined until it answers for this
 * Space. `voice_media_supported` is Soniox transcription (meetings, dictation
 * and Voice Mode dictation); `live_supported` is xAI Live, which turns Voice
 * Mode into a live conversation on its own.
 */
export function useVoiceMediaPolicy(
  tenantId: string,
  enabled = true,
): TeamHubVoiceMediaPolicy | undefined {
  const runtime = useOptionalTeamHubRuntime();
  const [answer, setAnswer] = useState<{
    policy: TeamHubVoiceMediaPolicy;
    tenantId: string;
  }>();
  useEffect(() => {
    if (!runtime || !enabled) return;
    const abort = new AbortController();
    void teamHubData(
      runtime.client.api.GET("/v0/tenants/{tenantId}/voice-media-policy", {
        params: { path: { tenantId } },
        signal: abort.signal,
      }),
    ).then(
      (policy) => {
        if (!abort.signal.aborted) setAnswer({ policy, tenantId });
      },
      () => undefined,
    );
    return () => abort.abort();
  }, [enabled, runtime, tenantId]);
  return answer?.tenantId === tenantId ? answer.policy : undefined;
}
