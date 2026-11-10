import {
  findTeamHubMessageTokenMatches,
  teamHubMentionTokenAliases,
  type TeamHubMessageDocumentReference,
  type TeamHubMessageSkillReference,
} from "@/features/teamhub/teamhub-message-content";
import type { TeamHubActorRef } from "@/features/teamhub/teamhub-types";
import { parseInternalRoomDocumentLink } from "@/features/rooms/files/document-detail-routes";

import type { MessageMentionQuery } from "./message-mentions";

export interface MessageDocumentOption {
  documentId: string;
  requiresRoomBinding?: boolean;
  name: string;
  tenantId?: string;
  updatedAt: string;
}

export function parseInternalDocumentLink(value: string, origin: string) {
  return parseInternalRoomDocumentLink(value, origin);
}

export interface MessageSkillOption {
  agent: TeamHubActorRef;
  description?: string;
  manifestVersion: string;
  name: string;
  skillId: string;
}

export type MessageSkillQuery = MessageMentionQuery & {
  agent: TeamHubActorRef;
};

export function formatDocumentToken(
  document: MessageDocumentOption,
  options: MessageDocumentOption[] = [document],
) {
  return `@${uniqueTokenLabel({
    currentKey: document.documentId,
    fallback: "document",
    items: options,
    itemKey: (item) => item.documentId,
    itemName: (item) => item.name,
    separator: "_",
  })}`;
}

export function formatSkillToken(
  skill: MessageSkillOption,
  options: MessageSkillOption[] = [skill],
) {
  return `/${uniqueTokenLabel({
    currentKey: skillOptionKey(skill),
    fallback: "skill",
    items: options.filter((item) => item.agent.id === skill.agent.id),
    itemKey: skillOptionKey,
    itemName: (item) => item.name.toLocaleLowerCase(),
    separator: "-",
  })}`;
}

export function findMessageSkillQuery(
  body: string,
  cursor: number,
  mentions: TeamHubActorRef[],
): MessageSkillQuery | null {
  const boundedCursor = Math.max(0, Math.min(cursor, body.length));
  const beforeCursor = body.slice(0, boundedCursor);
  const match = beforeCursor.match(/(^|\s)\/([\p{L}\p{N}_-]*)$/u);
  if (!match) return null;
  const query = match[2] ?? "";
  const start = boundedCursor - query.length - 1;
  const agent = findNearestMentionedAgent(body.slice(0, start), mentions);
  if (!agent) return null;
  return {
    agent,
    end: boundedCursor,
    query,
    start,
  };
}

export function findDocumentCandidates(
  query: MessageMentionQuery | null,
  options: MessageDocumentOption[],
) {
  if (!query) return [];
  const normalized = query.query.toLocaleLowerCase();
  return options.filter((document) =>
    `${document.name} ${formatDocumentToken(document, options)}`
      .toLocaleLowerCase()
      .includes(normalized),
  );
}

export function findSkillCandidates(
  query: MessageSkillQuery | null,
  options: MessageSkillOption[],
) {
  if (!query) return [];
  const normalized = query.query.toLocaleLowerCase();
  return options.filter(
    (skill) =>
      skill.agent.id === query.agent.id &&
      `${skill.name} ${skill.skillId} ${formatSkillToken(skill, options)}`
        .toLocaleLowerCase()
        .includes(normalized),
  );
}

export function replaceComposerToken(
  body: string,
  query: MessageMentionQuery,
  token: string,
) {
  const suffix = body.slice(query.end);
  const separator = !suffix || !/^[\s.,!?;:()[\]{}]/.test(suffix) ? " " : "";
  const replacement = `${token}${separator}`;
  return {
    body: `${body.slice(0, query.start)}${replacement}${suffix}`,
    cursor: query.start + replacement.length,
  };
}

export function activeDocumentReferences<
  T extends TeamHubMessageDocumentReference,
>(body: string, references: T[]) {
  return activeTokenReferences(body, references);
}

