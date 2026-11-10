// Public benchmark data, downloaded at a pinned revision and checked by
// SHA-256, then read into one Case shape. A Case's history is public input;
// its answer and type go only to the judge.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type Benchmark = "locomo" | "longmemeval";

export interface Turn {
  role: "user" | "assistant";
  speaker: string;
  text: string;
}

export interface HistorySession {
  id: string;
  /** The dataset's own date text, such as `1:56 pm on 8 May, 2023`. */
  date: string;
  turns: Turn[];
}

export interface Corpus {
  /** SHA-256 of the canonical sessions; questions on one history share it. */
  id: string;
  sessions: HistorySession[];
}

export interface Case {
  id: string;
  benchmark: Benchmark;
  /** LoCoMo category number or LongMemEval question_type. */
  type: string;
  question: string;
  /** When the question is asked, as an ISO timestamp. */
  askedAt: string;
  answer: string;
  unanswerable: boolean;
  corpus: Corpus;
}

export interface Plan {
  benchmark: Benchmark;
  dataset_sha256: string;
  seed: number;
  selection?: string;
  subset_of?: string;
  case_ids: string[];
}

const UPSTREAMS: Record<Benchmark, { url: string; sha256: string }> = {
  locomo: {
    url: "https://raw.githubusercontent.com/snap-research/locomo/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/data/locomo10.json",
    sha256: "79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4",
  },
  longmemeval: {
    url: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/98d7416c24c778c2fee6e6f3006e7a073259d48f/longmemeval_s_cleaned.json",
    sha256: "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442",
  },
};

export const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

export async function readPlan(name: string): Promise<Plan> {
  const file = path.join(import.meta.dirname, "plans", `${name}.json`);
  const plan = JSON.parse(await fs.readFile(file, "utf8")) as Plan;
  if (new Set(plan.case_ids).size !== plan.case_ids.length)
    throw new Error(`Plan ${name} repeats a case`);
  if (plan.dataset_sha256 !== UPSTREAMS[plan.benchmark].sha256)
    throw new Error(`Plan ${name} was drawn from another dataset revision`);
  return plan;
}

/** The dataset file, downloaded once into `dataDirectory`. */
export async function datasetFile(
  benchmark: Benchmark,
  dataDirectory: string,
): Promise<string> {
  const { url, sha256: expected } = UPSTREAMS[benchmark];
  const file = path.join(dataDirectory, path.basename(new URL(url).pathname));
  const present = await fs.readFile(file).catch(() => undefined);
  if (present && sha256(present) === expected) return file;
  console.log(`Downloading ${benchmark} from ${url}`);
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Download of ${benchmark} failed: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (sha256(bytes) !== expected)
    throw new Error(
      `Downloaded ${benchmark} does not match its pinned SHA-256`,
    );
  await fs.mkdir(dataDirectory, { recursive: true });
  await fs.writeFile(`${file}.tmp`, bytes);
  await fs.rename(`${file}.tmp`, file);
  return file;
}

/** The plan's cases, in plan order. */
export async function loadCases(
  plan: Plan,
  dataDirectory: string,
): Promise<Case[]> {
  const rows = JSON.parse(
    await fs.readFile(await datasetFile(plan.benchmark, dataDirectory), "utf8"),
  ) as unknown[];
  const wanted = new Set(plan.case_ids);
  const cases = new Map<string, Case>();
  const read = plan.benchmark === "locomo" ? locomoCases : longMemEvalCases;
  for (const row of rows)
    for (const item of read(row, wanted)) cases.set(item.id, item);
  const missing = plan.case_ids.filter((id) => !cases.has(id));
  if (missing.length)
    throw new Error(
      `Plan cases are missing from the dataset: ${missing.join(", ")}`,
    );
  return plan.case_ids.map((id) => cases.get(id)!);
}

function corpus(sessions: HistorySession[]): Corpus {
  return { id: sha256(JSON.stringify(sessions)), sessions };
}

interface LocomoRow {
  sample_id: string;
  conversation: Record<string, unknown>;
  qa: {
    question: string;
    answer?: string | number;
    adversarial_answer?: string;
    category: number;
  }[];
}

