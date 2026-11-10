// The Human's memory.md: TeamHub stores each version; Memory is its only
// writer, from Profile revisions and nightly dreaming (no daytime writes).
import fs from "node:fs/promises";
import path from "node:path";
import type postgres from "postgres";
import { isRecord } from "@linger/service-kit";
import { ModelCallError } from "../runtime-model-call.js";
import { requestMemoryStructuredOutput } from "./llm.js";
import { promptRoot } from "./paths.js";

// Each section has a separate budget so hobbies cannot crowd out an introduction.
export const USER_MEMORY_SECTIONS = [
  { key: "profile", title: "Profile" },
  { key: "career", title: "Career" },
  { key: "interests", title: "Interests" },
  {
    key: "communication_and_working_style",
    title: "Communication & Working Style",
  },
  { key: "milestones", title: "Milestones" },
] as const;
export type UserMemorySectionKey = (typeof USER_MEMORY_SECTIONS)[number]["key"];
export interface UserMemoryEntry {
  text: string;
  /** The day the entry was last added or rewritten. */
  date: string;
}
export type UserMemorySections = Record<
  UserMemorySectionKey,
  UserMemoryEntry[]
>;
export type UserMemoryCadence = "profile" | "daily" | "weekly";
export interface UserMemoryEdit {
  op: "add" | "replace" | "delete";
  section: UserMemorySectionKey;
  old: string | string[];
  text: string;
  source_ref: string;
  /** The Human's words in the cited Session; empty for other evidence. */
  quote: string;
}
/** One piece of evidence the model may cite by `ref`. */
export interface UserMemoryEvidence {
  ref: string;
  kind: "profile" | "session" | "daily" | "weekly";
  content: string;
  /** Where it came from, kept in the version record. */
  source?: string;
}

/** Bytes of the rendered file, which goes into every AnotherMe prompt. */
export const USER_MEMORY_CAPACITY = {
  target_bytes: 4_000,
  max_bytes: 5_000,
} as const;
/** The most entries a section holds; a full section merges or drops one
 * before it takes another. */
export const USER_MEMORY_SECTION_LIMITS: Record<UserMemorySectionKey, number> =
  {
    profile: 6,
    communication_and_working_style: 8,
    career: 5,
    interests: 6,
    milestones: 8,
  };
const MAX_ENTRY_CHARS = 200;
const MAX_EDITS = 120;

/** A Daily or Weekly report as evidence: its body without frontmatter. */
export function reportEvidence(markdown: string): string {
  return markdown.replace(/^---\n[\s\S]*?\n---\n/u, "").trim();
}

export function emptyUserMemory(): UserMemorySections {
  return {
    profile: [],
    communication_and_working_style: [],
    career: [],
    interests: [],
    milestones: [],
  };
}

/** Start a new portrait with the owner's display name. The writer can expand
 * it into an introduction or honor a correction/forget request. Never reseed
 * an existing revision, even when its Profile has since been cleared. */
export function initialUserMemory(
  human: string,
  ownerActorId: string,
  date: string,
): UserMemorySections {
  const sections = emptyUserMemory();
  const name = human.trim().replace(/\s+/gu, " ");
  if (
    name &&
    name !== ownerActorId &&
    !/^(?:user|human)$/iu.test(name) &&
    [...name].length <= MAX_ENTRY_CHARS
  )
    sections.profile.push({ text: name, date });
  return sections;
}

export function renderUserMemory(sections: UserMemorySections): string {
  return `# Memory\n\n${USER_MEMORY_SECTIONS.map(
    ({ key, title }) =>
      `## ${title}\n${
        sections[key].map((e) => `- ${e.text} [${e.date}]`).join("\n") ||
        "None recorded."
      }`,
  ).join("\n\n")}\n`;
}
export function userMemoryBytes(sections: UserMemorySections): number {
  return Buffer.byteLength(renderUserMemory(sections), "utf8");
}
/** The size the model is told, and whether this update must also shrink the
 * file: it is over the target bytes or a section is over its limit. */
