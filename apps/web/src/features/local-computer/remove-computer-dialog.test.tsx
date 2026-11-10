import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import {
  teamHubErrorResponse,
  type TestRouteHandler,
} from "@/test/teamhub-test-server";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubLocalComputerPage,
  TeamHubTenantAgent,
} from "@/features/teamhub/teamhub-types";

import {
  NO_OTHER_COMPUTER_NOTICE,
  RemoveComputerDialog,
} from "./remove-computer-dialog";

type LocalComputer = TeamHubLocalComputerPage["items"][number];

describe("RemoveComputerDialog", () => {
  it("preselects the first other computer where the current runtime is ready and explains the model", () => {
    const reviewer = agent("actor-reviewer", "Local Reviewer");
    reviewer.runtime.reasoning_effort = "high";
    renderDialog({
      agents: [reviewer],
      computers: [
        oldComputer(),
        computer("computer-offline", "Offline Mac", { status: "offline" }),
        computer("computer-new", "New Mac"),
        computer("computer-other", "Other Mac"),
      ],
    });
    expect(
      screen.getByRole("combobox", { name: "Target for Local Reviewer" }),
    ).toHaveTextContent("New Mac · Codex");
    expect(
      screen.getByText("Uses Codex · GPT-5.4 · Medium. Reasoning was High."),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Move 1 Agent and remove" }),
    ).toBeEnabled();
    expect(screen.queryByText(NO_OTHER_COMPUTER_NOTICE)).toBeNull();
  });

  it("leaves the target empty until the user picks a runtime that is ready elsewhere", async () => {
    const target = computer("computer-new", "New Mac");
    target.runtimes = [
      {
        error_code: "RUNTIME_AUTHENTICATION_REQUIRED",
        message: "Codex authentication is required",
        models: [{ id: "openai/gpt-5.4", label: "GPT-5.4" }],
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
      agents: [agent("actor-reviewer", "Local Reviewer")],
      computers: [oldComputer(), target],
    });
    const select = screen.getByRole("combobox", {
      name: "Target for Local Reviewer",
    });
    expect(select).toHaveTextContent("Choose a target");
    expect(
      screen.getByText("Codex isn't ready on New Mac. Choose another Runtime."),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Move 1 Agent and remove" }),
    ).toBeDisabled();
    fireEvent.click(select);
    fireEvent.click(
      await screen.findByRole("option", { name: "New Mac · Claude Code" }),
    );
    expect(
      screen.getByText("Uses Claude Code · Claude default."),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Move 1 Agent and remove" }),
    ).toBeEnabled();
  });

  it("moves every Agent in order and then removes the Computer", async () => {
    const order: string[] = [];
    const updateTenantAgent = vi.fn(
      ({ params }: { params: Record<string, string> }) => {
        order.push(params.agentId!);
        return placed(params.agentId!);
      },
    );
    const onConfirm = vi.fn();
    renderDialog({
      agents: [
        agent("actor-a", "Agent A"),
        agent("actor-b", "Agent B", "anotherme"),
      ],
      handlers: { updateTenantAgent },
      onConfirm,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Move 2 Agents and remove" }),
    );
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(order).toEqual(["actor-a", "actor-b"]);
    expect(
      screen.getAllByRole("status").map((node) => node.textContent),
    ).toEqual(["Moved", "Moved"]);
    expect(updateTenantAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { tenantId: "tenant-northstar", agentId: "actor-b" },
        body: expect.objectContaining({
          expected_configuration_revision: 3,
          runtime: expect.objectContaining({
            placement: {
              computer_id: "computer-new",
              runtime_type: "codex",
              type: "local",
              workspace_grant_id: "grant-new",
            },
          }),
        }),
      }),
    );
  });

  it("stops at the first failure and retries only the unfinished Agents", async () => {
    const updateTenantAgent = vi
      .fn()
      .mockReturnValueOnce(
        teamHubErrorResponse(
          409,
          "AGENT_RUN_ACTIVE",
          "Agent has an active Run",
        ),
      )
      .mockImplementation(({ params }: { params: Record<string, string> }) =>
        placed(params.agentId!),
      );
    const onConfirm = vi.fn();
    renderDialog({
      agents: [agent("actor-a", "Agent A"), agent("actor-b", "Agent B")],
      handlers: { updateTenantAgent },
      onConfirm,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Move 2 Agents and remove" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Failed: Agent has an active Run",
    );
    expect(updateTenantAgent).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(
      updateTenantAgent.mock.calls.map((call) => call[0].params.agentId),
    ).toEqual(["actor-a", "actor-a", "actor-b"]);
  });

  it("deletes an ordinary Agent instead of moving it", async () => {
    const deleteTenantAgent = vi.fn(() => undefined);
    const updateTenantAgent = vi.fn();
    const onConfirm = vi.fn();
    renderDialog({
      agents: [agent("actor-a", "Agent A")],
      handlers: { deleteTenantAgent, updateTenantAgent },
      onConfirm,
    });
    fireEvent.click(
      screen.getByRole("combobox", { name: "Target for Agent A" }),
    );
    fireEvent.click(
      await screen.findByRole("option", { name: "Delete this Agent instead" }),
    );
    expect(
      screen.getByText(
        "Removes this Agent from every Room and deletes your direct chat with it.",
      ),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Delete and remove" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(deleteTenantAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { tenantId: "tenant-northstar", agentId: "actor-a" },
      }),
    );
    expect(updateTenantAgent).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Deleted");
  });

  it("asks for a new computer when no other computer can take the Agents and keeps Another Me undeletable", async () => {
    const onConnect = vi.fn();
    renderDialog({
      agents: [
        agent("actor-me", "Another Jenny", "anotherme"),
        agent("actor-a", "Agent A"),
      ],
      computers: [
        oldComputer(),
        computer("computer-legacy", "Legacy Mac", { upgrade_required: true }),
      ],
      onConnect,
    });
    expect(screen.getByText(NO_OTHER_COMPUTER_NOTICE)).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Move 2 Agents and remove" }),
    ).toBeDisabled();
    expect(
      screen.getByText(
        "Another Me can't be deleted. Connect another computer to move it.",
      ),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("combobox", { name: "Target for Another Jenny" }),
    );
    expect(
      screen.queryByRole("option", { name: "Delete this Agent instead" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("combobox", { name: "Target for Agent A" }),
    );
    fireEvent.click(
      await screen.findByRole("option", { name: "Delete this Agent instead" }),
    );
    // Another Me still has no target, so the Computer cannot be removed yet.
    expect(
      screen.getByRole("button", { name: "Move 2 Agents and remove" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Connect a computer" }));
    expect(onConnect).toHaveBeenCalledTimes(1);
  });
});

function renderDialog({
  agents,
  handlers = {},
  computers = [oldComputer(), computer("computer-new", "New Mac")],
  onConfirm = vi.fn(),
  onConnect = vi.fn(),
}: {
  agents: TeamHubTenantAgent[];
  handlers?: {
    deleteTenantAgent?: TestRouteHandler;
    updateTenantAgent?: TestRouteHandler;
  };
  computers?: LocalComputer[];
  onConfirm?: () => void;
  onConnect?: () => void;
}) {
  const runtime = createTestTeamHubRuntime();
  runtime.server
    .on(
      "DELETE",
      "/v0/tenants/{tenantId}/agents/{agentId}",
      handlers.deleteTenantAgent ?? (() => undefined),
    )
    .on(
      "PATCH",
      "/v0/tenants/{tenantId}/agents/{agentId}",
      handlers.updateTenantAgent ?? (({ params }) => placed(params.agentId!)),
    );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <RemoveComputerDialog
          agents={agents}
          computer={computers[0]!}
          computers={computers}
          onClose={vi.fn()}
          onConfirm={onConfirm}
          onConnect={onConnect}
          pending={false}
          tenantId="tenant-northstar"
        />
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
}

function oldComputer() {
  return computer("computer-old", "Old Mac", {
    workspace_grants: [
      {
        grant_id: "grant-old",
        label: "Old workspace",
        mode: "workspace-write",
      },
    ],
  });
}

function computer(
  computerId: string,
  displayName: string,
  overrides: Partial<LocalComputer> = {},
): LocalComputer {
  return {
    active_operations: 0,
    computer_id: computerId,
    display_name: displayName,
    runtimes: [
      {
        models: [
          {
            id: "openai/gpt-5.4",
            label: "GPT-5.4",
            allowed_reasoning_effort: ["low", "medium"],
            default_reasoning_effort: "medium",
          },
        ],
        status: "ready",
        type: "codex",
      },
    ],
    status: "online",
    upgrade_required: false,
    workspace_grants: [
      {
        grant_id: "grant-new",
        label: "New workspace",
        mode: "workspace-write",
      },
    ],
    ...overrides,
  };
}

function placed(actorId: string): TeamHubTenantAgent {
  const moved = agent(actorId, `Agent ${actorId}`);
  return {
    ...moved,
    configuration_revision: 4,
    runtime: {
      ...moved.runtime,
      placement: { ...moved.runtime.placement!, computer_id: "computer-new" },
    },
  };
}

function agent(
  actorId: string,
  displayName: string,
  agentType: TeamHubTenantAgent["agent_type"] = "general",
): TeamHubTenantAgent {
  const timestamp = "2026-10-01T09:00:00Z";
  return {
    actor: {
      created_at: timestamp,
      display_name: displayName,
      id: actorId,
      kind: "agent",
      tenant_id: "tenant-northstar",
    },
    agent_management_id: `management-${actorId}`,
    agent_type: agentType,
    configuration_revision: 3,
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
      model: "openai/gpt-5.4",
      placement: {
        computer_id: "computer-old",
        runtime_type: "codex",
        type: "local",
        workspace_grant_id: "grant-old",
      },
    },
    skill_bindings: [],
    updated_at: timestamp,
    visibility_scope: "sponsor",
  };
}
