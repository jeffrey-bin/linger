// Shared product plumbing for the benchmark (product.ts) and the lifecycle
// run (lifecycle.ts): one Memory index over a disposable database, Wiki
// generation, publication into the index, the Agent's knowledge search/read
// handlers, and bounded steps.
import fs from "node:fs/promises";
import path from "node:path";

import type { JsonLogger } from "@linger/service-kit/node";
import type {
  PersonalKnowledgeEvidenceReadResponse,
  PersonalKnowledgeQueryResponse,
} from "@linger/wire-contracts/node-services-internal/client";
import postgres from "postgres";

import { AgentWikiBackend } from "../../src/llm-wiki/agent-wiki-backend.js";
import { setWikiLogger } from "../../src/llm-wiki/log.js";
import { MemoryChunkIndex } from "../../src/memory/chunk-index.js";
import {
  queryPersonalKnowledge,
  readPersonalKnowledgeEvidence,
} from "../../src/memory/knowledge-query.js";
import { closeMemoryDatabase } from "../../src/memory/database.js";
import { setMemoryModelCall } from "../../src/memory/llm.js";
import { parseMemoryMarkdown } from "../../src/memory/markdown.js";
import { setMemoryLogger } from "../../src/memory/run-telemetry.js";
import {
  periodReportSource,
  type SourceIdentity,
  wikiPageRawSource,
} from "../../src/memory/search/source-store.js";
import { SessionFactIndex } from "../../src/memory/session-fact-index.js";
import type { ModelCall } from "../../src/runtime-model-call.js";
import { sha256 } from "./datasets.js";

/** The identities one Another Me's knowledge is stored under. */
export interface Scope {
  tenant_id: string;
  user_artifact_owner_actor_id: string;
  agent_id: string;
  agent_actor_id: string;
}

export interface SearchInput {
  query: string;
  alternates?: string[];
  dateFrom?: string;
  dateTo?: string;
  eventFrom?: string;
  eventTo?: string;
}

export interface ReadInput {
  evidenceId: string;
  sectionIds: string[];
  offset?: number;
}

/** The Agent's `teamhub knowledge search` / `read` over one scope. */
export interface Knowledge {
  search(
    scope: Scope,
    input: SearchInput,
  ): Promise<PersonalKnowledgeQueryResponse>;
  read(
    scope: Scope,
    input: ReadInput,
  ): Promise<PersonalKnowledgeEvidenceReadResponse>;
}

export interface MemoryWorkspace extends Knowledge {
  /** The disposable database, for seeding what TeamHub would hold. */
  sql: postgres.Sql;
  index: MemoryChunkIndex;
  facts: SessionFactIndex;
  wikiBackend: AgentWikiBackend;
  close(): Promise<void>;
}

/**
 * Memory over one data root and a disposable PostgreSQL database that
 * TeamHub's migrations created; model calls go to `modelCall` and logs to
 * `<dataRoot>/log.jsonl`.
 */
export async function openMemoryWorkspace(options: {
  dataRoot: string;
  databaseUrl: string;
  modelCall: ModelCall;
}): Promise<MemoryWorkspace> {
  const url = new URL(options.databaseUrl);
  if (
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !/^\/memory_benchmark(_\w+)?$/u.test(url.pathname)
  )
    throw new Error(
      "The benchmark writes only to a localhost memory_benchmark* database",
    );
  // Memory code that reads TeamHub's views on its own (Pocket Notes, for
  // one) uses this database too, never the one the root .env names.
  process.env.TEAMHUB_DATABASE_URL = options.databaseUrl;
  const sql = postgres(options.databaseUrl, {
    max: 10,
    onnotice: () => undefined,
  });
  const [schema] = await sql<{ name: string | null }[]>`
    SELECT to_regnamespace('memory_index')::text AS name`;
  if (!schema?.name) {
    await sql.end();
    throw new Error(
      "The database has no memory_index schema; run TeamHub migrations on it first",
    );
  }
  const { dataRoot } = options;
  await fs.mkdir(dataRoot, { recursive: true });
  const logFile = path.join(dataRoot, "log.jsonl");
  const logger: JsonLogger = {
    log: (level, event, fields = {}) =>
      void fs.appendFile(
        logFile,
        `${JSON.stringify({ time: new Date().toISOString(), level, event, ...fields })}\n`,
      ),
    child: () => logger,
  };
  setMemoryLogger(logger);
  setWikiLogger(logger);
  setMemoryModelCall(() => options.modelCall);
  const index = new MemoryChunkIndex({ dataRoot, sql });
  const facts = new SessionFactIndex({ sql });
  index.factIndex = facts;
  return {
    index,
    facts,
    wikiBackend: new AgentWikiBackend({ modelCall: () => options.modelCall }),
    search: (scope, input) =>
      // As POST /internal/v1/query passes the request on.
      queryPersonalKnowledge(
        dataRoot,
        {
          ...scope,
          query: input.query,
          ...(input.alternates?.length ? { alternates: input.alternates } : {}),
          ...(input.dateFrom ? { date_from: input.dateFrom } : {}),
          ...(input.dateTo ? { date_to: input.dateTo } : {}),
          ...(input.eventFrom ? { event_from: input.eventFrom } : {}),
          ...(input.eventTo ? { event_to: input.eventTo } : {}),
        },
        { chunkSearch: index },
      ),
    read: (scope, input) =>
      readPersonalKnowledgeEvidence(
        dataRoot,
        {
          ...scope,
          evidence_id: input.evidenceId,
          section_requests: input.sectionIds.map((sectionId) => ({
            section_id: sectionId,
            ...(input.offset !== undefined ? { offset: input.offset } : {}),
          })),
        },
        { rawSourceProvider: index },
      ),
    sql,
    async close() {
      await index.close();
      await sql.end({ timeout: 5 });
      await closeMemoryDatabase();
    },
  };
}

