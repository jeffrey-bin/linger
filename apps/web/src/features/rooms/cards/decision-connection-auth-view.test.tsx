import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { DecisionCard, type DecisionMessageCard } from "./decision-card";

type Card = DecisionMessageCard;
const card: Card = {
  card_type: "personal_notice",
  intent: "decision_requested",
  version: 1,
  decision_id: "auth-1",
  kind: "connection_auth",
  status: "pending",
  title: "Create a Notion page for this plan.",
  connection_auth: { app_key: "notion" },
  expires_at: "2999-01-01T00:00:00Z",
  decision_owner: { id: "alice", display_name: "Alice", kind: "human" },
  requester: {
    id: "writer",
    display_name: "Project Writer",
    kind: "agent",
  },
};
async function setup(
  next: Card = card,
  actorId = "alice",
  hasConnection = true,
  status: "active" | "pending" = "active",
) {
  const runtime = createTestTeamHubRuntime();

  const existing = (await runtime.client.listExternalConnections())
    .connections[0]!;
  const connection = {
    ...existing,
    id: "notion-1",
    provider: "notion" as const,
    identity_label: "Alice's Notion",
    status,
  };
  vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
    connections: hasConnection ? [connection] : [],
  });
  if (next.status === "authorizing")
    vi.spyOn(runtime.client, "getExternalConnection").mockResolvedValue({
      ...connection,
      status: "pending",
      connect_url: "https://connect.example.test/resume",
    });
  const decision = vi.fn().mockResolvedValue(undefined);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <DecisionCard
            tenantId="tenant_one"
            card={next}
            currentActorId={actorId}
            messageId="message-1"
            onDecision={decision}
            roomId="room-1"
          />
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { runtime, decision, connection };
}

