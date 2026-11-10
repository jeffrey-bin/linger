import { Schema, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { ThreadData } from "@blocknote/core/comments";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TeamHubDocumentThreadStore } from "./room-document-comments";
import {
  RoomDocumentCommentsController,
  RoomDocumentCommentsOpenProvider,
} from "./room-document-comments-sidebar";

const blockNote = vi.hoisted(() => ({
  selection: { from: 5, to: 7 },
  doc: undefined as ProseMirrorNode | undefined,
  coordsAtPos: vi.fn(),
  domAtPos: vi.fn(),
  selectedThreadId: undefined as string | undefined,
  pendingComment: false,
  stopPendingComment: vi.fn(),
  selectThread: vi.fn(),
  threadPositions: new Map<string, { from: number; to: number }>(),
  threads: new Map<string, ThreadData>(),
}));

vi.mock("@blocknote/react", () => ({
  getReferenceText: () => "selected text",
  useBlockNoteEditor: () => ({
    prosemirrorState: { selection: blockNote.selection, doc: blockNote.doc },
    prosemirrorView: {
      coordsAtPos: blockNote.coordsAtPos,
      domAtPos: blockNote.domAtPos,
    },
  }),
  useExtension: () => ({
    selectThread: blockNote.selectThread,
    stopPendingComment: blockNote.stopPendingComment,
  }),
  useExtensionState: () => ({
    selectedThreadId: blockNote.selectedThreadId,
    pendingComment: blockNote.pendingComment,
    threadPositions: blockNote.threadPositions,
  }),
  useThreads: () => blockNote.threads,
}));

