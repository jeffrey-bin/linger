import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DecisionCard, type DecisionMessageCard } from "./decision-card";

type Detail = NonNullable<DecisionMessageCard["runtime_permission"]>;

const sponsor = {
  display_name: "Leo Xing",
  id: "actor_leo",
  kind: "human" as const,
};
const agent = {
  display_name: "Nova",
  id: "actor_nova",
  kind: "agent" as const,
};

const patchDetail: Detail = {
  input:
    '{"command":"*** Begin Patch\\n*** Update File: deploy/prod/values.yaml"}',
  kind: "code",
  patch:
    "*** Update File: deploy/prod/values.yaml\n@@ teamhub:\n-    tag: 0.21.3\n+    tag: 0.22.0",
  rationale: "Changes the production config; the task only asked for staging.",
  title: "Edit deploy/prod/values.yaml",
  tool: "apply_patch",
};

function permissionCard(
  detail: Detail = patchDetail,
  decided?: {
    answer: { decision: "approve" | "deny"; comment?: string };
    expiresAt?: string;
    status: "approved" | "consumed" | "denied";
  },
): DecisionMessageCard {
  const base = {
    card_type: "personal_notice" as const,
    decision_id: "decision_1",
    decision_owner: sponsor,
    intent: "decision_requested" as const,
    kind: "runtime_permission" as const,
    requester: agent,
    runtime_permission: detail,
    title: detail.title,
    version: 1,
  };
  if (!decided) return { ...base, status: "pending" };
  return {
    ...base,
    answer: decided.answer,
    decided_at: "2026-10-24T02:42:00Z",
    decided_by: sponsor,
    ...(decided.expiresAt ? { expires_at: decided.expiresAt } : {}),
    status: decided.status,
    version: 2,
  };
}

function renderCard(
  card: DecisionMessageCard,
  currentActorId = sponsor.id,
  onDecision = vi.fn(),
) {
  render(
    <DecisionCard
      card={card}
      currentActorId={currentActorId}
      messageId="message_1"
      onDecision={onDecision}
      roomId="room_1"
      tenantId="tenant_1"
    />,
  );
  return onDecision;
}

