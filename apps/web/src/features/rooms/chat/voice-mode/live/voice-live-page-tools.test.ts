// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createHttpTeamHubClient } from "@/features/teamhub/teamhub-client";
import {
  TeamHubTestServer,
  teamHubErrorResponse,
  type TestRouteHandler,
} from "@/test/teamhub-test-server";
import type { VoiceCommandContext } from "../commands/voice-command";
import {
  matchPageOption,
  pageSettle,
  pageTargetLimits,
  readPageTargets,
  riskyTarget,
  runPageAction,
} from "./voice-live-page-tools";

const page = vi.hoisted(() => ({
  elements: [] as Array<{ id: string; name: string }>,
  rooms: [] as Array<{ id: string; name: string }>,
  sections: [] as Array<{ id: string; name: string }>,
  results: [] as Array<{ id: string; name: string }>,
  regions: [] as Array<{ id: string; name: string }>,
  fields: [] as Array<{ element: { value: string }; name: string }>,
  elementOptions: [] as unknown[],
  ran: [] as Array<[string, ...unknown[]]>,
  /** What each bridge action reports: true when it changed the page. */
  works: true,
  /** Documents the Room on screen has. */
  roomDocuments: [] as string[],
  /** Each control's in-place state, and what a click turns it into. */
  inPlace: new Map<string, { key: string; name?: string }>(),
  toggles: new Map<string, { key: string; name?: string }>(),
  /** A route a click started that commits only after this many polls. */
  lazyRoute: undefined as { path: string; polls: number } | undefined,
  latest: undefined as
    | {
        roomId: string;
        message: { id: string; author: { display_name: string } };
      }
    | undefined,
}));
vi.mock("../commands/builtin-voice-commands", () => ({
  elementOptions: (options: unknown) => {
    page.elementOptions.push(options);
    return page.elements;
  },
  conversations: (_context: unknown, limit = 40) => page.rooms.slice(0, limit),
  sectionOptions: () => page.sections,
  offeredSection: (id: string) =>
    page.sections.some((section) => section.id === id)
      ? { scrollIntoView: () => page.ran.push(["jump", id]) }
      : undefined,
  latestOtherMessage: () => page.latest,
  reactions: [
    { id: "+1", name: "thumbs up, like" },
    { id: "heart", name: "heart, love" },
  ],
}));
const act = vi.hoisted(() => (name: string) => (...args: unknown[]) => {
  page.ran.push([name, ...args]);
  return page.works;
});
vi.mock("../voice-ui-bridge", () => ({
  chatComposerName: "Chat composer",
  // Each element id stands for one element on screen.
  offeredVoiceElement: (id: string) =>
    page.elements.some((element) => element.id === id) ? { id } : undefined,
  voiceClick: (id: string) => {
    if (!act("click")(id)) return undefined;
    const toggled = page.toggles.get(id);
    if (toggled) page.inPlace.set(id, toggled);
    return id;
  },
  voiceInPlaceState: (id: string) => page.inPlace.get(id) ?? { key: "steady" },
  voiceNavigating: () => {
    const route = page.lazyRoute;
    if (!route) return false;
    if (--route.polls > 0) return true;
    window.history.pushState(null, "", route.path);
    page.lazyRoute = undefined;
    return false;
  },
  voiceNavigate: (path: string) => {
    if (!act("navigate")(path)) return false;
    window.history.pushState(null, "", path);
    return true;
  },
  voiceScroll: act("scroll"),
  voiceBack: () => {
    if (!act("back")()) return false;
    window.history.pushState(null, "", "/previous");
    return true;
  },
  voiceClose: act("close"),
  voiceSearch: act("search"),
  voiceOpenResult: async (id: string) => act("open_result")(id),
  voiceOpenRoomDocument: async (id: string) => {
    if (!page.roomDocuments.includes(id)) return false;
    page.ran.push(["room_document", id]);
    return true;
  },
  voiceSearchResults: () => page.results,
  voiceScrollRegions: () => page.regions,
  voiceWindowAction: act("window"),
  voiceTextFields: () => page.fields,
  voiceFill: (
    element: { value: string },
    text: string,
    mode: "replace" | "append",
  ) => {
    if (!page.works) return false;
    element.value = mode === "append" ? element.value + text : text;
    page.ran.push(["type", text, mode]);
    return true;
  },
}));

