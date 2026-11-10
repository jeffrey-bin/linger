import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHttpTeamHubClient,
  TeamHubError,
} from "@/features/teamhub/teamhub-client";
import {
  teamHubErrorResponse,
  TeamHubTestServer,
  type TestRouteHandler,
} from "@/test/teamhub-test-server";
import type {
  TeamHubVoiceCapture,
  TeamHubVoiceSession,
} from "@/features/teamhub/teamhub-types";
import { releaseVoiceSession } from "./voice-session-release";

const session = { id: "voice-old", room_id: "room-old" } as TeamHubVoiceSession;
const recording = {
  id: "capture-old",
  voice_session_id: session.id,
  status: "recording",
} as TeamHubVoiceCapture;
const conflict = () =>
  teamHubErrorResponse(409, "VOICE_CAPTURE_CONFLICT", "Still finalizing");
const missing = () => teamHubErrorResponse(404, "NOT_FOUND", "Not found");

function clientFixture() {
  const stop = vi.fn<TestRouteHandler>(() => ({
    ...recording,
    status: "finalizing",
  }));
  const close = vi.fn<TestRouteHandler>(() => ({
    ...session,
    status: "closed",
  }));
  const active = vi.fn<TestRouteHandler>(() => recording);
  const server = new TeamHubTestServer()
    .on("POST", "/v0/voice-captures/{captureSessionId}/stop", stop)
    .on("DELETE", "/v0/voice-sessions/{voiceSessionId}", close)
    .on("GET", "/v0/rooms/{roomId}/active-voice-capture", active);
  const client = createHttpTeamHubClient({
    fetchRequest: server.fetch,
    onAuthenticationRequired: () => undefined,
  });
  return { active, client, close, server, stop };
}

afterEach(() => vi.useRealTimers());

describe("Voice page release", () => {
  it("sends the stop immediately with keepalive before closing the session", async () => {
    vi.useFakeTimers();
    const fixture = clientFixture();
    let finishStop = () => {};
    fixture.stop.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finishStop = resolve;
      });
      return { ...recording, status: "finalizing" };
    });
    const pending = releaseVoiceSession(fixture.client, session, recording);
    // No timer runs: the stop must not wait behind a retry delay.
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.stop).toHaveBeenCalledOnce();
    expect(fixture.close).not.toHaveBeenCalled();
    finishStop();
    await pending;
    expect(fixture.stop).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { captureSessionId: recording.id },
      }),
    );
    expect(fixture.close).toHaveBeenCalledWith(
      expect.objectContaining({ params: { voiceSessionId: session.id } }),
    );
    expect(
      fixture.server.requests.map((request) => [
        request.method,
        request.keepalive,
      ]),
    ).toEqual([
      ["POST", true],
      ["DELETE", true],
    ]);
  });

  it("finds and stops a capture whose Start response arrived after the page left", async () => {
    vi.useFakeTimers();
    const fixture = clientFixture();
    fixture.close.mockReturnValueOnce(conflict());
    const pending = releaseVoiceSession(fixture.client, session, undefined);
    await vi.advanceTimersByTimeAsync(250);
    await pending;
    expect(fixture.active).toHaveBeenCalledWith(
      expect.objectContaining({ params: { roomId: session.room_id } }),
    );
    expect(fixture.stop).toHaveBeenCalledOnce();
    expect(fixture.close).toHaveBeenCalledTimes(2);
  });

  it("never stops another session found in the same room", async () => {
    vi.useFakeTimers();
    const fixture = clientFixture();
    fixture.close.mockReturnValueOnce(conflict());
    fixture.active.mockReturnValue({
      ...recording,
      voice_session_id: "voice-new",
    });
    const pending = releaseVoiceSession(fixture.client, session, undefined);
    await vi.advanceTimersByTimeAsync(250);
    await pending;
    expect(fixture.stop).not.toHaveBeenCalled();
    expect(
      fixture.close.mock.calls.every(
        ([request]) => request.params.voiceSessionId === session.id,
      ),
    ).toBe(true);
  });

  it("closes the session even when the old capture is already gone", async () => {
    const fixture = clientFixture();
    fixture.stop.mockReturnValueOnce(missing());
    await releaseVoiceSession(fixture.client, session, recording);
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it("does not treat failed cleanup as an unbounded background retry", async () => {
    vi.useFakeTimers();
    const fixture = clientFixture();
    fixture.close.mockReturnValue(conflict());
    fixture.active.mockReturnValue({
      ...recording,
      status: "finalizing",
    });
    const pending = releaseVoiceSession(
      fixture.client,
      session,
      recording,
    ).catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await pending).toBeInstanceOf(TeamHubError);
    expect(fixture.close).toHaveBeenCalledTimes(9);
    expect(fixture.stop).toHaveBeenCalledOnce();
  });
});
