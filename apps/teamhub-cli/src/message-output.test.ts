import { describe, expect, it } from "vitest";
import {
  renderMessageRead,
  renderMessageSearch,
  renderMessageDirect,
  renderMessageSequence,
  renderMessageSend,
} from "./message-output.js";
const message = {
  message_id: "message_one",
  inbox_id: "task:task.with:colon",
  author: "Alice",
  author_actor_id: "actor_alice",
  author_kind: "human",
  created_at: "2026-10-13T08:00:00Z",
  body: "Complete\nbody",
  segments: [{ type: "text", content: "Complete\nbody" }],
  context_message_ids: ["message_old", "message_hidden"],
  context_messages: [
    {
      message_id: "message_old",
      author: "Bob",
      body: 'Line\nwith tabs\tand "quotes"',
    },
  ],
  resource_references: [{ document_id: "document_one" }],
};
describe("message output", () => {
  it("shows complete content, direct reply context and explicit unavailable IDs", () => {
    const result = renderMessageRead({
      mode: "messages",
      requested_message_ids: ["message_one", "message_missing"],
      messages: [message],
      unavailable_message_ids: ["message_missing"],
      has_more: false,
    });
    expect(result).toContain("1 of 2 messages");
    expect(result).toContain("Target: --inbox task:task.with:colon");
    expect(result).toContain(
      'reply to message_id="message_old" Bob: "Line\\nwith tabs\\tand \\"quotes\\""'.replace(
        '\\"quotes',
        '\\"quotes',
      ),
    );
    expect(result).toContain(
      'reply to message_id="message_hidden" [unavailable]',
    );
    expect(result).toContain('Unavailable message IDs: ["message_missing"]');
    expect(result).not.toContain("Has more");
  });
  it("retains Thread root with no replies and pagination", () => {
    const result = renderMessageRead({
      mode: "inbox",
      root: message,
      messages: [],
      has_more: false,
    });
    expect(result).toContain("Root");
    expect(result).toContain("No replies found.");
    expect(result).toContain("Has more: no");
  });
  it("prints unchanged search and explicit Inbox filters without changing JSON", () => {
    const response = { messages: [], has_more: false };
    expect(
      renderMessageSearch(response, {
        query: " Query %_ ",
        inbox_ids: ["meta:actor_a:task_a"],
      }),
    ).toContain("Query:  Query %_ ");
    expect(renderMessageSearch(response, { query: "Q" })).toContain(
      "Inboxes: all authorized",
    );
    expect(response).toEqual({ messages: [], has_more: false });
  });
  it("keeps every direct ID and says queued for sequences", () => {
    const direct = renderMessageDirect({
      inbox_id: "room:room_sponsor",
      message_ids: ["message_a", "message_b"],
      room_created: true,
      duplicate_request: true,
      reason: "Original messages returned.",
    });
    expect(direct).toContain("Already accepted");
    expect(direct).toContain("message_a\n  message_b");
    expect(direct).toContain("Room created  true");
    expect(
      renderMessageSequence({
        inbox_id: "room_example",
        sequence_id: "sequence_one",
        duplicate_request: false,
      }),
    ).toContain("Presentation is queued.");
  });
  it("does not invent duplicate status and retains complete tree resource identities", () => {
    expect(() => renderMessageDirect({ message_ids: [] })).toThrow(
      "duplicate-request",
    );
    const rendered = renderMessageSend({
      target: { type: "room", id: "room_example" },
      message_id: "message_one",
      duplicate_request: false,
      resources: [
        {
          kind: "tree",
          segment_index: 0,
          status: "published",
          publication_group_id: "group_one",
          root_placement_path: "reports",
          file_count: 1,
          directory_count: 0,
          total_bytes: 20,
          documents: [
            {
              relative_path: "nested/report.md",
              document_id: "document_report",
              document_version_id: "version_one",
            },
          ],
        },
      ],
    });
    expect(rendered).toContain(
      "nested/report.md  document_report  version_one",
    );
    expect(rendered).not.toContain("Duplicate request");
  });
});
