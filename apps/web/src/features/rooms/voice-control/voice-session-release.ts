import { teamHubData } from "@/features/teamhub/teamhub-api";
import {
  TeamHubError,
  type TeamHubClient,
} from "@/features/teamhub/teamhub-client";
import type {
  TeamHubVoiceCapture,
  TeamHubVoiceSession,
} from "@/features/teamhub/teamhub-types";
import {
  VoiceRequestScope,
  waitForVoiceDelay,
} from "@/features/teamhub/voice-request-scope";
import { asError } from "@linger/service-kit";

export async function releaseVoiceSession(
  client: TeamHubClient,
  session: TeamHubVoiceSession,
  initialCapture: TeamHubVoiceCapture | undefined,
  onStopped?: (capture: TeamHubVoiceCapture) => void,
) {
  let capture = initialCapture;
  const requests = new VoiceRequestScope();
  const deadline = Date.now() + 60_000;
  let failure: unknown;
  for (const delay of [0, 250, 500, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000]) {
    if (Date.now() >= deadline) break;
    if (delay > 0) await waitForVoiceDelay(delay);
    try {
      if (
        capture?.voice_session_id === session.id &&
        (capture.status === "starting" || capture.status === "recording")
      ) {
        try {
          const captureId = capture.id;
          capture = await requests.run((signal) =>
            teamHubData(
              client.api.POST("/v0/voice-captures/{captureSessionId}/stop", {
                params: { path: { captureSessionId: captureId } },
                signal,
                keepalive: true,
              }),
            ),
          );
          onStopped?.(capture);
        } catch (error) {
          if (!(error instanceof TeamHubError) || error.status !== 404)
            throw error;
          capture = undefined;
        }
      }
      await requests.run((signal) =>
        teamHubData(
          client.api.DELETE("/v0/voice-sessions/{voiceSessionId}", {
            params: { path: { voiceSessionId: session.id } },
            signal,
            keepalive: true,
          }),
        ),
      );
      return;
    } catch (error) {
      if (error instanceof TeamHubError && error.status === 404) return;
      failure = error;
      if (
        error instanceof TeamHubError &&
        error.status < 500 &&
        error.status !== 409
      )
        throw error;
      try {
        const active = await requests.run((signal) =>
          teamHubData(
            client.api.GET("/v0/rooms/{roomId}/active-voice-capture", {
              params: { path: { roomId: session.room_id } },
              signal,
            }),
          ),
        );
        capture = active?.voice_session_id === session.id ? active : undefined;
      } catch {
        capture = undefined;
      }
    }
  }
  throw asError(failure ?? new Error("Voice session cleanup timed out"));
}