export function identityOf(scope: Scope): SourceIdentity {
  return {
    agent_id: scope.agent_id,
    tenant_id: scope.tenant_id,
    user_artifact_owner_actor_id: scope.user_artifact_owner_actor_id,
  };
}

/**
 * Whether a published page is searched: the rule of `searchableWikiPage` in
 * src/memory/wiki-index.ts, which keeps navigation and empty pages out of
 * search. Keep the two the same.
 */
function searchableWikiPage(key: string, content: string): boolean {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, "");
  return (
    !/(?:^|\/)(?:index|readme|log|instructions)\.md$/iu.test(key) &&
    Boolean(body.trim())
  );
}

/**
 * Publishes a generated Wiki into the index as TeamHub's publication job
 * does: every page a source, navigation and empty pages not searchable, and
 * pages no longer in the Wiki retired. Returns the searchable page count.
 */
export async function indexWikiPages(
  index: MemoryChunkIndex,
  scope: Scope,
  pages: readonly { key: string; content: string }[],
  /** When a page was published, as an ISO time. */
  publishedAt: (key: string) => string,
): Promise<number> {
  const identity = identityOf(scope);
  const revision = sha256(
    JSON.stringify(pages.map((page) => [page.key, sha256(page.content)])),
  );
  const kept: string[] = [];
  let searchable = 0;
  for (const page of pages) {
    const isSearchable = searchableWikiPage(page.key, page.content);
    if (isSearchable) searchable += 1;
    const source = wikiPageRawSource({
      identity,
      pageKey: page.key,
      title: parseMemoryMarkdown(page.content).title,
      documentId: `wiki_${sha256(page.key).slice(0, 32)}`,
      documentVersionId: `wiki_${sha256(page.content).slice(0, 32)}`,
      publishedAt: publishedAt(page.key),
      revision,
      markdown: page.content,
    });
    kept.push(source.id);
    await index.indexDatabaseSource(source, page.content, {
      searchable: isSearchable,
    });
  }
  await index.retireDatabaseSources(identity, "wiki", kept);
  return searchable;
}

/** Indexes one collection's Daily or Weekly reports, as the report index does. */
export async function indexReports(
  index: MemoryChunkIndex,
  scope: Scope,
  collection: "daily" | "weekly",
  reports: readonly { periodStart: string; content: string }[],
): Promise<void> {
  const identity = identityOf(scope);
  const kept: string[] = [];
  for (const report of reports) {
    const source = periodReportSource({
      identity,
      collection,
      periodStart: report.periodStart,
      title: parseMemoryMarkdown(report.content).title,
      markdown: report.content,
    });
    kept.push(source.id);
    await index.indexDatabaseSource(source, report.content);
  }
  await index.retireDatabaseSources(
    identity,
    "period_summary",
    kept,
    collection,
  );
}

/** The dated reports of one `timeline/<collection>` directory. */
export async function readReports(
  directory: string,
): Promise<{ periodStart: string; content: string }[]> {
  const reports: { periodStart: string; content: string }[] = [];
  for (const name of (await fs.readdir(directory).catch(() => [])).sort())
    if (/^\d{4}-\d{2}-\d{2}\.md$/u.test(name))
      reports.push({
        periodStart: name.slice(0, 10),
        content: await fs.readFile(path.join(directory, name), "utf8"),
      });
  return reports;
}

/** Every Markdown page of a generated Wiki, by its relative path. */
export async function readPages(
  directory: string,
): Promise<{ key: string; content: string }[]> {
  const pages: { key: string; content: string }[] = [];
  const visit = async (root: string) => {
    for (const entry of (
      await fs.readdir(root, { withFileTypes: true }).catch(() => [])
    ).sort((a, b) => a.name.localeCompare(b.name))) {
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

export interface StepResult {
  ok: boolean;
  attempts: number;
  seconds: number;
  error?: string;
}

/** A step gets two attempts; one that still fails is skipped. */
const STEP_ATTEMPTS = 2;

/** Runs one product step with bounded attempts; it never throws. */
export async function step(work: () => Promise<unknown>): Promise<StepResult> {
  const started = performance.now();
  for (let attempt = 1; ; attempt += 1) {
    try {
      await work();
      return {
        ok: true,
        attempts: attempt,
        seconds: (performance.now() - started) / 1000,
      };
    } catch (error) {
      const terminal =
        (error as { disposition?: string }).disposition === "terminal";
      if (attempt >= STEP_ATTEMPTS || terminal) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`  ERROR step: ${message.slice(0, 300)}`);
        return {
          ok: false,
          attempts: attempt,
          seconds: (performance.now() - started) / 1000,
          error: message.slice(0, 500),
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 15_000));
    }
  }
}
