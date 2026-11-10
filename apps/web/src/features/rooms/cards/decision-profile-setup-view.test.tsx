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
import type { TestRouteHandler } from "@/test/teamhub-test-server";
import { TeamHubError } from "@/features/teamhub/teamhub-client";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubMessageAttachmentUpload } from "@/features/teamhub/teamhub-types";

import type { DecisionMessageCard } from "./decision-card";
import { ProfileSetupDecision } from "./decision-profile-setup-view";
import type { RoomCardDecision } from "./room-message-card-contract";

type Card = DecisionMessageCard;
interface SetupForm {
  apps?: string[];
  kind: "profile_setup_apps" | "profile_setup_sources";
  more_apps?: string[];
}

const owner = {
  display_name: "Jenny Bin",
  id: "actor-jenny",
  kind: "human" as const,
};

function setupCard(
  { kind, ...view }: SetupForm,
  resolved?: Card["answer"],
): Card {
  const base = {
    card_type: "personal_notice" as const,
    decision_id: "decision-setup",
    decision_owner: owner,
    intent: "decision_requested" as const,
    kind,
    profile_setup: view,
    requester: {
      display_name: "Another Me",
      id: "actor-delegate",
      kind: "agent" as const,
    },
    title: "Connect one account.",
  };
  return resolved
    ? {
        ...base,
        answer: resolved,
        decided_at: "2026-10-30T10:00:00Z",
        decided_by: owner,
        status: "answered",
        version: 2,
      }
    : { ...base, status: "pending", version: 3 };
}

const appsForm: SetupForm = {
  apps: ["gmail", "outlook", "google_calendar"],
  kind: "profile_setup_apps",
  more_apps: ["github"],
};
const sourcesForm: SetupForm = { kind: "profile_setup_sources" };

