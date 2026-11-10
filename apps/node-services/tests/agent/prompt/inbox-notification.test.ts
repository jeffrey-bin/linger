import { describe, expect, it } from "vitest";

import {
  DEFAULT_INBOX_PROMPT_TEMPLATE,
  renderInboxNotificationPrompt,
} from "../../../src/agent/prompt/index.js";

describe("Inbox notification message previews", () => {
  it("pairs each Inbox summary with its previews in the compact default", () => {
    expect(DEFAULT_INBOX_PROMPT_TEMPLATE).toContain("{{inbox_updates}}");
    expect(DEFAULT_INBOX_PROMPT_TEMPLATE).not.toContain(
      "Respond to direct mentions",
    );
    expect(
      renderInboxNotificationPrompt(DEFAULT_INBOX_PROMPT_TEMPLATE, {
        agent_name: "Reviewer",
        changed_inbox_count: "1",
        changed_inboxes: `- Inbox room-1
  New messages for you: 1`,
        message_previews: `  Showing all 1 new message:
    message-5 Alice: "Latest"

`,
        triggered_at: "2026-08-26T00:00:00.000Z",
      }),
    ).toBe(`Inbox updates are available:
- Inbox room-1
  New messages for you: 1
  Showing all 1 new message:
    message-5 Alice: "Latest"

Use the messages shown above when they provide enough context. If more context is needed, use teamhub message read or teamhub message search to read history that is not already represented in your current context. Read earlier messages only when they may affect your response. Follow your role instructions.`);
  });
});
