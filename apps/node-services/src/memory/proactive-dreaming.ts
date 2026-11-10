import { localDate, localTimeZone } from "./date.js";
// Proactive dreaming: once a night, revise one Human's reminder guideline
// from how they answered what proactive actually showed them that day. It
// reads only that Human's proactive outputs, each tagged with the wake source
// that led to it, with the next twenty Messages of its Room, writes a new guideline version (the previous one stays for
// rollback), then clears the day's outputs and event deduplication records. A guideline
// holds broad specific rules, which evaluation follows, and clues: specific
// observations only dreaming reads, carrying evidence across nights until
// they are strong enough to be rules.
import fs from "node:fs/promises";
import path from "node:path";

import type postgres from "postgres";

import { memoryDatabase } from "./database.js";
import { requestMemoryStructuredOutput } from "./llm.js";
import { promptRoot } from "./paths.js";

export interface ProactiveOwner {
  tenantId: string;
  ownerActorId: string;
}

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- needs an implicit index signature
export type Clue = {
  matter: string;
  kind: string;
  time: string | null;
  leaning: "remind_directly" | "track_for_follow_up" | "stay_silent";
  seen: number;
  last_seen: string;
};

export interface Guideline {
  version: number;
  specific: string[];
  clues: Clue[];
}

/** What woke AnotherMe to say it; see the TeamHub reminder quiet wakes. */
export type ProactiveSource = "review" | "routine" | "event" | "plan";

export interface ProactiveExchange {
  source: ProactiveSource;
  output: string;
  at: string;
  replies: { author: string; authorKind: string; text: string; at: string }[];
}

export const maxSpecificRules = 20;
export const maxClues = 20;
/** A clue not seen again within this many days is dropped. */
const clueDays = 14;

/**
 * Reads prompts/proactive/dreaming.md: the "- " items under "## General
 * rules" and the fenced block under "## System prompt", with the limits
 * filled in.
 */
export function parseDreamPrompt(text: string): {
  system: string;
  generalRules: string[];
} {
  const sections = new Map<string, string[]>();
  let heading = "";
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) heading = line.slice(3).trim();
    else if (heading)
      sections.set(heading, [...(sections.get(heading) ?? []), line]);
  }
  const generalRules = (sections.get("General rules") ?? [])
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim());
  // The system prompt sits in a fenced block so Markdown tools leave it as is.
  const system = /```text\n([\s\S]*?)\n```/u
    .exec((sections.get("System prompt") ?? []).join("\n"))?.[1]
    ?.replaceAll("{{maxClues}}", String(maxClues))
    .replaceAll("{{maxSpecificRules}}", String(maxSpecificRules));
  if (generalRules.length === 0 || !system)
    throw new Error("prompts/proactive/dreaming.md is missing a section");
  return { system, generalRules };
}

const loadDreamPrompt = async () =>
  parseDreamPrompt(
    await fs.readFile(
      path.join(promptRoot, "proactive", "dreaming.md"),
      "utf8",
    ),
  );

export function defaultGuideline(): Guideline {
  return { version: 1, specific: [], clues: [] };
}

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- needs an implicit index signature
export type DreamOutput = {
  specific: string[];
  removed_rules: string[];
  clues: Clue[];
  change_note: string;
};

const leanings = [
  "remind_directly",
  "track_for_follow_up",
  "stay_silent",
] as const;

const dreamSchema = {
  type: "object",
  additionalProperties: false,
  required: ["specific", "removed_rules", "clues", "change_note"],
  properties: {
    specific: {
      type: "array",
      maxItems: maxSpecificRules,
      items: { type: "string", minLength: 1, maxLength: 200 },
    },
    removed_rules: {
      type: "array",
      items: { type: "string", maxLength: 200 },
    },
    clues: {
      type: "array",
      maxItems: maxClues,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["matter", "kind", "time", "leaning", "seen", "last_seen"],
        properties: {
          matter: { type: "string", minLength: 1, maxLength: 120 },
          kind: { type: "string", maxLength: 60 },
          time: { type: ["string", "null"], maxLength: 40 },
          leaning: { type: "string", enum: [...leanings] },
          seen: { type: "integer", minimum: 1 },
          last_seen: { type: "string" },
        },
      },
    },
    change_note: { type: "string", maxLength: 2000 },
  },
};