describe("Chat connection authorization", () => {
  afterEach(() => vi.restoreAllMocks());

  it("asks explicit consent for the named general Agent and selected connection", async () => {
    const { decision } = await setup();
    expect(await screen.findByText("Notion")).toBeVisible();
    expect(screen.queryByText("Project Writer")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        level: 3,
        name: "Create a Notion page for this plan.",
      }),
    ).toBeVisible();
    expect(
      screen.getAllByText("Create a Notion page for this plan."),
    ).toHaveLength(1);
    expect(document.querySelector(".card-prompt")).toBeNull();
    expect(screen.queryByText(/Asks you|Authorizing/)).not.toBeInTheDocument();
    fireEvent.click(
      await screen.findByRole("button", { name: "Allow Project Writer" }),
    );
    await waitFor(() =>
      expect(decision).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: "approve",
          connectionId: "notion-1",
          requestId: "auth-1",
          expectedVersion: 1,
        }),
      ),
    );
  });

  it("shows a long agent prompt as the heading, never on a button", async () => {
    const prompt =
      "If you like, please authorize your Notion connection. Once authorized, I can read or act on only the pages or databases you name.";
    await setup({
      ...card,
      title: prompt,
      requester: {
        ...card.requester,
        display_name: "alex.doe's AnotherMe",
      },
    });
    expect(await screen.findByText("Notion")).toBeVisible();
    expect(screen.queryByText("alex.doe's AnotherMe")).not.toBeInTheDocument();
    const heading = screen.getByRole("heading", { level: 3, name: prompt });
    expect(heading).toHaveClass("[overflow-wrap:anywhere]");
    expect(screen.getAllByText(prompt)).toHaveLength(1);
    expect(document.querySelector(".card-prompt")).toBeNull();
    expect(
      await screen.findByRole("button", {
        name: "Allow alex.doe's AnotherMe",
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", {
        name: /Connect Notion and allow/,
      }),
    ).not.toBeInTheDocument();
  });

  it("does not let another Room member connect or grant", async () => {
    const { runtime } = await setup(card, "bob");
    expect(await screen.findByText("Notion")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /Allow|Connect|Not now|Cancel/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Only Alice|Waiting for Alice/),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "App authorization requested" }),
    ).toBeVisible();
    expect(runtime.client.listExternalConnections).not.toHaveBeenCalled();
  });

  it("lets the assignee dismiss the request without connecting", async () => {
    const { decision } = await setup();
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    await waitFor(() =>
      expect(decision).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: "deny",
          requestId: "auth-1",
          expectedVersion: 1,
        }),
      ),
    );
  });

  it("saves pending consent before opening OAuth and recovers a blocked popup", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const { runtime, decision, connection } = await setup(card, "alice", false);
    const create = vi
      .spyOn(runtime.client, "createExternalConnection")
      .mockResolvedValue({
        ...connection,
        status: "pending",
        connect_url: "https://connect.example.test/notion",
      });
    fireEvent.click(
      await screen.findByRole("button", { name: "Connect Notion" }),
    );
    await waitFor(() =>
      expect(decision).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: connection.id,
          decision: "approve",
        }),
      ),
    );
    expect(create).toHaveBeenCalledWith("notion");
    expect(
      await screen.findByRole("button", { name: "Open authorization window" }),
    ).toBeVisible();
  });

  it("starts a new authorization when the pending link expired", async () => {
    vi.spyOn(window, "open").mockReturnValue({
      opener: null,
    } as unknown as Window);
    const { runtime, decision, connection } = await setup(
      card,
      "alice",
      true,
      "pending",
    );
    vi.spyOn(runtime.client, "getExternalConnection").mockResolvedValue({
      ...connection,
      connect_url: "https://connect.example.test/expired",
      connect_expires_at: "2026-01-01T00:00:00Z",
    });
    const create = vi
      .spyOn(runtime.client, "createExternalConnection")
      .mockResolvedValue({
        ...connection,
        id: "notion-2",
        connect_url: "https://connect.example.test/notion",
      });
    fireEvent.click(
      await screen.findByRole("button", { name: "Connect Notion" }),
    );
    await waitFor(() =>
      expect(decision).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: "notion-2",
          decision: "approve",
        }),
      ),
    );
    expect(create).toHaveBeenCalledWith("notion");
    await waitFor(() =>
      expect(window.open).toHaveBeenCalledWith(
        "https://connect.example.test/notion",
        "linger_composio_oauth",
        expect.any(String),
      ),
    );
  });

  it("resumes a pending authorization while its link is open", async () => {
    vi.spyOn(window, "open").mockReturnValue({
      opener: null,
    } as unknown as Window);
    const { runtime, decision, connection } = await setup(
      card,
      "alice",
      true,
      "pending",
    );
    vi.spyOn(runtime.client, "getExternalConnection").mockResolvedValue({
      ...connection,
      connect_url: "https://connect.example.test/resume",
      connect_expires_at: "2999-01-01T00:00:00Z",
    });
    const create = vi.spyOn(runtime.client, "createExternalConnection");
    fireEvent.click(
      await screen.findByRole("button", { name: "Connect Notion" }),
    );
    await waitFor(() =>
      expect(window.open).toHaveBeenCalledWith(
        "https://connect.example.test/resume",
        "linger_composio_oauth",
        expect.any(String),
      ),
    );
    expect(decision).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: connection.id }),
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("navigates OAuth only after durable consent is accepted", async () => {
    vi.spyOn(window, "open").mockReturnValue({
      opener: null,
    } as unknown as Window);
    const { runtime, decision, connection } = await setup(card, "alice", false);
    vi.spyOn(runtime.client, "createExternalConnection").mockResolvedValue({
      ...connection,
      status: "pending",
      connect_url: "https://connect.example.test/notion",
    });
    let accept!: () => void;
    decision.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          accept = resolve;
        }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Connect Notion" }),
    );
    await waitFor(() => expect(decision).toHaveBeenCalledOnce());
    expect(window.open).not.toHaveBeenCalled();
    accept();
    await waitFor(() =>
      expect(window.open).toHaveBeenCalledWith(
        "https://connect.example.test/notion",
        "linger_composio_oauth",
        expect.stringContaining("width=560,height=720"),
      ),
    );
  });

  it("retains the server-bound connection and cancellation after reload", async () => {
    const pending: Card = {
      ...card,
      version: 2,
      status: "authorizing",
      connection_auth: { app_key: "notion", connection_id: "notion-1" },
      answer: { decision: "approve", connection_id: "notion-1" },
      decided_by: card.decision_owner,
      decided_at: "2026-09-14T00:00:00Z",
    };
    vi.spyOn(window, "open").mockReturnValue({
      opener: null,
    } as unknown as Window);
    const { decision } = await setup(pending);
    expect(await screen.findByText("Authorizing…")).toBeVisible();
    fireEvent.click(
      await screen.findByRole("button", { name: "Open authorization window" }),
    );
    expect(window.open).toHaveBeenCalledWith(
      "https://connect.example.test/resume",
      "linger_composio_oauth",
      expect.stringContaining("width=560,height=720"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(decision).toHaveBeenCalledWith(
        expect.objectContaining({ decision: "deny", expectedVersion: 2 }),
      ),
    );
  });

  it("puts a done line in place of the actions rather than accepting a client success claim", async () => {
    const complete: Card = {
      ...card,
      status: "succeeded",
      connection_auth: { app_key: "notion", connection_id: "notion-1" },
      decided_by: card.decision_owner,
      decided_at: "2026-09-14T00:00:00Z",
      answer: { decision: "approve", connection_id: "notion-1" },
    };
    await setup(complete);
    const box = await screen.findByRole("region", {
      name: "App authorization requested",
    });
    expect(box).toHaveTextContent("Notion");
    const line = screen.getByText("Connected");
    expect(line.closest("p")?.querySelector("svg")).toHaveClass(
      "text-app-success",
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it.each([
    ["denied", "Not connected", "text-app-muted"],
    ["failed", "Failed: the sign-in did not complete", "text-app-danger"],
    ["expired", "Expired", "text-app-muted"],
  ] as const)(
    "ends a %s authorization with its own done line",
    async (status, done, tone) => {
      await setup({ ...card, status, decided_by: card.decision_owner }, "bob");
      const line = await screen.findByText(done);
      expect(line.closest("p")?.querySelector("svg")).toHaveClass(tone);
      expect(screen.queryByText(/by Alice/)).not.toBeInTheDocument();
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    },
  );
});
