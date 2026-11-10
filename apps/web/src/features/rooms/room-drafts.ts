import type {
  TeamHubMessageDocumentReference,
  TeamHubMessageSkillReference,
} from "@/features/teamhub/teamhub-message-content";
import type { TeamHubActorRef } from "@/features/teamhub/teamhub-types";
import { isRecord } from "@linger/service-kit";

const roomComposerDraftPrefix = "linger.room-composer-draft:";
const composerDraftFormat = "linger-composer-draft-v3";

export interface RoomDraftScope {
  accountId: string;
  roomId: string;
  tenantId: string;
  threadId?: string;
}

export interface RoomComposerDraft {
  voiceMaterials?: VoiceDocumentSelection[];
  documentContexts: RoomComposerDocumentContext[];
  body: string;
  documentReferences: RoomComposerDocumentReference[];
  mentions: TeamHubActorRef[];
  skillReferences: TeamHubMessageSkillReference[];
}

/** An explicitly selected excerpt, not a verified Document anchor or read pin.
 * It comes from exactly one source: a Document (`documentId`) or a Message in
 * the same Room (`messageId`, with the author's name as `title`). A Document
 * material with an empty `quote` stands for the whole file. */
export interface VoiceDocumentSelection {
  id: string;
  documentId?: string;
  messageId?: string;
  title: string;
  quote: string;
  versionId?: string;
}

export interface RoomComposerDocumentContext {
  documentId: string;
  documentVersionId: string;
  filename: string;
  sourceRoomId: string;
  sourceRoomName: string;
  versionNumber: number;
}

export type RoomComposerDocumentReference =
  TeamHubMessageDocumentReference & {};

const draftListeners = new Set<() => void>();

/** Calls `listener` after any Room composer draft in this tab changes. */
export function subscribeRoomComposerDrafts(listener: () => void) {
  draftListeners.add(listener);
  return () => {
    draftListeners.delete(listener);
  };
}

function notifyDraftListeners() {
  for (const listener of draftListeners) listener();
}

export function readRoomComposerDraft(
  scope: RoomDraftScope,
): RoomComposerDraft {
  try {
    const stored = resolveLocalStorage()?.getItem(roomComposerDraftKey(scope));
    return stored ? parseComposerDraft(stored) : emptyComposerDraft();
  } catch {
    return emptyComposerDraft();
  }
}

export function writeRoomComposerDraft(
  scope: RoomDraftScope,
  draft: RoomComposerDraft,
) {
  try {
    const storage = resolveLocalStorage();
    if (
      !draft.body &&
      draft.documentContexts.length === 0 &&
      !draft.voiceMaterials?.length
    ) {
      storage?.removeItem(roomComposerDraftKey(scope));
    } else {
      storage?.setItem(
        roomComposerDraftKey(scope),
        JSON.stringify({ ...draft, format: composerDraftFormat }),
      );
    }
  } catch {
    // The composer remains usable in memory when browser storage is unavailable.
  }
  notifyDraftListeners();
}

export function clearRoomDrafts() {
  try {
    const storage = resolveLocalStorage();

    if (!storage) {
      return;
    }

    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);

      if (key?.startsWith(roomComposerDraftPrefix)) {
        storage.removeItem(key);
      }
    }
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
  notifyDraftListeners();
}

function roomComposerDraftKey(scope: RoomDraftScope) {
  const segments = [scope.accountId, scope.tenantId, scope.roomId];

  if (scope.threadId) {
    segments.push(scope.threadId);
  }

  return `${roomComposerDraftPrefix}${segments.map(encodeURIComponent).join(":")}`;
}

function resolveLocalStorage() {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

function parseComposerDraft(stored: string): RoomComposerDraft {
  try {
    const candidate: unknown = JSON.parse(stored);
    if (!isRecord(candidate) || candidate.format !== composerDraftFormat) {
      return emptyComposerDraft();
    }
    return {
      ...(Array.isArray(candidate.voiceMaterials)
        ? {
            voiceMaterials: candidate.voiceMaterials
              .filter(isVoiceDocumentSelection)
              .slice(0, 5),
          }
        : {}),
      documentContexts: Array.isArray(candidate.documentContexts)
        ? candidate.documentContexts.filter(isDocumentContext)
        : [],
      body: typeof candidate.body === "string" ? candidate.body : "",
      documentReferences: Array.isArray(candidate.documentReferences)
        ? candidate.documentReferences.filter(isDocumentReference)
        : [],
      mentions: Array.isArray(candidate.mentions)
        ? candidate.mentions.filter(isActorReference)
        : [],
      skillReferences: Array.isArray(candidate.skillReferences)
        ? candidate.skillReferences.filter(isSkillReference)
        : [],
    };
  } catch {
    return emptyComposerDraft();
  }
}

export function isVoiceDocumentSelection(
  value: unknown,
): value is VoiceDocumentSelection {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id.length <= 128 &&
    (typeof value.documentId === "string"
      ? /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.documentId) &&
        value.messageId === undefined
      : value.documentId === undefined &&
        typeof value.messageId === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.messageId) &&
        value.versionId === undefined) &&
    typeof value.title === "string" &&
    value.title.trim().length > 0 &&
    value.title.length <= 512 &&
    typeof value.quote === "string" &&
    (value.quote.trim().length > 0 || typeof value.documentId === "string") &&
    value.quote.length <= 10_000 &&
    (value.versionId === undefined ||
      (typeof value.versionId === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.versionId)))
  );
}

function emptyComposerDraft(): RoomComposerDraft {
  return {
    documentContexts: [],
    body: "",
    documentReferences: [],
    mentions: [],
    skillReferences: [],
  };
}

function isDocumentContext(
  value: unknown,
): value is RoomComposerDocumentContext {
  return (
    isRecord(value) &&
    typeof value.documentId === "string" &&
    typeof value.documentVersionId === "string" &&
    typeof value.filename === "string" &&
    typeof value.sourceRoomId === "string" &&
    typeof value.sourceRoomName === "string" &&
    Number.isSafeInteger(value.versionNumber) &&
    (value.versionNumber as number) > 0
  );
}

function isActorReference(value: unknown): value is TeamHubActorRef {
  return (
    isRecord(value) &&
    typeof value.display_name === "string" &&
    typeof value.id === "string" &&
    (value.kind === "agent" || value.kind === "human") &&
    typeof value.tenant_id === "string"
  );
}

function isDocumentReference(
  value: unknown,
): value is RoomComposerDocumentReference {
  return (
    isRecord(value) &&
    typeof value.documentId === "string" &&
    typeof value.token === "string"
  );
}

function isSkillReference(
  value: unknown,
): value is TeamHubMessageSkillReference {
  return (
    isRecord(value) &&
    typeof value.manifestVersion === "string" &&
    typeof value.skillId === "string" &&
    typeof value.target === "string" &&
    typeof value.token === "string"
  );
}