/** Applies the model's answer to the current guideline as the next version;
 * `today` is the local date the exchanges happened. */
export function nextGuideline(
  current: Guideline,
  output: DreamOutput,
  today: string,
): Guideline {
  // A current rule leaves only when the answer names it as removed, so an
  // answer that forgets to repeat the rules never wipes them.
  const removed = new Set(output.removed_rules.map((rule) => rule.trim()));
  const kept = current.specific.filter((rule) => !removed.has(rule.trim()));
  const seen = new Set<string>();
  const specific = [...output.specific, ...kept]
    .map((rule) => rule.trim())
    .filter((rule) => rule && !seen.has(rule) && seen.add(rule))
    .slice(0, maxSpecificRules);
  return {
    version: current.version + 1,
    specific,
    clues: keptClues(output.clues, today),
  };
}

/** One clue per matter and kind, recent ones first, none older than clueDays. */
function keptClues(clues: readonly Clue[], today: string): Clue[] {
  const oldest = new Date(`${today}T00:00:00Z`);
  oldest.setUTCDate(oldest.getUTCDate() - clueDays);
  const cutoff = oldest.toISOString().slice(0, 10);
  const byThing = new Map<string, Clue>();
  for (const clue of clues) {
    const lastSeen = /^\d{4}-\d{2}-\d{2}$/u.test(clue.last_seen)
      ? clue.last_seen > today
        ? today
        : clue.last_seen
      : today;
    const kept: Clue = {
      matter: clue.matter.trim(),
      kind: clue.kind.trim(),
      time: clue.time?.trim() || null,
      leaning: clue.leaning,
      seen: Math.max(1, Math.floor(clue.seen)),
      last_seen: lastSeen,
    };
    if (!kept.matter || kept.last_seen < cutoff) continue;
    const key = `${kept.matter}\u0000${kept.kind}`;
    const previous = byThing.get(key);
    if (!previous || previous.last_seen < kept.last_seen)
      byThing.set(key, kept);
  }
  return [...byThing.values()]
    .sort((a, b) => b.last_seen.localeCompare(a.last_seen))
    .slice(0, maxClues);
}

const localClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: localTimeZone(),
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Groups the query rows into one exchange per output. */
export function exchangesFromRows(
  rows: readonly {
    message_id: string;
    source: ProactiveSource;
    output_body: string;
    output_at: Date;
    position: number;
    author: string;
    author_kind: string;
    body: string;
    at: Date | null;
  }[],
): ProactiveExchange[] {
  const exchanges = new Map<string, ProactiveExchange>();
  for (const row of rows) {
    let exchange = exchanges.get(row.message_id);
    if (!exchange) {
      exchange = {
        source: row.source,
        output: row.output_body,
        at: row.output_at.toISOString(),
        replies: [],
      };
      exchanges.set(row.message_id, exchange);
    }
    if (row.position > 0)
      exchange.replies.push({
        author: row.author,
        authorKind: row.author_kind,
        text: row.body.slice(0, 1_000),
        at: (row.at ?? row.output_at).toISOString(),
      });
  }
  return [...exchanges.values()];
}

export interface DreamStore {
  guideline(owner: ProactiveOwner): Promise<Guideline>;
  exchanges(owner: ProactiveOwner, before: Date): Promise<ProactiveExchange[]>;
  save(
    owner: ProactiveOwner,
    guideline: Guideline,
    note: string,
  ): Promise<void>;
  clear(owner: ProactiveOwner, before: Date): Promise<void>;
}