export function activeSkillReferences(
  body: string,
  references: TeamHubMessageSkillReference[],
  mentions: TeamHubActorRef[],
) {
  const actorsByToken = new Map(
    mentions.flatMap((actor) =>
      teamHubMentionTokenAliases(actor).map((token) => [token, actor] as const),
    ),
  );
  const referencesByTargetAndToken = new Map(
    references.map((reference) => [
      skillReferenceKey(reference.target, reference.token),
      reference,
    ]),
  );
  const activeReferences: TeamHubMessageSkillReference[] = [];
  const seen = new Set<string>();
  let activeAgentId: string | null = null;
  const tokens = new Set([
    ...actorsByToken.keys(),
    ...references.map((reference) => reference.token),
  ]);

  for (const match of findTeamHubMessageTokenMatches(body, tokens)) {
    const actor = actorsByToken.get(match.token);
    if (actor) {
      activeAgentId = actor.kind === "agent" ? actor.id : null;
      continue;
    }
    if (!activeAgentId) continue;
    const key = skillReferenceKey(activeAgentId, match.token);
    const reference = referencesByTargetAndToken.get(key);
    if (!reference || seen.has(key)) continue;
    activeReferences.push(reference);
    seen.add(key);
  }
  return activeReferences;
}

function activeTokenReferences<T extends { token: string }>(
  body: string,
  references: T[],
) {
  const byToken = new Map(
    references.map((reference) => [reference.token, reference]),
  );
  const ordered: T[] = [];
  for (const match of body.matchAll(/\S+/gu)) {
    const token = trimTokenPunctuation(match[0]);
    const reference = byToken.get(token);
    if (!reference) continue;
    ordered.push(reference);
    byToken.delete(token);
  }
  return ordered;
}

function findNearestMentionedAgent(body: string, mentions: TeamHubActorRef[]) {
  const actorsByToken = new Map(
    mentions.flatMap((actor) =>
      teamHubMentionTokenAliases(actor).map((token) => [token, actor] as const),
    ),
  );
  let nearestActor: TeamHubActorRef | null = null;
  for (const match of findTeamHubMessageTokenMatches(
    body,
    actorsByToken.keys(),
  )) {
    const actor = actorsByToken.get(match.token);
    if (actor) nearestActor = actor;
  }
  return nearestActor?.kind === "agent" ? nearestActor : null;
}

function skillReferenceKey(target: string, token: string) {
  return `${target}\u0000${token}`;
}

function trimTokenPunctuation(token: string) {
  return token.replace(/[.,!?;:()[\]{}]+$/, "");
}

function normalizeTokenLabel(
  value: string,
  fallback: string,
  separator: "-" | "_",
) {
  const normalized = value
    .trim()
    .replace(/^[@/]+/, "")
    .replace(/\s+/g, separator)
    .replace(/[^\p{L}\p{N}_-]+/gu, separator)
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function uniqueTokenLabel<T>({
  currentKey,
  fallback,
  itemKey,
  itemName,
  items,
  separator,
}: {
  currentKey: string;
  fallback: string;
  itemKey: (item: T) => string;
  itemName: (item: T) => string;
  items: T[];
  separator: "-" | "_";
}) {
  const used = new Set<string>();
  const labelsByKey = new Map<string, string>();
  // The catalog and a freshly resolved link can describe the same Document.
  // Only distinct identities compete for a label; the latest metadata wins.
  const uniqueItems = new Map(items.map((item) => [itemKey(item), item]));
  const ordered = [...uniqueItems.values()].sort((left, right) =>
    compareTokenKeys(itemKey(left), itemKey(right)),
  );
  for (const item of ordered) {
    const base = normalizeTokenLabel(itemName(item), fallback, separator);
    let label = base;
    let suffix = 2;
    while (used.has(label)) {
      label = `${base}${separator}${suffix}`;
      suffix += 1;
    }
    used.add(label);
    labelsByKey.set(itemKey(item), label);
  }
  return labelsByKey.get(currentKey) ?? fallback;
}

function skillOptionKey(skill: MessageSkillOption) {
  return `${skill.skillId}\u0000${skill.manifestVersion}`;
}

function compareTokenKeys(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
