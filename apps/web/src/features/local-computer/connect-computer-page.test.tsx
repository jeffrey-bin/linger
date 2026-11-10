import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import {
  teamHubErrorResponse,
  type TestRouteHandler,
} from "@/test/teamhub-test-server";

import { browserRoomMessageOutbox } from "@/features/rooms/chat/room-message-outbox";

import { ConnectComputerPage } from "./connect-computer-page";

afterEach(() => vi.restoreAllMocks());

describe("ConnectComputerPage", () => {
  it("creates a Tenant-scoped enrollment and returns only the short-lived code to loopback", async () => {
    const runtime = createTestTeamHubRuntime();

    const createEnrollment = serveEnrollment(runtime, () => ({
      authorization_code: "c".repeat(43),
      computer_id: "computer-1",
      enrollment_id: "enrollment-1",
      expires_at: "2026-07-30T12:00:00Z",
    }));
    const navigateToCallback = vi.fn();

    renderPage(runtime, navigateToCallback, validConnectPath());

    expect(
      await screen.findByRole("heading", { name: "Connect Alice's Mac" }),
    ).toBeVisible();
    expect(await screen.findByText(/Signed in as/)).toHaveTextContent("jenny");
    const connectButton = screen.getByRole("button", {
      name: "Connect computer",
    });
    await waitFor(() => expect(connectButton).toBeEnabled());
    fireEvent.click(connectButton);

    await waitFor(() => expect(createEnrollment).toHaveBeenCalledOnce());
    expect(createEnrollment).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { tenantId: "tenant-northstar" },
        body: {
          code_challenge: "a".repeat(43),
          display_name: "Alice's Mac",
          redirect_uri: "http://127.0.0.1:45123/callback",
        },
      }),
    );
    await waitFor(() => expect(navigateToCallback).toHaveBeenCalledOnce());
    const callback = new URL(navigateToCallback.mock.calls[0]?.[0] as string);
    expect(callback.origin + callback.pathname).toBe(
      "http://127.0.0.1:45123/callback",
    );
    expect(Object.fromEntries(callback.searchParams)).toEqual({
      code: "c".repeat(43),
      enrollment_id: "enrollment-1",
      state: "s".repeat(43),
    });
    expect(callback.href).not.toContain("gateway");
  });

  it("fails closed before TeamHub when the callback is not exact loopback", async () => {
    const runtime = createTestTeamHubRuntime();

    const createEnrollment = serveEnrollment(runtime, () => undefined);

    renderPage(
      runtime,
      vi.fn(),
      validConnectPath("http://localhost:45123/callback"),
    );

    expect(
      await screen.findByRole("heading", {
        name: "Connection request is invalid",
      }),
    ).toBeVisible();
    expect(createEnrollment).not.toHaveBeenCalled();
  });

  it("forwards an existing Computer identity for owner-authorized renewal", async () => {
    const runtime = createTestTeamHubRuntime();

    const createEnrollment = serveEnrollment(runtime, () => ({
      authorization_code: "c".repeat(43),
      computer_id: "computer-existing",
      enrollment_id: "enrollment-renewal",
      expires_at: "2026-08-30T12:00:00Z",
    }));

    renderPage(
      runtime,
      vi.fn(),
      `${validConnectPath()}&computer_id=computer-existing`,
    );
    const button = await screen.findByRole("button", {
      name: "Reconnect computer",
    });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);

    await waitFor(() =>
      expect(createEnrollment).toHaveBeenCalledWith(
        expect.objectContaining({
          params: { tenantId: "tenant-northstar" },
          body: {
            code_challenge: "a".repeat(43),
            computer_id: "computer-existing",
            display_name: "Alice's Mac",
            redirect_uri: "http://127.0.0.1:45123/callback",
          },
        }),
      ),
    );
  });

  it.each([
    {
      code: "LOCAL_COMPUTER_REMOVED",
      message: "Local Computer was removed",
      status: 410,
    },
    {
      code: "INVALID_ENROLLMENT",
      message: "Local Computer enrollment is invalid or expired",
      status: 404,
    },
  ])(
    "returns a replacement result to the loopback CLI for $status $code",
    async ({ code, message, status }) => {
      const runtime = createTestTeamHubRuntime();

      serveEnrollment(runtime, () =>
        teamHubErrorResponse(status, code, message),
      );
      const navigateToCallback = vi.fn();

      renderPage(
        runtime,
        navigateToCallback,
        `${validConnectPath()}&computer_id=computer-existing`,
      );
      const button = await screen.findByRole("button", {
        name: "Reconnect computer",
      });
      await waitFor(() => expect(button).toBeEnabled());
      fireEvent.click(button);

      const replacementHeading = await screen.findByText(
        "Confirm Local Computer replacement",
      );
      expect(replacementHeading.closest('[role="alert"]')).toBeInTheDocument();
      expect(navigateToCallback).not.toHaveBeenCalled();

      fireEvent.click(
        screen.getByRole("button", { name: "Replace local identity" }),
      );

      expect(navigateToCallback).toHaveBeenCalledOnce();
      const callback = new URL(navigateToCallback.mock.calls[0]?.[0] as string);
      expect(callback.origin + callback.pathname).toBe(
        "http://127.0.0.1:45123/callback",
      );
      expect(Object.fromEntries(callback.searchParams)).toEqual({
        error: "local_computer_replacement_required",
        state: "s".repeat(43),
      });
    },
  );

  it("returns a cancellation result when the user keeps the current setup", async () => {
    const runtime = createTestTeamHubRuntime();

    serveEnrollment(runtime, () =>
      teamHubErrorResponse(
        404,
        "INVALID_ENROLLMENT",
        "Local Computer enrollment is invalid or expired",
      ),
    );
    const navigateToCallback = vi.fn();

    renderPage(
      runtime,
      navigateToCallback,
      `${validConnectPath()}&computer_id=computer-existing`,
    );
    const button = await screen.findByRole("button", {
      name: "Reconnect computer",
    });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    fireEvent.click(
      await screen.findByRole("button", { name: "Keep current setup" }),
    );

    expect(navigateToCallback).toHaveBeenCalledOnce();
    const callback = new URL(navigateToCallback.mock.calls[0]?.[0] as string);
    expect(callback.origin + callback.pathname).toBe(
      "http://127.0.0.1:45123/callback",
    );
    expect(Object.fromEntries(callback.searchParams)).toEqual({
      error: "local_computer_replacement_cancelled",
      state: "s".repeat(43),
    });
  });

  it("retains setup and blocks revocation if Account outbox cleanup fails", async () => {
    const runtime = createTestTeamHubRuntime();

    const logout = vi.fn(() => undefined);
    runtime.server.on("POST", "/v0/auth/logout", logout);
    vi.spyOn(browserRoomMessageOutbox, "clearAccount").mockRejectedValue(
      new Error("Storage unavailable"),
    );
    const route = validConnectPath();
    renderPage(runtime, vi.fn(), route, true);
    const switchButton = await screen.findByRole("button", {
      name: "Use another account",
    });
    await waitFor(() => expect(switchButton).toBeEnabled());
    fireEvent.click(switchButton);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not confirm logout. Please retry.",
    );
    expect(logout).not.toHaveBeenCalled();
    expect(screen.getByTestId("location")).toHaveTextContent(route);
    expect(switchButton).toBeEnabled();
  });

  it("signs out the current browser account and preserves the setup request", async () => {
    const runtime = createTestTeamHubRuntime();

    const identity = runtime.seed.identity;
    const logout = vi.fn(() => undefined);
    runtime.server.on("POST", "/v0/auth/logout", logout);
    const clearOutbox = vi
      .spyOn(browserRoomMessageOutbox, "clearAccount")
      .mockResolvedValue();
    const route = `${validConnectPath()}&computer_id=computer-existing`;

    renderPage(runtime, vi.fn(), route, true);
    const switchButton = await screen.findByRole("button", {
      name: "Use another account",
    });
    await waitFor(() => expect(switchButton).toBeEnabled());
    fireEvent.click(switchButton);

    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("/login"),
    );
    expect(logout).toHaveBeenCalledOnce();
    expect(clearOutbox).toHaveBeenCalledWith(identity.account.id);
    expect(clearOutbox.mock.invocationCallOrder[0]).toBeLessThan(
      logout.mock.invocationCallOrder[0]!,
    );
    const location = new URL(
      screen.getByTestId("location").textContent ?? "",
      "http://localhost",
    );
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("return_to")).toBe(route);
  });
});

const renderPage = (
  runtime: ReturnType<typeof createTestTeamHubRuntime>,
  navigateToCallback: (url: string) => void,
  route: string,
  showLocation = false,
) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <MemoryRouter initialEntries={[route]}>
          <ConnectComputerPage navigateToCallback={navigateToCallback} />
          {showLocation ? <LocationProbe /> : null}
        </MemoryRouter>
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
};

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname}
      {location.search}
    </output>
  );
}

const validConnectPath = (redirectUri = "http://127.0.0.1:45123/callback") => {
  const query = new URLSearchParams({
    code_challenge: "a".repeat(43),
    display_name: "Alice's Mac",
    redirect_uri: redirectUri,
    state: "s".repeat(43),
  });
  return `/connect-computer?${query.toString()}`;
};

function serveEnrollment(
  runtime: ReturnType<typeof createTestTeamHubRuntime>,
  handler: TestRouteHandler,
) {
  const enrollment = vi.fn(handler);
  runtime.server.on(
    "POST",
    "/v0/tenants/{tenantId}/local-computer-enrollments",
    enrollment,
  );
  return enrollment;
}