export function userMemoryCapacity(sections: UserMemorySections) {
  const bytes = userMemoryBytes(sections);
  return {
    capacity: {
      ...USER_MEMORY_CAPACITY,
      current_bytes: bytes,
      section_limits: USER_MEMORY_SECTION_LIMITS,
    },
    compact:
      bytes > USER_MEMORY_CAPACITY.target_bytes ||
      USER_MEMORY_SECTIONS.some(
        ({ key }) => sections[key].length > USER_MEMORY_SECTION_LIMITS[key],
      ),
  };
}

/** The edits one memory.md update answers with, citing these refs. */
export function userMemoryEditSchema(refs: readonly string[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["edits", "change_note"],
    properties: {
      edits: {
        type: "array",
        maxItems: MAX_EDITS,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["op", "section", "old", "text", "source_ref", "quote"],
          properties: {
            op: { type: "string", enum: ["add", "replace", "delete"] },
            section: {
              type: "string",
              enum: USER_MEMORY_SECTIONS.map(({ key }) => key),
            },
            old: {
              anyOf: [
                { type: "string" },
                {
                  type: "array",
                  items: { type: "string" },
                  minItems: 2,
                  maxItems: USER_MEMORY_SECTION_LIMITS.milestones,
                },
              ],
            },
            text: { type: "string" },
            source_ref: { type: "string", enum: [...refs, "memory"] },
            quote: { type: "string", maxLength: 300 },
          },
        },
      },
      change_note: { type: "string", maxLength: 1000 },
    },
  } as const;
}

const sectionKeys = new Set<string>(USER_MEMORY_SECTIONS.map(({ key }) => key));
/** Entries are English, like the Profile; a name may keep its own script. */
const mostlyCjk = (text: string) =>
  (text.match(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
  )?.length ?? 0) >
  0.3 * (text.match(/\p{L}/gu)?.length ?? 0);
const bracketDate = /\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*$/u;
const quoteText = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]/gu, "");
/** Whether a quote appears in its Session, ignoring case, spacing and
 * punctuation; an ellipsis may join pieces that appear in that order. */
export function quotedIn(quote: string, content: string): boolean {
  const pieces = quote
    .split(/\.{3}|…/u)
    .map(quoteText)
    .filter(Boolean);
  if (pieces.join("").length < 4) return false;
  const haystack = quoteText(content);
  let from = 0;
  for (const piece of pieces) {
    const at = haystack.indexOf(piece, from);
    if (at < 0) return false;
    from = at + piece.length;
  }
  return true;
}

/** Applies edits in order; any edit that does not fit rejects the whole
 * answer, unless `skipInvalid` (the last attempt) drops just that edit.
 * Entries no edit names stay byte-for-byte unchanged. An edit drawn from a
 * Session whose quote is not found there is dropped alone: it has no
 * evidence, but the rest of the answer does. Milestones keep the most recent
 * events: past their limit the oldest go. */
