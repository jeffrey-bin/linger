import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DecisionCard, type DecisionMessageCard } from "./decision-card";

type ConnectorView = NonNullable<DecisionMessageCard["connector_write"]>;
type Message = NonNullable<ConnectorView["message"]>;
type AgentView = NonNullable<DecisionMessageCard["agent_change"]>;
interface CardState {
  answer?: { decision: "approve" | "deny"; comment?: string };
  expires_at?: string;
  outcome?: string;
  status?: DecisionMessageCard["status"];
}

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
const later = () => new Date(Date.now() + 23 * 3600_000).toISOString();
const longPrompt = Array.from(
  { length: 12 },
  (_, line) => `Step ${line + 1}: review the sources carefully.`,
).join("\n");

function messageDetail(message: Partial<Message> = {}): ConnectorView {
  return {
    account: "alice@example.com",
    app: "gmail",
    input: '{"recipient_email":"bob@example.com","subject":"Launch"}',
    kind: "message",
    message: { body: "Hello Bob", format: "text", ...message },
    title: "Send an email to bob@example.com",
    tool: "GMAIL_SEND_EMAIL",
  };
}

const changeDetail: ConnectorView = {
  account: "ops@example.com",
  app: "notion",
  fields: [
    { label: "Page", value: "page_123" },
    { label: "Property", value: "Status!Done" },
    { label: "Values", value: '[\n  "Name",\n  "Qty"\n]' },
  ],
  input: '{"page_id":"page_123"}',
  kind: "change",
  title: "Update a Notion page",
  tool: "NOTION_UPDATE_PAGE",
};

function createDetail(): AgentView {
  return {
    action: "create",
    agent_name: "Researcher",
    changes: [
      { after: "Researcher", field: "name" },
      { after: "Finds and checks sources.", field: "description" },
      { after: longPrompt, field: "prompt" },
    ],
  };
}

function updateDetail(): AgentView {
  return {
    action: "update",
    agent_name: "Nova",
    changes: [
      { after: "Nova Prime", before: "Nova", field: "name" },
      { after: "Writes release notes.", before: "", field: "description" },
      {
        after: "Write release notes for each launch.",
        before: "Answer questions.",
        field: "prompt",
      },
    ],
    target_actor_id: "actor_nova",
  };
}

function baseCard(title: string, state: CardState) {
  const { answer, expires_at = later(), outcome, status = "pending" } = state;
  return {
    card_type: "personal_notice" as const,
    decision_id: "decision_1",
    decision_owner: sponsor,
    expires_at,
    intent: "decision_requested" as const,
    requester: agent,
    status,
    title,
    version: answer ? 2 : 1,
    ...(outcome ? { outcome } : {}),
    ...(answer
      ? { answer, decided_at: "2026-10-24T02:42:00Z", decided_by: sponsor }
      : {}),
  };
}

function connectorCard(
  view: ConnectorView = messageDetail(),
  state: CardState = {},
): DecisionMessageCard {
  return {
    ...baseCard(view.title, state),
    connector_write: view,
    kind: "connector_write",
  };
}

function agentCard(
  view: AgentView = createDetail(),
  state: CardState = {},
): DecisionMessageCard {
  const title =
    view.action === "create"
      ? `Create Agent “${view.agent_name}”`
      : `Change Agent “${view.agent_name}”`;
  return {
    ...baseCard(title, state),
    agent_change: view,
    kind: "agent_change",
  };
}

function renderCard(
  card: DecisionMessageCard,
  currentActorId = sponsor.id,
  onDecision = vi.fn(),
) {
  const view = render(
    <DecisionCard
      card={card}
      currentActorId={currentActorId}
      messageId="message_1"
      onDecision={onDecision}
      roomId="room_1"
      tenantId="tenant_1"
    />,
  );
  return { ...view, onDecision };
}

function messagePreview() {
  return screen.getByRole("region", { name: "Message preview" });
}

/** Opens the summary row to the kind's full view. */
function openSummary() {
  fireEvent.click(
    within(
      screen.getByRole("region", { name: /request|Room creation/ }),
    ).getAllByRole("button", { expanded: false })[0]!,
  );
}

