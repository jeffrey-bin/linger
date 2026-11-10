// Session fact extraction after Hindsight's concise retain (engine/retain/
// fact_extraction.py, MIT, Copyright (c) 2025 Vectorize AI, Inc.): the Raw
// conversation in windows of up to 3,000 characters, one system prompt and one
// "Extract facts from the following chunk" message per window, the same output
// fields and the same post-processing. Unlike Hindsight, one call carries a
// batch of windows. It runs beside, never inside, Wiki generation.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@linger/service-kit";
import {
  isComputerOffline,
  ModelCallError,
  type ModelOwner,
  type ModelChain,
} from "../runtime-model-call.js";
import { runMemoryModelChain, type MemoryModelChainRunner } from "./llm.js";
import { promptRoot } from "./paths.js";
import type { SourceChunk } from "./search/chunks.js";

/** Hindsight's DEFAULT_RETAIN_CHUNK_SIZE in characters. */
export const FACT_WINDOW_CHARS = 3_000;
/** Contract limit for one entity name. */
const MAX_ENTITY_CHARS = 80;
/**
 * Minimum share of a fact's words that occur in its window. Facts that keep the
 * window's language reuse its names and words (median 0.76 on LoCoMo); facts
 * the model translated despite the prompt's LANGUAGE rule share almost none.
 */
const MIN_SOURCE_WORD_SHARE = 0.35;
const SCRIPTS = [
  "Latin",
  "Cyrillic",
  "Greek",
  "Han",
  "Hiragana",
  "Katakana",
  "Hangul",
  "Arabic",
  "Hebrew",
  "Thai",
  "Devanagari",
].map((name) => [name, new RegExp(`\\p{Script=${name}}`, "u")] as const);

export interface ExtractedFact {
  what: string;
  when: string;
  where: string;
  who: string;
  why: string;
  fact_kind: "event" | "conversation";
  occurred_start?: string;
  occurred_end?: string;
  fact_type: "world" | "assistant";
  entities: string[];
}

export interface FactWindow {
  chunks: SourceChunk[];
  text: string;
  sha256: string;
}

const text = { type: "string" };
// Hindsight's FactExtractionResponseNoCausal; strict JSON schema mode needs
// every field present, so the event dates are nullable instead of optional.
const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["facts"],
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "what",
          "when",
          "where",
          "who",
          "why",
          "fact_kind",
          "occurred_start",
          "occurred_end",
          "fact_type",
          "entities",
        ],
        properties: {
          what: text,
          when: text,
          where: text,
          who: text,
          why: text,
          fact_kind: { type: "string", enum: ["event", "conversation"] },
          occurred_start: { type: ["string", "null"] },
          occurred_end: { type: ["string", "null"] },
          fact_type: { type: "string", enum: ["world", "assistant"] },
          entities: { type: "array", items: text },
        },
      },
    },
  },
};

let systemPrompt: Promise<string> | undefined;
const loadSystemPrompt = () =>
  (systemPrompt ??= fs
    .readFile(path.join(promptRoot, "facts", "fact-extraction.md"), "utf8")
    .then((content) => content.replace(/^<!--[\s\S]*?-->\n/u, "")));

/** Consecutive chunks grouped up to the Hindsight chunk size; never split. */
export function factWindows(chunks: readonly SourceChunk[]): FactWindow[] {
  const windows: SourceChunk[][] = [];
  for (const chunk of chunks) {
    const current = windows.at(-1);
    const length = current?.reduce((n, c) => n + c.content.length + 2, 0) ?? 0;
    if (current && length + chunk.content.length <= FACT_WINDOW_CHARS)
      current.push(chunk);
    else windows.push([chunk]);
  }
  return windows.map((group) => {
    const content = group.map((chunk) => chunk.content).join("\n\n");
    return {
      chunks: group,
      text: content,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  });
}

/** Hindsight's _build_user_message for one window. */
export function factUserMessage(
  window: Pick<FactWindow, "text">,
  index: number,
  total: number,
  eventDate: Date | undefined,
  context: string,
): string {
  const date =
    eventDate && Number.isFinite(eventDate.getTime())
      ? `${eventDate.toLocaleDateString("en-US", {
          weekday: "long",
          month: "long",
          day: "2-digit",
          year: "numeric",
          timeZone: "UTC",
        })} (${eventDate.toISOString()})`
      : "Unknown";
  return `Extract facts from the following chunk.

Chunk: ${index + 1}/${total}
Event Date: ${date}
Context: ${context || "none"}

Content:
${window.text}`;
}

const isoDay = (value: unknown) =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}/u.test(value)
    ? value.slice(0, 10)
    : undefined;

