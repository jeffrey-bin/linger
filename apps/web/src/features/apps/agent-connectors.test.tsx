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
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { AgentConnectors } from "./agent-connectors";

async function fixture() {
  const runtime = createTestTeamHubRuntime();

  return runtime;
}

function mount(
  runtime: Awaited<ReturnType<typeof fixture>>,
  actorId = "actor-anotherme-jenny",
) {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TeamHubRuntimeProvider runtime={runtime}>
        <MemoryRouter>
          <AgentConnectors agentActorId={actorId} tenantId="tenant-northstar" />
        </MemoryRouter>
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
}

describe("Agent sidebar connectors", () => {
  it("saves access for only the selected connection and reads the confirmed grant back", async () => {
    const runtime = await fixture();
    const initial = await runtime.client.listExternalConnectionAgentAccess(
      "external-connection-gmail",
    );
    const revoked = { ...initial.agents[0]!, granted: false, revision: 2 };
    const readAccess = vi
      .spyOn(runtime.client, "listExternalConnectionAgentAccess")
      .mockResolvedValue(initial);
    const update = vi
      .spyOn(runtime.client, "setExternalConnectionAgentAccess")
      .mockResolvedValue(revoked);
    mount(runtime);
    const gmail = await screen.findByRole("region", { name: "Gmail" });
    const access = await within(gmail).findByRole("switch");
    expect(access).toBeChecked();
    readAccess.mockResolvedValue({ agents: [revoked] });
    fireEvent.click(access);
    await waitFor(() => expect(access).not.toBeChecked());
    expect(update).toHaveBeenCalledWith(
      "external-connection-gmail",
      "actor-anotherme-jenny",
      false,
    );
    readAccess.mockResolvedValue(initial);
    update.mockResolvedValue(initial.agents[0]!);
    fireEvent.click(access);
    await waitFor(() => expect(access).toBeChecked());
  });

  it("retains the last confirmed state after failure and retries the change", async () => {
    const runtime = await fixture();
    const initial = await runtime.client.listExternalConnectionAgentAccess(
      "external-connection-gmail",
    );
    const revoked = { ...initial.agents[0]!, granted: false, revision: 2 };
    const readAccess = vi
      .spyOn(runtime.client, "listExternalConnectionAgentAccess")
      .mockResolvedValue(initial);
    const update = vi
      .spyOn(runtime.client, "setExternalConnectionAgentAccess")
      .mockRejectedValueOnce(new Error("Connection unavailable; retry."))
      .mockResolvedValue(revoked);
    mount(runtime);
    const gmail = await screen.findByRole("region", { name: "Gmail" });
    const access = await within(gmail).findByRole("switch");
    fireEvent.click(access);
    expect(await within(gmail).findByRole("alert")).toHaveTextContent(
      "Connection unavailable",
    );
    expect(access).toBeChecked();
    readAccess.mockResolvedValue({ agents: [revoked] });
    fireEvent.click(access);
    await waitFor(() => expect(access).not.toBeChecked());
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("does not allow access when the server does not list this Agent as eligible", async () => {
    const runtime = await fixture();
    vi.spyOn(
      runtime.client,
      "listExternalConnectionAgentAccess",
    ).mockResolvedValue({ agents: [] });
    const update = vi.spyOn(runtime.client, "setExternalConnectionAgentAccess");
    mount(runtime, "actor-codex");
    const gmail = await screen.findByRole("region", { name: "Gmail" });
    const access = await within(gmail).findByRole("switch");
    expect(access).toBeDisabled();
    expect(gmail).toHaveTextContent("Access unavailable for this Agent");
    expect(update).not.toHaveBeenCalled();
    expect(
      screen.getByRole("link", { name: "Connect another app" }),
    ).toHaveAttribute("href", "/t/tenant-northstar/apps");
    expect(screen.queryByRole("region", { name: "Slack" })).toBeNull();
    expect(screen.queryByText("Not connected")).toBeNull();
  });
});