export function applyUserMemoryEdits(
  current: UserMemorySections,
  edits: readonly UserMemoryEdit[],
  date: string,
  evidence: readonly UserMemoryEvidence[],
  skipInvalid = false,
): { sections: UserMemorySections; applied: UserMemoryEdit[] } {
  let next = cloneSections(current);
  const byRef = new Map(evidence.map((e) => [e.ref, e]));
  const applied: UserMemoryEdit[] = [];
  /** Applies one edit to `sections`; false when its quote is not found. */
  const apply = (
    sections: UserMemorySections,
    edit: UserMemoryEdit,
    where: string,
  ): boolean => {
    if (!sectionKeys.has(edit.section))
      throw new Error(`${where}: unknown section ${edit.section}`);
    const source = byRef.get(edit.source_ref);
    if (!source && edit.source_ref !== "memory")
      throw new Error(`${where}: unknown source_ref ${edit.source_ref}`);
    if (source?.kind === "session" && !quotedIn(edit.quote, source.content))
      return false;
    // The named section is a hint: an exact entry elsewhere is moved.
    let found: ReturnType<typeof findEntry> | undefined;
    if (Array.isArray(edit.old)) {
      if (
        edit.section !== "milestones" ||
        edit.op !== "replace" ||
        edit.old.length < 2
      )
        throw new Error(
          `${where}: use an array only to replace multiple milestones`,
        );
      // This edit works on a private candidate. A missing source or invalid
      // replacement leaves every original milestone in place.
      for (const old of edit.old) {
        const at = sections.milestones.findIndex((entry) => entry.text === old);
        if (at < 0)
          throw new Error(`${where}: no matching milestone for "${old}"`);
        sections.milestones.splice(at, 1);
      }
    } else if (edit.op !== "add") {
      found = findEntry(sections, edit.section, edit.old, where);
      sections[found.section].splice(found.position, 1);
    }
    if (edit.op === "add" || edit.op === "replace") {
      const text = edit.text.trim();
      if (!text || /[\r\n]/u.test(text) || [...text].length > MAX_ENTRY_CHARS)
        throw new Error(
          `${where}: text must be one line of 1-${MAX_ENTRY_CHARS} characters`,
        );
      if (edit.section === "milestones" && !eventDatePrefix.test(text))
        throw new Error(
          `${where}: start a milestone with its event date (YYYY-MM or YYYY-MM-DD); omit an undatable event`,
        );
      if (bracketDate.test(text))
        throw new Error(`${where}: do not write a bracketed date`);
      if (mostlyCjk(text))
        throw new Error(
          `${where}: write the entry in English; only names keep their own script`,
        );
      const entries = sections[edit.section];
      if (entries.some((e) => e.text === text))
        throw new Error(
          `${where}: "${text}" already exists in ${edit.section}`,
        );
      const entry = { text, date };
      if (found?.section === edit.section)
        entries.splice(found.position, 0, entry);
      else entries.push(entry);
    } else if (edit.op !== "delete") throw new Error(`${where}: unknown op`);
    return true;
  };
  const applyEdits = (enforceSectionLimits: boolean) =>
    edits.forEach((edit, index) => {
      const candidate = cloneSections(next);
      try {
        if (!apply(candidate, edit, `edit ${index + 1}`)) return;
        if (
          enforceSectionLimits &&
          edit.section !== "milestones" &&
          candidate[edit.section].length >
            Math.max(
              next[edit.section].length,
              USER_MEMORY_SECTION_LIMITS[edit.section],
            )
        )
          return;
      } catch (error) {
        if (skipInvalid) return;
        throw error;
      }
      next = candidate;
      applied.push(edit);
    });
  applyEdits(false);
  // A corrected batch may still overfill one section. Only in that case
  // replay it with admission per edit, preserving unrelated edits and moves.
  if (
    skipInvalid &&
    USER_MEMORY_SECTIONS.some(
      ({ key }) =>
        key !== "milestones" &&
        next[key].length >
          Math.max(current[key].length, USER_MEMORY_SECTION_LIMITS[key]),
    )
  ) {
    next = cloneSections(current);
    applied.length = 0;
    applyEdits(true);
  }
  keepRecentMilestones(next);
  for (const { key } of USER_MEMORY_SECTIONS) {
    const limit = USER_MEMORY_SECTION_LIMITS[key];
    // A section already over its limit (a lowered limit) may still shrink.
    if (next[key].length > limit && next[key].length > current[key].length)
      throw new Error(
        `${key} would hold ${next[key].length} entries, at most ${limit}: merge entries or delete the least useful`,
      );
  }
  const bytes = userMemoryBytes(next);
  if (bytes > USER_MEMORY_CAPACITY.max_bytes)
    throw new Error(
      `memory.md would be ${bytes} bytes, over ${USER_MEMORY_CAPACITY.max_bytes}`,
    );
  return { sections: next, applied };
}
const cloneSections = (sections: UserMemorySections) =>
  Object.fromEntries(
    USER_MEMORY_SECTIONS.map(({ key }) => [key, [...sections[key]]]),
  ) as UserMemorySections;