/**
 * Hindsight's post-processing: only events keep dates, a point event ends
 * where it starts, entities are plain strings, and a fact needs its statement.
 */
export function normalizeExtractedFacts(output: unknown): ExtractedFact[] {
  const facts = (output as { facts?: unknown } | null)?.facts;
  if (!Array.isArray(facts)) return [];
  return facts.flatMap((value) => {
    const fact = value as Record<string, unknown>;
    if (typeof fact.what !== "string" || !fact.what.trim()) return [];
    const field = (key: string) =>
      typeof fact[key] === "string" && fact[key].trim()
        ? fact[key].trim()
        : "N/A";
    const kind = fact.fact_kind === "event" ? "event" : "conversation";
    const start = kind === "event" ? isoDay(fact.occurred_start) : undefined;
    const end = start ? isoDay(fact.occurred_end) : undefined;
    return [
      {
        what: fact.what.trim(),
        when: field("when"),
        where: field("where"),
        who: field("who"),
        why: field("why"),
        fact_kind: kind,
        ...(start
          ? {
              occurred_start: start,
              occurred_end: end && end >= start ? end : start,
            }
          : {}),
        fact_type: fact.fact_type === "assistant" ? "assistant" : "world",
        entities: Array.isArray(fact.entities)
          ? fact.entities
              .filter((entity): entity is string => typeof entity === "string")
              .map((entity) => entity.trim())
              // The wire contract bounds entity names; longer ones are paths or prose.
              .filter((entity) => entity && entity.length <= MAX_ENTITY_CHARS)
              .slice(0, 10)
          : [],
      },
    ];
  });
}

function dominantScript(text: string): string | undefined {
  const counts = new Map<string, number>();
  for (const letter of text.match(/\p{L}/gu) ?? []) {
    const script = SCRIPTS.find(([, pattern]) => pattern.test(letter))?.[0];
    if (script) counts.set(script, (counts.get(script) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** Words of three or more letters; unspaced Han and kana runs become character pairs. */
function words(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{M}]+/gu) ?? []).flatMap((run) => {
    const chars = [...run];
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(run))
      return chars.slice(1).map((char, index) => chars[index] + char);
    return chars.length >= 3 ? [run] : [];
  });
}

/** Whether a fact keeps its window's language instead of translating it. */
export function writtenLikeSource(fact: string, source: string): boolean {
  const script = dominantScript(fact);
  if (script && script !== dominantScript(source)) return false;
  const factWords = words(fact);
  if (factWords.length < 4) return true;
  const vocabulary = new Set(words(source));
  return (
    factWords.filter((word) => vocabulary.has(word)).length /
      factWords.length >=
    MIN_SOURCE_WORD_SHARE
  );
}

/** A window with what its user message names besides its text. */
export interface FactBatchWindow {
  readonly window: FactWindow;
  readonly index: number;
  readonly total: number;
  readonly eventDate: Date | undefined;
  readonly context: string;
}

/** Windows one extraction call carries. The Runtime's fixed cost per call is
 * far above one 3,000-character window, so windows share a call. */
export const FACT_BATCH_WINDOWS = 16;

/** One answer per window, keyed by the window_sha256 the prompt gives it. */
function batchSchema(shas: readonly string[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["windows"],
    properties: {
      windows: {
        type: "array",
        maxItems: shas.length,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["window_sha256", "facts"],
          properties: {
            window_sha256: { type: "string", enum: [...shas] },
            facts: RESPONSE_SCHEMA.properties.facts,
          },
        },
      },
    },
  };
}

/** Hindsight's user message for every window of a batch, each under its key. */
export function factBatchMessage(batch: readonly FactBatchWindow[]): string {
  return `Extract facts from each of the following ${batch.length} chunks separately. Return one entry per chunk with its window_sha256 and only the facts stated in that chunk.

${batch
  .map(
    (item) =>
      `=== window_sha256: ${item.window.sha256} ===\n${factUserMessage(item.window, item.index, item.total, item.eventDate, item.context)}`,
  )
  .join("\n\n")}`;
}

