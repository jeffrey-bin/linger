import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubVoiceCapture } from "@/features/teamhub/teamhub-types";
import { VoiceRequestScope } from "@/features/teamhub/voice-request-scope";

export function VoiceRecoveryPanel({
  capture,
}: {
  capture: TeamHubVoiceCapture;
}) {
  const { client } = useTeamHubRuntime();
  const [download, setDownload] = useState<string>();
  const [error, setError] = useState<{ captureId: string; message: string }>();
  const [pendingCaptureId, setPendingCaptureId] = useState<string>();
  const [requests] = useState(() => new VoiceRequestScope());
  const activeRetryRef = useRef<symbol | undefined>(undefined);
  useEffect(
    () => () => {
      activeRetryRef.current = undefined;
      requests.cancel();
    },
    [capture.id, requests],
  );
  const version = capture.source_audio_document_version_id;
  useEffect(() => {
    let active = true;
    let dispose: (() => void) | undefined;
    setDownload(undefined);
    if (version)
      void client
        .getDocumentVersionContentLocation(version)
        .then((location) => {
          if (!active) {
            location.dispose();
            return;
          }
          dispose = location.dispose;
          setDownload(location.url);
        })
        .catch(() => {
          if (active)
            setError({
              captureId: capture.id,
              message: "Original recording download is temporarily unavailable",
            });
        });
    return () => {
      active = false;
      dispose?.();
    };
  }, [capture.id, client, version]);
  const progress = Math.min(
    100,
    Math.floor(
      ((capture.transcript_recovery_progress_ms ?? 0) /
        Math.max(1, capture.transcript_recovery_total_ms ?? 1)) *
        100,
    ),
  );
  const failed = capture.transcript_recovery_status === "failed";
  const pending = pendingCaptureId === capture.id;
  return (
    <section
      aria-label="Recording transcript recovery"
      className="w-full rounded-lg border border-app-border bg-app-rail/40 p-4 text-[14px] leading-5 text-app-ink"
      role="status"
    >
      <p className="font-medium">Recording saved</p>
      <p className="mt-1 text-app-muted">
        {failed
          ? "Transcript recovery is paused. Please retry."
          : `Recovering transcript ${progress}%. It will appear in this Room when complete.`}
        You can start a new recording.
      </p>
      <div className="mt-2 flex items-center gap-3">
        {download ? (
          <a
            className="text-app-info underline"
            href={download}
            download="original-recording.m4a"
          >
            Download original recording
          </a>
        ) : null}
        {failed ? (
          <Button
            disabled={pending}
            size="compact"
            onClick={() => {
              if (activeRetryRef.current) return;
              const request = Symbol();
              activeRetryRef.current = request;
              setPendingCaptureId(capture.id);
              setError(undefined);
              void requests
                .run((signal) =>
                  teamHubData(
                    client.api.POST(
                      "/v0/voice-captures/{captureSessionId}/transcript-recovery/retry",
                      {
                        params: { path: { captureSessionId: capture.id } },
                        signal,
                      },
                    ),
                  ),
                )
                .catch(() => {
                  if (activeRetryRef.current === request)
                    setError({
                      captureId: capture.id,
                      message:
                        "The retry request was not confirmed. Check progress or try again later.",
                    });
                })
                .finally(() => {
                  if (activeRetryRef.current !== request) return;
                  activeRetryRef.current = undefined;
                  setPendingCaptureId(undefined);
                });
            }}
          >
            Retry transcription
          </Button>
        ) : null}
      </div>
      {error?.captureId === capture.id ? (
        <p role="alert" className="mt-2 text-app-danger">
          {error.message}
        </p>
      ) : null}
    </section>
  );
}
