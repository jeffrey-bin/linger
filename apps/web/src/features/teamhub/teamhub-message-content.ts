import type { TeamHubActorRef, TeamHubMessageSegment } from "./teamhub-types";
import { isRecord } from "@linger/service-kit";

const messageIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** A delivered Document shown as a card; a canvas is a card that also opens in the panel. */
export function isDocumentCardSegment(segment: TeamHubMessageSegment) {
  return (
    segment.type === "document" &&
    (segment.presentation === "card" || segment.presentation === "canvas")
  );
}
const maximumMessageLength = 50_000;
const maximumMessageSegments = 1_000;

export interface TeamHubMessageFileReference {
  documentId: string;
  documentVersionId: string;
  filename: string;
}

export interface TeamHubMessageDocumentReference {
  documentId: string;
  token: string;
}

export interface TeamHubMessageSkillReference {
  manifestVersion: string;
  skillId: string;
  target: string;
  token: string;
}

export interface TeamHubStructuredMessageContent {
  raw_message: string;
  segments: TeamHubMessageSegment[];
}

export function createTeamHubMessageContent({
  files,
  mentions,
  documentReferences = [],
  skillReferences = [],
  text,
}: {
  files: TeamHubMessageFileReference[];
  mentions: TeamHubActorRef[];
  documentReferences?: TeamHubMessageDocumentReference[];
  skillReferences?: TeamHubMessageSkillReference[];
  text: string;
}): TeamHubStructuredMessageContent {
  const segments = textSegments(
    text,
    mentions,
    documentReferences,
    skillReferences,
  );

  for (const file of files) {
    if (segments.length) {
      segments.push({ content: "\n", type: "text" });
    }
    segments.push({
      content: file.filename,
      document_id: file.documentId,
      presentation: "card",
      type: "document",
    });
  }

  const rawMessage = segments.map((segment) => segment.content).join("");
  if (!isTeamHubMessageContent(rawMessage, segments)) {
    throw new Error("TeamHub Message content is invalid.");
  }
  return { raw_message: rawMessage, segments };
}

export function isTeamHubMessageContent(
  rawMessage: unknown,
  segments: unknown,
): segments is TeamHubMessageSegment[] {
  if (
    typeof rawMessage !== "string" ||
    rawMessage.length === 0 ||
    rawMessage.length > maximumMessageLength ||
    !Array.isArray(segments) ||
    segments.length === 0 ||
    segments.length > maximumMessageSegments
  ) {
    return false;
  }

  let reconstructed = "";
  for (const segment of segments) {
    if (!isTeamHubMessageSegment(segment)) {
      return false;
    }
    reconstructed += segment.content;
    if (reconstructed.length > maximumMessageLength) {
      return false;
    }
  }
  return reconstructed === rawMessage;
}

export function referencedMessageActors(
  segments: TeamHubMessageSegment[],
  actors: TeamHubActorRef[],
) {
  const actorsById = new Map(actors.map((actor) => [actor.id, actor]));
  const referenced: TeamHubActorRef[] = [];
  const seen = new Set<string>();

  for (const segment of segments) {
    if (segment.type !== "reference" || seen.has(segment.target)) {
      continue;
    }
    const actor = actorsById.get(segment.target);
    const expectedTargetType = actor?.kind === "human" ? "user" : "agent";
    if (actor && segment.target_type === expectedTargetType) {
      referenced.push(actor);
      seen.add(actor.id);
    }
  }
  return referenced;
}

export function formatTeamHubMentionToken(actor: TeamHubActorRef) {
  const name = actor.display_name.trim().replace(/^@+/, "");
  return `@${name.replace(/\s+/g, " ")}`;
}

export function teamHubMentionTokenAliases(actor: TeamHubActorRef) {
  const token = formatTeamHubMentionToken(actor);
  const legacyToken = token.replace(/\s+/g, "_");
  return token === legacyToken ? [token] : [token, legacyToken];
}

export function findTeamHubMessageTokenMatches(
  text: string,
  tokens: Iterable<string>,
) {
  const candidates = [...new Set(tokens)]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  if (!text || candidates.length === 0) {
    return [];
  }
  const matcher = new RegExp(
    `(?<![\\p{L}\\p{N}_@/])(?:${candidates.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}_-])`,
    "gu",
  );
  return [...text.matchAll(matcher)].map((match) => ({
    index: match.index,
    token: match[0],
  }));
}

