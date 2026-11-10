// Memory/Wiki benchmark on LoCoMo and LongMemEval. Stages each question's
// public history through the product (product.ts), lets the answering model
// use the Another Me's knowledge tools (answer.ts), grades the answers
// (judge.ts) and writes report.md and summary.json. Every answer is stored as
// it completes, so an interrupted run resumes where it stopped. See README.md.
//
// From apps/node-services:
//   node --env-file=../../.env --import tsx scripts/memory-benchmark/run.ts \
//     --plan locomo-validate7 --out .local/memory-benchmark/runs/<name> \
//     --database-url postgresql://postgres@127.0.0.1:<port>/memory_benchmark \
//     [--arms product,search,wiki,memory-md,none] [--rounds 3]
//     [--state <prepared state>] [--skip-nightly] [--nightly-concurrency 4]
//     [--baseline <another run's out>] [--limit N] [--concurrency 8]
//     [--model openai/gpt-5.6-luna] [--judge-model openai/gpt-5.6-luna]
//     [--retry-errors]
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { createGatewayModelCall } from "../gateway-model-call.js";
import {
  type AnswerRecord,
  ARMS,
  type Arm,
  answerQuestion,
  NIGHTLY_ARMS,
} from "./answer.js";
import { type Case, loadCases, readPlan, sha256 } from "./datasets.js";
import {
  calibrateJudge,
  type Judgment,
  JUDGE_PROTOCOL,
  judge,
  judgePrompt,
} from "./judge.js";
import { openProduct, type PreparedCorpus, productStages } from "./product.js";

// Memory's days follow the process time zone; sessions are staged as
// Asia/Shanghai wall time, as the Memory tests pin.
process.env.TZ = "Asia/Shanghai";

const { values: args } = parseArgs({
  options: {
    plan: { type: "string" },
    out: { type: "string" },
    state: { type: "string" },
    "database-url": { type: "string" },
    arms: { type: "string", default: "product" },
    rounds: { type: "string", default: "1" },
    limit: { type: "string" },
    concurrency: { type: "string", default: "8" },
    model: { type: "string", default: "openai/gpt-5.6-luna" },
    "judge-model": { type: "string", default: "openai/gpt-5.6-luna" },
    baseline: { type: "string" },
    data: { type: "string" },
    "retry-errors": { type: "boolean", default: false },
    "skip-nightly": { type: "boolean", default: false },
    "nightly-concurrency": { type: "string", default: "4" },
  },
});
if (!args.plan || !args.out)
  throw new Error("--plan and --out are required; see the header of run.ts");
const databaseUrl =
  args["database-url"] ?? process.env.MEMORY_BENCHMARK_DATABASE_URL;
if (!databaseUrl)
  throw new Error(
    "--database-url (or MEMORY_BENCHMARK_DATABASE_URL) is required",
  );
const arms = args.arms.split(",") as Arm[];
if (!arms.length || arms.some((arm) => !ARMS.includes(arm)))
  throw new Error(`--arms takes ${ARMS.join(", ")}`);
const nightly = !args["skip-nightly"];
if (!nightly && arms.some((arm) => NIGHTLY_ARMS.includes(arm)))
  throw new Error(
    `--skip-nightly leaves no Wiki, Daily or memory.md for ${NIGHTLY_ARMS.join(", ")}`,
  );
const stages = productStages(nightly);
const rounds = Number(args.rounds);
const concurrency = Number(args.concurrency);
const appRoot = path.resolve(import.meta.dirname, "../..");
const out = path.resolve(args.out);
const stateRoot = path.resolve(args.state ?? path.join(out, "state"));
const dataDirectory = path.resolve(
  args.data ?? path.join(appRoot, ".local/memory-benchmark/data"),
);

const plan = await readPlan(args.plan);
const cases = (await loadCases(plan, dataDirectory)).slice(
  0,
  args.limit ? Number(args.limit) : undefined,
);

