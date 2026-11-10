import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import {
  createTestTeamHubRuntime,
  type TestTeamHubRuntime,
} from "@/test/teamhub-test-runtime";
import {
  teamHubErrorResponse,
  type TestRouteRequest,
} from "@/test/teamhub-test-server";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { TeamHubError } from "@/features/teamhub/teamhub-error";
import { AgentInfoContent } from "./agent-info-content";

async function setup(
  options: {
    localComputerId?: string;
    runtime?: ReturnType<typeof createTestTeamHubRuntime>;
    agentName?: string;
    roomId?: string;
    onSaveName?: (name: string) => Promise<unknown>;
  } = {},
) {
  const {
    localComputerId,
    runtime = createTestTeamHubRuntime(),
    agentName = "Codex",
    roomId,
    onSaveName,
  } = options;
  const listed = (await readTenantAgents(runtime)).items.find(
    (item) => item.actor.display_name === agentName,
  )!;
  const registration: typeof listed = {
    ...listed,
    ...(localComputerId
      ? {
          runtime: {
            ...listed.runtime,
            placement: {
              computer_id: localComputerId,
              runtime_type: "codex",
              type: "local",
              workspace_grant_id: "grant-1",
            },
          },
        }
      : {}),
  };
  if (localComputerId) {
    runtime.server.on("GET", "/v0/tenants/{tenantId}/agents", () => ({
      items: runtime.seed.tenantAgents.map((item) =>
        item.actor.id === registration.actor.id ? registration : item,
      ),
      page: { has_more: false },
    }));
  }
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const content = (nameBusy: boolean) => (
    <QueryClientProvider client={queryClient}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <MemoryRouter>
          <AgentInfoContent
            canEditName={Boolean(onSaveName)}
            nameBusy={nameBusy}
            onSaveName={onSaveName}
            tenantId="tenant-northstar"
            actor={registration.actor}
            registration={registration}
            availability={{
              status: "online",
              label: "Online",
              active_task_count: 0,
            }}
            details={<p>Read-only Agent details</p>}
            roomId={roomId}
          />
        </MemoryRouter>
      </TeamHubRuntimeProvider>
    </QueryClientProvider>
  );
  const view = render(content(false));
  return {
    runtime,
    registration,
    setNameBusy: (busy: boolean) => view.rerender(content(busy)),
  };
}

const savedNotice = "Saved. Future runs will use the new configuration.";

function uploadSkill() {
  const file = new File(
    ["---\nname: meeting-notes\ndescription: Capture meeting notes.\n---\n"],
    "SKILL.md",
    { type: "text/markdown", lastModified: 1 },
  );
  fireEvent.change(screen.getByLabelText("Upload Skill package"), {
    target: { files: [file] },
  });
  return file;
}