describe("Room Document Comments popover", () => {
  beforeEach(() => {
    blockNote.selectedThreadId = undefined;
    blockNote.pendingComment = false;
    blockNote.doc = undefined;
    blockNote.stopPendingComment.mockReset();
    blockNote.selectThread.mockReset();
    blockNote.threadPositions.clear();
    blockNote.threads.clear();
    vi.restoreAllMocks();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    blockNote.domAtPos.mockReturnValue({
      node: document.createTextNode("selected text"),
    });
  });

  it("renders no comment control before a document has threads", () => {
    const { container } = renderController();

    expect(container).toBeEmptyDOMElement();
    expect(
      screen.queryByRole("button", { name: /Show all Document comments/ }),
    ).not.toBeInTheDocument();
  });

  it("opens the sidebar for a pending native selection and cancels on close", async () => {
    blockNote.pendingComment = true;
    renderController({ composer: <textarea aria-label="Pending comment" /> });
    const sidebar = await screen.findByRole("complementary", {
      name: "All Document comments",
    });
    expect(
      within(sidebar).getByRole("textbox", { name: "Pending comment" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close comments" }));
    expect(blockNote.stopPendingComment).toHaveBeenCalledOnce();
  });

  it("opens the sidebar for a read-only selection without creating a thread", async () => {
    const onCancelSelection = vi.fn();
    renderController({
      pendingSelection: true,
      onCancelSelection,
      composer: <textarea aria-label="Pending comment" />,
    });
    const sidebar = await screen.findByRole("complementary", {
      name: "All Document comments",
    });
    expect(within(sidebar).getByRole("textbox")).toBeVisible();
    expect(blockNote.threads.size).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Close comments" }));
    expect(onCancelSelection).toHaveBeenCalledOnce();
  });

  it("explains how to create the first anchored comment", () => {
    renderController({ open: true, showTrigger: false });

    expect(screen.getByText("No open comments")).toBeVisible();
    expect(
      screen.getByText("Select text in the document, then choose Add comment."),
    ).toBeVisible();
  });

  it("keeps comments hidden until the count control opens all threads", () => {
    blockNote.threads.set("thread_1", thread("thread_1", "First comment"));
    blockNote.threads.set("thread_2", thread("thread_2", "Second comment"));
    blockNote.threadPositions.set("thread_1", { from: 1, to: 4 });
    blockNote.threadPositions.set("thread_2", { from: 8, to: 12 });

    renderController();

    const trigger = screen.getByRole("button", {
      name: "Show all Document comments (2)",
    });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("complementary", { name: "All Document comments" }),
    ).not.toBeInTheDocument();

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("complementary", { name: "All Document comments" }),
    ).toBeVisible();
    expect(screen.getByText("First comment")).toBeVisible();
    expect(screen.getByText("Second comment")).toBeVisible();
    expect(blockNote.selectThread).toHaveBeenCalledWith(undefined, false);
  });

  it("keeps the sidebar stable until its close command is used", () => {
    blockNote.threads.set("thread_1", thread("thread_1", "First comment"));
    renderController();

    const trigger = screen.getByRole("button", {
      name: "Show all Document comments (1)",
    });
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(
      screen.getByRole("complementary", { name: "All Document comments" }),
    ).toBeVisible();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(
      screen.getByRole("complementary", { name: "All Document comments" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close comments" }));
    expect(
      screen.queryByRole("complementary", { name: "All Document comments" }),
    ).not.toBeInTheDocument();
  });

  it("keeps a retryable error visible when Comment Threads fail to load", () => {
    const onRetry = vi.fn();

    renderController({ error: true, onRetry, open: true, showTrigger: false });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Comments could not be loaded.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("removes a discussion after its referenced selection is deleted", () => {
    blockNote.threads.set("thread_1", {
      ...thread("thread_1", "Removed discussion"),
      metadata: { anchorStatus: "orphaned" },
    });
    blockNote.threads.set("thread_2", {
      ...thread("thread_2", "Kept discussion"),
      metadata: { anchorStatus: "attached" },
    });
    renderController({ open: true, showTrigger: false });
    expect(screen.queryByText("Removed discussion")).toBeNull();
    expect(screen.getByText("Kept discussion")).toBeVisible();
  });

  it("keeps a failed selection link visible and retryable", () => {
    blockNote.threads.set("thread_1", {
      ...thread("thread_1", "First comment"),
      metadata: {
        anchorStatus: "pending",
        attachmentError: "Attach unavailable",
      },
    });
    const threadStore = controllerThreadStore();
    threadStore.attachSelectionAnchor = vi.fn();

    renderController({ open: true, showTrigger: false, threadStore });

    expect(screen.getByRole("alert")).toHaveTextContent("Comment saved");
    fireEvent.click(screen.getByRole("button", { name: "Retry linking" }));
    expect(threadStore.attachSelectionAnchor).toHaveBeenCalledWith("thread_1");
  });

  it("selects a sidebar thread and levels its text with the card", () => {
    blockNote.threads.set("thread_1", thread("thread_1", "First comment"));
    blockNote.threadPositions.set("thread_1", { from: 1, to: 4 });
    renderController();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Show all Document comments (1)",
      }),
    );
    const threadCard = screen.getByRole("article", {
      name: "Comment on selected text",
    });
    expect(threadCard).toHaveAttribute(
      "id",
      "room-document-comment-thread-thread_1",
    );

    // The Document pane is scrolled so the anchored text lands level with the
    // card, rather than centred independently of where the card sits.
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: true,
    } as MediaQueryList);
    const layout = document.createElement("div");
    layout.dataset.documentScrollLayout = "true";
    const lane = threadCard.closest<HTMLElement>(".bn-threads-sidebar")!;
    lane.parentElement!.insertBefore(layout, lane);
    layout.append(lane);
    layout.scrollTop = 40;
    blockNote.coordsAtPos.mockReturnValue({ top: 300 });
    vi.spyOn(threadCard, "getBoundingClientRect").mockReturnValue({
      top: 120,
    } as DOMRect);

    fireEvent.click(screen.getByRole("button", { name: "selected text" }));
    expect(layout.scrollTop).toBe(40 + 300 - 120);

    expect(blockNote.selectThread).toHaveBeenCalledWith("thread_1", false);
  });

  it("opens the sidebar and scrolls to the selected comment card", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollIntoView,
    });
    blockNote.threads.set("thread_1", thread("thread_1", "First comment"));
    blockNote.threadPositions.set("thread_1", { from: 1, to: 4 });
    const onOpenChange = vi.fn();
    const view = render(<ControlledCommentsController onOpen={onOpenChange} />);

    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    blockNote.selectedThreadId = "thread_1";
    view.rerender(<ControlledCommentsController onOpen={onOpenChange} />);

    await waitFor(() =>
      expect(
        screen.getByRole("article", { name: "Comment on selected text" }),
      ).toBeVisible(),
    );
    expect(onOpenChange).toHaveBeenCalledWith(true);
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
  });

  it("drops a Thread once every Comment in it is deleted", () => {
    const emptied = thread("thread_deleted", "Gone");
    blockNote.threads.set("thread_deleted", {
      ...emptied,
      comments: [{ ...emptied.comments[0]!, body: undefined }],
    });
    blockNote.threads.set("thread_1", thread("thread_1", "Still here"));

    renderController({ open: true, showTrigger: false });

    expect(screen.getByText("Still here")).toBeVisible();
    expect(screen.queryByText("Comment deleted")).not.toBeInTheDocument();
    expect(screen.queryByText("Gone")).not.toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(1);
  });

  it("inserts the new composer between comments in document order", () => {
    blockNote.pendingComment = true;
    blockNote.threads.set("later", thread("later", "Later comment"));
    blockNote.threads.set("earlier", thread("earlier", "Earlier comment"));
    blockNote.threadPositions.set("earlier", { from: 1, to: 3 });
    blockNote.threadPositions.set("later", { from: 8, to: 12 });
    const { container } = renderController({
      open: true,
      composer: <textarea aria-label="Pending comment" />,
    });
    const items = container.querySelector(".bn-threads-sidebar")!.children;
    expect(items[0]).toHaveTextContent("Earlier comment");
    expect(items[1]).toContainElement(screen.getByLabelText("Pending comment"));
    expect(items[2]).toHaveTextContent("Later comment");
  });

  it("orders not-yet-synced references by their text positions, including within one block", () => {
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        block: { content: "paragraph", attrs: { id: { default: null } } },
        paragraph: { content: "text*" },
        text: {},
      },
    });
    blockNote.doc = schema.node("doc", null, [
      schema.node("block", { id: "body" }, [
        schema.node(
          "paragraph",
          null,
          schema.text("Earlier text and later text"),
        ),
      ]),
    ]);
    for (const [id, quoted_text] of [
      ["later", "later text"],
      ["earlier", "Earlier text"],
    ]) {
      blockNote.threads.set(id!, {
        ...thread(id!, id!),
        metadata: {
          anchorStatus: "pending",
          anchor: {
            block_id: "body",
            quoted_text,
            context_before: "",
            context_after: "",
          },
        },
      });
    }
    const { container } = renderController({ open: true });
    const cards = container.querySelectorAll("[data-comment-card]");
    expect(
      [...cards].map((card) => card.getAttribute("data-comment-card")),
    ).toEqual(["earlier", "later"]);
    expect(Number(cards[0]!.getAttribute("data-anchor-pos"))).toBeLessThan(
      Number(cards[1]!.getAttribute("data-anchor-pos")),
    );
  });

  afterEach(() => {
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
    delete (HTMLElement.prototype as { scrollIntoView?: unknown })
      .scrollIntoView;
  });
});

