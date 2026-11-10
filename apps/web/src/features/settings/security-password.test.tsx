import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import {
  teamHubErrorResponse,
  type TestRouteHandler,
} from "@/test/teamhub-test-server";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { ChangePasswordDialog } from "./change-password-dialog";
import { SecuritySettingsPage } from "./security-settings-page";

describe("Security password through the live HTTP client", () => {
  it("keeps the pending password dialog open until the result arrives", async () => {
    let rejectChange!: (error: Error) => void;
    const changePassword = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          rejectChange = reject;
        }),
    );
    const onClose = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ChangePasswordDialog
          changePassword={changePassword}
          onChanged={vi.fn()}
          onClose={onClose}
        />
      </QueryClientProvider>,
    );
    const dialog = screen.getByRole("dialog", { name: "Change password" });
    for (const label of [
      "Current password",
      "New password",
      "Confirm new password",
    ]) {
      fireEvent.change(within(dialog).getByLabelText(label), {
        target: { value: "test-password" },
      });
    }
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Change password" }),
    );
    await waitFor(() => expect(changePassword).toHaveBeenCalledOnce());
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent(dialog, new Event("cancel", { bubbles: true, cancelable: true }));
    expect(onClose).not.toHaveBeenCalled();
    rejectChange(
      new Error("Could not confirm password change. Please try again."),
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Could not confirm password change.",
    );
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toBeEnabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("works through TeamHub and retains the dialog on failure without retrying", async () => {
    const fixture = createTestTeamHubRuntime();

    const change = vi
      .fn<TestRouteHandler>()
      .mockReturnValueOnce(
        teamHubErrorResponse(
          400,
          "INVALID_CURRENT_PASSWORD",
          "Current password is incorrect.",
        ),
      )
      .mockReturnValueOnce(undefined);
    fixture.server.on("POST", "/v0/account/password", change);
    render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: {
              mutations: { retry: 3 },
              queries: { retry: false },
            },
          })
        }
      >
        <TeamHubRuntimeProvider runtime={fixture}>
          <MemoryRouter>
            <SecuritySettingsPage />
          </MemoryRouter>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Change password" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Change password" });
    expect(
      within(dialog).getByText(/Other browsers and devices/),
    ).toBeVisible();
    for (const [label, value] of [
      ["Current password", "wrong-password"],
      ["New password", "new-password"],
      ["Confirm new password", "new-password"],
    ] as const) {
      fireEvent.change(within(dialog).getByLabelText(label), {
        target: { value },
      });
    }
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Change password" }),
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Current password is incorrect.",
    );
    expect(change).toHaveBeenCalledTimes(1);
    fireEvent.change(within(dialog).getByLabelText("Current password"), {
      target: { value: "old-password" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Change password" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Password changed");
    expect(change).toHaveBeenCalledTimes(2);
    expect(change).toHaveBeenLastCalledWith(
      expect.objectContaining({
        body: {
          current_password: "old-password",
          new_password: "new-password",
        },
      }),
    );
  });
});
