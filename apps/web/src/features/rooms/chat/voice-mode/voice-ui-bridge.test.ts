// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  collectVoiceElements,
  registerVoiceSearch,
  registerVoiceShell,
  resetVoiceUiForTest,
  voiceBack,
  voiceCanClose,
  voiceClick,
  voiceClose,
  voiceNavigate,
  voiceOpenResult,
  voiceScroll,
  voiceOverlays,
  voiceScrollRegions,
  voiceSearch,
  voiceSearchResults,
  voiceFill,
  voiceInPlaceState,
  voiceTextFields,
} from "./voice-ui-bridge";

afterEach(() => {
  resetVoiceUiForTest();
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
});

function shell() {
  const actions = {
    back: vi.fn(),
    navigate: vi.fn((path: string) => window.history.pushState(null, "", path)),
    openSearch: vi.fn(),
    navigating: () => false,
  };
  registerVoiceShell(actions);
  return actions;
}

function searchSurface() {
  const surface = {
    close: vi.fn(),
    open: vi.fn(async (id: string) => {
      window.history.pushState(null, "", `/t/tenant-1/documents/${id}`);
    }),
    results: () => [
      { id: "doc_budget", name: "Q3 Budget" },
      { id: "doc_plan", name: "Launch plan" },
    ],
    search: vi.fn(),
  };
  const unregister = registerVoiceSearch(surface);
  return { surface, unregister };
}

function pane(name: string, { scrollHeight = 2000, scrollWidth = 400 } = {}) {
  const element = document.createElement("div");
  element.dataset.voiceScroll = name;
  element.style.overflowX = "auto";
  element.style.overflowY = "auto";
  Object.defineProperty(element, "clientHeight", { value: 500 });
  Object.defineProperty(element, "clientWidth", { value: 400 });
  Object.defineProperty(element, "scrollHeight", { value: scrollHeight });
  Object.defineProperty(element, "scrollWidth", { value: scrollWidth });
  // Mid-way, so every direction has room unless a test says otherwise.
  element.scrollTop = 100;
  element.scrollLeft = 1;
  element.getBoundingClientRect = () =>
    ({
      top: 0,
      left: 0,
      bottom: 500,
      right: 400,
      width: 400,
      height: 500,
    }) as DOMRect;
  element.scrollBy = vi.fn();
  element.scrollTo = vi.fn();
  document.body.append(element);
  return element;
}

