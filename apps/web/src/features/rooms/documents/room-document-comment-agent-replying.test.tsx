import type { ThreadData } from "@blocknote/core/comments";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { TeamHubActorRef } from "@/features/teamhub/teamhub-types";

import {
  AGENT_REPLY_WAIT_MS,
  agentsReplyingTo,
  RoomDocumentCommentAgentReplying,
} from "./room-document-comment-agent-replying";

const jenny: TeamHubActorRef = {
  display_name: "Jenny",
  id: "actor-jenny",
  kind: "human",
  tenant_id: "tenant-a",
};
const codex: TeamHubActorRef = {
  display_name: "Codex",
  id: "actor-codex",
  kind: "agent",
  tenant_id: "tenant-a",
};
const actors = new Map([jenny, codex].map((actor) => [actor.id, actor]));

function comment(
  id: string,
  author: TeamHubActorRef,
  mention: TeamHubActorRef | null,
  createdAt: Date,
) {
  return {
    body: [
      {
        content: [
          { text: "please look ", type: "text" },
          ...(mention
            ? [
                {
                  props: { actorId: mention.id, label: mention.display_name },
                  type: "mention",
                },
              ]
            : []),
        ],
        type: "paragraph",
      },
    ],
    createdAt,
    id,
    reactions: [],
    type: "comment",
    updatedAt: createdAt,
    userId: author.id,
  };
}

function thread(
  comments: ReturnType<typeof comment>[],
  resolved = false,
): ThreadData {
  return {
    comments,
    createdAt: new Date(0),
    deletedAt: undefined,
    id: "thread-1",
    metadata: {},
    resolved,
    type: "thread",
    updatedAt: new Date(0),
  } as unknown as ThreadData;
}

describe("Agent replying in a comment thread", () => {
  const now = Date.parse("2026-09-24T10:00:00Z");
  const recent = new Date(now - 30_000);

  it("waits on an Agent @mentioned in the latest comment", () => {
    expect(
      agentsReplyingTo(
        thread([comment("c1", jenny, codex, recent)]),
        actors,
        now,
      ),
    ).toEqual([codex]);
  });

  it("stops once the Agent's reply is the latest comment", () => {
    expect(
      agentsReplyingTo(
        thread([
          comment("c1", jenny, codex, recent),
          comment("c2", codex, null, new Date(now - 5_000)),
        ]),
        actors,
        now,
      ),
    ).toEqual([]);
  });

  it("ignores Human mentions, resolved threads, and long-silent Agents", () => {
    expect(
      agentsReplyingTo(
        thread([comment("c1", jenny, jenny, recent)]),
        actors,
        now,
      ),
    ).toEqual([]);
    expect(
      agentsReplyingTo(
        thread([comment("c1", jenny, codex, recent)], true),
        actors,
        now,
      ),
    ).toEqual([]);
    expect(
      agentsReplyingTo(
        thread([
          comment(
            "c1",
            jenny,
            codex,
            new Date(now - AGENT_REPLY_WAIT_MS - 1_000),
          ),
        ]),
        actors,
        now,
      ),
    ).toEqual([]);
  });

  it("announces the reply with the wave dots and shimmering label", () => {
    render(
      <RoomDocumentCommentAgentReplying
        actors={actors}
        anchorText="Hi there"
        thread={thread([comment("c1", jenny, codex, new Date())])}
      />,
    );
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Codex is replying");
    expect(status.querySelectorAll(".agent-replying-dots > span")).toHaveLength(
      3,
    );
    expect(status.querySelector(".agent-replying-label")).not.toBeNull();
  });

  it("stops as soon as the Agent's edit reaches the anchored text", () => {
    const asked = thread([comment("c1", jenny, codex, new Date())]);
    const { rerender } = render(
      <RoomDocumentCommentAgentReplying
        actors={actors}
        anchorText="Hi there"
        thread={asked}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Codex is replying");
    rerender(
      <RoomDocumentCommentAgentReplying
        actors={actors}
        anchorText="Hello"
        thread={asked}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
    // A new request waits again from the text as it now stands.
    rerender(
      <RoomDocumentCommentAgentReplying
        actors={actors}
        anchorText="Hello"
        thread={thread([
          comment("c1", jenny, codex, new Date()),
          comment("c2", codex, null, new Date()),
          comment("c3", jenny, codex, new Date()),
        ])}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Codex is replying");
  });
});
