import { describe, expect, it } from "vitest";
import { renderAcceptedNotification } from "../../../src/agent/prompt/accepted-notification.js";
import { contributeInboxNotificationContext } from "../../../src/agent/agent-features/notification-context/index.js";

describe("accepted Room notification", () => {
  it("restores body, context IDs and exact resource identities without message files", () => {
    const rendered = renderAcceptedNotification({
      notificationRender: {
        template: "{{message_previews}}",
        agentName: "A",
        triggeredAt: "now",
      },
      acceptedNotification: {
        inboxId: "thread:thread-a",
        cursorEncoding: "room_event_v1",
        after: "7",
        through: "19",
        messages: [
          {
            id: "request-a",
            body: "Compare the reports",
            author: "Human",
            mentioned: true,
            contextMessageIds: ["previous-request"],
            resourceReferences: [
              { type: "document", content: "report", document_id: "doc-a" },
              {
                type: "file",
                content: "report",
                document_id: "doc-b",
                document_version_id: "version-b",
              },
            ],
          },
        ],
      },
    });
    expect(rendered.rawMessage).toContain("request-a");
    expect(rendered.rawMessage).toContain("Compare the reports");
    expect(rendered.rawMessage).toContain("previous-request");
    expect(rendered.rawMessage).toContain("teamhub message read --message-ids");
    expect(rendered.rawMessage).toContain("doc-a");
    expect(rendered.rawMessage).toContain("version-b");
    expect(rendered.rawMessage).not.toMatch(
      /messages\.(md|json)|meta\.(md|json)|#12|Last handled/,
    );
    expect(rendered.documentReferences).toEqual([
      { documentId: "doc-a" },
      { documentId: "doc-b", documentVersionId: "version-b" },
    ]);
  });

  it("rebuilds the trusted team.md reminder after a queued Run resumes", () => {
    const published = renderAcceptedNotification(
      {
        acceptedNotification: {
          inboxId: "room:r",
          after: "1",
          through: "2",
          messages: [
            {
              id: "announcement-1",
              body: "Protocol published",
              author: "Agent",
              mentioned: true,
              teamProtocol: "fan-out-and-synthesize",
            },
          ],
        },
      },
      contributeInboxNotificationContext,
    );
    expect(published.rawMessage).toContain(
      "Collaboration protocol published (fan-out-and-synthesize). Read the current protocol with teamhub room protocol before you act.",
    );
  });
});