function renderCard(
  card: Card,
  {
    currentActorId = owner.id,
    onDecision = vi.fn<(decision: RoomCardDecision) => Promise<void>>(),
    runtime = createTestTeamHubRuntime(),
  } = {},
) {
  render(
    <MemoryRouter>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <TeamHubRuntimeProvider runtime={runtime}>
          <ProfileSetupDecision
            card={card}
            currentActorId={currentActorId}
            messageId="message-setup"
            onDecision={onDecision}
            roomId="room-another-me"
          />
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { onDecision, runtime };
}

function upload(id: string, filename: string): TeamHubMessageAttachmentUpload {
  return {
    created_at: "2026-10-30T10:00:00Z",
    expires_at: "2026-10-31T10:00:00Z",
    filename,
    id,
    media_type: "application/pdf",
    room_id: "room-another-me",
    sha256: "0".repeat(64),
    size_bytes: 2048,
    status: "available",
  };
}

describe("AnotherMe setup card prompt", () => {
  it.each([[appsForm], [sourcesForm]])(
    "shows the %j prompt as the box heading",
    async (form) => {
      renderCard(setupCard(form));

      const card = await screen.findByRole("region", {
        name: "AnotherMe setup",
      });
      expect(
        within(card).getByRole("heading", {
          level: 3,
          name: "Connect one account.",
        }),
      ).toBeVisible();
      expect(screen.getAllByText("Connect one account.")).toHaveLength(1);
      expect(document.querySelector(".card-prompt")).toBeNull();
      expect(screen.queryByText(/Asks you/)).toBeNull();
    },
  );

  it("shows anyone else no actions or copy", async () => {
    renderCard(setupCard(sourcesForm), { currentActorId: "actor-maya" });
    expect(await screen.findByText("Connect one account.")).toBeVisible();
    expect(screen.queryByText(/Waiting for Jenny Bin/)).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("AnotherMe apps setup card", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows the requested apps in order and keeps more apps behind More", async () => {
    renderCard(setupCard(appsForm));

    const list = await screen.findByRole("region", {
      name: "Connect your apps",
    });
    expect(await within(list).findByText("Gmail")).toBeVisible();
    expect(within(list).getByText("Outlook")).toBeVisible();
    expect(within(list).getByText("Google Calendar")).toBeVisible();
    expect(
      within(list)
        .getByText("Gmail")
        .compareDocumentPosition(within(list).getByText("Outlook")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      within(list)
        .getByText("Outlook")
        .compareDocumentPosition(within(list).getByText("Google Calendar")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // The Human's active Gmail connection shows its account label.
    expect(await within(list).findByText("jenny@linger.test")).toBeVisible();
    expect(within(list).queryByText("GitHub")).not.toBeInTheDocument();

    fireEvent.click(within(list).getByRole("button", { name: /More/ }));
    expect(within(list).getByText("GitHub")).toBeVisible();
    expect(within(list).queryByText("X")).not.toBeInTheDocument();
    expect(within(list).queryByText("LinkedIn")).not.toBeInTheDocument();
    expect(
      await within(list).findByRole("button", { name: "Connect GitHub" }),
    ).toBeEnabled();
  });

  it("uses only the apps supplied by the server", async () => {
    renderCard(
      setupCard({ ...appsForm, apps: ["outlook"], more_apps: ["github"] }),
    );
    const list = await screen.findByRole("region", {
      name: "Connect your apps",
    });
    expect(await within(list).findByText("Outlook")).toBeVisible();
    expect(within(list).queryByText("Gmail")).not.toBeInTheDocument();
    expect(within(list).queryByText("Google Calendar")).not.toBeInTheDocument();
    fireEvent.click(within(list).getByRole("button", { name: /More/ }));
    expect(within(list).getByText("GitHub")).toBeVisible();
  });

  it("connects an app through the shared Connectors flow", async () => {
    const runtime = createTestTeamHubRuntime();
    const pending = {
      ...(await runtime.client.listExternalConnections()).connections[0]!,
      provider: "github" as const,
      status: "pending" as const,
      connect_url: "https://connect.example.test/github",
    };
    const create = vi
      .spyOn(runtime.client, "createExternalConnection")
      .mockResolvedValue(pending);
    vi.spyOn(window, "open").mockReturnValue(null);
    renderCard(setupCard(appsForm), { runtime });

    fireEvent.click(await screen.findByRole("button", { name: /More/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Connect GitHub" }),
    );

    await waitFor(() => expect(create).toHaveBeenCalledWith("github"));
    expect(
      await screen.findByRole("button", { name: "Open authorization window" }),
    ).toBeVisible();
  });

  it("asks for the Composio key when the deployment has none", async () => {
    const runtime = createTestTeamHubRuntime();
    const catalog = await runtime.client.listExternalApps();
    vi.spyOn(runtime.client, "listExternalApps").mockResolvedValue({
      apps: catalog.apps.map((app) => ({
        ...app,
        availability: "unavailable",
      })),
      provider_configured: false,
      provider_key: { source: "none", can_save: true },
    });
    const create = vi.spyOn(runtime.client, "createExternalConnection");
    renderCard(setupCard(appsForm), { runtime });

    fireEvent.click(await screen.findByRole("button", { name: /More/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Connect GitHub" }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Connect GitHub",
    });
    expect(within(dialog).getByLabelText("Composio API key")).toBeVisible();
    expect(
      within(dialog).getByRole("link", { name: "Get a key" }),
    ).toBeVisible();
    expect(create).not.toHaveBeenCalled();
  });

  it("uses a newly saved Composio key for onboarding connections", async () => {
    const runtime = createTestTeamHubRuntime();
    const configuredCatalog = await runtime.client.listExternalApps();
    const list = vi
      .spyOn(runtime.client, "listExternalApps")
      .mockResolvedValue({
        ...configuredCatalog,
        apps: configuredCatalog.apps.map((app) => ({
          ...app,
          availability: "unavailable",
        })),
        provider_configured: false,
        provider_key: { source: "none", can_save: true },
      });
    vi.spyOn(runtime.client, "saveExternalProviderKey").mockImplementation(
      async () => {
        list.mockResolvedValue(configuredCatalog);
        return { source: "stored", can_save: true };
      },
    );
    const pending = {
      ...(await runtime.client.listExternalConnections()).connections[0]!,
      provider: "github" as const,
      status: "pending" as const,
      connect_url: "https://connect.example.test/github",
    };
    const create = vi
      .spyOn(runtime.client, "createExternalConnection")
      .mockResolvedValue(pending);
    vi.spyOn(window, "open").mockReturnValue(null);
    renderCard(setupCard(appsForm), { runtime });
    fireEvent.click(await screen.findByRole("button", { name: /More/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Connect GitHub" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Connect GitHub",
    });
    fireEvent.change(within(dialog).getByLabelText("Composio API key"), {
      target: { value: "test-key" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save key" }));
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Connect GitHub" }),
    );
    await waitFor(() => expect(create).toHaveBeenCalledWith("github"));
    expect(
      await screen.findByRole("button", { name: "Open authorization window" }),
    ).toBeVisible();
    expect(screen.queryByLabelText("Composio API key")).not.toBeInTheDocument();
  });

  it("shows a connection permission failure without asking for the key again", async () => {
    const runtime = createTestTeamHubRuntime();
    vi.spyOn(runtime.client, "createExternalConnection").mockRejectedValue(
      new TeamHubError({
        code: "COMPOSIO_CONNECTION_FORBIDDEN",
        message:
          "Composio denied this connection. Check the saved API key permissions.",
        status: 403,
      }),
    );
    renderCard(setupCard(appsForm), { runtime });
    fireEvent.click(await screen.findByRole("button", { name: /More/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Connect GitHub" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Check the saved API key permissions",
    );
    expect(screen.queryByLabelText("Composio API key")).not.toBeInTheDocument();
  });

  it("shows when an authorized connection is still being verified", async () => {
    const runtime = createTestTeamHubRuntime();
    const current = await runtime.client.listExternalConnections();
    vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
      connections: current.connections.map((connection) =>
        connection.provider === "gmail"
          ? {
              ...connection,
              status: "pending",
              status_error_code: "provider_identity_unavailable",
            }
          : connection,
      ),
    });
    renderCard(setupCard(appsForm), { runtime });
    expect(await screen.findByText("Verifying connection…")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Connect Gmail" })).toBeNull();
  });

  it("submits Connected and Skip for now with the card version", async () => {
    const { onDecision } = renderCard(setupCard(appsForm));

    fireEvent.click(await screen.findByRole("button", { name: "Connected" }));
    await waitFor(() =>
      expect(onDecision).toHaveBeenCalledWith({
        decision: "connected",
        expectedVersion: 3,
        messageId: "message-setup",
        requestId: "decision-setup",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    await waitFor(() =>
      expect(onDecision).toHaveBeenLastCalledWith(
        expect.objectContaining({ decision: "skipped", expectedVersion: 3 }),
      ),
    );
  });

  it.each([
    [{ decision: "skipped" as const }, "Skipped", "text-app-muted"],
    [{ decision: "connected" as const }, "Connected", "text-app-success"],
  ])(
    "puts a done line in place of the replies: %j",
    async (answer, done, tone) => {
      renderCard(setupCard(appsForm, answer));

      const line = await screen.findByText(done);
      expect(line.closest("p")?.querySelector("svg")).toHaveClass(tone);
      const list = screen.getByRole("region", { name: "Connect your apps" });
      expect(await within(list).findByText("Gmail")).toBeVisible();
      expect(screen.queryAllByRole("button")).toEqual([]);
      expect(screen.queryByText(/asked Jenny Bin/)).toBeNull();
    },
  );

  it("ends an expired card with one Expired line", async () => {
    renderCard({ ...setupCard(appsForm), status: "expired" });
    const line = await screen.findByText("Expired");
    expect(line.closest("p")?.querySelector("svg")).toHaveClass(
      "text-app-muted",
    );
    expect(screen.getAllByText(/Expired/)).toHaveLength(1);
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  it("is read-only for anyone but the assignee", async () => {
    renderCard(setupCard(appsForm), { currentActorId: "actor-maya" });

    await screen.findByRole("region", { name: "Connect your apps" });
    expect(screen.queryByRole("button", { name: "Connected" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Connect / })).toBeNull();
  });
});

describe("AnotherMe sources setup card", () => {
  afterEach(() => vi.restoreAllMocks());

  function addLink(value: string) {
    const input = screen.getByRole("textbox", { name: "Paste a link" });
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: "Enter" });
  }

  it("adds valid links and rejects invalid, duplicate and extra ones", async () => {
    const { onDecision } = renderCard(setupCard(sourcesForm));
    await screen.findByRole("textbox", { name: "Paste a link" });

    addLink("jenny.example");
    expect(screen.getByRole("alert")).toHaveTextContent("http:// or https://");
    addLink("ftp://jenny.example");
    expect(screen.getByRole("alert")).toHaveTextContent("http:// or https://");
    addLink(" https://jenny.example ");
    expect(screen.getByText("jenny.example")).toBeVisible();
    addLink("https://jenny.example");
    expect(screen.getByRole("alert")).toHaveTextContent("already added");
    for (const n of [2, 3, 4, 5]) addLink(`https://jenny.example/${n}`);
    addLink("https://jenny.example/6");
    expect(screen.getByRole("alert")).toHaveTextContent("up to 5 links");
    expect(screen.queryByText("jenny.example/6")).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Paste a link" }), {
      target: { value: "" },
    });

    fireEvent.click(screen.getByRole("button", { name: "That's all" }));
    await waitFor(() =>
      expect(onDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          attachmentUploadIds: [],
          decision: "done",
          links: [
            "https://jenny.example",
            "https://jenny.example/2",
            "https://jenny.example/3",
            "https://jenny.example/4",
            "https://jenny.example/5",
          ],
        }),
      ),
    );
  });

  it("makes added links removable and includes a pasted draft on submission", async () => {
    const { onDecision } = renderCard(setupCard(sourcesForm));
    const input = await screen.findByRole("textbox", { name: "Paste a link" });
    fireEvent.change(input, { target: { value: "https://example.com/first" } });
    fireEvent.click(screen.getByRole("button", { name: "Add link" }));
    expect(screen.getByText("Added")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Select That's all");
    fireEvent.click(
      screen.getByRole("button", { name: "Remove https://example.com/first" }),
    );
    fireEvent.change(input, {
      target: { value: "https://example.com/second" },
    });
    fireEvent.click(screen.getByRole("button", { name: "That's all" }));
    await waitFor(() =>
      expect(onDecision).toHaveBeenCalledWith(
        expect.objectContaining({ links: ["https://example.com/second"] }),
      ),
    );
  });

  it("does not submit an invalid pasted draft", async () => {
    const { onDecision } = renderCard(setupCard(sourcesForm));
    const input = await screen.findByRole("textbox", { name: "Paste a link" });
    fireEvent.change(input, { target: { value: "not a link" } });
    fireEvent.click(screen.getByRole("button", { name: "That's all" }));
    expect(screen.getByRole("alert")).toHaveTextContent("http:// or https://");
    expect(onDecision).not.toHaveBeenCalled();
  });

  it("uploads files, cancels a removed one and sends the rest", async () => {
    const runtime = createTestTeamHubRuntime();
    const resolvers: Array<(value: TeamHubMessageAttachmentUpload) => void> =
      [];
    const uploadFile = vi
      .spyOn(runtime.client, "uploadMessageAttachment")
      .mockImplementation(
        () => new Promise((resolve) => resolvers.push(resolve)),
      );
    const cancel = vi.fn<TestRouteHandler>(() => undefined);
    runtime.server.on(
      "DELETE",
      "/v0/rooms/{roomId}/message-attachment-uploads/{attachmentUploadId}",
      cancel,
    );
    const { onDecision } = renderCard(setupCard(sourcesForm), { runtime });

    fireEvent.change(
      await screen.findByLabelText("Upload files", { selector: "input" }),
      {
        target: {
          files: [
            new File(["a"], "resume.pdf", { type: "application/pdf" }),
            new File(["b"], "portfolio.pdf", { type: "application/pdf" }),
          ],
        },
      },
    );
    expect(uploadFile).toHaveBeenCalledTimes(2);
    expect(uploadFile).toHaveBeenCalledWith(
      "room-another-me",
      expect.any(File),
      expect.any(String),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(uploadFile.mock.calls[0]![2]).not.toBe(uploadFile.mock.calls[1]![2]);
    expect(screen.getByRole("button", { name: "That's all" })).toBeDisabled();

    resolvers[0]!(upload("upload-resume", "resume.pdf"));
    resolvers[1]!(upload("upload-portfolio", "portfolio.pdf"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "That's all" })).toBeEnabled(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Remove portfolio.pdf" }),
    );
    await waitFor(() =>
      expect(cancel).toHaveBeenCalledWith(
        expect.objectContaining({
          params: {
            attachmentUploadId: "upload-portfolio",
            roomId: "room-another-me",
          },
        }),
      ),
    );
    expect(screen.queryByText("portfolio.pdf")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "That's all" }));
    await waitFor(() =>
      expect(onDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          attachmentUploadIds: ["upload-resume"],
          decision: "done",
          links: [],
        }),
      ),
    );
  });

  it("prevents submission until a failed upload is removed", async () => {
    const runtime = createTestTeamHubRuntime();
    vi.spyOn(runtime.client, "uploadMessageAttachment").mockRejectedValue(
      new Error("Upload failed"),
    );
    renderCard(setupCard(sourcesForm), { runtime });
    fireEvent.change(
      await screen.findByLabelText("Upload files", { selector: "input" }),
      {
        target: { files: [new File(["a"], "resume.pdf")] },
      },
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Upload failed");
    expect(screen.getByRole("button", { name: "That's all" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Remove resume.pdf" }));
    expect(screen.getByRole("button", { name: "That's all" })).toBeEnabled();
  });

  it("skips without any items", async () => {
    const { onDecision } = renderCard(setupCard(sourcesForm));
    await screen.findByRole("textbox", { name: "Paste a link" });
    addLink("https://jenny.example");

    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() =>
      expect(onDecision).toHaveBeenCalledWith({
        decision: "skipped",
        expectedVersion: 3,
        messageId: "message-setup",
        requestId: "decision-setup",
      }),
    );
  });

  it("explains an unavailable upload and keeps the items", async () => {
    const onDecision = vi.fn().mockRejectedValue(
      new TeamHubError({
        code: "ATTACHMENT_UPLOAD_UNAVAILABLE",
        message: "Attachment upload is unavailable.",
        status: 409,
      }),
    );
    renderCard(setupCard(sourcesForm), { onDecision });
    await screen.findByRole("textbox", { name: "Paste a link" });
    addLink("https://jenny.example");

    fireEvent.click(screen.getByRole("button", { name: "That's all" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A file is no longer available",
    );
    expect(screen.getByText("jenny.example")).toBeVisible();
  });

  it("lists what a shared card shared above its done line", async () => {
    renderCard(
      setupCard(sourcesForm, {
        attachment_upload_ids: ["upload-1", "upload-2"],
        decision: "done",
        links: ["https://jenny.example/work"],
      }),
    );

    const line = await screen.findByText("Shared 1 link and 2 files");
    expect(line.closest("p")?.querySelector("svg")).toHaveClass(
      "text-app-success",
    );
    const shared = screen.getByRole("region", { name: "Shared sources" });
    expect(within(shared).getByText("jenny.example/work")).toBeVisible();
    expect(within(shared).getByText("2 files")).toBeVisible();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  it("ends a skipped sources card with its done line", async () => {
    renderCard(setupCard(sourcesForm, { decision: "skipped" }));
    const line = await screen.findByText("Skipped");
    expect(line.closest("p")?.querySelector("svg")).toHaveClass(
      "text-app-muted",
    );
    expect(screen.queryByRole("region", { name: "Shared sources" })).toBeNull();
    expect(screen.queryAllByRole("button")).toEqual([]);
  });
});
