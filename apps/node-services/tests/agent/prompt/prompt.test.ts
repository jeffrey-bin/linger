import { describe, expect, it } from "vitest";

import {
  DEFAULT_INBOX_PROMPT_TEMPLATE,
  renderInboxNotificationPrompt,
} from "../../../src/agent/prompt/index.js";

describe("Inbox notification prompts", () => {
  it("keeps routing policy in role instructions and the notification payload compact", () => {
    expect(DEFAULT_INBOX_PROMPT_TEMPLATE).toContain("{{inbox_updates}}");
    expect(DEFAULT_INBOX_PROMPT_TEMPLATE).toContain(
      "Use the messages shown above when they provide enough context",
    );
    expect(DEFAULT_INBOX_PROMPT_TEMPLATE).toContain(
      "not already represented in your current context",
    );
    expect(DEFAULT_INBOX_PROMPT_TEMPLATE).toContain(
      "Read earlier messages only when they may affect your response",
    );
    expect(DEFAULT_INBOX_PROMPT_TEMPLATE).not.toContain(
      "Read the full conversation",
    );
    expect(DEFAULT_INBOX_PROMPT_TEMPLATE).not.toContain(
      "Respond to direct mentions",
    );
    expect(DEFAULT_INBOX_PROMPT_TEMPLATE).not.toContain(
      "teamhub message direct",
    );
  });

  it("renders typed template variables", () => {
    expect(
      renderInboxNotificationPrompt(
        "{{agent_name}}|{{changed_inbox_count}}|{{changed_inboxes}}|{{triggered_at}}",
        {
          agent_name: "Reviewer",
          changed_inbox_count: "2",
          changed_inboxes: "inbox-a\ninbox-b",
          triggered_at: "2026-08-17T00:00:00.000Z",
        },
      ),
    ).toBe("Reviewer|2|inbox-a\ninbox-b|2026-08-17T00:00:00.000Z");
  });
});
