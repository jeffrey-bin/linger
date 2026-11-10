/**
 * Lets spoken Voice Mode commands drive the app shell: open and use Global
 * Search, open a conversation, and scroll. The shell and the search dialog
 * register what they offer while they are mounted; nothing else is reachable.
 */

export interface VoiceSearchResult {
  id: string;
  name: string;
}

interface VoiceSearchSurface {
  results: () => readonly VoiceSearchResult[];
  open: (id: string) => Promise<void>;
  search: (query: string) => void;
  close: () => void;
}

interface VoiceShell {
  navigate: (path: string) => void;
  openSearch: (query: string) => void;
  back: () => void;
  /** Whether a route change is still loading (lazy routes commit late). */
  navigating: () => boolean;
}

/** The Room on screen opens its own Documents beside its chat. */
interface VoiceRoomFiles {
  open: (documentId: string) => Promise<boolean>;
}

let shell: VoiceShell | undefined;
let roomFiles: VoiceRoomFiles | undefined;
let searchSurface: VoiceSearchSurface | undefined;
/** A page opened from search by voice, so "close" returns to that search. */
let openedByVoice: { path: string; query: string } | undefined;
let lastQuery = "";

export function registerVoiceShell(next: VoiceShell) {
  shell = next;
  return () => {
    if (shell === next) shell = undefined;
  };
}

export function registerVoiceRoomFiles(next: VoiceRoomFiles) {
  roomFiles = next;
  return () => {
    if (roomFiles === next) roomFiles = undefined;
  };
}

/** Opens a Document in the side panel when the Room on screen has it. */
export function voiceOpenRoomDocument(documentId: string) {
  return roomFiles?.open(documentId) ?? Promise.resolve(false);
}

export function registerVoiceSearch(next: VoiceSearchSurface) {
  searchSurface = next;
  return () => {
    if (searchSurface === next) searchSurface = undefined;
  };
}

export function voiceSearchResults() {
  return searchSurface?.results() ?? [];
}

/** True while "close" has something to close: a search, a page voice opened, or a panel. */
export function voiceCanClose() {
  return (
    Boolean(searchSurface) ||
    (openedByVoice !== undefined &&
      window.location.pathname === openedByVoice.path) ||
    openOverlays().length > 0
  );
}

export function voiceSearch(query: string) {
  if (!shell) return false;
  lastQuery = query;
  openedByVoice = undefined;
  if (searchSurface) searchSurface.search(query);
  else shell.openSearch(query);
  return true;
}

export async function voiceOpenResult(id: string) {
  const surface = searchSurface;
  if (!surface?.results().some((result) => result.id === id)) return false;
  const query = lastQuery;
  await surface.open(id);
  openedByVoice = { path: window.location.pathname, query };
  return true;
}

/**
 * Closes the named panel, else the search, else leaves a page opened from it
 * and searches again, else closes the front-most open panel.
 */
export function voiceClose(overlayId?: string) {
  const named = overlayId ? offeredOverlays.get(overlayId) : undefined;
  if (named?.isConnected) return closeOverlay(named);
  if (searchSurface) {
    searchSurface.close();
    return true;
  }
  const onOpenedPage =
    openedByVoice !== undefined &&
    window.location.pathname === openedByVoice.path;
  if (!shell || !openedByVoice || !onOpenedPage) {
    const overlays = openOverlays();
    return overlays.length
      ? closeOverlay(overlays[overlays.length - 1]!)
      : false;
  }
  const { query } = openedByVoice;
  openedByVoice = undefined;
  shell.back();
  if (query) {
    lastQuery = query;
    shell.openSearch(query);
  }
  return true;
}

export function voiceBack() {
  if (!shell) return false;
  // The first page of the tab has nowhere to go back to.
  const index = (window.history.state as { idx?: unknown } | null)?.idx;
  if (typeof index === "number" && index <= 0) return false;
  searchSurface?.close();
  openedByVoice = undefined;
  shell.back();
  return true;
}

export type VoiceElementArea =
  | "navigation"
  | "sidebar"
  | "main"
  | "panel"
  | "dialog";
export interface VoiceElement {
  id: string;
  name: string;
  area: VoiceElementArea;
  /** The element's list, by its label, and its place in that list. */
  group?: string;
  /** The labelled panel or region it sits in, such as "Daily report". */
  within?: string;
  position: number;
  size: number;
  /** Lets "the next one" or "the one after it" be resolved. */
  state?: "current" | "last clicked";
}

