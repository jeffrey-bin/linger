// Replays one memo_eval corpus night by night through the new nightly memory
// pipeline and measures it: the Wiki refresh (AgentWikiBackend), the day read
// (memory.md and Daily from the raw conversations) and Tracking Items. Weekly
// is unchanged by the redesign, so both arms leave it out. Steps run one
// after another so every model call is counted against its night and step.
// The final Wiki and the Dailies are written into the state the way memo_eval
// reads them, so memo_eval can answer
// its questions from them. Run it on a copy of a prepared state, one corpus
// per process. Model calls go to local Codex as the Daemon makes them, or to
// the LLM gateway. Usage (from apps/node-services):
//   node --env-file=<.env> --import tsx scripts/night-benchmark.ts \
//     --state <copy of memo_eval .runtime/<state>> --corpus <sha prefix> \
//     --out <dir> [--human-name user|@title] [--runtime codex|claude|gateway] \
//     [--model <id>] [--concurrency 3] [--nights N]
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { JsonLogger } from "@linger/service-kit/node";

import { AgentWikiBackend } from "../src/llm-wiki/agent-wiki-backend.js";
import type { WikiInput } from "../src/llm-wiki/backend.js";
import { setWikiLogger } from "../src/llm-wiki/log.js";
import { renderSessionSource } from "../src/llm-wiki/wiki-session-source.js";
import { collectAndPersistDaily } from "../src/memory/daily-cli.js";
import { runDayRead } from "../src/memory/day-read.js";
import { setMemoryModelCall } from "../src/memory/llm.js";
import { setMemoryLogger } from "../src/memory/run-telemetry.js";
import {
  updateTrackingItems,
  type TrackingItem,
  type TrackingItemStore,
} from "../src/memory/tracking-items.js";
import type { AnotherMeSubject } from "../src/memory/types.js";
import {
  renderUserMemory,
  type UserMemoryRevision,
  type UserMemoryStore,
} from "../src/memory/user-memory.js";
import type { ModelCall } from "../src/runtime-model-call.js";
import { createCodexModelCall } from "./codex-model-call.js";
import { createClaudeModelCall } from "./claude-model-call.js";
import { createGatewayModelCall } from "./gateway-model-call.js";

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2)
  args.set(
    process.argv[index]!.replace(/^--/u, ""),
    process.argv[index + 1] ?? "",
  );
const state = path.resolve(args.get("state") ?? "");
const corpusPrefix = args.get("corpus") ?? "";
const out = path.resolve(args.get("out") ?? "");
if (!args.get("state") || !corpusPrefix || !args.get("out"))
  throw new Error("--state, --corpus and --out are required");
const runtime = args.get("runtime") ?? "codex";
const humanName = args.get("human-name") ?? "user";
const concurrency = Number(args.get("concurrency") ?? 3);
const dataRoot = path.join(state, "linger", "data");

const sha = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

interface Usage {
  calls: number;
  failed: number;
  input: number;
  cached: number;
  output: number;
  reasoning: number;
}

// Usage of the calls made since `mark()`, for either runtime.
let usageSince: () => () => Usage;
let modelCall: ModelCall;
let close = async () => {};
let modelName: string;
if (runtime === "codex") {
  modelName = args.get("model") ?? "gpt-6-astra";
  const codex = await createCodexModelCall({
    model: modelName,
    concurrency,
    maxTimeoutMs: 6 * 60_000,
  });
  modelCall = codex.modelCall;
  close = codex.close;
  usageSince = () => {
    const from = codex.records.length;
    return () => {
      const calls = codex.records.slice(from);
      return {
        calls: calls.length,
        failed: calls.filter((call) => !call.ok).length,
        input: calls.reduce((sum, call) => sum + call.inputTokens, 0),
        cached: calls.reduce((sum, call) => sum + call.cachedTokens, 0),
        output: calls.reduce((sum, call) => sum + call.outputTokens, 0),
        reasoning: calls.reduce((sum, call) => sum + call.reasoningTokens, 0),
      };
    };
  };
} else if (runtime === "claude") {
  // Claude Code as the Daemon's Claude runtime runs it, on the LLM gateway.
  modelName = args.get("model") ?? "openrouter/claude-sonnet-5.5";
  const claude = await createClaudeModelCall({
    model: modelName,
    concurrency,
    maxTimeoutMs: 6 * 60_000,
  });
  modelCall = claude.modelCall;
  close = claude.close;
  usageSince = () => {
    const from = claude.records.length;
    return () => {
      const calls = claude.records.slice(from);
      return {
        calls: calls.length,
        failed: calls.filter((call) => !call.ok).length,
        input: calls.reduce((sum, call) => sum + call.inputTokens, 0),
        cached: calls.reduce((sum, call) => sum + call.cachedTokens, 0),
        output: calls.reduce((sum, call) => sum + call.outputTokens, 0),
        reasoning: 0,
      };
    };
  };
} else {
  modelName = args.get("model") ?? "openai/gpt-5.6-luna";
  const gateway = createGatewayModelCall({ model: modelName, concurrency });
  modelCall = gateway.modelCall;
  usageSince = () => {
    const from = { ...gateway.usage };
    return () => ({
      calls: gateway.usage.calls - from.calls,
      failed: gateway.usage.failures - from.failures,
      input: gateway.usage.prompt - from.prompt,
      cached: gateway.usage.cached - from.cached,
      output: gateway.usage.completion - from.completion,
      reasoning: 0,
    });
  };
}
setMemoryModelCall(() => modelCall);

