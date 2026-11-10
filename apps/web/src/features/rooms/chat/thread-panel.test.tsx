import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  acceptRoomMessages,
  createTestTeamHubRuntime,
  type TestTeamHubRuntime,
} from "@/test/teamhub-test-runtime";
import type { TestRouteHandler } from "@/test/teamhub-test-server";
import {
  TeamHubRuntimeProvider,
  type TeamHubRuntime,
} from "@/features/teamhub/teamhub-runtime";
import type { RunStatusTransport } from "@/features/teamhub/run-status-transport";
import { TeamHubError } from "@/features/teamhub/teamhub-client";
import { formatTeamHubMentionToken } from "@/features/teamhub/teamhub-message-content";
import type {
  TeamHubActorRef,
  TeamHubMessage,
  TeamHubRunStatus,
} from "@/features/teamhub/teamhub-types";

import { readRoomComposerDraft, writeRoomComposerDraft } from "../room-drafts";
import { roomMessagesQueryKey } from "../room-queries";
import { requestThreadComposerFocus } from "./thread-composer-focus";
import { roomMessageSender } from "./room-message-sender";
import { ThreadPanel } from "./thread-panel";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";

const openPanelTab = vi.fn();

vi.mock("../room-connectivity", async () => {
  const actual = await vi.importActual<typeof import("../room-connectivity")>(
    "../room-connectivity",
  );
  return {
    ...actual,
    useRoomOutletContext: () => ({
      focusPanelMessageId: null,
      lastAppliedRoomSeq: 0,
      messagePresentations: {},
      openPanelTab,
      recordMessagePresentation: () => undefined,
      status: "connected" as const,
    }),
  };
});