function textSegments(
  text: string,
  mentions: TeamHubActorRef[],
  documentReferences: TeamHubMessageDocumentReference[],
  skillReferences: TeamHubMessageSkillReference[],
) {
  const segmentsByToken = new Map<string, TeamHubMessageSegment>();
  const skillSegmentsByToken = new Map<string, TeamHubMessageSegment[]>();
  for (const actor of mentions) {
    for (const token of teamHubMentionTokenAliases(actor)) {
      const existing = segmentsByToken.get(token);
      if (
        existing?.type === "reference" &&
        (existing.target !== actor.id ||
          existing.target_type !== (actor.kind === "human" ? "user" : "agent"))
      ) {
        throw new Error(`Mention token ${token} matches more than one Actor.`);
      }
      registerToken(segmentsByToken, token, {
        content: token,
        target: actor.id,
        target_type: actor.kind === "human" ? "user" : "agent",
        type: "reference",
      });
    }
  }
  for (const document of documentReferences) {
    registerToken(segmentsByToken, document.token, {
      content: document.token,
      document_id: document.documentId,
      presentation: "inline",
      type: "document",
    });
  }
  for (const skill of skillReferences) {
    const segment = {
      content: skill.token,
      manifest_version: skill.manifestVersion,
      skill_id: skill.skillId,
      target: skill.target,
      type: "skill" as const,
    };
    const queued = skillSegmentsByToken.get(skill.token) ?? [];
    queued.push(segment);
    skillSegmentsByToken.set(skill.token, queued);
  }
  const tokens = [
    ...new Set([...segmentsByToken.keys(), ...skillSegmentsByToken.keys()]),
  ].sort((left, right) => right.length - left.length);
  if (!tokens.length || !text) {
    return text ? [{ content: text, type: "text" as const }] : [];
  }

  const matcher = new RegExp(
    `(?:${tokens.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}_-])`,
    "gu",
  );
  const segments: TeamHubMessageSegment[] = [];
  let cursor = 0;

  for (const match of text.matchAll(matcher)) {
    const index = match.index;
    const token = match[0];
    const queuedSkills = skillSegmentsByToken.get(token);
    const structuredSegment =
      segmentsByToken.get(token) ?? queuedSkills?.shift();
    if (!structuredSegment) {
      continue;
    }
    if (index > cursor) {
      segments.push({ content: text.slice(cursor, index), type: "text" });
    }
    segments.push(structuredSegment);
    if (
      structuredSegment.type === "file" ||
      structuredSegment.type === "document"
    ) {
      segmentsByToken.delete(token);
    }
    if (queuedSkills && queuedSkills.length === 0) {
      skillSegmentsByToken.delete(token);
    }
    cursor = index + token.length;
  }
  if (cursor < text.length) {
    segments.push({ content: text.slice(cursor), type: "text" });
  }
  return segments.length ? segments : [{ content: text, type: "text" }];
}

function registerToken(
  segmentsByToken: Map<string, TeamHubMessageSegment>,
  token: string,
  segment: TeamHubMessageSegment,
) {
  const existing = segmentsByToken.get(token);
  if (existing && JSON.stringify(existing) !== JSON.stringify(segment)) {
    throw new Error(`Message token ${token} matches more than one reference.`);
  }
  segmentsByToken.set(token, segment);
}

function isTeamHubMessageSegment(
  value: unknown,
): value is TeamHubMessageSegment {
  if (!isRecord(value) || !validContent(value.content)) {
    return false;
  }
  switch (value.type) {
    case "text":
      return hasExactKeys(value, ["content", "type"]);
    case "reference":
      return (
        hasExactKeys(value, ["content", "target", "target_type", "type"]) &&
        typeof value.target === "string" &&
        messageIdPattern.test(value.target) &&
        (value.target_type === "user" || value.target_type === "agent")
      );
    case "file":
      return (
        hasExactKeys(value, [
          "content",
          "document_id",
          "document_version_id",
          "type",
        ]) &&
        typeof value.document_id === "string" &&
        messageIdPattern.test(value.document_id) &&
        typeof value.document_version_id === "string" &&
        messageIdPattern.test(value.document_version_id)
      );
    case "document":
      return (
        (hasExactKeys(value, ["content", "document_id", "type"]) ||
          hasExactKeys(value, [
            "content",
            "document_id",
            "presentation",
            "type",
          ])) &&
        typeof value.document_id === "string" &&
        messageIdPattern.test(value.document_id) &&
        (value.presentation === undefined ||
          value.presentation === "inline" ||
          value.presentation === "card" ||
          value.presentation === "canvas")
      );
    case "html_fragment":
      return (
        hasExactKeys(value, ["content", "html", "type"]) &&
        typeof value.content === "string" &&
        value.content.length <= 1024 &&
        typeof value.html === "string" &&
        value.html.trim() !== "" &&
        value.html.length <= 2_097_152
      );
    case "skill":
      return (
        hasExactKeys(value, [
          "content",
          "manifest_version",
          "skill_id",
          "target",
          "type",
        ]) &&
        typeof value.content === "string" &&
        /^\/\S+$/.test(value.content) &&
        typeof value.target === "string" &&
        messageIdPattern.test(value.target) &&
        typeof value.skill_id === "string" &&
        messageIdPattern.test(value.skill_id) &&
        typeof value.manifest_version === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(value.manifest_version)
      );
    default:
      return false;
  }
}

function validContent(value: unknown) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumMessageLength
  );
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]) {
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length) {
    return false;
  }

  const sortedExpected = expected.slice().sort();
  for (let index = 0; index < sortedExpected.length; index += 1) {
    if (sortedExpected[index] !== keys[index]) {
      return false;
    }
  }
  return true;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
