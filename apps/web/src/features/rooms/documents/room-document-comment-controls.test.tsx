import type { ThreadData } from "@blocknote/core/comments";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RoomDocumentCommentThread } from "./room-document-comment-thread";
import type { TeamHubDocumentThreadStore } from "./room-document-comments";

const alice = {
  display_name: "Alice",
  id: "actor_alice",
  kind: "human" as const,
  tenant_id: "tenant_acme",
};

const thread: ThreadData = {
  comments: [
    {
      body: [
        {
          content: [{ styles: {}, text: "Visible comment", type: "text" }],
          id: "comment_block_1",
          props: {},
          type: "paragraph",
        },
      ],
      createdAt: new Date("2026-08-03T00:00:00Z"),
      id: "comment_1",
      metadata: {},
      reactions: [],
      type: "comment",
      updatedAt: new Date("2026-08-03T00:00:00Z"),
      userId: alice.id,
    },
  ],
  createdAt: new Date("2026-08-03T00:00:00Z"),
  id: "thread_1",
  metadata: {},
  resolved: false,
  type: "thread",
  updatedAt: new Date("2026-08-03T00:00:00Z"),
};

const threadStore = {
  addComment: vi.fn(),
  addReaction: vi.fn(),
  auth: {
    canAddComment: () => true,
    canAddReaction: vi.fn(() => true),
    canDeleteComment: () => true,
    canDeleteReaction: vi.fn(() => false),
    canResolveThread: () => true,
    canUnresolveThread: () => true,
    canUpdateComment: () => true,
  },
  deleteComment: vi.fn(),
  deleteReaction: vi.fn(),
  resolveThread: vi.fn(),
  unresolveThread: vi.fn(),
  updateComment: vi.fn(),
} as unknown as TeamHubDocumentThreadStore;

function openReply() {
  return screen.getByLabelText("Reply to Document comment");
}

