import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  acceptTenantAgentUpdates,
  createTestTeamHubRuntime,
  type TestTeamHubRuntime,
} from "@/test/teamhub-test-runtime";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";

import { ActorAvatarImageProvider } from "./actor-avatar-image";

import { GENERAL_AGENT_INSTRUCTIONS } from "../general-agent-defaults";
import { UNSET_AGENT_INSTRUCTIONS } from "./agent-instruction-text";
import { EditAgentProfileDialog } from "./edit-agent-profile-dialog";
import { EditAgentInstructionsDialog } from "./edit-agent-instructions-dialog";

const actor = {
  id: "agent-instructions",
  kind: "agent" as const,
  display_name: "Sinclair",
  tenant_id: "tenant",
  created_at: "2026-09-20T00:00:00Z",
};
const defaults = {
  actor,
  canEdit: true,
  instructions: "Original instructions.",
  isPending: false,
  onClose: vi.fn(),
  onSave: vi.fn(),
};

describe("Agent instructions editing", () => {
  it("submits the edited instructions with formatting and keeps the draft after a failed save", () => {
    const onSave = vi.fn();
    const { rerender } = render(
      <EditAgentInstructionsDialog {...defaults} onSave={onSave} />,
    );
    expect(
      screen.queryByRole("textbox", { name: "Agent name" }),
    ).not.toBeInTheDocument();
    const instructions = screen.getByRole("textbox", {
      name: "Agent instructions",
    });
    fireEvent.change(instructions, {
      target: { value: "  Answer clearly.\nUse concise examples.\n" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({
      instructions: "  Answer clearly.\nUse concise examples.\n",
    });
    rerender(
      <EditAgentInstructionsDialog
        {...defaults}
        onSave={onSave}
        error="Save failed. Try again."
      />,
    );
    expect(instructions).toHaveValue(
      "  Answer clearly.\nUse concise examples.\n",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Save failed");
  });
  it("keeps the unset hint out of the instruction text", () => {
    const onSave = vi.fn();
    render(
      <EditAgentInstructionsDialog
        {...defaults}
        instructions={GENERAL_AGENT_INSTRUCTIONS}
        onSave={onSave}
      />,
    );
    const instructions = screen.getByRole("textbox", {
      name: "Agent instructions",
    });
    expect(instructions).toHaveValue("");
    expect(instructions).toHaveAttribute(
      "placeholder",
      UNSET_AGENT_INSTRUCTIONS,
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
  });
  it("does not save empty instructions or a canceled edit", () => {
    const onSave = vi.fn(),
      onClose = vi.fn();
    render(
      <EditAgentInstructionsDialog
        {...defaults}
        onSave={onSave}
        onClose={onClose}
      />,
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Agent instructions" }),
      { target: { value: " \n " } },
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });
  it.each([{ canEdit: false }, { isPending: true }])(
    "prevents editing when unavailable: %j",
    (props) => {
      render(<EditAgentInstructionsDialog {...defaults} {...props} />);
      expect(
        screen.getByRole("textbox", { name: "Agent instructions" }),
      ).toBeDisabled();
      const save = screen.queryByRole("button", { name: /Save|Saving/ });
      if (save) expect(save).toBeDisabled();
    },
  );
});

describe("Agent profile editing", () => {
  it("only displays and saves the name and avatar", () => {
    const onSave = vi.fn();
    renderWithRuntime(
      <EditAgentProfileDialog
        actor={actor}
        canEdit
        isPending={false}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    );
    expect(
      screen.queryByRole("textbox", { name: "Agent instructions" }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Agent name" }), {
      target: { value: "  New name  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({ name: "New name" });
  });

  it("saves the avatar through TeamHub", async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    const { runtime } = renderWithRuntime(
      <EditAgentProfileDialog
        actor={actor}
        canEdit
        isPending={false}
        onClose={onClose}
        onSave={onSave}
      />,
    );
    const updateAvatar = vi.fn(() => ({}));
    runtime.server.on(
      "PUT",
      "/v0/tenants/{tenantId}/agents/{agentId}/avatar",
      updateAvatar,
    );

    fireEvent.keyDown(
      screen.getByRole("slider", { name: "Avatar background color hue" }),
      {
        key: "ArrowRight",
        shiftKey: true,
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    // A recolored character has no picture to send or remove.
    expect(updateAvatar).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { tenantId: actor.tenant_id, agentId: actor.id },
        body: {
          avatar_key: expect.stringMatching(/^figure:[a-z_]+:[0-9A-F]{6}$/),
        },
      }),
    );
    // The name did not change, so the profile update isn't sent.
    expect(onSave).not.toHaveBeenCalled();
  });

  it("shows only avatar controls when renaming is not allowed", async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    const { runtime } = renderWithRuntime(
      <EditAgentProfileDialog
        actor={actor}
        canEdit
        canEditName={false}
        isPending={false}
        onClose={onClose}
        onSave={onSave}
      />,
    );
    const updateAvatar = vi.fn(() => ({}));
    runtime.server.on(
      "PUT",
      "/v0/tenants/{tenantId}/agents/{agentId}/avatar",
      updateAvatar,
    );

    expect(screen.getByText("Update your Agent's avatar.")).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Agent name" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Edit agent name" }),
    ).not.toBeInTheDocument();
    fireEvent.keyDown(
      screen.getByRole("slider", { name: "Avatar background color hue" }),
      { key: "ArrowRight", shiftKey: true },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(updateAvatar).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe("Agent avatar upload", () => {
  it("keeps Edit profile open when the file picker is dismissed", () => {
    const onClose = vi.fn();
    renderWithRuntime(
      <EditAgentProfileDialog
        actor={actor}
        canEdit
        isPending={false}
        onClose={onClose}
        onSave={vi.fn()}
      />,
    );
    const file = screen.getByLabelText("Avatar image file");
    // Browsers fire a bubbling "cancel" on the input when the picker closes.
    file.dispatchEvent(new Event("cancel", { bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Edit profile" })).toBeVisible();
  });
});

describe("Agent avatar record loading", () => {
  it("follows TeamHub's avatar when it loads after the dialog opens", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptTenantAgentUpdates(runtime);

    const identity = runtime.seed.identity;
    const tenantId = identity.actors[0]!.tenant_id;
    const agents = await readTenantAgents(runtime, tenantId);
    const codex = agents.items.find(
      (agent) => agent.created_by.id === identity.actors[0]!.id,
    )!;
    await savePictureAvatar(runtime, tenantId, codex.actor.id);
    const avatarWrites = runtime.server.requestsTo(
      "PUT",
      "/v0/tenants/{tenantId}/agents/{agentId}/avatar",
    ).length;
    const onSave = vi.fn();
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <TeamHubRuntimeProvider runtime={runtime}>
          <ActorAvatarImageProvider identity={identity} tenantId={tenantId}>
            <EditAgentProfileDialog
              actor={codex.actor}
              canEdit
              isPending={false}
              onClose={vi.fn()}
              onSave={onSave}
            />
          </ActorAvatarImageProvider>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );

    // The record arrives after the dialog opened; the preview follows it.
    const hero = screen.getByTestId("agent-avatar-hero");
    await waitFor(() =>
      expect(hero.querySelector("img")).toHaveAttribute(
        "src",
        "data:image/png;base64,AAAA",
      ),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Agent name" }), {
      target: { value: "Renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith({ name: "Renamed" });
    // An untouched avatar is never written back over the saved one.
    expect(
      runtime.server.requestsTo(
        "PUT",
        "/v0/tenants/{tenantId}/agents/{agentId}/avatar",
      ),
    ).toHaveLength(avatarWrites);
  });

  it("recolors a saved picture without resending it", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptTenantAgentUpdates(runtime);

    const identity = runtime.seed.identity;
    const tenantId = identity.actors[0]!.tenant_id;
    const codex = (await readTenantAgents(runtime, tenantId)).items.find(
      (agent) => agent.created_by.id === identity.actors[0]!.id,
    )!;
    // TeamHub hands the picture back by URL, which it would not accept as input.
    await savePictureAvatar(runtime, tenantId, codex.actor.id);
    const updateAvatar = vi.fn(() => ({}));
    runtime.server.on(
      "PUT",
      "/v0/tenants/{tenantId}/agents/{agentId}/avatar",
      updateAvatar,
    );
    const onClose = vi.fn();
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <TeamHubRuntimeProvider runtime={runtime}>
          <ActorAvatarImageProvider identity={identity} tenantId={tenantId}>
            <EditAgentProfileDialog
              actor={codex.actor}
              canEdit
              isPending={false}
              onClose={onClose}
              onSave={vi.fn()}
            />
          </ActorAvatarImageProvider>
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("agent-avatar-hero").querySelector("img"),
      ).toHaveAttribute("src", "data:image/png;base64,AAAA"),
    );
    fireEvent.keyDown(
      screen.getByRole("slider", {
        name: "Avatar background color saturation and brightness",
      }),
      { key: "ArrowDown", shiftKey: true },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(updateAvatar).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { tenantId, agentId: codex.actor.id },
        body: { avatar_key: expect.stringMatching(/^image:[0-9A-F]{6}$/) },
      }),
    );
  });
});

function renderWithRuntime(ui: ReactElement) {
  const runtime = createTestTeamHubRuntime();
  acceptTenantAgentUpdates(runtime);
  const view = render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TeamHubRuntimeProvider runtime={runtime}>{ui}</TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
  return { ...view, runtime };
}

function readTenantAgents(runtime: TestTeamHubRuntime, tenantId: string) {
  return teamHubData(
    runtime.client.api.GET("/v0/tenants/{tenantId}/agents", {
      params: { path: { tenantId } },
    }),
  );
}

function savePictureAvatar(
  runtime: TestTeamHubRuntime,
  tenantId: string,
  agentId: string,
) {
  return teamHubData(
    runtime.client.api.PUT("/v0/tenants/{tenantId}/agents/{agentId}/avatar", {
      params: { path: { tenantId, agentId } },
      body: {
        avatar_image: "data:image/png;base64,AAAA",
        avatar_key: "image:112233",
      },
    }),
  );
}