describe("Voice Mode screen actions", () => {
  it("opens search filled in, or searches again in the open dialog", () => {
    const actions = shell();
    expect(voiceSearch("Q3 Budget")).toBe(true);
    expect(actions.openSearch).toHaveBeenCalledWith("Q3 Budget");

    const { surface } = searchSurface();
    voiceSearch("launch");
    expect(surface.search).toHaveBeenCalledWith("launch");
    expect(actions.openSearch).toHaveBeenCalledOnce();
  });

  it("opens a result, then closing it goes back to the same search", async () => {
    const actions = shell();
    const { surface, unregister } = searchSurface();
    voiceSearch("Q3");
    expect(voiceSearchResults()).toHaveLength(2);
    await expect(voiceOpenResult("doc_missing")).resolves.toBe(false);
    await expect(voiceOpenResult("doc_plan")).resolves.toBe(true);
    expect(surface.open).toHaveBeenCalledWith("doc_plan");
    // Opening a result closes the dialog, which unregisters it.
    unregister();

    expect(voiceCanClose()).toBe(true);
    expect(voiceClose()).toBe(true);
    expect(actions.back).toHaveBeenCalledOnce();
    expect(actions.openSearch).toHaveBeenLastCalledWith("Q3");
    expect(voiceCanClose()).toBe(false);
  });

  it("only closes what voice opened, and only while it is on screen", async () => {
    shell();
    expect(voiceClose()).toBe(false);
    const { unregister } = searchSurface();
    await voiceOpenResult("doc_budget");
    unregister();
    window.history.pushState(null, "", "/t/tenant-1/rooms/room-1/chat");
    expect(voiceCanClose()).toBe(false);
    expect(voiceClose()).toBe(false);
  });

  it("closes an open search before opening a conversation", () => {
    const actions = shell();
    const { surface } = searchSurface();
    expect(voiceNavigate("/t/tenant-1/rooms/room-1/chat")).toBe(true);
    expect(surface.close).toHaveBeenCalledOnce();
    expect(actions.navigate).toHaveBeenCalledWith(
      "/t/tenant-1/rooms/room-1/chat",
    );
  });

  it("scrolls a region named from the screen, else what was scrolled last, else the largest", () => {
    const main = pane("main", { scrollHeight: 3000 });
    const sidebar = pane("sidebar");
    sidebar.setAttribute("aria-label", "Wiki sidebar");
    sidebar.getBoundingClientRect = () =>
      ({
        top: 0,
        left: 0,
        bottom: 500,
        right: 200,
        width: 200,
        height: 500,
      }) as DOMRect;
    expect(voiceScroll("up")).toBe(true);
    expect(main.scrollBy).toHaveBeenCalledWith({
      top: -400,
      behavior: "smooth",
    });

    const regions = voiceScrollRegions();
    const named = regions.find((region) => region.name === "Wiki sidebar")!;
    expect(voiceScroll("top", named.id)).toBe(true);
    expect(sidebar.scrollTo).toHaveBeenCalledWith({
      top: 0,
      behavior: "smooth",
    });
    // "Keep going" without a region follows the last one scrolled.
    voiceScroll("down");
    expect(sidebar.scrollBy).toHaveBeenCalledWith({
      top: 400,
      behavior: "smooth",
    });
    expect(voiceScroll("down", "region-missing")).toBe(false);
  });

  it("reports nothing to scroll at the end, and nothing to go back to on the first page", () => {
    const main = pane("main", { scrollHeight: 3000 });
    main.scrollTop = 0;
    expect(voiceScroll("up")).toBe(false);
    expect(voiceScroll("top")).toBe(false);
    expect(main.scrollBy).not.toHaveBeenCalled();
    main.scrollTop = 2500;
    expect(voiceScroll("down")).toBe(false);
    expect(voiceScroll("up")).toBe(true);

    const actions = shell();
    window.history.replaceState({ idx: 0 }, "", "/first");
    expect(voiceBack()).toBe(false);
    expect(actions.back).not.toHaveBeenCalled();
    window.history.replaceState({ idx: 2 }, "", "/third");
    expect(voiceBack()).toBe(true);
    expect(actions.back).toHaveBeenCalledOnce();
  });

  it("scrolls a floating panel first and closes it by its close button", () => {
    pane("main", { scrollHeight: 3000 });
    const panel = document.createElement("aside");
    panel.setAttribute("aria-label", "Daily report");
    panel.style.position = "fixed";
    panel.getBoundingClientRect = () =>
      ({
        top: 100,
        left: 900,
        bottom: 600,
        right: 1300,
        width: 400,
        height: 500,
      }) as DOMRect;
    const body = pane("document", { scrollHeight: 2000 });
    body.removeAttribute("data-voice-scroll");
    panel.append(body);
    const close = document.createElement("button");
    close.setAttribute("aria-label", "Close Daily");
    const closed = vi.fn();
    close.addEventListener("click", closed);
    panel.append(close);
    document.body.append(panel);

    expect(voiceScroll("down")).toBe(true);
    expect(body.scrollBy).toHaveBeenCalledWith({
      top: 400,
      behavior: "smooth",
    });
    expect(voiceScrollRegions().map((region) => region.name)).toContain(
      "Daily report (floating panel)",
    );

    expect(voiceCanClose()).toBe(true);
    expect(voiceOverlays()).toEqual([
      { id: "overlay-0", name: "Daily report" },
    ]);
    expect(voiceClose()).toBe(true);
    expect(closed).toHaveBeenCalledOnce();
  });
  it("closes a docked side panel that marks itself closable, by its Hide button", () => {
    const panel = document.createElement("aside");
    panel.setAttribute("aria-label", "Panel sidebar");
    panel.setAttribute("data-voice-closable", "");
    panel.getBoundingClientRect = () =>
      ({
        top: 0,
        left: 900,
        bottom: 800,
        right: 1300,
        width: 400,
        height: 800,
      }) as DOMRect;
    const hide = document.createElement("button");
    hide.setAttribute("aria-label", "Hide sidebar");
    const hidden = vi.fn();
    hide.addEventListener("click", hidden);
    panel.append(hide);
    document.body.append(panel);

    expect(voiceCanClose()).toBe(true);
    expect(voiceOverlays()).toEqual([
      { id: "overlay-0", name: "Panel sidebar" },
    ]);
    expect(voiceClose()).toBe(true);
    expect(hidden).toHaveBeenCalledOnce();
    // Without the mark a docked panel is part of the page, not something to close.
    panel.removeAttribute("data-voice-closable");
    expect(voiceCanClose()).toBe(false);
  });

  it("sees a click that unfolds a sidebar in place as a change, and an idle one as none", () => {
    document.body.innerHTML = `
      <main><button aria-expanded="false" aria-label="Expand sidebar"></button><button>Copy</button></main>
      <aside aria-label="Panel sidebar" data-open="false"></aside>`;
    const panel = document.querySelector<HTMLElement>("aside")!;
    let width = 0;
    panel.getBoundingClientRect = () =>
      ({
        top: 0,
        left: 900,
        bottom: 800,
        right: 900 + width,
        width,
        height: 800,
      }) as DOMRect;
    for (const button of document.querySelectorAll<HTMLElement>("button"))
      button.getBoundingClientRect = () =>
        ({
          top: 10,
          left: 10,
          bottom: 30,
          right: 70,
          width: 60,
          height: 20,
        }) as DOMRect;
    const toggle = document.querySelector<HTMLElement>(
      '[aria-label="Expand sidebar"]',
    )!;
    toggle.addEventListener("click", () => {
      toggle.setAttribute("aria-expanded", "true");
      toggle.setAttribute("aria-label", "Hide sidebar");
      panel.dataset.open = "true";
      width = 320;
    });
    const elements = collectVoiceElements();
    const expand = elements.find((item) => item.name === "Expand sidebar")!;
    const copy = elements.find((item) => item.name === "Copy")!;

    const idle = voiceInPlaceState(copy.id);
    voiceClick(copy.id);
    expect(voiceInPlaceState(copy.id).key).toBe(idle.key);

    const before = voiceInPlaceState(expand.id);
    voiceClick(expand.id);
    const after = voiceInPlaceState(expand.id);
    expect(after.key).not.toBe(before.key);
    expect(after.name).toBe("Hide sidebar");
  });

  it("scrolls sideways, and moves a horizontal slider with arrow keys", () => {
    const strip = pane("main", { scrollWidth: 1200 });
    expect(voiceScroll("right")).toBe(true);
    expect(strip.scrollBy).toHaveBeenCalledWith({
      left: 320,
      behavior: "smooth",
    });
    strip.remove();

    const slider = document.createElement("div");
    slider.setAttribute("role", "slider");
    slider.tabIndex = 0;
    slider.getBoundingClientRect = () =>
      ({
        top: 0,
        left: 0,
        bottom: 40,
        right: 600,
        width: 600,
        height: 40,
      }) as DOMRect;
    const keys: string[] = [];
    slider.addEventListener("keydown", (event) => keys.push(event.key));
    document.body.append(slider);
    expect(voiceScroll("left")).toBe(true);
    expect(keys).toEqual(["ArrowLeft", "ArrowLeft", "ArrowLeft"]);
    expect(document.activeElement).toBe(slider);
  });
  it("offers visible clickable elements by area and clicks the one chosen", () => {
    document.body.innerHTML = `
      <nav aria-label="Primary navigation"><a href="/workspace">Workspace</a></nav>
      <nav aria-label="Room navigation"><button aria-label="Pocket notes"></button></nav>
      <main>
        <a href="/doc/1">Q3 Budget.xlsx</a>
        <button>Delete room</button>
        <button disabled>Share</button>
        <button style="display:none">Hidden</button>
      </main>
      <section aria-label="Voice Mode window"><button>End Voice Mode</button></section>
      <div role="dialog"><div role="option">Launch plan</div></div>`;
    const place: Record<string, [number, number]> = {
      Workspace: [10, 100],
      "Pocket notes": [100, 80],
      "Q3 Budget.xlsx": [500, 200],
      "Delete room": [500, 260],
      Share: [500, 300],
      "End Voice Mode": [900, 60],
      "Launch plan": [400, 120],
    };
    for (const element of document.querySelectorAll<HTMLElement>(
      "a, button, [role=option]",
    )) {
      const name =
        element.getAttribute("aria-label") ?? element.textContent ?? "";
      const at = place[name];
      element.getBoundingClientRect = () =>
        ({
          top: at?.[1] ?? 0,
          left: at?.[0] ?? 0,
          bottom: (at?.[1] ?? 0) + (at ? 20 : 0),
          right: (at?.[0] ?? 0) + (at ? 60 : 0),
          width: at ? 60 : 0,
          height: at ? 20 : 0,
        }) as DOMRect;
    }

    const elements = collectVoiceElements();
    expect(elements.map(({ area, name }) => [area, name])).toEqual([
      ["dialog", "Launch plan"],
      ["navigation", "Workspace"],
      ["sidebar", "Pocket notes"],
      ["main", "Q3 Budget.xlsx"],
    ]);

    const link = document.querySelector<HTMLAnchorElement>('a[href="/doc/1"]')!;
    const clicked = vi.fn((event: Event) => event.preventDefault());
    link.addEventListener("click", clicked);
    const file = elements.find((element) => element.name === "Q3 Budget.xlsx")!;
    expect(voiceClick(file.id)).toBe("Q3 Budget.xlsx");
    expect(clicked).toHaveBeenCalledOnce();
    link.remove();
    expect(voiceClick(file.id)).toBeUndefined();
  });

  it("lists named text fields and fills one as typing would, never a password", () => {
    document.body.innerHTML = `
      <main>
        <textarea aria-label="Message Room">Draft</textarea>
        <input type="search" placeholder="Search files" />
        <input type="password" aria-label="Password" />
        <input aria-label="Read only" readonly />
      </main>
      <section aria-label="Voice Mode window"><input aria-label="Box in the voice window" /></section>`;
    for (const element of document.querySelectorAll<HTMLElement>(
      "input, textarea",
    ))
      element.getBoundingClientRect = () =>
        ({
          top: 10,
          left: 10,
          bottom: 30,
          right: 110,
          width: 100,
          height: 20,
        }) as DOMRect;
    expect(voiceTextFields().map(({ name }) => name)).toEqual([
      "Chat composer [Message Room]",
      "Search files",
    ]);
    const composer = voiceTextFields()[0]!.element;
    const inputs: string[] = [];
    composer.addEventListener("input", () => inputs.push(composer.value));
    expect(voiceFill(composer, ", running late", "append")).toBe(true);
    expect(voiceFill(composer, "I will be late")).toBe(true);
    expect(inputs).toEqual(["Draft, running late", "I will be late"]);
    composer.remove();
    expect(voiceFill(composer, "x")).toBe(false);
  });

  it("offers the live model risky, hover-only and switch targets, main area first", () => {
    document.body.innerHTML = `
      <nav aria-label="Primary navigation"><a href="/workspace">Workspace</a></nav>
      <main>
        <button>Delete room</button>
        <div class="hover"><button>Reply</button></div>
        <label><input type="checkbox" checked /> Do not disturb</label>
        <div role="switch" aria-label="Unread only" aria-checked="false"></div>
      </main>`;
    let top = 0;
    for (const element of document.querySelectorAll<HTMLElement>(
      "a, button, input, [role=switch]",
    )) {
      const at = (top += 30);
      element.getBoundingClientRect = () =>
        ({
          top: at,
          left: 300,
          bottom: at + 20,
          right: 360,
          width: 60,
          height: 20,
        }) as DOMRect;
      // Like the browser, an ancestor at opacity 0 hides the element.
      element.checkVisibility = (options?: { opacityProperty?: boolean }) =>
        !(options?.opacityProperty && element.closest(".hover"));
    }
    expect(collectVoiceElements().map(({ name }) => name)).toEqual([
      "Workspace",
      "Do not disturb [on]",
      "Unread only [off]",
    ]);
    expect(
      collectVoiceElements(120, { riskyTargets: true, hoverTargets: true }).map(
        ({ area, name }) => [area, name],
      ),
    ).toEqual([
      ["main", "Delete room"],
      ["main", "Reply"],
      ["main", "Do not disturb [on]"],
      ["main", "Unread only [off]"],
      ["navigation", "Workspace"],
    ]);
  });

  it("goes back and closes an open search first", () => {
    expect(voiceBack()).toBe(false);
    const actions = shell();
    const { surface } = searchSurface();
    expect(voiceBack()).toBe(true);
    expect(surface.close).toHaveBeenCalledOnce();
    expect(actions.back).toHaveBeenCalledOnce();
  });

  it('marks the open item and the one voice clicked last, for "the next one"', () => {
    document.body.innerHTML = `
      <nav aria-label="Room navigation">
        <a href="/a">Alpha</a>
        <a href="/b" aria-current="page">Beta</a>
        <a href="/c">Gamma</a>
      </nav>`;
    document.querySelectorAll<HTMLElement>("a").forEach((link, index) => {
      link.getBoundingClientRect = () =>
        ({
          top: 40 * index,
          left: 80,
          bottom: 40 * index + 30,
          right: 240,
          width: 160,
          height: 30,
        }) as DOMRect;
      link.addEventListener("click", (event) => event.preventDefault());
    });
    const before = collectVoiceElements();
    expect(before.map(({ name, state }) => [name, state])).toEqual([
      ["Alpha", undefined],
      ["Beta", "current"],
      ["Gamma", undefined],
    ]);
    voiceClick(before[2]!.id);
    expect(
      collectVoiceElements().find((item) => item.name === "Gamma")?.state,
    ).toBe("last clicked");
  });

  it("offers only what is inside an open dialog, which covers the page", () => {
    document.body.innerHTML = `
      <main><a href="/files">Files</a></main>
      <dialog open><div role="option">Q3 Budget Review</div></dialog>`;
    for (const element of document.querySelectorAll<HTMLElement>(
      "a, [role=option], dialog",
    )) {
      element.getBoundingClientRect = () =>
        ({
          top: 10,
          left: 300,
          bottom: 40,
          right: 600,
          width: 300,
          height: 30,
        }) as DOMRect;
      element.getClientRects = () => [{}] as unknown as DOMRectList;
    }
    expect(
      collectVoiceElements().map(({ area, name }) => [area, name]),
    ).toEqual([["dialog", "Q3 Budget Review"]]);
  });

  it("numbers items within their own list and keeps off-screen items of a shown list", () => {
    document.body.innerHTML = `
      <aside aria-label="Wiki sidebar">
        <button aria-label="Back to Wiki"></button>
        <nav aria-label="Projects files">
          <a href="/p1">Alpha</a><a href="/p2">Beta</a><a href="/p3">Gamma</a>
        </nav>
      </aside>`;
    const tops = { "Back to Wiki": 10, Alpha: 60, Beta: 100, Gamma: 2000 };
    for (const element of document.querySelectorAll<HTMLElement>("a, button")) {
      const top =
        tops[
          (element.getAttribute("aria-label") ??
            element.textContent) as keyof typeof tops
        ];
      element.getBoundingClientRect = () =>
        ({
          top,
          left: 80,
          bottom: top + 30,
          right: 240,
          width: 160,
          height: 30,
        }) as DOMRect;
      element.scrollIntoView = vi.fn();
      element.addEventListener("click", (event) => event.preventDefault());
    }
    const elements = collectVoiceElements();
    expect(
      elements.map(({ group, name, position, size }) => [
        name,
        group,
        position,
        size,
      ]),
    ).toEqual([
      ["Back to Wiki", undefined, 1, 1],
      ["Alpha", "Projects files", 1, 3],
      ["Beta", "Projects files", 2, 3],
      ["Gamma", "Projects files", 3, 3],
    ]);
    const gamma = document.querySelector<HTMLElement>('a[href="/p3"]')!;
    voiceClick(elements[3]!.id);
    expect(gamma.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("scrolls the page itself when the middle of the screen is not in a scrolling area", () => {
    const sidebar = pane("sidebar");
    const page = document.documentElement;
    Object.defineProperty(document, "scrollingElement", {
      configurable: true,
      value: page,
    });
    Object.defineProperty(page, "scrollHeight", {
      configurable: true,
      value: 3000,
    });
    Object.defineProperty(page, "clientHeight", {
      configurable: true,
      value: 800,
    });
    page.scrollBy = vi.fn();
    const content = document.createElement("main");
    document.body.append(content);
    document.elementsFromPoint = () => [content, document.body];
    try {
      expect(voiceScroll("down")).toBe(true);
      expect(page.scrollBy).toHaveBeenCalled();
      expect(sidebar.scrollBy).not.toHaveBeenCalled();
    } finally {
      // @ts-expect-error jsdom has no elementsFromPoint
      delete document.elementsFromPoint;
      Object.defineProperty(document, "scrollingElement", {
        configurable: true,
        value: null,
      });
      Object.defineProperty(page, "scrollHeight", {
        configurable: true,
        value: 0,
      });
      Object.defineProperty(page, "clientHeight", {
        configurable: true,
        value: 0,
      });
    }
  });
});
