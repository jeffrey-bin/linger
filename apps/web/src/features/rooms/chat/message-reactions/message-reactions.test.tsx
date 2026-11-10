import {
  type InfiniteData,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

import {
  roomMessageQueryKey,
  roomMessagesQueryKey,
} from "@/features/rooms/room-queries";
import {
  createHttpTeamHubClient,
  TeamHubTransportError,
} from "@/features/teamhub/teamhub-client";
import type {
  TeamHubMessage,
  TeamHubMessagePage,
} from "@/features/teamhub/teamhub-types";

import {
  TeamHubTestServer,
  type TestRouteHandler,
} from "@/test/teamhub-test-server";

import { MessageTimeline } from "../message-timeline";
import { createRoomProjection } from "../room-projection";
import emojiData from "@emoji-mart/data/sets/15/native.json";

import {
  buildReactionCatalog,
  searchReactionCatalog,
} from "./reaction-catalog";
import {
  messageSupportsReactions,
  toggleMessageReaction,
} from "./reaction-state";
import { useMessageReactionToggle } from "./use-message-reaction-toggle";

function message(overrides: Partial<TeamHubMessage> = {}): TeamHubMessage {
  return {
    attachments: [],
    author: {
      display_name: "Lin",
      id: "agent-1",
      kind: "agent",
      tenant_id: "tenant-1",
    },
    created_at: "2026-10-09T08:00:00.000Z",
    id: "message-1",
    message_kind: "conversation",
    raw_message: "We shipped the release",
    room_id: "room-1",
    segments: [{ type: "text", content: "We shipped the release" }],
    tenant_id: "tenant-1",
    ...overrides,
  };
}

function renderTimeline(
  messages: TeamHubMessage[],
  props: Partial<ComponentProps<typeof MessageTimeline>> = {},
) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <MessageTimeline
          actorDisplayNames={{
            "agent-1": "Lin",
            "human-1": "Alice",
            "human-2": "Bob",
          }}
          actorKinds={{
            "agent-1": "agent",
            "human-1": "human",
            "human-2": "human",
          }}
          canLoadOlder={false}
          currentActorId="human-1"
          loadingOlder={false}
          mentionableActorIds={new Set()}
          messages={messages}
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
          {...props}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Reaction state", () => {
  it("toggles only one Actor's Reaction and keeps first-reacted grouping", () => {
    const reactions = [
      { reaction_id: "tada" as const, actor_ids: ["human-2"] },
      { reaction_id: "ok" as const, actor_ids: ["human-1"] },
    ];
    expect(toggleMessageReaction(reactions, "tada", "human-1", true)).toEqual([
      { reaction_id: "tada", actor_ids: ["human-2", "human-1"] },
      { reaction_id: "ok", actor_ids: ["human-1"] },
    ]);
    expect(toggleMessageReaction(reactions, "tada", "human-1", true)).toEqual(
      toggleMessageReaction(
        toggleMessageReaction(reactions, "tada", "human-1", true),
        "tada",
        "human-1",
        true,
      ),
    );
    expect(toggleMessageReaction(reactions, "ok", "human-1", false)).toEqual([
      { reaction_id: "tada", actor_ids: ["human-2"] },
    ]);
    expect(
      toggleMessageReaction(
        [{ reaction_id: "ok", actor_ids: ["human-1"] }],
        "ok",
        "human-1",
        false,
      ),
    ).toBeUndefined();
  });

  it("builds the full official library with annotation search aliases", () => {
    const catalog = buildReactionCatalog(emojiData, [
      { hexcode: "1F44C", label: "d’accord", tags: ["parfait"] },
    ]);
    expect(catalog.byId.size).toBe(1870);
    expect(catalog.categories.map((category) => category.label)).toEqual([
      "Smileys & People",
      "Animals & Nature",
      "Food & Drink",
      "Activity",
      "Travel & Places",
      "Objects",
      "Symbols",
      "Flags",
    ]);
    expect(catalog.recommended.map((entry) => entry.glyph).join("")).toBe(
      "❤️👌👍😄🎉😂",
    );
    expect(
      searchReactionCatalog(catalog, "parfait").map((entry) => entry.id),
    ).toEqual(["ok_hand"]);
    expect(
      searchReactionCatalog(catalog, "party popper").map((entry) => entry.id),
    ).toEqual(["tada"]);
  });

  it("matches annotations whose hexcode omits the FE0F selector", () => {
    const catalog = buildReactionCatalog(emojiData, [
      { hexcode: "2764", label: "cœur rouge", tags: ["amour"] },
    ]);
    expect(catalog.byId.get("heart")?.keywords).toEqual(
      expect.arrayContaining(["cœur rouge", "amour"]),
    );
    expect(
      searchReactionCatalog(catalog, "amour").map((entry) => entry.id),
    ).toEqual(["heart"]);
  });

  it("supports only ordinary chat Messages", () => {
    expect(messageSupportsReactions(message())).toBe(true);
    expect(
      messageSupportsReactions(message({ message_kind: "agent_runtime" })),
    ).toBe(false);
    expect(
      messageSupportsReactions(message({ card_context_message_id: "card-1" })),
    ).toBe(false);
  });
});

