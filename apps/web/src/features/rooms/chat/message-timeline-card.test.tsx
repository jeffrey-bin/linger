import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  TeamHubMessage,
  TeamHubRunStatus,
  TeamHubRuntimePresentationEventRecord,
} from "@/features/teamhub/teamhub-types";

import {
  AgentStreamingStatusDock,
  buildRuntimeTimelineViews,
  MessageTimeline,
} from "./message-timeline";
import { AGENT_STATUS_LINE_TIMING } from "./agent-status-line";
import {
  createDocumentTestRuntime,
  seedRoomUpload,
} from "@/test/document-scenarios";
import {
  presentTeamHubMessageAttachments,
  TeamHubRuntimeProvider,
} from "@/features/teamhub/teamhub-runtime";
import * as markdown from "./message-markdown";
import * as previewLoader from "../files/artifact-preview-loader";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";

describe("Room Message timeline cards", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a bubble for a Human's text and for an Agent's reply", () => {
    const agent = ordinaryAgentMessage();
    const human = ordinaryHumanMessage();
    renderTimeline([human, agent]);
    expect(
      within(messageRow(human))
        .getByText(human.raw_message)
        .closest(".room-message-bubble"),
    ).not.toBeNull();
    expect(
      within(messageRow(agent))
        .getByText(agent.raw_message)
        .closest(".room-message-bubble"),
    ).not.toBeNull();
  });

  it("invites the first Message only while no Messages are arriving", () => {
    const view = renderTimeline([]);
    expect(
      screen.getByRole("heading", { name: "Start the conversation" }),
    ).toBeVisible();
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <MessageTimeline
            canLoadOlder={false}
            loadingOlder={false}
            messages={[]}
            messagesArriving
            onCancel={vi.fn()}
            onCardDecision={vi.fn()}
            onCloseLinkedSource={vi.fn()}
            onOpenArtifact={vi.fn()}
            onOpenMessageFile={vi.fn()}
            onOpenProfile={vi.fn()}
            onRetry={vi.fn()}
            pendingMessages={[]}
            presentations={{}}
            tenantId="tenant-1"
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(
      screen.queryByRole("heading", { name: "Start the conversation" }),
    ).toBeNull();
  });

  it("groups consecutive senders and separates conversations after five minutes", () => {
    const first = {
      ...ordinaryAgentMessage(),
      id: "first",
      created_at: "2026-10-22T10:00:00Z",
    };
    const second = {
      ...first,
      id: "second",
      created_at: "2026-10-22T10:04:59Z",
    };
    const own = {
      ...ordinaryHumanMessage(),
      created_at: "2026-10-22T10:05:00Z",
    };
    const later = { ...first, id: "later", created_at: "2026-10-22T10:10:00Z" };
    const { container } = renderTimeline([first, second, own, later]);
    expect(
      container.querySelectorAll(".room-conversation-time time"),
    ).toHaveLength(2);
    const continuation = container.querySelector('[data-message-id="second"]')!;
    expect(
      container.querySelector('[data-message-id="first"]'),
    ).toHaveAttribute("data-group-start", "true");
    expect(continuation).toHaveAttribute("data-group-start", "false");
    expect(
      within(continuation as HTMLElement).queryByRole("button", {
        name: "Codex",
      }),
    ).toBeNull();
    const ownRow = container.querySelector(`[data-message-id="${own.id}"]`)!;
    expect(ownRow).toHaveAttribute("data-current-actor", "true");
    expect(ownRow).toHaveAttribute("data-group-start", "true");
    expect(
      within(ownRow as HTMLElement).getByRole("img", {
        name: `${own.author.display_name} avatar`,
      }),
    ).toBeVisible();
    expect(ownRow.querySelector(".room-message-author")).toBeNull();
    expect(container.querySelectorAll("article time")).toHaveLength(0);
    expect(screen.getAllByRole("button", { name: "Codex" })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Helpful" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Not helpful" })).toBeNull();
  });

  it("renders a Room notice as a centered line that ends the author's group", () => {
    const agent = ordinaryAgentMessage();
    const notice: TeamHubMessage = {
      ...agent,
      id: "notice",
      message_kind: "room_notice",
      notice: {
        agent: { ...agent.author, display_name: "Writer", id: "agent-writer" },
        type: "agent_created",
      },
      raw_message: "Codex created Writer and added it to this Room.",
      segments: [
        {
          content: "Codex created Writer and added it to this Room.",
          type: "text",
        },
      ],
      created_at: "2026-10-22T10:00:00Z",
    };
    const next = { ...agent, id: "after", created_at: "2026-10-22T10:01:00Z" };
    const { container } = renderTimeline([notice, next]);
    expect(screen.getByRole("note")).toHaveTextContent(
      "Codex created Writer and added it to this Room",
    );
    expect(container.querySelector('[data-message-id="notice"]')).toBeNull();
    expect(
      container.querySelector('[data-message-id="after"]'),
    ).toHaveAttribute("data-group-start", "true");
  });

  it("starts a new conversation across local midnight even without a five-minute gap", () => {
    const first = {
      ...ordinaryAgentMessage(),
      id: "before-midnight",
      created_at: new Date(2026, 9, 22, 23, 59).toISOString(),
    };
    const next = {
      ...first,
      id: "after-midnight",
      created_at: new Date(2026, 9, 23, 0, 0).toISOString(),
    };
    const { container } = renderTimeline([first, next]);
    expect(
      container.querySelectorAll(".room-conversation-time time"),
    ).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Codex" })).toHaveLength(2);
  });

  it("restores the author after another member speaks", () => {
    const first = {
      ...ordinaryAgentMessage(),
      id: "first",
      created_at: "2026-10-22T10:00:00Z",
    };
    const human = {
      ...ordinaryHumanMessage(),
      created_at: "2026-10-22T10:01:00Z",
    };
    const next = { ...first, id: "next", created_at: "2026-10-22T10:02:00Z" };
    const { container } = renderTimeline([first, human, next]);
    expect(
      container.querySelectorAll(".room-conversation-time time"),
    ).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Codex" })).toHaveLength(2);
  });

  it("records the complete Agent message only after its text DOM is committed", () => {
    const message = ordinaryAgentMessage();
    const log = vi
      .spyOn(console, "debug")
      .mockImplementation((event, fields) => {
        if (event === "room.render_timing" && fields.surface === "message")
          expect(screen.getByText(message.raw_message)).toBeInTheDocument();
      });
    try {
      const view = renderTimeline([message, ordinaryHumanMessage()]);
      view.rerender(
        timelineElement([structuredClone(message), ordinaryHumanMessage()]),
      );
      const renders = log.mock.calls.filter(
        ([, fields]) => fields?.surface === "message",
      );
      expect(renders).toHaveLength(1);
      expect(renders[0]?.[1]).toMatchObject({
        messageId: message.id,
        roomId: message.room_id,
        phase: "dom_committed",
        result: "rendered",
      });
      expect(JSON.stringify(renders)).not.toContain(message.raw_message);
    } finally {
      log.mockRestore();
    }
  });

  it("reuses unchanged history during outgoing updates but renders edits and current actions", () => {
    const renderMarkdown = vi.spyOn(markdown, "MessageMarkdown");
    const first = ordinaryHumanMessage();
    const second = {
      ...ordinaryHumanMessage(),
      id: "second",
      raw_message: "Second",
      segments: [{ type: "text" as const, content: "Second" }],
    };
    const queryClient = new QueryClient();
    const props: ComponentProps<typeof MessageTimeline> = {
      messages: [first, second],
      canLoadOlder: false,
      loadingOlder: false,
      onCancel: vi.fn(),
      onCardDecision: vi.fn(),
      onCloseLinkedSource: vi.fn(),
      onOpenArtifact: vi.fn(),
      onOpenMessageFile: vi.fn(),
      onOpenProfile: vi.fn(),
      onOpenThread: vi.fn(),
      onRetry: vi.fn(),
      pendingMessages: [],
      presentations: {},
      tenantId: "tenant-1",
    };
    const element = (changes: Partial<typeof props>) => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <MessageTimeline {...props} {...changes} />
        </MemoryRouter>
      </QueryClientProvider>
    );
    const view = render(element({}));
    const historyRenders = () =>
      renderMarkdown.mock.calls.filter(
        ([value]) => value.body === first.raw_message,
      ).length;
    const count = historyRenders();
    expect(count).toBeGreaterThan(0);
    view.rerender(
      element({
        pendingMessages: [
          {
            attachments: [],
            body: "Outgoing",
            clientId: "queued",
            contextMessages: [],
            createdAt: Date.now(),
            mentions: [],
            status: "sending",
          },
        ],
      }),
    );
    expect(screen.getByText("Outgoing")).toBeVisible();
    expect(historyRenders()).toBe(count);
    const edited = {
      ...second,
      raw_message: "Edited",
      segments: [{ type: "text" as const, content: "Edited" }],
    };
    view.rerender(element({ messages: [first, edited] }));
    expect(screen.getByText("Edited")).toBeVisible();
    expect(historyRenders()).toBe(count);
    const onOpenThread = vi.fn();
    view.rerender(
      element({
        messages: [first, edited],
        onOpenThread,
        selectedContextMessageIds: new Set([first.id]),
      }),
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: "More message actions" })[0]!,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Reply to thread" }));
    expect(onOpenThread).toHaveBeenCalledWith(first, { focusComposer: true });
    expect(props.onOpenThread).not.toHaveBeenCalled();
    expect(
      document.querySelector(`[data-message-id="${first.id}"]`),
    ).toHaveAttribute("data-selected-context", "true");
    renderMarkdown.mockRestore();
  });

  it("shows a muted clock and Routine name only on a scheduled Agent reply", () => {
    const scheduled = {
      ...ordinaryAgentMessage(),
      routine_name: "Daily anime pick",
    };
    const ordinary = { ...ordinaryAgentMessage(), id: "ordinary-agent" };
    const human = {
      ...ordinaryHumanMessage(),
      routine_name: "Not an Agent task",
    };
    renderTimeline([scheduled, ordinary, human]);

    const label = screen.getByTestId("message-routine-label");
    expect(label).toHaveAttribute(
      "aria-label",
      "Scheduled task: Daily anime pick",
    );
    expect(label).toHaveClass("text-app-muted");
    expect(label.querySelector("svg")).not.toBeNull();
    expect(screen.getByText("Daily anime pick")).toBeVisible();
    expect(screen.queryByText("Not an Agent task")).toBeNull();
    expect(screen.getAllByText("An ordinary Agent answer")).toHaveLength(2);
  });

  it("renders the same Document consistently across Human and Agent labels and metadata refreshes", () => {
    const human = ordinaryHumanMessage();
    const agent = ordinaryAgentMessage();
    human.segments = [
      {
        type: "document",
        document_id: "shared",
        content: "Old title.md",
        presentation: "card",
      },
    ];
    agent.segments = [
      {
        type: "document",
        document_id: "shared",
        content: "Other title.pdf",
        presentation: "card",
      },
    ];
    const messages = [human, agent];
    const view = renderTimeline(messages, {
      documentMetadata: {
        shared: {
          title: "Current title",
          format: "blocknote",
          representation_format: "markdown",
        },
      },
    });
    expect(
      screen.getAllByRole("button", { name: "Open Current title" }),
    ).toHaveLength(2);
    expect(screen.getAllByText("Online document")).toHaveLength(2);
    expect(screen.queryByText("Markdown")).toBeNull();
    expect(screen.queryByText("PDF")).toBeNull();
    view.rerender(
      timelineElement(messages, {
        documentMetadata: {
          shared: {
            title: "Renamed",
            format: "blocknote",
            representation_format: "markdown",
          },
        },
      }),
    );
    expect(
      screen.getAllByRole("button", { name: "Open Renamed" }),
    ).toHaveLength(2);
  });
  it("shows a delivery card as its title bubble and its files as ordinary file items, without its text", () => {
    const message = ordinaryAgentMessage();
    const onOpenMessageFile = vi.fn();
    message.card_title = "Last week competitor findings";
    message.raw_message = "Company A cut enterprise pricing 15%.comparison";
    message.segments = [
      { type: "text", content: "Company A cut enterprise pricing 15%." },
      {
        type: "document",
        document_id: "doc-table",
        content: "comparison",
        presentation: "card",
      },
    ];
    const { container } = renderTimeline(message, {
      documentMetadata: {
        "doc-table": {
          title: "competitor-comparison.xlsx",
          format: "binary",
          representation_format: "binary",
          version: {
            filename: "competitor-comparison.xlsx",
            media_type:
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          },
        },
      },
      onOpenMessageFile,
      // The card's file also has its attachment row; it still shows once.
      presentations: {
        [message.id]: {
          attachments: [
            {
              available: true,
              document: { id: "doc-table", title: "comparison" },
              filename: "competitor-comparison.xlsx",
              id: "attachment-table",
              mediaType:
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              sizeBytes: 2048,
            },
          ],
          mentions: [],
        },
      },
    });
    const card = screen.getByRole("region", {
      name: "Last week competitor findings",
    });
    expect(
      within(card).queryByText("Company A cut enterprise pricing 15%."),
    ).toBeNull();
    // The file is the same item every Message file uses, once.
    const file = within(card).getByRole("button", {
      name: "Preview competitor-comparison.xlsx",
    });
    expect(file.closest("[data-message-file-item]")).toHaveClass("rounded-xl");
    expect(within(card).getByText("Excel · 2 KB")).toBeVisible();
    expect(container.querySelectorAll("[data-message-file-item]")).toHaveLength(
      1,
    );
    fireEvent.click(file);
    expect(onOpenMessageFile).toHaveBeenCalledWith(
      expect.objectContaining({ document_id: "doc-table" }),
    );
    expect(container.querySelector(".room-message-bubble")).toBeNull();
    expect(within(card).queryByRole("link", { name: "Open" })).toBeNull();
  });
  it("does not enhance a Profile-like card without confirming its owner", () => {
    const message = ordinaryAgentMessage();
    message.card_title = "Jenny Bin";
    message.raw_message =
      "Growth Design Lead · Northstar\n\nProfile ready. See the Wiki Profile page.";
    message.segments = [{ type: "text", content: message.raw_message }];
    renderTimeline(message);
    const card = screen.getByRole("region", { name: "Jenny Bin" });
    expect(
      within(card).queryByRole("img", { name: "Jenny Bin avatar" }),
    ).toBeNull();
    expect(within(card).queryByRole("link", { name: "Open" })).toBeNull();
    expect(within(card).queryByText(/Growth Design Lead/)).toBeNull();
  });
  it("links only a card TeamHub marks as the Profile delivery to Wiki Profile", async () => {
    const runtime = createDocumentTestRuntime();
    const delivery = ordinaryAgentMessage();
    delivery.card_title = "Jenny Bin";
    delivery.card_kind = "profile";
    delivery.raw_message =
      "Growth Design Lead · Northstar\n\nShe leads onboarding design.";
    delivery.segments = [{ type: "text", content: delivery.raw_message }];
    const lookalike = ordinaryAgentMessage();
    lookalike.id = "message-lookalike";
    lookalike.card_title = "Weekly digest";
    lookalike.raw_message = "See the wiki profile page";
    lookalike.segments = [{ type: "text", content: lookalike.raw_message }];
    runtime.server.on("GET", "/v0/tenants/{tenantId}/another-me", () => ({
      room_id: delivery.room_id,
      agent_actor_id: delivery.author.id,
    }));
    vi.spyOn(runtime.client, "getPersonalProfile").mockResolvedValue({
      history: [],
      has_more: false,
    });
    render(
      <TeamHubRuntimeProvider runtime={runtime}>
        {timelineElement([delivery, lookalike])}
      </TeamHubRuntimeProvider>,
    );
    const card = screen.getByRole("region", { name: "Jenny Bin" });
    expect(
      await within(card).findByRole("link", { name: "Open" }),
    ).toHaveAttribute("href", "/t/tenant-1/library/wiki");
    const digest = screen.getByRole("region", { name: "Weekly digest" });
    expect(within(digest).queryByRole("link", { name: "Open" })).toBeNull();
    expect(within(digest).queryByText("See the wiki profile page")).toBeNull();
  });
  it("opens the Actor from an Agent reference whose label has no at prefix", () => {
    const message = ordinaryAgentMessage();
    const onOpenProfile = vi.fn();
    message.raw_message = "Please review, lu";
    message.segments = [
      { type: "text", content: "Please review, " },
      {
        type: "reference",
        content: "lu",
        target: "actor-lu",
        target_type: "user",
      },
    ];
    renderTimeline(message, { onOpenProfile });
    fireEvent.click(screen.getByRole("button", { name: "@lu" }));
    expect(onOpenProfile).toHaveBeenCalledWith("actor-lu");
  });
  it.each(["human", "agent"] as const)(
    "renders %s image attachments once in fresh and historical Messages",
    async (authorKind) => {
      const runtime = createDocumentTestRuntime();

      const document = await seedRoomUpload(runtime, "timeline-image", {
        representationFormat: "png",
        file: new File(["image"], "photo.png", { type: "image/png" }),
      });
      const version = await readDocumentVersion(
        runtime.client,
        document.current_version!.id,
      );
      const load = vi
        .spyOn(previewLoader, "loadArtifactPreview")
        .mockResolvedValue({
          decision: { kind: "image" },
          dispose: () => {},
          objectUrl: "blob:timeline-image",
          version,
        });
      const message =
        authorKind === "human"
          ? ordinaryHumanMessage()
          : ordinaryAgentMessage();
      const file = {
        content: "photo.png",
        document_id: document.id,
        document_version_id: version.id,
        filename: "photo.png",
        media_type: "image/png",
        type: "file" as const,
      };
      message.segments = [
        { type: "text", content: "Look at photo.png\n" },
        file,
      ];
      const onOpenMessageFile = vi.fn();
      const onOpenArtifact = vi.fn();
      const element = (presentations = {}, documentMetadata = {}) => (
        <TeamHubRuntimeProvider runtime={runtime}>
          {timelineElement(message, {
            presentations,
            documentMetadata,
            onOpenMessageFile,
            onOpenArtifact,
          })}
        </TeamHubRuntimeProvider>
      );
      try {
        message.attachments = [
          {
            id: "attachment-image",
            document_version_id: version.id,
            sha256: version.sha256,
            document_id: document.id,
            filename: "photo.png",
            media_type: "image/png",
            size_bytes: 5,
            available: true,
          },
        ];
        const view = render(
          element(
            {
              [message.id]: {
                attachments: presentTeamHubMessageAttachments(message),
                mentions: [],
              },
            },
            { [document.id]: { ...document, version } },
          ),
        );
        await screen.findByRole("img", { name: "photo.png" });
        expect(screen.getAllByRole("img", { name: "photo.png" })).toHaveLength(
          1,
        );
        expect(screen.getByText("Look at photo.png")).toBeVisible();
        // The file segment and its attachment row are one image, shown
        // itself rather than as a file item.
        expect(screen.queryByText("photo.png")).not.toBeInTheDocument();
        expect(screen.queryByText("Image · 5 B")).not.toBeInTheDocument();
        // Historical Messages without a hydrated attachment presentation still use
        // the immutable identity carried by their file segment.
        view.rerender(element());
        await screen.findByRole("img", { name: "photo.png" });
        fireEvent.click(
          screen.getByRole("button", { name: "Preview photo.png" }),
        );
        expect(onOpenArtifact).toHaveBeenCalledWith(
          expect.objectContaining({
            id: document.id,
            current_version: { id: version.id },
          }),
        );
        expect(onOpenMessageFile).not.toHaveBeenCalled();
        expect(load).toHaveBeenLastCalledWith(
          expect.objectContaining({
            documentId: document.id,
            versionId: version.id,
          }),
        );
        const reference = {
          type: "document" as const,
          document_id: document.id,
          content: "photo.png",
          presentation: "card" as const,
        };
        message.segments = [reference];
        view.rerender(element({}, { [document.id]: { ...document, version } }));
        await screen.findByRole("img", { name: "photo.png" });
        fireEvent.click(
          screen.getByRole("button", { name: "Preview photo.png" }),
        );
        expect(onOpenMessageFile).toHaveBeenCalledWith(reference);
        view.unmount();
      } finally {
        load.mockRestore();
      }
    },
  );

  it("renders timeline Message lists without React key warnings", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    renderTimeline([ordinaryHumanMessage(), ordinaryAgentMessage()]);

    const errors = consoleError.mock.calls.flat().join(" ");
    consoleError.mockRestore();
    expect(errors).not.toContain('unique "key" prop');
  });

  it("exposes ordinary Reply, multi-select, and mention actions", () => {
    const message = ordinaryAgentMessage();
    const onForwardMessage = vi.fn();
    const onMentionAuthor = vi.fn();
    const onReply = vi.fn();

    renderTimeline(message, {
      onForwardMessage,
      onMentionAuthor,
      onReply,
    });

    fireEvent.click(
      screen.getByRole("button", { name: "More message actions" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Reply to message" }));

    const authorButton = screen.getByRole("button", { name: "Codex" });
    fireEvent.click(authorButton);

    expect(onReply).toHaveBeenCalledWith(message);

    expect(onMentionAuthor).toHaveBeenCalledWith(message.author);
    expect(authorButton.firstElementChild?.tagName).toBe("svg");
    expect(
      screen.getAllByRole("tooltip").map((tooltip) => tooltip.textContent),
    ).toEqual(["Copy message"]);
    fireEvent.click(
      screen.getByRole("button", { name: "More message actions" }),
    );
    expect(
      screen.getByRole("menuitem", { name: "Reply to message" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("menuitem", { name: "Forward message" }));
    expect(onForwardMessage).toHaveBeenCalledWith(message);
  });

  it.each(["timeline", "linked source"] as const)(
    "distinguishes unavailable members, former members, and mentionable authors in %s",
    (renderPath) => {
      const message = ordinaryAgentMessage();
      const onMentionAuthor = vi.fn();
      const interactions = {
        onMentionAuthor,
        ...(renderPath === "linked source"
          ? { linkedSource: { kind: "ready" as const, message } }
          : {}),
      };
      const messages = renderPath === "timeline" ? [message] : [];
      const view = renderTimeline(messages, {
        ...interactions,
        memberActorIds: new Set([message.author.id]),
        mentionableActorIds: new Set(),
      });
      const authorButton = () => screen.getByRole("button", { name: "Codex" });

      expect(authorButton()).toBeDisabled();
      expect(authorButton()).toHaveAttribute(
        "title",
        "Codex is unavailable right now",
      );
      fireEvent.click(authorButton());
      expect(onMentionAuthor).not.toHaveBeenCalled();

      view.rerender(
        timelineElement(messages, {
          ...interactions,
          mentionableActorIds: new Set(),
        }),
      );
      expect(authorButton()).toBeDisabled();
      expect(authorButton()).toHaveAttribute(
        "title",
        "Codex is no longer in this Room",
      );
      fireEvent.click(authorButton());
      expect(onMentionAuthor).not.toHaveBeenCalled();

      view.rerender(
        timelineElement(messages, {
          ...interactions,
          mentionableActorIds: new Set([message.author.id]),
        }),
      );
      expect(authorButton()).toBeEnabled();
      expect(authorButton()).toHaveAttribute("title", "Mention Codex");
      fireEvent.click(authorButton());
      expect(onMentionAuthor).toHaveBeenCalledWith(message.author);
    },
  );

  it("renders historical Messages when presentation attachments are null", () => {
    const message = ordinaryAgentMessage();

    renderTimeline(message, {
      presentations: {
        [message.id]: { attachments: null, mentions: [] },
      } as unknown as ComponentProps<typeof MessageTimeline>["presentations"],
    });

    expect(screen.getByText("An ordinary Agent answer")).toBeVisible();
  });

  it("renders historical Messages when presentation mentions are null", () => {
    const message = ordinaryAgentMessage();

    renderTimeline(message, {
      presentations: {
        [message.id]: { attachments: [], mentions: null },
      } as unknown as ComponentProps<typeof MessageTimeline>["presentations"],
    });

    expect(screen.getByText("An ordinary Agent answer")).toBeVisible();
  });

  it("hides the sidebar action when thread opening is not available", () => {
    renderTimeline(ordinaryAgentMessage(), {
      onOpenThread: undefined,
    });

    expect(
      screen.queryByRole("button", { name: "Reply to thread" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy message" })).toBeVisible();
  });

  it("shows a parent reply record after Thread replies exist", () => {
    const message = ordinaryAgentMessage();
    const onOpenThread = vi.fn();
    message.thread = {
      reply_count: 2,
      room_id: "room-thread-1",
    };
    renderTimeline(message, { onOpenThread });

    fireEvent.click(
      screen.getByRole("button", { name: "Open thread, 2 replies" }),
    );
    expect(onOpenThread).toHaveBeenCalledWith(message);
    expect(screen.getByText("2 replies")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Open thread, 2 replies" }),
    ).toHaveClass("h-6", "bg-muted");
    expect(
      screen
        .getByRole("button", { name: "Open thread, 2 replies" })
        .querySelector("svg"),
    ).not.toBeNull();
  });

  it("renders reply context before the committed Message body", () => {
    const message = ordinaryAgentMessage();
    message.context_messages = [
      {
        author: {
          display_name: "Alice",
          id: "human-1",
          kind: "human",
          tenant_id: "tenant-1",
        },
        created_at: "2026-07-30T07:59:00Z",
        message_id: "message-context",
        raw_message: "## Original **question**",
        segments: [{ content: "## Original **question**", type: "text" }],
      },
    ];

    renderTimeline(message);

    const context = screen.getByLabelText("Reply context");
    const body = screen.getByText("An ordinary Agent answer");
    expect(
      context.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(context).toHaveTextContent("Original question");
    expect(context).not.toHaveTextContent("**");
  });

  it("renders a typed Document reference inline and preserves its identity", () => {
    const message = ordinaryAgentMessage();
    message.raw_message = "Review @Launch_plan today";
    message.segments = [
      { content: "Review ", type: "text" },
      {
        content: "@Launch_plan",
        document_id: "document-plan",
        presentation: "inline",
        type: "document",
      },
      { content: " today", type: "text" },
    ];
    const onOpenMessageFile = vi.fn();
    renderTimeline(message, { onOpenMessageFile });

    const reference = screen.getByRole("button", {
      name: "Open Launch_plan",
    });
    expect(reference).toHaveAttribute("data-reference-kind", "document");
    expect(screen.queryByText("Review @Launch_plan today")).toBeNull();
    fireEvent.click(reference);
    expect(onOpenMessageFile).toHaveBeenCalledWith({
      content: "Launch_plan",
      document_id: "document-plan",
      presentation: "inline",
      type: "document",
    });
    expect(
      screen.queryByRole("button", { name: "Open @Launch_plan" }),
    ).not.toBeInTheDocument();
  });

  it("shows a file an Agent attached once, as an item after its text bubble", () => {
    const message = ordinaryAgentMessage();
    const file = {
      content: "brief.md",
      document_id: "document-brief",
      document_version_id: "version-brief",
      filename: "brief.md",
      media_type: "text/markdown",
      type: "file" as const,
    };
    message.raw_message = "Here is the brief\nbrief.md";
    message.segments = [{ type: "text", content: "Here is the brief\n" }, file];
    const onOpenMessageFile = vi.fn();
    const { container } = renderTimeline(message, {
      onOpenMessageFile,
      presentations: {
        [message.id]: {
          attachments: [
            {
              available: true,
              document: { id: "document-brief", title: "brief.md" },
              filename: "brief.md",
              id: "attachment-brief",
              mediaType: "text/markdown",
              sizeBytes: 2048,
            },
          ],
          mentions: [],
        },
      },
    });

    expect(container.querySelectorAll("[data-message-file-item]")).toHaveLength(
      1,
    );
    expect(screen.getByText("Markdown · 2 KB")).toBeVisible();
    const item = screen.getByRole("button", { name: "Preview brief.md" });
    expect(item.closest(".room-message-bubble")).toBeNull();
    fireEvent.click(item);
    expect(onOpenMessageFile).toHaveBeenCalledWith(file);
  });

  it("shows a person's uploads after their text, on their side", () => {
    const message = ordinaryHumanMessage();
    const onOpenArtifact = vi.fn();
    const attachment = {
      available: true,
      document: { id: "document-notes", title: "notes.pdf" },
      filename: "notes.pdf",
      id: "attachment-notes",
      mediaType: "application/pdf",
      sizeBytes: 3 * 1024 * 1024,
    };
    const { container } = renderTimeline(message, {
      onOpenArtifact,
      presentations: {
        [message.id]: {
          attachments: [
            attachment,
            {
              ...attachment,
              available: false,
              document: { id: "document-old", title: "old.zip" },
              filename: "old.zip",
              id: "attachment-old",
              mediaType: "application/zip",
            },
          ],
          mentions: [],
        },
      },
    });

    const runs = [
      ...container.querySelector(".room-message-body-main")!.children,
    ];
    expect(runs[0]).toHaveClass("room-message-bubble");
    expect(runs[0]).toHaveTextContent("Please handle this here");
    // A person's own files line up on their side, with the bubble.
    expect(runs[1]).toHaveClass("justify-end");
    expect(screen.getByText("PDF · 3.0 MB")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Preview notes.pdf" }));
    expect(onOpenArtifact).toHaveBeenCalledWith(attachment.document);
    // An unavailable upload stays, greyed and without its action.
    const unavailable = screen.getByRole("button", {
      name: "old.zip is unavailable",
    });
    expect(unavailable).toBeDisabled();
    expect(unavailable.closest("[data-message-file-item]")).toHaveClass(
      "opacity-55",
    );
  });

  it("splits an Agent's text, file, text into a bubble, an item, and a bubble", () => {
    const message = ordinaryAgentMessage();
    message.raw_message = "Before\nreport.csv\nAfter";
    message.segments = [
      { type: "text", content: "Before\n" },
      {
        content: "report.csv",
        document_id: "document-report",
        document_version_id: "version-report",
        filename: "report.csv",
        media_type: "text/csv",
        type: "file",
      },
      { type: "text", content: "After" },
    ];
    const { container } = renderTimeline(message);

    const runs = [
      ...container.querySelector(".room-message-body-main")!.children,
    ];
    expect(runs).toHaveLength(3);
    expect(runs[0]).toHaveClass("room-message-bubble");
    expect(runs[0]).toHaveTextContent("Before");
    expect(
      runs[1]!.querySelector("[data-message-file-item]"),
    ).toHaveTextContent("report.csv");
    expect(runs[1]!.querySelector(".room-message-bubble")).toBeNull();
    expect(runs[2]).toHaveClass("room-message-bubble");
    expect(runs[2]).toHaveTextContent("After");
    // Actions anchor to the first bubble alone.
    expect(runs[0]!.querySelector(".message-row-actions")).not.toBeNull();
    expect(container.querySelectorAll(".message-row-actions")).toHaveLength(1);
  });

  it("shows a folder and a Document as the same file item", () => {
    const message = ordinaryAgentMessage();
    message.segments = [
      {
        content: "Published deck",
        directory_count: 3,
        entry_document_id: "document-index",
        entry_document_version_id: "version-index",
        file_count: 7,
        publication_group_id: "publication-group",
        root_path: "deck",
        total_bytes: 80 * 1024,
        type: "artifact_tree",
      },
      {
        content: "Plan",
        document_id: "document-plan",
        presentation: "card",
        type: "document",
      },
      {
        content: "Published assets",
        directory_count: 1,
        file_count: 1,
        publication_group_id: "publication-assets",
        root_path: "assets",
        total_bytes: 20,
        type: "artifact_tree",
      },
    ];
    const onOpenArtifact = vi.fn();
    const onOpenMessageFile = vi.fn();
    const { container } = renderTimeline(message, {
      onOpenArtifact,
      onOpenMessageFile,
      documentMetadata: {
        "document-plan": {
          title: "Launch plan",
          format: "blocknote",
          representation_format: "markdown",
        },
      },
    });

    expect(container.querySelectorAll("[data-message-file-item]")).toHaveLength(
      3,
    );
    expect(container.querySelector(".room-message-bubble")).toBeNull();
    expect(screen.getByText("7 files · 3 folders · 80 KB")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Preview deck" }));
    expect(onOpenArtifact).toHaveBeenCalledWith({
      current_version: { id: "version-index" },
      id: "document-index",
      title: "deck",
    });
    expect(screen.getByText("Online document")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Open Launch plan" }));
    expect(onOpenMessageFile).toHaveBeenCalledWith(message.segments[1]);
    // A folder without an entry page has nothing to open.
    expect(screen.getByRole("group", { name: "assets" })).toHaveTextContent(
      "1 file · 1 folder · 20 B",
    );
  });

  it("renders a delivered Document as the shared attachment card", () => {
    const message = ordinaryAgentMessage();
    const delivered = {
      content: "teamhub-product-introduction.md",
      document_id: "document-product-introduction",
      presentation: "card" as const,
      type: "document" as const,
    };
    message.raw_message = `Done\n${delivered.content}`;
    message.segments = [{ content: "Done\n", type: "text" }, delivered];
    const onOpenMessageFile = vi.fn();
    renderTimeline(message, {
      onOpenMessageFile,
      documentMetadata: {
        "document-product-introduction": {
          title: "Product introduction",
          format: "blocknote",
          representation_format: "markdown",
        },
      },
    });

    const card = screen.getByRole("button", {
      name: "Open Product introduction",
    });
    // The Document sits outside the text bubble, after it.
    expect(card.closest(".room-message-bubble")).toBeNull();
    expect(
      screen.getByText("Done").closest(".room-message-bubble"),
    ).not.toBeNull();
    expect(screen.getByText("Online document")).toBeVisible();
    expect(card.querySelector('[data-kind="document"]')).toBeInTheDocument();
    fireEvent.click(card);
    expect(onOpenMessageFile).toHaveBeenCalledWith(delivered);
    expect(
      screen.queryByRole("button", { name: "Open product-introduction.md" }),
    ).not.toBeInTheDocument();
  });

  it("uses current Document metadata for a legacy at-prefixed attachment", () => {
    const message = ordinaryAgentMessage();
    message.segments = [
      { content: message.raw_message, type: "text" },
      {
        content: "@signed.txt",
        document_id: "document-signed",
        document_version_id: "version-signed",
        type: "file",
      },
    ];
    const onOpenMessageFile = vi.fn();
    renderTimeline(message, {
      onOpenMessageFile,
      documentMetadata: {
        "document-signed": {
          title: "Signed agreement",
          format: "plain_text",
          representation_format: "plain_text",
        },
      },
    });

    const attachmentCard = screen.getByRole("button", {
      name: "Preview Signed agreement",
    });
    expect(attachmentCard.closest(".room-message-bubble")).toBeNull();
    fireEvent.click(attachmentCard);
    expect(onOpenMessageFile).toHaveBeenCalledWith(message.segments[1]);
    expect(
      screen.queryByRole("button", { name: "Preview signed.txt" }),
    ).not.toBeInTheDocument();
  });

  it("hides preview actions for ordinary uploaded files when previews are disabled", () => {
    const message = ordinaryHumanMessage();
    renderTimeline(message, {
      messageFilePreview: "disabled",
      documentMetadata: {
        "document-slide-deck": {
          title: "slide-deck.zip",
          format: "zip",
          representation_format: "zip",
        },
      },
      presentations: {
        [message.id]: {
          attachments: [
            {
              available: true,
              document: {
                current_version: { id: "version-slide-deck" },
                id: "document-slide-deck",
                title: "slide-deck.zip",
              },
              filename: "slide-deck.zip",
              id: "attachment-slide-deck",
              mediaType: "application/zip",
              sizeBytes: 1_058_611,
            },
          ],
          mentions: [],
        },
      },
    });

    expect(screen.getByRole("group", { name: "slide-deck.zip" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Open slide-deck.zip" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("View")).not.toBeInTheDocument();
  });

  it("does not render agent_runtime Messages in the conversation timeline", () => {
    const message = ordinaryAgentMessage();
    message.message_kind = "agent_runtime";
    message.raw_message = "Human submitted interaction interaction-1: approve";
    message.segments = [{ content: message.raw_message, type: "text" }];

    renderTimeline(message);

    expect(
      screen.queryByText("Human submitted interaction interaction-1: approve"),
    ).toBeNull();
    expect(screen.queryByRole("article")).toBeNull();
  });

  it("does not render an internal Typed Card decision receipt", () => {
    const message = ordinaryAgentMessage();
    message.author = {
      display_name: "Alice",
      id: "human-1",
      kind: "human",
      tenant_id: "tenant-1",
    };
    message.raw_message =
      "Decision outcome: kind=task_creation request_id=review-1 decision=approved";
    message.segments = [{ content: message.raw_message, type: "text" }];
    message.card_context_message_id = "message-card-1";

    renderTimeline(message);

    expect(screen.queryByText(/Decision outcome:/)).toBeNull();
  });

  it("uses the message Agent's workspace scope for Room card decisions", async () => {
    const message = roomCreationCardMessage();
    message.card = {
      card_type: "personal_notice",
      decision_id: "coordination-workspace-agent",
      status: "pending",
      decision_owner: {
        display_name: "Bob",
        id: "human-2",
        kind: "human",
      },
      intent: "decision_requested",
      kind: "room_creation",
      requester: { display_name: "Codex", id: "agent-1", kind: "agent" },
      title: "Request to create a collaboration room",
      room_creation: {
        initial_message_segments: [{ content: "Start.", type: "text" }],
        member_ids: [message.author.id],
        name: "release-owners",
        origin_room_id: "room-1",
      },
      version: 1,
    };

    renderTimeline(message, {
      workspaceAgentIds: new Set([message.author.id]),
    });

    expect(
      await screen.findByRole("button", { name: "Create Room" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Don't create" })).toBeVisible();
    expect(screen.queryByText("Only Bob can decide.")).toBeNull();
  });

  it("routes View activity from the compact status to the Room sidebar", () => {
    const onViewActivity = vi.fn();
    const initialEvents = [
      runtimeStatusRecord("1", "working"),
      runtimeActivityStartedRecord(
        "2",
        "activity-search",
        "search",
        "Searching the Room",
      ),
      runtimeActivityFinishedRecord("3", "activity-search", "succeeded"),
      runtimeActivityStartedRecord(
        "4",
        "activity-command",
        "command",
        "Running the focused tests",
      ),
    ];
    const view = render(
      <MemoryRouter>
        <AgentStreamingStatusDock
          runStatuses={[runStatus()]}
          onViewActivity={onViewActivity}
          runtimePresentationEventsByRunStatusId={{
            "run-status-1": initialEvents,
          }}
        />
      </MemoryRouter>,
    );

    const trigger = screen.getByRole("button", {
      name: "Open Agents working activity",
    });
    // The command names nothing, so the line keeps the search.
    expect(trigger).toHaveAttribute("title", "Codex: Searching");
    view.rerender(
      <MemoryRouter>
        <AgentStreamingStatusDock
          runStatuses={[runStatus()]}
          onViewActivity={onViewActivity}
          runtimePresentationEventsByRunStatusId={{
            "run-status-1": [
              ...initialEvents,
              runtimeActivityUpdatedRecord(
                "5",
                "activity-command",
                "Completed 8 of 12 checks",
              ),
            ],
          }}
        />
      </MemoryRouter>,
    );
    expect(trigger).toHaveAttribute("title", "Codex: Searching");
    fireEvent.click(trigger);
    expect(screen.queryByText("Completed 8 of 12 checks")).toBeNull();

    expect(onViewActivity).toHaveBeenCalledWith(
      "run-status-1",
      expect.objectContaining({ id: "agent-1" }),
      "run-status-1",
    );
    expect(
      screen.queryByRole("dialog", { name: "Agents working" }),
    ).not.toBeInTheDocument();
  });

  it.each([
    [
      "command",
      { command: "git status --short", status_steps: ["Checking changes"] },
      "Checking changes",
    ],
    [
      "read",
      { file_path: "src/app.tsx", status_steps: ["Reading app.tsx"] },
      "Reading app.tsx",
    ],
    [
      "tool",
      {
        command: "teamhub agent create --name Juno",
        status_steps: ["Creating Juno"],
      },
      "Creating Juno",
    ],
    [
      "command",
      {
        command: "curl -s https://fares.test",
        status_title: "Fetch the fares",
      },
      "Fetch the fares",
    ],
    ["search", { pattern: "activity" }, "Searching"],
    ["tool", { server: "computer", arguments: {} }, "Using tools"],
  ] as const)(
    "names the %s action in the streaming dock",
    (kind, input, text) => {
      render(
        <MemoryRouter>
          <AgentStreamingStatusDock
            runStatuses={[runStatus()]}
            runtimePresentationEventsByRunStatusId={{
              "run-status-1": [
                runtimeStatusRecord("1", "working"),
                runtimeActivityStartedRecord(
                  "2",
                  "action",
                  kind,
                  "native_tool",
                  "segment-1",
                  [
                    {
                      label: "Input",
                      format: "json",
                      content: JSON.stringify(input),
                    },
                  ],
                ),
              ],
            }}
          />
        </MemoryRouter>,
      );
      expect(
        screen.getByTestId("agent-streaming-status-dock"),
      ).toHaveTextContent(text);
    },
  );

  it("opens View activity in the Room sidebar before a formal Agent Message exists", () => {
    const onViewActivity = vi.fn();
    render(
      <MemoryRouter>
        <AgentStreamingStatusDock
          runStatuses={[runStatus()]}
          onViewActivity={onViewActivity}
          runtimePresentationEventsByRunStatusId={{
            "run-status-1": [
              runtimeStatusRecord("1", "working"),
              runtimeActivityStartedRecord(
                "2",
                "activity-command",
                "command",
                "exec_command",
              ),
            ],
          }}
        />
      </MemoryRouter>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open Agents working activity" }),
    );

    expect(onViewActivity).toHaveBeenCalledWith(
      "run-status-1",
      expect.objectContaining({ id: "agent-1" }),
      "run-status-1",
    );
    expect(
      screen.queryByRole("region", { name: "Activity details" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "Agents working" }),
    ).not.toBeInTheDocument();
  });

  describe("server Run state", () => {
    function dockElement(
      props: ComponentProps<typeof AgentStreamingStatusDock> = {},
    ) {
      return (
        <QueryClientProvider client={new QueryClient()}>
          <MemoryRouter>
            <AgentStreamingStatusDock
              cancelRoomRun={vi.fn()}
              runStatuses={[runStatus({ run_id: "run-1" })]}
              {...props}
            />
          </MemoryRouter>
        </QueryClientProvider>
      );
    }

    it("observes Dock disappearance with the prior run identity after the DOM changes", () => {
      const log = vi
        .spyOn(console, "debug")
        .mockImplementation((_event, fields) => {
          if (fields?.surface === "dock" && fields.phase === "dom_committed")
            expect(
              screen.queryByTestId("agent-streaming-status-dock") !== null,
            ).toBe(fields.result === "working");
        });
      try {
        const view = render(dockElement());
        view.rerender(dockElement({ runStatuses: [] }));
        expect(log).toHaveBeenLastCalledWith(
          "room.render_timing",
          expect.objectContaining({
            surface: "dock",
            result: "stopped",
            previous: expect.objectContaining({ runIds: ["run-1"] }),
          }),
        );
      } finally {
        log.mockRestore();
      }
    });

    it("shows a Run from its start through its progress to its end", () => {
      const view = render(dockElement());
      // Start: an active Run before its first event.
      expect(shownStatus()).toBe("Codex: Starting");
      expect(stopButton("Stop Codex's task")).toBeVisible();

      // In progress: the Run's own activity.
      view.rerender(
        dockElement({
          runStatuses: [runStatus({ run_id: "run-1", revision: 2 })],
          runtimePresentationEventsByRunStatusId: {
            "run-status-1": [
              runtimeStatusRecord("1", "working"),
              runtimeActivityStartedRecord("2", "search-1", "search", "Search"),
            ],
          },
        }),
      );
      expect(shownStatus()).toBe("Codex: Searching");
      expect(stopButton("Stop Codex's task")).toBeVisible();

      // End: the pushed Run status completes.
      view.rerender(
        dockElement({
          runStatuses: [
            runStatus({ run_id: "run-1", revision: 3, status: "completed" }),
          ],
        }),
      );
      expect(screen.queryByTestId("agent-streaming-status-dock")).toBeNull();
      expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();
    });

    it("shows an aborted Run whose outcome has not loaded as stopped, without Stop", () => {
      const view = render(dockElement());
      view.rerender(
        dockElement({
          runStatuses: [
            runStatus({ run_id: "run-1", revision: 2, status: "aborted" }),
          ],
        }),
      );
      expect(shownStatus()).toBe("Codex: Run stopped");
      expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();
    });

    it.each([
      { replied: true, status: "active" as const },
      { replied: false, status: "completed" as const },
    ])("hides a Run whose Run status says %j", (change) => {
      render(
        dockElement({
          runStatuses: [runStatus({ run_id: "run-1", ...change })],
          runtimePresentationEventsByRunStatusId: {
            "run-status-1": [runtimeStatusRecord("1", "working")],
          },
        }),
      );
      expect(screen.queryByTestId("agent-streaming-status-dock")).toBeNull();
      expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();
    });

    it("removes a replied Run and shows it again when TeamHub revokes replied", () => {
      const events = {
        "run-status-1": [
          runtimeStatusRecord("1", "working"),
          runtimeMessageOutputRecord("2", "reply-1"),
          runtimeActivityStartedRecord("3", "search-1", "search", "Search"),
        ],
      };
      const view = render(
        dockElement({
          runStatuses: [runStatus({ run_id: "run-1", replied: true })],
          runtimePresentationEventsByRunStatusId: events,
        }),
      );
      expect(screen.queryByTestId("agent-streaming-status-dock")).toBeNull();
      expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();

      view.rerender(
        dockElement({
          runStatuses: [
            runStatus({ run_id: "run-1", replied: false, revision: 2 }),
          ],
          runtimePresentationEventsByRunStatusId: events,
        }),
      );
      expect(shownStatus()).toBe("Codex: Searching");
      expect(stopButton("Stop Codex's task")).toBeVisible();
    });

    it("shows a local typing Agent as starting without Stop or activity", () => {
      render(
        dockElement({
          runStatuses: [],
          typingAgent: { display_name: "Another Me", id: "agent-me" },
        }),
      );
      expect(shownStatus()).toBe("Another Me: Starting");
      expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();
      expect(
        screen.getByRole("button", { name: "Open Agents working activity" }),
      ).toBeDisabled();
    });
  });

  it("keeps Working through a queued run and queued runtime events", () => {
    const view = (phase: number) => (
      <MemoryRouter>
        <AgentStreamingStatusDock
          runStatuses={[runStatus()]}
          runtimePresentationEventsByRunStatusId={
            phase === 2
              ? { "run-status-1": [runtimeStatusRecord("1", "queued")] }
              : {}
          }
        />
      </MemoryRouter>
    );
    const { rerender } = render(view(1));
    for (const phase of [1, 2]) {
      rerender(view(phase));
      expect(shownStatus()).toBe("Codex: Starting");
      expect(screen.queryByText(/Waiting/)).not.toBeInTheDocument();
    }
  });

  it.each([true, false])(
    "prioritizes recovery and clears it when caught up (replayed activity: %s)",
    (hasReplayedActivity) => {
      vi.useFakeTimers();
      const recovery = runtimeActivityStartedRecord(
        "2",
        "recovery",
        "recovery",
        "Recovering run status",
      );
      const view = (finished: boolean) => (
        <MemoryRouter>
          <AgentStreamingStatusDock
            runStatuses={[runStatus()]}
            runtimePresentationEventsByRunStatusId={{
              "run-status-1": [
                runtimeStatusRecord("1", "working"),
                recovery,
                ...(hasReplayedActivity
                  ? [
                      runtimeActivityStartedRecord(
                        "3",
                        "tool",
                        "tool",
                        "Using old tool",
                      ),
                    ]
                  : []),
                ...(finished
                  ? [
                      {
                        ...recovery,
                        event_ordinal: "4",
                        event: {
                          type: "activity.finished" as const,
                          activity_id: "recovery",
                          outcome: "succeeded" as const,
                        },
                      },
                    ]
                  : []),
              ],
            }}
          />
        </MemoryRouter>
      );
      const { rerender } = render(view(false));
      expect(shownStatus()).toBe("Codex: Recovering the task");
      rerender(view(true));
      passLineHolds();
      expect(shownStatus()).toBe(
        hasReplayedActivity ? "Codex: Using tools" : "Codex: Working",
      );
    },
  );

  it("only shows an explicit input wait while an interaction is active", () => {
    vi.useFakeTimers();
    const start = runtimeActivityStartedRecord(
      "2",
      "input",
      "interaction",
      "Confirm the next step",
    );
    const view = (finished: boolean) => (
      <MemoryRouter>
        <AgentStreamingStatusDock
          runStatuses={[runStatus()]}
          runtimePresentationEventsByRunStatusId={{
            "run-status-1": [
              runtimeStatusRecord("1", "working"),
              start,
              ...(finished
                ? [
                    {
                      ...start,
                      event_ordinal: "3",
                      event: {
                        type: "activity.finished" as const,
                        activity_id: "input",
                        outcome: "succeeded" as const,
                      },
                    },
                  ]
                : []),
            ],
          }}
        />
      </MemoryRouter>
    );
    const { rerender } = render(view(false));
    expect(shownStatus()).toBe("Codex: Waiting for your input");
    rerender(view(true));
    passLineHolds();
    expect(shownStatus()).toBe("Codex: Working");
  });

  it.each(["succeeded", "failed", "canceled", "declined"] as const)(
    "keeps naming a command after it %s until the next status, including replay",
    (outcome) => {
      vi.useFakeTimers();
      const events = [
        runtimeStatusRecord("1", "working"),
        runtimeActivityStartedRecord(
          "2",
          "command",
          "command",
          "exec_command",
          "segment-1",
          inputBlock({ command: "pnpm test", status_steps: ["Running tests"] }),
        ),
      ];
      const element = (finished: boolean) => (
        <MemoryRouter>
          <AgentStreamingStatusDock
            runStatuses={[runStatus()]}
            runtimePresentationEventsByRunStatusId={{
              "run-status-1": [
                ...events,
                ...(finished
                  ? [runtimeActivityFinishedRecord("3", "command", outcome)]
                  : []),
              ],
            }}
          />
        </MemoryRouter>
      );
      const view = render(element(false));
      const currentStatus = () =>
        screen.getByRole("button", { name: "Open Agents working activity" });
      expect(currentStatus()).toHaveAttribute("title", "Codex: Running tests");
      view.rerender(element(true));
      expect(currentStatus()).toHaveAttribute("title", "Codex: Running tests");
      passLineHolds();
      expect(currentStatus()).toHaveAttribute("title", "Codex: Running tests");
      view.unmount();
      // Seen only after it finished, as a quick tool between two updates.
      render(element(true));
      passLineHolds();
      expect(currentStatus()).toHaveAttribute("title", "Codex: Running tests");
    },
  );

  it("keeps a concurrent activity current until it ends, then follows explicit thinking", () => {
    vi.useFakeTimers();
    const events = [
      runtimeStatusRecord("1", "working"),
      runtimeActivityStartedRecord("2", "search", "search", "Search"),
      runtimeActivityStartedRecord("3", "command", "command", "exec_command"),
      runtimeActivityFinishedRecord("4", "command", "succeeded"),
    ];
    const element = (records: TeamHubRuntimePresentationEventRecord[]) => (
      <MemoryRouter>
        <AgentStreamingStatusDock
          runStatuses={[runStatus()]}
          runtimePresentationEventsByRunStatusId={{ "run-status-1": records }}
        />
      </MemoryRouter>
    );
    const view = render(element(events));
    const currentStatus = () =>
      screen.getByRole("button", { name: "Open Agents working activity" });
    expect(currentStatus()).toHaveAttribute("title", "Codex: Searching");
    view.rerender(
      element([
        ...events,
        runtimeActivityFinishedRecord("5", "search", "succeeded"),
        runtimeStatusRecord("6", "thinking", "Preparing a response"),
      ]),
    );
    passLineHolds();
    expect(currentStatus()).toHaveAttribute(
      "title",
      "Codex: Preparing a response",
    );
  });

  it.each([
    [
      "dots before the Agent's first event",
      [runtimeStatusRecord("1", "working")],
      "Codex: Starting",
    ],
    [
      "Thinking for thinking without a summary",
      [
        runtimeStatusRecord("1", "working"),
        runtimeStatusRecord("2", "thinking"),
      ],
      "Codex: Thinking",
    ],
    [
      "the complete thinking summary",
      [
        runtimeStatusRecord("1", "working"),
        runtimeStatusRecord("2", "thinking", "Checking fares. Then booking."),
      ],
      "Codex: Checking fares. Then booking.",
    ],
    [
      "Working once a message has gone out",
      [
        runtimeStatusRecord("1", "working"),
        runtimeActivityStartedRecord("2", "command", "command", "exec_command"),
        runtimeActivityFinishedRecord("3", "command", "succeeded"),
        runtimeActivityStartedRecord("4", "send", "message", "exec_command"),
        runtimeMessageOutputRecord("5", "reply-1"),
        runtimeActivityFinishedRecord("6", "send", "succeeded", "segment-2"),
      ],
      "Codex: Working",
    ],
  ] as const)("shows %s", (_name, records, title) => {
    vi.useFakeTimers();
    render(
      <MemoryRouter>
        <AgentStreamingStatusDock
          runStatuses={[runStatus()]}
          runtimePresentationEventsByRunStatusId={{
            "run-status-1": [...records],
          }}
        />
      </MemoryRouter>,
    );
    passLineHolds();
    const trigger = screen.getByRole("button", {
      name: "Open Agents working activity",
    });
    expect(trigger).toHaveAttribute("title", title);
    if (title !== "Codex: Starting") {
      expect(trigger).toHaveTextContent(title.slice("Codex: ".length));
    }
  });

  it("plays a group's steps in order, then keeps the last", () => {
    vi.useFakeTimers();
    const thinking = [
      runtimeStatusRecord("1", "working"),
      runtimeStatusRecord("2", "thinking", "Checking fares"),
    ];
    const element = (records: TeamHubRuntimePresentationEventRecord[]) => (
      <MemoryRouter>
        <AgentStreamingStatusDock
          runStatuses={[runStatus()]}
          runtimePresentationEventsByRunStatusId={{ "run-status-1": records }}
        />
      </MemoryRouter>
    );
    const view = render(element(thinking));
    expect(shownStatus()).toBe("Codex: Checking fares");
    view.rerender(
      element([
        ...thinking,
        runtimeActivityStartedRecord(
          "3",
          "fetch",
          "command",
          "exec_command",
          "segment-1",
          inputBlock({
            command: "curl -s https://fares.test -o f.json; python3 parse.py",
            status_steps: ["Fetching fares.test", "Running a script"],
          }),
        ),
      ]),
    );
    expect(shownStatus()).toBe("Codex: Checking fares");
    passLineHolds();
    expect(shownStatus()).toBe("Codex: Fetching fares.test");
    passLineHolds();
    expect(shownStatus()).toBe("Codex: Running a script");
    passLineHolds();
    expect(shownStatus()).toBe("Codex: Running a script");
  });

  it("keeps the last text, without minutes, for a command it cannot name", () => {
    vi.useFakeTimers();
    render(
      <MemoryRouter>
        <AgentStreamingStatusDock
          runStatuses={[runStatus()]}
          runtimePresentationEventsByRunStatusId={{
            "run-status-1": [
              runtimeStatusRecord("1", "working"),
              runtimeStatusRecord("2", "thinking", "Checking fares"),
              runtimeStatusRecord("3", "working"),
              runtimeActivityStartedRecord(
                "4",
                "unknown",
                "command",
                "exec_command",
                "segment-1",
                inputBlock({ command: "some-unknown-tool --flag" }),
              ),
            ],
          }}
        />
      </MemoryRouter>,
    );
    act(() => {
      vi.advanceTimersByTime(60_000 + AGENT_STATUS_LINE_TIMING.tickMs);
    });
    expect(shownStatus()).toBe("Codex: Checking fares");
    expect(screen.queryByText("· 1m")).toBeNull();
  });

  it("puts a long-running Activity's minutes right after its text", () => {
    vi.useFakeTimers();
    render(
      <MemoryRouter>
        <AgentStreamingStatusDock
          runStatuses={[runStatus()]}
          runtimePresentationEventsByRunStatusId={{
            "run-status-1": [
              runtimeStatusRecord("1", "working"),
              runtimeActivityStartedRecord(
                "2",
                "command",
                "command",
                "exec_command",
                "segment-1",
                inputBlock({
                  command: "pnpm test",
                  status_steps: ["Running tests"],
                }),
              ),
            ],
          }}
        />
      </MemoryRouter>,
    );
    act(() => {
      vi.advanceTimersByTime(60_000 + AGENT_STATUS_LINE_TIMING.tickMs);
    });
    // Inside the rolling text, not after the stretched roll.
    expect(
      screen.getByText("· 1m").closest(".town-status-roll-in"),
    ).toHaveTextContent("Running tests· 1m");
  });

  it("does not repeat the queued prompt in the composer dock", () => {
    render(
      <MemoryRouter>
        <AgentStreamingStatusDock
          runStatuses={[runStatus()]}
          runtimePresentationEventsByRunStatusId={{
            "run-status-1": [runtimeStatusRecord("1", "queued")],
          }}
        />
      </MemoryRouter>,
    );

    expect(shownStatus()).toBe("Codex: Starting");
    expect(
      screen.queryByText("Queued, waiting to run"),
    ).not.toBeInTheDocument();
  });

  it("keeps an unconfirmed follow-up visible after success without Stop or spinner", () => {
    const onViewActivity = vi.fn();
    const terminal = runtimeTerminalStatusRecord("2", "completed");
    render(
      <MemoryRouter>
        <AgentStreamingStatusDock
          runStatuses={[runStatus({ status: "completed" })]}
          onViewActivity={onViewActivity}
          cancelRoomRun={vi.fn()}
          runtimePresentationEventsByRunStatusId={{
            "run-status-1": [
              {
                ...terminal,
                event: {
                  type: "status.changed",
                  status: "stopped",
                  outcome: "completed",
                  unconfirmed_input_ids: ["follow-up"],
                },
              },
            ],
          }}
        />
      </MemoryRouter>,
    );
    const trigger = screen.getByRole("button", {
      name: "Open Agent status activity",
    });
    expect(trigger).toHaveTextContent("Follow-up delivery unconfirmed");
    expect(trigger.querySelector(".town-dots, .town-spinner")).toBeNull();
    fireEvent.click(trigger);
    expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();
    expect(onViewActivity).toHaveBeenCalledWith(
      "run-status-1",
      expect.objectContaining({ id: "agent-1" }),
      "run-status-1",
    );
  });

  it("offers Resend only for an unconfirmed follow-up of a known Run", async () => {
    const queryClient = new QueryClient();
    const redeliverRoomRun = vi.fn(() =>
      Promise.resolve({
        run_id: "run-status-1",
        status: "redelivered" as const,
        redelivered_count: 1,
      }),
    );
    const unconfirmed = {
      "run-status-1": [
        {
          ...runtimeTerminalStatusRecord("2", "completed"),
          event: {
            type: "status.changed" as const,
            status: "stopped" as const,
            outcome: "completed" as const,
            unconfirmed_input_ids: ["follow-up"],
          },
        },
      ],
    };
    const dock = (
      props: Partial<ComponentProps<typeof AgentStreamingStatusDock>>,
    ) => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <AgentStreamingStatusDock
            redeliverRoomRun={redeliverRoomRun}
            {...props}
          />
        </MemoryRouter>
      </QueryClientProvider>
    );
    const resend = () =>
      screen.queryByRole("button", {
        name: "Resend unconfirmed follow-up to Codex",
      });
    const { rerender } = render(dock({ runStatuses: [runStatus()] }));
    expect(resend()).toBeNull();
    // An aborted Run whose outcome has not loaded shows as stopped.
    rerender(dock({ runStatuses: [runStatus({ status: "aborted" })] }));
    expect(shownStatus()).toBe("Codex: Run stopped");
    expect(resend()).toBeNull();
    rerender(
      dock({
        runStatuses: [runStatus({ status: "completed", run_id: undefined })],
        runtimePresentationEventsByRunStatusId: unconfirmed,
      }),
    );
    expect(resend()).toBeNull();
    rerender(
      dock({
        runStatuses: [runStatus({ status: "completed" })],
        runtimePresentationEventsByRunStatusId: unconfirmed,
        redeliverRoomRun: undefined,
      }),
    );
    expect(resend()).toBeNull();
    rerender(
      dock({
        runStatuses: [runStatus({ status: "completed" })],
        runtimePresentationEventsByRunStatusId: unconfirmed,
      }),
    );
    fireEvent.click(resend()!);
    expect(await screen.findByText("Resent")).toBeInTheDocument();
    expect(resend()).toBeNull();
    expect(redeliverRoomRun).toHaveBeenCalledTimes(1);
    expect(redeliverRoomRun).toHaveBeenCalledWith("run-status-1");
    queryClient.clear();
  });

  it("offers Resend for a failed Run only when its follow-ups are unconfirmed", () => {
    const failedWith = (unconfirmed_input_ids?: string[]) => ({
      "run-status-1": [
        {
          ...runtimeTerminalStatusRecord("2", "failed"),
          event: {
            type: "status.changed" as const,
            status: "stopped" as const,
            outcome: "failed" as const,
            ...(unconfirmed_input_ids ? { unconfirmed_input_ids } : {}),
          },
        },
      ],
    });
    const dock = (events: ReturnType<typeof failedWith>) => (
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <AgentStreamingStatusDock
            redeliverRoomRun={vi.fn()}
            runStatuses={[runStatus({ status: "aborted" })]}
            runtimePresentationEventsByRunStatusId={events}
          />
        </MemoryRouter>
      </QueryClientProvider>
    );
    const resend = () =>
      screen.queryByRole("button", {
        name: "Resend unconfirmed follow-up to Codex",
      });
    const { rerender } = render(dock(failedWith()));
    expect(shownStatus()).toMatch(/^Codex: Run failed/);
    expect(resend()).toBeNull();
    rerender(dock(failedWith(["follow-up"])));
    expect(shownStatus()).toMatch(/^Codex: Run failed/);
    expect(resend()).toBeInTheDocument();
  });

  it("shows the latest failure below the composer and clears it after success", () => {
    const failed = runStatus({ id: "failed", status: "aborted" });
    const { rerender } = render(
      <MemoryRouter>
        <AgentStreamingStatusDock runStatuses={[failed]} />
      </MemoryRouter>,
    );
    expect(shownStatus()).toBe("Codex: Run stopped");
    rerender(
      <MemoryRouter>
        <AgentStreamingStatusDock
          runStatuses={[
            failed,
            runStatus({
              id: "success",
              created_at: "2026-08-15T00:00:00Z",
              status: "completed",
            }),
          ]}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId("agent-streaming-status-dock")).toBeNull();
  });

  it("keeps one latest failure per Agent with activity access but no Stop or spinner", () => {
    const onViewActivity = vi.fn();
    render(
      <MemoryRouter>
        <AgentStreamingStatusDock
          onViewActivity={onViewActivity}
          cancelRoomRun={vi.fn()}
          runStatuses={[
            runStatus({ id: "older", status: "aborted" }),
            runStatus({
              id: "latest",
              status: "aborted",
              created_at: "2026-08-15T00:00:00Z",
            }),
          ]}
        />
      </MemoryRouter>,
    );
    const trigger = screen.getByRole("button", {
      name: "Open Agent status activity",
    });
    expect(trigger).toHaveAttribute("title", "Codex: Run stopped");
    expect(trigger.querySelector(".town-dots, .town-spinner")).toBeNull();
    fireEvent.pointerEnter(screen.getByTestId("agent-streaming-status-dock"));
    expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();
    expect(screen.getAllByText("Run stopped")).toHaveLength(1);
    fireEvent.click(trigger);
    expect(onViewActivity).toHaveBeenCalledWith(
      "latest",
      expect.objectContaining({ id: "agent-1" }),
      "latest",
    );
  });

  it("shows two Agents' failures only after a third Agent stops working", () => {
    render(
      <MemoryRouter>
        <AgentStreamingStatusDock
          runStatuses={[
            runStatus({ id: "failed-a", status: "aborted" }),
            runStatus({
              id: "failed-b",
              status: "aborted",
              agent: { id: "agent-b", kind: "agent", display_name: "Other" },
            }),
            runStatus({
              id: "working-c",
              agent: { id: "agent-c", kind: "agent", display_name: "Working" },
            }),
          ]}
        />
      </MemoryRouter>,
    );
    expect(shownStatus()).toBe("Working: Starting");
    expect(screen.queryByText(/Run failed/)).toBeNull();
  });

  it("replaces a historical failure when the Agent's next Run starts", () => {
    render(
      <MemoryRouter>
        <AgentStreamingStatusDock
          runStatuses={[
            runStatus({ status: "aborted" }),
            runStatus({ id: "new-run", created_at: "2026-08-15T00:00:00Z" }),
          ]}
        />
      </MemoryRouter>,
    );
    expect(shownStatus()).toBe("Codex: Starting");
    expect(screen.queryByText(/Run failed/)).not.toBeInTheDocument();
  });

  it("keeps an older working Run and its Stop over a newer ended one", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <AgentStreamingStatusDock
            cancelRoomRun={vi.fn()}
            runStatuses={[
              runStatus({ id: "still-ending" }),
              runStatus({
                id: "newer-aborted",
                status: "aborted",
                created_at: "2026-08-15T00:00:00Z",
              }),
            ]}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(shownStatus()).toBe("Codex: Starting");
    expect(screen.queryByText(/Run failed/)).not.toBeInTheDocument();
    fireEvent.pointerEnter(screen.getByTestId("agent-streaming-status-dock"));
    expect(stopButton("Stop Codex's task")).toBeVisible();
  });

  it("replaces the Agent's old failure with a local typing state", () => {
    render(
      <MemoryRouter>
        <AgentStreamingStatusDock
          runStatuses={[runStatus({ status: "aborted" })]}
          typingAgent={{ display_name: "Codex", id: "agent-1" }}
        />
      </MemoryRouter>,
    );
    expect(shownStatus()).toBe("Codex: Starting");
    expect(screen.queryByText(/Run failed/)).not.toBeInTheDocument();
  });

  it("starts the same Agent's next task with a fresh Stop", async () => {
    const cancelRoomRun = vi.fn().mockResolvedValue({
      run_id: "run-a",
      status: "cancel_requested",
      agent_actor_id: "agent-1",
      message_ids: ["message-a"],
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = (runId: string) => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <AgentStreamingStatusDock
            cancelRoomRun={cancelRoomRun}
            runStatuses={[runStatus({ id: runId })]}
          />
        </MemoryRouter>
      </QueryClientProvider>
    );
    const { rerender } = render(view("run-a"));
    fireEvent.click(stopButton("Stop Codex's task"));
    await waitFor(() =>
      expect(stopButton("Stop Codex's task")).toHaveTextContent("Stopping"),
    );
    rerender(view("run-b"));
    expect(stopButton("Stop Codex's task")).toHaveTextContent(/^Stop$/);
    expect(stopButton("Stop Codex's task")).toBeEnabled();
    fireEvent.click(stopButton("Stop Codex's task"));
    await waitFor(() => expect(cancelRoomRun).toHaveBeenCalledTimes(2));
    const [first, second] = cancelRoomRun.mock.calls;
    expect(second?.[0]).toBe("run-b");
    // A new task's stop is a new request, not a retry of the last one.
    expect(second?.[1]).not.toBe(first?.[1]);
  });

  it("stops only the Agent shown on the status line", async () => {
    const cancelRoomRun = vi.fn().mockResolvedValue({
      run_id: "run-a",
      status: "cancel_requested",
      agent_actor_id: "agent-1",
      message_ids: ["message-a"],
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <AgentStreamingStatusDock
            cancelRoomRun={cancelRoomRun}
            runStatuses={[
              runStatus({ run_id: "run-a" }),
              runStatus({
                id: "run-b",
                agent: {
                  display_name: "Reviewer",
                  id: "agent-reviewer",
                  kind: "agent",
                },
              }),
            ]}
            runtimePresentationEventsByRunStatusId={{
              "run-status-1": [
                runtimeStatusRecord("1", "working"),
                runtimeActivityStartedRecord(
                  "2",
                  "activity-command",
                  "command",
                  "exec_command",
                ),
              ],
            }}
            scopeKey={["teamhub", "tenant-1", "room-1"]}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    fireEvent.click(stopButton("Stop Codex's task"));
    await waitFor(() =>
      expect(cancelRoomRun).toHaveBeenCalledWith("run-a", expect.any(String)),
    );
    expect(cancelRoomRun).toHaveBeenCalledTimes(1);
  });

  it("marks a working Agent's avatar live and keeps its activity out of the timeline", () => {
    const message = ordinaryAgentMessage();
    renderTimeline(message, {
      runStatuses: [runStatus()],
      runtimePresentationEventsByRunStatusId: {
        "run-status-1": [
          runtimeStatusRecord("1", "working"),
          runtimeActivityStartedRecord(
            "2",
            "activity-1",
            "search",
            "Searching the web",
          ),
        ],
      },
    });

    expect(
      within(messageRow(message)).getByRole("button", {
        name: "Open Codex status",
      }),
    ).not.toHaveAttribute("aria-describedby");
    expect(
      screen.queryByRole("article", { name: /Agent status from Codex/ }),
    ).toBeNull();
    expect(screen.queryByText("Searching the web")).toBeNull();
  });

  it("opens the running activity directly from the Agent avatar", () => {
    const onOpenAgentActivity = vi.fn();
    const message = ordinaryAgentMessage();
    renderTimeline(message, {
      onOpenAgentActivity,
      runStatuses: [runStatus({ run_id: "run-current" })],
      runtimePresentationEventsByRunStatusId: {
        "run-status-1": [runtimeStatusRecord("1", "working")],
      },
    });
    fireEvent.click(
      within(messageRow(message)).getByRole("button", {
        name: "Open Codex status",
      }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "View activity" }));
    expect(onOpenAgentActivity).toHaveBeenCalledWith(
      "agent-1",
      "run-status-1",
      "run-current",
    );
  });

  it("does not present completed activity history as live", () => {
    const message = ordinaryAgentMessage();

    renderTimeline(message, {
      runStatuses: [
        runStatus({ id: "run-status-complete", status: "completed" }),
      ],
      runtimePresentationEventsByRunStatusId: {
        "run-status-complete": [
          runtimeStatusRecord("1", "working"),
          runtimeActivityStartedRecord(
            "2",
            "activity-search",
            "search",
            "Searching the Room",
          ),
          runtimeActivityUpdatedRecord(
            "3",
            "activity-search",
            "Found the related specification",
          ),
          runtimeActivityFinishedRecord("4", "activity-search", "succeeded"),
          runtimeTerminalStatusRecord("5", "completed"),
        ],
      },
    });

    const row = messageRow(message);
    fireEvent.pointerEnter(
      within(row).getByRole("button", { name: "Open Codex profile" }),
    );
    expect(
      screen.getByRole("menuitem", { name: "View activity" }),
    ).toBeVisible();
    expect(screen.queryByText("Live activities")).toBeNull();
  });

  it("keeps Reply to thread, Forward, and Reply in the More message menu", () => {
    const message = ordinaryAgentMessage();
    renderTimeline(message, {
      onForwardMessage: vi.fn(),
      onOpenThread: vi.fn(),
      onReply: vi.fn(),
    });

    fireEvent.click(
      within(messageRow(message)).getByRole("button", {
        name: "More message actions",
      }),
    );
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Forward message", "Reply to message", "Reply to thread"]);
  });

  it("keeps nested multi-Agent Runtime outputs in canonical Room order", () => {
    const request = ordinaryHumanMessage();
    const coordinatorReply = ordinaryAgentMessage();
    coordinatorReply.id = "message-coordinator";
    coordinatorReply.raw_message = "Coordinator assigned the research";
    coordinatorReply.segments = [
      { content: coordinatorReply.raw_message, type: "text" },
    ];
    coordinatorReply.reply_to_message_id = request.id;

    const analystReply = ordinaryAgentMessage();
    analystReply.author = {
      display_name: "Product Analyst",
      id: "agent-analyst",
      kind: "agent",
      tenant_id: "tenant-1",
    };
    analystReply.id = "message-analyst";
    analystReply.raw_message = "Product analysis is ready";
    analystReply.segments = [
      { content: analystReply.raw_message, type: "text" },
    ];
    analystReply.reply_to_message_id = coordinatorReply.id;

    const researcherReply = ordinaryAgentMessage();
    researcherReply.author = {
      display_name: "Product Researcher",
      id: "agent-researcher",
      kind: "agent",
      tenant_id: "tenant-1",
    };
    researcherReply.id = "message-researcher";
    researcherReply.raw_message = "Research evidence is ready";
    researcherReply.segments = [
      { content: researcherReply.raw_message, type: "text" },
    ];
    researcherReply.reply_to_message_id = coordinatorReply.id;

    renderTimeline([request, coordinatorReply, analystReply, researcherReply], {
      runStatuses: [
        runStatus({ id: "run-status-coordinator", status: "completed" }),
        runStatus({
          agent: {
            display_name: "Product Analyst",
            id: "agent-analyst",
            kind: "agent",
          },
          id: "run-status-analyst",
          status: "completed",
        }),
        runStatus({
          agent: {
            display_name: "Product Researcher",
            id: "agent-researcher",
            kind: "agent",
          },
          id: "run-status-researcher",
          status: "completed",
        }),
      ],
      runtimePresentationEventsByRunStatusId: {
        "run-status-analyst": [
          runtimeStatusRecord(
            "1",
            "thinking",
            "Analyzing product implications",
            "segment-analyst",
          ),
          runtimeOutputRecord("2", analystReply.id, "segment-analyst"),
        ],
        "run-status-coordinator": [
          runtimeStatusRecord(
            "1",
            "thinking",
            "Delegating the research",
            "segment-coordinator",
          ),
          runtimeOutputRecord("2", coordinatorReply.id, "segment-coordinator"),
        ],
        "run-status-researcher": [
          runtimeStatusRecord(
            "1",
            "thinking",
            "Collecting primary evidence",
            "segment-researcher",
          ),
          runtimeOutputRecord("2", researcherReply.id, "segment-researcher"),
        ],
      },
    });

    const rows = [
      messageRow(request),
      messageRow(coordinatorReply),
      messageRow(analystReply),
      messageRow(researcherReply),
    ];
    for (const message of [coordinatorReply, analystReply, researcherReply]) {
      const row = messageRow(message);
      expect(screen.getAllByText(message.raw_message)).toHaveLength(1);
      expect(row.querySelector('[id^="runtime-details-"]')).toBeNull();
      expect(
        within(row).queryByRole("button", {
          name: "Show activity details",
        }),
      ).toBeNull();
    }
    for (let index = 0; index < rows.length - 1; index += 1) {
      expect(
        rows[index]!.compareDocumentPosition(rows[index + 1]!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    expect(
      screen.queryByRole("article", { name: /Agent status from/ }),
    ).toBeNull();
  });

  it.each(["completed", "failed", "canceled"] as const)(
    "hides an active stopped Run status with the %s outcome",
    (outcome) => {
      renderTimeline(ordinaryAgentMessage(), {
        runStatuses: [runStatus()],
        runtimePresentationEventsByRunStatusId: {
          "run-status-1": [runtimeTerminalStatusRecord("1", outcome)],
        },
      });

      expect(
        screen.queryByRole("article", { name: /Live Agent status/ }),
      ).toBeNull();
      expect(screen.queryByText(/runtime\.status/)).toBeNull();
    },
  );

  it("never inserts failed turns into chat messages", () => {
    const request = ordinaryHumanMessage();
    const firstFailedRunStatus = runStatus({
      stop_reason: "Codex leaked /private/runtime/path",
      id: "run-status-failed-1",
      status: "aborted",
    });
    const secondFailedRunStatus = runStatus({
      stop_reason: "Codex leaked /private/runtime/path-again",
      id: "run-status-failed-2",
      status: "aborted",
    });

    renderTimeline(request, {
      runStatuses: [firstFailedRunStatus, secondFailedRunStatus],
      runtimePresentationEventsByRunStatusId: {
        [firstFailedRunStatus.id]: [
          runtimeStatusRecord("1", "working"),
          runtimeTerminalStatusRecord("2", "failed"),
        ],
        [secondFailedRunStatus.id]: [
          runtimeStatusRecord("1", "working"),
          runtimeTerminalStatusRecord("2", "failed"),
        ],
      },
    });

    expect(
      screen.queryByRole("article", { name: "Agent status from Codex" }),
    ).toBeNull();
    expect(screen.queryByText("Run failed")).toBeNull();
    expect(screen.queryByText(/private\/runtime\/path/)).toBeNull();
    expect(screen.queryByText(/sensitive internal failure/)).toBeNull();
  });

  it("does not append failures without a visible message anchor", () => {
    const terminal = runtimeTerminalStatusRecord("1", "failed");
    renderTimeline(ordinaryHumanMessage(), {
      runStatuses: [
        runStatus({
          id: "startup-failed",
          status: "aborted",
          stop_reason: "private token",
        }),
      ],
      runtimePresentationEventsByRunStatusId: {
        "startup-failed": [
          {
            ...terminal,
            event: {
              type: "status.changed",
              status: "stopped",
              outcome: "failed",
              failure: {
                code: "session_not_found",
                runtime_type: "codex",
                runtime_version: "0.153.4",
              },
            },
          },
        ],
      },
    });
    expect(
      screen.queryByRole("article", { name: "Agent status from Codex" }),
    ).toBeNull();
    expect(
      screen.queryByText(
        /Session history could not be restored|private token|private runtime log/,
      ),
    ).toBeNull();
  });

  it("keeps historical failures out of chat after success and remount", () => {
    const request = ordinaryHumanMessage();
    const followUp: TeamHubMessage = {
      ...ordinaryHumanMessage(),
      id: "message-followup",
      raw_message: "Try again",
      segments: [{ type: "text", content: "Try again" }],
    };
    const response: TeamHubMessage = {
      ...ordinaryAgentMessage(),
      id: "message-success",
      raw_message: "It works now",
      segments: [{ type: "text", content: "It works now" }],
    };
    const failure = runStatus({
      id: "run-status-old-failure",
      status: "aborted",
    });
    const success = runStatus({
      id: "run-status-new-success",
      created_at: "2026-08-15T00:00:00Z",
      status: "completed",
    });
    const messages = [request, followUp, response];
    const props = { runStatuses: [success, failure] };
    const view = renderTimeline(messages, props);
    expect(
      screen.queryByRole("article", { name: "Agent status from Codex" }),
    ).toBeNull();
    view.unmount();
    renderTimeline(messages, props);
    expect(
      screen.queryByRole("article", { name: "Agent status from Codex" }),
    ).toBeNull();
  });

  it("renders a known Typed Card without repeating its fallback text", async () => {
    const message = roomCreationCardMessage();
    const onReply = vi.fn();
    renderTimeline(message, { onReply });

    const card = await screen.findByRole("region", { name: "Room creation" });
    expect(card).toBeVisible();
    expect(card.closest("article")).toHaveAttribute(
      "data-author-kind",
      "agent",
    );
    expect(card.closest("article")).toHaveAttribute(
      "data-current-actor",
      "false",
    );
    expect(screen.queryByText("Fallback: Room creation requested")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Reply to thread" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "More message actions" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Reply to message" }));
    expect(screen.getByRole("button", { name: "Copy message" })).toBeVisible();
    expect(onReply).toHaveBeenCalledWith(message);
    expect(screen.queryByRole("button", { name: "Helpful" })).toBeNull();
  });

  it("keeps fallback text for a future card without treating it as a Thread", () => {
    const message = unknownCardMessage();
    const onReply = vi.fn();
    renderTimeline(message, { onReply });

    expect(screen.getByText("Fallback: future card")).toBeVisible();
    expect(screen.queryByRole("region")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Reply to thread" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "More message actions" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Reply to message" }));
    expect(onReply).toHaveBeenCalledWith(message);
  });

  it("shows a recoverable error when a Message file preview cannot load", async () => {
    const message = ordinaryAgentMessage();
    message.segments.push({
      content: "conversation-context.md",
      document_id: "document-missing",
      document_version_id: "version-missing",
      type: "file",
    });
    renderTimeline(message, {
      onOpenMessageFile: vi.fn().mockRejectedValue(new Error("not found")),
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Preview conversation-context.md",
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "File preview is unavailable",
    );
  });

  it("keeps HTML fragments inline between surrounding text", () => {
    const message = ordinaryAgentMessage();
    message.raw_message =
      "Pick a style\nVisual fragment\nTell me once you choose";
    message.segments = [
      { content: "Pick a style\n", type: "text" },
      {
        content: "Visual fragment",
        html: "<div class='option'>Pine Green Strategy</div>",
        type: "html_fragment",
      },
      { content: "Tell me once you choose", type: "text" },
    ];
    renderTimeline(message);

    const intro = screen.getByText("Pick a style");
    const fragment = screen.getByTitle("Visual fragment");
    const outro = screen.getByText("Tell me once you choose");
    expect(fragment).toHaveAttribute("sandbox", "allow-scripts");
    expect(fragment.getAttribute("srcdoc")).toContain("Pine Green Strategy");
    expect(
      intro.compareDocumentPosition(fragment) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      fragment.compareDocumentPosition(outro) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps ordinary HTML file segments as downloadable file cards", () => {
    const message = ordinaryAgentMessage();
    message.raw_message = "Download fragment-flowchart.svg";
    message.segments = [
      { content: "Download fragment-flowchart.svg\n", type: "text" },
      {
        content: "Open the layout review",
        document_id: "document-html",
        document_version_id: "version-html",
        filename: "style-options.fragment.html",
        media_type: "text/html",
        type: "file",
      },
    ];
    renderTimeline(message, {
      documentMetadata: {
        "document-html": {
          title: "style-options.fragment.html",
          format: "html",
          representation_format: "html",
        },
      },
    });

    expect(
      screen.getByRole("button", {
        name: "Preview style-options.fragment.html",
      }),
    ).toBeVisible();
    expect(screen.getByText("HTML")).toBeVisible();
    expect(screen.queryByText("Open the layout review")).toBeNull();
    expect(screen.queryByTitle("style-options.fragment.html")).toBeNull();
  });
});

describe("Agent reply arrival", () => {
  it("pops in only the Messages that arrive after the Room opened", () => {
    const history = ordinaryAgentMessage();
    const view = renderTimeline(history);
    const arrived = {
      ...ordinaryAgentMessage(),
      id: "message-agent-arrived",
      raw_message: "A freshly arrived Agent answer",
      segments: [
        { type: "text" as const, content: "A freshly arrived Agent answer" },
      ],
      created_at: "2099-01-01T00:00:00Z",
    };
    const humanAfterOpen = {
      ...ordinaryHumanMessage(),
      id: "message-human-after-open",
      created_at: "2099-01-01T00:00:01Z",
    };
    view.rerender(timelineElement([history, arrived, humanAfterOpen]));

    // Only the reply that arrived pops in; history stays still, and the
    // person's own Message already popped as it was sent.
    const popped = document.querySelectorAll('[data-entering="true"]');
    expect(popped).toHaveLength(1);
    expect(popped[0]).toHaveTextContent("A freshly arrived Agent answer");
    // An Agent's words also sweep in as if typed, after the pop.
    expect(popped[0]!.querySelector(".message-text-sweep")).not.toBeNull();
    expect(messageRow(history)).not.toHaveAttribute("data-entering");
    expect(messageRow(humanAfterOpen)).not.toHaveAttribute("data-entering");
  });
});

function renderTimeline(
  message: TeamHubMessage | TeamHubMessage[],
  interactions: {
    documentMetadata?: ComponentProps<
      typeof MessageTimeline
    >["documentMetadata"];
    actorDisplayNames?: Readonly<Record<string, string>>;
    linkedSource?: ComponentProps<typeof MessageTimeline>["linkedSource"];
    memberActorIds?: ReadonlySet<string>;
    mentionableActorIds?: ReadonlySet<string>;
    messageFilePreview?: ComponentProps<
      typeof MessageTimeline
    >["messageFilePreview"];
    runStatuses?: TeamHubRunStatus[];
    runtimePresentationEventsByRunStatusId?: Readonly<
      Record<string, readonly TeamHubRuntimePresentationEventRecord[]>
    >;
    onMentionAuthor?: (actor: TeamHubMessage["author"]) => void;
    onOpenProfile?: (actorId: string) => void;
    onOpenAgentActivity?: ComponentProps<
      typeof MessageTimeline
    >["onOpenAgentActivity"];
    onForwardMessage?: (message: TeamHubMessage) => void;
    onOpenArtifact?: ComponentProps<typeof MessageTimeline>["onOpenArtifact"];
    onOpenMessageFile?: ComponentProps<
      typeof MessageTimeline
    >["onOpenMessageFile"];
    onOpenThread?: (message: TeamHubMessage) => void;
    onRecallMessage?: (message: TeamHubMessage) => Promise<void>;
    onReply?: (message: TeamHubMessage) => void;
    presentations?: ComponentProps<typeof MessageTimeline>["presentations"];
    workspaceAgentIds?: ComponentProps<
      typeof MessageTimeline
    >["workspaceAgentIds"];
  } = {},
) {
  return render(timelineElement(message, interactions));
}

function timelineElement(
  message: TeamHubMessage | TeamHubMessage[],
  interactions: Parameters<typeof renderTimeline>[1] = {},
) {
  const messages = Array.isArray(message) ? message : [message];
  return (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <MessageTimeline
          canLoadOlder={false}
          currentActorId="human-1"
          loadingOlder={false}
          messages={messages}
          runStatuses={interactions.runStatuses}
          mentionableActorIds={new Set(messages.map((item) => item.author.id))}
          onCancel={vi.fn()}
          onCardDecision={vi.fn()}
          onCloseLinkedSource={vi.fn()}
          onOpenArtifact={interactions.onOpenArtifact ?? vi.fn()}
          onOpenMessageFile={interactions.onOpenMessageFile ?? vi.fn()}
          onOpenProfile={vi.fn()}
          onOpenThread={vi.fn()}
          {...interactions}
          onRetry={vi.fn()}
          pendingMessages={[]}
          presentations={interactions.presentations ?? {}}
          tenantId="tenant-1"
        />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

/** Lets the status line pass its minimum show and placeholder hold times. */
function passLineHolds() {
  act(() => {
    vi.advanceTimersByTime(
      AGENT_STATUS_LINE_TIMING.minShowMs + AGENT_STATUS_LINE_TIMING.tickMs,
    );
  });
}

function shownStatus() {
  return screen
    .getByRole("button", { name: /^Open Agents? (working|status) activity$/ })
    .getAttribute("title");
}

function stopButton(name: string) {
  return screen.getByRole("button", { name });
}

function runStatus(
  overrides: Partial<TeamHubRunStatus> = {},
): TeamHubRunStatus {
  return {
    agent: { display_name: "Codex", id: "agent-1", kind: "agent" },
    created_at: "2026-08-14T00:00:00Z",
    id: "run-status-1",
    run_id: overrides.id ?? "run-status-1",
    replied: false,
    revision: 1,
    room_id: "room-1",
    status: "active",
    updated_at: "2026-08-14T00:00:01Z",
    ...overrides,
  };
}

function ordinaryAgentMessage(): TeamHubMessage {
  const message = roomCreationCardMessage();
  delete message.card;
  message.raw_message = "An ordinary Agent answer";
  message.segments = [{ type: "text", content: message.raw_message }];
  return message;
}

function ordinaryHumanMessage(): TeamHubMessage {
  const message = ordinaryAgentMessage();
  message.author = {
    display_name: "Alice",
    id: "human-1",
    kind: "human",
    tenant_id: "tenant-1",
  };
  message.raw_message = "Please handle this here";
  message.segments = [{ type: "text", content: message.raw_message }];
  message.id = "message-human-1";
  return message;
}

function messageRow(message: TeamHubMessage): HTMLElement {
  const row = screen
    .getAllByRole("article")
    .find((candidate) => within(candidate).queryByText(message.raw_message));
  expect(row).toBeDefined();
  return row!;
}

function runtimeStatusRecord(
  eventOrdinal: string,
  status: "queued" | "working" | "thinking",
  title?: string,
  segmentId = "segment-1",
): TeamHubRuntimePresentationEventRecord {
  return {
    event: {
      status,
      ...(title === undefined ? {} : { title }),
      type: "status.changed",
    },
    event_ordinal: eventOrdinal,
    segment_id: segmentId,
  };
}

function inputBlock(input: Record<string, unknown>) {
  return [
    { label: "Input", format: "json" as const, content: JSON.stringify(input) },
  ];
}

function runtimeActivityStartedRecord(
  eventOrdinal: string,
  activityId: string,
  kind: Extract<
    TeamHubRuntimePresentationEventRecord["event"],
    { type: "activity.started" }
  >["kind"],
  title: string,
  segmentId = "segment-1",
  content?: NonNullable<
    Extract<
      TeamHubRuntimePresentationEventRecord["event"],
      { type: "activity.started" }
    >["content"]
  >,
): TeamHubRuntimePresentationEventRecord {
  return {
    event: {
      activity_id: activityId,
      ...(content === undefined ? {} : { content }),
      kind,
      title,
      type: "activity.started",
    },
    event_ordinal: eventOrdinal,
    segment_id: segmentId,
  };
}

function runtimeActivityUpdatedRecord(
  eventOrdinal: string,
  activityId: string,
  detail: string,
  segmentId = "segment-1",
): TeamHubRuntimePresentationEventRecord {
  return {
    event: {
      activity_id: activityId,
      detail,
      type: "activity.updated",
    },
    event_ordinal: eventOrdinal,
    segment_id: segmentId,
  };
}

function runtimeActivityFinishedRecord(
  eventOrdinal: string,
  activityId: string,
  outcome: Extract<
    TeamHubRuntimePresentationEventRecord["event"],
    { type: "activity.finished" }
  >["outcome"],
  segmentId = "segment-1",
  content?: NonNullable<
    Extract<
      TeamHubRuntimePresentationEventRecord["event"],
      { type: "activity.finished" }
    >["content"]
  >,
): TeamHubRuntimePresentationEventRecord {
  return {
    event: {
      activity_id: activityId,
      ...(content === undefined ? {} : { content }),
      outcome,
      type: "activity.finished",
    },
    event_ordinal: eventOrdinal,
    segment_id: segmentId,
  };
}

function runtimeOutputRecord(
  eventOrdinal: string,
  messageId: string,
  segmentId = "segment-1",
): TeamHubRuntimePresentationEventRecord {
  return {
    event: {
      output_id: messageId,
      output_kind: "message",
      surface: "room_timeline",
      type: "presentation.output_created",
    },
    event_ordinal: eventOrdinal,
    message_id: messageId,
    segment_id: segmentId,
  };
}

function runtimeMessageOutputRecord(
  eventOrdinal: string,
  outputId: string,
  segmentId = "segment-1",
): TeamHubRuntimePresentationEventRecord {
  return {
    event: {
      output_id: outputId,
      output_kind: "message",
      surface: "room_timeline",
      type: "presentation.output_created",
    },
    event_ordinal: eventOrdinal,
    segment_id: segmentId,
  };
}

function runtimeTerminalStatusRecord(
  eventOrdinal: string,
  outcome: "canceled" | "completed" | "failed",
  segmentId = "segment-1",
): TeamHubRuntimePresentationEventRecord {
  return {
    event: {
      outcome,
      status: "stopped",
      type: "status.changed",
    },
    event_ordinal: eventOrdinal,
    segment_id: segmentId,
  };
}

function roomCreationCardMessage(): TeamHubMessage {
  const author = {
    display_name: "Codex",
    id: "agent-1",
    kind: "agent" as const,
    tenant_id: "tenant-1",
  };
  const fallback = "Fallback: Room creation requested";
  return {
    attachments: [],
    author,
    card: {
      card_type: "personal_notice",
      decision_id: "coordination-42",
      status: "pending",
      decision_owner: { display_name: "Alice", id: "human-1", kind: "human" },
      intent: "decision_requested",
      kind: "room_creation",
      requester: { display_name: "Codex", id: "agent-1", kind: "agent" },
      title: "Request to create a collaboration room",
      room_creation: {
        initial_message_segments: [
          { content: "Start the incident review.", type: "text" },
        ],
        member_ids: ["agent-1", "human-1"],
        name: "incident-review",
        origin_room_id: "room-1",
      },
      version: 1,
    },
    created_at: "2026-07-30T08:00:00Z",
    id: "message-card-1",
    message_kind: "conversation",
    raw_message: fallback,
    room_id: "room-1",
    segments: [{ content: fallback, type: "text" as const }],
    tenant_id: "tenant-1",
  };
}

function unknownCardMessage(): TeamHubMessage {
  return {
    ...roomCreationCardMessage(),
    card: {
      card_type: "future_card",
      intent: "future_intent",
      version: 1,
    },
    raw_message: "Fallback: future card",
    segments: [{ content: "Fallback: future card", type: "text" }],
  } as unknown as TeamHubMessage;
}

function readDocumentVersion(client: TeamHubClient, documentVersionId: string) {
  return teamHubData(
    client.api.GET("/v0/document-versions/{documentVersionId}", {
      params: { path: { documentVersionId } },
    }),
  );
}

describe("Runtime timeline projection reuse", () => {
  it("re-projects only the Run whose status or events changed", () => {
    const first = runStatus({ id: "run-status-1" });
    const second = runStatus({
      agent: { display_name: "Claude", id: "agent-2", kind: "agent" },
      id: "run-status-2",
    });
    const firstEvents = [runtimeStatusRecord("1", "working", "Reading")];
    const secondEvents = [runtimeStatusRecord("1", "thinking")];
    const cache = new Map();
    const [firstView, secondView] = buildRuntimeTimelineViews({
      cache,
      runStatuses: [first, second],
      runtimePresentationEventsByRunStatusId: {
        "run-status-1": firstEvents,
        "run-status-2": secondEvents,
      },
    });

    const next = buildRuntimeTimelineViews({
      cache,
      runStatuses: [first, second],
      runtimePresentationEventsByRunStatusId: {
        "run-status-1": firstEvents,
        "run-status-2": [
          ...secondEvents,
          runtimeStatusRecord("2", "working", "Writing"),
        ],
      },
    });
    expect(next).toHaveLength(2);
    expect(next[0]).toBe(firstView);
    expect(next[1]).not.toBe(secondView);

    const revised = buildRuntimeTimelineViews({
      cache,
      runStatuses: [{ ...first, revision: 2 }],
      runtimePresentationEventsByRunStatusId: { "run-status-1": firstEvents },
    });
    expect(revised[0]).not.toBe(firstView);
    // A Run that leaves the list leaves the cache too.
    expect([...cache.keys()]).toEqual(["run-status-1"]);
  });
});