async function requestBatchFacts(
  batch: readonly FactBatchWindow[],
  chain: ModelChain,
  step: string,
): Promise<Map<string, ExtractedFact[]>> {
  // Sessions can repeat a window word for word; the answer is keyed by
  // window_sha256, so each distinct window is asked once and its schema enum
  // stays free of duplicates.
  const distinct = [
    ...new Map(batch.map((item) => [item.window.sha256, item])).values(),
  ];
  const shas = distinct.map((item) => item.window.sha256);
  const { output } = await chain.call({
    step,
    instructions: await loadSystemPrompt(),
    input: factBatchMessage(distinct),
    schemaName: "fact_extraction",
    outputSchema: batchSchema(shas),
    // Hindsight's evaluated retain runs at low reasoning effort.
    effort: "low",
  });
  const facts = new Map<string, ExtractedFact[]>();
  for (const entry of Array.isArray(output.windows) ? output.windows : []) {
    const sha = isRecord(entry) ? entry.window_sha256 : undefined;
    if (typeof sha !== "string" || !shas.includes(sha)) continue;
    facts.set(sha, [
      ...(facts.get(sha) ?? []),
      ...normalizeExtractedFacts(entry),
    ]);
  }
  return facts;
}

/**
 * Extract a batch of windows as one Memory chain keyed by its windows, one
 * call per step. Windows whose facts drift into another language are
 * extracted once more together, and facts still translated after that are
 * dropped. A batch whose answer stays invalid is retried as two halves. A
 * window the answer leaves out is absent from the result, so the next sync
 * extracts it again.
 */
export async function extractWindowBatch(
  batch: readonly FactBatchWindow[],
  owner: ModelOwner,
  runChain: MemoryModelChainRunner = runMemoryModelChain,
): Promise<Map<string, ExtractedFact[]>> {
  return runChain(
    { kind: "memory", owner, key: factBatchKey(batch) },
    (chain) => extractInChain(batch, chain, "first"),
  );
}

/** The batch's distinct windows name it, so a restart asks the same key. */
export function factBatchKey(batch: readonly FactBatchWindow[]): string {
  const shas = [...new Set(batch.map((item) => item.window.sha256))].sort();
  return `memory.facts:${createHash("sha256").update(shas.join("\n")).digest("hex")}`;
}

async function extractInChain(
  batch: readonly FactBatchWindow[],
  chain: ModelChain,
  step: string,
): Promise<Map<string, ExtractedFact[]>> {
  let facts: Map<string, ExtractedFact[]>;
  try {
    facts = await requestBatchFacts(batch, chain, step);
  } catch (error) {
    if (
      batch.length < 2 ||
      !(error instanceof ModelCallError && error.kind === "invalid_output")
    )
      throw error;
    const half = Math.ceil(batch.length / 2);
    const prefix = step === "first" ? "split" : step;
    // A chain runs its calls one at a time, so the halves go in order.
    const halves = new Map<string, ExtractedFact[]>();
    for (const [index, part] of [
      batch.slice(0, half),
      batch.slice(half),
    ].entries())
      for (const entry of await extractInChain(
        part,
        chain,
        `${prefix}-${index}`,
      ))
        halves.set(...entry);
    return halves;
  }
  const kept = (item: FactBatchWindow, extracted: readonly ExtractedFact[]) =>
    extracted.filter(({ what }) => writtenLikeSource(what, item.window.text));
  const drifted = batch.filter((item) => {
    const extracted = facts.get(item.window.sha256);
    return extracted && kept(item, extracted).length !== extracted.length;
  });
  if (drifted.length === 0) return facts;
  let retried = new Map<string, ExtractedFact[]>();
  try {
    retried = await requestBatchFacts(drifted, chain, `${step}-drift`);
  } catch (error) {
    // Waiting for the Computer keeps every window for the next sync; any other
    // failure keeps the first answer's facts that stayed in their language.
    if (isComputerOffline(error)) throw error;
  }
  for (const item of drifted) {
    const sha = item.window.sha256;
    facts.set(sha, kept(item, retried.get(sha) ?? facts.get(sha)!));
  }
  return facts;
}
