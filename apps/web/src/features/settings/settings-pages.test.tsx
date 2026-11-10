import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createTestTeamHubRuntime,
  type TestTeamHubRuntime,
} from "@/test/teamhub-test-runtime";
import type { TestRouteRequest } from "@/test/teamhub-test-server";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubAccountProfileUpdate } from "@/features/teamhub/teamhub-types";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";

import { AccountSettingsPage } from "./account-settings-page";
import { SecuritySettingsPage } from "./security-settings-page";
import { SettingsLayout } from "./settings-page";

// The dialog imports its sections lazily, so pay that cost before the first
// assertion instead of racing a dynamic import inside a findBy timeout.
beforeAll(async () => {
  await Promise.all([
    import("./account-settings-page"),
    import("./security-settings-page"),
    import("@/features/local-computer/computers-page"),
  ]);
});

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() {
        return values.size;
      },
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    } satisfies Storage,
  });
});

describe("Settings surfaces", () => {
  it("saves the display name from the profile card without changing the overview", async () => {
    const runtime = await testRuntime();
    const before = await runtime.client.getPersonalProfile("tenant-northstar");
    const saved = {
      ...(await accountProfile(runtime)),
      name: "Jenny Card",
      name_user_managed: true,
    };
    const patch = vi.fn(() => saved);
    runtime.server.on("PATCH", "/v0/tenants/{tenantId}/account-profile", patch);
    renderSettings(runtime);
    fireEvent.click(
      await screen.findByRole("button", { name: "Edit display name" }),
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Profile display name" }),
      { target: { value: "Jenny Card" } },
    );
    runtime.server.on(
      "GET",
      "/v0/tenants/{tenantId}/account-profile",
      () => saved,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("textbox", { name: "Profile display name" }),
      ).not.toBeInTheDocument(),
    );
    expect(patch).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { name: "Jenny Card" },
        params: { tenantId: "tenant-northstar" },
      }),
    );
    expect(
      (await screen.findAllByText("Jenny Card", { exact: true }))[0],
    ).toBeVisible();
    expect(await runtime.client.getPersonalProfile("tenant-northstar")).toEqual(
      before,
    );
  });

  it("shows Personal Insights without provenance and lets the Human remove one", async () => {
    const runtime = await testRuntime();
    const remove = vi
      .spyOn(runtime.client, "deletePersonalInsight")
      .mockResolvedValue();
    renderSettings(runtime);

    expect(
      await screen.findByRole("heading", { name: "Insights" }),
    ).toBeVisible();
    expect(
      screen.getByText(
        "You prefer direct evidence and clear ownership before a team commits to a plan.",
      ),
    ).toBeVisible();
    expect(screen.queryByText("Evidence source")).not.toBeInTheDocument();

    vi.spyOn(runtime.client, "listPersonalInsights").mockResolvedValue({
      items: [],
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Delete Communication style insight",
      }),
    );

    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("No insights yet.")).toBeVisible();
  });

  it("switches Settings sections through their own addresses", async () => {
    const runtime = await testRuntime();
    renderSettings(runtime);

    fireEvent.click(
      within(
        await screen.findByRole("navigation", { name: "Settings sections" }),
      ).getByRole("link", { name: "Security" }),
    );

    expect(
      await screen.findByRole("button", { name: "Change password" }),
    ).toBeVisible();
    expect(screen.getByTestId("location")).toHaveTextContent(
      "/t/tenant-northstar/settings/security",
    );
    expect(screen.getByRole("link", { name: "Security" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("presents Settings as a page and displays the saved Account response", async () => {
    const runtime = await testRuntime();
    const saved = {
      ...(await accountProfile(runtime)),
      organization: "Northstar Labs",
      organization_user_managed: true,
    };
    const patch = vi.fn(() => saved);
    runtime.server.on("PATCH", "/v0/tenants/{tenantId}/account-profile", patch);
    renderSettings(runtime);

    expect(
      await screen.findByRole("heading", { level: 1, name: "Settings" }),
    ).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const settingsNav = screen.getByRole("complementary", {
      name: "Settings navigation",
    });
    expect(
      within(settingsNav)
        .getAllByRole("link")
        .map((link) => link.textContent?.replace(/\s+/g, " ").trim()),
    ).toEqual(["Profile", "Security", "Computers"]);
    expect(
      screen.queryByRole("button", { name: "Log out" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Change password" }),
    ).not.toBeInTheDocument();
    // The display name is edited on the profile card, not in this form.
    expect(screen.queryByLabelText("Name")).toBeNull();
    const organization = await screen.findByLabelText("Organization");
    expect(
      screen.queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument();
    fireEvent.change(organization, { target: { value: "Northstar Labs" } });
    const saveProfile = screen.getByRole("button", { name: "Save" });
    expect(saveProfile).toBeEnabled();
    runtime.server.on(
      "GET",
      "/v0/tenants/{tenantId}/account-profile",
      () => saved,
    );
    fireEvent.click(saveProfile);

    expect(await screen.findByText("Account saved")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument();
    expect(patch).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { bio: "", organization: "Northstar Labs" },
        params: { tenantId: "tenant-northstar" },
      }),
    );
    expect(organization).toHaveValue("Northstar Labs");
  });

  it("locks Account input while a profile save is pending", async () => {
    const runtime = await testRuntime();
    const currentAccount = await accountProfile(runtime);
    let completeSave!: () => void;
    const save = vi.fn(
      ({ body }: TestRouteRequest) =>
        new Promise((resolve) => {
          completeSave = () =>
            resolve({
              ...currentAccount,
              organization:
                (body as TeamHubAccountProfileUpdate).organization ??
                currentAccount.organization,
              organization_user_managed: true,
            });
        }),
    );
    runtime.server.on("PATCH", "/v0/tenants/{tenantId}/account-profile", save);
    renderSettings(runtime);

    const organization = await screen.findByLabelText("Organization");
    fireEvent.change(organization, { target: { value: "Northstar Labs" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(organization).toBeDisabled());
    await waitFor(() => expect(save).toHaveBeenCalled());
    await act(async () => completeSave());
    expect(await screen.findByText("Account saved")).toBeVisible();
  });

  it("preserves a dirty Account input when server state refreshes", async () => {
    const runtime = await testRuntime();
    const { queryClient } = renderSettings(runtime);
    const organization = await screen.findByLabelText("Organization");

    fireEvent.change(organization, { target: { value: "Draft Co" } });
    act(() => {
      queryClient.setQueryData(
        ["teamhub", "account-profile", "tenant-northstar"],
        {
          name: "Jenny Remote",
          bio: "",
          organization: "",
          name_user_managed: false,
          bio_user_managed: false,
          organization_user_managed: false,
          email: "jenny@northstar.example",
        },
      );
    });

    expect((await screen.findAllByText("Jenny Remote"))[0]).toBeVisible();
    expect(organization).toHaveValue("Draft Co");

    fireEvent.change(organization, { target: { value: "" } });
    act(() => {
      queryClient.setQueryData(
        ["teamhub", "account-profile", "tenant-northstar"],
        {
          name: "Jenny Remote Again",
          bio: "",
          organization: "",
          name_user_managed: false,
          bio_user_managed: false,
          organization_user_managed: false,
          email: "jenny@northstar.example",
        },
      );
    });

    expect((await screen.findAllByText("Jenny Remote Again"))[0]).toBeVisible();
    expect(organization).toHaveValue("");
  });

  it("submits a valid password change from Security settings", async () => {
    const runtime = await testRuntime();
    const change = vi.fn(() => undefined);
    runtime.server.on("POST", "/v0/account/password", change);
    renderSettings(runtime, "/t/tenant-northstar/settings/security");

    fireEvent.click(
      await screen.findByRole("button", { name: "Change password" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Change password" });
    const submit = within(dialog).getByRole("button", {
      name: "Change password",
    });
    expect(submit).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText("Current password"), {
      target: { value: "linger-v0" },
    });
    fireEvent.change(within(dialog).getByLabelText("New password"), {
      target: { value: "linger-v1" },
    });
    fireEvent.change(within(dialog).getByLabelText("Confirm new password"), {
      target: { value: "different-password" },
    });
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Passwords do not match.",
    );
    expect(submit).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText("Confirm new password"), {
      target: { value: "linger-v1" },
    });
    fireEvent.click(submit);

    expect(await screen.findByText("Password changed")).toBeVisible();
    expect(change).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { current_password: "linger-v0", new_password: "linger-v1" },
      }),
    );
    expect(
      screen.queryByRole("dialog", { name: "Change password" }),
    ).not.toBeInTheDocument();
  });

  it("lets live TeamHub write Bio and Organization", async () => {
    const fixture = await testRuntime();
    renderSettings({
      ...fixture,
    });

    expect(await screen.findByLabelText("Bio")).toBeVisible();
    expect(screen.getByLabelText("Organization")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Log out" }),
    ).not.toBeInTheDocument();
  });

  it("shows the hero, Account form, and Insights only", async () => {
    const runtime = await testRuntime();
    renderSettings(runtime);

    expect(await screen.findByLabelText("Organization")).toBeVisible();
    expect(screen.queryByText("Connected accounts")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add source" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Insights" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Change cover" })).toBeVisible();
    expect(
      screen.getAllByRole("button", { name: "Upload profile photo" }),
    ).toHaveLength(1);
    expect(screen.queryByText("jenny@northstar.example")).toBeNull();
    expect(
      screen.queryByText("Your private profile, also used by Another Me."),
    ).toBeNull();
    expect(
      screen.queryByRole("article", { name: "Profile content" }),
    ).toBeNull();
  });
});

async function testRuntime() {
  const runtime = createTestTeamHubRuntime();

  return runtime;
}

function renderSettings(
  runtime: ReturnType<typeof createTestTeamHubRuntime>,
  initialEntry = "/t/tenant-northstar/settings/account",
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  }),
) {
  const view = render(
    <QueryClientProvider client={queryClient}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <RouterProvider
          router={createMemoryRouter(
            [
              { element: <p>Signed out</p>, path: "/login" },
              {
                children: [
                  { element: <AccountSettingsPage />, path: "account" },
                  { element: <SecuritySettingsPage />, path: "security" },
                ],
                element: (
                  <>
                    <SettingsLayout />
                    <LocationProbe />
                  </>
                ),
                path: "/t/:tenantId/settings",
              },
            ],
            { initialEntries: [initialEntry] },
          )}
        />
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );

  return { queryClient, unmount: view.unmount };
}

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">{`${location.pathname}${location.search}`}</output>
  );
}

function accountProfile(runtime: TestTeamHubRuntime) {
  return teamHubData(
    runtime.client.api.GET("/v0/tenants/{tenantId}/account-profile", {
      params: { path: { tenantId: "tenant-northstar" } },
    }),
  );
}