/** The checkout under test: HEAD plus a hash of uncommitted Memory/Wiki changes. */
function sourceIdentity() {
  const git = (...command: string[]) =>
    execFileSync("git", ["-C", appRoot, ...command], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
  const diff = git("diff", "HEAD", "--", "src", "prompts", "scripts");
  const untracked = git(
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    "src",
    "prompts",
    "scripts",
  ).trim();
  return {
    commit: git("rev-parse", "HEAD").trim(),
    dirty_sha256: diff || untracked ? sha256(diff + untracked) : null,
  };
}

const source = sourceIdentity();
const fixed = {
  plan: args.plan,
  benchmark: plan.benchmark,
  dataset_sha256: plan.dataset_sha256,
  case_ids: cases.map((item) => item.id),
  answer_model: args.model,
  judge_model: args["judge-model"],
  judge_protocol: JUDGE_PROTOCOL,
  state: stateRoot,
};
await fs.mkdir(out, { recursive: true });
const manifestPath = path.join(out, "manifest.json");
const previous = await fs
  .readFile(manifestPath, "utf8")
  .then((text) => JSON.parse(text) as { fixed: unknown; source: unknown })
  .catch(() => undefined);
if (previous && JSON.stringify(previous.fixed) !== JSON.stringify(fixed))
  throw new Error(
    "This --out holds a run with another plan, model, judge or state; use a new --out",
  );
if (previous && JSON.stringify(previous.source) !== JSON.stringify(source))
  console.log(
    "Note: the checkout changed since this run started; new answers use the current code",
  );

// The state was prepared by one checkout and one database; answers may come
// from later code, and both identities are recorded.
await fs.mkdir(stateRoot, { recursive: true });
const stateIdentityPath = path.join(stateRoot, "identity.json");
const database = new URL(databaseUrl);
const stateIdentity = await fs
  .readFile(stateIdentityPath, "utf8")
  .then((text) => JSON.parse(text) as Record<string, unknown>)
  .catch(async () => {
    const identity = {
      prepared_by: source,
      stages,
      database: `${database.host}${database.pathname}`,
      model: args.model,
    };
    await fs.writeFile(stateIdentityPath, JSON.stringify(identity, null, 2));
    return identity;
  });
if (stateIdentity.database !== `${database.host}${database.pathname}`)
  throw new Error(
    `The state was indexed in ${String(stateIdentity.database)}; pass that database`,
  );
if (JSON.stringify(stateIdentity.stages) !== JSON.stringify(stages))
  throw new Error(
    `The state was prepared with stages ${String(stateIdentity.stages)}; use the same --skip-nightly or another --state`,
  );
await fs.writeFile(
  manifestPath,
  JSON.stringify(
    {
      fixed,
      source,
      state: stateIdentity,
      arms,
      rounds,
      started_at: new Date().toISOString(),
    },
    null,
    2,
  ),
);

const productGateway = createGatewayModelCall({
  model: args.model,
  concurrency,
});
const judgeGateway = createGatewayModelCall({
  model: args["judge-model"],
  concurrency,
});
await calibrateJudge(judgeGateway.modelCall, plan.benchmark);
console.log(`Judge ${args["judge-model"]} passed its known-answer controls`);

const product = await openProduct({
  dataRoot: path.join(stateRoot, "memory"),
  databaseUrl,
  modelCall: productGateway.modelCall,
  nightly,
  nightlyConcurrency: Number(args["nightly-concurrency"]),
});

interface StoredAnswer {
  case_id: string;
  arm: Arm;
  round: number;
  type: string;
  unanswerable: boolean;
  question: string;
  gold: string;
  record?: AnswerRecord;
  judgment?: Judgment;
  error?: string;
  source: typeof source;
}

const answerPath = (arm: Arm, round: number, item: Case) =>
  path.join(
    out,
    "answers",
    arm,
    `r${round}`,
    `${item.id.replaceAll(":", "_")}.json`,
  );

async function runOne(arm: Arm, round: number, item: Case) {
  const file = answerPath(arm, round, item);
  const stored = await fs
    .readFile(file, "utf8")
    .then((text) => JSON.parse(text) as StoredAnswer)
    .catch(() => undefined);
  if (stored && !(stored.error && args["retry-errors"])) return;
  const result: StoredAnswer = {
    case_id: item.id,
    arm,
    round,
    type: item.type,
    unanswerable: item.unanswerable,
    question: item.question,
    gold: item.answer,
    source,
  };
  try {
    result.record = await answerQuestion({
      item,
      arm,
      ...(arm === "none"
        ? {}
        : { prepared: await product.prepare(item.corpus) }),
      product,
      model: args.model,
    });
    result.judgment = await judge(
      judgeGateway.modelCall,
      `${arm}:${round}:${item.id}`,
      judgePrompt(item, result.record.answer),
    );
  } catch (error) {
    // Bounded: the gateway calls already retried; the question is recorded as
    // failed and the run moves on. --retry-errors runs it again.
    result.error = error instanceof Error ? error.message : String(error);
    console.error(
      `ERROR ${arm} r${round} ${item.id}: ${result.error.slice(0, 300)}`,
    );
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(result, null, 2));
}

// Prepare each history once before answering on it; a failed history fails
// its questions and the others go on.
const corpora = [
  ...new Map(cases.map((item) => [item.corpus.id, item.corpus])).values(),
];
let preparedCount = 0;
const prepared = (
  await Promise.all(
    (arms.some((arm) => arm !== "none") ? corpora : []).map(async (corpus) => {
      const started = performance.now();
      try {
        const result = await product.prepare(corpus);
        console.log(
          `Prepared history ${++preparedCount}/${corpora.length} (${corpus.sessions.length} sessions) in ${((performance.now() - started) / 1000).toFixed(0)} s`,
        );
        return result;
      } catch (error) {
        console.error(
          `ERROR preparing ${corpus.id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return undefined;
      }
    }),
  )
).filter((item): item is PreparedCorpus => Boolean(item));

const work =
  rounds && arms.length
    ? Array.from({ length: rounds }, (_, index) => index + 1).flatMap((round) =>
        arms.flatMap((arm) =>
          cases.map((item) => () => runOne(arm, round, item)),
        ),
      )
    : [];
let done = 0;
const workers = Array.from(
  { length: Math.min(concurrency, work.length) },
  async () => {
    for (let next = work.shift(); next; next = work.shift()) {
      await next();
      done += 1;
      if (done % 10 === 0) console.log(`Answered ${done}`);
    }
  },
);
await Promise.all(workers);
await product.close();

// Report.
async function readAnswers(directory: string): Promise<StoredAnswer[]> {
  const answers: StoredAnswer[] = [];
  const root = path.join(directory, "answers");
  for (const arm of await fs.readdir(root).catch(() => []))
    for (const round of await fs.readdir(path.join(root, arm)))
      for (const file of await fs.readdir(path.join(root, arm, round)))
        answers.push(
          JSON.parse(
            await fs.readFile(path.join(root, arm, round, file), "utf8"),
          ) as StoredAnswer,
        );
  return answers;
}

interface ArmSummary {
  rounds: number[];
  mean: number;
  min: number;
  max: number;
  errors: number;
  by_type: Record<string, number>;
  tokens: { prompt: number; completion: number };
  seconds_per_answer: number;
  tool_calls_per_answer: number;
}

function summarize(
  answers: StoredAnswer[],
  cases: number,
): Record<string, ArmSummary> {
  const result: Record<string, ArmSummary> = {};
  for (const arm of [...new Set(answers.map((answer) => answer.arm))].sort()) {
    const own = answers.filter((answer) => answer.arm === arm);
    const roundNumbers = [...new Set(own.map((answer) => answer.round))].sort();
    const accuracy = roundNumbers.map(
      (round) =>
        own.filter(
          (answer) => answer.round === round && answer.judgment?.correct,
        ).length / cases,
    );
    const types = [...new Set(own.map((answer) => answer.type))].sort();
    const answered = own.filter((answer) => answer.record);
    result[arm] = {
      rounds: accuracy,
      mean: accuracy.reduce((sum, value) => sum + value, 0) / accuracy.length,
      min: Math.min(...accuracy),
      max: Math.max(...accuracy),
      errors: own.filter((answer) => answer.error).length,
      by_type: Object.fromEntries(
        types.map((type) => {
          const typed = own.filter((answer) => answer.type === type);
          return [
            type,
            typed.filter((answer) => answer.judgment?.correct).length /
              typed.length,
          ];
        }),
      ),
      tokens: {
        prompt: answered.reduce(
          (sum, answer) => sum + answer.record!.usage.prompt,
          0,
        ),
        completion: answered.reduce(
          (sum, answer) => sum + answer.record!.usage.completion,
          0,
        ),
      },
      seconds_per_answer:
        answered.reduce((sum, answer) => sum + answer.record!.seconds, 0) /
        Math.max(1, answered.length),
      tool_calls_per_answer:
        answered.reduce(
          (sum, answer) => sum + answer.record!.tool_calls.length,
          0,
        ) / Math.max(1, answered.length),
    };
  }
  return result;
}

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const summary = {
  plan: args.plan,
  cases: cases.length,
  source,
  state: stateIdentity,
  prepared: {
    histories: prepared.length,
    raw_sources: prepared.reduce((sum, item) => sum + item.raw_sources, 0),
    indexed_chunks: prepared.reduce(
      (sum, item) => sum + item.indexed_chunks,
      0,
    ),
    nights: prepared.reduce((sum, item) => sum + item.nights, 0),
    failed_wiki_nights: prepared.reduce(
      (sum, item) => sum + item.failed_wiki_nights,
      0,
    ),
    failed_day_reads: prepared.reduce(
      (sum, item) => sum + item.failed_day_reads,
      0,
    ),
    wiki_pages: prepared.reduce((sum, item) => sum + item.wiki_pages, 0),
    dailies: prepared.reduce((sum, item) => sum + item.dailies, 0),
    seconds: prepared.reduce((sum, item) => sum + item.seconds, 0),
  },
  model_usage: {
    preparation: productGateway.usage,
    judge: judgeGateway.usage,
  },
  arms: summarize(await readAnswers(out), cases.length),
};
const baseline = args.baseline
  ? (JSON.parse(
      await fs.readFile(
        path.join(path.resolve(args.baseline), "summary.json"),
        "utf8",
      ),
    ) as typeof summary)
  : undefined;
await fs.writeFile(
  path.join(out, "summary.json"),
  JSON.stringify(summary, null, 2),
);

const lines = [
  `# Memory benchmark: ${args.plan}`,
  "",
  `- Checkout: \`${source.commit.slice(0, 12)}\`${source.dirty_sha256 ? ` + uncommitted \`${source.dirty_sha256.slice(0, 12)}\`` : ""}`,
  `- History prepared by: \`${String((stateIdentity.prepared_by as { commit?: string })?.commit ?? "").slice(0, 12)}\`, stages ${stages.join(", ")}`,
  `- ${cases.length} questions, ${prepared.length} histories, answer model ${args.model}, judge ${args["judge-model"]} (${JUDGE_PROTOCOL})`,
  `- Preparation: ${summary.prepared.nights} nights (${summary.prepared.failed_wiki_nights} Wiki and ${summary.prepared.failed_day_reads} day-read failures skipped), ${summary.prepared.wiki_pages} Wiki pages, ${summary.prepared.dailies} Dailies`,
  "",
  "| Arm | Rounds | Mean | Min–max | Errors | Tool calls / answer | Seconds / answer |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  ...Object.entries(summary.arms).map(
    ([arm, value]) =>
      `| ${arm} | ${value.rounds.map(percent).join(", ")} | ${percent(value.mean)} | ${percent(value.min)}–${percent(value.max)} | ${value.errors} | ${value.tool_calls_per_answer.toFixed(1)} | ${value.seconds_per_answer.toFixed(1)} |`,
  ),
  "",
  "## By question type (all rounds)",
  "",
  "| Arm | Type | Accuracy | Baseline |",
  "| --- | --- | --- | --- |",
  ...Object.entries(summary.arms).flatMap(([arm, value]) =>
    Object.entries(value.by_type).map(
      ([type, accuracy]) =>
        `| ${arm} | ${type} | ${percent(accuracy)} | ${baseline?.arms[arm]?.by_type[type] !== undefined ? percent(baseline.arms[arm].by_type[type]) : "—"} |`,
    ),
  ),
];
if (baseline)
  lines.push(
    "",
    `## Against ${path.resolve(args.baseline!)}`,
    "",
    "| Arm | This run | Baseline | Difference | Baseline min–max |",
    "| --- | --- | --- | --- | --- |",
    ...Object.entries(summary.arms).map(([arm, value]) => {
      const other = baseline.arms[arm];
      return other
        ? `| ${arm} | ${percent(value.mean)} | ${percent(other.mean)} | ${((value.mean - other.mean) * 100).toFixed(1)} pt | ${percent(other.min)}–${percent(other.max)} |`
        : `| ${arm} | ${percent(value.mean)} | — | — | — |`;
    }),
  );
await fs.writeFile(path.join(out, "report.md"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
console.log(`\nWrote ${path.join(out, "report.md")}`);