describe("Runtime permission decisions", () => {
  it("heads the box with the title and shows the action as one row that opens to the full call and diff", () => {
    renderCard(permissionCard());

    const box = screen.getByRole("region", { name: "Permission request" });
    expect(
      within(box).getByRole("heading", {
        level: 3,
        name: "Edit deploy/prod/values.yaml",
      }),
    ).toBeVisible();
    expect(document.querySelector(".card-prompt")).toBeNull();
    // The title reads once, as the heading; the row names the tool.
    expect(screen.getAllByText("Edit deploy/prod/values.yaml")).toHaveLength(1);
    const row = screen.getByRole("button", { expanded: false });
    expect(row).toHaveTextContent("apply_patch");
    expect(row).not.toHaveTextContent("Edit deploy/prod/values.yaml");
    expect(row).toHaveTextContent("+1 −1");
    expect(screen.queryByText(/Full call/)).not.toBeInTheDocument();

    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Full call · apply_patch")).toBeInTheDocument();
    expect(
      screen.getByText(/"command": "\*\*\* Begin Patch/),
    ).toBeInTheDocument();
    expect(screen.getByText("Diff · +1 −1")).toBeInTheDocument();
    expect(
      screen.getByText("+    tag: 0.22.0", { normalizer: (text) => text }),
    ).toBeInTheDocument();
  });

  it("shows the title as the heading and the tool in the row without a reason", () => {
    renderCard(permissionCard({ ...patchDetail, rationale: "" }));
    expect(
      screen.getByRole("heading", {
        level: 3,
        name: "Edit deploy/prod/values.yaml",
      }),
    ).toBeVisible();
    expect(document.querySelector(".card-prompt")).toBeNull();
    const row = screen.getByRole("button", { expanded: false });
    expect(row).toHaveTextContent("apply_patch");
    expect(row).not.toHaveTextContent("Edit deploy/prod/values.yaml");
  });

  it("allows once", () => {
    const onDecision = renderCard(permissionCard());
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "approve",
        expectedVersion: 1,
        feedback: undefined,
        requestId: "decision_1",
      }),
    );
  });

  it("denies without a reason", () => {
    const onDecision = renderCard(permissionCard());
    fireEvent.click(screen.getByRole("button", { name: "Don't allow" }));
    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "deny", feedback: undefined }),
    );
  });

  it("turns Don't allow into a reason field and sends the reason with the denial", () => {
    const onDecision = renderCard(permissionCard());
    const actions = screen.getByRole("group", { name: "Approval actions" });

    fireEvent.click(
      within(actions).getByRole("button", { name: "Add a reason" }),
    );
    const reason = screen.getByRole("textbox", { name: "Reason for denying" });
    expect(reason).toHaveFocus();
    // Allow keeps working as a check mark while the field is open.
    const approve = within(actions).getByRole("button", {
      name: "Allow once",
    });
    expect(
      within(approve).queryByText("Allow once", {
        ignore: '[aria-hidden="true"]',
      }),
    ).not.toBeInTheDocument();
    expect(
      within(actions).getByRole("button", { name: "Deny without a reason" }),
    ).toHaveAttribute("aria-pressed", "true");

    fireEvent.change(reason, {
      target: { value: "leave prod alone, change staging first" },
    });
    // Enter that picks an input method candidate does not submit.
    fireEvent.keyDown(reason, {
      isComposing: true,
      key: "Enter",
      keyCode: 229,
    });
    expect(onDecision).not.toHaveBeenCalled();
    fireEvent.keyDown(reason, { key: "Enter" });
    expect(onDecision).toHaveBeenLastCalledWith(
      expect.objectContaining({
        decision: "deny",
        feedback: "leave prod alone, change staging first",
      }),
    );
  });

  it("hides each deny layer on a wrapper, never on a control that dims when disabled", () => {
    renderCard(permissionCard());
    const plain = screen.getByTestId("deny-plain-layer");
    const reason = screen.getByTestId("deny-reason-layer");
    expect(reason).toHaveClass("opacity-0");
    expect(plain).not.toHaveClass("opacity-0");

    fireEvent.click(screen.getByRole("button", { name: "Add a reason" }));
    expect(plain).toHaveClass("opacity-0");
    expect(plain).toHaveAttribute("inert");
    // The Deny button dims while a decision is submitting; if it also carried
    // the hiding opacity, disabled:opacity-45 would win and show it.
    expect(
      within(plain).getByRole("button", {
        hidden: true,
        name: "Don't allow",
      }).className,
    ).not.toMatch(/\bopacity-0\b/);
    expect(reason).not.toHaveClass("opacity-0");
  });

  it("switches back to a plain Don't allow and keeps the draft", () => {
    renderCard(permissionCard());
    fireEvent.click(screen.getByRole("button", { name: "Add a reason" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "Reason for denying" }),
      {
        target: { value: "later" },
      },
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Deny without a reason" }),
    );
    const toggle = screen.getByRole("button", { name: "Continue your reason" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "Allow once" }),
    ).toHaveTextContent("Allow once");

    fireEvent.click(toggle);
    expect(
      screen.getByRole("textbox", { name: "Reason for denying" }),
    ).toHaveValue("later");
  });

  it("shows tips only when their own control is hovered, not the whole message", () => {
    renderCard(permissionCard());
    const tip = screen.getByText("Add a reason");
    // A plain `group` ancestor (the timeline message row) must not reveal it.
    expect(tip.className).toContain("group-hover/tip:opacity-100");
    expect(tip.className).not.toMatch(/(^|\s)group-hover:/);
    expect(
      screen.getByRole("button", { name: "Add a reason" }).className,
    ).toMatch(/(^|\s)group\/tip(\s|$)/);
  });

  it("restyles deny as the soft button with the reason toggle beside it, no red outline", () => {
    renderCard(permissionCard());
    const deny = screen.getByRole("button", { name: "Don't allow" });
    const toggle = screen.getByRole("button", { name: "Add a reason" });
    for (const control of [deny, toggle]) {
      expect(control).toHaveClass("bg-secondary");
      expect(control.className).not.toMatch(/danger/);
    }
    expect(deny).toHaveClass("rounded-l-lg");
    expect(toggle).toHaveClass("rounded-r-lg");
  });

  it("shows other members the box without actions or copy", () => {
    renderCard(permissionCard(), "actor_someone_else");
    expect(
      screen.getByRole("region", { name: "Permission request" }),
    ).toBeVisible();
    expect(
      screen.queryByText(/Waiting for|can decide/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "Approval actions" }),
    ).not.toBeInTheDocument();
  });

  it("puts a done line in place of the actions once decided", () => {
    const future = new Date(Date.now() + 23 * 3600_000).toISOString();
    const past = new Date(Date.now() - 3600_000).toISOString();
    const approve = { decision: "approve" as const };
    const cases: { card: DecisionMessageCard; done: RegExp; tone: string }[] = [
      {
        card: permissionCard(patchDetail, {
          answer: approve,
          expiresAt: future,
          status: "approved",
        }),
        done: /^Allowed once until /,
        tone: "text-app-success",
      },
      {
        card: permissionCard(patchDetail, {
          answer: approve,
          expiresAt: past,
          status: "consumed",
        }),
        done: /^Allowed once · Used$/,
        tone: "text-app-success",
      },
      {
        card: permissionCard(patchDetail, {
          answer: approve,
          expiresAt: past,
          status: "approved",
        }),
        done: /^Expired$/,
        tone: "text-app-muted",
      },
      {
        card: permissionCard(patchDetail, {
          answer: { comment: "leave prod alone", decision: "deny" },
          status: "denied",
        }),
        done: /^Not allowed · “leave prod alone”$/,
        tone: "text-app-muted",
      },
      {
        card: permissionCard(patchDetail, {
          answer: { decision: "deny" },
          status: "denied",
        }),
        done: /^Not allowed$/,
        tone: "text-app-muted",
      },
    ];
    for (const { card, done, tone } of cases) {
      const { unmount } = render(
        <DecisionCard
          card={card}
          currentActorId={sponsor.id}
          messageId="message_1"
          onDecision={vi.fn()}
          roomId="room_1"
          tenantId="tenant_1"
        />,
      );
      const line = screen.getByText(done);
      expect(line.closest("p")?.querySelector("svg")).toHaveClass(tone);
      expect(
        screen.getByRole("heading", {
          level: 3,
          name: "Edit deploy/prod/values.yaml",
        }),
      ).toBeVisible();
      expect(screen.getByRole("button", { expanded: false })).toHaveTextContent(
        "apply_patch",
      );
      expect(
        screen.queryByRole("group", { name: "Approval actions" }),
      ).not.toBeInTheDocument();
      unmount();
    }
  });

  it("shows a GUI action's screenshot to the decision owner only", () => {
    const gui = permissionCard({
      input: '{"target":"e42"}',
      kind: "gui",
      rationale: "Merging puts !2141 into dev.",
      screenshot: {
        height: 800,
        url: "/v0/decisions/decision_1/screenshot",
        width: 1280,
      },
      title: 'Click "Merge" · GitLab (gitlab.example.com)',
      tool: "mcp__browser__browser_click",
    });
    renderCard(gui);
    // The screen shows without opening the row while the card waits.
    const image = screen.getByRole("img", {
      name: "The screen before this action, with its target marked",
    });
    expect(image).toHaveAttribute("src", "/v0/decisions/decision_1/screenshot");
    expect(image).toHaveAttribute("width", "1280");
    fireEvent.error(image);
    expect(
      screen.getByText("The screenshot is no longer available."),
    ).toBeInTheDocument();
  });

  it("tells other members the screenshot is the decision owner's", () => {
    renderCard(
      permissionCard({
        input: "{}",
        kind: "gui",
        rationale: "",
        screenshot: { height: 1, url: "/v0/x/screenshot", width: 1 },
        title: "Click on the desktop",
        tool: "mcp__computer__click",
      }),
      "actor_someone_else",
    );
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(
      screen.getByText("Only Leo Xing can see the screenshot."),
    ).toBeInTheDocument();
  });

  it("shows the page element of a GUI action under Details", () => {
    renderCard(
      permissionCard({
        input: '{"ref":"e42","element":"Merge"}',
        kind: "gui",
        page: {
          target_name: "Merge",
          target_role: "button",
          title: "feat: queue (!2141) · GitLab",
          url: "http://gitlab.example.com/group/repo/-/merge_requests/2141",
        },
        rationale: "Merging puts !2141 into dev.",
        title: 'Click "Merge" · GitLab (gitlab.example.com)',
        tool: "mcp__browser__browser_click",
      }),
    );
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("Page element")).toBeInTheDocument();
    expect(screen.getByText('button "Merge"')).toBeInTheDocument();
    expect(
      screen.getByText(
        "http://gitlab.example.com/group/repo/-/merge_requests/2141",
      ),
    ).toBeInTheDocument();
  });

  it("keeps the review's rationale in view under the summary row", () => {
    renderCard(permissionCard());
    expect(
      screen.getByText(permissionCard().runtime_permission!.rationale),
    ).toBeVisible();
  });
});
