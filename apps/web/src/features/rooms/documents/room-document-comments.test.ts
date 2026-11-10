import { describe, expect, it, vi } from "vitest";

import { createHttpTeamHubClient } from "@/features/teamhub/teamhub-client";
import type { TeamHubDocumentCommentThread } from "@/features/teamhub/teamhub-types";
import {
  teamHubErrorResponse,
  TeamHubTestServer,
  type TestRouteRequest,
} from "@/test/teamhub-test-server";

import { createTeamHubDocumentThreadStore } from "./room-document-comments";
import { commentBodyFromComposition } from "./room-document-comment-body";
import {
  commentResponse,
  commentThreadResponse,
} from "./document-comment-test-data";

describe("Room Document Comment ThreadStore", () => {
  it("leaves the native Room comment wake to the atomic comment command", async () => {
    const createRoomDocumentCommentThread = vi.fn(() => threadFixture());
    const server = new TeamHubTestServer().on(
      "POST",
      "/v0/documents/{documentId}/comment-threads",
      createRoomDocumentCommentThread,
    );
    const store = createTeamHubDocumentThreadStore({
      currentActorId: "actor_human_1",
      documentId: "document_1",
      getDurableHead: durableHead,
      getCurrentAnchor: () => ({
        block_id: "block_1",
        context_after: "after",
        context_before: "before",
        quoted_text: "selected text",
      }),
      client: testClient(server),
      currentContext: { binding_kind: "room", context_id: "room_1" },
      attachSelectionAnchors: false,
    });
    await store.createThread({
      initialComment: {
        body: commentBodyFromComposition({
          body: "Review this",
          files: [],
          mentions: [],
        }),
      },
    });
    expect(createRoomDocumentCommentThread).toHaveBeenCalledOnce();
  });

  it("preserves the Room mention selection as a BlockNote mention node", () => {
    expect(
      commentBodyFromComposition({
        body: "Ask @Maya Chen today",
        files: [],
        mentions: [
          {
            display_name: "Maya Chen",
            id: "actor_human_2",
            kind: "human",
            tenant_id: "tenant_1",
          },
        ],
      }),
    ).toEqual([
      {
        content: [
          { styles: {}, text: "Ask ", type: "text" },
          {
            props: { actorId: "actor_human_2", label: "@Maya Chen" },
            type: "mention",
          },
          { styles: {}, text: " today", type: "text" },
        ],
        props: {},
        type: "paragraph",
      },
    ]);
  });

  it("creates a durable Thread with selection evidence and structured mentions", async () => {
    const durableThread = threadFixture();
    const createRoomDocumentCommentThread = vi.fn(() => durableThread);
    const server = new TeamHubTestServer().on(
      "POST",
      "/v0/documents/{documentId}/comment-threads",
      createRoomDocumentCommentThread,
    );
    const store = createTeamHubDocumentThreadStore({
      client: testClient(server),
      currentContext: { binding_kind: "room", context_id: "room_1" },
      currentActorId: "actor_human_1",
      documentId: "document_1",
      getDurableHead: durableHead,
      getCurrentAnchor: () => ({
        block_id: "block_1",
        context_after: "after",
        context_before: "before",
        quoted_text: "selected text",
      }),
    });
    const observed = vi.fn();
    store.subscribe(observed);

    const created = await store.createThread({
      initialComment: {
        body: [
          {
            content: [
              { styles: {}, text: "Review ", type: "text" },
              {
                props: { actorId: "actor_human_2", label: "Maya" },
                type: "mention",
              },
            ],
            id: "comment_block_1",
            props: {},
            type: "paragraph",
          },
        ],
      },
    });

    expect(createRoomDocumentCommentThread).toHaveBeenCalledOnce();
    expect(createRoomDocumentCommentThread).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { documentId: "document_1" },
        body: {
          anchor: {
            block_id: "block_1",
            context_after: "after",
            context_before: "before",
            quoted_text: "selected text",
          },
          current_context: { binding_kind: "room", context_id: "room_1" },
          initial_comment: {
            segments: [
              { content: "Review ", type: "text" },
              {
                actor_id: "actor_human_2",
                content: "Maya",
                type: "reference",
              },
            ],
          },
          durable_head: durableHead(),
        },
      }),
    );
    expect(created).toMatchObject({
      id: "thread_1",
      metadata: {
        anchorStatus: "pending",
        documentId: "document_1",
      },
      resolved: false,
    });
    expect(created.comments[0]).toMatchObject({
      body: [
        {
          content: [
            { styles: {}, text: "Review ", type: "text" },
            {
              props: { actorId: "actor_human_2", label: "Maya" },
              type: "mention",
            },
          ],
          type: "paragraph",
        },
      ],
      id: "comment_1",
      metadata: { author: durableThread.comments[0]!.author, versionNumber: 1 },
      userId: "actor_human_1",
    });
    expect(store.getThread("thread_1")).toEqual(created);
    expect(observed).toHaveBeenLastCalledWith(new Map([["thread_1", created]]));
  });

  it("attaches a read-only selection Thread through the comment-only command", async () => {
    const pending = threadFixture();
    const attached = {
      ...pending,
      anchor_status: "attached" as const,
    };
    const attachDocumentCommentSelectionAnchor = vi.fn(() => ({
      revision_id: "revision_attached",
      status: "attached",
      thread: attached,
    }));
    const server = new TeamHubTestServer()
      .on("POST", "/v0/documents/{documentId}/comment-threads", () => pending)
      .on(
        "POST",
        "/v0/document-comment-threads/{documentCommentThreadId}/anchor-attachments",
        attachDocumentCommentSelectionAnchor,
      );
    const onSelectionAnchorAttached = vi.fn();
    const store = createTeamHubDocumentThreadStore({
      attachSelectionAnchors: true,
      client: testClient(server),
      currentActorId: "actor_human_1",
      documentId: "document_1",
      getDurableHead: durableHead,
      getCurrentAnchor: () => ({
        block_id: "block_1",
        context_after: "after",
        context_before: "before",
        quoted_text: "selected text",
      }),
      onSelectionAnchorAttached,
    });

    const created = await store.createThread({
      initialComment: {
        body: [
          {
            content: [{ styles: {}, text: "Review", type: "text" }],
            props: {},
            type: "paragraph",
          },
        ],
      },
    });

    expect(attachDocumentCommentSelectionAnchor).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { documentCommentThreadId: pending.id },
        body: {
          expected_full_state_fingerprint: durableHead().state_hash,
          expected_persisted_seq: durableHead().persisted_seq,
        },
      }),
    );
    expect(created.metadata).toMatchObject({ anchorStatus: "attached" });
    expect(onSelectionAnchorAttached).toHaveBeenCalledOnce();
  });

  it("keeps a pending read-only Thread retryable after attachment fails", async () => {
    const pending = threadFixture();
    const attached = { ...pending, anchor_status: "attached" as const };
    const attachDocumentCommentSelectionAnchor = vi
      .fn<(request: TestRouteRequest) => unknown>()
      .mockReturnValueOnce(
        teamHubErrorResponse(503, "UNAVAILABLE", "Attach unavailable"),
      )
      .mockReturnValueOnce({
        revision_id: "revision_attached",
        status: "attached",
        thread: attached,
      });
    const server = new TeamHubTestServer()
      .on("POST", "/v0/documents/{documentId}/comment-threads", () => pending)
      .on(
        "POST",
        "/v0/document-comment-threads/{documentCommentThreadId}/anchor-attachments",
        attachDocumentCommentSelectionAnchor,
      );
    const store = createTeamHubDocumentThreadStore({
      attachSelectionAnchors: true,
      client: testClient(server),
      currentActorId: "actor_human_1",
      documentId: "document_1",
      getDurableHead: durableHead,
      getCurrentAnchor: () => pending.anchor,
    });

    const created = await store.createThread({
      initialComment: {
        body: [
          {
            content: [{ styles: {}, text: "Review", type: "text" }],
            props: {},
            type: "paragraph",
          },
        ],
      },
    });
    expect(created.metadata).toMatchObject({
      anchorStatus: "pending",
      attachmentError: "Attach unavailable",
    });
    await store.attachSelectionAnchor(pending.id);

    expect(store.getThread(pending.id).metadata).toMatchObject({
      anchorStatus: "attached",
    });
    // The retry checks the same durable head as the first attempt.
    expect(
      attachDocumentCommentSelectionAnchor.mock.calls[1]?.[0].body,
    ).toEqual(attachDocumentCommentSelectionAnchor.mock.calls[0]?.[0].body);
  });

  it("uses current Comment versions and reloads authoritative reaction state", async () => {
    const initial = threadFixture();
    const reply = commentFixture({ id: "comment_2", versionNumber: 1 });
    const edited = commentFixture({ id: "comment_1", versionNumber: 2 });
    const deleted = {
      ...commentFixture({ id: "comment_1", versionNumber: 3 }),
      body: "",
      deleted_at: "2026-08-01T00:03:00Z",
      segments: [],
    };
    const withReaction = {
      ...initial,
      comments: [
        {
          ...initial.comments[0]!,
          reactions: [
            {
              actor_ids: ["actor_human_1"],
              created_at: "2026-08-01T00:05:00Z",
              emoji: "👍",
            },
          ],
        },
      ],
    };
    const createRoomDocumentCommentReply = vi.fn(() => reply);
    const updateRoomDocumentComment = vi.fn(() => edited);
    const deleteRoomDocumentComment = vi.fn(() => deleted);
    const getRoomDocumentCommentThread = vi
      .fn<(request: TestRouteRequest) => unknown>()
      .mockReturnValueOnce(withReaction)
      .mockReturnValueOnce(initial);
    const server = new TeamHubTestServer()
      .on(
        "POST",
        "/v0/document-comment-threads/{documentCommentThreadId}/comments",
        createRoomDocumentCommentReply,
      )
      .on(
        "PATCH",
        "/v0/document-comments/{documentCommentId}",
        updateRoomDocumentComment,
      )
      .on(
        "DELETE",
        "/v0/document-comments/{documentCommentId}",
        deleteRoomDocumentComment,
      )
      .on(
        "PUT",
        "/v0/document-comments/{documentCommentId}/reactions/{emoji}",
        () => undefined,
      )
      .on(
        "DELETE",
        "/v0/document-comments/{documentCommentId}/reactions/{emoji}",
        () => undefined,
      )
      .on(
        "GET",
        "/v0/document-comment-threads/{documentCommentThreadId}",
        getRoomDocumentCommentThread,
      );
    const store = createTeamHubDocumentThreadStore({
      client: testClient(server),
      currentActorId: "actor_human_1",
      documentId: "document_1",
      getDurableHead: durableHead,
      getCurrentAnchor: () => initial.anchor,
    });
    store.replaceThreads([initial]);
    const body = [
      {
        content: [{ styles: {}, text: "Changed", type: "text" }],
        props: {},
        type: "paragraph",
      },
    ];

    await store.addComment({ comment: { body }, threadId: "thread_1" });
    await store.updateComment({
      comment: { body },
      commentId: "comment_1",
      threadId: "thread_1",
    });
    await store.deleteComment({
      commentId: "comment_1",
      threadId: "thread_1",
    });
    await store.addReaction({
      commentId: "comment_1",
      emoji: "👍",
      threadId: "thread_1",
    });
    expect(
      store.auth.canAddReaction(store.getThread("thread_1").comments[0]!, "👍"),
    ).toBe(false);
    await store.deleteReaction({
      commentId: "comment_1",
      emoji: "👍",
      threadId: "thread_1",
    });

    expect(createRoomDocumentCommentReply).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { documentCommentThreadId: "thread_1" },
        body: {
          durable_head: durableHead(),
          segments: [{ content: "Changed", type: "text" }],
        },
      }),
    );
    expect(updateRoomDocumentComment).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { documentCommentId: "comment_1" },
        body: {
          expected_version: 1,
          durable_head: durableHead(),
          segments: [{ content: "Changed", type: "text" }],
        },
      }),
    );
    expect(deleteRoomDocumentComment).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { documentCommentId: "comment_1" },
        body: { expected_version: 2 },
      }),
    );
    expect(
      server.requestsTo(
        "PUT",
        "/v0/document-comments/{documentCommentId}/reactions/{emoji}",
      ),
    ).toHaveLength(1);
    expect(
      server.requestsTo(
        "DELETE",
        "/v0/document-comments/{documentCommentId}/reactions/{emoji}",
      ),
    ).toHaveLength(1);
    expect(getRoomDocumentCommentThread).toHaveBeenCalledTimes(2);
    expect(
      store.auth.canAddReaction(store.getThread("thread_1").comments[0]!, "👍"),
    ).toBe(true);
  });

  it("uses UI authorization only to mirror TeamHub's Human capabilities", () => {
    const thread = threadFixture();
    const store = createTeamHubDocumentThreadStore({
      client: testClient(new TeamHubTestServer()),
      currentActorId: "actor_human_1",
      documentId: "document_1",
      getDurableHead: durableHead,
      getCurrentAnchor: () => thread.anchor,
    });
    store.replaceThreads([
      {
        ...thread,
        comments: [
          thread.comments[0]!,
          {
            ...thread.comments[0]!,
            author: { ...thread.created_by, id: "actor_human_2" },
            id: "comment_2",
          },
        ],
      },
    ]);
    const projected = store.getThread("thread_1");

    expect(store.auth.canCreateThread()).toBe(true);
    expect(store.auth.canAddComment(projected)).toBe(true);
    expect(store.auth.canResolveThread(projected)).toBe(false);
    expect(store.auth.canUnresolveThread(projected)).toBe(false);
    expect(store.auth.canDeleteThread(projected)).toBe(false);
    expect(store.auth.canUpdateComment(projected.comments[0]!)).toBe(true);
    expect(store.auth.canDeleteComment(projected.comments[0]!)).toBe(true);
    expect(store.auth.canUpdateComment(projected.comments[1]!)).toBe(false);
    expect(store.auth.canDeleteComment(projected.comments[1]!)).toBe(false);
  });

  it("commits new Anchor evidence before an orphaned Thread is marked again", async () => {
    const orphaned = { ...threadFixture(), anchor_status: "orphaned" as const };
    const pending = { ...orphaned, anchor_status: "pending" as const };
    const reanchorRoomDocumentCommentThread = vi.fn(() => pending);
    const server = new TeamHubTestServer().on(
      "POST",
      "/v0/document-comment-threads/{documentCommentThreadId}/anchors",
      reanchorRoomDocumentCommentThread,
    );
    const store = createTeamHubDocumentThreadStore({
      client: testClient(server),
      currentActorId: "actor_human_1",
      documentId: "document_1",
      getDurableHead: durableHead,
      getCurrentAnchor: () => ({
        block_id: "block_2",
        context_after: "new after",
        context_before: "new before",
        quoted_text: "new selection",
      }),
    });
    store.replaceThreads([orphaned]);

    await store.reanchorThread("thread_1");

    expect(reanchorRoomDocumentCommentThread).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { documentCommentThreadId: "thread_1" },
        body: {
          block_id: "block_2",
          context_after: "new after",
          context_before: "new before",
          quoted_text: "new selection",
        },
      }),
    );
    expect(store.getThread("thread_1").metadata).toMatchObject({
      anchorStatus: "pending",
    });
  });

  it("refuses to resolve or reopen a Thread", async () => {
    const store = createTeamHubDocumentThreadStore({
      client: testClient(new TeamHubTestServer()),
      currentActorId: "actor_human_1",
      documentId: "document_1",
      getCurrentAnchor: () => threadFixture().anchor,
      getDurableHead: durableHead,
    });
    store.replaceThreads([threadFixture()]);

    await expect(store.resolveThread()).rejects.toThrow(
      "Document Comment Threads cannot be resolved",
    );
    await expect(store.unresolveThread()).rejects.toThrow(
      "Document Comment Threads cannot be resolved",
    );
    const thread = store.getThread("thread_1");
    expect(store.auth.canResolveThread(thread)).toBe(false);
    expect(store.auth.canUnresolveThread(thread)).toBe(false);
  });
});

function durableHead() {
  return {
    persisted_seq: 7,
    state_hash: "a".repeat(64),
    state_hash_version: 1 as const,
  };
}

function threadFixture(): TeamHubDocumentCommentThread {
  const thread = commentThreadResponse("thread_1", "Review Maya");
  return {
    ...thread,
    anchor: {
      ...thread.anchor,
      kind: "selection",
      block_id: "block_1",
      context_after: "after",
      context_before: "before",
      document_version_id: undefined,
      quoted_text: "selected text",
    },
    anchor_status: "pending",
    comments: [
      {
        ...commentResponse("comment_1", "thread_1", "Review Maya"),
        segments: [
          { content: "Review ", type: "text" },
          { actor_id: "actor_human_2", content: "Maya", type: "reference" },
        ],
      },
    ],
  };
}

function commentFixture(input: { id: string; versionNumber: number }) {
  return {
    ...commentResponse(input.id, "thread_1", "Changed"),
    version_number: input.versionNumber,
  };
}

function testClient(server: TeamHubTestServer) {
  return createHttpTeamHubClient({
    fetchRequest: server.fetch,
    onAuthenticationRequired: () => undefined,
  });
}