const eventDatePrefix =
  /^\d{4}-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?(?=[\s:,.–—]|$)/u;
const eventDate = (entry: UserMemoryEntry) =>
  eventDatePrefix.exec(entry.text)![0];
function keepRecentMilestones(sections: UserMemorySections): void {
  const milestones = sections.milestones;
  while (milestones.length > USER_MEMORY_SECTION_LIMITS.milestones) {
    let oldest = 0;
    milestones.forEach((entry, i) => {
      if (eventDate(entry) < eventDate(milestones[oldest]!)) oldest = i;
    });
    milestones.splice(oldest, 1);
  }
}
function findEntry(
  sections: UserMemorySections,
  section: UserMemorySectionKey,
  old: string,
  where: string,
): { section: UserMemorySectionKey; position: number } {
  const position = sections[section].findIndex((e) => e.text === old);
  if (position >= 0) return { section, position };
  const elsewhere = USER_MEMORY_SECTIONS.flatMap(({ key }) => {
    const at = sections[key].findIndex((e) => e.text === old);
    return at >= 0 ? [{ section: key, position: at }] : [];
  });
  if (elsewhere.length !== 1)
    throw new Error(`${where}: old "${old}" matches no entry`);
  return elsewhere[0]!;
}

/** One model answer: the edits it proposes and a note on them. */
interface UserMemoryProposal {
  edits: UserMemoryEdit[];
  change_note: string;
}

/** One cadence of maintenance: the model proposes edits against the current
 * sections, the application applies them. A rejected answer is corrected
 * within the Memory kind's attempts, and the last one keeps its valid edits.
 * Returns null when there is nothing to read. */