const clickable =
  'a[href], button, summary, [role="button"], [role="link"], [role="tab"], [role="option"], [role="menuitem"], [role="treeitem"], input[type="checkbox"], input[type="radio"], [role="switch"], [role="checkbox"], [role="radio"], [role="menuitemcheckbox"], [role="menuitemradio"]';
/**
 * Never clicked by the voice command pipeline: the Human does these
 * themselves. The live model may still list them, behind its spoken
 * confirmation (see collectVoiceElements' riskyTargets).
 */
const destructive =
  /delete|remove|send|log ?out|sign ?out|leave|pay|archive|discard/i;
const areaOrder: VoiceElementArea[] = [
  "dialog",
  "navigation",
  "sidebar",
  "main",
  "panel",
];
const liveAreaOrder: VoiceElementArea[] = [
  "dialog",
  "main",
  "panel",
  "navigation",
  "sidebar",
];
/** The elements offered with the turn being recognized, by id. */
let offeredElements = new Map<string, HTMLElement>();
let lastClicked: HTMLElement | undefined;

/** Whether the page marks this element as the open, selected or pressed one. */
function isCurrent(element: HTMLElement) {
  const marked = (name: string, off = "false") => {
    const value = element.getAttribute(name);
    return value !== null && value !== off;
  };
  return (
    marked("aria-current") ||
    element.getAttribute("aria-selected") === "true" ||
    element.getAttribute("aria-pressed") === "true" ||
    element.dataset.state === "active"
  );
}

function elementName(element: HTMLElement) {
  const name = accessibleName(element);
  // A checkbox or switch says whether it is on, so "turn it off" can be told.
  const checked =
    element instanceof HTMLInputElement &&
    (element.type === "checkbox" || element.type === "radio")
      ? element.checked
      : element.matches('[role="switch"], [role="checkbox"], [role="radio"]')
        ? element.getAttribute("aria-checked") === "true"
        : undefined;
  return checked === undefined || !name
    ? name
    : `${name} [${checked ? "on" : "off"}]`;
}

function accessibleName(element: HTMLElement) {
  if (element instanceof HTMLInputElement && element.labels?.[0])
    return clean(
      element.getAttribute("aria-label") ||
        element.labels[0].innerText ||
        element.labels[0].textContent ||
        "",
    );
  const labelledBy = element
    .getAttribute("aria-labelledby")
    ?.split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
  const name =
    element.getAttribute("aria-label") ||
    labelledBy ||
    element.innerText ||
    element.textContent ||
    element.getAttribute("title") ||
    "";
  return clean(name);
}

const clean = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 120);

function elementArea(element: HTMLElement, rect: DOMRect): VoiceElementArea {
  if (element.closest('[role="dialog"], dialog[open]')) return "dialog";
  if (element.closest('nav[aria-label="Primary navigation"]'))
    return "navigation";
  if (
    element.closest(
      'nav[aria-label="Room navigation"], aside[aria-label$=" sidebar"]',
    )
  )
    return "sidebar";
  return rect.left > window.innerWidth * 0.72 ? "panel" : "main";
}

/** The list or group an element belongs to, so "the 7th project" counts within it. */
const groupSelector =
  'ul, ol, nav, [role="list"], [role="listbox"], [role="menu"], [role="menubar"], [role="tablist"], [role="grid"], [role="tree"], [role="radiogroup"], [role="toolbar"]';

function labelOf(node: Element) {
  const label =
    node.getAttribute("aria-label") ||
    node
      .getAttribute("aria-labelledby")
      ?.split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
  return label?.replace(/\s+/g, " ").trim().slice(0, 60) || undefined;
}

function groupLabel(group: Element | null) {
  return group ? labelOf(group) : undefined;
}

const regionSelector =
  'aside, nav, section, main, form, dialog, [role="dialog"], [role="region"], [role="complementary"], [role="navigation"], [role="main"]';

/** The nearest labelled part of the page around a node, such as "Daily report". */
function regionLabel(node: Element | null | undefined) {
  for (
    let region = node?.closest(regionSelector);
    region;
    region = region.parentElement?.closest(regionSelector)
  ) {
    const label = labelOf(region);
    if (label) return label;
  }
  return undefined;
}

/**
 * The clickable things a spoken "click" may mean, in reading order within
 * each area, numbered within their own list. Items of a list scrolled partly
 * out of view are kept, so "the 7th one" can still be reached. Voice Mode's
 * own window and destructive actions are left out.
 */
