import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import type { TeamHubPersonalProfileGeneration } from "@/features/teamhub/teamhub-types";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";

import { WikiProfilePage } from "./wiki-profile-page";

const generation: TeamHubPersonalProfileGeneration = {
  id: "profile-generation-response",
  tenant_id: "tenant-northstar",
  status: "queued",
  decision_status: "pending",
  prompt_version: "scenario",
  sources: [],
  created_at: "2026-10-15T12:00:00Z",
  updated_at: "2026-10-15T12:00:00Z",
};

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

describe("Wiki Profile sources", () => {
  it("adds an already connected Gmail account to the profile", async () => {
    const runtime = await testRuntime();
    const generate = vi
      .spyOn(runtime.client, "createPersonalProfileGeneration")
      .mockResolvedValue(generation);
    renderProfile(runtime);

    await openAddSource();
    const dialog = await screen.findByRole("dialog", {
      name: "Add profile sources",
    });
    expect(
      within(dialog).getByRole("navigation", { name: "Profile sources" }),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("button", { name: "Accounts" }),
    ).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Files" })).toBeVisible();
    expect(
      within(dialog).getByRole("button", { name: "Another AI" }),
    ).toBeVisible();
    const addGmail = await within(dialog).findByRole("button", {
      name: "Add Gmail",
    });
    expect(addGmail.parentElement).toHaveTextContent(
      "GmailConnected as jenny@linger.testAdd",
    );
    fireEvent.click(addGmail);
    await waitFor(() => expect(generate).toHaveBeenCalledOnce());
    expect(generate.mock.calls[0]?.[1]).toEqual({
      sources: [
        {
          connection_id: "external-connection-gmail",
          kind: "connection",
        },
      ],
    });
  });

  it("requires Notion page or database selections before generating from More", async () => {
    const runtime = await testRuntime();
    const template = (await runtime.client.listExternalConnections())
      .connections[0]!;
    vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
      connections: [
        {
          ...template,
          id: "external-connection-notion",
          identity_label: "Jenny workspace",
          provider: "notion",
        },
      ],
    });
    vi.spyOn(runtime.client, "listNotionResources").mockResolvedValue({
      resources: [
        {
          id: "page-about",
          kind: "notion_page",
          title: "About me",
        },
        {
          id: "db-projects",
          kind: "notion_database",
          title: "Projects",
        },
      ],
    });
    const generate = vi
      .spyOn(runtime.client, "createPersonalProfileGeneration")
      .mockResolvedValue(generation);
    renderProfile(runtime);

    await openAddSource();
    const dialog = await screen.findByRole("dialog", {
      name: "Add profile sources",
    });
    fireEvent.click(
      await within(dialog).findByRole("button", {
        name: "Choose Notion",
      }),
    );
    expect(
      await within(dialog).findByRole("checkbox", { name: "About me" }),
    ).toBeVisible();
    expect(
      within(dialog).queryByText(
        "Share pages or databases with the Notion integration first.",
      ),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", {
        name: "Add 0 Notion items",
      }),
    ).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "About me" }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Projects" }));
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Add 2 Notion items",
      }),
    );
    await waitFor(() => expect(generate).toHaveBeenCalledOnce());
    expect(generate.mock.calls[0]?.[1]).toEqual({
      sources: [
        {
          kind: "connection",
          connection_id: "external-connection-notion",
          selections: [
            {
              is_private: false,
              kind: "notion_page",
              name: "About me",
              remote_id: "page-about",
            },
            {
              is_private: false,
              kind: "notion_database",
              name: "Projects",
              remote_id: "db-projects",
            },
          ],
        },
      ],
    });
  });

  it("lets an Apps-connected GitHub account choose optional profile content", async () => {
    const runtime = await testRuntime();
    const template = (await runtime.client.listExternalConnections())
      .connections[0]!;
    vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
      connections: [
        {
          ...template,
          id: "external-connection-github",
          identity_label: "@octocat",
          provider: "github",
        },
      ],
    });
    vi.spyOn(runtime.client, "listGitHubRepositories").mockResolvedValue({
      repositories: [
        {
          default_branch: "main",
          description: "Profile repository",
          full_name: "octocat/profile",
          html_url: "https://github.com/octocat/profile",
          id: "repo-1",
          language: "TypeScript",
          name: "profile",
          updated_at: "2026-09-03T12:00:00.000Z",
        },
      ],
    });
    const generate = vi
      .spyOn(runtime.client, "createPersonalProfileGeneration")
      .mockResolvedValue(generation);
    renderProfile(runtime);

    await openAddSource();
    const dialog = await screen.findByRole("dialog", {
      name: "Add profile sources",
    });
    fireEvent.click(
      await within(dialog).findByRole("button", {
        name: "Choose GitHub",
      }),
    );

    expect(
      await within(dialog).findByText("GitHub repositories"),
    ).toBeVisible();
    const addProfile = within(dialog).getByRole("button", {
      name: "Add GitHub profile",
    });
    expect(addProfile).toBeEnabled();
    fireEvent.click(addProfile);

    await waitFor(() => expect(generate).toHaveBeenCalledOnce());
    expect(generate.mock.calls[0]?.[1]).toEqual({
      sources: [
        {
          connection_id: "external-connection-github",
          kind: "connection",
        },
      ],
    });
  });

  it("automatically adds a newly authorized fixed Gmail source", async () => {
    const runtime = await testRuntime();
    const listed = await runtime.client.listExternalConnections();
    const template = listed.connections.find(
      (connection) => connection.provider === "gmail",
    )!;
    const pending = {
      ...template,
      connect_url: "https://connect.example.test/gmail",
      id: "external-connection-gmail-new",
      identity_label: undefined,
      status: "pending" as const,
    };
    const active = {
      ...pending,
      connect_url: undefined,
      identity_label: "new@linger.test",
      status: "active" as const,
    };
    vi.spyOn(runtime.client, "createExternalConnection").mockResolvedValue(
      pending,
    );
    vi.spyOn(runtime.client, "listExternalConnections")
      .mockResolvedValueOnce({
        connections: listed.connections.filter(
          (connection) => connection.provider !== "gmail",
        ),
      })
      .mockResolvedValue({
        connections: listed.connections.concat(active),
      });
    const generate = vi
      .spyOn(runtime.client, "createPersonalProfileGeneration")
      .mockResolvedValue(generation);
    vi.spyOn(window, "open").mockReturnValue({
      close: vi.fn(),
      location: { replace: vi.fn() },
      opener: window,
    } as unknown as Window);
    renderProfile(runtime);

    await openAddSource();
    const dialog = await screen.findByRole("dialog", {
      name: "Add profile sources",
    });
    fireEvent.click(
      await within(dialog).findByRole("button", {
        name: "Add Gmail",
      }),
    );

    await waitFor(() => expect(generate).toHaveBeenCalledOnce());
    expect(generate.mock.calls[0]?.[1]).toEqual({
      sources: [
        {
          connection_id: "external-connection-gmail-new",
          kind: "connection",
        },
      ],
    });
  });

  it("lets the Human continue a pending authorization from Add source", async () => {
    const runtime = await testRuntime();
    const listed = await runtime.client.listExternalConnections();
    const template = listed.connections[0]!;
    const pending = {
      ...template,
      connect_url: undefined,
      id: "external-connection-notion-pending",
      identity_label: undefined,
      provider: "notion" as const,
      status: "pending" as const,
    };
    const active = {
      ...pending,
      identity_label: "Jenny workspace",
      status: "active" as const,
    };
    vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
      connections: [pending],
    });
    vi.spyOn(runtime.client, "getExternalConnection").mockResolvedValue({
      ...pending,
      connect_url: "https://connect.example.test/notion-pending",
    });
    vi.spyOn(runtime.client, "listNotionResources").mockResolvedValue({
      resources: [],
    });
    vi.spyOn(window, "open").mockReturnValue({
      close: vi.fn(),
      opener: window,
    } as unknown as Window);
    const { queryClient } = renderProfile(runtime);

    await openAddSource();
    const dialog = await screen.findByRole("dialog", {
      name: "Add profile sources",
    });
    fireEvent.click(
      await within(dialog).findByRole("button", {
        name: "Continue Notion authorization",
      }),
    );

    expect(window.open).toHaveBeenCalledWith(
      "https://connect.example.test/notion-pending",
      "linger_composio_oauth",
      expect.stringContaining("width=560,height=720"),
    );
    act(() => {
      queryClient.setQueryData(["teamhub", "external-connections"], {
        connections: [active],
      });
    });
    expect(
      await within(dialog).findByRole("heading", {
        name: "Choose Notion content",
      }),
    ).toBeVisible();
  });

  it("does not treat a rejected duplicate authorization as a reconnectable account", async () => {
    const runtime = await testRuntime();
    const existing = (await runtime.client.listExternalConnections())
      .connections[0]!;
    vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
      connections: [
        {
          ...existing,
          id: "external-connection-duplicate",
          provider: "gmail",
          status: "failed",
          status_error_code: "duplicate_remote_principal",
        },
      ],
    });

    renderProfile(runtime);
    await openAddSource();
    const dialog = await screen.findByRole("dialog", {
      name: "Add profile sources",
    });

    expect(
      await within(dialog).findByRole("button", { name: "Add Gmail" }),
    ).toBeVisible();
    expect(within(dialog).queryByText("Open Apps")).toBeNull();
  });

  it("waits for an explicit GitHub content choice after a new connection", async () => {
    const runtime = await testRuntime();
    const listed = await runtime.client.listExternalConnections();
    const template = listed.connections[0]!;
    const pending = {
      ...template,
      connect_url: "https://connect.example.test/github",
      id: "external-connection-github-new",
      identity_label: undefined,
      provider: "github" as const,
      status: "pending" as const,
    };
    const active = {
      ...pending,
      connect_url: undefined,
      identity_label: "@octocat",
      status: "active" as const,
    };
    vi.spyOn(runtime.client, "createExternalConnection").mockResolvedValue(
      pending,
    );
    vi.spyOn(runtime.client, "listExternalConnections")
      .mockResolvedValueOnce({ connections: listed.connections })
      .mockResolvedValue({ connections: [...listed.connections, active] });
    vi.spyOn(runtime.client, "listGitHubRepositories").mockResolvedValue({
      repositories: [],
    });
    const generate = vi
      .spyOn(runtime.client, "createPersonalProfileGeneration")
      .mockResolvedValue(generation);
    vi.spyOn(window, "open").mockReturnValue({
      close: vi.fn(),
      location: { replace: vi.fn() },
      opener: window,
    } as unknown as Window);
    renderProfile(runtime);

    await openAddSource();
    const dialog = await screen.findByRole("dialog", {
      name: "Add profile sources",
    });
    fireEvent.click(
      await within(dialog).findByRole("button", {
        name: "Choose GitHub",
      }),
    );

    expect(
      await within(dialog).findByText("GitHub repositories"),
    ).toBeVisible();
    expect(generate).not.toHaveBeenCalled();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Add GitHub profile" }),
    );
    await waitFor(() => expect(generate).toHaveBeenCalledOnce());
  });

  it("stacks connected sources first and grays out the ones to connect", async () => {
    const runtime = await testRuntime();
    const existing = (await runtime.client.listExternalConnections())
      .connections[0]!;
    vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
      connections: [
        {
          ...existing,
          id: "slack-expired",
          identity_label: "jenny@northstar",
          provider: "slack",
          status: "expired",
        },
        existing,
        {
          ...existing,
          id: "gmail-pending",
          identity_label: "pending@linger.test",
          status: "pending",
        },
        {
          ...existing,
          id: "github-duplicate",
          identity_label: "@duplicate",
          provider: "github",
          status: "failed",
          status_error_code: "duplicate_remote_principal",
        },
      ],
    });
    renderProfile(runtime);

    const sources = await screen.findByRole("list", {
      name: "Profile sources",
    });
    const names = [
      "Gmail · jenny@linger.test — connected",
      "Reconnect Slack",
      "Connect Discord",
      "Connect GitHub",
      "Connect Google Calendar",
      "Connect Notion",
      "Add source",
    ];
    await waitFor(() =>
      expect(
        within(sources)
          .getAllByRole("button")
          .map((button) => button.getAttribute("aria-label")),
      ).toEqual(names),
    );
    for (const button of within(sources).getAllByRole("button")) {
      expect(button.nextElementSibling).toHaveTextContent(
        button.getAttribute("aria-label")!,
      );
    }
    expect(
      within(sources)
        .getAllByTestId("source-logo")
        .map((logo) => logo.classList.contains("grayscale")),
    ).toEqual([false, true, true, true, true, true]);

    const details = screen.getByRole("complementary", {
      name: "Profile details",
    });
    expect(within(details).getByText("Sources")).toHaveAccessibleDescription(
      "Another Me learns from these to write this page",
    );
    expect(
      within(details).queryByRole("button", { name: /Manage/ }),
    ).not.toBeInTheDocument();
    expect(details).not.toHaveTextContent(/accounts? ·|needs reconnect/);
  });

  it("starts connecting a grayed-out app in Add source", async () => {
    const runtime = await testRuntime();
    const template = (await runtime.client.listExternalConnections())
      .connections[0]!;
    const create = vi
      .spyOn(runtime.client, "createExternalConnection")
      .mockResolvedValue({
        ...template,
        connect_url: "https://connect.example.test/notion",
        id: "external-connection-notion-new",
        identity_label: undefined,
        provider: "notion",
        status: "pending",
      });
    const open = vi.spyOn(window, "open").mockReturnValue({
      close: vi.fn(),
      location: { replace: vi.fn() },
      opener: window,
    } as unknown as Window);
    renderProfile(runtime);

    fireEvent.click(
      await screen.findByRole("button", { name: "Connect Notion" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Add profile sources" }),
    ).toBeVisible();
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0]?.[0]).toBe("notion");
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        "https://connect.example.test/notion",
        expect.any(String),
        expect.any(String),
      ),
    );
  });

  it("sends an expired app to Apps from Add source instead of connecting again", async () => {
    const runtime = await testRuntime();
    const existing = (await runtime.client.listExternalConnections())
      .connections[0]!;
    vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
      connections: [
        {
          ...existing,
          id: "slack-expired",
          provider: "slack",
          status: "expired",
        },
      ],
    });
    const create = vi.spyOn(runtime.client, "createExternalConnection");
    renderProfile(runtime);

    fireEvent.click(
      await screen.findByRole("button", { name: "Reconnect Slack" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Add profile sources",
    });
    expect(
      await within(dialog).findByRole("link", { name: "Open Apps" }),
    ).toHaveAttribute("href", "/t/tenant-northstar/apps?app=slack");
    expect(create).not.toHaveBeenCalled();
  });

  it("disconnects a connected account from its logo", async () => {
    const runtime = await testRuntime();
    const listed = await runtime.client.listExternalConnections();
    const list = vi
      .spyOn(runtime.client, "listExternalConnections")
      .mockResolvedValue(listed);
    const disconnect = vi
      .spyOn(runtime.client, "disconnectExternalConnection")
      .mockImplementation(async () => {
        list.mockResolvedValue({
          connections: listed.connections.filter(
            (connection) => connection.provider !== "gmail",
          ),
        });
        const gmail = listed.connections.find(
          (connection) => connection.provider === "gmail",
        )!;
        return { ...gmail, status: "disconnecting" as const };
      });
    renderProfile(runtime);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Gmail · jenny@linger.test — connected",
      }),
    );
    fireEvent.click(
      within(
        await screen.findByRole("dialog", { name: "Disconnect account?" }),
      ).getByRole("button", { name: "Disconnect" }),
    );
    await waitFor(() => expect(disconnect).toHaveBeenCalledOnce());
    expect(disconnect.mock.calls[0]?.[0]).toBe("external-connection-gmail");
    expect(
      await screen.findByRole("button", { name: "Connect Gmail" }),
    ).toBeInTheDocument();
  });

  it("shows one Add source pane at a time", async () => {
    const runtime = await testRuntime();
    renderProfile(runtime);

    await openAddSource();
    const dialog = await screen.findByRole("dialog", {
      name: "Add profile sources",
    });

    expect(
      await within(dialog).findByRole("button", {
        name: "Add Gmail",
      }),
    ).toBeVisible();
    expect(
      within(dialog).queryByRole("button", { name: /^Connect / }),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: "Choose files" }),
    ).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Files" }));
    expect(
      within(dialog).getByRole("button", { name: "Choose files" }),
    ).toBeVisible();
    expect(
      within(dialog).queryByRole("button", { name: "Add Gmail" }),
    ).not.toBeInTheDocument();
  });

  it("copies the external AI prompt and submits its summary for automatic Profile update", async () => {
    const runtime = await testRuntime();
    const generate = vi
      .spyOn(runtime.client, "createPersonalProfileGeneration")
      .mockResolvedValue(generation);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    renderProfile(runtime);

    await openAddSource();
    const dialog = await screen.findByRole("dialog", {
      name: "Add profile sources",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Another AI" }));

    const prompt = within(dialog).getByLabelText("Prompt to use");
    expect((prompt as HTMLTextAreaElement).value).toContain(
      "Based on our previous conversations",
    );
    const add = within(dialog).getByRole("button", { name: "Add" });
    expect(add).toBeDisabled();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Copy prompt" }),
    );
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        (prompt as HTMLTextAreaElement).value,
      ),
    );

    fireEvent.change(within(dialog).getByLabelText("AI summary"), {
      target: { value: "  I prefer concise written plans.  " },
    });
    expect(add).toBeEnabled();
    fireEvent.click(add);

    await waitFor(() => expect(generate).toHaveBeenCalledOnce());
    expect(generate.mock.calls[0]?.[1]).toEqual({
      sources: [
        {
          kind: "external_ai_summary",
          summary: "I prefer concise written plans.",
        },
      ],
    });
  });

  it("uploads More files to Wiki immediately and generates from input versions", async () => {
    const runtime = await testRuntime();
    // Profile sources consume only the input receipt of the upload.
    runtime.server.on(
      "POST",
      "/v0/tenants/{tenantId}/personal-wiki/documents/uploads",
      () =>
        Response.json(
          {
            ...runtime.seed.documents.values().next().value!,
            current_version: {
              id: "profile-input-1",
              sha256: "a".repeat(64),
              version_number: 1,
            },
            id: "profile-source-1",
            title: "resume.md",
          },
          { status: 201 },
        ),
    );
    const upload = vi.spyOn(runtime.client, "uploadPersonalWikiDocument");
    const generate = vi
      .spyOn(runtime.client, "createPersonalProfileGeneration")
      .mockResolvedValue(generation);
    renderProfile(runtime);

    await openAddSource();
    const dialog = await screen.findByRole("dialog", {
      name: "Add profile sources",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Files" }));
    fireEvent.change(within(dialog).getByLabelText("Profile files"), {
      target: {
        files: [new File(["# Resume"], "resume.md", { type: "text/markdown" })],
      },
    });
    expect(await within(dialog).findByText("resume.md")).toBeVisible();
    await waitFor(() => expect(upload).toHaveBeenCalledOnce());
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(generate).toHaveBeenCalledOnce());
    expect(generate.mock.calls[0]?.[1]).toEqual({
      sources: [
        {
          kind: "input_version",
          input_version_id: expect.any(String),
        },
      ],
    });
  });

  it("shows a permission error when Gmail authorization is insufficient", async () => {
    const runtime = await testRuntime();
    const listed = await runtime.client.listExternalConnections();
    const failed = {
      ...listed.connections[0]!,
      connect_url: "https://connect.example.test/gmail",
      id: "gmail-auth-failed",
      identity_label: undefined,
      provider: "gmail" as const,
      status: "failed" as const,
      status_error_code: "provider_auth_failed",
    };
    vi.spyOn(runtime.client, "createExternalConnection").mockResolvedValue({
      ...failed,
      status: "pending",
    });
    vi.spyOn(runtime.client, "listExternalConnections")
      .mockResolvedValueOnce({
        connections: listed.connections.filter(
          (connection) => connection.provider !== "gmail",
        ),
      })
      .mockResolvedValue({
        connections: listed.connections
          .filter((connection) => connection.provider !== "gmail")
          .concat(failed),
      });
    vi.spyOn(window, "open").mockReturnValue({
      close: vi.fn(),
      location: { replace: vi.fn() },
      opener: window,
    } as unknown as Window);

    renderProfile(runtime);
    await openAddSource();
    const dialog = await screen.findByRole("dialog", {
      name: "Add profile sources",
    });
    fireEvent.click(
      await within(dialog).findByRole("button", {
        name: "Add Gmail",
      }),
    );

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "This app did not grant enough permission. Reconnect and approve all requested access.",
    );
    expect(
      within(dialog).queryByText("Waiting for authorization"),
    ).not.toBeInTheDocument();
  });
});

async function testRuntime() {
  return createTestTeamHubRuntime();
}

function renderProfile(
  runtime: ReturnType<typeof createTestTeamHubRuntime>,
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  }),
) {
  render(
    <QueryClientProvider client={queryClient}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <RouterProvider
          router={createMemoryRouter(
            [
              {
                element: <WikiProfilePage />,
                path: "/t/:tenantId/library/wiki/profile",
              },
              { element: <h1>Apps</h1>, path: "/t/:tenantId/apps" },
            ],
            { initialEntries: ["/t/tenant-northstar/library/wiki/profile"] },
          )}
        />
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
  return { queryClient };
}

async function openAddSource() {
  fireEvent.click(await screen.findByRole("button", { name: "Add source" }));
}