interface Scope {
  tenant_id: string;
  user_artifact_owner_actor_id: string;
  agent_id: string;
  agent_actor_id: string;
  corpus_sha256: string;
}
const scopeDirectory = path.join(state, "preparation", "scopes");
let scope: Scope | undefined;
for (const file of await fs.readdir(scopeDirectory)) {
  const candidate = JSON.parse(
    await fs.readFile(path.join(scopeDirectory, file), "utf8"),
  ) as Scope;
  if (candidate.corpus_sha256.startsWith(corpusPrefix)) scope = candidate;
}
if (!scope) throw new Error(`No corpus ${corpusPrefix} in ${state}`);
const corpus = scope.corpus_sha256;
const work = path.join(out, corpus.slice(0, 8));
await fs.mkdir(work, { recursive: true });

const logFile = path.join(work, "log.jsonl");
const logger: JsonLogger = {
  log: (level: string, event: string, fields: Record<string, unknown> = {}) => {
    void fs.appendFile(
      logFile,
      `${JSON.stringify({ time: new Date().toISOString(), level, event, ...fields })}\n`,
    );
  },
  child: () => logger,
};
setWikiLogger(logger);
setMemoryLogger(logger);

const epochs = await fs.readdir(path.join(dataRoot, "wiki-fixtures"));
if (epochs.length !== 1)
  throw new Error("The state needs exactly one Wiki epoch");
const epochRoot = path.join(dataRoot, "wiki-fixtures", epochs[0]!);
const evidence = path.join(
  dataRoot,
  scope.agent_id,
  "memory-state",
  "evidence",
);
const dates: string[] = [];
for (const date of (await fs.readdir(evidence))
  .filter((name) => /^\d{4}-\d{2}-\d{2}$/u.test(name))
  .sort()) {
  const sessions = await fs
    .readdir(path.join(evidence, date, "sessions"))
    .catch(() => []);
  if (sessions.some((name) => name.endsWith(".md"))) dates.push(date);
}
// `--nights N` replays only the first N nights, for a smoke run.
dates.splice(Number(args.get("nights") ?? dates.length));

const MESSAGE_HEADING = /^## \d{4}-\d{2}-\d{2}T[\d:.]+Z · .+$/u;

/** One date's Room-day Session Evidence as the Wiki generator's inputs. */
async function stageDay(date: string, inputs: string): Promise<WikiInput[]> {
  const directory = path.join(evidence, date, "sessions");
  const added: WikiInput[] = [];
  for (const file of (await fs.readdir(directory))
    .filter((name) => name.endsWith(".md"))
    .sort()) {
    const room = file.slice(0, -3);
    const evidence = await fs.readFile(path.join(directory, file), "utf8");
    const title = /^title: "?(.*?)"?$/mu.exec(evidence)?.[1] ?? room;
    const lines = (
      evidence.split("## Authoritative Raw Evidence")[1] ?? ""
    ).split("\n");
    let messages = 0;
    const raw: string[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      raw.push(lines[index]!);
      if (MESSAGE_HEADING.test(lines[index]!) && lines[index + 1] === "") {
        raw.push(
          "",
          `Message metadata: ${JSON.stringify({ message_id: `m${String(++messages).padStart(4, "0")}` })}`,
        );
        index += 1;
      }
    }
    if (messages === 0) continue;
    const { markdown, routing } = renderSessionSource(title, raw.join("\n"), {
      kind: "room",
      date,
      sessionId: room,
      roomId: room,
      representedHumanActorId: scope!.user_artifact_owner_actor_id,
      representedHumanDisplayName: humanName === "@title" ? title : humanName,
    });
    await fs.mkdir(path.join(inputs, room), { recursive: true });
    await fs.writeFile(path.join(inputs, room, "document.md"), markdown);
    added.push({
      assetKey: room,
      contentPath: `${room}/document.md`,
      contentSha256: sha(markdown),
      sourceUrl: `document://${room}/versions/${date}`,
      title,
      session: routing,
    });
  }
  return added;
}