describe("DecisionCard", () => {
  it("heads the box with the title and shows the email as one summary row that opens to the message", () => {
    renderCard(
      connectorCard(
        messageDetail({
          attachments: ["plan.pdf", "budget.xlsx"],
          bcc: ["audit@example.com"],
          body: "Hello Bob,\n\nThe launch moves to Friday.",
          cc: ["carol@example.com", "dan@example.com"],
          subject: "Launch date",
          to: ["bob@example.com"],
        }),
      ),
    );

    expect(screen.queryByText(/Asks you|Waiting for/)).not.toBeInTheDocument();
    const box = screen.getByRole("region", { name: "Confirmation request" });
    expect(
      within(box).getByRole("heading", {
        level: 3,
        name: "Send an email to bob@example.com",
      }),
    ).toBeVisible();
    expect(
      screen.getAllByText("Send an email to bob@example.com"),
    ).toHaveLength(1);
    expect(document.querySelector(".card-prompt")).toBeNull();
    const row = within(box).getByRole("button", { expanded: false });
    expect(row).toHaveTextContent("bob@example.com · Launch date");
    expect(row).toHaveTextContent("Gmail · alice@example.com");
    expect(
      screen.queryByRole("region", { name: "Message preview" }),
    ).not.toBeInTheDocument();

    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    const preview = messagePreview();
    for (const [label, value] of [
      ["To", "bob@example.com"],
      ["Cc", "carol@example.com, dan@example.com"],
      ["Bcc", "audit@example.com"],
      ["Subject", "Launch date"],
    ] as const) {
      expect(within(preview).getByText(label)).toBeInTheDocument();
      expect(within(preview).getByText(value)).toBeInTheDocument();
    }
    expect(within(preview).queryByText("Where")).not.toBeInTheDocument();
    expect(
      within(preview).getByText("Hello Bob,\n\nThe launch moves to Friday.", {
        normalizer: (text) => text,
      }),
    ).toHaveClass("whitespace-pre-wrap");
    const attachments = within(preview).getByRole("list", {
      name: "Attachments",
    });
    expect(
      within(attachments)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["plan.pdf", "budget.xlsx"]);
    // The full call stays under Details.
    expect(screen.queryByText(/Full call/)).not.toBeInTheDocument();

    fireEvent.click(row);
    expect(
      screen.queryByRole("region", { name: "Message preview" }),
    ).not.toBeInTheDocument();
  });

  it("names the app by its readable name and falls back to its key", () => {
    const { unmount } = renderCard(
      connectorCard({ ...changeDetail, account: "" }),
    );
    expect(screen.getByText("Notion")).toBeInTheDocument();
    unmount();
    renderCard(connectorCard({ ...changeDetail, account: "me", app: "zoom" }));
    expect(screen.getByText("zoom · me")).toBeInTheDocument();
  });

  it("never repeats the heading's text in the summary row", () => {
    renderCard(connectorCard(changeDetail));
    expect(screen.getAllByText("Update a Notion page")).toHaveLength(1);
    const row = screen.getByRole("button", { expanded: false });
    expect(row).toHaveTextContent("Notion · ops@example.com");
    expect(row).toHaveTextContent("NOTION_UPDATE_PAGE");
  });

  it("renders an HTML body sanitized in a sandboxed frame", () => {
    renderCard(
      connectorCard(
        messageDetail({
          body: '<html><head><style>p{color:red}</style></head><body><p>Hi <b>Bob</b></p><script>alert(1)</script><img src="x" onerror="alert(2)"><a href="javascript:alert(3)">bad</a><a href="https://example.com/doc">doc</a></body></html>',
          format: "html",
        }),
      ),
    );
    openSummary();

    const frame = within(messagePreview()).getByTitle("Message body");
    expect(frame.tagName).toBe("IFRAME");
    const sandbox = frame.getAttribute("sandbox") ?? "";
    expect(sandbox).not.toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-forms");
    const source = frame.getAttribute("srcdoc") ?? "";
    expect(source).toContain("<p>Hi <b>Bob</b></p>");
    expect(source).toContain("p{color:red}");
    expect(source).toContain("Content-Security-Policy");
    expect(source).not.toMatch(/<script|onerror|javascript:/i);
    expect(source).toContain(
      '<a href="https://example.com/doc" target="_blank" rel="noopener noreferrer">doc</a>',
    );
  });

  it("renders a Markdown body with the Room Markdown renderer", () => {
    renderCard(
      connectorCard({
        ...messageDetail({
          body: "Looks **good** to me.\n\n- first\n- second",
          destination: "Issue #3 in project 12",
          format: "markdown",
        }),
        app: "github",
        title: "Comment on GitHub issue #3",
        tool: "GITHUB_CREATE_AN_ISSUE_COMMENT",
      }),
    );
    openSummary();

    const preview = messagePreview();
    expect(within(preview).getByText("Where")).toBeInTheDocument();
    expect(
      within(preview).getByText("Issue #3 in project 12"),
    ).toBeInTheDocument();
    expect(within(preview).getByText("good").tagName).toBe("STRONG");
    expect(
      within(preview)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["first", "second"]);
    expect(within(preview).queryByText(/\*\*/)).not.toBeInTheDocument();
  });

  it("renders Slack mrkdwn as Slack shows it, not as Markdown", () => {
    renderCard(
      connectorCard({
        ...messageDetail({
          body: [
            "*Deploy* is _done_ ~maybe~ with `v2` &amp; more",
            "See <https://example.com/run?a=1&amp;b=2|the run> or <https://example.com/raw>, cc <@U123|alice> <!here>",
            "# not a heading",
            "**not bold in Slack**",
            "&gt; quoted line",
            "```",
            "npm run *deploy*",
            "```",
          ].join("\n"),
          destination: "Slack #releases",
          format: "mrkdwn",
        }),
        app: "slack",
        title: "Share files in Slack",
        tool: "SLACK_UPLOAD_OR_CREATE_A_FILE_IN_SLACK",
      }),
    );
    openSummary();

    const preview = messagePreview();
    expect(within(preview).getByText("Deploy").tagName).toBe("STRONG");
    expect(within(preview).getByText("done").tagName).toBe("EM");
    expect(within(preview).getByText("maybe").tagName).toBe("DEL");
    expect(within(preview).getByText("v2").tagName).toBe("CODE");
    expect(
      within(preview).getByRole("link", { name: "the run" }),
    ).toHaveAttribute("href", "https://example.com/run?a=1&b=2");
    expect(
      within(preview).getByRole("link", { name: "https://example.com/raw" }),
    ).toHaveAttribute("target", "_blank");
    const body = within(preview).getByTestId("message-body");
    expect(body).toHaveTextContent("with v2 & more");
    expect(body).toHaveTextContent("cc @alice @here");
    expect(
      within(preview).queryByRole("heading", { name: /not a heading/ }),
    ).not.toBeInTheDocument();
    expect(body).toHaveTextContent("# not a heading");
    expect(body).toHaveTextContent("**not bold in Slack**");
    expect(within(preview).getByText("quoted line").tagName).toBe("BLOCKQUOTE");
    const code = within(preview).getByText("npm run *deploy*");
    expect(code.tagName).toBe("CODE");
    expect(code.parentElement?.tagName).toBe("PRE");
  });

  it("shows a change's fields, keeping the lines of multi-line values", () => {
    renderCard(connectorCard(changeDetail));
    openSummary();

    expect(
      screen.queryByRole("region", { name: "Message preview" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Page")).toBeInTheDocument();
    expect(screen.getByText("page_123")).toBeInTheDocument();
    expect(screen.getByText("Status!Done").tagName).toBe("SPAN");
    const values = screen.getByText('[\n  "Name",\n  "Qty"\n]', {
      normalizer: (text) => text,
    });
    expect(values.tagName).toBe("PRE");
    expect(values).toHaveClass("font-mono", "whitespace-pre-wrap");
  });

  it("shows the tool and full input under Details", () => {
    renderCard(connectorCard());
    openSummary();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(
      screen.getByText("Full call · GMAIL_SEND_EMAIL"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/"recipient_email": "bob@example.com"/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Hide details" }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("shows a new Agent's name, description, and collapsed instructions", () => {
    renderCard(agentCard());

    expect(
      screen.getByRole("heading", {
        level: 3,
        name: "Create Agent “Researcher”",
      }),
    ).toBeVisible();
    expect(screen.getAllByText("Create Agent “Researcher”")).toHaveLength(1);
    expect(document.querySelector(".card-prompt")).toBeNull();
    const row = screen.getByRole("button", { expanded: false });
    expect(row).toHaveTextContent("New Agent Researcher");
    expect(row).toHaveTextContent("Finds and checks sources.");
    fireEvent.click(row);
    const fields = screen.getByText("Name").closest("dl")!;
    expect(within(fields).getByText("Researcher").tagName).toBe("INS");
    expect(
      within(fields).getByText("Finds and checks sources."),
    ).toBeInTheDocument();
    // A new Agent has nothing to replace.
    expect(fields.querySelector("del")).toBeNull();

    const instructions = screen.getByRole("region", { name: "Instructions" });
    const preview = within(instructions).getByText(/^Step 1:/);
    expect(preview).toHaveClass("line-clamp-4");
    const toggle = screen.getByRole("button", {
      name: "Show full instructions",
    });
    fireEvent.click(toggle);
    expect(preview).not.toHaveClass("line-clamp-4");
    expect(preview).toHaveTextContent("Step 12:");
    expect(screen.getByRole("button", { name: "Create" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Don't create" })).toBeVisible();
  });

  it("shows each current Agent value beside its replacement", () => {
    renderCard(agentCard(updateDetail()));

    expect(
      screen.getByRole("heading", { level: 3, name: "Change Agent “Nova”" }),
    ).toBeVisible();
    expect(screen.getAllByText("Change Agent “Nova”")).toHaveLength(1);
    expect(document.querySelector(".card-prompt")).toBeNull();
    const row = screen.getByRole("button", { expanded: false });
    expect(row).toHaveTextContent("Change Nova");
    expect(row).toHaveTextContent("Name, description, instructions");
    fireEvent.click(row);
    expect(screen.getByText("Nova").tagName).toBe("DEL");
    expect(screen.getByText("Nova Prime").tagName).toBe("INS");
    // An empty description reads as None, not as a blank.
    expect(screen.getByText("None").tagName).toBe("DEL");
    fireEvent.click(
      screen.getByRole("button", { name: "Show full instructions" }),
    );
    expect(
      within(
        screen.getByRole("region", { name: "Current instructions" }),
      ).getByText("Answer questions."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Don't apply" })).toBeVisible();
  });

  it("sends through the decision route", () => {
    const { onDecision } = renderCard(connectorCard());
    expect(screen.getByRole("button", { name: "Send" })).toHaveClass(
      "bg-primary",
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onDecision).toHaveBeenCalledWith({
      decision: "approve",
      expectedVersion: 1,
      feedback: undefined,
      messageId: "message_1",
      requestId: "decision_1",
    });
  });

  it("approves or denies a generic change in plain words", () => {
    const approve = renderCard(connectorCard(changeDetail));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(approve.onDecision).toHaveBeenLastCalledWith(
      expect.objectContaining({ decision: "approve" }),
    );
    approve.unmount();
    const { onDecision } = renderCard(connectorCard(changeDetail));
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onDecision).toHaveBeenLastCalledWith(
      expect.objectContaining({ decision: "deny", feedback: undefined }),
    );
  });

  it("denies with a reason", () => {
    const { onDecision } = renderCard(agentCard());
    fireEvent.click(screen.getByRole("button", { name: "Add a reason" }));
    const reason = screen.getByRole("textbox", { name: "Reason for denying" });
    fireEvent.change(reason, { target: { value: "Wrong recipient" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Deny with this reason" }),
    );
    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "deny",
        expectedVersion: 1,
        feedback: "Wrong recipient",
        requestId: "decision_1",
      }),
    );
  });

  it("shows a failed decision", async () => {
    renderCard(
      connectorCard(),
      sponsor.id,
      vi.fn().mockRejectedValue(new Error("The card changed.")),
    );
    fireEvent.click(screen.getByRole("button", { name: "Don't send" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The card changed.",
    );
  });

  it("shows other members the box without actions or copy", () => {
    renderCard(connectorCard(), "actor_someone_else");
    expect(
      screen.getByRole("region", { name: "Confirmation request" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { expanded: false })).toBeVisible();
    expect(screen.queryByText(/Waiting for|Only /)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "Approval actions" }),
    ).not.toBeInTheDocument();
  });

  it("puts a done line in place of the actions once a request is decided or expired", () => {
    const past = new Date(Date.now() - 3600_000).toISOString();
    const approved = { decision: "approve" as const };
    const cases: {
      card: DecisionMessageCard;
      done: string;
      tone: string;
    }[] = [
      {
        card: connectorCard(messageDetail(), {
          answer: approved,
          status: "approved",
        }),
        done: "Sending…",
        tone: "text-app-muted",
      },
      {
        card: agentCard(createDetail(), {
          answer: approved,
          status: "executing",
        }),
        done: "Creating…",
        tone: "text-app-muted",
      },
      {
        card: agentCard(updateDetail(), {
          answer: approved,
          status: "executing",
        }),
        done: "Applying…",
        tone: "text-app-muted",
      },
      {
        card: connectorCard(messageDetail(), {
          answer: approved,
          status: "succeeded",
        }),
        done: "Sent",
        tone: "text-app-success",
      },
      {
        card: connectorCard(changeDetail, {
          answer: approved,
          status: "succeeded",
        }),
        done: "Done",
        tone: "text-app-success",
      },
      {
        card: agentCard(createDetail(), {
          answer: approved,
          status: "succeeded",
        }),
        done: "Created",
        tone: "text-app-success",
      },
      {
        card: agentCard(updateDetail(), {
          answer: approved,
          status: "succeeded",
        }),
        done: "Applied",
        tone: "text-app-success",
      },
      {
        card: connectorCard(messageDetail(), {
          answer: approved,
          outcome: "The connected account is not active.",
          status: "failed",
        }),
        done: "Failed: The connected account is not active.",
        tone: "text-app-danger",
      },
      {
        card: agentCard(createDetail(), { answer: approved, status: "failed" }),
        done: "Failed",
        tone: "text-app-danger",
      },
      {
        card: connectorCard(messageDetail(), {
          answer: approved,
          outcome: "TeamHub stopped while running this request.",
          status: "unknown",
        }),
        done: "Result unknown: TeamHub stopped while running this request.",
        tone: "text-app-warning",
      },
      {
        card: connectorCard(messageDetail(), {
          answer: { comment: "Wrong recipient", decision: "deny" },
          status: "denied",
        }),
        done: "Not sent · “Wrong recipient”",
        tone: "text-app-muted",
      },
      {
        card: agentCard(createDetail(), {
          answer: { decision: "deny" },
          status: "denied",
        }),
        done: "Not created",
        tone: "text-app-muted",
      },
      {
        card: agentCard(updateDetail(), {
          answer: { decision: "deny" },
          status: "denied",
        }),
        done: "Not applied",
        tone: "text-app-muted",
      },
      {
        card: connectorCard(messageDetail(), {
          expires_at: past,
          status: "expired",
        }),
        done: "Expired",
        tone: "text-app-muted",
      },
      {
        // TeamHub has not expired it yet, but its time is up.
        card: connectorCard(messageDetail(), { expires_at: past }),
        done: "Expired",
        tone: "text-app-muted",
      },
    ];
    for (const { card, done, tone } of cases) {
      const { unmount } = renderCard(card);
      const line = screen.getByText(done);
      expect(line.closest("p")?.querySelector("svg")).toHaveClass(tone);
      // The heading and the collapsed summary row stay.
      expect(
        screen.getByRole("heading", { level: 3, name: card.title }),
      ).toBeVisible();
      expect(document.querySelector(".card-prompt")).toBeNull();
      expect(screen.getByRole("button", { expanded: false })).toBeVisible();
      expect(
        screen.queryByRole("group", { name: "Approval actions" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/approved this|denied this|by Leo/)).toBeNull();
      unmount();
    }
  });
});
