import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type {
  TeamHubLocalComputerPage,
  TeamHubTenantAgent,
} from "@/features/teamhub/teamhub-types";

import { OFFLINE_COMPUTER_HINT } from "./agent-move-target";
import {
  agentMoveHint,
  type AgentRuntimeField,
  EditAgentRuntimeDialog,
  type AgentRuntimeUpdateInput,
} from "./edit-agent-runtime-dialog";

type LocalComputer = TeamHubLocalComputerPage["items"][number];

describe("EditAgentRuntimeDialog", () => {
  it("preserves a removed model and requires an explicit selection", async () => {
    const registration = localCodexAgent();
    registration.runtime.model = "removed-model";
    const onSave = vi.fn();
    renderDialog({ registration, onSave });
    await screen.findByText(
      "The current model is unavailable. Choose another model.",
    );
    expect(
      screen.getByRole("combobox", { name: "Agent model" }),
    ).toHaveTextContent("removed-model");
    expect(screen.getByRole("button", { name: "Save Runtime" })).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
  });
  it("keeps the saved Reasoning beside an unavailable model", async () => {
    const registration = localCodexAgent();
    registration.runtime.model = "removed-model";
    registration.runtime.reasoning_effort = "medium";
    renderDialog({ registration, onSave: vi.fn(), field: "model" });
    await screen.findByText(
      "The current model is unavailable. Choose another model.",
    );
    const reasoning = screen.getByRole("combobox", {
      name: "Agent reasoning effort",
    });
    expect(reasoning).toHaveTextContent("Medium · Unavailable");
    expect(reasoning).toBeDisabled();
  });
  it("shows a known empty catalog without restoring defaults", async () => {
    const computer = localComputer("computer-old", "Old Mac", "online");
    computer.runtimes = computer.runtimes.map((runtime) => ({
      ...runtime,
      models: [],
    }));
    renderDialog({ onSave: vi.fn(), computersOverride: { items: [computer] } });
    await screen.findByText("No models are available for this runtime.");
    expect(screen.getByRole("button", { name: "Save Runtime" })).toBeDisabled();
  });
  it("locks Runtime in the Details model editor", async () => {
    renderDialog({ onSave: vi.fn(), field: "model" });
    expect(
      await screen.findByRole("combobox", { name: "Agent runtime" }),
    ).toBeDisabled();
  });
  it("edits the model and reasoning without changing the bound Computer or workspace", async () => {
    const onSave = vi.fn<(input: AgentRuntimeUpdateInput) => void>();
    renderDialog({ onSave });
    const model = await screen.findByRole("combobox", { name: "Agent model" });
    await waitFor(() => expect(model).toHaveTextContent("Codex default"));
    const computer = screen.getByRole("combobox", { name: "Agent computer" });
    expect(computer).toHaveTextContent("Old Mac · Online");
    // The composer opens the full Runtime settings, so the Computer stays
    // selectable there; leaving it alone keeps the bound placement.
    expect(computer).toBeEnabled();
    fireEvent.click(model);
    fireEvent.click(await screen.findByRole("option", { name: "Codex fast" }));
    const reasoning = screen.getByRole("combobox", {
      name: "Agent reasoning effort",
    });
    fireEvent.click(reasoning);
    fireEvent.click(await screen.findByRole("option", { name: "High" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Runtime" }));
    expect(onSave).toHaveBeenCalledWith({
      runtime: {
        model: "codex-fast",
        reasoning_effort: "high",
        placement: localCodexAgent().runtime.placement,
      },
    });
  });

  it.each(["computer", "workspace"])(
    "never falls back to a different %s if the configured binding is missing",
    async (missing) => {
      const onSave = vi.fn<(input: AgentRuntimeUpdateInput) => void>();
      const registration = localCodexAgent();
      if (registration.runtime.placement?.type === "local") {
        if (missing === "computer")
          registration.runtime.placement.computer_id = "computer-removed";
        else
          registration.runtime.placement.workspace_grant_id = "grant-removed";
      }
      renderDialog({ onSave, registration });
      await screen.findByText("Runtime options are unavailable.");
      expect(
        screen.getByRole("button", { name: "Save Runtime" }),
      ).toBeDisabled();
      expect(onSave).not.toHaveBeenCalled();
    },
  );

  it.each(["claude", "pi"] as const)(
    "switches local runtime to %s while retaining the Computer and transport",
    async (type) => {
      const onSave = vi.fn();
      const computer = localComputer("computer-old", "Old Mac", "online");
      computer.runtimes = [
        ...computer.runtimes.filter((item) => item.type !== type),
        {
          type,
          status: "ready",
          models: [{ id: "custom-model", label: "Custom model" }],
        },
      ];
      renderDialog({ onSave, computersOverride: { items: [computer] } });
      const runtime = await screen.findByRole("combobox", {
        name: "Agent runtime",
      });
      await waitFor(() => expect(runtime).toHaveTextContent("Codex"));
      fireEvent.click(runtime);
      fireEvent.click(
        await screen.findByRole("option", {
          name: type === "pi" ? "Pi" : "Claude Code",
        }),
      );
      await waitFor(() =>
        expect(
          screen.getByRole("combobox", { name: "Agent model" }),
        ).toHaveTextContent("Custom model"),
      );
      fireEvent.click(screen.getByRole("button", { name: "Save Runtime" }));
      expect(onSave).toHaveBeenCalledWith({
        runtime: {
          model: "custom-model",
          placement: {
            ...localCodexAgent().runtime.placement,
            runtime_type: type,
          },
        },
      });
    },
  );

  it("blocks an unauthenticated target and allows choosing a ready runtime again", async () => {
    const onSave = vi.fn();
    renderDialog({ onSave });
    const runtime = await screen.findByRole("combobox", {
      name: "Agent runtime",
    });
    await waitFor(() => expect(runtime).toHaveTextContent("Codex"));
    fireEvent.click(runtime);
    fireEvent.click(
      await screen.findByRole("option", { name: "Claude Code · Unavailable" }),
    );
    expect(screen.getByText("Claude authentication is required")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save Runtime" })).toBeDisabled();
    fireEvent.click(runtime);
    fireEvent.click(await screen.findByRole("option", { name: "Codex" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save Runtime" }),
      ).toBeEnabled(),
    );
    expect(onSave).not.toHaveBeenCalled();
  });

  it("saves on an offline Computer from its last reported Runtimes", async () => {
    renderDialog({
      onSave: vi.fn(),
      computersOverride: {
        items: [localComputer("computer-old", "Old Mac", "offline")],
      },
    });
    await screen.findByText(OFFLINE_COMPUTER_HINT);
    expect(screen.getByRole("button", { name: "Save Runtime" })).toBeEnabled();
  });

  it("moves to another computer keeping the ready runtime, model, and reasoning", async () => {
    const onSave = vi.fn<(input: AgentRuntimeUpdateInput) => void>();
    const registration = localCodexAgent();
    registration.runtime.model = "codex-fast";
    registration.runtime.reasoning_effort = "high";
    const target = localComputer("computer-new", "New Mac", "online", {
      workspace_grants: [
        { grant_id: "grant-read", label: "Read only", mode: "read-only" },
        {
          grant_id: "grant-new-workspace",
          label: "New workspace",
          mode: "workspace-write",
        },
      ],
    });
    renderDialog({
      computersOverride: {
        items: [localComputer("computer-old", "Old Mac", "online"), target],
      },
      field: "computer",
      onSave,
      registration,
    });
    const computer = await screen.findByRole("combobox", {
      name: "Agent computer",
    });
    await waitFor(() => expect(computer).toHaveTextContent("Old Mac · Online"));
    expect(screen.queryByText(agentMoveHint)).toBeNull();
    fireEvent.click(computer);
    fireEvent.click(
      await screen.findByRole("option", { name: "New Mac · Online" }),
    );
    expect(
      screen.getByRole("combobox", { name: "Agent runtime" }),
    ).toHaveTextContent("Codex");
    expect(
      screen.getByRole("combobox", { name: "Agent model" }),
    ).toHaveTextContent("Codex fast");
    expect(
      screen.getByRole("combobox", { name: "Agent reasoning effort" }),
    ).toHaveTextContent("High");
    expect(screen.getByText(agentMoveHint)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Move Agent" }));
    expect(onSave).toHaveBeenCalledWith({
      runtime: {
        model: "codex-fast",
        reasoning_effort: "high",
        placement: {
          computer_id: "computer-new",
          runtime_type: "codex",
          type: "local",
          workspace_grant_id: "grant-new-workspace",
        },
      },
    });
  });

  it("falls back to the target's first model and its default reasoning", async () => {
    const onSave = vi.fn<(input: AgentRuntimeUpdateInput) => void>();
    const registration = localCodexAgent();
    registration.runtime.model = "codex-fast";
    registration.runtime.reasoning_effort = "high";
    const target = localComputer("computer-new", "New Mac", "online");
    target.runtimes = [
      {
        models: [
          {
            id: "codex-next",
            label: "Codex next",
            allowed_reasoning_effort: ["low", "medium"],
            default_reasoning_effort: "medium",
          },
        ],
        status: "ready",
        type: "codex",
      },
    ];
    renderDialog({
      computersOverride: {
        items: [localComputer("computer-old", "Old Mac", "online"), target],
      },
      field: "computer",
      onSave,
      registration,
    });
    const computer = await screen.findByRole("combobox", {
      name: "Agent computer",
    });
    await waitFor(() => expect(computer).toHaveTextContent("Old Mac · Online"));
    fireEvent.click(computer);
    fireEvent.click(
      await screen.findByRole("option", { name: "New Mac · Online" }),
    );
    expect(
      screen.getByRole("combobox", { name: "Agent model" }),
    ).toHaveTextContent("Codex next");
    expect(
      screen.getByRole("combobox", { name: "Agent reasoning effort" }),
    ).toHaveTextContent("Medium");
    fireEvent.click(screen.getByRole("button", { name: "Move Agent" }));
    expect(onSave).toHaveBeenCalledWith({
      runtime: expect.objectContaining({
        model: "codex-next",
        reasoning_effort: "medium",
      }),
    });
  });

  it("leaves the runtime empty when the current runtime isn't ready on the target", async () => {
    const onSave = vi.fn<(input: AgentRuntimeUpdateInput) => void>();
    const target = localComputer("computer-new", "New Mac", "online");
    target.runtimes = [
      {
        error_code: "RUNTIME_AUTHENTICATION_REQUIRED",
        message: "Codex authentication is required",
        models: [{ id: "codex-default", label: "Codex default" }],
        status: "authentication_required",
        type: "codex",
      },
      {
        models: [{ id: "claude-default", label: "Claude default" }],
        status: "ready",
        type: "claude",
      },
    ];
    renderDialog({
      computersOverride: {
        items: [localComputer("computer-old", "Old Mac", "online"), target],
      },
      field: "computer",
      onSave,
    });
    const computer = await screen.findByRole("combobox", {
      name: "Agent computer",
    });
    await waitFor(() => expect(computer).toHaveTextContent("Old Mac · Online"));
    fireEvent.click(computer);
    fireEvent.click(
      await screen.findByRole("option", { name: "New Mac · Online" }),
    );
    const runtime = screen.getByRole("combobox", { name: "Agent runtime" });
    expect(runtime).toHaveTextContent("Choose a runtime");
    expect(
      screen.getByText("Codex isn't ready on New Mac. Choose another Runtime."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Move Agent" })).toBeDisabled();
    fireEvent.click(runtime);
    fireEvent.click(await screen.findByRole("option", { name: "Claude Code" }));
    expect(
      screen.getByRole("combobox", { name: "Agent model" }),
    ).toHaveTextContent("Claude default");
    fireEvent.click(screen.getByRole("button", { name: "Move Agent" }));
    expect(onSave).toHaveBeenCalledWith({
      runtime: {
        model: "claude-default",
        placement: {
          computer_id: "computer-new",
          runtime_type: "claude",
          type: "local",
          workspace_grant_id: "grant-workspace",
        },
      },
    });
  });

  it("offers offline computers and disables upgrade-required ones as move targets", async () => {
    renderDialog({
      computersOverride: {
        items: [
          localComputer("computer-old", "Old Mac", "online"),
          localComputer("computer-offline", "Offline Mac", "offline"),
          localComputer("computer-legacy", "Legacy Mac", "online", {
            upgrade_required: true,
          }),
        ],
      },
      field: "computer",
      onSave: vi.fn(),
    });
    const computer = await screen.findByRole("combobox", {
      name: "Agent computer",
    });
    await waitFor(() => expect(computer).toHaveTextContent("Old Mac · Online"));
    fireEvent.click(computer);
    expect(
      await screen.findByRole("option", { name: "Offline Mac · Offline" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("option", {
        name: "Legacy Mac · Online · Upgrade required",
      }),
    ).toBeDisabled();
    expect(
      screen.getByRole("option", { name: "Old Mac · Online" }),
    ).toBeEnabled();
  });

  it("cannot move to a computer without a writable workspace", async () => {
    const onSave = vi.fn();
    renderDialog({
      computersOverride: {
        items: [
          localComputer("computer-old", "Old Mac", "online"),
          localComputer("computer-new", "New Mac", "online", {
            workspace_grants: [
              { grant_id: "grant-read", label: "Read only", mode: "read-only" },
            ],
          }),
        ],
      },
      field: "computer",
      onSave,
    });
    const computer = await screen.findByRole("combobox", {
      name: "Agent computer",
    });
    await waitFor(() => expect(computer).toHaveTextContent("Old Mac · Online"));
    fireEvent.click(computer);
    fireEvent.click(
      await screen.findByRole("option", { name: "New Mac · Online" }),
    );
    expect(
      screen.getByText(
        "This computer has no writable workspace. Choose another computer.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Move Agent" })).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
  });
});

function renderDialog({
  field = "runtime",
  onSave,
  registration = localCodexAgent(),
  computersOverride,
}: {
  field?: AgentRuntimeField;
  onSave: (input: AgentRuntimeUpdateInput) => void;
  registration?: TeamHubTenantAgent;
  computersOverride?: TeamHubLocalComputerPage;
}) {
  const computers: TeamHubLocalComputerPage = computersOverride ?? {
    items: [
      localComputer("computer-old", "Old Mac", "online"),
      localComputer("computer-new", "New Mac", "online"),
    ],
  };
  const client = {
    listTenantLocalComputers: vi.fn().mockResolvedValue(computers),
  };

  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <EditAgentRuntimeDialog
        field={field}
        client={client}
        isPending={false}
        onClose={vi.fn()}
        onSave={onSave}
        registration={registration}
        tenantId="tenant-northstar"
      />
    </QueryClientProvider>,
  );
}

function localComputer(
  computerId: string,
  displayName: string,
  status: "online" | "offline",
  overrides: Partial<LocalComputer> = {},
): LocalComputer {
  return {
    active_operations: 0,
    available_capacity: 2,
    capacity: 2,
    computer_id: computerId,
    display_name: displayName,
    runtimes: [
      {
        error_code: "RUNTIME_AUTHENTICATION_REQUIRED",
        message: "Claude authentication is required",
        models: [{ id: "claude-default", label: "Claude default" }],
        status: "authentication_required",
        type: "claude",
      },
      {
        models: [
          { id: "codex-default", label: "Codex default" },
          {
            id: "codex-fast",
            label: "Codex fast",
            allowed_reasoning_effort: ["low", "high"],
          },
        ],
        status: "ready" as const,
        type: "codex" as const,
      },
    ],
    status,
    upgrade_required: false,
    workspace_grants: [
      {
        grant_id: "grant-workspace",
        label: "Workspace",
        mode: "workspace-write",
      },
    ],
    ...overrides,
  };
}

function localCodexAgent(): TeamHubTenantAgent {
  const timestamp = "2026-09-01T15:40:00Z";
  return {
    actor: {
      created_at: timestamp,
      display_name: "Local Codex",
      handle: "@local_codex",
      id: "actor-local-codex",
      kind: "agent",
      tenant_id: "tenant-northstar",
    },
    agent_management_id: "agent-local-codex",
    agent_type: "general",
    configuration_revision: 1,
    created_at: timestamp,
    created_by: {
      display_name: "Jenny Bin",
      id: "actor-jenny",
      kind: "human",
      tenant_id: "tenant-northstar",
    },
    description: "",
    instructions: "Work locally.",
    runtime: {
      model: "codex-default",
      placement: {
        computer_id: "computer-old",
        runtime_type: "codex",
        type: "local",
        workspace_grant_id: "grant-workspace",
      },
    },
    skill_bindings: [],
    updated_at: timestamp,
    visibility_scope: "sponsor",
  };
}
