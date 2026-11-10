import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useContext,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { Button } from "@/components/ui/button";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import {
  TeamHubError,
  TeamHubTransportError,
} from "@/features/teamhub/teamhub-error";
import type { TeamHubVoiceMediaPolicy } from "@/features/teamhub/teamhub-types";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import { voicePollRetryDelay } from "./voice-poll-retry";
import {
  VoiceRequestScope,
  waitForVoiceDelay,
} from "@/features/teamhub/voice-request-scope";

import { VoiceControlContext } from "./voice-control-context";

import type { VoiceContexts } from "./voice-backend-provider";

const LiveKitProvider = lazy(async () => ({
  default: (await import("./voice-control-provider"))
    .LiveKitVoiceControlProvider,
}));

// The engines own their existing subscription/recording lifecycles. Only their
// context values cross into the stable workspace subtree, never their loading boundary.
function VoiceContextBridge({
  onChange,
}: {
  onChange: Dispatch<SetStateAction<VoiceContexts>>;
}) {
  const livekit = useContext(VoiceControlContext);
  useLayoutEffect(() => {
    onChange((current) => ({ ...current, livekit }));
  }, [livekit, onChange]);
  return null;
}

export function VoiceBackendController({
  tenantId,
  onChange,
}: {
  tenantId: string;
  onChange: Dispatch<SetStateAction<VoiceContexts>>;
}) {
  const { client } = useTeamHubRuntime();
  const [backend, setBackend] = useState<TeamHubVoiceMediaPolicy>();
  const [error, setError] = useState<"recovering" | "failed">();
  const retryRef = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    let pending = false;
    let failures = 0;
    const controller = new AbortController();
    const requests = new VoiceRequestScope();
    setBackend(undefined);
    onChange({ livekit: null });
    setError(undefined);
    const attempt = async () => {
      if (controller.signal.aborted || pending) return;
      pending = true;
      try {
        while (!controller.signal.aborted) {
          try {
            const backend = await readVoiceBackend(
              client,
              tenantId,
              requests,
              controller.signal,
            );
            if (!controller.signal.aborted) {
              setBackend(backend);
              setError(undefined);
              onChange((current) => ({ ...current, policy: backend }));
            }
            return;
          } catch (cause) {
            if (controller.signal.aborted) return;
            const retryable =
              cause instanceof TeamHubTransportError ||
              (cause instanceof TeamHubError &&
                (cause.status === 429 || cause.status >= 500));
            setError(retryable ? "recovering" : "failed");
            if (!retryable) return;
            await waitForVoiceDelay(
              voicePollRetryDelay(++failures),
              controller.signal,
            );
          }
        }
      } finally {
        pending = false;
      }
    };
    const retry = () => {
      if (controller.signal.aborted || pending) return;
      failures = 0;
      setError("recovering");
      void attempt();
    };
    retryRef.current = retry;
    void attempt();
    return () => {
      controller.abort();
      if (retryRef.current === retry) retryRef.current = undefined;
    };
  }, [client, tenantId, onChange]);
  return (
    <>
      <Suspense fallback={null}>
        {backend?.voice_media_supported ? (
          <LiveKitProvider
            tenantId={tenantId}
            activeRoomId={backend.active_room_id}
          >
            <VoiceContextBridge onChange={onChange} />
          </LiveKitProvider>
        ) : null}
      </Suspense>
      {error === "recovering" ? (
        <div role="status">Reconnecting voice…</div>
      ) : error === "failed" ? (
        <div role="alert" className="flex items-center gap-3">
          Voice connection is temporarily unavailable.
          <Button onClick={() => retryRef.current?.()}>
            Retry voice connection
          </Button>
        </div>
      ) : null}
    </>
  );
}

async function readVoiceBackend(
  client: TeamHubClient,
  tenantId: string,
  requests: VoiceRequestScope,
  signal: AbortSignal,
) {
  const policy = await requests.run(
    (requestSignal) =>
      teamHubData(
        client.api.GET("/v0/tenants/{tenantId}/voice-media-policy", {
          params: { path: { tenantId } },
          signal: requestSignal,
        }),
      ),
    signal,
  );
  signal.throwIfAborted();
  return policy;
}
