import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";

import { OAuthCompletePage } from "./oauth-complete-page";

describe("OAuth completion page", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
  });

  function renderPage(outcome: Promise<void> = Promise.resolve()) {
    const runtime = createTestTeamHubRuntime();
    const complete = vi
      .spyOn(runtime.client, "completeExternalConnectionAuthorization")
      .mockReturnValue(outcome);
    render(
      <TeamHubRuntimeProvider runtime={runtime}>
        <OAuthCompletePage />
      </TeamHubRuntimeProvider>,
    );
    return complete;
  }

  it("asks TeamHub to check the returned account, then closes", async () => {
    window.history.replaceState(
      null,
      "",
      "/oauth/composio-complete?status=success&connected_account_id=ca_returned",
    );
    const close = vi.spyOn(window, "close").mockImplementation(() => undefined);

    const complete = renderPage();

    expect(complete).toHaveBeenCalledWith("ca_returned");
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(
      screen.getByRole("heading", { name: "Authorization complete" }),
    ).toBeVisible();
    expect(screen.getByText("You can close this window.")).toBeVisible();
  });

  it("checks every pending authorization when the callback names none, and closes on failure", async () => {
    window.history.replaceState(null, "", "/oauth/composio-complete");
    const close = vi.spyOn(window, "close").mockImplementation(() => undefined);

    const complete = renderPage(Promise.reject(new Error("offline")));

    expect(complete).toHaveBeenCalledWith(undefined);
    await waitFor(() => expect(close).toHaveBeenCalled());
  });
});