describe("Message Reactions in the timeline", () => {
  it("opens a dot-style searchable keyboard picker from the action strip", async () => {
    const onToggleReaction = vi.fn().mockResolvedValue(undefined);
    renderTimeline([message()], { onToggleReaction });

    fireEvent.click(screen.getByRole("button", { name: "Add reaction" }));
    // It opens as a quick row of the default Reactions; All expands it.
    const quick = await screen.findByRole("dialog", { name: "Add reaction" });
    await waitFor(() =>
      expect(within(quick).getAllByRole("button")).toHaveLength(7),
    );
    expect(screen.queryByRole("combobox", { name: "Search emoji" })).toBeNull();
    fireEvent.click(
      within(quick).getByRole("button", { name: "Search all emoji" }),
    );
    const search = screen.getByRole("combobox", { name: "Search emoji" });
    await waitFor(() => expect(search).toHaveFocus());
    const grid = await screen.findByRole("group", { name: "Recommended" });
    expect(within(grid).getAllByRole("option")).toHaveLength(6);
    expect(
      screen.getByRole("toolbar", { name: "Emoji categories" }),
    ).toContainElement(screen.getByRole("button", { name: "Flags" }));
    fireEvent.change(search, { target: { value: "party popper" } });
    expect(
      within(screen.getByRole("listbox"))
        .getAllByRole("option")
        .map((option) => option.getAttribute("aria-label")),
    ).toEqual(["Party Popper"]);
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onToggleReaction).toHaveBeenCalledWith(
      expect.objectContaining({ id: "message-1" }),
      "tada",
    );
    expect(screen.queryByRole("dialog", { name: "Add reaction" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Add reaction" }));
    fireEvent.click(await screen.findByRole("button", { name: "Thumbs Up" }));
    expect(onToggleReaction).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "message-1" }),
      "+1",
    );
    fireEvent.click(screen.getByRole("button", { name: "Add reaction" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Search all emoji" }),
    );
    const reopened = screen.getByRole("combobox", { name: "Search emoji" });
    await screen.findByRole("group", { name: "Recommended" });
    fireEvent.keyDown(reopened, { key: "ArrowRight" });
    const activeId = reopened.getAttribute("aria-activedescendant");
    expect(
      document.getElementById(activeId ?? "")?.getAttribute("aria-label"),
    ).toBe("Ok Hand");
    fireEvent.keyDown(reopened, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Add reaction" })).toBeNull();
  });

  it("keeps six Reactions not yet on the Message in the quick row", async () => {
    renderTimeline(
      [
        message({
          reactions: [
            { reaction_id: "heart", actor_ids: ["human-1"] },
            { reaction_id: "tada", actor_ids: ["human-2"] },
          ],
        }),
      ],
      { onToggleReaction: vi.fn().mockResolvedValue(undefined) },
    );
    fireEvent.click(screen.getByRole("button", { name: "Add reaction" }));
    const quick = await screen.findByRole("dialog", { name: "Add reaction" });
    await waitFor(() =>
      expect(within(quick).getAllByRole("button")).toHaveLength(7),
    );
    const labels = within(quick)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"));
    // Heart and Tada are already on the Message; the next emoji fill in.
    expect(labels.slice(0, 4)).toEqual([
      "Ok Hand",
      "Thumbs Up",
      "Grinning Face with Smiling Eyes",
      "Face with Tears of Joy",
    ]);
    expect(labels).not.toContain("Red Heart");
    expect(labels).not.toContain("Party Popper");
    expect(labels.at(-1)).toBe("Search all emoji");
  });

  it("shows grouped chips with own highlight, reactors and an error to retry", async () => {
    const onToggleReaction = vi.fn().mockRejectedValue(new Error("offline"));
    renderTimeline(
      [
        message({
          reactions: [
            { reaction_id: "tada", actor_ids: ["human-2", "agent-1"] },
            { reaction_id: "ok_hand", actor_ids: ["human-1"] },
          ],
        }),
      ],
      { onToggleReaction },
    );
    const chips = within(
      await screen.findByRole("group", { name: "Reactions" }),
    ).getAllByRole("button");
    expect(chips.map((chip) => chip.getAttribute("aria-label"))).toEqual([
      "Party Popper 2: Bob, Lin (Agent)",
      "Ok Hand 1: You",
    ]);
    expect(chips.map((chip) => chip.getAttribute("aria-pressed"))).toEqual([
      "false",
      "true",
    ]);
    // Reactors are in each chip's label only; no hover tooltip. The chip's
    // wrapper stays positioned so the chip paints above the Message bubble.
    expect(
      within(screen.getByRole("group", { name: "Reactions" })).queryByRole(
        "tooltip",
      ),
    ).toBeNull();
    for (const chip of chips)
      expect(chip.parentElement).toHaveClass("relative");
    fireEvent.click(chips[1]!);
    expect(onToggleReaction).toHaveBeenCalledWith(
      expect.objectContaining({ id: "message-1" }),
      "ok_hand",
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Reaction was not saved. Try again.",
    );
  });
});

describe("useMessageReactionToggle", () => {
  const reactionPath =
    "/v0/rooms/{roomId}/messages/{messageId}/reactions/{reactionId}" as const;

  function setup(routes: (server: TeamHubTestServer) => void) {
    const server = new TeamHubTestServer();
    routes(server);
    const client = createHttpTeamHubClient({
      fetchRequest: server.fetch,
      onAuthenticationRequired: () => undefined,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const initial = message({
      reactions: [{ reaction_id: "ok", actor_ids: ["human-2"] }],
    });
    queryClient.setQueryData<InfiniteData<TeamHubMessagePage>>(
      roomMessagesQueryKey("tenant-1", "room-1"),
      {
        pageParams: [undefined],
        pages: [
          {
            items: [initial],
            page: { has_more: false },
          } as unknown as TeamHubMessagePage,
        ],
      },
    );
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () =>
        useMessageReactionToggle({
          client,
          currentActorId: "human-1",
          queryClient,
          roomId: "room-1",
          tenantId: "tenant-1",
        }),
      { wrapper },
    );
    const cached = () =>
      queryClient.getQueryData<InfiniteData<TeamHubMessagePage>>(
        roomMessagesQueryKey("tenant-1", "room-1"),
      )!.pages[0]!.items[0]!.reactions;
    return { cached, initial, queryClient, toggle: result.current };
  }

  it("applies optimistically and alternates queued clicks against the latest cache", async () => {
    const putMessageReaction = vi.fn<TestRouteHandler>(() => undefined);
    const deleteMessageReaction = vi.fn<TestRouteHandler>(() => undefined);
    const { cached, initial, toggle } = setup((server) =>
      server
        .on("PUT", reactionPath, putMessageReaction)
        .on("DELETE", reactionPath, deleteMessageReaction),
    );
    await act(async () => {
      const first = toggle(initial, "ok");
      expect(cached()).toEqual([
        { reaction_id: "ok", actor_ids: ["human-2", "human-1"] },
      ]);
      await Promise.all([first, toggle(initial, "ok")]);
    });
    const reactionParams = expect.objectContaining({
      params: { messageId: "message-1", reactionId: "ok", roomId: "room-1" },
    });
    expect(putMessageReaction).toHaveBeenCalledWith(reactionParams);
    expect(deleteMessageReaction).toHaveBeenCalledWith(reactionParams);
    expect(cached()).toEqual([{ reaction_id: "ok", actor_ids: ["human-2"] }]);
  });

  it("restores the authoritative Message after a failed write and rethrows", async () => {
    const authoritative = message({
      reactions: [{ reaction_id: "laugh", actor_ids: ["human-2"] }],
    });
    const { cached, initial, queryClient, toggle } = setup((server) =>
      server
        .on(
          "GET",
          "/v0/rooms/{roomId}/messages/{messageId}",
          () => authoritative,
        )
        .on("PUT", reactionPath, () => {
          throw new Error("offline");
        }),
    );
    await act(async () => {
      await expect(toggle(initial, "tada")).rejects.toBeInstanceOf(
        TeamHubTransportError,
      );
    });
    expect(cached()).toEqual([
      { reaction_id: "laugh", actor_ids: ["human-2"] },
    ]);
    expect(
      queryClient.getQueryData<TeamHubMessage>(
        roomMessageQueryKey("tenant-1", "room-1", "message-1"),
      )?.reactions,
    ).toEqual(authoritative.reactions);
  });
});

describe("message.reactions.changed projection", () => {
  it("replaces the Message aggregate in loaded caches", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<InfiniteData<TeamHubMessagePage>>(
      roomMessagesQueryKey("tenant-1", "room-1"),
      {
        pageParams: [undefined],
        pages: [
          {
            items: [
              message({
                reactions: [{ reaction_id: "ok", actor_ids: ["human-1"] }],
              }),
            ],
            page: { has_more: false },
          } as unknown as TeamHubMessagePage,
        ],
      },
    );
    const projection = createRoomProjection({
      queryClient,
      roomId: "room-1",
      tenantId: "tenant-1",
    });
    await projection.applyEvent({
      event_id: "event-1",
      event_type: "message.reactions.changed",
      occurred_at: "2026-10-09T08:01:00.000Z",
      payload: {
        kind: "message.reactions.changed",
        message_id: "message-1",
        reactions: [{ reaction_id: "tada", actor_ids: ["agent-1"] }],
      },
      room_id: "room-1",
      room_seq: 1,
      tenant_id: "tenant-1",
    });
    expect(
      queryClient.getQueryData<InfiniteData<TeamHubMessagePage>>(
        roomMessagesQueryKey("tenant-1", "room-1"),
      )!.pages[0]!.items[0]!.reactions,
    ).toEqual([{ reaction_id: "tada", actor_ids: ["agent-1"] }]);
  });
});

describe("Agent cheer on Reactions", () => {
  async function react(name: string) {
    fireEvent.click(screen.getByRole("button", { name: "Add reaction" }));
    fireEvent.click(await screen.findByRole("button", { name }));
  }

  it("makes the Agent smile when a cheering Reaction is added to its Message", async () => {
    // The animation stays loading, so its layer remains while the test looks.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => undefined)),
    );
    const onToggleReaction = vi.fn().mockResolvedValue(undefined);
    renderTimeline([message()], { onToggleReaction });
    const motion = () => document.querySelector(".agent-avatar-motion");
    expect(motion()).toBeNull();

    await react("Thumbs Up");

    expect(onToggleReaction).toHaveBeenCalledWith(
      expect.objectContaining({ id: "message-1" }),
      "+1",
    );
    await waitFor(() => expect(motion()).not.toBeNull());
    vi.unstubAllGlobals();
  });

  it("floats sparkles or hearts, never the Reaction itself", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => undefined)),
    );
    const animate = vi.fn(() => ({
      cancel: vi.fn(),
      finished: new Promise(() => undefined),
    }));
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value: animate,
    });
    const onToggleReaction = vi.fn().mockResolvedValue(undefined);
    const { container } = renderTimeline([message()], { onToggleReaction });
    const floating = () =>
      [...container.querySelectorAll(".room-message-avatar span")]
        .map((piece) => piece.textContent)
        .filter((text) => text === "✨" || text === "💗" || text === "👍");

    await react("Thumbs Up");

    expect(floating()).toEqual(["✨", "✨", "✨", "✨", "✨"]);
    // @ts-expect-error -- remove the stub so other tests see jsdom's Element.
    delete HTMLElement.prototype.animate;
    vi.unstubAllGlobals();
  });

  it("stays still for other Reactions, removals, and people's Messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => undefined)),
    );
    const onToggleReaction = vi.fn().mockResolvedValue(undefined);
    const motion = () => document.querySelector(".agent-avatar-motion");
    const { unmount } = renderTimeline([message()], { onToggleReaction });
    await react("Ok Hand");
    expect(onToggleReaction).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "message-1" }),
      "ok_hand",
    );
    expect(motion()).toBeNull();
    unmount();

    const removal = renderTimeline(
      [message({ reactions: [{ reaction_id: "+1", actor_ids: ["human-1"] }] })],
      { onToggleReaction },
    );
    fireEvent.click(screen.getByRole("button", { name: /^Thumbs Up 1/ }));
    expect(onToggleReaction).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "message-1" }),
      "+1",
    );
    expect(motion()).toBeNull();
    removal.unmount();

    renderTimeline(
      [
        message({
          author: {
            display_name: "Alice",
            id: "human-2",
            kind: "human",
            tenant_id: "tenant-1",
          },
        }),
      ],
      { onToggleReaction },
    );
    await react("Thumbs Up");
    expect(motion()).toBeNull();
    vi.unstubAllGlobals();
  });
});
