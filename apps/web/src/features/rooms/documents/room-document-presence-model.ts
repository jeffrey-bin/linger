import type { TeamHubRoomMember } from "@/features/teamhub/teamhub-types";

import type { RoomDocumentCollaborationSession } from "./room-document-collaboration";

export type RoomDocumentAwareness = NonNullable<
  RoomDocumentCollaborationSession["awareness"]
>;

export interface RoomDocumentParticipant {
  actorId: string;
  clientId: number;
  color: string;
  initials: string;
  isCurrent: boolean;
  name: string;
}

export interface CurrentPresenceActor {
  color: string;
  displayName: string;
  id: string;
}

export function listRoomDocumentParticipants({
  awareness,
  currentActor,
  members,
}: {
  awareness: RoomDocumentCollaborationSession["awareness"];
  currentActor: CurrentPresenceActor;
  members: readonly TeamHubRoomMember[] | undefined;
}): RoomDocumentParticipant[] {
  if (awareness === null) return [];

  const namesByActorId = new Map(
    members?.map((member) => [member.actor.id, member.actor.display_name]),
  );
  const remotes = new Map<string, RoomDocumentParticipant>();

  for (const [clientId, state] of awareness.getStates()) {
    if (clientId === awareness.clientID) continue;
    const user = readPresenceUser(state);
    if (user === null || user.actorId === currentActor.id) continue;
    const existing = remotes.get(user.actorId);
    if (existing !== undefined && existing.clientId < clientId) continue;

    const name = namesByActorId.get(user.actorId) ?? user.name ?? user.actorId;
    remotes.set(user.actorId, {
      actorId: user.actorId,
      clientId,
      color: user.color,
      initials: createInitials(name),
      isCurrent: false,
      name,
    });
  }

  if (remotes.size === 0) return [];

  return [
    {
      actorId: currentActor.id,
      clientId: awareness.clientID,
      color: currentActor.color,
      initials: createInitials(currentActor.displayName),
      isCurrent: true,
      name: currentActor.displayName,
    },
    ...[...remotes.values()].sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.clientId - right.clientId,
    ),
  ];
}

export function createRoomDocumentCursor(
  user: unknown,
  namesByActorId: ReadonlyMap<string, string>,
): HTMLElement {
  const presence = readPresenceUser({ user });
  const color = presence?.color ?? "#64748b";
  const actorId = presence?.actorId;
  const name =
    (actorId ? namesByActorId.get(actorId) : undefined) ??
    presence?.name ??
    actorId ??
    "Collaborator";
  const cursor = document.createElement("span");
  cursor.classList.add("bn-collaboration-cursor__base");
  cursor.setAttribute("data-active", "");
  if (actorId) cursor.setAttribute("data-actor-id", actorId);

  const caret = document.createElement("span");
  caret.classList.add("bn-collaboration-cursor__caret");
  caret.setAttribute("contenteditable", "false");
  caret.style.backgroundColor = color;
  caret.style.color = readableTextColor(color);

  const label = document.createElement("span");
  label.classList.add("bn-collaboration-cursor__label");
  label.setAttribute("aria-label", `${name} cursor`);
  label.setAttribute("data-collaborator-name", name);
  label.setAttribute("role", "img");
  label.style.backgroundColor = color;
  label.style.color = readableTextColor(color);
  caret.append(label);

  cursor.append(
    document.createTextNode("\u2060"),
    caret,
    document.createTextNode("\u2060"),
  );
  return cursor;
}

export function createRoomDocumentCursorRenderer(): {
  destroy(): void;
  renderCursor(user: unknown): HTMLElement;
  setNames(names: ReadonlyMap<string, string>): void;
} {
  const cursors = new Set<HTMLElement>();
  let namesByActorId: ReadonlyMap<string, string> = new Map();

  return {
    destroy() {
      cursors.clear();
    },
    renderCursor(user) {
      const cursor = createRoomDocumentCursor(user, namesByActorId);
      cursors.add(cursor);
      return cursor;
    },
    setNames(names) {
      namesByActorId = names;
      for (const cursor of cursors) {
        refreshRoomDocumentCursorName(cursor, names);
      }
    },
  };
}

export function refreshRoomDocumentCursorName(
  cursor: HTMLElement,
  namesByActorId: ReadonlyMap<string, string>,
): void {
  const actorId = cursor.dataset.actorId;
  const name = actorId ? namesByActorId.get(actorId) : undefined;
  const label = cursor.querySelector<HTMLElement>(
    ".bn-collaboration-cursor__label",
  );
  if (name === undefined || label === null) return;
  label.setAttribute("aria-label", `${name} cursor`);
  label.dataset.collaboratorName = name;
}

export function presenceIdentitySnapshot(
  awareness: RoomDocumentCollaborationSession["awareness"],
): string {
  if (awareness === null) return "";
  return [...awareness.getStates()]
    .map(([clientId, state]) => {
      const user = readPresenceUser(state);
      return user === null
        ? `${clientId}:invalid`
        : `${clientId}:${user.actorId}:${user.color}:${user.name ?? ""}`;
    })
    .sort()
    .join("|");
}

function readPresenceUser(state: unknown): {
  actorId: string;
  color: string;
  name?: string;
} | null {
  if (typeof state !== "object" || state === null || !("user" in state)) {
    return null;
  }
  const user = state.user;
  if (typeof user !== "object" || user === null) return null;
  const value = user as Record<string, unknown>;
  const actorId = typeof value.actorId === "string" ? value.actorId : value.id;
  if (
    typeof actorId !== "string" ||
    actorId.trim() === "" ||
    typeof value.color !== "string" ||
    !/^#[a-fA-F0-9]{6}$/.test(value.color)
  ) {
    return null;
  }
  return {
    actorId,
    color: value.color,
    ...(typeof value.name === "string" && value.name.trim() !== ""
      ? { name: value.name.trim() }
      : {}),
  };
}

function createInitials(name: string): string {
  const words = name
    .trim()
    .split(/[\s_-]+/u)
    .filter(Boolean);
  if (words.length === 0) return "?";
  return words
    .slice(0, 2)
    .map((word) => Array.from(word)[0])
    .join("")
    .toLocaleUpperCase();
}

export function readableTextColor(color: string): "#1a1a16" | "#ffffff" {
  const red = Number.parseInt(color.slice(1, 3), 16) / 255;
  const green = Number.parseInt(color.slice(3, 5), 16) / 255;
  const blue = Number.parseInt(color.slice(5, 7), 16) / 255;
  const linear = (channel: number) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  const luminance =
    0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
  return luminance > 0.179 ? "#1a1a16" : "#ffffff";
}

/** The color that marks an actor's cursor and presence in every Document. */
export function collaborationColor(identity: string): string {
  const colors = [
    "#698cc7",
    "#a17cb9",
    "#b88022",
    "#4e9ba2",
    "#df5583",
    "#d95b31",
  ];
  const hash = Array.from(identity).reduce(
    (current, character) => (current * 31 + character.charCodeAt(0)) >>> 0,
    0,
  );
  return colors[hash % colors.length]!;
}