export type DreamResult =
  | { status: "no_exchanges" }
  | { status: "updated"; version: number; exchanges: number };

/**
 * One Human's dreaming. The day is emptied every night, with or without
 * exchanges; a failure leaves it in place so the next night learns from it
 * again.
 */
export async function dreamProactiveGuideline(
  owner: ProactiveOwner,
  store: DreamStore,
  options: {
    before?: Date;
    request?: typeof requestMemoryStructuredOutput;
  } = {},
): Promise<DreamResult> {
  const before = options.before ?? new Date();
  const exchanges = await store.exchanges(owner, before);
  if (exchanges.length === 0) {
    await store.clear(owner, before);
    return { status: "no_exchanges" };
  }
  const current = await store.guideline(owner);
  const request = options.request ?? requestMemoryStructuredOutput;
  const today = localDate(new Date(exchanges.at(-1)!.at));
  const clock = (at: string) => localClock.format(new Date(at));
  const prompt = await loadDreamPrompt();
  const output = (await request({
    owner,
    system: prompt.system,
    user: JSON.stringify({
      today,
      general_rules: prompt.generalRules,
      specific_rules: current.specific,
      clues: current.clues,
      exchanges: exchanges.map((exchange) => ({
        source: exchange.source,
        at: clock(exchange.at),
        text: exchange.output,
        followed_by: exchange.replies.map((reply) => ({
          speaker: reply.authorKind === "human" ? "user" : "assistant",
          at: clock(reply.at),
          text: reply.text,
        })),
      })),
    }),
    schemaName: "proactive_guideline_update",
    schema: dreamSchema,
    reasoningEffort: "medium",
  })) as DreamOutput;
  const next = nextGuideline(current, output, today);
  await store.save(owner, next, output.change_note.slice(0, 2_000));
  await store.clear(owner, before);
  return {
    status: "updated",
    version: next.version,
    exchanges: exchanges.length,
  };
}

/** The TeamHub database store, scoped to one owner on every statement. */
export function postgresDreamStore(sql: postgres.Sql): DreamStore {
  return {
    async guideline(owner) {
      const rows = await sql<
        {
          version: number;
          specific: string[];
          clues: Clue[];
        }[]
      >`
        SELECT version, specific, clues FROM memory_source.proactive_guidelines
        WHERE tenant_id = ${owner.tenantId} AND owner_actor_id = ${owner.ownerActorId}
        ORDER BY version DESC LIMIT 1`;
      return rows[0]
        ? {
            version: rows[0].version,
            specific: rows[0].specific,
            clues: rows[0].clues,
          }
        : defaultGuideline();
    },
    async exchanges(owner, before) {
      const rows = await sql<
        {
          message_id: string;
          source: ProactiveSource;
          output_body: string;
          output_at: Date;
          position: number;
          author: string;
          author_kind: string;
          body: string;
          at: Date | null;
        }[]
      >`
        SELECT message_id, source, output_body, output_at, position, author, author_kind, body, at
        FROM memory_source.proactive_exchanges(${owner.tenantId}, ${owner.ownerActorId}, ${before})`;
      return exchangesFromRows(rows);
    },
    async save(owner, guideline, note) {
      await sql`
        SELECT memory_source.record_proactive_guideline(
          ${owner.tenantId}, ${owner.ownerActorId}, ${guideline.version},
          ${sql.json(guideline.specific)}, ${sql.json(guideline.clues)}, ${note})`;
    },
    async clear(owner, before) {
      await sql`
        SELECT memory_source.clear_proactive_learning(${owner.tenantId}, ${owner.ownerActorId}, ${before})`;
    },
  };
}

/** The nightly step for one Memory subject, after its Daily. */
export async function dreamProactiveForSubject(
  owner: ProactiveOwner,
): Promise<DreamResult> {
  return dreamProactiveGuideline(owner, postgresDreamStore(memoryDatabase()));
}