export function collectVoiceElements(
  limit = 120,
  options: {
    /** Keep delete/send/leave targets; the live model confirms them aloud. */
    riskyTargets?: boolean;
    /** Keep hover-only actions (message reply, react, more). */
    hoverTargets?: boolean;
  } = {},
): VoiceElement[] {
  type Found = Omit<VoiceElement, "group" | "position" | "size"> & {
    element: HTMLElement;
    rect: DOMRect;
    list: Element | null;
    visible: boolean;
  };
  const found: Found[] = [];
  // An open dialog covers the page: only what is inside it can be clicked.
  const dialog = Array.from(
    document.querySelectorAll<HTMLElement>('[role="dialog"], dialog[open]'),
  )
    .filter(
      (element) =>
        element.getClientRects().length > 0 &&
        !element.closest('[aria-label="Voice Mode window"]'),
    )
    .at(-1);
  for (const element of (dialog ?? document).querySelectorAll<HTMLElement>(
    clickable,
  )) {
    if (
      element.closest(
        '[aria-label="Voice Mode window"], [aria-hidden="true"], [inert]',
      ) ||
      element.matches(":disabled, [aria-disabled='true']")
    )
      continue;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    // Hover-only actions are transparent until pointed at; a person cannot
    // see them, so the command pipeline neither counts nor clicks them. The
    // live model may still use them: they are only hidden, not absent.
    if (
      element.checkVisibility?.({
        visibilityProperty: true,
        ...(options.hoverTargets ? {} : { opacityProperty: true }),
      }) === false
    )
      continue;
    const name = elementName(element);
    if (!name || (!options.riskyTargets && destructive.test(name))) continue;
    found.push({
      area: elementArea(element, rect),
      element,
      list: element.parentElement?.closest(groupSelector) ?? null,
      id: "",
      name,
      rect,
      visible:
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth,
    });
  }
  // Off-screen items stay only when their list shows on screen.
  const shownGroups = new Set(
    found.filter((item) => item.visible).map((item) => item.list),
  );
  const offered = found.filter(
    (item) => item.visible || (item.list && shownGroups.has(item.list)),
  );
  // Position within each list follows document order, as the list reads.
  const members = new Map<Element | null, Found[]>();
  for (const item of offered)
    members.set(item.list, [...(members.get(item.list) ?? []), item]);
  // The live model lists the page the Human is working on before the
  // navigation chrome, so a long Room list cannot crowd out the main area.
  const order = options.riskyTargets ? liveAreaOrder : areaOrder;
  offered.sort(
    (left, right) =>
      order.indexOf(left.area) - order.indexOf(right.area) ||
      left.rect.top - right.rect.top ||
      left.rect.left - right.rect.left,
  );
  offeredElements = new Map();
  return offered.slice(0, limit).map((item, index) => {
    const id = `element-${index}`;
    offeredElements.set(id, item.element);
    const list = members.get(item.list) ?? [item];
    const state =
      item.element === lastClicked
        ? ("last clicked" as const)
        : isCurrent(item.element)
          ? ("current" as const)
          : undefined;
    const group = groupLabel(item.list);
    const within = regionLabel(item.element.parentElement);
    return {
      ...(within && within !== group ? { within } : {}),
      area: item.area,
      id,
      name: item.name,
      position: list.indexOf(item) + 1,
      size: list.length,
      ...(group ? { group } : {}),
      ...(state ? { state } : {}),
    };
  });
}

/** The element behind an offered id, while it is still on screen. */
export function offeredVoiceElement(id: string) {
  const element = offeredElements.get(id);
  return element?.isConnected ? element : undefined;
}

/** Clicks an element offered with this turn, if it is still on screen. */
export function voiceClick(id: string) {
  const element = offeredElements.get(id);
  if (!element?.isConnected) return undefined;
  // A list item scrolled out of view is brought in first, as a person would.
  element.scrollIntoView({ block: "nearest" });
  element.focus({ preventScroll: true });
  element.click();
  lastClicked = element;
  return elementName(element);
}

/** The parts of the layout a click can open, close or resize in place. */
const layoutParts =
  'aside, nav, main, dialog[open], [role="dialog"], [role="complementary"], [role="navigation"]';

/**
 * What a click on an offered control can change without leaving the page:
 * the control's own state and name, and which panels, dialogs and sidebars
 * are on screen and how wide. Equal snapshots mean nothing changed in place.
 */
