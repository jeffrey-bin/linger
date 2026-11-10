// @vitest-environment jsdom
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { teamHubSessionQueryKey } from "@/features/rooms/room-queries";
import { createTeamHubTestSeed } from "@/test/teamhub-seed";
import { TeamHubError } from "@/features/teamhub/teamhub-error";
import { startTeamHubSessionActivity } from "./teamhub-session-activity";

afterEach(() => {
  vi.restoreAllMocks();
});

async function setup() {
  const identity = createTeamHubTestSeed().identity;
  const session = {
    id: "session-response",
    account_id: identity.account.id,
    identity,
    created_at: "2026-10-15T00:00:00Z",
    expires_at: "2026-10-16T00:00:00Z",
  };
  const queryClient = new QueryClient();
  const renewSession = vi.fn().mockResolvedValue(session);
  let now = 0;
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const stop = startTeamHubSessionActivity({
    queryClient,
    renewSession,
    now: () => now,
  });
  return {
    queryClient,
    session,
    renewSession,
    stop,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("foreground Session renewal", () => {
  it("renews on authenticated startup and throttles activity without extending an unattended tab", async () => {
    const env = await setup();
    expect(env.renewSession).not.toHaveBeenCalled();
    env.queryClient.setQueryData(teamHubSessionQueryKey, env.session);
    await settle();
    expect(env.renewSession).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event("keydown"));
    expect(env.renewSession).toHaveBeenCalledTimes(1);
    env.advance(25 * 60 * 60_000);
    // Ordinary query updates/stream wakes cannot manufacture foreground activity.
    env.queryClient.setQueryData(teamHubSessionQueryKey, { ...env.session });
    expect(env.renewSession).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event("wheel"));
    await settle();
    expect(env.renewSession).toHaveBeenCalledTimes(2);
    env.stop();
    env.advance(5 * 60_000);
    document.dispatchEvent(new Event("pointerdown"));
    window.dispatchEvent(new Event("focus"));
    expect(env.renewSession).toHaveBeenCalledTimes(2);
  });

  it("waits for a visible page and coalesces in-flight requests", async () => {
    const env = await setup();
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    env.queryClient.setQueryData(teamHubSessionQueryKey, env.session);
    expect(env.renewSession).not.toHaveBeenCalled();
    let resolve: ((value: typeof env.session) => void) | undefined;
    env.renewSession.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    env.advance(6 * 60_000);
    window.dispatchEvent(new Event("focus"));
    expect(env.renewSession).toHaveBeenCalledTimes(1);
    resolve?.(env.session);
    await settle();
    env.stop();
  });

  it("does not restore cached authentication after logout races a renewal", async () => {
    const env = await setup();
    let resolve: ((value: typeof env.session) => void) | undefined;
    env.renewSession.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    env.queryClient.setQueryData(teamHubSessionQueryKey, env.session);
    env.queryClient.removeQueries({ queryKey: teamHubSessionQueryKey });
    resolve?.(env.session);
    await settle();
    expect(
      env.queryClient.getQueryData(teamHubSessionQueryKey),
    ).toBeUndefined();
    env.advance(6 * 60_000);
    document.dispatchEvent(new Event("keydown"));
    expect(env.renewSession).toHaveBeenCalledTimes(1);
    env.stop();
  });

  it("keeps state on network/5xx failure and retries on later activity", async () => {
    const env = await setup();
    env.renewSession
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockRejectedValueOnce(
        new TeamHubError({
          code: "INTERNAL_ERROR",
          status: 503,
          message: "unavailable",
        }),
      );
    env.queryClient.setQueryData(teamHubSessionQueryKey, env.session);
    await settle();
    expect(env.queryClient.getQueryData(teamHubSessionQueryKey)).toEqual(
      env.session,
    );
    env.advance(30_000);
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(env.queryClient.getQueryData(teamHubSessionQueryKey)).toEqual(
      env.session,
    );
    env.advance(30_000);
    document.dispatchEvent(new Event("pointerdown"));
    await settle();
    expect(env.renewSession).toHaveBeenCalledTimes(3);
    env.stop();
  });
});
