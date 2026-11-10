import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { TeamHubError } from "@/features/teamhub/teamhub-client";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";

import { ConnectedAppsPage } from "./connected-apps-page";

describe("Connected apps", () => {
  afterEach(() => vi.restoreAllMocks());

  it("lists curated apps without a key and explains that an admin must set one", async () => {
    const runtime = await testRuntime();
    vi.spyOn(runtime.client, "listExternalApps").mockResolvedValue(
      await unconfiguredCatalog(runtime, false),
    );
    renderPage(runtime);

    fireEvent.click(
      await screen.findByRole("button", { name: "Connect Slack" }),
    );

    const dialog = await screen.findByRole("dialog", { name: "Connect Slack" });
    expect(dialog).toHaveTextContent("COMPOSIO_API_KEY");
    expect(dialog).toHaveTextContent("TEAMHUB_SECRET_ENCRYPTION_KEY");
    expect(
      within(dialog).queryByLabelText("Composio API key"),
    ).not.toBeInTheDocument();
  });

  it("asks for the Composio key on Connect, then connects from the dialog", async () => {
    const runtime = await testRuntime();
    const listApps = vi
      .spyOn(runtime.client, "listExternalApps")
      .mockResolvedValue(await unconfiguredCatalog(runtime, true));
    runtime.server.on("PUT", "/v0/external-apps/provider-key", () => ({
      can_save: true,
      source: "stored",
    }));
    const save = vi.spyOn(runtime.client, "saveExternalProviderKey");
    const pending = {
      ...(await runtime.client.listExternalConnections()).connections[0]!,
      provider: "slack" as const,
      status: "pending" as const,
      connect_url: "https://connect.example.test/slack",
    };
    const createConnection = vi
      .spyOn(runtime.client, "createExternalConnection")
      .mockResolvedValue(pending);
    vi.spyOn(window, "open").mockReturnValue({
      close: vi.fn(),
      opener: window,
    } as unknown as Window);
    renderPage(runtime);

    // The app list stays visible without a key.
    fireEvent.click(
      await screen.findByRole("button", { name: "Connect Slack" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Connect Slack" });
    expect(dialog).toHaveTextContent(
      "Connect Slack securely through Composio. Add your API key once to enable your connectors.",
    );
    expect(dialog).toHaveTextContent("full read and write access");
    expect(dialog).toHaveTextContent("Read All");
    expect(dialog).toHaveTextContent("Write All");
    expect(dialog).toHaveTextContent(
      "Permissions cannot be changed after a key is created",
    );
    expect(dialog).toHaveTextContent(
      "Copy the key, paste it below, and select Save key",
    );
    expect(dialog).toHaveTextContent(
      "select Connect, and complete authorization",
    );
    expect(dialog).toHaveTextContent(
      "Read-only keys cannot create the authorization",
    );
    expect(
      within(dialog).getByRole("link", { name: "Get a key" }),
    ).toHaveAttribute(
      "href",
      "https://dashboard.composio.dev/~/project/settings/api-keys",
    );
    expect(createConnection).not.toHaveBeenCalled();

    listApps.mockRestore();
    fireEvent.change(within(dialog).getByLabelText("Composio API key"), {
      target: { value: " ck_live " },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save key" }));
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Connect Slack" }),
    );

    expect(save).toHaveBeenCalledWith("ck_live");
    await waitFor(() => expect(createConnection).toHaveBeenCalledWith("slack"));
    expect(window.open).toHaveBeenCalledWith(
      "https://connect.example.test/slack",
      "linger_composio_oauth",
      expect.any(String),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("asks for the Composio key from the app details dialog too", async () => {
    const runtime = await testRuntime();
    vi.spyOn(runtime.client, "listExternalApps").mockResolvedValue(
      await unconfiguredCatalog(runtime, true),
    );
    const create = vi.spyOn(runtime.client, "createExternalConnection");
    renderPage(runtime, "/apps?app=slack");

    const details = await screen.findByRole("dialog", { name: "Slack" });
    fireEvent.click(
      within(details).getByRole("button", { name: "Connect Slack" }),
    );

    const keyDialog = await screen.findByRole("dialog", {
      name: "Connect Slack",
    });
    expect(within(keyDialog).getByLabelText("Composio API key")).toBeVisible();
    expect(
      within(keyDialog).getByRole("link", { name: "Get a key" }),
    ).toBeVisible();
    expect(create).not.toHaveBeenCalled();
  });

  it("shows a one-line summary on the card and the full description in the dialog", async () => {
    const runtime = await testRuntime();
    const description =
      "Import the last six months, up to 3,000 messages, for Profile and Wiki.";
    vi.spyOn(runtime.client, "listExternalApps").mockResolvedValue({
      provider_configured: true,
      provider_key: { source: "stored", can_save: true },
      apps: [
        {
          key: "gmail",
          display_name: "Gmail",
          description,
          availability: "available",
          capabilities: ["connect", "agent_tools"],
          allows_multiple_connections: true,
          supports_reauthorization: false,
        },
      ],
    });
    vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
      connections: [],
    });

    renderPage(runtime);

    const card = await screen.findByRole("button", { name: "Gmail" });
    expect(within(card).getByText("Email")).toHaveClass("truncate");
    expect(within(card).queryByText(description)).toBeNull();
    // A saved provider key is not managed from this page.
    expect(screen.queryByRole("button", { name: "Composio key" })).toBeNull();

    fireEvent.click(card);
    expect(
      await screen.findByRole("dialog", { name: "Gmail" }),
    ).toHaveTextContent(description);
  });

  it("groups apps into sections, hides ungrouped apps, and filters by group", async () => {
    const runtime = await testRuntime();

    renderPage(runtime);

    expect(await screen.findByRole("button", { name: "Gmail" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Connectors" })).toBeVisible();
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(
      screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent),
    ).toEqual(["Mail & Calendar", "Meetings", "Productivity", "Messaging"]);
    const sectionApps = (name: string) =>
      within(screen.getByRole("region", { name }))
        .getAllByRole("article")
        .map((card) => within(card).getAllByRole("button")[0]!.ariaLabel);
    expect(sectionApps("Mail & Calendar")).toEqual([
      "Gmail",
      "Google Calendar",
    ]);
    expect(sectionApps("Meetings")).toEqual(["Google Meet"]);
    expect(sectionApps("Productivity")).toEqual(["GitHub", "Notion"]);
    expect(sectionApps("Messaging")).toEqual(["Slack", "Discord"]);
    // Facebook belongs to no group, so the page does not offer it.
    expect(screen.queryByRole("button", { name: "Facebook" })).toBeNull();
    expect(screen.getAllByText("Unavailable")).toHaveLength(3);
    expect(
      within(screen.getByRole("button", { name: "Gmail" })).getByText(
        "Connected",
      ),
    ).toBeVisible();
    // Disconnecting sits in the card's menu, not beside Connect.
    expect(
      screen.queryByRole("button", { name: "Disconnect Gmail" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Actions for Gmail" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Connect Slack" })).toBeVisible();
    expect(screen.queryByText("jenny@linger.test")).not.toBeInTheDocument();

    const categories = screen.getByRole("tablist", {
      name: "Connector categories",
    });
    fireEvent.click(within(categories).getByRole("tab", { name: "Messaging" }));
    expect(
      within(categories).getByRole("tab", { name: "Messaging" }),
    ).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
    expect(
      within(screen.getByRole("region", { name: "Application connections" }))
        .getAllByRole("article")
        .map((card) => within(card).getAllByRole("button")[0]!.ariaLabel),
    ).toEqual(["Slack", "Discord"]);

    fireEvent.click(within(categories).getByRole("tab", { name: "All" }));
    fireEvent.click(screen.getByRole("button", { name: "Connected only" }));
    expect(
      within(screen.getByRole("region", { name: "Application connections" }))
        .getAllByRole("article")
        .map((card) => within(card).getAllByRole("button")[0]!.ariaLabel),
    ).toEqual(["Gmail"]);

    fireEvent.click(screen.getByRole("button", { name: "Connected only" }));
    fireEvent.click(screen.getByRole("button", { name: "Gmail" }));
    expect(await screen.findByText("jenny@linger.test")).toBeVisible();
  });

  it("asks for a new key when Composio rejects the saved one, then connects", async () => {
    const runtime = await testRuntime();
    vi.spyOn(runtime.client, "listExternalApps").mockResolvedValue({
      ...(await runtime.client.listExternalApps()),
      provider_configured: true,
      provider_key: { source: "stored", can_save: true },
    });
    const save = vi
      .spyOn(runtime.client, "saveExternalProviderKey")
      .mockResolvedValue({ source: "stored", can_save: true });
    const pending = {
      ...(await runtime.client.listExternalConnections()).connections[0]!,
      provider: "slack" as const,
      status: "pending" as const,
      connect_url: "https://connect.example.test/slack",
    };
    const create = vi
      .spyOn(runtime.client, "createExternalConnection")
      .mockRejectedValueOnce(
        new TeamHubError({
          code: "COMPOSIO_KEY_REJECTED",
          message: "Composio rejected the configured API key",
          status: 409,
        }),
      )
      .mockResolvedValueOnce(pending);
    renderPage(runtime);

    fireEvent.click(
      await screen.findByRole("button", { name: "Connect Slack" }),
    );

    const dialog = await screen.findByRole("dialog", { name: "Connect Slack" });
    expect(dialog).toHaveTextContent(
      "Composio no longer accepts the saved API key.",
    );
    // The dialog explains the failure, so the card shows no error of its own.
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("Composio API key"), {
      target: { value: "ck_new" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save key" }));
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Connect Slack" }),
    );

    expect(save).toHaveBeenCalledWith("ck_new");
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  });

  it("lists a connected app outside the groups under Connected only", async () => {
    const runtime = await testRuntime();
    const existing = (await runtime.client.listExternalConnections())
      .connections[0]!;
    vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
      connections: [
        existing,
        {
          ...existing,
          id: "external-connection-facebook",
          provider: "facebook",
        },
      ],
    });
    renderPage(runtime);

    await screen.findByRole("button", { name: "Gmail" });
    expect(screen.queryByRole("button", { name: "Facebook" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Connected only" }));

    expect(
      within(screen.getByRole("region", { name: "Application connections" }))
        .getAllByRole("article")
        .map((card) => within(card).getAllByRole("button")[0]!.ariaLabel),
    ).toEqual(["Gmail", "Facebook"]);
  });

  it("opens the manage dialog for an app the grid does not offer", async () => {
    const runtime = await testRuntime();

    renderPage(runtime, "/apps?app=facebook");

    expect(
      await screen.findByRole("dialog", { name: "Facebook" }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Facebook" })).toBeNull();
  });

  it("counts only active authorizations as connected", async () => {
    const runtime = await testRuntime();
    const existing = (await runtime.client.listExternalConnections())
      .connections[0]!;
    vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
      connections: [
        existing,
        {
          ...existing,
          id: "gmail-expired",
          identity_label: "expired@linger.test",
          status: "expired",
        },
        {
          ...existing,
          id: "gmail-failed",
          identity_label: "failed@linger.test",
          status: "failed",
        },
      ],
    });

    renderPage(runtime, "/apps?app=gmail");

    const gmail = await screen.findByRole("button", { name: "Gmail" });
    expect(within(gmail).getByText("Connected")).toBeVisible();
    expect(screen.queryByText(/need attention/)).not.toBeInTheDocument();
    const dialog = screen.getByRole("dialog", { name: "Gmail" });
    expect(within(dialog).queryByText("expired@linger.test")).toBeNull();
    expect(within(dialog).queryByText("failed@linger.test")).toBeNull();
  });

  it("hides in-flight pending accounts from the manage dialog", async () => {
    const runtime = await testRuntime();
    const existing = (await runtime.client.listExternalConnections())
      .connections[0]!;
    vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
      connections: [
        {
          ...existing,
          id: "gmail-pending",
          identity_label: "gmail pending account",
          status: "pending",
        },
      ],
    });

    renderPage(runtime, "/apps?app=gmail");

    const dialog = await screen.findByRole("dialog", { name: "Gmail" });
    expect(
      within(dialog).queryByText("gmail pending account"),
    ).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Pending")).not.toBeInTheDocument();
    expect(screen.queryByText("Authorizing…")).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Connect Gmail" }).length,
    ).toBeGreaterThan(0);
  });

  it("lets the owner turn auto reminders off for a watchable account, without Agent access", async () => {
    const runtime = await testRuntime();
    const listAccess = vi.spyOn(
      runtime.client,
      "listExternalConnectionAgentAccess",
    );
    const initial = (await runtime.client.listExternalConnections())
      .connections[0]!;
    const off = { ...initial, auto_reminders: false };
    vi.spyOn(runtime.client, "listExternalConnections")
      .mockResolvedValueOnce({ connections: [initial] })
      .mockResolvedValue({ connections: [off] });
    const setAutoReminders = vi
      .spyOn(runtime.client, "setExternalConnectionAutoReminders")
      .mockResolvedValue(off);

    renderPage(runtime, "/apps?app=gmail");

    const dialog = await screen.findByRole("dialog", { name: "Gmail" });
    const toggle = await within(dialog).findByRole("switch", {
      name: "Auto reminders for jenny@linger.test",
    });
    expect(toggle).toBeChecked();
    expect(
      within(dialog).getByText(
        "Agents check this account for things that need your attention.",
      ),
    ).toBeVisible();
    expect(within(dialog).queryByText("Agent access")).toBeNull();
    fireEvent.click(toggle);

    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(setAutoReminders).toHaveBeenCalledWith(
      "external-connection-gmail",
      false,
    );
    expect(listAccess).not.toHaveBeenCalled();
  });

  it("shows no auto reminders switch for an app AnotherMe cannot watch", async () => {
    const runtime = await testRuntime();
    const existing = (await runtime.client.listExternalConnections())
      .connections[0]!;
    vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
      connections: [
        {
          ...existing,
          id: "external-connection-notion",
          identity_label: "Jenny's workspace",
          provider: "notion",
        },
      ],
    });

    renderPage(runtime, "/apps?app=notion");

    const dialog = await screen.findByRole("dialog", { name: "Notion" });
    expect(await within(dialog).findByText("Jenny's workspace")).toBeVisible();
    expect(within(dialog).queryByRole("switch")).toBeNull();
    expect(within(dialog).queryByText("Agent access")).toBeNull();
  });

  it("starts a connection through the generic app endpoint", async () => {
    const runtime = await testRuntime();
    const pending = {
      ...(await runtime.client.listExternalConnections()).connections[0]!,
      provider: "slack" as const,
      status: "pending" as const,
      connect_url: "https://connect.example.test/slack",
    };
    const createConnection = vi
      .spyOn(runtime.client, "createExternalConnection")
      .mockResolvedValue(pending);
    vi.spyOn(window, "open").mockReturnValue({
      close: vi.fn(),
      opener: window,
    } as unknown as Window);

    renderPage(runtime);

    fireEvent.click(
      await screen.findByRole("button", { name: "Connect Slack" }),
    );

    await waitFor(() => expect(createConnection).toHaveBeenCalledWith("slack"));
    expect(window.open).toHaveBeenCalledWith(
      "https://connect.example.test/slack",
      "linger_composio_oauth",
      expect.stringContaining("width=560,height=720"),
    );
    expect(screen.queryByText("Authorization in progress")).toBeNull();
  });

  it("keeps unavailable catalog entries visible but not actionable", async () => {
    const runtime = await testRuntime();

    renderPage(runtime);
    fireEvent.click(await screen.findByRole("button", { name: "Discord" }));

    const dialog = await screen.findByRole("dialog", { name: "Discord" });
    expect(
      within(dialog).getByRole("button", { name: "Connect" }),
    ).toBeDisabled();
    expect(
      within(dialog).queryByText("No accounts connected."),
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("button", { name: "Discord" })).getByText(
        "Unavailable",
      ),
    ).toBeVisible();
  });

  it("keeps the pending connection and offers a popup-blocker fallback", async () => {
    const runtime = await testRuntime();
    const pending = {
      ...(await runtime.client.listExternalConnections()).connections[0]!,
      provider: "slack" as const,
      status: "pending" as const,
      connect_url: "https://connect.example.test/slack",
    };
    vi.spyOn(runtime.client, "createExternalConnection").mockResolvedValue(
      pending,
    );
    vi.spyOn(window, "open").mockReturnValue(null);

    renderPage(runtime);
    fireEvent.click(
      await screen.findByRole("button", { name: "Connect Slack" }),
    );

    expect(
      await screen.findByText("Your browser blocked the authorization popup."),
    ).toBeVisible();
    expect(screen.getByText("Authorizing…")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Open authorization window" }),
    ).toBeVisible();
  });

  it("hides a pending Discord account that never finished connecting", async () => {
    const runtime = await testRuntime();
    const template = (await runtime.client.listExternalConnections())
      .connections[0]!;
    const pending = {
      ...template,
      id: "pending-discord",
      identity_label: "Discord server",
      provider: "discord" as const,
      status: "pending" as const,
      status_error_code: "discord_guild_required",
    };
    const catalog = await runtime.client.listExternalApps();
    vi.spyOn(runtime.client, "listExternalApps").mockResolvedValue({
      provider_configured: true,
      provider_key: { source: "environment", can_save: false },
      apps: catalog.apps.map((app) =>
        app.key === "discord"
          ? { ...app, availability: "available" as const }
          : app,
      ),
    });
    vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
      connections: [pending],
    });
    vi.spyOn(runtime.client, "getExternalConnection").mockResolvedValue(
      pending,
    );
    renderPage(runtime, "/apps?app=discord");
    const dialog = await screen.findByRole("dialog", { name: "Discord" });
    expect(
      within(dialog).queryByText("Discord server"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Discord could not verify the authorized Server/),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Discord Server ID")).toBeNull();
    expect(
      within(dialog).getByRole("button", { name: "Connect Discord" }),
    ).toBeEnabled();
  });

  it("hides a Gmail account that failed authorization", async () => {
    const runtime = await testRuntime();
    const existing = (await runtime.client.listExternalConnections())
      .connections[0]!;
    vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
      connections: [
        {
          ...existing,
          status: "failed",
          status_error_code: "provider_auth_failed",
        },
      ],
    });

    renderPage(runtime, "/apps?app=gmail");

    const dialog = await screen.findByRole("dialog", { name: "Gmail" });
    expect(
      screen.queryByText(
        "This app did not grant enough permission. Reconnect and approve all requested access.",
      ),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
    expect(
      within(dialog).getByRole("button", { name: "Connect Gmail" }),
    ).toBeEnabled();
  });

  it("hides an expired Gmail account instead of continuing reauthorization", async () => {
    const runtime = await testRuntime();
    const existing = (await runtime.client.listExternalConnections())
      .connections[0]!;
    vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
      connections: [
        {
          ...existing,
          reauthorizing: true,
          reauthorization_connect_expires_at: "2026-08-06T08:10:00.000Z",
          reauthorization_connect_url:
            "https://connect.example.test/gmail/reauthorize",
          status: "expired",
        },
      ],
    });
    const createReauthorization = vi.spyOn(
      runtime.client,
      "createExternalConnectionReauthorization",
    );
    const replace = vi.fn();
    vi.spyOn(window, "open").mockReturnValue({
      close: vi.fn(),
      location: { replace },
      opener: window,
    } as unknown as Window);

    renderPage(runtime, "/apps?app=gmail");

    const dialog = await screen.findByRole("dialog", { name: "Gmail" });
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(
      within(dialog).getByRole("button", { name: "Connect Gmail" }),
    ).toBeEnabled();
    expect(window.open).not.toHaveBeenCalled();
    expect(createReauthorization).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("hides a duplicate remote account that failed to connect", async () => {
    const runtime = await testRuntime();
    const existing = (await runtime.client.listExternalConnections())
      .connections[0]!;
    vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
      connections: [
        {
          ...existing,
          id: "external-connection-duplicate",
          status: "failed",
          status_error_code: "duplicate_remote_principal",
        },
      ],
    });

    renderPage(runtime, "/apps?app=gmail");

    const dialog = await screen.findByRole("dialog", { name: "Gmail" });
    expect(
      screen.queryByText("This account is already connected."),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
    expect(
      within(dialog).getByRole("button", { name: "Connect Gmail" }),
    ).toBeEnabled();
  });

  it("confirms what disconnecting stops before disconnecting an account", async () => {
    const runtime = await testRuntime();
    const existing = (await runtime.client.listExternalConnections())
      .connections[0]!;
    const disconnecting = {
      ...existing,
      revision: existing.revision + 1,
      status: "disconnecting" as const,
    };
    const disconnect = vi
      .spyOn(runtime.client, "disconnectExternalConnection")
      .mockResolvedValue(disconnecting);
    vi.spyOn(runtime.client, "getExternalConnection").mockResolvedValue(
      disconnecting,
    );

    renderPage(runtime, "/apps?app=gmail");

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Disconnect jenny@linger.test",
      }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Disconnect account?",
    });
    expect(
      within(dialog).getByText(/Agents lose access to this account/),
    ).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));

    await waitFor(() => expect(disconnect).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(
        within(dialog).queryByRole("button", { name: "Disconnect" }),
      ).toBeNull(),
    );
    expect(
      within(dialog).getAllByRole("button", { name: "Close" }).length,
    ).toBeGreaterThan(0);
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "Provider authorization: pending",
    );
    expect(disconnect.mock.calls[0]?.[1]).toEqual({ expected_revision: 1 });
  });
});

/** The curated catalog TeamHub lists without a Composio key. */
async function unconfiguredCatalog(
  runtime: Awaited<ReturnType<typeof testRuntime>>,
  canSave: boolean,
) {
  const catalog = await runtime.client.listExternalApps();
  return {
    apps: catalog.apps.map((app) => ({
      ...app,
      availability: "unavailable" as const,
    })),
    provider_configured: false,
    provider_key: { source: "none" as const, can_save: canSave },
  };
}

async function testRuntime() {
  const runtime = createTestTeamHubRuntime();

  return runtime;
}

function renderPage(
  runtime: Awaited<ReturnType<typeof testRuntime>>,
  initialEntry = "/apps",
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <ConnectedAppsPage />
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}
