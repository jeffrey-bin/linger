import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "@/app/query-client";
import {
  voiceClose,
  voiceOpenResult,
  voiceSearchResults,
} from "@/features/rooms/chat/voice-mode/voice-ui-bridge";
import {
  acceptDirectRooms,
  createTestTeamHubRuntime,
} from "@/test/teamhub-test-runtime";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import {
  teamHubErrorResponse,
  type TestRouteRequest,
} from "@/test/teamhub-test-server";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubDocument,
  TeamHubMessage,
  TeamHubMessageSearchHit,
} from "@/features/teamhub/teamhub-types";

import { GlobalSearchDialog } from "./global-search-dialog";
import {
  readGlobalSearchStore,
  type GlobalSearchStore,
} from "./global-search-recent";
import { isGlobalSearchShortcut } from "./search-shortcut";

const TENANT = "tenant-northstar";
const INPUT_NAME = "Search messages, docs, people, agents and rooms";
const STORAGE_KEY = `global-search-recent.v2:${TENANT}`;

/** Result rows and scope cards live in the listbox. */
const results = () => within(screen.getByRole("listbox"));

describe("Global search dialog", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: createTestStorage(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens as a centred dialog with one field, four scope cards and no filters", async () => {
    await renderDialog();
    expect(screen.getByRole("dialog", { name: "Search" })).toHaveAttribute(
      "data-size",
      "md",
    );
    expect(screen.getByRole("combobox", { name: INPUT_NAME })).toHaveAttribute(
      "placeholder",
      "Search messages, docs, members and rooms",
    );
    expect(screen.getByRole("button", { name: "Esc" })).toBeVisible();
    expect(screen.getByRole("listbox")).toHaveClass("workspace-scrollbar");
    // Types are scopes the person steps into, not tabs or filter selects.
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(
      screen.queryByRole("combobox", { name: /Filter search/ }),
    ).toBeNull();
    expect(screen.getByText("Search in")).toBeVisible();
    expect(
      results()
        .getAllByRole("option")
        .map((card) => card.textContent),
    ).toEqual([
      "MessagesChats in your Rooms",
      "MembersAgents you can message",
      "DocsDocs and notes",
      "RoomsRooms you can join",
    ]);
  });

  it("searches messages and docs after the debounce without a preview pane", async () => {
    const harness = await renderDialog();
    const { message, document } = await harness.samples();
    harness.searchMessages.mockReturnValue({
      items: [
        messageHit(message, "Deploy to test after the freeze", {
          id: "room-all",
          kind: "room",
          name: "All hands",
        }),
      ],
      page: { has_more: false },
    });
    harness.searchDocuments.mockReturnValue({
      items: [
        {
          ...document,
          representation_format: "markdown",
          search_match: {
            body_index_status: "ready",
            body_snippet: "…run the deploy after the freeze…",
          },
        },
        {
          ...document,
          format: "pdf",
          id: "document-deploy-scan",
          representation_format: "pdf",
          search_match: {
            body_index_status: "ready",
            body_snippet: "…scanned deploy steps…",
          },
          title: "Deploy runbook scan.pdf",
        },
      ],
      page: { has_more: false },
    });

    fireEvent.change(screen.getByRole("combobox", { name: INPUT_NAME }), {
      target: { value: "deploy" },
    });

    await waitFor(() =>
      expect(searchRequests(harness.searchMessages)).toContainEqual({
        params: { tenantId: TENANT },
        query: { limit: "20", q: "deploy" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(searchRequests(harness.searchDocuments)).toContainEqual({
      params: {},
      query: { limit: "20", q: "deploy", tenant_id: TENANT },
      signal: expect.any(AbortSignal),
    });
    const messageRow = await results().findByRole("option", {
      name: /Deploy to test after the freeze/,
    });
    expect(within(messageRow).getByText("in #All hands")).toBeVisible();
    expect(messageRow.querySelector("mark")).toHaveTextContent("Deploy");
    // Messages lead, the first row is active, and group labels carry no counts.
    const rows = results().getAllByRole("option");
    expect(rows[0]).toBe(messageRow);
    expect(rows[0]).toHaveAttribute("aria-selected", "true");
    expect(results().getByText("Messages")).toHaveTextContent(/^Messages$/);
    expect(results().getByText("Docs")).toHaveTextContent(/^Docs$/);

    expect(screen.queryByRole("complementary", { name: "Preview" })).toBeNull();
    expect(
      results().getByRole("option", { name: /product-v0-brief/ }),
    ).toBeVisible();
    expect(
      results().getByRole("option", { name: /Deploy runbook scan/ }),
    ).toBeVisible();

    // A query that stayed on screen with results joins Recent searches.
    await waitFor(() =>
      expect(readGlobalSearchStore(TENANT).queries).toEqual(["deploy"]),
    );
  });

  it("shows three hits per group and steps into a type with See all", async () => {
    const harness = await renderDialog();
    const { message, document } = await harness.samples();
    const hit = messageHit(message, "Count regression message", {
      id: "room-all",
      kind: "room",
      name: "All hands",
    });
    harness.searchMessages.mockReturnValue({
      items: Array.from({ length: 20 }, (_, index) => ({
        ...hit,
        message: { ...hit.message, id: `count-message-${index}` },
      })),
      page: { has_more: true },
    });
    harness.searchDocuments.mockReturnValue({
      items: Array.from({ length: 20 }, (_, index) => ({
        ...document,
        id: `count-document-${index}`,
      })),
      page: { has_more: true },
    });
    const input = screen.getByRole("combobox", { name: INPUT_NAME });
    fireEvent.change(input, { target: { value: "count-regression" } });
    const messageRows = () =>
      results().queryAllByRole("option", { name: /Count regression message/ });
    await waitFor(() => expect(messageRows()).toHaveLength(3));
    fireEvent.click(
      screen.getByRole("button", { name: /See all in Messages/ }),
    );
    expect(
      screen.getByRole("button", { name: "Remove Messages scope" }),
    ).toBeVisible();
    expect(input).toHaveAttribute("placeholder", "Search messages");
    expect(messageRows()).toHaveLength(20);
    expect(results().queryByText("Docs")).toBeNull();
    // Scoping reuses the page already fetched.
    expect(harness.searchMessages).toHaveBeenCalledTimes(1);
    expect(harness.searchDocuments).toHaveBeenCalledTimes(1);

    // Backspace leaves the scope only once the field is empty.
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(
      screen.getByRole("button", { name: "Remove Messages scope" }),
    ).toBeVisible();
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(
      screen.queryByRole("button", { name: "Remove Messages scope" }),
    ).toBeNull();
    expect(input).toHaveAttribute(
      "placeholder",
      "Search messages, docs, members and rooms",
    );
  });

  it("opens a message hit with the keyword highlight and records the open", async () => {
    const harness = await renderDialog();
    const { message } = await harness.samples();
    harness.searchMessages.mockReturnValue({
      items: [
        messageHit(message, "Freeze the release at four", {
          id: "room-all",
          kind: "room",
          name: "All hands",
        }),
      ],
      page: { has_more: false },
    });
    const input = screen.getByRole("combobox", { name: INPUT_NAME });
    fireEvent.change(input, { target: { value: "Freeze " } });
    const row = await results().findByRole("option", {
      name: /Freeze the release/,
    });
    await waitFor(() =>
      expect(input).toHaveAttribute("aria-activedescendant", row.id),
    );

    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(harness.onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        `/t/${TENANT}/rooms/room-all/chat?message=${message.id}&highlight=Freeze`,
      ),
    );
    expect(harness.onClose).toHaveBeenCalledTimes(1);
    const store = readGlobalSearchStore(TENANT);
    expect(store.queries).toEqual(["Freeze"]);
  });

  it("opens a thread hit through the parent Room thread parameter without a highlight", async () => {
    const harness = await renderDialog();
    const { message } = await harness.samples();
    harness.searchMessages.mockReturnValue({
      items: [
        messageHit(
          { ...message, id: "message-thread-reply" },
          "Thread reply about rollout",
          {
            id: "room-thread-1",
            kind: "thread",
            name: "Rollout thread",
            parent_room_id: "room-all",
            root_message_id: "message-root-1",
          },
        ),
      ],
      page: { has_more: false },
    });
    fireEvent.change(screen.getByRole("combobox", { name: INPUT_NAME }), {
      target: { value: "rollout" },
    });
    // The line opens a few characters before the match.
    const row = await results().findByRole("option", {
      name: /reply about rollout/,
    });
    expect(within(row).getByText(/thread$/)).toBeVisible();
    fireEvent.click(row);
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        `/t/${TENANT}/rooms/room-all/chat?thread=message-root-1`,
      ),
    );
    expect(screen.getByTestId("location")).not.toHaveTextContent("highlight");
  });

  it("opens an Agent from Members into its Direct Room and lists that Room nowhere else", async () => {
    const harness = await renderDialog();
    const input = screen.getByRole("combobox", { name: INPUT_NAME });
    fireEvent.change(input, { target: { value: "codex" } });
    // Agents live in Members, next to Humans, with their agent tile and tag;
    // the Direct Room with Codex is reached through this row, not a Rooms row.
    const agentRow = await results().findByRole("option", { name: /Codex/ });
    expect(
      within(agentRow).getByRole("img", { name: "Codex avatar" }),
    ).toBeVisible();
    expect(within(agentRow).getByText("Agent")).toBeVisible();
    expect(
      results().queryByRole("option", { name: /Direct message/ }),
    ).toBeNull();
    expect(results().queryByText("Rooms")).toBeNull();

    fireEvent.click(agentRow);
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        `/t/${TENANT}/rooms/room-dm-codex/chat`,
      ),
    );
    expect(harness.onClose).toHaveBeenCalledTimes(1);
  });

  it("offers its visible results to Voice Mode and opens and closes like a click", async () => {
    const harness = await renderDialog();
    // Scope cards and recent queries are not results Voice Mode can open.
    expect(voiceSearchResults()).toEqual([]);
    const input = screen.getByRole("combobox", { name: INPUT_NAME });
    fireEvent.change(input, { target: { value: "codex" } });
    await results().findByRole("option", { name: /Codex/ });
    const codex = voiceSearchResults().find(
      (result) => result.name === "Codex",
    );
    expect(codex).toBeDefined();
    expect(voiceClose()).toBe(true);
    expect(harness.onClose).toHaveBeenCalledTimes(1);
    await act(async () => {
      expect(await voiceOpenResult(codex!.id)).toBe(true);
    });
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        `/t/${TENANT}/rooms/room-dm-codex/chat`,
      ),
    );
    expect(harness.onClose).toHaveBeenCalledTimes(2);
  });

  it("creates the Direct Room for an Agent that has none before opening it", async () => {
    const harness = await renderDialog();
    acceptDirectRooms(harness.runtime);
    const input = screen.getByRole("combobox", { name: INPUT_NAME });
    fireEvent.change(input, { target: { value: "lev8" } });
    fireEvent.click(await results().findByRole("option", { name: /Lev8 GTM/ }));
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        new RegExp(`/t/${TENANT}/rooms/room-dm-[^/]+/chat`),
      ),
    );
    const [opened] = harness.runtime.server.requestsTo(
      "POST",
      "/v0/tenants/{tenantId}/direct-rooms",
    );
    expect(new URL(opened!.url).pathname).toBe(
      `/v0/tenants/${TENANT}/direct-rooms`,
    );
    expect(await opened!.json()).toEqual({ peer_actor_id: "actor-lev8" });
    expect(harness.onClose).toHaveBeenCalledTimes(1);
  });

  it("lists no Humans in Members and draws group Rooms as member mosaics", async () => {
    await renderDialog();
    const input = screen.getByRole("combobox", { name: INPUT_NAME });
    fireEvent.change(input, { target: { value: "j" } });
    // Only Agents are Members; Jenny herself has no row.
    await results().findByRole("option", { name: /Jenny's Delegate/ });
    expect(
      results().queryByRole("option", { name: /Jenny Bin/ }),
    ).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: "all" } });
    const groupRow = await results().findByRole("option", { name: /^#all/ });
    // A group Room draws the sidebar's member mosaic instead of a chat glyph.
    expect(
      groupRow.querySelectorAll(".room-avatar .room-avatar-tile [aria-label]")
        .length,
    ).toBeGreaterThan(0);
    expect(
      within(groupRow).getByText("General collaboration for the whole team."),
    ).toBeVisible();
  });

  it("matches cached members locally and searches the backend from two characters", async () => {
    const harness = await renderDialog();
    const input = screen.getByRole("combobox", { name: INPUT_NAME });
    fireEvent.change(input, { target: { value: "j" } });
    const person = await results().findByRole("option", {
      name: /Jenny's Delegate/,
    });
    expect(person).toBeVisible();
    expect(harness.searchMessages).not.toHaveBeenCalled();
    expect(harness.searchDocuments).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "je" } });
    await waitFor(() =>
      expect(searchRequests(harness.searchMessages)).toContainEqual({
        params: { tenantId: TENANT },
        query: { limit: "20", q: "je" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(
      results().getByRole("option", { name: /Jenny's Delegate/ }),
    ).toBeVisible();

    // Tab narrows to the highlighted row's type.
    await hover(results().getByRole("option", { name: /Jenny's Delegate/ }));
    fireEvent.keyDown(input, { key: "Tab" });
    expect(
      screen.getByRole("button", { name: "Remove Members scope" }),
    ).toBeVisible();
    expect(
      results().getByRole("option", { name: /Jenny's Delegate/ }),
    ).toBeVisible();
  });

  it.each([
    ["Members", "codex", /Codex/],
    ["Rooms", "all", /^#all/],
  ])("sends no backend search in the %s scope", async (scope, text, row) => {
    const harness = await renderDialog();
    const input = screen.getByRole("combobox", { name: INPUT_NAME });
    fireEvent.click(
      results().getByRole("option", { name: new RegExp(`^${scope}`) }),
    );
    fireEvent.change(input, { target: { value: text } });
    // Let the debounce settle on the query before checking for requests.
    await act(() => new Promise((resolve) => setTimeout(resolve, 250)));
    expect(results().getByRole("option", { name: row })).toBeVisible();
    expect(harness.searchMessages).not.toHaveBeenCalled();
    expect(harness.searchDocuments).not.toHaveBeenCalled();

    // The same query searches both groups once the scope is removed.
    fireEvent.click(
      screen.getByRole("button", { name: `Remove ${scope} scope` }),
    );
    await waitFor(() =>
      expect(harness.searchMessages).toHaveBeenCalledTimes(1),
    );
    expect(harness.searchDocuments).toHaveBeenCalledTimes(1);
  });

  it("cancels the searches a newer query replaces", async () => {
    const harness = await renderDialog();
    harness.searchMessages.mockReturnValueOnce(new Promise(() => {}));
    harness.searchDocuments.mockReturnValueOnce(new Promise(() => {}));
    const input = screen.getByRole("combobox", { name: INPUT_NAME });
    fireEvent.change(input, { target: { value: "dep" } });
    await waitFor(() =>
      expect(harness.searchMessages).toHaveBeenCalledTimes(1),
    );
    const firstMessages =
      harness.searchMessages.mock.calls[0]![0].request.signal;
    const firstDocuments =
      harness.searchDocuments.mock.calls[0]![0].request.signal;
    expect(firstMessages.aborted).toBe(false);
    expect(firstDocuments.aborted).toBe(false);

    fireEvent.change(input, { target: { value: "deploy" } });
    await waitFor(() =>
      expect(harness.searchMessages).toHaveBeenCalledTimes(2),
    );
    expect(firstMessages.aborted).toBe(true);
    expect(firstDocuments.aborted).toBe(true);
    expect(
      harness.searchMessages.mock.calls[1]![0].request.signal.aborted,
    ).toBe(false);
  });

  it("shows a search TeamHub stopped at its time limit without retrying it", async () => {
    const harness = await renderDialog({ queryClient: createAppQueryClient() });
    harness.searchMessages.mockReturnValue(
      teamHubErrorResponse(
        503,
        "SEARCH_TIMEOUT",
        "search took too long; narrow the query and try again",
      ),
    );
    fireEvent.change(screen.getByRole("combobox", { name: INPUT_NAME }), {
      target: { value: "deploy" },
    });
    expect(await screen.findByText("Search failed")).toBeVisible();
    expect(
      screen.getByText("search took too long; narrow the query and try again"),
    ).toBeVisible();
    expect(harness.searchMessages).toHaveBeenCalledTimes(1);
  });

  it("steps into a scope from its card, browses Members, and closes with Escape", async () => {
    const harness = await renderDialog();
    const input = screen.getByRole("combobox", { name: INPUT_NAME });
    // The Messages card is active first; Tab steps into it.
    fireEvent.keyDown(input, { key: "Tab" });
    expect(
      screen.getByRole("button", { name: "Remove Messages scope" }),
    ).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Search messages");
    fireEvent.keyDown(input, { key: "Backspace" });
    // Enter on the Members card browses every member before a word is typed.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(
      screen.getByRole("button", { name: "Remove Members scope" }),
    ).toBeVisible();
    expect(
      await results().findByRole("option", { name: /Codex/ }),
    ).toBeVisible();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(harness.onClose).toHaveBeenCalledTimes(1);
  });

  it("drops the highlight when the pointer leaves the list and keeps Enter on the active row", async () => {
    await renderDialog();
    const input = screen.getByRole("combobox", { name: INPUT_NAME });
    const cards = results().getAllByRole("option");
    await hover(cards[1]!);
    expect(cards[1]).toHaveClass("bg-app-hover");
    fireEvent.mouseLeave(screen.getByRole("listbox").parentElement!);
    expect(cards[1]).not.toHaveClass("bg-app-hover");
    // Still the Enter target while unhighlighted.
    expect(input).toHaveAttribute("aria-activedescendant", cards[1]!.id);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(cards[2]).toHaveClass("bg-app-hover");
    fireEvent.mouseLeave(screen.getByRole("listbox").parentElement!);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(
      screen.getByRole("button", { name: "Remove Docs scope" }),
    ).toBeVisible();
  });

  it("shows recent searches for an empty query", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seededStore()));
    await renderDialog();
    const input = screen.getByRole("combobox", { name: INPUT_NAME });
    expect(screen.getByText("Recent")).toBeVisible();
    expect(screen.queryByText("Frequently used")).not.toBeInTheDocument();
    const rows = results().getAllByRole("option");
    expect(rows.slice(4).map((row) => row.textContent)).toEqual([
      expect.stringContaining("deploy"),
      expect.stringContaining("freeze"),
    ]);
    // Recent queries are single-line rows with the query glyph.
    expect(rows[4]).toHaveClass("h-10");
    expect(
      rows[4]!.querySelector("svg.global-search-query-glyph"),
    ).not.toBeNull();

    // Arrow keys walk across the scope cards and the Recent rows.
    expect(input).toHaveAttribute("aria-activedescendant", rows[0]!.id);
    for (let step = 0; step < 5; step += 1) {
      fireEvent.keyDown(input, { key: "ArrowDown" });
    }
    expect(input).toHaveAttribute("aria-activedescendant", rows[5]!.id);
  });

  it("re-runs a recent search from its row and clears the list on request", async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seededStore()));
    const harness = await renderDialog();
    const input = screen.getByRole("combobox", { name: INPUT_NAME });
    for (let step = 0; step < 5; step += 1) {
      fireEvent.keyDown(input, { key: "ArrowDown" });
    }
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveValue("freeze");
    expect(harness.onClose).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(searchRequests(harness.searchMessages)).toContainEqual({
        params: { tenantId: TENANT },
        query: { limit: "20", q: "freeze" },
        signal: expect.any(AbortSignal),
      }),
    );

    fireEvent.change(input, { target: { value: "" } });
    await results().findByRole("option", { name: /deploy/ });
    fireEvent.click(
      screen.getByRole("button", { name: "Clear recent searches" }),
    );
    expect(screen.queryByText("Recent")).not.toBeInTheDocument();
    expect(readGlobalSearchStore(TENANT).queries).toEqual([]);
  });
  it("accepts Cmd/Ctrl+K anywhere, including editors, but not mid-composition", () => {
    expect(
      isGlobalSearchShortcut(
        new KeyboardEvent("keydown", { key: "k", metaKey: true }),
      ),
    ).toBe(true);
    expect(
      isGlobalSearchShortcut(
        new KeyboardEvent("keydown", { key: "K", ctrlKey: true }),
      ),
    ).toBe(true);
    expect(
      isGlobalSearchShortcut(new KeyboardEvent("keydown", { key: "k" })),
    ).toBe(false);
    expect(
      isGlobalSearchShortcut(
        new KeyboardEvent("keydown", {
          key: "k",
          metaKey: true,
          shiftKey: true,
        }),
      ),
    ).toBe(false);
    expect(
      isGlobalSearchShortcut(
        new KeyboardEvent("keydown", {
          isComposing: true,
          key: "k",
          metaKey: true,
        }),
      ),
    ).toBe(false);

    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const child = document.createElement("span");
    editor.append(child);
    document.body.append(editor);
    let seen: KeyboardEvent | undefined;
    window.addEventListener("keydown", (event) => (seen = event), {
      once: true,
    });
    child.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "k", metaKey: true }),
    );
    expect(seen).toBeDefined();
    expect(isGlobalSearchShortcut(seen!)).toBe(true);
    editor.remove();
  });
});

