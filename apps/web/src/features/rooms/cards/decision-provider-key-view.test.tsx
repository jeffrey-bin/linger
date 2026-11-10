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

const card: DecisionMessageCard = {
  card_type: "personal_notice",
  intent: "decision_requested",
  version: 1,
  decision_id: "key-1",
  kind: "provider_key",
  status: "pending",
  title:
    "Please add a Composio API key so I can connect higgsfield. Every connected app needs it.",
  provider_key: { app_key: "higgsfield" },
  decision_owner: { id: "alice", display_name: "Alice", kind: "human" },
  requester: { id: "writer", display_name: "Writer", kind: "agent" },
};

function setup(
  next: DecisionMessageCard = card,
  actorId = "alice",
  canSave = true,
) {
  const client = {
    listExternalApps: vi.fn().mockResolvedValue({
      apps: [],
      provider_configured: false,
      provider_key: { source: "none", can_save: canSave },
    }),
    saveExternalProviderKey: vi
      .fn()
      .mockResolvedValue({ source: "saved", can_save: true }),
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
  return { client, decision };
}

describe("Composio key card", () => {
  it("saves the key from its dialog without answering the card itself", async () => {
    const { client, decision } = setup();
    const box = await screen.findByRole("region", {
      name: "Composio API key requested",
    });
    expect(box).toHaveTextContent("Needed to connect Higgsfield");
    fireEvent.click(within(box).getByRole("button", { name: "Add key" }));
    fireEvent.change(await screen.findByLabelText("Composio API key"), {
      target: { value: " ak_secret " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    await waitFor(() =>
      expect(client.saveExternalProviderKey).toHaveBeenCalledWith("ak_secret"),
    );
    await waitFor(() =>
      expect(
        screen.queryByLabelText("Composio API key"),
      ).not.toBeInTheDocument(),
    );
    expect(decision).not.toHaveBeenCalled();
  });

  it("asks for the key for every app when the command named none", async () => {
    setup({ ...card, provider_key: {} });
    expect(
      await screen.findByRole("region", { name: "Composio API key requested" }),
    ).toHaveTextContent("Every connected app needs it");
  });

  it("tells the owner how to set the key when TeamHub cannot store one", async () => {
    setup(card, "alice", false);
    fireEvent.click(await screen.findByRole("button", { name: "Add key" }));
    expect(await screen.findByText(/COMPOSIO_API_KEY/)).toBeVisible();
    expect(screen.queryByLabelText("Composio API key")).not.toBeInTheDocument();
  });

  it("declines with a deny decision", async () => {
    const { decision } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    await waitFor(() =>
      expect(decision).toHaveBeenCalledWith({
        decision: "deny",
        expectedVersion: 1,
        messageId: "message-1",
        requestId: "key-1",
      }),
    );
  });

  it("shows other members the box without actions", async () => {
    setup(card, "bob");
    expect(
      await screen.findByRole("region", { name: "Composio API key requested" }),
    ).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it.each([
    [
      {
        ...card,
        status: "answered",
        answer: { decision: "configured" },
        decided_by: card.decision_owner,
        decided_at: "2026-11-09T10:00:00Z",
      },
      "Key added",
    ],
    [
      {
        ...card,
        status: "denied",
        answer: { decision: "deny" },
        decided_by: card.decision_owner,
        decided_at: "2026-11-09T10:00:00Z",
      },
      "No key added",
    ],
  ] as const)(
    "puts a done line in place of the actions: %#",
    async (settled, done) => {
      setup(settled);
      expect(await screen.findByText(done)).toBeVisible();
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    },
  );
});
