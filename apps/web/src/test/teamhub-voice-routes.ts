import type {
  TeamHubVoiceCapture,
  TeamHubVoiceCaptureQuestion,
  TeamHubVoiceSession,
} from "@/features/teamhub/teamhub-types";

import type { TeamHubApiPath } from "@/features/teamhub/teamhub-api";
import {
  teamHubErrorResponse,
  type TestRouteHandler,
  type TestRouteMethod,
} from "./teamhub-test-server";
import type { TestTeamHubRuntime } from "./teamhub-test-runtime";

const liveCaptureStatuses = ["starting", "recording", "finalizing"];

interface AcceptedVoiceRoutes {
  on(
    method: TestRouteMethod,
    path: TeamHubApiPath,
    handler: TestRouteHandler,
  ): AcceptedVoiceRoutes;
}

/**
 * Accepts the Voice Session and Capture lifecycle in memory: a session opens
 * connected, a Capture records until stopped, and stopping finalizes it.
 * Returns the accepted handler of one route.
 */
export function acceptVoice(runtime: TestTeamHubRuntime) {
  const { seed, server } = runtime;
  const sessions = new Map<string, TeamHubVoiceSession>();
  const captures = new Map<string, TeamHubVoiceCapture>();
  const questions = new Map<string, TeamHubVoiceCaptureQuestion[]>();
  let next = 0;
  const human = () => seed.identity.actors[0]!;
  const session = (id: string) => sessions.get(id);
  const capture = (id: string) => captures.get(id);
  const missing = (what: string) =>
    teamHubErrorResponse(404, "NOT_FOUND", `${what} was not found.`);
  // Keeps each accepted handler so a test can wrap one with a later route.
  const accepted = new Map<string, TestRouteHandler>();
  const routes: AcceptedVoiceRoutes = {
    on(method, path, handler) {
      accepted.set(`${method} ${path}`, handler);
      server.on(method, path, handler);
      return routes;
    },
  };

  routes
    .on("POST", "/v0/rooms/{roomId}/voice-sessions", ({ body, params }) => {
      const now = new Date().toISOString();
      const created: TeamHubVoiceSession = {
        created_at: now,
        created_by_actor_id: human().id,
        credential_generation: 0,
        id: `voice-session-${++next}`,
        input_ready_generation: 0,
        purpose: (body as { purpose: TeamHubVoiceSession["purpose"] }).purpose,
        room_id: params.roomId!,
        status: "connected",
        tenant_id: human().tenant_id,
        updated_at: now,
      };
      sessions.set(created.id, created);
      return Response.json(created, { status: 201 });
    })
    .on("GET", "/v0/rooms/{roomId}/voice-sessions", ({ params }) => {
      // Like TeamHub, the recording window never resumes a dictation session.
      const active = [...sessions.values()].find(
        (candidate) =>
          candidate.room_id === params.roomId &&
          candidate.purpose === "hardware_control" &&
          candidate.status !== "closed",
      );
      return active ?? missing("VoiceSession");
    })
    .on(
      "GET",
      "/v0/voice-sessions/{voiceSessionId}",
      ({ params }) =>
        session(params.voiceSessionId!) ?? missing("VoiceSession"),
    )
    .on(
      "POST",
      "/v0/voice-sessions/{voiceSessionId}/connection-credentials",
      ({ params }) => {
        const current = session(params.voiceSessionId!);
        if (!current) return missing("VoiceSession");
        const generation = current.credential_generation + 1;
        sessions.set(current.id, {
          ...current,
          credential_generation: generation,
          input_ready_generation: generation,
          input_started_offset_ms: generation,
          updated_at: new Date().toISOString(),
        });
        return {
          credential: `test-${current.id}-${generation}`,
          endpoint: "ws://voice.test.invalid",
          expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
          generation,
        };
      },
    )
    .on("DELETE", "/v0/voice-sessions/{voiceSessionId}", ({ params }) => {
      const current = session(params.voiceSessionId!);
      if (!current) return missing("VoiceSession");
      const now = new Date().toISOString();
      const closed: TeamHubVoiceSession = {
        ...current,
        closed_at: now,
        status: "closed",
        updated_at: now,
      };
      sessions.set(closed.id, closed);
      return closed;
    })
    .on(
      "POST",
      "/v0/voice-sessions/{voiceSessionId}/dictation-commit",
      ({ body }) => ({
        request_id: (body as { request_id: string }).request_id,
        status: "accepted",
      }),
    )
    .on("GET", "/v0/voice-sessions/{voiceSessionId}/events", ({ params }) => ({
      has_more: false,
      items: [],
      next_cursor: `${params.voiceSessionId}:0`,
    }))
    .on("GET", "/v0/voice-sessions/{voiceSessionId}/transcript-events", () => ({
      items: [],
    }))
    .on(
      "POST",
      "/v0/voice-sessions/{voiceSessionId}/captures",
      ({ body, params }) => {
        const current = session(params.voiceSessionId!);
        if (!current) return missing("VoiceSession");
        const existing = [...captures.values()].find(
          (candidate) =>
            candidate.voice_session_id === current.id &&
            liveCaptureStatuses.includes(candidate.status),
        );
        if (existing) return existing;
        const now = new Date().toISOString();
        const started: TeamHubVoiceCapture = {
          archived_through_ms: (body as { start_offset_ms: number })
            .start_offset_ms,
          created_at: now,
          gap_count: 0,
          gap_duration_ms: 0,
          id: `voice-capture-${++next}`,
          requested_start_offset_ms: Math.max(
            0,
            Date.parse(now) - Date.parse(current.created_at),
          ),
          room_id: current.room_id,
          status: "recording",
          updated_at: now,
          voice_session_id: current.id,
        };
        captures.set(started.id, started);
        return Response.json(started, { status: 201 });
      },
    )
    .on(
      "GET",
      "/v0/voice-captures/{captureSessionId}",
      ({ params }) =>
        capture(params.captureSessionId!) ?? missing("Voice Capture"),
    )
    .on("GET", "/v0/rooms/{roomId}/active-voice-capture", ({ params }) => {
      const active = [...captures.values()]
        .filter(
          (candidate) =>
            candidate.room_id === params.roomId &&
            (liveCaptureStatuses.includes(candidate.status) ||
              candidate.status === "recovering"),
        )
        .sort(
          (left, right) =>
            Number(liveCaptureStatuses.includes(right.status)) -
              Number(liveCaptureStatuses.includes(left.status)) ||
            Date.parse(right.created_at) - Date.parse(left.created_at),
        )[0];
      return Response.json(active ?? null);
    })
    .on("POST", "/v0/voice-captures/{captureSessionId}/stop", ({ params }) => {
      const current = capture(params.captureSessionId!);
      if (!current) return missing("Voice Capture");
      const owner = session(current.voice_session_id);
      const now = new Date().toISOString();
      const finalizing: TeamHubVoiceCapture = {
        ...current,
        // TeamHub stops at the media server's archived position, not a
        // client-supplied offset; the test uses the session clock.
        archived_through_ms: Math.max(
          1,
          Date.parse(now) - Date.parse(owner?.created_at ?? now),
        ),
        status: "finalizing",
        updated_at: now,
      };
      captures.set(current.id, { ...finalizing, status: "finalized" });
      return finalizing;
    })
    .on(
      "POST",
      "/v0/voice-captures/{captureSessionId}/transcript-recovery/retry",
      ({ params }) => {
        const current = capture(params.captureSessionId!);
        if (!current) return missing("Voice Capture");
        const retried = {
          ...current,
          transcript_recovery_status: "pending" as const,
        };
        captures.set(current.id, retried);
        return retried;
      },
    )
    .on(
      "GET",
      "/v0/voice-captures/{captureSessionId}/questions",
      ({ params }) =>
        capture(params.captureSessionId!)
          ? { items: questions.get(params.captureSessionId!) ?? [] }
          : missing("Voice Capture"),
    )
    .on(
      "POST",
      "/v0/voice-captures/{captureSessionId}/questions",
      ({ body, params }) => {
        if (!capture(params.captureSessionId!)) return missing("Voice Capture");
        const question = (body as { question: string }).question;
        const asked: TeamHubVoiceCaptureQuestion = {
          answer: "The recording so far does not settle this yet.",
          answered: false,
          created_at: new Date().toISOString(),
          cutoff_offset_ms: 0,
          id: `voice-question-${++next}`,
          kind: "answer",
          question,
          sources: [],
        };
        questions.set(params.captureSessionId!, [
          ...(questions.get(params.captureSessionId!) ?? []),
          asked,
        ]);
        return asked;
      },
    );
  return (method: TestRouteMethod, path: TeamHubApiPath) => {
    const handler = accepted.get(`${method} ${path}`);
    if (!handler) throw new Error(`acceptVoice has no ${method} ${path} route`);
    return handler;
  };
}
