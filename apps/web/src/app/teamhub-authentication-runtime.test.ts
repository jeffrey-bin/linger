import { QueryClient } from "@tanstack/react-query";
import { TeamHubError } from "@/features/teamhub/teamhub-error";
import { describe, expect, it, vi } from "vitest";

import { createTeamHubAuthenticationSignals } from "@/features/teamhub/teamhub-authentication";

import { startTeamHubAuthenticationRuntime } from "./teamhub-authentication-runtime";

describe("TeamHub authentication runtime", () => {
  it("clears only TeamHub state before returning to login", () => {
    const queryClient = new QueryClient();
    const navigate = vi.fn();
    const signals = createTeamHubAuthenticationSignals({
      channelFactory: () => null,
    });
    const stop = startTeamHubAuthenticationRuntime({
      navigate,
      queryClient,
      signals,
    });

    queryClient.setQueryData(["teamhub", "session"], { id: "session-1" });
    queryClient.setQueryData(["public"], { remains: true });

    signals.publish("authentication-required");

    expect(queryClient.getQueryData(["teamhub", "session"])).toBeUndefined();
    expect(queryClient.getQueryData(["public"])).toEqual({ remains: true });
    expect(navigate).toHaveBeenCalledWith("/login?reason=session-expired", {
      replace: true,
    });
    stop();
  });

  it("invalidates state after the current Session probe confirms expiry", async () => {
    const queryClient = new QueryClient();
    const navigate = vi.fn();
    const signals = createTeamHubAuthenticationSignals({
      channelFactory: () => null,
    });
    const stop = startTeamHubAuthenticationRuntime({
      navigate,
      probeSession: vi.fn().mockRejectedValue(
        new TeamHubError({
          code: "UNAUTHENTICATED",
          message: "expired",
          status: 401,
        }),
      ),
      queryClient,
      signals,
    });
    queryClient.setQueryData(["teamhub", "session"], { id: "expired" });

    signals.publish("authentication-required", "session-expired");

    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/login?reason=session-expired", {
        replace: true,
      }),
    );
    expect(queryClient.getQueryData(["teamhub", "session"])).toBeUndefined();
    stop();
  });

  it("preserves a pending Local Computer setup when an expired Session probe wins the route race", async () => {
    const queryClient = new QueryClient();
    const navigate = vi.fn();
    const signals = createTeamHubAuthenticationSignals({
      channelFactory: () => null,
    });
    const setupPath =
      "/connect-computer?redirect_uri=http%3A%2F%2F127.0.0.1%3A64747%2Fcallback&state=setup-state&code_challenge=setup-challenge";
    const stop = startTeamHubAuthenticationRuntime({
      currentLocation: () => ({
        pathname: "/login",
        search: `?return_to=${encodeURIComponent(setupPath)}`,
      }),
      navigate,
      probeSession: vi.fn().mockRejectedValue(
        new TeamHubError({
          code: "UNAUTHENTICATED",
          message: "expired",
          status: 401,
        }),
      ),
      queryClient,
      signals,
    });

    signals.publish("authentication-required");

    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        `/login?reason=session-expired&return_to=${encodeURIComponent(setupPath)}`,
        { replace: true },
      ),
    );
    stop();
  });

  it("does not preserve an untrusted login return target", () => {
    const navigate = vi.fn();
    const signals = createTeamHubAuthenticationSignals({
      channelFactory: () => null,
    });
    const stop = startTeamHubAuthenticationRuntime({
      currentLocation: () => ({
        pathname: "/login",
        search:
          "?return_to=https%3A%2F%2Fevil.example%2Fconnect-computer%3Fstate%3Dstolen",
      }),
      navigate,
      queryClient: new QueryClient(),
      signals,
    });

    signals.publish("authentication-required");

    expect(navigate).toHaveBeenCalledWith("/login?reason=session-expired", {
      replace: true,
    });
    stop();
  });

  it("ignores a stale invalidation when the current Cookie Session is valid", async () => {
    const queryClient = new QueryClient();
    const navigate = vi.fn();
    const signals = createTeamHubAuthenticationSignals({
      channelFactory: () => null,
    });
    const probeSession = vi.fn().mockResolvedValue(undefined);
    const stop = startTeamHubAuthenticationRuntime({
      navigate,
      probeSession,
      queryClient,
      signals,
    });
    queryClient.setQueryData(["teamhub", "session"], { id: "current" });

    signals.publish("authentication-required", "session-expired");

    await vi.waitFor(() => expect(probeSession).toHaveBeenCalledOnce());
    expect(queryClient.getQueryData(["teamhub", "session"])).toEqual({
      id: "current",
    });
    expect(navigate).not.toHaveBeenCalled();
    stop();
  });

  it.each([
    new TypeError("offline"),
    new TeamHubError({
      status: 503,
      code: "INTERNAL_ERROR",
      message: "unavailable",
    }),
  ])(
    "does not clear authenticated state on a transient probe failure: %s",
    async (error) => {
      const queryClient = new QueryClient();
      const navigate = vi.fn();
      const signals = createTeamHubAuthenticationSignals({
        channelFactory: () => null,
      });
      const probeSession = vi.fn().mockRejectedValue(error);
      const stop = startTeamHubAuthenticationRuntime({
        navigate,
        queryClient,
        signals,
        probeSession,
      });
      queryClient.setQueryData(["teamhub", "session"], { id: "current" });
      signals.publish("authentication-required");
      await vi.waitFor(() => expect(probeSession).toHaveBeenCalledOnce());
      expect(navigate).not.toHaveBeenCalled();
      expect(queryClient.getQueryData(["teamhub", "session"])).toEqual({
        id: "current",
      });
      stop();
    },
  );

  it("coalesces concurrent invalidation probes", async () => {
    let resolveProbe: (() => void) | undefined;
    const probeSession = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveProbe = resolve;
        }),
    );
    const signals = createTeamHubAuthenticationSignals({
      channelFactory: () => null,
    });
    const stop = startTeamHubAuthenticationRuntime({
      navigate: vi.fn(),
      probeSession,
      queryClient: new QueryClient(),
      signals,
    });

    signals.publish("authentication-required", "session-expired");
    signals.publish("authentication-required", "session-expired");

    expect(probeSession).toHaveBeenCalledOnce();
    resolveProbe?.();
    stop();
  });

  it("clears stale TeamHub state and re-resolves the app after another tab signs in", () => {
    const queryClient = new QueryClient();
    const navigate = vi.fn();
    const signals = createTeamHubAuthenticationSignals({
      channelFactory: () => null,
    });
    const stop = startTeamHubAuthenticationRuntime({
      navigate,
      queryClient,
      signals,
    });
    queryClient.setQueryData(["teamhub", "session"], { id: "stale" });

    signals.publish("authenticated");

    expect(queryClient.getQueryData(["teamhub", "session"])).toBeUndefined();
    expect(navigate).toHaveBeenCalledWith("/", { replace: true });
    stop();
  });
});