export function voiceInPlaceState(id: string) {
  const element = offeredElements.get(id);
  const name = element?.isConnected ? elementName(element) : undefined;
  const control = element?.isConnected
    ? ["aria-expanded", "aria-pressed", "aria-checked", "aria-selected"]
        .map((attribute) => element.getAttribute(attribute) ?? "")
        .concat(element.dataset.state ?? "", name ?? "")
        .join("|")
    : "gone";
  const layout = Array.from(document.querySelectorAll<HTMLElement>(layoutParts))
    .filter((part) => onScreen(part.getBoundingClientRect()))
    // Width, not height: a sidebar folds sideways, while new messages only
    // make a column taller.
    .map(
      (part) =>
        `${labelOf(part) ?? part.tagName}:${part.dataset.open ?? ""}:${Math.round(part.getBoundingClientRect().width / 24)}`,
    )
    .join("\n");
  return { key: `${control}\n${layout}`, name };
}

/** Text fields that can be filled by voice; passwords never are. */
const textField =
  'textarea, input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="tel"], input[type="number"]';

export interface VoiceTextField {
  element: HTMLInputElement | HTMLTextAreaElement;
  name: string;
}

/** The visible, enabled text fields in the top-most dialog or the page. */
/** How the chat composer is named to the live model. */
export const chatComposerName = "Chat composer";

export function voiceTextFields(): VoiceTextField[] {
  const dialog = Array.from(
    document.querySelectorAll<HTMLElement>('[role="dialog"], dialog[open]'),
  )
    .filter(
      (element) =>
        element.getClientRects().length > 0 &&
        !element.closest('[aria-label="Voice Mode window"]'),
    )
    .at(-1);
  const fields: VoiceTextField[] = [];
  for (const element of (dialog ?? document).querySelectorAll<
    HTMLInputElement | HTMLTextAreaElement
  >(textField)) {
    if (
      element.closest(
        '[aria-label="Voice Mode window"], [aria-hidden="true"], [inert]',
      ) ||
      element.disabled ||
      element.readOnly ||
      !onScreen(element.getBoundingClientRect())
    )
      continue;
    const name =
      accessibleName(element) ||
      clean(element.getAttribute("placeholder") ?? "") ||
      clean(element.getAttribute("name") ?? "");
    // The chat composer is what "the input box" means when one is not named.
    if (name)
      fields.push({
        element,
        name: element.matches(composer)
          ? `${chatComposerName} [${name}]`
          : name,
      });
  }
  return fields;
}

const composer = '[aria-label^="Message "]';

/**
 * Fills a text field as typing would: the native setter, then an input
 * event, so React's controlled state sees the new value. Nothing is sent.
 */
export function voiceFill(
  element: HTMLInputElement | HTMLTextAreaElement,
  text: string,
  mode: "replace" | "append" = "replace",
) {
  if (!element.isConnected || element.disabled || element.readOnly)
    return false;
  const next =
    mode === "append" && element.value ? `${element.value}${text}` : text;
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(element),
    "value",
  )?.set;
  element.focus({ preventScroll: true });
  if (setter) setter.call(element, next);
  else element.value = next;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return element.value === next;
}

/** Whether the app is still loading a route change voice may have started. */
export function voiceNavigating() {
  return shell?.navigating() ?? false;
}

export function voiceNavigate(path: string) {
  if (!shell) return false;
  searchSurface?.close();
  openedByVoice = undefined;
  shell.navigate(path);
  return true;
}

export type VoiceWindowAction =
  | "mute"
  | "unmute"
  | "expand"
  | "shrink"
  | "move_left"
  | "move_right";

let voiceWindow: ((action: VoiceWindowAction) => void) | undefined;

/** The Voice Mode window offers its own controls while it is open. */
export function registerVoiceWindow(
  control: (action: VoiceWindowAction) => void,
) {
  voiceWindow = control;
  return () => {
    if (voiceWindow === control) voiceWindow = undefined;
  };
}

export function voiceWindowAction(action: VoiceWindowAction) {
  if (!voiceWindow) return false;
  voiceWindow(action);
  return true;
}

export type VoiceScrollDirection =
  | "up"
  | "down"
  | "top"
  | "bottom"
  | "left"
  | "right";

interface Scroller {
  element: HTMLElement;
  slider: boolean;
  area: number;
}

