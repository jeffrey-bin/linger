import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  createTestTeamHubRuntime,
  type TestTeamHubRuntime,
} from "@/test/teamhub-test-runtime";
import type { TestRouteRequest } from "@/test/teamhub-test-server";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubAgentTemplate,
  TeamHubTenantAgentCreateInput,
} from "@/features/teamhub/teamhub-types";

import { CreateAgentFromTemplateDialog } from "./create-agent-from-template-dialog";

describe("CreateAgentFromTemplateDialog", () => {
  it("lists official templates and user templates under their own headings", async () => {
    await renderDialog();

    const official = await screen.findByRole("list", {
      name: "Official templates",
    });
    expect(official).toHaveTextContent("Code Reviewer");
    expect(official).not.toHaveTextContent("Market Researcher");

    // No tab to click: both origins are visible in one pass.
    const fromUsers = screen.getByRole("list", {
      name: "Templates from users",
    });
    expect(fromUsers).toHaveTextContent("Market Researcher");
    expect(fromUsers).toHaveTextContent("by Jenny");
    expect(fromUsers).not.toHaveTextContent("Code Reviewer");
  });

  it("previews every Routine and creates with the template without a selection step", async () => {
    const template: TeamHubAgentTemplate = {
      template_id: "scheduled-template",
      origin: "published",
      name: "Scheduled Agent",
      description: "Checks regularly",
      instructions: "Check the room.",
      connector_bindings: [],
      skill_bindings: [],
      created_at: "2026-10-15T00:00:00Z",
      updated_at: "2026-10-15T00:00:00Z",
      routines: [
        {
          key: "daily",
          name: "Daily check",
          instruction: "Check all updates.",
          created_by_role: "human",
          mention_role: "agent",
          enabled: true,
          cadence: {
            kind: "daily",
            timezone: "Asia/Shanghai",
            hour: 9,
            minute: 0,
          },
        },
        {
          key: "paused",
          name: "Paused check",
          instruction: "Keep this paused.",
          created_by_role: "agent",
          enabled: false,
          cadence: {
            kind: "every_n_hours",
            timezone: "UTC",
            interval_hours: 2,
          },
        },
      ],
    };
    const { createAgent } = await renderDialog((runtime) => {
      runtime.server.on(
        "GET",
        "/v0/tenants/{tenantId}/agent-templates",
        () => ({
          items: [template],
        }),
      );
    });
    expect(await screen.findByText("2 Routines")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Scheduled Agent/ }));
    const routines = screen.getByRole("region", { name: "Routines" });
    expect(routines).toHaveTextContent("Daily check");
    expect(routines).toHaveTextContent("Paused check");
    expect(routines).toHaveTextContent("Asia/Shanghai");
    expect(routines).toHaveTextContent("Enabled");
    expect(routines).toHaveTextContent("Paused");
    expect(within(routines).queryByRole("checkbox")).toBeNull();
    const submit = screen.getByRole("button", { name: "Create Agent" });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    await waitFor(() =>
      expect(createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          params: { tenantId: "tenant-northstar" },
          body: expect.objectContaining({ template_id: template.template_id }),
        }),
      ),
    );
  });

  it("applies the template Skills to a Local Agent on the selected Computer", async () => {
    const { createAgent } = await renderDialog();

    fireEvent.click(
      await screen.findByRole("button", { name: /Code Reviewer/ }),
    );
    expect(screen.queryByRole("radio")).toBeNull();

    expect(
      await screen.findByRole("combobox", { name: "Local Computer" }),
    ).toHaveTextContent("Jenny's Mac");
    // The Local Context projects platform Skills read-only next to the ones the
    // Computer already has, so they are applied rather than dropped.
    expect(
      await screen.findByText(
        /used alongside the Skills already on this Computer/,
      ),
    ).toBeVisible();

    const submit = screen.getByRole("button", { name: "Create Agent" });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);

    await waitFor(() => expect(createAgent).toHaveBeenCalledOnce());
    const input = createAgent.mock.calls[0]?.[0]
      .body as TeamHubTenantAgentCreateInput;
    expect(input.runtime.placement).toEqual({
      computer_id: "computer-jenny-mac",
      runtime_type: "codex",
      type: "local",
      workspace_grant_id: "grant-linger-workspace",
    });
    expect(input.skill_bindings).toEqual([
      {
        manifest_version: "1.0.0",
        name: "Review Changes",
        skill_id: "skill-review-changes",
      },
    ]);
  });

  it("layers the removal control over the card instead of positioning Button itself", async () => {
    // Button hardcodes `relative`, and Tailwind emits `.relative` after
    // `.absolute`, so an `absolute` passed to Button silently loses and the
    // control drops into normal flow below the card. The positioning therefore
    // has to live on a wrapper, and the card has to be the containing block.
    await renderDialog();

    const fromUsers = await screen.findByRole("list", {
      name: "Templates from users",
    });
    const card = within(fromUsers).getAllByRole("listitem")[0]!;
    const remove = within(card).getByRole("button", {
      name: /Remove .* from the marketplace/,
    });

    expect(remove.className).not.toMatch(/\babsolute\b/);
    expect(remove.parentElement?.className).toMatch(/\babsolute\b/);
    expect(card.className).toMatch(/\brelative\b/);
  });

  it("keeps every card the same height with a three-line instruction clamp", async () => {
    // `line-clamp-3` needs `display:-webkit-box`, so a `block` in the same class
    // list silently defeats it: Tailwind emits `.block` after `.line-clamp-3`.
    // The card is a fixed height so long instructions cannot stretch one card
    // past its neighbours or past the skeleton it replaces.
    await renderDialog();

    await screen.findByRole("list", { name: "Official templates" });
    const cards = screen.getAllByRole("listitem");
    expect(cards.length).toBeGreaterThan(1);
    for (const card of cards) {
      expect(card.className).toMatch(/h-\[144px\]/);
      const preview = card.querySelector(".line-clamp-3");
      expect(preview).not.toBeNull();
      expect(preview!.className).not.toMatch(/(^|\s)block(\s|$)/);
    }
  });

  it("shows the template instructions between Name and the Computer", async () => {
    // Instructions say what the Agent will be, which is read before choosing
    // the Computer it runs on, so they sit under Name.
    await renderDialog();

    fireEvent.click(
      await screen.findByRole("button", { name: /Code Reviewer/ }),
    );

    const expectInstructionsUnderName = async () => {
      const instructions = await screen.findByRole("region", {
        name: "Instructions",
      });
      expect(instructions).toHaveTextContent(
        "You are a Code Reviewer working with your Human Sponsor.",
      );
      const name = screen.getByLabelText("Name");
      const placement = await screen.findByRole("combobox", {
        name: "Local Computer",
      });
      // Ordered Name -> Instructions -> Runs on.
      expect(
        name.compareDocumentPosition(instructions) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        instructions.compareDocumentPosition(placement) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    };

    await expectInstructionsUnderName();
  });

  it("confirms removal over the card rather than in its corner", async () => {
    await renderDialog();

    const fromUsers = await screen.findByRole("list", {
      name: "Templates from users",
    });
    const card = within(fromUsers).getAllByRole("listitem")[0]!;
    fireEvent.click(
      within(card).getByRole("button", {
        name: /Remove .* from the marketplace/,
      }),
    );

    const prompt = await within(card).findByText("Remove this template?");
    // The confirmation covers the card it asks about, so it never sits on top
    // of the name the person is deciding on.
    expect(prompt.parentElement?.className).toMatch(/\binset-0\b/);
    expect(within(card).getByRole("button", { name: "Remove" })).toBeVisible();
    expect(within(card).getByRole("button", { name: "Cancel" })).toBeVisible();
  });

  it("lists template Skills this Workspace lacks and copies the shared ones on create", async () => {
    // A published template can reference a Skill that only exists privately in
    // the publisher's Tenant. It is copied on create, and one that cannot be
    // copied still appears in the Skills list, marked, rather than in a note.
    const shared = {
      manifest_version: "1.0.0",
      name: "debug-linger-runtime-incidents",
      skill_id: "skill_publisher_private",
    };
    const gone = {
      manifest_version: "1.0.0",
      name: "retired-notes",
      skill_id: "skill_gone",
    };
    const template: TeamHubAgentTemplate = {
      routines: [],
      connector_bindings: [],
      created_at: "2026-09-24T10:00:00.000Z",
      description: "Debugs CI Agents.",
      instructions: "You are Leo.",
      name: "Another Leo",
      origin: "published",
      published_by: {
        display_name: "leo",
        id: "actor-leo",
        kind: "human",
        tenant_id: "tenant-elsewhere",
      },
      skill_bindings: [shared, gone],
      template_id: "agent_template_leo",
      updated_at: "2026-09-24T10:00:00.000Z",
    };
    const copy = {
      manifest_version: "1.0.0",
      name: shared.name,
      skill_id: "skill_copy",
    };
    const importAgentTemplateSkills = vi.fn(() => ({
      items: [
        { skill: copy, source: shared, status: "imported" },
        { source: gone, status: "unavailable" },
      ],
    }));
    const { createAgent } = await renderDialog((runtime) => {
      runtime.server
        .on(
          "POST",
          "/v0/tenants/{tenantId}/agent-templates/{templateId}/skill-imports",
          importAgentTemplateSkills,
        )
        .on(
          "GET",
          "/v0/tenants/{tenantId}/agent-templates/{templateId}/skill-imports",
          () => ({
            items: [
              { source: shared, status: "importable" },
              { source: gone, status: "unavailable" },
            ],
          }),
        )
        .on("GET", "/v0/tenants/{tenantId}/agent-templates", () => ({
          items: [template],
        }));
    });

    fireEvent.click(await screen.findByRole("button", { name: /Another Leo/ }));
    const skills = await screen.findByRole("region", { name: "Skills" });
    expect(
      within(skills).getByText(shared.name).closest("li"),
    ).toHaveTextContent("Added to your Skills");
    const missing = within(skills).getByText("retired-notes").closest("li")!;
    expect(missing).toHaveAttribute("aria-disabled", "true");
    expect(missing).toHaveTextContent("Not available here");
    // Only the Skill the Agent will actually get is counted.
    expect(within(skills).getByText("1")).toBeVisible();
    expect(screen.queryByText(/and skipped/)).toBeNull();

    const submit = screen.getByRole("button", { name: "Create Agent" });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);

    await waitFor(() => expect(createAgent).toHaveBeenCalledOnce());
    expect(importAgentTemplateSkills).toHaveBeenCalledWith(
      expect.objectContaining({
        params: {
          templateId: "agent_template_leo",
          tenantId: "tenant-northstar",
        },
      }),
    );
    expect(
      (createAgent.mock.calls[0]?.[0].body as TeamHubTenantAgentCreateInput)
        .skill_bindings,
    ).toEqual([copy]);
  });

  it("returns to the template list from the setup step", async () => {
    await renderDialog();

    fireEvent.click(
      await screen.findByRole("button", { name: /Code Reviewer/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Back to templates" }));

    expect(
      await screen.findByRole("list", { name: "Official templates" }),
    ).toBeVisible();
  });
});

async function renderDialog(
  configure: (runtime: TestTeamHubRuntime) => void = () => {},
) {
  const runtime = createTestTeamHubRuntime();
  const createAgent = vi.fn((_request: TestRouteRequest) => ({
    actor: {
      created_at: "2026-09-21T10:00:00.000Z",
      display_name: "PR Reviewer",
      id: "actor-from-template",
      kind: "agent",
      tenant_id: "tenant-northstar",
    },
  }));
  runtime.server.on("POST", "/v0/tenants/{tenantId}/agents", createAgent);
  configure(runtime);
  const onCreated = vi.fn();
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TeamHubRuntimeProvider runtime={runtime}>
        <CreateAgentFromTemplateDialog
          onClose={vi.fn()}
          onCreated={onCreated}
          tenantId="tenant-northstar"
        />
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
  return { createAgent, onCreated };
}