function ControlledCommentsController({
  onOpen,
}: {
  onOpen: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [queryClient] = useState(() => new QueryClient());
  const handleOpen = useCallback(
    (next: boolean) => {
      setOpen(next);
      onOpen(next);
    },
    [onOpen],
  );
  return (
    <QueryClientProvider client={queryClient}>
      <RoomDocumentCommentsOpenProvider onOpenChange={handleOpen} open={open}>
        <RoomDocumentCommentsController
          mentionOptions={[]}
          showTrigger={false}
          threadStore={controllerThreadStore()}
        />
      </RoomDocumentCommentsOpenProvider>
    </QueryClientProvider>
  );
}

function renderController(
  props: Partial<Parameters<typeof RoomDocumentCommentsController>[0]> = {},
) {
  const { threadStore = controllerThreadStore(), ...controllerProps } = props;
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <RoomDocumentCommentsController
        mentionOptions={[]}
        {...controllerProps}
        threadStore={threadStore}
      />
    </QueryClientProvider>,
  );
}

function controllerThreadStore() {
  return {
    addComment: vi.fn(),
    auth: {
      canAddComment: () => true,
      canAddReaction: () => true,
      canDeleteComment: () => false,
      canDeleteReaction: () => false,
      canResolveThread: () => true,
      canUnresolveThread: () => true,
      canUpdateComment: () => false,
    },
  } as unknown as TeamHubDocumentThreadStore;
}

function thread(id: string, body: string): ThreadData {
  return {
    comments: [
      {
        body: [
          {
            content: [{ styles: {}, text: body, type: "text" }],
            id: `${id}_block`,
            props: {},
            type: "paragraph",
          },
        ],
        createdAt: new Date("2026-08-03T00:00:00Z"),
        id: `${id}_comment`,
        metadata: {},
        reactions: [],
        type: "comment",
        updatedAt: new Date("2026-08-03T00:00:00Z"),
        userId: "actor_alice",
      },
    ],
    createdAt: new Date("2026-08-03T00:00:00Z"),
    id,
    metadata: {},
    resolved: false,
    type: "thread",
    updatedAt: new Date("2026-08-03T00:00:00Z"),
  };
}