describe("Agent Info", () => {
  it("does not show Computer Skills in Details", async () => {
    await setup({ localComputerId: "computer-mac" });
    expect(await screen.findByText("Review Changes")).toBeVisible();
    expect(
      screen.queryByRole("region", { name: "Skills on this Computer" }),
    ).not.toBeInTheDocument();
  });

  it("shows Details, Routines, and Connectors tabs", async () => {
    await setup();
    expect(await screen.findByRole("tab", { name: "Details" })).toBeVisible();
    const tabs = within(
      screen.getByRole("tablist", { name: "Agent settings" }),
    );
    expect(tabs.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Details",
      "Routines",
      "Connectors",
    ]);
    // Equal-width pills keep the middle tab under the name and do not stretch.
    for (const tab of tabs.getAllByRole("tab"))
      expect(tab).toHaveClass("rounded-full", "w-[92px]", "min-w-0");
    expect(tabs.getAllByRole("tab")[0]).not.toHaveClass("flex-1");
  });

  it("shows Connectors directly without a collapsible section", async () => {
    await setup();
    expect(await screen.findByText("Online")).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "Connectors" }));
    expect(await screen.findByRole("region", { name: "Gmail" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Connectors" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Activity" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Runtime" })).toBeNull();
  });

  it("explains routines are per Room when opened outside a Room", async () => {
    await setup();
    fireEvent.click(await screen.findByRole("tab", { name: "Routines" }));
    expect(
      await screen.findByText(
        "Open this Agent from a Room to see its routines there.",
      ),
    ).toBeVisible();
  });

  it("reuses the Room routines panel scoped to routines the Agent created or executes", async () => {
    const runtime = createTestTeamHubRuntime();
    const listed = (await readTenantAgents(runtime)).items.find(
      (item) => item.actor.display_name === "Codex",
    )!;
    const routine = {
      cadence: { kind: "daily" as const, time: "09:00", timezone: "UTC" },
      created_at: "2026-10-14T00:00:00Z",
      created_by_actor_id: "human-1",
      enabled: true,
      instruction: "Do it",
      revision: 1,
      room_id: "room-1",
      updated_at: "2026-10-14T00:00:00Z",
    };
    const list = vi.fn(() => ({
      items: [
        {
          ...routine,
          id: "r1",
          name: "Created by agent",
          instruction: "Created by agent",
          created_by_actor_id: listed.actor.id,
        },
        {
          ...routine,
          id: "r2",
          name: "Executed by agent",
          instruction: "Executed by agent",
          mention_actor_id: listed.actor.id,
        },
        {
          ...routine,
          id: "r3",
          name: "Someone else",
          instruction: "Someone else",
          mention_actor_id: "agent-other",
        },
      ],
      page: { has_more: false },
    }));
    runtime.server.on("GET", "/v0/rooms/{roomId}/routines", list);
    await setup({ runtime, roomId: "room-1" });
    fireEvent.click(await screen.findByRole("tab", { name: "Routines" }));
    expect(await screen.findByText("Created by agent")).toBeVisible();
    expect(screen.getByText("Executed by agent")).toBeVisible();
    expect(screen.queryByText("Someone else")).toBeNull();
    expect(screen.queryByText("Showing routines in this Room")).toBeNull();
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ params: { roomId: "room-1" } }),
    );
    expect(
      screen.getAllByRole("switch", { name: "Pause routine" }),
    ).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "New routine" }));
    expect(screen.queryByRole("combobox", { name: "Mention" })).toBeNull();
  });

  it("keeps Skills in Details and Connectors in their own tab", async () => {
    await setup();
    expect(await screen.findByText("Online")).toBeVisible();
    expect(screen.getByText("Read-only Agent details")).toBeVisible();
    expect(screen.getByRole("tab", { name: "Details" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      await screen.findByRole("heading", { name: "Skills" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Add" })).toBeVisible();
    expect(await screen.findByText("Review Changes")).toBeVisible();
    expect(screen.getByText("1.0.0")).toBeVisible();
    // Each Skill says what it does on its own line, without a hover.
    expect(
      screen.getByText(
        "Review repository changes and report concrete, actionable findings before approval.",
      ),
    ).toBeVisible();
    const upload = await screen.findByRole("button", { name: "Upload Skill" });
    expect(upload).toBeVisible();
    fireEvent.mouseEnter(upload);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("ZIP or SKILL.md");
    expect(tooltip).toHaveTextContent("Same name upgrades this Skill.");
    fireEvent.mouseLeave(upload);
    expect(screen.queryByRole("tab", { name: "Logs" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Connectors" }));
    expect(screen.getByText("Read-only Agent details")).not.toBeVisible();
    expect(await screen.findByRole("region", { name: "Gmail" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Slack" })).toBeNull();
    expect(screen.queryByText("Not connected")).toBeNull();
    expect(
      screen.getByRole("link", { name: "Connect another app" }),
    ).toHaveAttribute("href", "/t/tenant-northstar/apps");
    fireEvent.click(screen.getByRole("tab", { name: "Details" }));
    expect(screen.getByText("Read-only Agent details")).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "Connectors" }));
    expect(screen.queryByRole("button", { name: "Activity" })).toBeNull();
  });
  it("shows five Skills initially and expands the remaining items", async () => {
    const runtime = createTestTeamHubRuntime();
    runtime.server.on("GET", "/v0/tenants/{tenantId}/agents", () => ({
      page: { has_more: false },
      items: runtime.seed.tenantAgents.map((item) =>
        item.actor.display_name === "Codex"
          ? {
              ...item,
              skill_bindings: Array.from({ length: 7 }, (_, index) => ({
                skill_id: `skill-${index}`,
                name: `Example skill ${index}`,
                manifest_version: "1.0.0",
                description: "Example",
              })),
            }
          : item,
      ),
    }));
    await setup({ runtime });
    expect(await screen.findByText("Example skill 0")).toBeVisible();
    expect(screen.getByText("Example skill 4")).toBeVisible();
    expect(screen.queryByText("Example skill 5")).not.toBeInTheDocument();
    const skillsPanel = screen.getByRole("region", { name: "Skills" });
    expect(screen.getByRole("tabpanel", { name: "Details" })).toHaveClass(
      "[overflow-anchor:none]",
      "[scrollbar-gutter:stable_both-edges]",
    );
    expect(
      within(skillsPanel).getByRole("button", { name: "Show all 7 Skills" }),
    ).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(
      within(skillsPanel).getByRole("button", { name: "Show all 7 Skills" }),
    );
    expect(
      within(skillsPanel).getByRole("button", { name: "Show fewer" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Example skill 6")).toBeVisible();
    fireEvent.click(
      within(skillsPanel).getByRole("button", { name: "Show fewer" }),
    );
    expect(screen.queryByText("Example skill 5")).not.toBeInTheDocument();
  });

  it("returns keyboard focus after editing or cancelling the name", async () => {
    const onSaveName = vi.fn().mockResolvedValue(undefined);
    await setup({ onSaveName });
    const edit = await screen.findByRole("button", { name: "Edit name Codex" });
    fireEvent.click(edit);
    const name = screen.getByRole("textbox", { name: "Agent name" });
    fireEvent.keyDown(name, { key: "Escape" });
    expect(
      screen.getByRole("button", { name: "Edit name Codex" }),
    ).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Edit name Codex" }));
    const next = screen.getByRole("textbox", { name: "Agent name" });
    fireEvent.change(next, { target: { value: "Codex Reviewer" } });
    fireEvent.keyDown(next, { key: "Enter" });
    await waitFor(() =>
      expect(onSaveName).toHaveBeenCalledWith("Codex Reviewer"),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Edit name Codex" }),
      ).toHaveFocus(),
    );
  });

  it("restores focus only after a failed name save finishes", async () => {
    let rejectSave: (reason: Error) => void = () => {};
    const onSaveName = vi.fn(
      () =>
        new Promise((_, reject) => {
          rejectSave = reject;
        }),
    );
    const { setNameBusy } = await setup({ onSaveName });
    fireEvent.click(
      await screen.findByRole("button", { name: "Edit name Codex" }),
    );
    const input = screen.getByRole("textbox", { name: "Agent name" });
    fireEvent.change(input, { target: { value: "New name" } });
    fireEvent.keyDown(input, { key: "Enter" });
    setNameBusy(true);
    expect(input).toBeDisabled();
    await act(async () => rejectSave(new Error("Save failed")));
    expect(input).toBeDisabled();
    setNameBusy(false);
    await waitFor(() => expect(input).toHaveFocus());
  });

  it("loads all Skill catalog pages and exposes each available version", async () => {
    const runtime = createTestTeamHubRuntime();
    const base = runtime.seed.skillManifests[0]!;
    const list = vi
      .fn()
      .mockReturnValueOnce({
        items: [
          {
            ...base,
            skill_id: "extra",
            name: "Extra",
            manifest_version: "1.9.0",
            availability: "active",
          },
        ],
        page: { has_more: true, next_cursor: "next" },
      })
      .mockReturnValueOnce({
        items: [
          {
            ...base,
            skill_id: "extra",
            name: "Extra",
            manifest_version: "1.10.0",
            availability: "active",
          },
        ],
        page: { has_more: false },
      });
    runtime.server.on("GET", "/v0/tenants/{tenantId}/skill-manifests", list);
    await setup({ runtime });
    await openSkillLibrary();
    expect(
      await screen.findByRole("button", { name: /Extra · 1.9.0/ }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: /Extra · 1.10.0/ }),
    ).toBeVisible();
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ params: { tenantId: "tenant-northstar" } }),
    );
    expect(list.mock.calls[1]?.[0].query.toString()).toBe("cursor=next");
  });

  it("installs a catalog Skill against the current binding version", async () => {
    const runtime = createTestTeamHubRuntime();
    const base = runtime.seed.skillManifests[0]!;
    runtime.server.on("GET", "/v0/tenants/{tenantId}/skill-manifests", () => ({
      items: [
        {
          ...base,
          skill_id: "extra",
          name: "Extra",
          manifest_version: "1.9.0",
          availability: "active",
        },
      ],
      page: { has_more: false },
    }));
    const install = vi.fn(({ params }: { params: Record<string, string> }) => ({
      agent_actor_id: params.agentId,
      binding_version: 2,
      config: {},
      enabled: true,
      id: "binding-extra",
      skill: { manifest_version: "1.9.0", skill_id: "extra" },
      tenant_id: params.tenantId,
      updated_at: "2026-10-15T00:00:00Z",
      updated_by_actor_id: "actor-jenny",
    }));
    runtime.server.on(
      "PUT",
      "/v0/tenants/{tenantId}/agents/{agentId}/skill-bindings/{skillId}",
      install,
    );
    const { registration } = await setup({ runtime });
    await openSkillLibrary();
    fireEvent.click(
      await screen.findByRole("button", { name: /Extra · 1.9.0/ }),
    );
    await waitFor(() =>
      expect(install).toHaveBeenCalledWith(
        expect.objectContaining({
          body: {
            config: {},
            enabled: true,
            expected_binding_version: 1,
            manifest_version: "1.9.0",
          },
          params: {
            agentId: registration.actor.id,
            skillId: "extra",
            tenantId: "tenant-northstar",
          },
        }),
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(savedNotice);
  });

  it("shows Skill catalog errors inside the dialog and allows retry", async () => {
    const runtime = createTestTeamHubRuntime();
    runtime.server.on(
      "GET",
      "/v0/tenants/{tenantId}/skill-manifests",
      vi
        .fn()
        .mockReturnValueOnce(
          teamHubErrorResponse(
            503,
            "CATALOG_UNAVAILABLE",
            "Catalog unavailable",
          ),
        )
        .mockReturnValue({ items: [], page: { has_more: false } }),
    );
    await setup({ runtime });
    await openSkillLibrary();
    const dialog = screen.getByRole("dialog", { name: "Add Skill" });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Catalog unavailable",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    expect(
      await within(dialog).findByText("No more built-in Skills to add."),
    ).toBeVisible();
  });

  it("uploads a SKILL.md and removes an explicit binding from the sidebar", async () => {
    const { runtime, registration } = await setup();
    const apply = serveAgentUpdates(runtime);
    const initialBindings = await readSkillBindings(
      runtime,
      registration.actor.id,
    );
    const uploadedBinding = {
      ...initialBindings.items[0]!,
      id: "binding-meeting-notes",
      binding_version: 2,
      skill: { skill_id: "skill-meeting-notes", manifest_version: "1.0.0" },
    };
    const uploadedSkill = {
      ...uploadedBinding.skill,
      name: "meeting-notes",
      description: "Capture meeting notes.",
    };
    const upload = vi
      .spyOn(runtime.client, "uploadAgentSkillPackage")
      .mockResolvedValue(uploadedBinding);
    const remove = vi.fn((_request: TestRouteRequest) => undefined);
    runtime.server.on(
      "DELETE",
      "/v0/tenants/{tenantId}/agents/{agentId}/skill-bindings/{skillId}",
      remove,
    );
    expect(await screen.findByText("Review Changes")).toBeVisible();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Upload Skill" }),
      ).toBeEnabled(),
    );
    const bindings = vi.fn(() => ({
      ...initialBindings,
      binding_version: 2,
      items: [...initialBindings.items, uploadedBinding],
    }));
    runtime.server.on(
      "GET",
      "/v0/tenants/{tenantId}/agents/{agentId}/skill-bindings",
      bindings,
    );
    const agents = vi.fn(() => ({
      items: [
        {
          ...registration,
          skill_bindings: [...registration.skill_bindings, uploadedSkill],
        },
      ],
      page: { has_more: false },
    }));
    runtime.server.on("GET", "/v0/tenants/{tenantId}/agents", agents);
    const file = uploadSkill();
    expect(await screen.findByText("meeting-notes")).toBeVisible();
    expect(upload).toHaveBeenCalledWith(
      "tenant-northstar",
      registration.actor.id,
      file,
      "SKILL.md",
      expect.any(String),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(savedNotice);
    expect(apply).not.toHaveBeenCalled();
    bindings.mockReturnValue({
      ...initialBindings,
      binding_version: 3,
      items: [uploadedBinding],
    });
    agents.mockReturnValue({
      items: [{ ...registration, skill_bindings: [uploadedSkill] }],
      page: { has_more: false },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove Review Changes" }),
    );
    await waitFor(() =>
      expect(screen.queryByText("Review Changes")).toBeNull(),
    );
    expect(screen.getByText("meeting-notes")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(savedNotice);
    expect(remove).toHaveBeenCalledWith(
      expect.objectContaining({
        params: {
          agentId: registration.actor.id,
          skillId: initialBindings.items[0]!.skill.skill_id,
          tenantId: "tenant-northstar",
        },
      }),
    );
    expect(remove.mock.calls[0]?.[0].query.toString()).toBe(
      "expected_binding_version=2",
    );
    expect(apply).not.toHaveBeenCalled();
  });

  it("preserves a save revision conflict instead of reporting success", async () => {
    const { runtime } = await setup();
    const apply = serveAgentUpdates(runtime);
    const remove = await screen.findByRole("button", {
      name: "Remove Review Changes",
    });
    await waitFor(() => expect(remove).toBeEnabled());
    runtime.server.on(
      "DELETE",
      "/v0/tenants/{tenantId}/agents/{agentId}/skill-bindings/{skillId}",
      () =>
        teamHubErrorResponse(
          409,
          "SKILL_BINDING_REVISION_CONFLICT",
          "Reload the Skill binding revision.",
        ),
    );
    fireEvent.click(remove);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Reload the Skill binding revision.",
    );
    expect(screen.queryByText(savedNotice)).toBeNull();
    expect(screen.getByText("Review Changes")).toBeVisible();
    expect(apply).not.toHaveBeenCalled();
  });

  it("reports upload failures and retries the save without an application request", async () => {
    const { runtime, registration } = await setup();
    const initialBindings = await readSkillBindings(
      runtime,
      registration.actor.id,
    );
    const upload = vi
      .spyOn(runtime.client, "uploadAgentSkillPackage")
      .mockRejectedValueOnce(
        new TeamHubError({
          code: "SKILL_PACKAGE_INVALID",
          message: "Skill package validation failed.",
          status: 400,
        }),
      )
      .mockResolvedValue({
        ...initialBindings.items[0]!,
        id: "binding-meeting-notes",
        binding_version: 2,
        skill: { skill_id: "skill-meeting-notes", manifest_version: "1.0.0" },
      });
    const apply = serveAgentUpdates(runtime);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Upload Skill" }),
      ).toBeEnabled(),
    );
    uploadSkill();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Skill package validation failed.",
    );
    expect(screen.queryByText(savedNotice)).toBeNull();
    uploadSkill();
    expect(await screen.findByText(savedNotice)).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls[1]?.[4]).toBe(upload.mock.calls[0]?.[4]);
    expect(apply).not.toHaveBeenCalled();
  });
  it("keeps upload and remove visible when the current Human is not the Sponsor", async () => {
    await setup({ agentName: "Lev8 GTM" });
    expect(await screen.findByText("Research Market")).toBeVisible();
    const upload = await screen.findByRole("button", { name: "Upload Skill" });
    expect(upload).toBeDisabled();
    fireEvent.mouseEnter(upload.parentElement!);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Only the Sponsor can change Skills",
    );
    expect(
      screen.getByRole("button", { name: "Remove Research Market" }),
    ).toBeDisabled();
  });
});

// Add is enabled once the Sponsor identity loads.
async function openSkillLibrary() {
  const add = await screen.findByRole("button", { name: "Add" });
  await waitFor(() => expect(add).toBeEnabled());
  fireEvent.click(add);
}

function readTenantAgents(runtime: TestTeamHubRuntime) {
  return teamHubData(
    runtime.client.api.GET("/v0/tenants/{tenantId}/agents", {
      params: { path: { tenantId: "tenant-northstar" } },
    }),
  );
}

function readSkillBindings(runtime: TestTeamHubRuntime, agentId: string) {
  return teamHubData(
    runtime.client.api.GET(
      "/v0/tenants/{tenantId}/agents/{agentId}/skill-bindings",
      { params: { path: { tenantId: "tenant-northstar", agentId } } },
    ),
  );
}

function serveAgentUpdates(runtime: TestTeamHubRuntime) {
  const update = vi.fn();
  runtime.server.on("PATCH", "/v0/tenants/{tenantId}/agents/{agentId}", update);
  return update;
}