describe("ThreadPanel", () => {
  beforeEach(() => {
    openPanelTab.mockReset();
    const store = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        get length() {
          return store.size;
        },
        clear: () => store.clear(),
        getItem: (key: string) => store.get(key) ?? null,
        key: (index: number) => [...store.keys()][index] ?? null,
        removeItem: (key: string) => {
          store.delete(key);
        },
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
      } satisfies Storage,
    });
  });

  it("shows Thread loading immediately while the sub-room is created", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptRoomMessages(runtime);

    const page = await listRoomMessages(runtime, "room-all");
    const root = page.items.find((item) => item.id === "message-2");
    if (!root) throw new Error("Fixture Message message-2 is missing.");
    runtime.server.on(
      "POST",
      "/v0/rooms/{roomId}/messages/{messageId}/thread",
      () => new Promise(() => undefined),
    );
    const listRunStatuses = vi.spyOn(runtime.client, "listRoomRunStatuses");
    render(
      wrap(
        runtime,
        <ThreadPanel
          accountId="account-jenny"
          mentionOptions={[codex]}
          rootMessage={root}
          tenantId="tenant-northstar"
        />,
      ),
    );

    expect(await screen.findByTestId("thread-panel-loading")).toBeVisible();
    // Nothing streams before the Thread Room exists.
    expect(listRunStatuses).not.toHaveBeenCalled();
    expect(screen.getByText(root.raw_message)).toBeVisible();
    expect(screen.getByText(root.raw_message).closest("article")).toHaveClass(
      "room-message-card",
      "message-row",
    );
    expect(screen.getByLabelText("Reply in Thread")).toBeDisabled();
    expect(screen.getByRole("heading", { name: "Thread" })).toHaveFocus();
  });

  it("focuses the ready Thread composer with the caret after the draft for Reply to thread", async () => {
    writeRoomComposerDraft(
      {
        accountId: "account-jenny",
        roomId: "room-all",
        tenantId: "tenant-northstar",
        threadId: "message-2",
      },
      {
        body: "Draft reply",
        documentContexts: [],
        documentReferences: [],
        mentions: [],
        skillReferences: [],
      },
    );
    requestThreadComposerFocus("message-2");
    await renderThreadPanel(
      <ThreadPanel
        accountId="account-jenny"
        rootMessage={message("message-2", "Thread root")}
        tenantId="tenant-northstar"
      />,
    );

    const composer = await screen.findByLabelText("Reply in Thread");
    await waitFor(() => expect(composer).toHaveFocus());
    expect(composer).toBeEnabled();
    expect((composer as HTMLTextAreaElement).selectionStart).toBe(
      "Draft reply".length,
    );
  });

  it("keeps heading focus when the Thread opens from its reply preview", async () => {
    await renderThreadPanel(
      <ThreadPanel
        accountId="account-jenny"
        rootMessage={message("message-2", "Thread root")}
        tenantId="tenant-northstar"
      />,
    );

    await waitFor(() =>
      expect(screen.getByLabelText("Reply in Thread")).toBeEnabled(),
    );
    expect(screen.getByRole("heading", { name: "Thread" })).toHaveFocus();
  });

  it("keeps heading focus for Reply to thread on a coarse pointer", async () => {
    const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation(
      (query) =>
        ({
          matches: query === "(pointer: coarse)",
          media: query,
        }) as MediaQueryList,
    );
    requestThreadComposerFocus("message-2");
    await renderThreadPanel(
      <ThreadPanel
        accountId="account-jenny"
        rootMessage={message("message-2", "Thread root")}
        tenantId="tenant-northstar"
      />,
    );

    await waitFor(() =>
      expect(screen.getByLabelText("Reply in Thread")).toBeEnabled(),
    );
    expect(screen.getByRole("heading", { name: "Thread" })).toHaveFocus();
    matchMedia.mockRestore();
  });

  it("preserves the focused draft when a restored Thread finishes loading", async () => {
    render(
      <textarea aria-label="Existing chat draft" defaultValue="Keep typing" />,
    );
    const draft = screen.getByLabelText("Existing chat draft");
    draft.focus();

    await renderThreadPanel(
      <ThreadPanel
        accountId="account-jenny"
        rootMessage={message("message-2", "Thread root")}
        tenantId="tenant-northstar"
      />,
    );

    expect(screen.getByRole("heading", { name: "Thread" })).toBeInTheDocument();
    expect(draft).toHaveFocus();
    expect(draft).toHaveValue("Keep typing");
  });

  it("does not paint parent-room messages while the Thread is opening", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptRoomMessages(runtime);

    const page = await listRoomMessages(runtime, "room-all");
    const root = page.items.find((item) => item.id === "message-2");
    if (!root) throw new Error("Fixture Message message-2 is missing.");
    const parentOnly = page.items.find((item) => item.id === "message-3");
    if (!parentOnly) throw new Error("Fixture Message message-3 is missing.");
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(
      roomMessagesQueryKey("tenant-northstar", "room-all"),
      {
        pageParams: [undefined],
        pages: [page],
      },
    );
    runtime.server.on(
      "POST",
      "/v0/rooms/{roomId}/messages/{messageId}/thread",
      () => new Promise(() => undefined),
    );
    render(
      wrap(
        runtime,
        <ThreadPanel
          accountId="account-jenny"
          mentionOptions={[codex]}
          rootMessage={root}
          tenantId="tenant-northstar"
        />,
        queryClient,
      ),
    );

    expect(await screen.findByTestId("thread-panel-loading")).toBeVisible();
    expect(screen.getByText(root.raw_message)).toBeVisible();
    expect(screen.queryByText(parentOnly.raw_message)).not.toBeInTheDocument();
  });

  it("posts follow-up to the Thread room instead of the parent timeline", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptRoomMessages(runtime);

    const page = await listRoomMessages(runtime, "room-all");
    const root = page.items.find((item) => item.id === "message-2");
    if (!root) throw new Error("Fixture Message message-2 is missing.");
    const threadRequests = () =>
      runtime.server.requestsTo(
        "POST",
        "/v0/rooms/{roomId}/messages/{messageId}/thread",
      );
    const createMessage = vi.spyOn(
      roomMessageSender(runtime.client),
      "createMessage",
    );
    render(
      wrap(
        runtime,
        <ThreadPanel
          accountId="account-jenny"
          mentionOptions={[codex, lev8]}
          rootMessage={root}
          tenantId="tenant-northstar"
        />,
      ),
    );
    await waitFor(() => expect(threadRequests()).not.toHaveLength(0));

    const composer = await screen.findByLabelText("Reply in Thread");
    fireEvent.change(composer, {
      target: { selectionStart: 4, value: "@Cod" },
    });
    fireEvent.click(await screen.findByRole("option", { name: /Codex/ }));
    expect(composer).toHaveValue("@Codex ");

    fireEvent.change(composer, {
      target: { value: "@Codex Make a short plan" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(createMessage).toHaveBeenCalled());
    expect(createMessage.mock.calls[0]?.[0]).toMatchObject({
      body: "@Codex Make a short plan",
    });
    expect(createMessage.mock.calls[0]?.[0].roomId).not.toBe("room-all");
    await waitFor(() =>
      expect(screen.getByText(/Make a short plan/)).toBeVisible(),
    );
    const parent = await listRoomMessages(runtime, "room-all");
    expect(
      parent.items.some((item) =>
        item.raw_message.includes("Make a short plan"),
      ),
    ).toBe(false);
  });

  it("sends the reply as-is without targeting the referenced Agent host", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptRoomMessages(runtime);

    const page = await listRoomMessages(runtime, "room-all");
    const root = page.items.find((item) => item.id === "message-2");
    if (!root) throw new Error("Fixture Message message-2 is missing.");
    const threadRequests = () =>
      runtime.server.requestsTo(
        "POST",
        "/v0/rooms/{roomId}/messages/{messageId}/thread",
      );
    const createMessage = vi.spyOn(
      roomMessageSender(runtime.client),
      "createMessage",
    );
    render(
      wrap(
        runtime,
        <ThreadPanel
          accountId="account-jenny"
          mentionOptions={[codex]}
          rootMessage={root}
          tenantId="tenant-northstar"
        />,
      ),
    );
    await waitFor(() => expect(threadRequests()).not.toHaveLength(0));

    const composer = await screen.findByLabelText("Reply in Thread");
    fireEvent.change(composer, { target: { value: "How is this going" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(createMessage).toHaveBeenCalled());
    expect(createMessage.mock.calls[0]?.[0]).toMatchObject({
      body: "How is this going",
      mentions: [],
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Thread timeline")).toHaveTextContent(
        "How is this going",
      ),
    );
  });

  it("adds the Direct Room peer's @ on send and hides it in the Thread", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptRoomMessages(runtime);
    const root = await fixtureRoot(runtime);
    const getRoom = serveAsDirectRoom(runtime, root.room_id);
    const createMessage = vi.spyOn(
      roomMessageSender(runtime.client),
      "createMessage",
    );
    render(
      wrap(
        runtime,
        <ThreadPanel
          accountId="account-jenny"
          mentionOptions={[codex]}
          rootMessage={root}
          tenantId="tenant-northstar"
        />,
      ),
    );
    await waitFor(() => expect(getRoom).toHaveBeenCalled());

    await sendReply("How is this going");

    await waitFor(() => expect(createMessage).toHaveBeenCalled());
    expect(createMessage.mock.calls[0]?.[0]).toMatchObject({
      body: `${formatTeamHubMentionToken(codex)} How is this going`,
      mentions: [codex],
    });
    const timeline = screen.getByLabelText("Thread timeline");
    await waitFor(() =>
      expect(timeline).toHaveTextContent("How is this going"),
    );
    expect(timeline).not.toHaveTextContent("Codex How is this going");
  });

  it("scrolls to the latest reply after sending from earlier in the Thread", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptRoomMessages(runtime);

    const page = await listRoomMessages(runtime, "room-all");
    const root = page.items.find((item) => item.id === "message-2");
    if (!root) throw new Error("Fixture Message message-2 is missing.");
    render(
      wrap(
        runtime,
        <ThreadPanel
          accountId="account-jenny"
          mentionOptions={[codex]}
          rootMessage={root}
          tenantId="tenant-northstar"
        />,
      ),
    );

    const timeline = await screen.findByLabelText("Thread timeline");
    let scrollHeight = 800;
    Object.defineProperty(timeline, "clientHeight", {
      configurable: true,
      value: 200,
    });
    Object.defineProperty(timeline, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    timeline.scrollTop = 0;
    fireEvent.scroll(timeline);

    const composer = await screen.findByLabelText("Reply in Thread");
    fireEvent.change(composer, { target: { value: "Follow up on this" } });
    scrollHeight = 960;
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => {
      expect(screen.getByText("Follow up on this")).toBeVisible();
      expect(timeline.scrollTop).toBe(960);
    });
  });

  it("shows a failed Thread reply above the composer, not in the timeline", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptRoomMessages(runtime);

    const page = await listRoomMessages(runtime, "room-all");
    const root = page.items.find((item) => item.id === "message-2");
    if (!root) throw new Error("Fixture Message message-2 is missing.");
    const originalListRunStatuses = runtime.client.listRoomRunStatuses.bind(
      runtime.client,
    );
    vi.spyOn(runtime.client, "listRoomRunStatuses").mockImplementation(
      async (roomId) =>
        roomId === root.room_id
          ? originalListRunStatuses(roomId)
          : {
              items: [
                {
                  id: "thread-failed-run-status",
                  run_id: "thread-run",
                  room_id: roomId,
                  agent: {
                    id: codex.id,
                    kind: "agent",
                    display_name: codex.display_name,
                  },
                  status: "aborted",
                  stop_reason: "private token",
                  replied: false,
                  revision: 1,
                  created_at: "2026-08-14T08:00:00Z",
                  updated_at: "2026-08-14T08:00:01Z",
                },
              ],
            },
    );
    render(
      wrap(
        runtime,
        <ThreadPanel
          accountId="account-jenny"
          mentionOptions={[codex]}
          rootMessage={root}
          tenantId="tenant-northstar"
        />,
      ),
    );

    const dock = await screen.findByTestId("agent-streaming-status-dock");
    expect(
      within(dock).getByRole("button", { name: "Open Agent status activity" }),
    ).toHaveAttribute("title", "Codex: Run stopped");
    expect(
      dock.compareDocumentPosition(screen.getByLabelText("Reply in Thread")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByLabelText("Thread timeline")).not.toContainElement(dock);
    expect(
      screen.queryByRole("article", { name: "Agent status from Codex" }),
    ).not.toBeInTheDocument();
    expect(within(dock).queryByRole("button", { name: /Stop/ })).toBeNull();
    expect(screen.queryByText(/private token|private local error/)).toBeNull();
    fireEvent.click(
      within(dock).getByRole("button", { name: "Open Agent status activity" }),
    );
    const threadRoomId = (
      await teamHubData(
        runtime.client.api.POST(
          "/v0/rooms/{roomId}/messages/{messageId}/thread",
          { params: { path: { roomId: root.room_id, messageId: root.id } } },
        ),
      )
    ).room.id;
    expect(openPanelTab).toHaveBeenCalledWith(
      expect.objectContaining({
        activityRunStatusId: "thread-failed-run-status",
        activityRunId: "thread-run",
        activityRoomId: threadRoomId,
        anchorMessageId: root.id,
        actorId: codex.id,
      }),
    );
  });

  it("opens the Profile for a Thread author and structured Mention", async () => {
    const onOpenProfile = vi.fn();
    await renderThreadPanel(
      <ThreadPanel
        accountId="account-jenny"
        mentionOptions={[codex, lev8]}
        onOpenProfile={onOpenProfile}
        rootMentions={[lev8]}
        rootMessage={message("message-profile", "@Lev8_GTM, check this result")}
        tenantId="tenant-northstar"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open Codex profile" }));
    expect(onOpenProfile).toHaveBeenCalledWith("actor-codex");
    fireEvent.pointerEnter(
      screen.getByRole("button", { name: "Open Codex profile" }),
      { pointerType: "mouse" },
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "View activity" }));
    expect(openPanelTab).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "agentActivity",
        actorId: "actor-codex",
        activityRoomId: "room-all",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "@Lev8_GTM" }));
    expect(onOpenProfile).toHaveBeenCalledWith("actor-lev8");
  });

  it("renders an Agent's stored mention label without an at prefix in the Thread", async () => {
    const onOpenProfile = vi.fn();
    const root = message("message-bare-mention", "Please review, lu");
    root.segments = [
      { type: "text", content: "Please review, " },
      {
        type: "reference",
        content: "lu",
        target: "actor-lu",
        target_type: "user",
      },
    ];
    await renderThreadPanel(
      <ThreadPanel
        accountId="account-jenny"
        onOpenProfile={onOpenProfile}
        rootMessage={root}
        tenantId="tenant-northstar"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "@lu" }));
    expect(onOpenProfile).toHaveBeenCalledWith("actor-lu");
  });

  it("fills the panel without its own Thread chrome", async () => {
    await renderThreadPanel(
      <ThreadPanel
        accountId="account-jenny"
        mentionOptions={[codex]}
        rootMessage={message("message-embedded", "Embedded root")}
        tenantId="tenant-northstar"
      />,
    );

    expect(await screen.findByLabelText("Reply in Thread")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Close Thread" })).toBeNull();
    expect(screen.getByText("Embedded root")).toBeVisible();
  });

  it("keeps a long structured Mention in the Thread content column", async () => {
    await renderThreadPanel(
      <ThreadPanel
        accountId="account-jenny"
        mentionOptions={[codex]}
        onOpenProfile={vi.fn()}
        rootMentions={[ki]}
        rootMessage={message("message-mention", "@ki2022518")}
        tenantId="tenant-northstar"
      />,
    );

    const mention = screen.getByRole("button", { name: "@ki2022518" });
    expect(mention).toHaveClass("whitespace-nowrap");
    expect(mention.closest("article")?.children[1]).toHaveClass(
      "min-w-0",
      "flex-1",
    );
  });

  it("isolates and restores drafts by root Message", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptRoomMessages(runtime);

    const page = await listRoomMessages(runtime, "room-all");
    const first = page.items.find((item) => item.id === "message-2");
    const second = page.items.find((item) => item.id === "message-3");
    if (!first || !second) throw new Error("Fixture Messages are missing.");
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { rerender } = render(
      wrap(
        runtime,
        <ThreadPanel
          accountId="account-jenny"
          mentionOptions={[codex]}
          rootMessage={first}
          tenantId="tenant-northstar"
        />,
        queryClient,
      ),
    );

    const composer = await screen.findByLabelText("Reply in Thread");
    await waitFor(() => expect(composer).toBeEnabled());
    fireEvent.change(composer, {
      target: { value: "Draft for A" },
    });
    expect(screen.getByLabelText("Reply in Thread")).toHaveValue("Draft for A");
    expect(
      readRoomComposerDraft({
        accountId: "account-jenny",
        roomId: first.room_id,
        tenantId: "tenant-northstar",
        threadId: first.id,
      }).body,
    ).toBe("Draft for A");
    rerender(
      wrap(
        runtime,
        <ThreadPanel
          accountId="account-jenny"
          mentionOptions={[codex]}
          rootMessage={second}
          tenantId="tenant-northstar"
        />,
        queryClient,
      ),
    );
    expect(await screen.findByLabelText("Reply in Thread")).toHaveValue("");

    const composerB = screen.getByLabelText("Reply in Thread");
    await waitFor(() => expect(composerB).toBeEnabled());
    fireEvent.change(composerB, {
      target: { value: "Draft for B" },
    });
    rerender(
      wrap(
        runtime,
        <ThreadPanel
          accountId="account-jenny"
          mentionOptions={[codex]}
          rootMessage={first}
          tenantId="tenant-northstar"
        />,
        queryClient,
      ),
    );
    await waitFor(() => {
      expect(screen.getByLabelText("Reply in Thread")).toHaveValue(
        "Draft for A",
      );
    });
    expect(screen.queryByText("Draft for B")).not.toBeInTheDocument();
  });

  it("renders a file card in Thread and opens the parent Room preview", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptRoomMessages(runtime);

    const document = await readDocument(
      runtime.client,
      "document-product-v0-brief",
    );
    const version = document.current_version
      ? await readDocumentVersion(runtime.client, document.current_version.id)
      : undefined;
    const root = message("message-thread-file", "The brief is ready.");
    root.segments = [
      { type: "text", content: "The brief is ready.\n" },
      {
        content: version?.filename ?? "product-v0-brief.md",
        document_id: document.id,
        document_version_id: version?.id ?? "",
        filename: version?.filename,
        media_type: version?.media_type,
        type: "file",
      },
    ];
    render(
      wrap(
        runtime,
        <ThreadPanel
          accountId="account-jenny"
          mentionOptions={[codex]}
          rootMessage={root}
          tenantId="tenant-northstar"
        />,
      ),
    );

    fireEvent.click(
      await screen.findByRole("button", { name: `Preview ${document.title}` }),
    );
    await waitFor(() => {
      expect(openPanelTab).toHaveBeenCalledWith(
        expect.objectContaining({
          documentId: document.id,
          kind: "file",
        }),
      );
    });
  });

  it("opens an inline Document citation from Thread", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptRoomMessages(runtime);

    const document = await readDocument(
      runtime.client,
      "document-product-v0-brief",
    );
    const root = message("message-thread-cite", "See @Brief");
    root.segments = [
      { type: "text", content: "See " },
      {
        content: "@Brief",
        document_id: document.id,
        presentation: "inline",
        type: "document",
      },
    ];
    render(
      wrap(
        runtime,
        <ThreadPanel
          accountId="account-jenny"
          mentionOptions={[codex]}
          rootMessage={root}
          tenantId="tenant-northstar"
        />,
      ),
    );

    fireEvent.click(
      await screen.findByRole("button", { name: `Open ${document.title}` }),
    );
    await waitFor(() => {
      expect(openPanelTab).toHaveBeenCalledWith(
        expect.objectContaining({
          documentId: document.id,
          kind: "file",
        }),
      );
    });
  });
  it("subscribes to Thread Run statuses once the Thread Room exists, and only once", async () => {
    const fixture = createTestTeamHubRuntime();
    acceptRoomMessages(fixture);
    const root = await fixtureRoot(fixture);
    // A second runtime on the same seed answers the held Thread request.
    const seeded = createTestTeamHubRuntime(fixture.seed);
    acceptRoomMessages(seeded);
    let openThread!: () => void;
    fixture.server.on(
      "POST",
      "/v0/rooms/{roomId}/messages/{messageId}/thread",
      ({ request }) =>
        new Promise((resolve) => {
          openThread = () => resolve(seeded.server.fetch(request));
        }),
    );
    const unsubscribe = vi.fn();
    const subscribe = vi.fn<RunStatusTransport["subscribe"]>(() => unsubscribe);
    const runtime = { ...fixture, runStatuses: { subscribe } };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = render(
      wrap(
        runtime,
        <ThreadPanel
          accountId="account-jenny"
          mentionOptions={[codex]}
          rootMessage={root}
          tenantId="tenant-northstar"
        />,
        queryClient,
      ),
    );

    expect(await screen.findByTestId("thread-panel-loading")).toBeVisible();
    expect(subscribe).not.toHaveBeenCalled();
    await act(async () => openThread());

    await waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
    expect(subscribe.mock.calls[0]?.[0].roomId).not.toBe(root.room_id);
    // Props unrelated to the Thread Room keep the subscription.
    view.rerender(
      wrap(
        runtime,
        <ThreadPanel
          accountId="account-jenny"
          mentionOptions={[codex, lev8]}
          onOpenProfile={vi.fn()}
          rootMessage={root}
          tenantId="tenant-northstar"
        />,
        queryClient,
      ),
    );
    expect(subscribe).toHaveBeenCalledOnce();
    expect(unsubscribe).not.toHaveBeenCalled();

    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("keeps a failed reply after the Thread reopens and retries it with the same key", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptRoomMessages(runtime);
    const root = await fixtureRoot(runtime);
    const createMessage = vi
      .spyOn(roomMessageSender(runtime.client), "createMessage")
      .mockRejectedValueOnce(offline());
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const panel = (
      <ThreadPanel
        accountId="account-jenny"
        mentionOptions={[codex]}
        rootMessage={root}
        tenantId="tenant-northstar"
      />
    );
    const first = render(wrap(runtime, panel, queryClient));
    await sendReply("Retry me later");

    expect(await screen.findByText("Not sent")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("TeamHub is offline.");
    first.unmount();

    render(wrap(runtime, panel, queryClient));
    expect(await screen.findByText("Not sent")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(createMessage).toHaveBeenCalledTimes(2));
    expect(createMessage.mock.calls[1]?.[0].idempotencyKey).toBe(
      createMessage.mock.calls[0]?.[0].idempotencyKey,
    );
    await waitFor(() => expect(screen.queryByText("Not sent")).toBeNull());
    expect(
      within(screen.getByLabelText("Thread timeline")).getByText(
        "Retry me later",
      ),
    ).toBeVisible();
  });

  it("mentions a reply's author from their name", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptRoomMessages(runtime);
    const root = await fixtureRoot(runtime);
    const seeded = createTestTeamHubRuntime(runtime.seed);
    runtime.server.on(
      "GET",
      "/v0/rooms/{roomId}/messages",
      ({ params: { roomId }, request }) =>
        roomId === root.room_id
          ? seeded.server.fetch(request)
          : {
              items: [reply(roomId!, "reply-codex", "Can you check this?", 1)],
              page: { has_more: false },
              snapshot_room_seq: 0,
            },
    );
    render(
      wrap(
        runtime,
        <ThreadPanel
          accountId="account-jenny"
          mentionOptions={[codex]}
          rootMessage={root}
          tenantId="tenant-northstar"
        />,
      ),
    );

    const replyRow = (await screen.findByText("Can you check this?")).closest(
      "article",
    );
    if (!replyRow) throw new Error("The reply row is missing.");
    const composer = screen.getByLabelText("Reply in Thread");
    await waitFor(() => expect(composer).toBeEnabled());
    fireEvent.click(within(replyRow).getByRole("button", { name: "Codex" }));

    expect(composer).toHaveValue("@Codex ");
  });

  it("discards a failed reply without sending it again", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptRoomMessages(runtime);
    const root = await fixtureRoot(runtime);
    const createMessage = vi
      .spyOn(roomMessageSender(runtime.client), "createMessage")
      .mockRejectedValueOnce(offline());
    render(
      wrap(
        runtime,
        <ThreadPanel
          accountId="account-jenny"
          mentionOptions={[codex]}
          rootMessage={root}
          tenantId="tenant-northstar"
        />,
      ),
    );
    await sendReply("Never mind");

    expect(await screen.findByText("Not sent")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByText("Never mind")).toBeNull());
    expect(createMessage).toHaveBeenCalledOnce();
  });

  it("loads earlier replies above the newest page", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptRoomMessages(runtime);
    const root = await fixtureRoot(runtime);
    const seeded = createTestTeamHubRuntime(runtime.seed);
    runtime.server.on(
      "GET",
      "/v0/rooms/{roomId}/messages",
      ({ params: { roomId }, query, request }) =>
        roomId === root.room_id
          ? seeded.server.fetch(request)
          : query.get("cursor") === "reply-newer"
            ? {
                items: [reply(roomId!, "reply-older", "Older reply", 1)],
                page: { has_more: false },
                snapshot_room_seq: 0,
              }
            : {
                items: [reply(roomId!, "reply-newer", "Newer reply", 2)],
                page: { has_more: true, next_cursor: "reply-newer" },
                snapshot_room_seq: 0,
              },
    );
    render(
      wrap(
        runtime,
        <ThreadPanel
          accountId="account-jenny"
          mentionOptions={[codex]}
          rootMessage={root}
          tenantId="tenant-northstar"
        />,
      ),
    );

    const newer = await screen.findByText("Newer reply");
    expect(screen.queryByText("Older reply")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Load earlier replies" }),
    );

    const older = await screen.findByText("Older reply");
    expect(
      older.compareDocumentPosition(newer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Load earlier replies" }),
      ).toBeNull(),
    );
  });

  it("streams only the Direct Room peer in its Threads", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptRoomMessages(runtime);
    const root = await fixtureRoot(runtime);
    serveAsDirectRoom(runtime, root.room_id);
    vi.spyOn(runtime.client, "listRoomRunStatuses").mockImplementation(
      async (roomId) => ({
        items:
          roomId === root.room_id
            ? []
            : [abortedRunStatus(roomId, codex), abortedRunStatus(roomId, lev8)],
      }),
    );
    render(
      wrap(
        runtime,
        <ThreadPanel
          accountId="account-jenny"
          mentionOptions={[codex]}
          rootMessage={root}
          tenantId="tenant-northstar"
        />,
      ),
    );

    const dock = await screen.findByTestId("agent-streaming-status-dock");
    expect(
      within(dock).getByRole("button", { name: "Open Agent status activity" }),
    ).toHaveAttribute("title", "Codex: Run stopped");
    expect(dock).not.toHaveTextContent("Lev8 GTM");
  });

  it("renders a reply's card and decides it in the Thread Room", async () => {
    const runtime = createTestTeamHubRuntime();
    acceptRoomMessages(runtime);
    const root = await fixtureRoot(runtime);
    const identity = runtime.seed.identity;
    const human = identity.actors.find(
      (actor) => actor.tenant_id === "tenant-northstar",
    );
    if (!human) throw new Error("Fixture Human Actor is missing.");
    const owner = {
      display_name: human.display_name,
      id: human.id,
      kind: "human" as const,
    };
    let threadRoomId = "";
    const cardReply = (resolved: boolean) => ({
      ...reply(threadRoomId, "reply-card", "Release decision", 1),
      card: releaseCard(owner, resolved),
    });
    const seeded = createTestTeamHubRuntime(runtime.seed);
    runtime.server.on(
      "GET",
      "/v0/rooms/{roomId}/messages",
      ({ params: { roomId }, request }) => {
        if (roomId === root.room_id) return seeded.server.fetch(request);
        threadRoomId = roomId!;
        return {
          items: [cardReply(false)],
          page: { has_more: false },
          snapshot_room_seq: 0,
        };
      },
    );
    const decide = vi.fn<TestRouteHandler>(() => cardReply(true));
    runtime.server.on("POST", "/v0/decisions/{decisionId}", decide);
    render(
      wrap(
        runtime,
        <ThreadPanel
          accountId="account-jenny"
          mentionOptions={[codex]}
          rootMessage={root}
          tenantId="tenant-northstar"
        />,
      ),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Ship it" }));

    await waitFor(() =>
      expect(decide).toHaveBeenCalledWith(
        expect.objectContaining({
          body: {
            answers: { release: "ship" },
            decision: "submit",
            expected_version: 1,
          },
          params: { decisionId: "decision-thread" },
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Ship it" })).toBeNull(),
    );
    // Settled, the card reads as a system line with the chosen answer.
    await vi.waitFor(() =>
      expect(
        screen.getByText(/answered “Ship the release\?” with “Ship it”/),
      ).toBeVisible(),
    );
  });
});

const codex: TeamHubActorRef = {
  display_name: "Codex",
  id: "actor-codex",
  kind: "agent",
  tenant_id: "tenant-northstar",
};

const lev8: TeamHubActorRef = {
  display_name: "Lev8 GTM",
  id: "actor-lev8",
  kind: "agent",
  tenant_id: "tenant-northstar",
};

const ki: TeamHubActorRef = {
  display_name: "ki2022518",
  id: "actor-ki",
  kind: "human",
  tenant_id: "tenant-northstar",
};

function message(id: string, body: string): TeamHubMessage {
  return {
    attachments: [],
    author: codex,
    created_at: "2026-07-23T10:00:00Z",
    id,
    message_kind: "conversation",
    raw_message: body,
    room_id: "room-all",
    segments: [{ content: body, type: "text" }],
    tenant_id: "tenant-northstar",
  };
}

function listRoomMessages(runtime: TeamHubRuntime, roomId: string) {
  return teamHubData(
    runtime.client.api.GET("/v0/rooms/{roomId}/messages", {
      params: { path: { roomId } },
    }),
  );
}

async function fixtureRoot(runtime: TeamHubRuntime) {
  const page = await listRoomMessages(runtime, "room-all");
  const root = page.items.find((item) => item.id === "message-2");
  if (!root) throw new Error("Fixture Message message-2 is missing.");
  return root;
}

async function sendReply(body: string) {
  const composer = await screen.findByLabelText("Reply in Thread");
  await waitFor(() => expect(composer).toBeEnabled());
  fireEvent.change(composer, { target: { value: body } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
}

function offline() {
  return new TeamHubError({
    code: "SERVICE_UNAVAILABLE",
    message: "TeamHub is offline.",
    status: 503,
  });
}

function reply(
  roomId: string,
  id: string,
  body: string,
  minute: number,
): TeamHubMessage {
  return {
    ...message(id, body),
    created_at: `2026-07-23T10:0${minute}:00Z`,
    room_id: roomId,
  };
}

function abortedRunStatus(
  roomId: string,
  agent: TeamHubActorRef,
): TeamHubRunStatus {
  return {
    stop_reason: "private token",
    agent: { display_name: agent.display_name, id: agent.id, kind: "agent" },
    created_at: "2026-08-14T08:00:00Z",
    id: `draft-${agent.id}`,
    run_id: `draft-${agent.id}`,
    replied: false,
    revision: 1,
    room_id: roomId,
    status: "aborted",
    updated_at: "2026-08-14T08:00:01Z",
  };
}

function releaseCard(
  owner: { display_name: string; id: string; kind: "human" },
  resolved: boolean,
): NonNullable<TeamHubMessage["card"]> {
  const card = {
    card_type: "personal_notice" as const,
    decision_id: "decision-thread",
    decision_owner: owner,
    intent: "decision_requested" as const,
    kind: "question" as const,
    question: {
      questions: [
        {
          id: "release",
          input: "radio" as const,
          options: [
            { id: "ship", label: "Ship it" },
            { id: "hold", label: "Hold" },
          ],
          prompt: "Ship the release?",
        },
      ],
    },
    requester: {
      display_name: codex.display_name,
      id: codex.id,
      kind: "agent" as const,
    },
    title: "Release decision",
  };
  return resolved
    ? {
        ...card,
        answer: { answers: { release: "ship" }, decision: "submit" },
        decided_at: "2026-07-23T10:02:00Z",
        decided_by: owner,
        status: "answered",
        version: 2,
      }
    : { ...card, status: "pending", version: 1 };
}

async function renderThreadPanel(ui: React.ReactElement) {
  const runtime = createTestTeamHubRuntime();
  acceptRoomMessages(runtime);

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(wrap(runtime, ui, queryClient));
  return { ...view, queryClient, runtime };
}

/** Serves one Room as a Direct Room with Codex and the rest from the seed. */
function serveAsDirectRoom(runtime: TestTeamHubRuntime, directRoomId: string) {
  const seeded = createTestTeamHubRuntime(runtime.seed);
  const getRoom = vi.fn<TestRouteHandler>(async ({ params, request }) =>
    params.roomId === directRoomId
      ? {
          ...(await teamHubData(
            seeded.client.api.GET("/v0/rooms/{roomId}", {
              params: { path: { roomId: directRoomId } },
            }),
          )),
          direct_peer: codex,
          direct_peer_active: true,
          kind: "direct",
        }
      : seeded.server.fetch(request),
  );
  runtime.server.on("GET", "/v0/rooms/{roomId}", getRoom);
  return getRoom;
}

function wrap(
  runtime: TeamHubRuntime,
  ui: React.ReactElement,
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  }),
) {
  return (
    <QueryClientProvider client={queryClient}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <MemoryRouter>{ui}</MemoryRouter>
      </TeamHubRuntimeProvider>
    </QueryClientProvider>
  );
}

function readDocument(client: TeamHubClient, documentId: string) {
  return teamHubData(
    client.api.GET("/v0/documents/{documentId}", {
      params: { path: { documentId } },
    }),
  );
}

function readDocumentVersion(client: TeamHubClient, documentVersionId: string) {
  return teamHubData(
    client.api.GET("/v0/document-versions/{documentVersionId}", {
      params: { path: { documentVersionId } },
    }),
  );
}