function* locomoCases(value: unknown, wanted: Set<string>): Generator<Case> {
  const row = value as LocomoRow;
  if (!row.qa.some((_, index) => wanted.has(`${row.sample_id}:${index}`)))
    return;
  const dialog = row.conversation;
  const keys = Object.keys(dialog)
    .filter((key) => /^session_\d+$/u.test(key))
    .sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)));
  const sessions = keys.map((key) => ({
    id: `${row.sample_id}:${key}`,
    date: dialog[`${key}_date_time`] as string,
    // Both speakers are people; image turns keep the dataset's caption.
    turns: (
      dialog[key] as { speaker: string; text: string; blip_caption?: string }[]
    ).map((turn) => ({
      role: "user" as const,
      speaker: turn.speaker,
      text: turn.blip_caption
        ? `${turn.text}\n[Provided image caption] ${turn.blip_caption}`
        : turn.text,
    })),
  }));
  const history = corpus(sessions);
  const askedAt = isoTimestamp(sessions.at(-1)!.date);
  for (const [index, qa] of row.qa.entries()) {
    const id = `${row.sample_id}:${index}`;
    if (!wanted.has(id)) continue;
    // The AMB protocol excludes adversarial category 5.
    if (qa.category === 5) throw new Error(`${id} is an adversarial question`);
    yield {
      id,
      benchmark: "locomo",
      type: String(qa.category),
      question: qa.question,
      askedAt,
      answer: String(qa.answer ?? ""),
      unanswerable: false,
      corpus: history,
    };
  }
}

interface LongMemEvalRow {
  question_id: string;
  question_type: string;
  question: string;
  answer: string | number;
  question_date: string;
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: { role: "user" | "assistant"; content: string }[][];
}

function* longMemEvalCases(
  value: unknown,
  wanted: Set<string>,
): Generator<Case> {
  const row = value as LongMemEvalRow;
  if (!wanted.has(row.question_id)) return;
  // Upstream IDs such as answer_* reveal annotations; history gets pseudonyms.
  const sessions = row.haystack_sessions.map((turns, index) => ({
    id: `session_${sha256(row.haystack_session_ids[index]!).slice(0, 24)}`,
    date: row.haystack_dates[index]!,
    turns: turns.map((turn) => ({
      role: turn.role,
      speaker: turn.role,
      text: turn.content,
    })),
  }));
  yield {
    id: row.question_id,
    benchmark: "longmemeval",
    type: row.question_type,
    question: row.question,
    askedAt: isoTimestamp(row.question_date),
    answer: String(row.answer),
    unanswerable: row.question_id.endsWith("_abs"),
    corpus: corpus(sessions),
  };
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/**
 * A dataset date as wall-clock parts: LongMemEval `2023/05/20 (Sat) 02:21`
 * or LoCoMo `1:56 pm on 8 May, 2023`.
 */
export function datasetClock(value: string): {
  date: string;
  hour: number;
  minute: number;
} {
  const numeric =
    /^(\d{4})[-/](\d{2})[-/](\d{2})(?: \([A-Za-z]+\))?(?: (\d{2}):(\d{2}))?/u.exec(
      value,
    );
  if (numeric)
    return {
      date: `${numeric[1]}-${numeric[2]}-${numeric[3]}`,
      hour: Number(numeric[4] ?? 0),
      minute: Number(numeric[5] ?? 0),
    };
  const spoken =
    /^(\d{1,2}):(\d{2})\s*(am|pm) on (\d{1,2}) ([A-Za-z]+),? (\d{4})$/iu.exec(
      value.trim(),
    );
  const month = spoken ? MONTHS.indexOf(spoken[5]!.toLowerCase()) : -1;
  if (!spoken || month < 0)
    throw new Error(`Unsupported dataset date: ${value}`);
  const pm = spoken[3]!.toLowerCase() === "pm";
  return {
    date: `${spoken[6]}-${String(month + 1).padStart(2, "0")}-${spoken[4]!.padStart(2, "0")}`,
    hour: (Number(spoken[1]) % 12) + (pm ? 12 : 0),
    minute: Number(spoken[2]),
  };
}

function isoTimestamp(value: string): string {
  const { date, hour, minute } = datasetClock(value);
  return `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;
}
