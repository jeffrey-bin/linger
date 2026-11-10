/**
 * The live model operates the page itself (VOICE_RUNTIME_LIVE_MODEL_PAGE_TOOLS).
 * read_page lists what can be acted on with short refs; a page_action target
 * (a ref or a spoken name) is resolved against what is on screen now and
 * refused when not found, so a guess never acts on something else. Every
 * result is what actually happened: an action that changed nothing is
 * no_effect, never done. Risky targets wait for the Human's spoken yes.
 */
import { QueryClient } from "@tanstack/react-query";

import { teamHubDone } from "@/features/teamhub/teamhub-api";
import { documentQueryOptions } from "../../../room-queries";
import {
  conversations,
  elementOptions,
  latestOtherMessage,
  offeredSection,
  reactions,
  sectionOptions,
} from "../commands/builtin-voice-commands";
import type {
  VoiceCommandContext,
  VoiceCommandOption,
} from "../commands/voice-command";
import {
  chatComposerName,
  offeredVoiceElement,
  voiceBack,
  voiceClick,
  voiceClose,
  voiceNavigate,
  voiceNavigating,
  voiceOpenResult,
  voiceOpenRoomDocument,
  voiceScroll,
  voiceScrollRegions,
  voiceSearch,
  voiceSearchResults,
  voiceTextFields,
  voiceFill,
  voiceInPlaceState,
  voiceWindowAction,
  type VoiceScrollDirection,
  type VoiceWindowAction,
} from "../voice-ui-bridge";
import { voicePageState } from "./voice-page-reader";

/** read_page text from Runtime that also asks for clickable targets. */

const scrollDirections = ["up", "down", "top", "bottom", "left", "right"];
const windowActions = [
  "mute",
  "unmute",
  "expand",
  "shrink",
  "move_left",
  "move_right",
];
/** read_page lists at most this many targets of each kind. */
export const pageTargetLimits = {
  elements: 60,
  rooms: 30,
  sections: 20,
  results: 10,
  fields: 10,
  nameChars: 40,
};
/** All cached Rooms can be opened by name, not only the listed ones. */
const openableRooms = 500;
/** A field named only by kind ("the input box"), not by its label. */
const genericField = /^(?:input|textbox|text box|message box|composer)$/iu;

/**
 * Deleting, sending, leaving, paying, approving or other decisions that
 * cannot be undone: clicked only after the Human said yes to this click.
 */
const riskyName =
  /approve|deny|reject|decline|authori[sz]e|grant|accept|delete|remove|send|submit|leave|exit|quit|pay|purchase|buy|transfer|kick|ban|block|archive|reset|sign ?out|log ?out|discard|revoke|uninstall|destroy/iu;

/** Leaving Voice Mode itself is never confirmed. */
const leavesVoiceMode = /^(?:exit|leave|end|close) voice(?: mode)?$/iu;

export function riskyTarget(name: string) {
  return !leavesVoiceMode.test(name.trim()) && riskyName.test(name);
}