function seededStore(): GlobalSearchStore {
  return { queries: ["deploy", "freeze"] };
}

function LocationProbe() {
  const location = useLocation();
  return (
    <p data-testid="location">
      {location.pathname}
      {location.search}
    </p>
  );
}

async function renderDialog({
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  }),
}: { queryClient?: QueryClient } = {}) {
  const runtime = createTestTeamHubRuntime();

  const documents = await teamHubData(
    runtime.client.api.GET("/v0/library/documents/search", {
      params: { query: { q: "product-v0-brief" } },
    }),
  );
  const messages = await teamHubData(
    runtime.client.api.GET("/v0/rooms/{roomId}/messages", {
      params: { path: { roomId: "room-all" } },
    }),
  );
  const samples = async () => ({
    document: documents.items[0] as TeamHubDocument,
    message: messages.items[0] as TeamHubMessage,
  });
  const searchMessages = vi.fn(
    (_request: TestRouteRequest): unknown => emptySearchPage,
  );
  runtime.server.on(
    "GET",
    "/v0/tenants/{tenantId}/messages/search",
    searchMessages,
  );
  const searchDocuments = vi.fn(
    (_request: TestRouteRequest): unknown => emptySearchPage,
  );
  runtime.server.on("GET", "/v0/library/documents/search", searchDocuments);
  const onClose = vi.fn();
  const router = createMemoryRouter(
    [
      {
        element: (
          <>
            <GlobalSearchDialog onClose={onClose} tenantId={TENANT} />
            <LocationProbe />
          </>
        ),
        path: "/t/:tenantId/library",
      },
      { element: <LocationProbe />, path: "*" },
    ],
    { initialEntries: [`/t/${TENANT}/library`] },
  );
  render(
    <QueryClientProvider client={queryClient}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <RouterProvider router={router} />
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
  await screen.findByRole("combobox", { name: INPUT_NAME });
  return { onClose, router, runtime, samples, searchDocuments, searchMessages };
}

const emptySearchPage = { items: [], page: { has_more: false } };

function searchRequests(handler: { mock: { calls: [TestRouteRequest][] } }) {
  return handler.mock.calls.map(([{ params, query, request }]) => ({
    params,
    query: Object.fromEntries(query),
    signal: request.signal,
  }));
}

function messageHit(
  message: TeamHubMessage,
  text: string,
  room: TeamHubMessageSearchHit["room"],
): TeamHubMessageSearchHit {
  return {
    message: {
      ...message,
      raw_message: text,
      room_id: room.id,
    },
    room,
  };
}

/** Rest the pointer on a row long enough for it to become the active row. */
async function hover(element: Element) {
  fireEvent.mouseMove(element);
  await act(() => new Promise((resolve) => setTimeout(resolve, 120)));
}

function createTestStorage(): Storage {
  const values = new Map<string, string>();
  return {
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}
