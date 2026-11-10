import type { TeamHubActorRef } from "@/features/teamhub/teamhub-types";
import {
  findTeamHubMessageTokenMatches,
  formatTeamHubMentionToken,
  teamHubMentionTokenAliases,
} from "@/features/teamhub/teamhub-message-content";

export interface MessageMentionQuery {
  end: number;
  query: string;
  start: number;
}

export function formatMentionToken(actor: TeamHubActorRef) {
  return formatTeamHubMentionToken(actor);
}

export function findMessageMentionQuery(
  body: string,
  cursor: number,
): MessageMentionQuery | null {
  const boundedCursor = Math.max(0, Math.min(cursor, body.length));
  const beforeCursor = body.slice(0, boundedCursor);
  const match = beforeCursor.match(/(^|\s)@([\p{L}\p{N}_-]*)$/u);

  if (!match) {
    return null;
  }

  const query = match[2] ?? "";
  return {
    end: boundedCursor,
    query,
    start: boundedCursor - query.length - 1,
  };
}

export function findMessageMentionCandidates(
  query: MessageMentionQuery | null,
  options: TeamHubActorRef[],
) {
  if (!query) {
    return [];
  }

  const normalizedQuery = query.query.toLocaleLowerCase();
  const matcher = new RegExp(escapeRegExp(normalizedQuery), "u");
  return options.filter((actor) => matcher.test(mentionSearchText(actor)));
}

export function replaceMessageMention(
  body: string,
  query: MessageMentionQuery,
  actor: TeamHubActorRef,
) {
  const suffix = body.slice(query.end);
  const separator = !suffix || !/^[\s.,!?;:()[\]{}]/.test(suffix) ? " " : "";
  const replacement = `${formatMentionToken(actor)}${separator}`;
  return {
    body: `${body.slice(0, query.start)}${replacement}${suffix}`,
    cursor: query.start + replacement.length,
  };
}

export function activeMessageMentions(
  body: string,
  mentions: TeamHubActorRef[],
) {
  const actorsByToken = new Map(
    mentions.flatMap((actor) =>
      teamHubMentionTokenAliases(actor).map((token) => [token, actor] as const),
    ),
  );
  const orderedActors: TeamHubActorRef[] = [];
  const seen = new Set<string>();

  for (const match of findTeamHubMessageTokenMatches(
    body,
    actorsByToken.keys(),
  )) {
    const actor = actorsByToken.get(match.token);
    if (!actor || seen.has(actor.id)) {
      continue;
    }
    orderedActors.push(actor);
    seen.add(actor.id);
  }

  return orderedActors;
}

function mentionSearchText(actor: TeamHubActorRef) {
  return formatMentionToken(actor).slice(1).toLocaleLowerCase();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