/** What voice scrolled last, and on which page; another page starts afresh. */
let lastScroller: { element: HTMLElement; path: string } | undefined;
/** The scroll regions offered with the turn being recognized, by id. */
let offeredRegions = new Map<string, HTMLElement>();

function onScreen(rect: DOMRect) {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.top < window.innerHeight &&
    rect.right > 0 &&
    rect.left < window.innerWidth
  );
}

/** Whether an element can move in the axis: native scrolling or an ARIA slider. */
function scroller(
  element: HTMLElement,
  horizontal: boolean,
): Scroller | undefined {
  if (element.closest('[aria-label="Voice Mode window"]')) return undefined;
  const rect = element.getBoundingClientRect();
  if (!onScreen(rect)) return undefined;
  const area = rect.width * rect.height;
  if (element.getAttribute("role") === "slider") {
    const vertical = element.getAttribute("aria-orientation") === "vertical";
    return vertical === horizontal
      ? undefined
      : { area, element, slider: true };
  }
  // Size first: reading styles for every element on the page is costly.
  const room = horizontal
    ? element.scrollWidth - element.clientWidth
    : element.scrollHeight - element.clientHeight;
  if (room <= 1) return undefined;
  const style = getComputedStyle(element);
  return /auto|scroll|overlay/.test(
    (horizontal ? style.overflowX : style.overflowY) || style.overflow,
  )
    ? { area, element, slider: false }
    : undefined;
}

function pageScroller(horizontal: boolean): Scroller | undefined {
  const page = document.scrollingElement as HTMLElement | null;
  if (!page) return undefined;
  const room = horizontal
    ? page.scrollWidth - page.clientWidth
    : page.scrollHeight - page.clientHeight;
  return room > 1
    ? {
        area: window.innerWidth * window.innerHeight,
        element: page,
        slider: false,
      }
    : undefined;
}

function allScrollers(horizontal: boolean) {
  const found: Scroller[] = [];
  for (const element of document.querySelectorAll<HTMLElement>("body *")) {
    const item = scroller(element, horizontal);
    if (item) found.push(item);
  }
  const page = pageScroller(horizontal);
  if (page) found.push(page);
  return found;
}

/**
 * A panel floating above the page (fixed, and not the whole window) is what
 * the Human looks at, such as an opened daily summary.
 */
function floats(element: HTMLElement) {
  for (
    let node: HTMLElement | null = element;
    node && node !== document.body;
    node = node.parentElement
  ) {
    if (getComputedStyle(node).position !== "fixed") continue;
    const rect = node.getBoundingClientRect();
    if (
      rect.width < window.innerWidth * 0.9 ||
      rect.height < window.innerHeight * 0.9
    )
      return true;
  }
  return isInDialog(element);
}

function isInDialog(element: HTMLElement) {
  return Boolean(element.closest('dialog[open], [role="dialog"]'));
}

/** The scrollable regions on screen, named by the part of the page they belong to. */
export function voiceScrollRegions() {
  const scrollers = [...allScrollers(false), ...allScrollers(true)];
  const unique = scrollers.filter(
    (item, index) =>
      scrollers.findIndex((other) => other.element === item.element) === index,
  );
  offeredRegions = new Map();
  return unique.slice(0, 30).map((item, index) => {
    const id = `region-${index}`;
    offeredRegions.set(id, item.element);
    const page = item.element === document.scrollingElement;
    const name = page
      ? "the whole page"
      : (labelOf(item.element) ??
        regionLabel(item.element) ??
        `scrolling area ${index + 1}`);
    return {
      id,
      name: floats(item.element) ? `${name} (floating panel)` : name,
    };
  });
}

/**
 * The thing to move when no region is named: a floating panel in front, else
 * the one voice moved last on this page, else the innermost scrolling area in
 * the middle of the page, else the page itself or the largest area.
 */
function findScroller(horizontal: boolean, regionId?: string) {
  const candidates = allScrollers(horizontal);
  if (regionId) {
    const element = offeredRegions.get(regionId);
    return candidates.find((item) => item.element === element);
  }
  if (!candidates.length) return undefined;
  const floating = candidates.filter((item) => floats(item.element));
  if (floating.length) return floating[floating.length - 1];
  if (lastScroller?.path === window.location.pathname) {
    const last = candidates.find(
      (item) => item.element === lastScroller!.element,
    );
    if (last) return last;
  }
  const page = document.scrollingElement;
  const points = (
    document.elementsFromPoint?.(
      window.innerWidth * 0.6,
      window.innerHeight * 0.5,
    ) ?? []
  ).filter((element) => !element.closest('[aria-label="Voice Mode window"]'));
  for (const point of points) {
    const inner = candidates
      .filter((item) => item.element !== page && item.element.contains(point))
      .sort((left, right) => left.area - right.area)[0];
    if (inner) return inner;
  }
  const pageCandidate = candidates.find((item) => item.element === page);
  if (pageCandidate && points.length) return pageCandidate;
  return candidates.reduce((largest, item) =>
    item.area > largest.area ? item : largest,
  );
}

