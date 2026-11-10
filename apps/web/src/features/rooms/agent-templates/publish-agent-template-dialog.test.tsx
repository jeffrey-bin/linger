import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";

import { agentTemplateFromAgent } from "./agent-template";
import { PublishAgentTemplateDialog } from "./publish-agent-template-dialog";

it("publishes the Agent's portable template under the edited name", async () => {
  const runtime = createTestTeamHubRuntime();
  const registration = runtime.seed.tenantAgents.find(
    (agent) => agent.actor.display_name === "Codex",
  )!;
  const publish = vi.fn(({ body }: { body: unknown }) => ({
    ...(body as object),
    created_at: "2026-10-15T00:00:00Z",
    origin: "published",
    routines: [],
    template_id: "template-published",
    updated_at: "2026-10-15T00:00:00Z",
  }));
  runtime.server.on("POST", "/v0/tenants/{tenantId}/agent-templates", publish);
  const onClose = vi.fn();
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TeamHubRuntimeProvider runtime={runtime}>
        <PublishAgentTemplateDialog
          onClose={onClose}
          registration={registration}
          tenantId="tenant-northstar"
        />
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );

  fireEvent.change(screen.getByLabelText("Template name"), {
    target: { value: "  Reviewer  " },
  });
  const submit = screen.getByRole("button", { name: "Publish" });
  await waitFor(() => expect(submit).toBeEnabled());
  fireEvent.click(submit);

  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(publish).toHaveBeenCalledWith(
    expect.objectContaining({
      body: { ...agentTemplateFromAgent(registration), name: "Reviewer" },
      params: { tenantId: "tenant-northstar" },
    }),
  );
});