describe("Room Document Comment controls", () => {
  it("does not show an attachment warning while a saved comment anchor is syncing", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RoomDocumentCommentThread
          mentionOptions={[alice]}
          onFocus={vi.fn()}
          orphaned={false}
          referenceText="selected text"
          selected
          thread={{ ...thread, metadata: { anchorStatus: "pending" } }}
          threadStore={threadStore}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Visible comment")).toBeVisible();
    expect(screen.queryByText("Comment attachment is pending.")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Retry (attachment|linking)/ }),
    ).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers a text-link retry only after a real anchor attachment failure", async () => {
    const attachSelectionAnchor = vi.fn().mockResolvedValue(undefined);
    const store = {
      ...threadStore,
      attachSelectionAnchor,
    } as unknown as TeamHubDocumentThreadStore;
    const view = render(
      <QueryClientProvider client={new QueryClient()}>
        <RoomDocumentCommentThread
          mentionOptions={[alice]}
          onFocus={vi.fn()}
          orphaned={false}
          referenceText="selected text"
          selected
          thread={{
            ...thread,
            metadata: {
              anchorStatus: "pending",
              attachmentError: "Connection unavailable",
            },
          }}
          threadStore={store}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Comment saved");
    fireEvent.click(screen.getByRole("button", { name: "Retry linking" }));
    await waitFor(() =>
      expect(attachSelectionAnchor).toHaveBeenCalledWith(thread.id),
    );
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <RoomDocumentCommentThread
          mentionOptions={[alice]}
          onFocus={vi.fn()}
          orphaned={false}
          referenceText="selected text"
          selected
          thread={{ ...thread, metadata: { anchorStatus: "attached" } }}
          threadStore={store}
        />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "selected text" })).toBeEnabled();
  });

  it("uses the server author when absent from member and mention directories", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RoomDocumentCommentThread
          mentionOptions={[]}
          onFocus={vi.fn()}
          orphaned={false}
          referenceText="selected text"
          selected
          threadStore={threadStore}
          thread={{
            ...thread,
            comments: [{ ...thread.comments[0]!, metadata: { author: alice } }],
          }}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Alice")).toBeVisible();
    expect(screen.queryByText(alice.id)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Resolve comment" }),
    ).not.toBeInTheDocument();
  });

  it("resolves historical authors independently from mention candidates", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RoomDocumentCommentThread
          actorDirectory={[alice]}
          mentionOptions={[]}
          onFocus={vi.fn()}
          orphaned={false}
          referenceText="selected text"
          selected
          thread={thread}
          threadStore={threadStore}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Alice")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Edit comment" }));
    expect(screen.getByLabelText("Edit comment by Alice")).toBeVisible();
  });

  it("supports comment deletion, editing, and replies", async () => {
    vi.mocked(threadStore.addComment).mockClear();
    const queryClient = new QueryClient();
    const view = render(
      <QueryClientProvider client={queryClient}>
        <RoomDocumentCommentThread
          mentionOptions={[alice]}
          onFocus={vi.fn()}
          orphaned={false}
          referenceText="selected text"
          selected
          thread={thread}
          threadStore={threadStore}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Visible comment")).toBeVisible();
    expect(screen.getByRole("button", { name: "Edit comment" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Delete comment" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /reaction/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Comment thread actions" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Choose message attachments"),
    ).not.toBeInTheDocument();
    const reply = openReply();
    fireEvent.change(reply, {
      target: { selectionStart: 4, value: "@Ali" },
    });
    fireEvent.click(screen.getByRole("option", { name: /Alice/ }));
    fireEvent.keyDown(reply, { key: "Enter" });

    await waitFor(() =>
      expect(threadStore.addComment).toHaveBeenCalledWith({
        comment: {
          body: [
            {
              content: [
                {
                  props: { actorId: alice.id, label: "@Alice" },
                  type: "mention",
                },
              ],
              props: {},
              type: "paragraph",
            },
          ],
        },
        threadId: thread.id,
      }),
    );

    view.rerender(
      <QueryClientProvider client={queryClient}>
        <RoomDocumentCommentThread
          mentionOptions={[alice]}
          onFocus={vi.fn()}
          orphaned
          referenceText="selected text"
          selected
          thread={thread}
          threadStore={threadStore}
        />
      </QueryClientProvider>,
    );
    expect(
      screen.queryByRole("button", { name: "Re-anchor comment" }),
    ).not.toBeInTheDocument();

    view.rerender(
      <QueryClientProvider client={queryClient}>
        <RoomDocumentCommentThread
          mentionOptions={[alice]}
          onFocus={vi.fn()}
          orphaned={false}
          referenceText="selected text"
          selected
          thread={{ ...thread, resolved: true }}
          threadStore={threadStore}
        />
      </QueryClientProvider>,
    );
    expect(
      screen.queryByLabelText("Reply to Document comment"),
    ).not.toBeInTheDocument();
  });

  it("confirms an edit from the composer footer and cancels back to the body", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RoomDocumentCommentThread
          actorDirectory={[alice]}
          mentionOptions={[]}
          onFocus={vi.fn()}
          orphaned={false}
          referenceText="selected text"
          selected
          thread={thread}
          threadStore={threadStore}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit comment" }));
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Visible comment")).toBeVisible();
  });

  it("keeps a failed reply visible as a durable inline error", async () => {
    vi.mocked(threadStore.addComment)
      .mockReset()
      .mockRejectedValueOnce(new Error("Reply could not be saved."));
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RoomDocumentCommentThread
          mentionOptions={[alice]}
          onFocus={vi.fn()}
          orphaned={false}
          referenceText="selected text"
          selected
          thread={thread}
          threadStore={threadStore}
        />
      </QueryClientProvider>,
    );

    const reply = openReply();
    fireEvent.change(reply, { target: { value: "Please review" } });
    fireEvent.keyDown(reply, { key: "Enter" });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Reply could not be saved.",
    );
  });
});
