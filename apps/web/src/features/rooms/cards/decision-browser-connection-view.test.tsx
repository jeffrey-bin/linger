import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";

import { DecisionCard, type DecisionMessageCard } from "./decision-card";
import { createTeamHubApi } from "@/features/teamhub/teamhub-api";
import { fetchDouble } from "@/features/teamhub/teamhub-client-test-support";

type Card = DecisionMessageCard;
const card: Card = {
  card_type: "personal_notice",
  intent: "decision_requested",
  version: 1,
  decision_id: "browser-1",
  kind: "browser_connection",
  status: "pending",
  title: "Please connect your everyday Chrome.",
  browser_connection: { computer_id: "computer-mac" },
  decision_owner: { id: "alice", display_name: "Alice", kind: "human" },
  requester: { id: "writer", display_name: "Writer", kind: "agent" },
};
const connected: Card = {
  ...card,
  status: "answered",
  answer: { decision: "connected" },
  decided_by: card.decision_owner,
  decided_at: "2026-11-03T10:00:00Z",
};

function setup(next: Card = card, actorId = "alice") {
  const request = vi.fn(async (path: string) => {
    if (
      path !==
      "/v0/tenants/tenant_one/local-computers/computer-mac/browser-connection"
    )
      throw new Error(path);
    return { mode: "isolated", platform: "darwin", state: "not_connected" };
  });
  const api = createTeamHubApi({
    baseUrl: new URL("https://teamhub.test/"),
    fetchRequest: fetchDouble(async (url) =>
      Response.json(await request(new URL(url).pathname)),
    ),
    onAuthenticationRequired: vi.fn(),
  });
  const client = {
    listTenantLocalComputers: vi.fn().mockResolvedValue({
      items: [
        {
          computer_id: "computer-other",
          display_name: "Other PC",
          status: "online",
        },
        {
          computer_id: "computer-mac",
          display_name: "Alice's Mac",
          status: "online",
        },
      ],
    }),
    api,
  };
  const decision = vi.fn().mockResolvedValue(undefined);
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TeamHubRuntimeProvider runtime={{ client } as never}>
        <DecisionCard
          card={next}
          currentActorId={actorId}
          messageId="message-1"
          onDecision={decision}
          roomId="room-1"
          tenantId="tenant_one"
        />
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
  return { decision, request };
}

describe("Browser connection card", () => {
  it("opens the connection dialog locked to the card's Computer", async () => {
    const { request } = setup();
    const box = await screen.findByRole("region", {
      name: "Browser connection requested",
    });
    expect(
      within(box).getByRole("heading", {
        level: 3,
        name: "Please connect your everyday Chrome.",
      }),
    ).toBeVisible();
    expect(
      screen.getAllByText("Please connect your everyday Chrome."),
    ).toHaveLength(1);
    expect(document.querySelector(".card-prompt")).toBeNull();
    expect(box).toHaveTextContent("Everyday Chrome");
    expect(screen.getByRole("button", { name: "Not now" })).toHaveClass(
      "bg-secondary",
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("Alice's Mac")).toBeVisible();
    expect(
      screen.queryByRole("combobox", { name: "Computer" }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(request).toHaveBeenCalled());
  });

  it("declines with a deny decision", async () => {
    const { decision } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    await waitFor(() =>
      expect(decision).toHaveBeenCalledWith({
        decision: "deny",
        expectedVersion: 1,
        messageId: "message-1",
        requestId: "browser-1",
      }),
    );
  });

  it("shows other members the box without actions or copy", async () => {
    setup(card, "bob");
    expect(
      await screen.findByRole("region", {
        name: "Browser connection requested",
      }),
    ).toBeVisible();
    expect(screen.queryByText(/Waiting for Alice/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it.each([
    [connected, "Connected", "text-app-success"],
    [
      { ...connected, status: "denied", answer: { decision: "deny" } },
      "Not connected",
      "text-app-muted",
    ],
    [{ ...card, status: "expired" }, "Expired", "text-app-muted"],
    [
      { ...card, status: "failed" },
      "Failed: the connection did not complete",
      "text-app-danger",
    ],
  ] as const)(
    "puts a done line in place of the actions: %#",
    async (settled, done, tone) => {
      setup(settled);
      const line = await screen.findByText(done);
      expect(line.closest("p")?.querySelector("svg")).toHaveClass(tone);
      expect(
        screen.getByRole("region", { name: "Browser connection requested" }),
      ).toHaveTextContent("Everyday Chrome");
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    },
  );
});