const sliderKeys: Record<VoiceScrollDirection, string> = {
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  top: "Home",
  bottom: "End",
};

/** Scrolls about a screen, or moves a slider a few steps, in that direction. */
export function voiceScroll(
  direction: VoiceScrollDirection,
  regionId?: string,
) {
  const horizontal = direction === "left" || direction === "right";
  const target = findScroller(horizontal, regionId);
  if (!target) return false;
  lastScroller = { element: target.element, path: window.location.pathname };
  if (target.slider) {
    target.element.focus({ preventScroll: true });
    const presses = direction === "top" || direction === "bottom" ? 1 : 3;
    for (let press = 0; press < presses; press++)
      target.element.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: sliderKeys[direction],
        }),
      );
    return true;
  }
  return moveNative(target.element, direction);
}

/** Floating panels and dialogs that can be closed, offered with the turn, by id. */
let offeredOverlays = new Map<string, HTMLElement>();
const closeName = /^(close|dismiss|hide)\b|^×$/i;

function closeButton(overlay: HTMLElement) {
  return Array.from(
    overlay.querySelectorAll<HTMLElement>('button, [role="button"]'),
  ).find((button) => closeName.test(elementName(button)));
}

function openOverlays() {
  return Array.from(
    document.querySelectorAll<HTMLElement>(regionSelector),
  ).filter(
    (overlay) =>
      !overlay.closest('[aria-label="Voice Mode window"]') &&
      onScreen(overlay.getBoundingClientRect()) &&
      // A docked side panel marks itself closable; it neither floats nor is a dialog.
      (isInDialog(overlay) ||
        floats(overlay) ||
        overlay.hasAttribute("data-voice-closable")) &&
      closeButton(overlay) !== undefined &&
      // The outermost floating container stands for its inner parts.
      !overlay.parentElement
        ?.closest(regionSelector)
        ?.matches(":is(dialog[open], [role=dialog])"),
  );
}

/** Open panels and dialogs the Human can close by voice. */
export function voiceOverlays() {
  offeredOverlays = new Map();
  return openOverlays().map((overlay, index) => {
    const id = `overlay-${index}`;
    offeredOverlays.set(id, overlay);
    return { id, name: labelOf(overlay) ?? `open panel ${index + 1}` };
  });
}

function closeOverlay(overlay: HTMLElement) {
  const button = closeButton(overlay);
  if (button) button.click();
  else
    overlay.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }),
    );
  return true;
}

/** Scrolls, and says whether there was room to move that way at all. */
function moveNative(element: HTMLElement, direction: VoiceScrollDirection) {
  const behavior = "smooth" as const;
  const horizontal = direction === "left" || direction === "right";
  const position = horizontal ? element.scrollLeft : element.scrollTop;
  const end = horizontal
    ? element.scrollWidth - element.clientWidth
    : element.scrollHeight - element.clientHeight;
  // Smooth scrolling moves later, so the room is judged before it starts.
  const backward =
    direction === "up" || direction === "left" || direction === "top";
  if (backward ? position <= 1 : position >= end - 1) return false;
  if (horizontal) {
    const step = element.clientWidth * 0.8;
    element.scrollBy({ left: direction === "left" ? -step : step, behavior });
  } else if (direction === "up" || direction === "down") {
    const step = element.clientHeight * 0.8;
    element.scrollBy({ top: direction === "up" ? -step : step, behavior });
  } else
    element.scrollTo({
      top: direction === "top" ? 0 : element.scrollHeight,
      behavior,
    });
  return true;
}

export function resetVoiceUiForTest() {
  shell = undefined;
  searchSurface = undefined;
  openedByVoice = undefined;
  lastQuery = "";
  lastScroller = undefined;
  offeredRegions = new Map();
  offeredOverlays = new Map();
  offeredElements = new Map();
  lastClicked = undefined;
  voiceWindow = undefined;
}