export async function updateUserMemory(
  input: {
    owner: { tenantId: string; ownerActorId: string };
    /** The Human's display name as it appears in the evidence. */
    human: string;
    date: string;
    cadence: UserMemoryCadence;
    current: UserMemorySections;
    evidence: readonly UserMemoryEvidence[];
  },
  request: typeof requestMemoryStructuredOutput = requestMemoryStructuredOutput,
): Promise<{
  sections: UserMemorySections;
  edits: UserMemoryEdit[];
  /** Edits dropped because their quote was not in the Session. */
  dropped: number;
  changeNote: string;
} | null> {
  const { capacity, compact } = userMemoryCapacity(input.current);
  if (!input.evidence.length && !compact) return null;
  const system = await fs.readFile(
    path.join(promptRoot, "user-memory/update.md"),
    "utf8",
  );
  const refs = input.evidence.map(({ ref }) => ref);
  const evidence = input.evidence.map(({ ref, kind, content }) => ({
    ref,
    kind,
    content,
  }));
  const apply = (proposal: UserMemoryProposal, keepValid: boolean) => {
    if (!Array.isArray(proposal.edits) || proposal.edits.length > MAX_EDITS)
      throw new Error("edits must be an array of at most 120 items");
    return applyUserMemoryEdits(
      input.current,
      proposal.edits,
      input.date,
      input.evidence,
      keepValid,
    );
  };
  // The latest answer that matched the schema, kept for when every attempt
  // is rejected.
  let latest: UserMemoryProposal | undefined;
  let proposal: UserMemoryProposal;
  try {
    proposal = (await request({
      owner: input.owner,
      system,
      user: JSON.stringify({
        human: input.human,
        date: input.date,
        cadence: input.cadence,
        memory: input.current,
        evidence,
        capacity,
        compact,
      }),
      schemaName: "user_memory_update",
      schema: userMemoryEditSchema(refs),
      reasoningEffort: "medium",
      validate: (output) => {
        latest = output as unknown as UserMemoryProposal;
        try {
          apply(latest, false);
          return undefined;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    })) as unknown as UserMemoryProposal;
  } catch (error) {
    if (
      !latest ||
      !(error instanceof ModelCallError && error.kind === "invalid_output")
    )
      throw error;
    proposal = latest;
  }
  try {
    // The last rejected answer keeps its valid edits.
    const { sections, applied } = apply(proposal, true);
    return {
      sections,
      edits: applied,
      dropped: proposal.edits.length - applied.length,
      changeNote: (proposal.change_note ?? "").slice(0, 1000),
    };
  } catch (error) {
    throw new Error(
      `Memory update rejected: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export interface UserMemoryOwner {
  tenantId: string;
  ownerActorId: string;
}
export interface UserMemoryRevision {
  version: number;
  sections: UserMemorySections;
  /** The Profile Revision this version has taken in. */
  baseProfileRevisionId: string | null;
}
export class UserMemoryConflictError extends Error {}
export interface UserMemoryStore {
  latest(owner: UserMemoryOwner): Promise<UserMemoryRevision | null>;
  save(
    owner: UserMemoryOwner,
    base: UserMemoryRevision | null,
    next: {
      sections: UserMemorySections;
      baseProfileRevisionId: string | null;
      source: UserMemoryCadence | "rollback";
      changeNote: string;
      evidence: readonly unknown[];
    },
  ): Promise<UserMemoryRevision>;
}

/** One cadence against the latest stored version, saved as one version. A
 * day too large for one call is read in parts, each updating the result of
 * the previous part. A version written meanwhile (a rollback) restarts the
 * cadence once from that version. */
export async function maintainUserMemory(
  input: {
    owner: UserMemoryOwner;
    human: string;
    date: string;
    cadence: UserMemoryCadence;
    parts: readonly (readonly UserMemoryEvidence[])[];
    /** The Profile Revision a profile cadence reads. */
    profileRevisionId?: string;
  },
  store: UserMemoryStore,
  request: typeof requestMemoryStructuredOutput = requestMemoryStructuredOutput,
): Promise<{
  changed: boolean;
  version?: number;
  edits: number;
  dropped: number;
}> {
  for (let round = 0; ; round++) {
    const base = await store.latest(input.owner);
    let sections = base?.sections ?? emptyUserMemory();
    if (!base && input.parts.some((part) => part.length))
      sections = initialUserMemory(
        input.human,
        input.owner.ownerActorId,
        input.date,
      );
    const edits: UserMemoryEdit[] = [];
    const notes: string[] = [];
    let dropped = 0;
    for (const evidence of input.parts) {
      const updated = await updateUserMemory(
        { ...input, current: sections, evidence },
        request,
      );
      if (!updated) continue;
      sections = updated.sections;
      edits.push(...updated.edits);
      dropped += updated.dropped;
      if (updated.changeNote) notes.push(updated.changeNote);
    }
    const baseProfileRevisionId =
      input.cadence === "profile"
        ? (input.profileRevisionId ?? null)
        : (base?.baseProfileRevisionId ?? null);
    // A Profile that changed nothing is still recorded as taken in.
    if (
      renderUserMemory(sections) ===
        renderUserMemory(base?.sections ?? emptyUserMemory()) &&
      baseProfileRevisionId === (base?.baseProfileRevisionId ?? null)
    )
      return { changed: false, edits: 0, dropped };
    try {
      const saved = await store.save(input.owner, base, {
        sections,
        baseProfileRevisionId,
        source: input.cadence,
        changeNote: notes.join(" ").slice(0, 1000),
        evidence: [
          { edits },
          ...input.parts
            .flat()
            .map(({ ref, kind, source }) => ({ ref, kind, source })),
        ],
      });
      return {
        changed: true,
        version: saved.version,
        edits: edits.length,
        dropped,
      };
    } catch (error) {
      if (!(error instanceof UserMemoryConflictError) || round >= 1)
        throw error;
    }
  }
}

/** Stored sections are an external boundary: only well-formed entries load. */
export function readUserMemorySections(value: unknown): UserMemorySections {
  const sections = emptyUserMemory();
  if (!isRecord(value)) throw new Error("Invalid memory.md sections");
  for (const { key } of USER_MEMORY_SECTIONS) {
    const entries = value[key];
    if (
      !Array.isArray(entries) ||
      entries.some(
        (e) =>
          !isRecord(e) ||
          typeof e.text !== "string" ||
          typeof e.date !== "string",
      )
    )
      throw new Error(`Invalid memory.md section: ${key}`);
    sections[key] = entries.map((e) => ({ text: e.text, date: e.date }));
  }
  return sections;
}

export function postgresUserMemoryStore(sql: postgres.Sql) {
  const latestIn = async (
    tx: postgres.Sql | postgres.TransactionSql,
    owner: UserMemoryOwner,
  ): Promise<UserMemoryRevision | null> => {
    const [row] = await tx<
      {
        version: number;
        sections: unknown;
        base_profile_revision_id: string | null;
      }[]
    >`SELECT version,sections,base_profile_revision_id FROM memory_source.user_memory_revisions WHERE tenant_id=${owner.tenantId} AND owner_actor_id=${owner.ownerActorId} ORDER BY version DESC LIMIT 1`;
    return row
      ? {
          version: row.version,
          sections: readUserMemorySections(row.sections),
          baseProfileRevisionId: row.base_profile_revision_id,
        }
      : null;
  };
  const record = async (
    tx: postgres.TransactionSql,
    owner: UserMemoryOwner,
    next: UserMemoryRevision,
    source: string,
    changeNote: string,
    evidence: readonly unknown[],
  ) => {
    const markdown = renderUserMemory(next.sections);
    if (Buffer.byteLength(markdown, "utf8") > USER_MEMORY_CAPACITY.max_bytes)
      throw new Error("memory.md exceeds its byte limit");
    await tx`SELECT memory_source.record_user_memory_revision(${owner.tenantId},${owner.ownerActorId},${next.version},${tx.json(JSON.parse(JSON.stringify(next.sections)))},${markdown},${next.baseProfileRevisionId},${changeNote.slice(0, 1000)},${source},${tx.json(JSON.parse(JSON.stringify(evidence)))})`;
  };
  const locked = <T>(
    owner: UserMemoryOwner,
    work: (tx: postgres.TransactionSql) => Promise<T>,
  ) =>
    sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`user-memory:${owner.tenantId}:${owner.ownerActorId}`},0))`;
      return work(tx);
    }) as Promise<T>;
  return {
    latest: (owner: UserMemoryOwner) => latestIn(sql, owner),
    save: (
      owner: UserMemoryOwner,
      base: UserMemoryRevision | null,
      next: Parameters<UserMemoryStore["save"]>[2],
    ) =>
      locked(owner, async (tx) => {
        const current = await latestIn(tx, owner);
        if ((current?.version ?? 0) !== (base?.version ?? 0))
          throw new UserMemoryConflictError("memory.md changed meanwhile");
        const saved = {
          version: (current?.version ?? 0) + 1,
          sections: next.sections,
          baseProfileRevisionId: next.baseProfileRevisionId,
        };
        await record(
          tx,
          owner,
          saved,
          next.source,
          next.changeNote,
          next.evidence,
        );
        return saved;
      }),
    /** Writes an earlier version again as the newest one. */
    rollback: (owner: UserMemoryOwner, version: number) =>
      locked(owner, async (tx) => {
        const [target] = await tx<
          { sections: unknown; base_profile_revision_id: string | null }[]
        >`SELECT sections,base_profile_revision_id FROM memory_source.user_memory_revisions WHERE tenant_id=${owner.tenantId} AND owner_actor_id=${owner.ownerActorId} AND version=${version}`;
        if (!target)
          throw new Error(`memory.md version ${version} does not exist`);
        const current = await latestIn(tx, owner);
        const saved = {
          version: (current?.version ?? 0) + 1,
          sections: readUserMemorySections(target.sections),
          baseProfileRevisionId: target.base_profile_revision_id,
        };
        await record(
          tx,
          owner,
          saved,
          "rollback",
          `Restored version ${version}`,
          [],
        );
        return saved;
      }),
  };
}
