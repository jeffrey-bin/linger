import type { CommentData } from "@blocknote/core/comments";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { TeamHubActorRef } from "@/features/teamhub/teamhub-types";
import { commentBodyFromComposition } from "./room-document-comment-body";
import { RoomDocumentCommentRow } from "./room-document-comment-row";
import type { TeamHubDocumentThreadStore } from "./room-document-comments";

const author: TeamHubActorRef = {
  id: "agent-reviewer",
  tenant_id: "tenant_1",
  kind: "agent",
  display_name: "Reviewer",
};
const human: TeamHubActorRef = {
  id: "human-alice",
  tenant_id: "tenant_1",
  kind: "human",
  display_name: "Alice",
};

function renderComment(body: string) {
  const comment: CommentData = {
    type: "comment",
    id: "comment_1",
    userId: author.id,
    createdAt: new Date("2026-09-20T00:00:00Z"),
    updatedAt: new Date("2026-09-20T00:00:00Z"),
    reactions: [],
    body: commentBodyFromComposition({ body, files: [], mentions: [human] }),
    metadata: { author },
  };
  const threadStore = {
    auth: {
      canDeleteReaction: () => false,
      canAddReaction: () => false,
      canUpdateComment: () => false,
      canDeleteComment: () => false,
    },
  } as unknown as TeamHubDocumentThreadStore;
  return render(
    <RoomDocumentCommentRow
      actors={
        new Map([
          [author.id, author],
          [human.id, human],
        ])
      }
      comment={comment}
      mentionOptions={[human]}
      threadId="thread_1"
      threadStore={threadStore}
    />,
  );
}

describe("Document comment Markdown", () => {
  it("renders Agent Markdown with the Room message renderer and retains structured mentions", () => {
    const { container } = renderComment(
      "@Alice **Check passed**\n\n- First item\n- Second item\n\n> A quote\n\n```ts\nconst ready = true;\n```\n\n| Item | Status |\n| --- | --- |\n| Review | Done |",
    );
    expect(screen.getByText("Check passed").tagName).toBe("STRONG");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("table")).toBeVisible();
    expect(container.querySelector("blockquote")).toHaveTextContent("A quote");
    expect(container.querySelector("pre code")).toHaveTextContent(
      "const ready = true;",
    );
    expect(container.querySelector("mark")).toHaveTextContent("@Alice");
  });

  it("keeps the existing safe Markdown boundary for comment links and raw HTML", () => {
    const { container } = renderComment(
      "[Safe link](https://example.com) [Unsafe](javascript:alert%281%29) <img src=x onerror=alert(1)>",
    );
    expect(screen.getByRole("link", { name: "Safe link" })).toHaveAttribute(
      "href",
      "https://example.com",
    );
    expect(
      container
        .querySelector(".room-document-comment-body")
        ?.querySelector('a[href^="javascript:"], img, script'),
    ).toBeNull();
  });
});
