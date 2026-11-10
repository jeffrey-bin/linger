import { describe, expect, it } from "vitest";
import { renderAcceptedNotification } from "../../../src/agent/prompt/accepted-notification.js";
import { renderDirectMessagePreviews } from "../../../src/agent/prompt/inbox-notification.js";

describe("direct message previews", () => {
  it("shows stable IDs, retains references and supplies CLI reads when a document is not materialized", () => {
    const output = renderDirectMessagePreviews({
      messages: [
        {
          id: "message-a",
          author: "Alice",
          body: "review",
          mentioned: true,
          contextMessageIds: ["message-context"],
          resourceReferences: [
            { type: "document", content: "report", document_id: "doc-a" },
          ],
        },
      ],
    });
    expect(output).toContain("message-a");
    expect(output).toContain("message-context");
    expect(output).toContain(`teamhub message read --message-ids <message_id>`);
    expect(output).toContain("teamhub docs get");
    expect(output).toContain("doc-a");
    expect(output).not.toMatch(/#\d/u);
  });

  it("lists omitted messages by ID and retains an older explicit context request", () => {
    const output = renderDirectMessagePreviews({
      messages: Array.from({ length: 8 }, (_, index) => ({
        id: `message-${index}`,
        author: "Alice",
        body: `body-${index}`,
        mentioned: false,
        contextMessageIds: index === 0 ? ["earlier-context"] : [],
      })),
    });
    expect(output).toContain("body-0");
    expect(output).not.toContain("body-1");
    expect(output).toContain("message-1");
    expect(output).toContain("teamhub message read --message-ids");
  });

  it("carries stable Document IDs for execution-time authorization", () => {
    const message = renderAcceptedNotification({
      messageId: "notification-1",
      rawMessage: "",
      segments: [{ type: "text", content: "" }],
      acceptedNotification: {
        inboxId: "room:room",
        cursorEncoding: "room_event_v1",
        after: "0",
        through: "8",
        messages: [
          {
            id: "message-a",
            sequence: "2",
            body: "review",
            author: "Alice",
            mentioned: true,
            resourceReferences: [
              {
                type: "file",
                content: "report",
                document_id: "doc-ready",
                document_version_id: "v1",
              },
            ],
          },
        ],
      },
    });
    expect(message.documentReferences).toEqual([
      { documentId: "doc-ready", documentVersionId: "v1" },
    ]);
  });
});