/** Pages in memo_eval's order (bridges/wiki-fixture.mjs readPages). */
async function readPages(
  directory: string,
): Promise<{ key: string; content: string }[]> {
  const pages: { key: string; content: string }[] = [];
  const visit = async (root: string) => {
    for (const entry of (await fs.readdir(root, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const file = path.join(root, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.name.endsWith(".md"))
        pages.push({
          key: path.relative(directory, file).split(path.sep).join("/"),
          content: await fs.readFile(file, "utf8"),
        });
    }
  };
  await visit(directory);
  return pages;
}

/** Runs a step with bounded retries; a step that still fails is skipped. */
async function step<T>(
  label: string,
  work: () => Promise<T>,
): Promise<{
  ok: boolean;
  seconds: number;
  usage: Usage;
  value?: T;
  error?: string;
}> {
  const started = performance.now();
  const usage = usageSince();
  for (let attempt = 1; ; attempt += 1) {
    try {
      const value = await work();
      return {
        ok: true,
        seconds: (performance.now() - started) / 1000,
        usage: usage(),
        value,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const disposition = (error as { disposition?: string }).disposition;
      if (attempt >= 2 || disposition === "terminal") {
        console.log(
          `  FAILED ${corpus.slice(0, 8)} ${label}: ${message.slice(0, 300)}`,
        );
        logger.log("error", "benchmark.step_failed", {
          label,
          error: message.slice(0, 2000),
        });
        return {
          ok: false,
          seconds: (performance.now() - started) / 1000,
          usage: usage(),
          error: message.slice(0, 500),
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 15_000));
    }
  }
}

// Stand-ins for TeamHub's stores, kept in memory for the whole replay.
const revisions: UserMemoryRevision[] = [];
const memoryStore: UserMemoryStore = {
  latest: async () => revisions.at(-1) ?? null,
  save: async (_owner, _base, next) => {
    const revision = {
      version: revisions.length + 1,
      sections: next.sections,
      baseProfileRevisionId: next.baseProfileRevisionId,
    };
    revisions.push(revision);
    return revision;
  },
};
const tracking = new Map<string, TrackingItem>();
let trackingIds = 0;
const trackingStore: TrackingItemStore = {
  list: async () => [...tracking.values()],
  apply: async (_owner, changes) => {
    const now = new Date().toISOString();
    const items: TrackingItem[] = [];
    for (const create of changes.create) {
      const { idempotency_key: _key, ...fields } = create;
      const item: TrackingItem = {
        ...fields,
        id: `t${++trackingIds}`,
        status: "open",
        created_at: now,
        updated_at: now,
        revision: 1,
        routines: [],
      };
      tracking.set(item.id, item);
      items.push(item);
    }
    for (const update of changes.update) {
      const current = tracking.get(update.id);
      if (!current) continue;
      const { expected_revision: _revision, ...fields } = update;
      const item = {
        ...current,
        ...fields,
        updated_at: now,
        revision: current.revision + 1,
      };
      tracking.set(item.id, item);
      items.push(item);
    }
    for (const removed of changes.delete) tracking.delete(removed.id);
    return { items, deleted: changes.delete.map((removed) => removed.id) };
  },
  plan: async () => undefined,
};

let displayName = humanName;
if (humanName === "@title") {
  const first = path.join(evidence, dates[0]!, "sessions");
  const file = (await fs.readdir(first)).find((name) => name.endsWith(".md"))!;
  displayName =
    /^title: "?(.*?)"?$/mu.exec(
      await fs.readFile(path.join(first, file), "utf8"),
    )?.[1] ?? "user";
}
const subject: AnotherMeSubject = {
  tenantId: scope.tenant_id,
  agentActorId: scope.agent_actor_id,
  agentManagementId: scope.agent_id,
  agentDisplayName: "Another Me",
  representedHumanActorId: scope.user_artifact_owner_actor_id,
  representedHumanDisplayName: displayName,
  representedHumanAccountId: null,
  memorySubjectKey: scope.agent_id,
};
const owner = {
  tenantId: subject.tenantId,
  ownerActorId: subject.representedHumanActorId,
};
const backend = new AgentWikiBackend({ modelCall: () => modelCall });

const nights = path.join(work, "nights.jsonl");
await fs.rm(nights, { force: true });
const started = performance.now();
let wiki = path.join(work, "wiki-empty");
await fs.mkdir(wiki, { recursive: true });
for (const [index, date] of dates.entries()) {
  const next = path.join(work, `wiki-${date}`);
  const inputs = path.join(work, `inputs-${date}`);
  await fs.rm(inputs, { recursive: true, force: true });
  const added = await stageDay(date, inputs);
  const wikiStep = await step(`wiki ${date}`, async () => {
    await fs.rm(next, { recursive: true, force: true });
    return backend.generate({
      changes: { added, modified: [], removed: [] },
      generator: {
        tenantId: scope.tenant_id,
        agentActorId: scope.agent_actor_id,
      },
      existingOutputDirectory: wiki,
      inputsDirectory: inputs,
      mode: index === 0 ? "initialize" : "update",
      outputDirectory: next,
      generationId: `night-${date}`,
    });
  });
  if (!wikiStep.ok) {
    await fs.rm(next, { recursive: true, force: true });
    await fs.cp(wiki, next, { recursive: true });
  }
  wiki = next;
  const options = {
    date,
    memoryRoot: dataRoot,
    memorySubjectKey: scope.agent_id,
    concurrency: 1,
    subject,
  };
  const collection = await collectAndPersistDaily(options, false);
  const dayRead = await step(`day-read ${date}`, () =>
    runDayRead(options, collection, memoryStore),
  );
  const trackingStep = await step(`tracking ${date}`, () =>
    updateTrackingItems(
      {
        owner,
        humanName: displayName,
        date,
        sessions: collection.sessionFiles,
      },
      trackingStore,
    ),
  );
  const night: Record<string, unknown> = {
    date,
    sources: added.length,
    wiki: { ...wikiStep, value: undefined },
    dayRead: { ...dayRead, value: dayRead.value },
    tracking: { ...trackingStep, value: trackingStep.value },
    pages: (await readPages(next)).length,
    memoryVersion: revisions.length,
    trackingOpen: [...tracking.values()].filter(
      (item) => item.status === "open",
    ).length,
  };
  await fs.appendFile(nights, `${JSON.stringify(night)}\n`);
  await fs.rm(inputs, { recursive: true, force: true });
  console.log(
    `${corpus.slice(0, 8)} ${date} (${index + 1}/${dates.length}): wiki ${Math.round(wikiStep.seconds)}s, day-read ${Math.round(dayRead.seconds)}s, tracking ${Math.round(trackingStep.seconds)}s`,
  );
}

// Outputs for comparison, and the final Wiki in place of the fixture's pages.
await fs.writeFile(
  path.join(work, "memory.md"),
  renderUserMemory(revisions.at(-1)?.sections ?? ({} as never)),
);
await fs.writeFile(
  path.join(work, "tracking.json"),
  JSON.stringify([...tracking.values()], null, 2),
);
await fs.rm(path.join(work, "wiki"), { recursive: true, force: true });
await fs.cp(wiki, path.join(work, "wiki"), { recursive: true });
const fixtureRoot = path.join(epochRoot, corpus);
const previous = JSON.parse(
  await fs.readFile(path.join(fixtureRoot, "fixture.json"), "utf8"),
) as Record<string, unknown>;
const roomSessions = new Map<string, string[]>();
for (const [page, sessions] of Object.entries(
  previous.page_to_sessions as Record<string, string[]>,
)) {
  const room = /^sessions\/[^/]+\/([^/]+)\.md$/u.exec(page)?.[1];
  if (room) roomSessions.set(`teamhub://rooms/${room}/messages`, sessions);
}
const output = path.join(fixtureRoot, "workspace", "openwiki");
await fs.rm(output, { recursive: true, force: true });
await fs.cp(wiki, output, { recursive: true });
const pages = await readPages(output);
const seconds = (performance.now() - started) / 1000;
await fs.writeFile(
  path.join(fixtureRoot, "fixture.json"),
  JSON.stringify({
    ...previous,
    identity: {
      ...(previous.identity as object),
      wiki_generator: "memory-agent",
      wiki_generation_model: modelName,
    },
    revision: sha(
      JSON.stringify(pages.map((page) => [page.key, sha(page.content)])),
    ),
    generation: [],
    input_protocol: "memory_agent_nightly_v1",
    generation_seconds: seconds,
    missing_session_targets: [],
    page_hashes: Object.fromEntries(
      pages.map((page) => [page.key, sha(page.content)]),
    ),
    page_to_sessions: Object.fromEntries(
      pages.map((page) => [
        page.key,
        [
          ...new Set(
            [...roomSessions]
              .filter(([url]) => page.content.includes(url))
              .flatMap(([, ids]) => ids),
          ),
        ],
      ]),
    ),
  }),
);
await fs.writeFile(
  path.join(work, "summary.json"),
  JSON.stringify(
    {
      corpus,
      arm: "new",
      runtime,
      model: modelName,
      dates: dates.length,
      pages: pages.length,
      seconds,
    },
    null,
    2,
  ),
);
await close();
console.log(
  `${corpus.slice(0, 8)} done: ${dates.length} nights, ${pages.length} pages, ${Math.round(seconds)} s`,
);