const putMessageReaction = vi.fn<TestRouteHandler>(() => undefined);
/** Files the user can open, by id. */
const files = new Map([
  ["document_inroom", "Jensen Huang recent gossip.pptx"],
  ["document_elsewhere", "AI glasses market 2026.pptx"],
]);
const server = new TeamHubTestServer()
  .on(
    "PUT",
    "/v0/rooms/{roomId}/messages/{messageId}/reactions/{reactionId}",
    putMessageReaction,
  )
  .on("GET", "/v0/documents/{documentId}", ({ params }) => {
    const title = files.get(params.documentId!);
    return title
      ? { id: params.documentId, tenant_id: "t1", title }
      : teamHubErrorResponse(404, "NOT_FOUND");
  });
const context = {
  tenantId: "t1",
  roomId: "room-1",
  client: createHttpTeamHubClient({
    fetchRequest: server.fetch,
    onAuthenticationRequired: () => undefined,
  }),
} as unknown as VoiceCommandContext;
const element = (id: string, name: string) => ({
  id,
  name: `${name} (main area, item 1 of 3)`,
});

beforeEach(() => {
  page.elements = [
    element("el-1", "Pocket Note"),
    element("el-2", "Delete message"),
  ];
  page.rooms = [
    { id: "room-1", name: "Inner Mongolia trip" },
    { id: "room-2", name: "Inner Mongolia" },
  ];
  page.sections = [];
  page.results = [];
  page.regions = [];
  page.fields = [];
  page.elementOptions = [];
  page.ran = [];
  page.works = true;
  page.inPlace = new Map();
  page.toggles = new Map();
  page.lazyRoute = undefined;
  page.latest = undefined;
  pageSettle.waitMs = 0;
  pageSettle.stepMs = 0;
  putMessageReaction.mockClear();
  window.history.replaceState(null, "", "/t/t1/rooms/room-1/chat");
});

