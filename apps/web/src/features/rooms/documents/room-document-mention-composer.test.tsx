import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  RoomDocumentCommentComposer,
  DocumentMentionMessageComposer,
} from "./room-document-comment-composer";

const blockNote = vi.hoisted(() => ({
  createThread: vi.fn(),
  focus: vi.fn(),
  stopPendingComment: vi.fn(),
}));

vi.mock("@blocknote/react", () => ({
  useBlockNoteEditor: () => ({ focus: blockNote.focus }),
  useExtension: () => ({
    createThread: blockNote.createThread,
    stopPendingComment: blockNote.stopPendingComment,
  }),
}));

function renderWithQueryClient(node: ReactNode) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      {node}
    </QueryClientProvider>,
  );
}

function mentionedActorIds(body: unknown): string[] {
  const blocks = body as { content: { props?: { actorId?: string } }[] }[];
  return blocks.flatMap((block) =>
    block.content.flatMap((item) =>
      item.props?.actorId ? [item.props.actorId] : [],
    ),
  );
}

describe("Document comment Agent Mention composer", () => {
  beforeEach(() => {
    blockNote.createThread.mockReset().mockResolvedValue(undefined);
    blockNote.focus.mockReset();
    blockNote.stopPendingComment.mockReset();
  });

  it("posts a structured Agent Mention without an authorization step", async () => {
    const agent = {
      display_name: "Alice Agent",
      id: "actor_agent_alice",
      kind: "agent" as const,
      tenant_id: "tenant_1",
    };
    renderWithQueryClient(
      <RoomDocumentCommentComposer mentionOptions={[agent]} />,
    );
    const editor = screen.getByLabelText("New Document comment");
    fireEvent.change(editor, { target: { selectionStart: 1, value: "@" } });
    fireEvent.keyDown(editor, { key: "Enter" });

    // Every Agent can read its Human's Documents, so the Mention needs no grant.
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
    fireEvent.keyDown(editor, { key: "Enter" });

    await waitFor(() => expect(blockNote.createThread).toHaveBeenCalledOnce());
    const [{ initialComment }] = blockNote.createThread.mock.calls[0]!;
    expect(mentionedActorIds(initialComment.body)).toEqual([agent.id]);
    expect(blockNote.stopPendingComment).toHaveBeenCalledOnce();
    expect(blockNote.focus).toHaveBeenCalledOnce();
  });

  it("posts a reply that mentions an Agent directly", async () => {
    const agent = {
      id: "agent_reply",
      display_name: "Reply Agent",
      kind: "agent" as const,
      tenant_id: "tenant_1",
    };
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderWithQueryClient(
      <DocumentMentionMessageComposer
        ariaLabel="Reply"
        initialValue="@Reply_Agent review this"
        initialMentions={[agent]}
        mentionOptions={[agent]}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.keyDown(screen.getByLabelText("Reply"), { key: "Enter" });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0]![0].mentions).toEqual([agent]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("posts a comment that mentions several Agents", async () => {
    const agent = {
      id: "agent_one",
      display_name: "One",
      kind: "agent" as const,
      tenant_id: "tenant_1",
    };
    const other = { ...agent, id: "agent_two", display_name: "Two" };
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderWithQueryClient(
      <DocumentMentionMessageComposer
        initialValue="@One check"
        initialMentions={[agent]}
        mentionOptions={[agent, other]}
        onSubmit={onSubmit}
      />,
    );
    const editor = screen.getByLabelText("New Document comment");
    fireEvent.change(editor, {
      target: { value: "@One @", selectionStart: 6 },
    });
    fireEvent.click(screen.getByRole("option", { name: /^Two/ }));
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.keyDown(editor, { key: "Enter" });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(
      onSubmit.mock.calls[0]![0].mentions.map(
        (actor: { id: string }) => actor.id,
      ),
    ).toEqual([agent.id, other.id]);
    await waitFor(() => expect(editor).toHaveValue(""));
  });

  it("shows a user-visible candidate directory failure", () => {
    renderWithQueryClient(
      <RoomDocumentCommentComposer mentionDirectoryError mentionOptions={[]} />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Mention directory is unavailable",
    );
  });
});