function normalized(text: string) {
  return text.toLowerCase().replace(/[\s\p{Ps}\p{Pe}\p{Pi}\p{Pf}"']/gu, "");
}

const label = (option: VoiceCommandOption) =>
  option.name.replace(/\s*\([^)]*\)\s*$/u, "");

/**
 * Options a spoken name could mean: the id or exact name alone when there is
 * one, otherwise every partial match, shortest name first.
 */
function pageMatches(
  options: readonly VoiceCommandOption[],
  target: string,
): VoiceCommandOption[] {
  const wanted = normalized(target);
  if (!wanted) return [];
  const byId = options.find((option) => option.id === target);
  if (byId) return [byId];
  const name = (option: VoiceCommandOption) => normalized(label(option));
  const exact = options.find((option) => name(option) === wanted);
  if (exact) return [exact];
  const partial = options.filter(
    (option) =>
      name(option) &&
      (name(option).includes(wanted) || wanted.includes(name(option))),
  );
  return partial.sort((a, b) => name(a).length - name(b).length);
}

/** The single best option for a spoken name, or nothing when unclear. */
export function matchPageOption(
  options: readonly VoiceCommandOption[],
  target: string,
): VoiceCommandOption | undefined {
  return pageMatches(options, target)[0];
}

/** What the live model may act on: risky and hover-only targets included. */
const liveElements = () =>
  elementOptions({ riskyTargets: true, hoverTargets: true });

type Listed =
  | { kind: "element"; element: Element; name: string }
  | {
      kind: "field";
      element: HTMLInputElement | HTMLTextAreaElement;
      name: string;
    }
  | { kind: "room"; room: string; name: string }
  | { kind: "section" | "result" | "region"; id: string; name: string };

/** Targets listed by the last read_page, by ref, while still on screen. */
let listed = new Map<string, Listed>();

/**
 * Words of what the Human asked about (read_page's focus): CJK runs as
 * two-character pieces, other words whole, so a Chinese phrase finds a two-character word inside it.
 */
function focusTerms(focus: string) {
  const terms = new Set<string>();
  for (const word of focus
    .toLowerCase()
    .match(/[\p{Script=Han}]+|[a-z0-9]+/gu) ?? []) {
    if (/^[a-z0-9]+$/u.test(word)) {
      if (word.length > 1) terms.add(word);
      continue;
    }
    if (word.length === 1) terms.add(word);
    for (let index = 0; index + 2 <= word.length; index++)
      terms.add(word.slice(index, index + 2));
  }
  return [...terms];
}

/** Puts what matches the focus first, keeping each side in screen order. */
function byFocus<T>(
  items: readonly T[],
  name: (item: T) => string,
  terms: string[],
) {
  if (!terms.length) return [...items];
  const matches = (item: T) => {
    const text = name(item).toLowerCase();
    return terms.some((term) => text.includes(term));
  };
  return [...items.filter(matches), ...items.filter((item) => !matches(item))];
}

/**
 * The targets on screen and the Rooms, compactly, with refs. A focus (what
 * the Human asked about) lists matching targets first, so a long page does
 * not push the wanted one past the limits.
 */
export function readPageTargets(context: VoiceCommandContext, focus = "") {
  listed = new Map();
  const lines: string[] = [];
  const terms = focusTerms(focus);
  const short = (text: string) => text.slice(0, pageTargetLimits.nameChars);
  // Each kind counts from 1, so "the first result" is s1.
  const counts = new Map<string, number>();
  const add = (prefix: string, item: Listed, line: string) => {
    const count = (counts.get(prefix) ?? 0) + 1;
    counts.set(prefix, count);
    const ref = `${prefix}${count}`;
    listed.set(ref, item);
    lines.push(`${ref} ${line}`);
  };
  const elements = byFocus(liveElements(), label, terms);
  for (const option of elements.slice(0, pageTargetLimits.elements)) {
    const element = offeredVoiceElement(option.id);
    const name = short(label(option));
    if (!element || !name.trim()) continue;
    add(
      "e",
      { kind: "element", element, name },
      `${name}${riskyTarget(name) ? " (needs confirmation)" : ""}`,
    );
  }
  for (const field of voiceTextFields().slice(0, pageTargetLimits.fields))
    add(
      "t",
      { kind: "field", element: field.element, name: short(field.name) },
      `Input field: ${short(field.name)}`,
    );
  for (const result of voiceSearchResults().slice(0, pageTargetLimits.results))
    add(
      "s",
      { kind: "result", id: result.id, name: short(result.name) },
      `Search result: ${short(result.name)}`,
    );
  for (const section of sectionOptions().slice(0, pageTargetLimits.sections))
    add(
      "h",
      { kind: "section", id: section.id, name: short(label(section)) },
      `Document section: ${short(label(section))}`,
    );
  const regions = voiceScrollRegions();
  if (regions.length > 1)
    for (const region of regions.slice(0, 8))
      add(
        "g",
        { kind: "region", id: region.id, name: short(region.name) },
        `Scrollable region: ${short(region.name)}`,
      );
  const rooms = byFocus(
    conversations(context, openableRooms),
    (room) => room.name,
    terms,
  );
  for (const room of rooms.slice(0, pageTargetLimits.rooms))
    add(
      "r",
      { kind: "room", room: room.id, name: short(room.name) },
      `Room: ${short(room.name)}`,
    );
  return lines.join("\n");
}

/**
 * How long a click by name waits for its target after a previous step, and
 * the longest a step waits for a route change it started to finish loading.
 */
export const pageSettle = { waitMs: 1_200, stepMs: 150, navigationMs: 4_000 };

export interface PageActionResult {
  status: string;
  detail?: string;
}

const done: PageActionResult = {
  status: "done",
  detail:
    "Done on the page. Tell the user the result briefly, in the first person.",
};
const noEffect = (detail: string): PageActionResult => ({
  status: "no_effect",
  detail: `${detail} Tell the user truthfully that it did not work; never say it was done.`,
});
/** A spoken name that fits several targets: never guess one of them. */
const ambiguous = (options: VoiceCommandOption[]): PageActionResult => ({
  status: "ambiguous",
  detail: `Several match: ${options
    .slice(0, 5)
    .map((option) => `"${label(option).slice(0, pageTargetLimits.nameChars)}"`)
    .join(
      ", ",
    )}. Ask the user which one they mean, or call read_page and click by its id; never pick one yourself.`,
});
const notFound = (name: string): PageActionResult => ({
  status: "not_found",
  detail: `"${name}" is neither on screen nor in the room list. Tell the user truthfully it was not found; never pretend it was done.`,
});

const frame = () =>
  new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
const pause = () =>
  new Promise((resolve) => setTimeout(resolve, pageSettle.stepMs));

/** A region still loading its content, marked the accessible way. */
const pageLoading = () =>
  Array.from(document.querySelectorAll('[aria-busy="true"]')).some(
    // A busy button is a background action, not missing page content.
    (element) => !(element instanceof HTMLButtonElement),
  );

/**
 * Lets a route change or rerender land before a step reads the page. A lazy
 * route commits its URL only once its code has loaded, and the new page may
 * then still load its list, so a step waits while the app is navigating or a
 * region is aria-busy; a fixed pause reported such clicks as "nothing there"
 * and the model went looking elsewhere.
 */
async function settle() {
  await frame();
  await pause();
  await pageReady();
}

/** Waits, up to a cap, until no route change or aria-busy region is pending. */
export async function pageReady() {
  for (
    let waited = 0;
    (voiceNavigating() || pageLoading()) && waited < pageSettle.navigationMs;
    waited += Math.max(pageSettle.stepMs, 1)
  )
    await pause();
  await frame();
}

/** A room id, or a room's page path as create_room returns it. */
const roomTarget =
  /^(?:\/t\/[^/]+\/rooms\/)?(room_[A-Za-z0-9_-]{1,128})(?:\/chat)?$/;

/** A Document id, as search_documents and task results give it. */
const documentTarget = /^document_[A-Za-z0-9_-]{1,128}$/;

/**
 * Opens a Document beside the chat when the Room on screen has it, and
 * otherwise in the Library, whose list shows where it is kept. Its page still
 * checks access. The result names the file, so a wrong id is caught before the
 * user is told it is open.
 */
async function openDocument(
  context: VoiceCommandContext,
  documentId: string,
): Promise<PageActionResult> {
  const options = documentQueryOptions(
    context.client,
    context.tenantId,
    documentId,
  );
  const document = await (context.queryClient ?? new QueryClient())
    .fetchQuery(options)
    .catch(() => undefined);
  if (!document)
    return {
      status: "not_found",
      detail: `No file the user can open has id ${documentId}. Search for it with the user's words and open one from the results; never guess an id.`,
    };
  const check = `If that is not the file the user asked for, search_documents with their words and open the right one before saying anything; otherwise tell them briefly you opened it.`;
  if (await voiceOpenRoomDocument(documentId)) {
    await settle();
    return {
      status: "done",
      detail: `Opened "${document.title}" beside the chat in this room. ${check}`,
    };
  }
  const path = `/t/${context.tenantId}/documents/${documentId}`;
  if (!voiceNavigate(path))
    return noEffect("The page cannot open documents right now.");
  await settle();
  return window.location.pathname === path
    ? arrived(
        `This room does not have it, so "${document.title}" opened in the Library. ${check}`,
      )
    : noEffect("The document did not open.");
}

const roomPath = (context: VoiceCommandContext, roomId: string) =>
  `/t/${context.tenantId}/rooms/${roomId}/chat`;

async function openRoom(
  context: VoiceCommandContext,
  roomId: string,
): Promise<PageActionResult> {
  const path = roomPath(context, roomId);
  if (window.location.pathname === path)
    return {
      status: "done",
      detail:
        "This room is already open. Just tell the user they are already here.",
    };
  if (!voiceNavigate(path))
    return noEffect("The page cannot switch rooms right now.");
  await settle();
  return window.location.pathname === path
    ? arrived("The room is open.")
    : noEffect("The room did not open.");
}

/** A navigation result naming the page now on screen, so the model reports where it really is. */
function arrived(detail: string): PageActionResult {
  return {
    status: "done",
    detail: `${detail} The page now on screen:\n${voicePageState().text}\nTell the user where they are now based on this.`,
  };
}

export async function runPageAction(
  request: {
    action?: unknown;
    target?: unknown;
    text?: unknown;
    mode?: unknown;
    confirmed?: unknown;
  },
  context: VoiceCommandContext,
  active: () => boolean = () => true,
): Promise<PageActionResult> {
  if (!active()) return noEffect("The Live session ended.");
  const action = typeof request.action === "string" ? request.action : "";
  const target =
    typeof request.target === "string" ? request.target.trim() : "";
  const text = typeof request.text === "string" ? request.text.trim() : "";
  const confirmed =
    request.confirmed === true ||
    (typeof request.confirmed === "string" &&
      request.confirmed.toLowerCase() === "true");
  const ref = listed.get(target);
  // A room named by its id or path, such as one the call just created and
  // the room list does not show yet, opens directly; its page still checks
  // access.
  const roomId =
    action === "open_room" ? roomTarget.exec(target)?.[1] : undefined;
  if (roomId) return openRoom(context, roomId);

  switch (action) {
    case "scroll": {
      const direction = scrollDirections.includes(target)
        ? (target as VoiceScrollDirection)
        : "down";
      const region =
        ref?.kind === "region"
          ? ref.id
          : text
            ? matchPageOption(voiceScrollRegions(), text)?.id
            : undefined;
      return voiceScroll(direction, region)
        ? done
        : noEffect(
            "Already at the end in that direction, or nothing here can scroll.",
          );
    }
    case "back": {
      const before = window.location.href;
      if (!voiceBack()) return noEffect("There is no previous page here.");
      await settle();
      return window.location.href === before
        ? noEffect("The page did not go back.")
        : done;
    }
    case "close":
      return voiceClose()
        ? (await settle(), done)
        : noEffect("No open dialog, panel or search to close.");
    case "return_room":
      return openRoom(context, context.roomId);
    case "search": {
      const query = text || target;
      if (!voiceSearch(query)) return noEffect("Search cannot be opened here.");
      await settle();
      return {
        status: "done",
        detail: query
          ? `Searched the page for "${query}". Call read_page when you need the results; their ids start with s.`
          : "Opened the search box.",
      };
    }
    case "open_document":
      return documentTarget.test(target)
        ? openDocument(context, target)
        : {
            status: "failed",
            detail:
              "target must be a document_id from search_documents or a message.",
          };
    case "open_result": {
      const result =
        ref?.kind === "result"
          ? ref
          : matchPageOption(voiceSearchResults(), target);
      if (!result) return notFound(target);
      return (await voiceOpenResult(result.id))
        ? (await settle(), done)
        : noEffect("That search result is no longer there.");
    }
    case "jump_section": {
      const sections = sectionOptions();
      const section = matchPageOption(
        sections,
        ref?.kind === "section" ? ref.name : target,
      );
      const heading = section ? offeredSection(section.id) : undefined;
      if (!heading) return notFound(target);
      heading.scrollIntoView({ behavior: "smooth", block: "start" });
      return done;
    }
    case "voice_window": {
      if (!windowActions.includes(target))
        return {
          status: "failed",
          detail:
            "target must be mute/unmute/expand/shrink/move_left/move_right.",
        };
      return voiceWindowAction(target as VoiceWindowAction)
        ? done
        : noEffect(
            "The voice window is not on the page now (it cannot be controlled this way in picture-in-picture).",
          );
    }
    case "react": {
      const reaction = matchPageOption(reactions, target);
      if (!reaction)
        return {
          status: "failed",
          detail: `Only these reactions are available: ${reactions.map((item) => item.id).join(", ")}.`,
        };
      const message = latestOtherMessage(context);
      if (!message)
        return noEffect(
          "There is no message from someone else here to react to.",
        );
      try {
        await teamHubDone(
          context.client.api.PUT(
            "/v0/rooms/{roomId}/messages/{messageId}/reactions/{reactionId}",
            {
              params: {
                path: {
                  roomId: message.roomId,
                  messageId: message.message.id,
                  reactionId: reaction.id,
                },
              },
            },
          ),
        );
      } catch {
        return noEffect("The reaction was not added.");
      }
      return {
        status: "done",
        detail: `Added the reaction to the latest message from ${message.message.author.display_name}.`,
      };
    }
    case "type": {
      // Typing only fills the field; sending stays a separate, confirmed click.
      const fields = voiceTextFields();
      const options = fields.map((item, index) => ({
        id: `${index}`,
        name: item.name,
      }));
      const field =
        ref?.kind === "field"
          ? // A rerendered field is found again by the name it was listed with.
            (fields.find((item) => item.element === ref.element) ??
            fields.find((item) => item.name.startsWith(ref.name)))
          : ref
            ? undefined
            : target && !genericField.test(target)
              ? fields[Number(matchPageOption(options, target)?.id ?? -1)]
              : // "the input box" is the chat composer, or the only field.
                (fields.find((item) =>
                  item.name.startsWith(chatComposerName),
                ) ?? (fields.length === 1 ? fields[0] : undefined));
      if (!field)
        return {
          ...notFound(ref?.name ?? (target || "input field")),
          ...(fields.length > 1
            ? {
                detail: `There are several input fields: ${fields.map((item) => item.name).join(", ")}. Ask the user which one to fill, or use its t id from read_page.`,
              }
            : {}),
        };
      const mode = request.mode === "append" ? "append" : "replace";
      return voiceFill(
        field.element,
        typeof request.text === "string" ? request.text : "",
        mode,
      )
        ? {
            status: "done",
            detail: `Filled in "${field.name}"; nothing is sent or submitted yet. To send, ask the user first and click send only after they agree.`,
          }
        : noEffect("That input field cannot be filled right now.");
    }
    case "open_room":
    case "click":
      return clickOrOpen(action, target, ref, confirmed, context, active);
    default:
      return { status: "failed", detail: "unknown action" };
  }
}

async function clickOrOpen(
  action: "open_room" | "click",
  target: string,
  ref: Listed | undefined,
  confirmed: boolean,
  context: VoiceCommandContext,
  active: () => boolean,
): Promise<PageActionResult> {
  if (ref?.kind === "room") return openRoom(context, ref.room);
  if (ref?.kind === "result") {
    return (await voiceOpenResult(ref.id))
      ? (await settle(), done)
      : noEffect("That search result is no longer there.");
  }
  if (ref && ref.kind !== "element") return notFound(ref.name);
  const find = () => {
    const rooms = conversations(context, openableRooms);
    const roomMatches =
      !ref && action === "open_room" ? pageMatches(rooms, target) : [];
    const room = roomMatches.length === 1 ? roomMatches[0] : undefined;
    const options = roomMatches.length ? [] : liveElements();
    const elementMatches =
      ref || roomMatches.length ? [] : pageMatches(options, target);
    const element = roomMatches.length
      ? undefined
      : ref
        ? // A rerendered node is found again by the name it was listed with.
          (options.find(
            (option) => offeredVoiceElement(option.id) === ref.element,
          ) ??
          options.find(
            (option) =>
              label(option).slice(0, pageTargetLimits.nameChars) === ref.name,
          ))
        : elementMatches.length === 1
          ? elementMatches[0]
          : undefined;
    const several = roomMatches.length > 1 ? roomMatches : elementMatches;
    return { room, element, several: several.length > 1 ? several : [] };
  };
  let { room, element, several } = find();
  // In a chain ("open Pocket Notes, then click X") the previous step may
  // still be rendering: the target gets a short moment to appear.
  for (
    let waited = 0;
    !room &&
    !element &&
    !several.length &&
    action === "click" &&
    waited < pageSettle.waitMs;
    waited += pageSettle.stepMs
  ) {
    await new Promise((resolve) => setTimeout(resolve, pageSettle.stepMs));
    if (!active()) return noEffect("The Live session ended.");
    ({ room, element, several } = find());
  }
  if (several.length) return ambiguous(several);
  if (room) return openRoom(context, room.id);
  if (element) {
    const name = label(element);
    if (riskyTarget(name) && !confirmed)
      return {
        status: "needs_confirmation",
        detail: `"${name}" may not be undoable. First ask the user in the first person whether to click it (e.g. "Should I click ${name} for you?"), and call again with confirmed=true only after they clearly agree to this click; no answer or a different question is not agreement.`,
      };
    const before = window.location.href;
    const inPlace = voiceInPlaceState(element.id);
    if (!voiceClick(element.id))
      return noEffect("The thing to click is no longer on screen.");
    await settle();
    if (window.location.href !== before)
      return arrived(`Clicked "${name}" and the page changed.`);
    // Without leaving the page a click may still open, close or fold
    // something, which is the click working: clicking it again undoes it.
    const now = voiceInPlaceState(element.id);
    return {
      status: "done",
      detail:
        now.key !== inPlace.key
          ? `Clicked "${name}" and it changed on this page${now.name && now.name !== name ? `; the control now reads "${now.name}"` : ""}. Tell the user briefly it is done, and never click it again unless they ask: that would undo it. The page is still:\n${voicePageState().text}`
          : `Clicked "${name}"; the page, its panels and the control look the same:\n${voicePageState().text}\nSay you clicked it; if the user expected something to open or change, say it may not have and offer to check with read_page. Never click it again on your own. If they wanted another page, you are not there yet.`,
    };
  }
  // A click acts only on what is on screen: a name that is not there never
  // opens a chat room that merely shares a word with it.
  return notFound(ref?.name ?? target);
}