describe("model page tools", () => {
  it("matches spoken names, ids and the closest partial name", () => {
    const options = [...page.elements, ...page.rooms];
    expect(matchPageOption(options, "“Pocket Note”")?.id).toBe("el-1");
    expect(matchPageOption(options, "room-1")?.id).toBe("room-1");
    expect(matchPageOption(options, "the Inner Mongolia room")?.id).toBe(
      "room-2",
    );
    expect(matchPageOption(options, "Financial statements")).toBeUndefined();
    expect(matchPageOption(options, "")).toBeUndefined();
  });

  it("lists every kind of target within limits, including risky and hover-only ones", () => {
    page.elements = Array.from({ length: 80 }, (_, index) =>
      element(
        `el-${index}`,
        index === 1 ? "Delete" : `Button${index}${"x".repeat(60)}`,
      ),
    );
    page.elements.push(element("blank", " "));
    page.rooms = Array.from({ length: 40 }, (_, index) => ({
      id: `room-${index}`,
      name: `Room ${index}`,
    }));
    page.results = [{ id: "res-1", name: "Q3 Budget" }];
    page.sections = [{ id: "section-0", name: "Pricing (section 1)" }];
    page.regions = [
      { id: "region-0", name: "the whole page" },
      { id: "region-1", name: "Wiki sidebar" },
    ];
    const lines = readPageTargets(context).split("\n");
    const count = (prefix: string) =>
      lines.filter((line) => new RegExp(`^${prefix}\\d`).test(line)).length;
    expect(count("e")).toBe(pageTargetLimits.elements);
    expect(count("r")).toBe(pageTargetLimits.rooms);
    expect(lines).toContain("e2 Delete (needs confirmation)");
    expect(lines).toContain("s1 Search result: Q3 Budget");
    expect(lines).toContain("h1 Document section: Pricing");
    expect(lines).toContain("g2 Scrollable region: Wiki sidebar");
    expect(lines).toContain("r1 Room: Room 0");
    expect(
      lines.some((line) => /^s\d+ Search result: Q3 Budget$/.test(line)),
    ).toBe(true);
    expect(
      lines.some((line) => /^h\d+ Document section: Pricing$/.test(line)),
    ).toBe(true);
    expect(
      lines.some((line) => /^g\d+ Scrollable region: Wiki sidebar$/.test(line)),
    ).toBe(true);
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThan(60);
    expect(page.elementOptions[0]).toEqual({
      riskyTargets: true,
      hoverTargets: true,
    });
  });

  it("acts on listed refs and refuses targets not on screen", async () => {
    readPageTargets(context);
    await expect(
      runPageAction({ action: "click", target: "e1" }, context),
    ).resolves.toMatchObject({ status: "done" });
    await expect(
      runPageAction({ action: "open_room", target: "r2" }, context),
    ).resolves.toMatchObject({ status: "done" });
    await expect(
      runPageAction(
        { action: "click", target: "Financial statements" },
        context,
      ),
    ).resolves.toMatchObject({ status: "not_found" });
    expect(page.ran).toEqual([
      ["click", "el-1"],
      ["navigate", "/t/t1/rooms/room-2/chat"],
    ]);
  });

  it("waits for a lazy route a click started before saying the page did not change", async () => {
    readPageTargets(context);
    page.lazyRoute = { path: "/t/t1/library/wiki", polls: 3 };
    const result = await runPageAction(
      { action: "click", target: "e1" },
      context,
    );
    expect(result.status).toBe("done");
    expect(result.detail).toContain("the page changed");
    expect(window.location.pathname).toBe("/t/t1/library/wiki");
  });

  it("waits for a list still loading before reading the page after a click", async () => {
    readPageTargets(context);
    const loading = document.createElement("p");
    loading.setAttribute("aria-busy", "true");
    document.body.append(loading);
    setTimeout(() => loading.remove(), 200);
    await expect(
      runPageAction({ action: "click", target: "e1" }, context),
    ).resolves.toMatchObject({ status: "done" });
    expect(loading.isConnected).toBe(false);
  });

  it("names the page now on screen and never says a click that stayed reached another page", async () => {
    readPageTargets(context);
    document.title = "Messages";
    const stayed = await runPageAction(
      { action: "click", target: "e1" },
      context,
    );
    expect(stayed.detail).toContain("look the same");
    expect(stayed.detail).toContain("Messages");
    expect(stayed.detail).toContain("you are not there yet");
    expect(stayed.detail).toContain("Never click it again on your own");
    const opened = await runPageAction(
      { action: "open_room", target: "r2" },
      context,
    );
    expect(opened).toMatchObject({ status: "done" });
    expect(opened.detail).toContain("/t/t1/rooms/room-2/chat");
  });

  it("says a click that opened or folded something in place worked, so it is not clicked again", async () => {
    page.elements = [element("el-1", "Expand sidebar")];
    page.inPlace = new Map([
      ["el-1", { key: "folded", name: "Expand sidebar" }],
    ]);
    page.toggles = new Map([["el-1", { key: "open", name: "Hide sidebar" }]]);
    readPageTargets(context);
    const result = await runPageAction(
      { action: "click", target: "e1" },
      context,
    );
    expect(result.status).toBe("done");
    expect(result.detail).toContain("changed on this page");
    expect(result.detail).toContain('now reads "Hide sidebar"');
    expect(result.detail).toContain("never click it again unless they ask");
    expect(page.ran.filter(([name]) => name === "click")).toHaveLength(1);
  });

  it("opens a document beside the chat when the room has it, else in the Library", async () => {
    window.history.replaceState(null, "", "/t/t1/rooms/room-1/chat");
    page.roomDocuments = ["document_inroom"];
    await expect(
      runPageAction(
        { action: "open_document", target: "document_inroom" },
        context,
      ),
    ).resolves.toMatchObject({
      status: "done",
      // The file is named, so a wrong id is caught before the user hears it.
      detail: expect.stringContaining("Jensen Huang recent gossip.pptx"),
    });
    expect(page.ran).toContainEqual(["room_document", "document_inroom"]);
    expect(window.location.pathname).toBe("/t/t1/rooms/room-1/chat");

    const elsewhere = await runPageAction(
      { action: "open_document", target: "document_elsewhere" },
      context,
    );
    expect(elsewhere).toMatchObject({
      status: "done",
      detail: expect.stringContaining("Library"),
    });
    expect(window.location.pathname).toBe("/t/t1/documents/document_elsewhere");

    // An id nobody can open is refused, never guessed at.
    await expect(
      runPageAction(
        { action: "open_document", target: "document_missing" },
        context,
      ),
    ).resolves.toMatchObject({ status: "not_found" });

    // A search result ref or a name is not a document id.
    await expect(
      runPageAction({ action: "open_document", target: "s1" }, context),
    ).resolves.toMatchObject({ status: "failed" });
    page.roomDocuments = [];
  });

  it("opens a room by its id or path even before the room list shows it", async () => {
    for (const target of [
      "room_d6213794ed6fc65e6c2ad0f80bf540e4",
      "/t/t1/rooms/room_d6213794ed6fc65e6c2ad0f80bf540e4",
    ]) {
      window.history.replaceState(null, "", "/t/t1/rooms/room-1/chat");
      const opened = await runPageAction(
        { action: "open_room", target },
        context,
      );
      expect(opened.status).toBe("done");
      expect(window.location.pathname).toBe(
        "/t/t1/rooms/room_d6213794ed6fc65e6c2ad0f80bf540e4/chat",
      );
    }
  });

  it("opens any cached Room by name and says when it is already open", async () => {
    page.rooms = Array.from({ length: 120 }, (_, index) => ({
      id: `room-${index}`,
      name: `Room ${index}`,
    }));
    await expect(
      runPageAction({ action: "open_room", target: "Room 99" }, context),
    ).resolves.toMatchObject({ status: "done" });
    await expect(
      runPageAction({ action: "open_room", target: "Room 99" }, context),
    ).resolves.toMatchObject({
      status: "done",
      detail: expect.stringContaining("already open"),
    });
    expect(page.ran).toEqual([["navigate", "/t/t1/rooms/room-99/chat"]]);
  });

  it("never leaves the page for a chat room when a click's name is not on screen", async () => {
    page.rooms = [
      { id: "room-9", name: "Latency context-project-1-continuous" },
    ];
    const result = await runPageAction(
      { action: "click", target: "project" },
      context,
    );
    expect(result.status).toBe("not_found");
    expect(page.ran).toEqual([]);
    expect(window.location.pathname).toBe("/t/t1/rooms/room-1/chat");
  });

  it("asks instead of guessing when a spoken name fits several targets", async () => {
    page.elements = [
      element("el-1", "Project Alpha"),
      element("el-2", "Project Beta"),
    ];
    const click = await runPageAction(
      { action: "click", target: "project" },
      context,
    );
    expect(click.status).toBe("ambiguous");
    expect(click.detail).toContain("Project Alpha");
    expect(click.detail).toContain("Project Beta");
    page.rooms = [
      { id: "room-7", name: "context-project-1" },
      { id: "room-8", name: "context-project-2" },
    ];
    const open = await runPageAction(
      { action: "open_room", target: "project" },
      context,
    );
    expect(open.status).toBe("ambiguous");
    expect(page.ran).toEqual([]);
  });

  it("never reports done for an action that changed nothing", async () => {
    page.works = false;
    readPageTargets(context);
    for (const request of [
      { action: "scroll", target: "down" },
      { action: "back" },
      { action: "close" },
      { action: "click", target: "e1" },
      { action: "open_room", target: "Inner Mongolia" },
      { action: "search", text: "budget" },
      { action: "voice_window", target: "mute" },
    ])
      await expect(runPageAction(request, context)).resolves.toMatchObject({
        status: "no_effect",
      });
  });

  it("returns to the start Room, searches, opens a result and jumps to a section", async () => {
    window.history.replaceState(null, "", "/t/t1/rooms/room-2/chat");
    await expect(
      runPageAction({ action: "return_room" }, context),
    ).resolves.toMatchObject({ status: "done" });
    await expect(
      runPageAction({ action: "search", text: "budget" }, context),
    ).resolves.toMatchObject({ status: "done" });
    page.results = [{ id: "res-1", name: "Q3 Budget" }];
    page.sections = [{ id: "section-0", name: "Pricing (section 1)" }];
    await expect(
      runPageAction({ action: "open_result", target: "Q3 Budget" }, context),
    ).resolves.toMatchObject({ status: "done" });
    await expect(
      runPageAction({ action: "jump_section", target: "Pricing" }, context),
    ).resolves.toMatchObject({ status: "done" });
    await expect(
      runPageAction({ action: "jump_section", target: "Appendix" }, context),
    ).resolves.toMatchObject({ status: "not_found" });
    expect(page.ran).toEqual([
      ["navigate", "/t/t1/rooms/room-1/chat"],
      ["search", "budget"],
      ["open_result", "res-1"],
      ["jump", "section-0"],
    ]);
  });

  it("controls the voice window and reacts to the latest message of someone else", async () => {
    await expect(
      runPageAction({ action: "voice_window", target: "mute" }, context),
    ).resolves.toMatchObject({ status: "done" });
    await expect(
      runPageAction({ action: "voice_window", target: "louder" }, context),
    ).resolves.toMatchObject({ status: "failed" });
    await expect(
      runPageAction({ action: "react", target: "+1" }, context),
    ).resolves.toMatchObject({ status: "no_effect" });
    page.latest = {
      roomId: "room-1",
      message: { id: "m1", author: { display_name: "Wang" } },
    };
    await expect(
      runPageAction({ action: "react", target: "like" }, context),
    ).resolves.toMatchObject({ status: "done" });
    expect(putMessageReaction).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { messageId: "m1", reactionId: "+1", roomId: "room-1" },
      }),
    );
  });

  it("asks before risky clicks and runs them once confirmed", async () => {
    expect(riskyTarget("Delete message")).toBe(true);
    expect(riskyTarget("Leave room")).toBe(true);
    expect(riskyTarget("Pocket Note")).toBe(false);
    // Approval decisions wait for the Human's yes too.
    for (const name of ["Approve", "Approve and run", "Deny"])
      expect(riskyTarget(name)).toBe(true);
    expect(riskyTarget("Exit Voice Mode")).toBe(false);
    await expect(
      runPageAction({ action: "click", target: "Delete message" }, context),
    ).resolves.toMatchObject({ status: "needs_confirmation" });
    expect(page.ran).toEqual([]);
    await expect(
      runPageAction(
        { action: "click", target: "Delete message", confirmed: "True" },
        context,
      ),
    ).resolves.toMatchObject({ status: "done" });
    expect(page.ran).toEqual([["click", "el-2"]]);

    // An approval card's button is held the same way until the Human agrees.
    page.ran = [];
    page.elements = [element("el-3", "Approve")];
    await expect(
      runPageAction({ action: "click", target: "Approve" }, context),
    ).resolves.toMatchObject({ status: "needs_confirmation" });
    expect(page.ran).toEqual([]);
    await expect(
      runPageAction(
        { action: "click", target: "Approve", confirmed: true },
        context,
      ),
    ).resolves.toMatchObject({ status: "done" });
    expect(page.ran).toEqual([["click", "el-3"]]);
  });

  it("types into a listed or named field without sending anything", async () => {
    const composer = {
      element: { value: "Draft" },
      name: "Chat composer [Message Room]",
    };
    const comment = { element: { value: "" }, name: "Write a comment" };
    const title = { element: { value: "" }, name: "Title" };
    page.fields = [composer, comment];
    expect(readPageTargets(context).split("\n")).toEqual(
      expect.arrayContaining([
        "t1 Input field: Chat composer [Message Room]",
        "t2 Input field: Write a comment",
      ]),
    );
    await expect(
      runPageAction(
        { action: "type", target: "t2", text: " Agreed " },
        context,
      ),
    ).resolves.toMatchObject({
      status: "done",
      detail: expect.stringContaining("nothing is sent"),
    });
    await expect(
      runPageAction(
        {
          action: "type",
          target: "Message Room",
          text: ", running late",
          mode: "append",
        },
        context,
      ),
    ).resolves.toMatchObject({ status: "done" });
    expect(comment.element.value).toBe(" Agreed ");
    expect(composer.element.value).toBe("Draft, running late");
    // "The message box", or no field named, means the chat composer.
    for (const target of ["message box", undefined])
      await expect(
        runPageAction(
          { action: "type", target, text: "I will be late" },
          context,
        ),
      ).resolves.toMatchObject({ status: "done" });
    expect(composer.element.value).toBe("I will be late");
    // Without a composer, several fields are unclear; one is not.
    page.fields = [comment, title];
    await expect(
      runPageAction({ action: "type", text: "x" }, context),
    ).resolves.toMatchObject({
      status: "not_found",
      detail: expect.stringContaining("Write a comment, Title"),
    });
    page.fields = [comment];
    await expect(
      runPageAction({ action: "type", text: "OK" }, context),
    ).resolves.toMatchObject({ status: "done" });
    page.works = false;
    await expect(
      runPageAction({ action: "type", text: "OK" }, context),
    ).resolves.toMatchObject({ status: "no_effect" });
  });

  it("lists targets matching the focus first, within the same limits", () => {
    // Covers focusTerms' per-script two-character splitting for Han.
    page.elements = [
      ...Array.from({ length: 70 }, (_, index) =>
        element(`el-${index}`, `\u6309\u94ae${index}`),
      ),
      element("el-reply", "\u56de\u590d"),
    ];
    page.rooms = Array.from({ length: 60 }, (_, index) => ({
      id: `room-${index}`,
      name:
        index === 55
          ? "\u5e02\u573a\u90e8\u5468\u4f1a"
          : `\u623f\u95f4${index}`,
    }));
    expect(readPageTargets(context)).not.toContain("\u56de\u590d");
    const focused = readPageTargets(
      context,
      "\u5c0f\u738b\u90a3\u6761\u7684\u56de\u590d，\u518d\u6253\u5f00\u5e02\u573a\u90e8",
    );
    const lines = focused.split("\n");
    expect(lines[0]).toBe("e1 \u56de\u590d");
    expect(lines).toContain("r1 Room: \u5e02\u573a\u90e8\u5468\u4f1a");
    expect(lines.filter((line) => /^e\d/.test(line))).toHaveLength(
      pageTargetLimits.elements,
    );
  });

  it("finds a listed target again by name after the page rerendered it", async () => {
    readPageTargets(context);
    page.elements = [element("el-7", "Pocket Note")];
    await expect(
      runPageAction({ action: "click", target: "e1" }, context),
    ).resolves.toMatchObject({ status: "done" });
    expect(page.ran).toEqual([["click", "el-7"]]);
  });

  it("waits briefly for a click target a previous step is still rendering", async () => {
    pageSettle.waitMs = 600;
    pageSettle.stepMs = 20;
    page.elements = [];
    setTimeout(() => {
      page.elements = [element("el-9", "New note")];
    }, 60);
    await expect(
      runPageAction({ action: "click", target: "New note" }, context),
    ).resolves.toMatchObject({ status: "done" });
    expect(page.ran).toEqual([["click", "el-9"]]);
  });
});
