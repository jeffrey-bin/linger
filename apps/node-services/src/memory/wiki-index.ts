import fs from "node:fs/promises";
import path from "node:path";
import type postgres from "postgres";

import type { MemoryChunkIndex } from "./chunk-index.js";
import { loadAnotherMeSubjects } from "./collector.js";
import { memoryDatabase } from "./database.js";
import { parseMemoryMarkdown } from "./markdown.js";
import { pathExists } from "./fs-utils.js";
import { queryReadyMeetings } from "./ready-meetings.js";
import {
  publishMemoryWiki,
  type PublishedFile,
} from "./published-memory-files.js";
import { agentMemoryRoot, agentWorkspaceRoot } from "./paths.js";
import { memoryLogger, writeMemoryLog } from "./run-telemetry.js";
import {
  contentHash,
  periodReportSource,
  wikiPageRawSource,
  wikiPageSearchText,
  type SourceIdentity,
} from "./search/source-store.js";
import {
  downloadPublishedWikiPage,
  readPublishedWiki,
  teamHubWikiAccess,
  type TeamHubWikiAccess,
} from "./teamhub-wiki.js";
import type { AnotherMeSubject } from "./types.js";

export type WikiIndexCollection = "wiki" | "daily" | "weekly";

/** One page of the published Wiki as the index holds it. */
export interface IndexedWikiPage {
  key: string;
  title: string;
  content: string;
  metadata: Record<string, string>;
}

/**
 * Reads the Human's published Wiki as the index holds it. The revision names
 * the indexed page versions, so it changes whenever a page does.
 */
export async function readIndexedWiki(
  tenantId: string,
  ownerId: string,
  keys?: readonly string[],
  sql: postgres.Sql = memoryDatabase(),
): Promise<{ revision?: string; pages: IndexedWikiPage[] }> {
  const rows = await sql<
    { metadata: Record<string, string>; title: string; content: string }[]
  >`
    SELECT DISTINCT ON ((source.metadata->>'page_key') COLLATE "C")
      source.metadata, source.title, version.content
    FROM memory_index.sources source
    JOIN memory_index.source_versions version
      ON version.source_id = source.id AND version.sha256 = source.active_sha256
    WHERE source.tenant_id = ${tenantId}
      AND source.owner_id = ${ownerId}
      AND source.origin_kind = 'wiki'
      ${keys ? sql`AND source.metadata->>'page_key' = ANY(${[...keys]}::text[])` : sql``}
    ORDER BY (source.metadata->>'page_key') COLLATE "C", source.updated_at DESC, source.id
  `;
  const pages = rows.map((row) => ({
    key: row.metadata.page_key!,
    title: row.title,
    content: row.content,
    metadata: row.metadata,
  }));
  if (!pages.length) return { pages };
  return { revision: wikiRevision(pages), pages };
}

/** The revision of the Human's published Wiki the index holds. */
export async function indexedWikiRevision(
  tenantId: string,
  ownerId: string,
  sql: postgres.Sql = memoryDatabase(),
): Promise<string | undefined> {
  const rows = await sql<{ page_key: string; document_version_id: string }[]>`
    SELECT DISTINCT metadata->>'page_key' AS page_key,
      metadata->>'document_version_id' AS document_version_id
    FROM memory_index.sources
    WHERE tenant_id = ${tenantId} AND owner_id = ${ownerId}
      AND origin_kind = 'wiki' AND active_sha256 IS NOT NULL
  `;
  if (!rows.length) return undefined;
  return wikiRevision(
    rows.map((row) => ({
      key: row.page_key,
      metadata: { document_version_id: row.document_version_id },
    })),
  );
}

function wikiRevision(
  pages: readonly { key: string; metadata: Record<string, string> }[],
): string {
  return contentHash(
    JSON.stringify(
      pages
        .map((page) => [page.key, page.metadata.document_version_id ?? ""])
        .sort(([left], [right]) =>
          left! < right! ? -1 : left! > right! ? 1 : 0,
        ),
    ),
  );
}

type IndexSubject = Pick<
  AnotherMeSubject,
  "tenantId" | "agentManagementId" | "representedHumanActorId"
>;

/**
 * Navigation pages and empty pages are kept for the graph but not searched.
 */
function searchableWikiPage(key: string, content: string): boolean {
  return (
    !/(?:^|\/)(?:index|readme|log|instructions)\.md$/iu.test(key) &&
    Boolean(wikiPageSearchText(content).trim())
  );
}

function identityOf(subject: IndexSubject): SourceIdentity {
  return {
    agent_id: subject.agentManagementId,
    tenant_id: subject.tenantId,
    user_artifact_owner_actor_id: subject.representedHumanActorId,
  };
}

/**
 * Keeps the published Wiki and the Daily and Weekly reports in the one Raw
 * index, as sources of each of the Human's Another Mes. TeamHub's durable
 * publication job asks for each published Wiki revision and retries until it
 * is indexed; a report is indexed when it is written, and the Memory
 * scheduler's periodic reconciliation picks up any report the index still
 * lacks.
 */
export class WikiIndex {
  readonly #lanes = new Map<string, Promise<unknown>>();
  #stopped = false;
  readonly #controller = new AbortController();
  /** Automatic indexing skips an Another Me whose history rebuild is pending. */
  indexHold: (agentId: string) => boolean = () => false;

  constructor(
    private readonly chunks: Pick<
      MemoryChunkIndex,
      "indexDatabaseSource" | "retireDatabaseSources"
    >,
    private readonly dataRoot: string,
    private readonly access: TeamHubWikiAccess,
    private readonly sql: postgres.Sql = memoryDatabase(),
    private readonly loadSubjects: () => Promise<
      AnotherMeSubject[]
    > = loadAnotherMeSubjects,
  ) {}

  /**
   * Indexes the Human's published Wiki. A page whose Document Version the
   * index already holds is not downloaded again.
   */
  async indexWiki(tenantId: string, ownerId: string): Promise<void> {
    const subjects = (await this.loadSubjects()).filter(
      (subject) =>
        subject.tenantId === tenantId &&
        subject.representedHumanActorId === ownerId,
    );
    if (!subjects.length) return;
    await this.#inLane(`${tenantId}\n${ownerId}\nwiki`, async () => {
      const signal = this.#controller.signal;
      const wiki = await readPublishedWiki(this.access, ownerId, { signal });
      if (!wiki)
        throw new Error(
          "Published Wiki unavailable; refusing to infer deletion",
        );
      const indexed = await readIndexedWiki(
        tenantId,
        ownerId,
        undefined,
        this.sql,
      );
      const known = new Map(
        indexed.pages.map((page) => [
          page.metadata.document_version_id,
          page.content,
        ]),
      );
      const pages: { page: (typeof wiki.pages)[number]; content: string }[] =
        [];
      for (const page of wiki.pages) {
        signal.throwIfAborted();
        pages.push({
          page,
          content:
            known.get(page.documentVersionId) ??
            new TextDecoder().decode(
              await downloadPublishedWikiPage(
                this.access,
                ownerId,
                wiki.revision,
                page,
                signal,
              ),
            ),
        });
      }
      for (const subject of subjects) {
        const identity = identityOf(subject);
        let updated = 0;
        const kept: string[] = [];
        for (const { page, content } of pages) {
          if (!content) continue;
          const source = wikiPageRawSource({
            identity,
            pageKey: page.path,
            title: parseMemoryMarkdown(content).title,
            documentId: page.documentId,
            documentVersionId: page.documentVersionId,
            publishedAt: wiki.publishedAt,
            revision: wiki.revision,
            markdown: content,
          });
          kept.push(source.id);
          if (
            await this.chunks.indexDatabaseSource(source, content, {
              searchable: searchableWikiPage(page.path, content),
            })
          )
            updated++;
        }
        const deleted = await this.chunks.retireDatabaseSources(
          identity,
          "wiki",
          kept,
        );
        await this.#projectWiki(subject, pages);
        if (updated || deleted)
          memoryLogger().log("info", "memory.wiki_index_synced", {
            agent_id: subject.agentManagementId,
            revision: wiki.revision,
            pages: pages.length,
            updated,
            deleted,
          });
      }
    });
  }

  /** Indexes one Another Me's Daily or Weekly reports. */
  async indexReports(
    agentId: string,
    collection: "daily" | "weekly",
  ): Promise<void> {
    const subjects = (await this.loadSubjects()).filter(
      (subject) => subject.agentManagementId === agentId,
    );
    if (subjects.length !== 1)
      throw new Error("Report indexing requires exactly one Another Me scope");
    if (this.indexHold(agentId)) {
      writeMemoryLog("memory_rebuild_index_hold_skipped", {
        memory_subject_key: agentId,
        index: `reports:${collection}`,
      });
      return;
    }
    await this.#indexReportScope(subjects[0]!, collection);
  }

  /**
   * Indexes an owner's collections now; a Human without a published Wiki has
   * only reports to index.
   */
  async indexOwner(
    subject: IndexSubject,
    collections: readonly WikiIndexCollection[],
  ): Promise<void> {
    for (const collection of collections) {
      if (collection === "wiki") {
        if (
          await readPublishedWiki(this.access, subject.representedHumanActorId)
        )
          await this.indexWiki(
            subject.tenantId,
            subject.representedHumanActorId,
          );
        continue;
      }
      await this.#indexReportScope(subject, collection);
    }
  }

  /** Drops one owner's Wiki and report sources so a history rebuild starts empty. */
  async clearOwner(tenantId: string, ownerId: string): Promise<void> {
    await this.sql`
      DELETE FROM memory_index.sources
      WHERE tenant_id = ${tenantId} AND owner_id = ${ownerId}
        AND origin_kind IN ('wiki', 'period_summary')
    `;
  }

  /**
   * The Memory scheduler's periodic pass: index any report the index still
   * lacks, including report file edits and deletions outside a generation.
   */
  async reconcile(): Promise<void> {
    try {
      await this.#reconcileReports();
    } catch (error) {
      memoryLogger().log("error", "memory.report_reconciliation_failed", {
        error,
      });
    }
  }

  async close(): Promise<void> {
    this.#stopped = true;
    this.#controller.abort();
    await Promise.all(
      [...this.#lanes.values()].map((lane) => lane.catch(() => undefined)),
    );
  }

  async #projectWiki(subject: IndexSubject, pages: readonly PublishedFile[]) {
    const ids = pages
      .filter(({ page }) =>
        /^sessions\/[^/]+\/(?!index\.md$)[^/]+\.md$/u.test(page.path),
      )
      .map(({ page }) => path.posix.basename(page.path, ".md"));
    const meetings = ids.length
      ? await queryReadyMeetings(
          subject.tenantId,
          subject.representedHumanActorId,
          ids,
          this.sql,
        )
      : [];
    await publishMemoryWiki(
      this.dataRoot,
      subject.agentManagementId,
      pages,
      new Map(meetings.map((row) => [row.id, row.started_at])),
    );
  }

  async #reconcileReports(): Promise<void> {
    for (const subject of await this.loadSubjects()) {
      if (this.#stopped) return;
      if (this.indexHold(subject.agentManagementId)) continue;
      // Populate the reader tree for a Wiki that was indexed before this layout existed.
      const marker = path.join(
        agentWorkspaceRoot(this.dataRoot, subject.agentManagementId),
        "memory-state/wiki-file-paths.json",
      );
      if (!(await pathExists(marker))) {
        await this.#inLane(
          `${subject.tenantId}\n${subject.representedHumanActorId}\nwiki`,
          async () => {
            if (await pathExists(marker)) return;
            const { pages } = await readIndexedWiki(
              subject.tenantId,
              subject.representedHumanActorId,
              undefined,
              this.sql,
            );
            await this.#projectWiki(
              subject,
              pages.map((page) => ({
                page: {
                  path: page.key,
                  documentId: page.metadata.document_id!,
                },
                content: page.content,
              })),
            );
          },
        );
      }
      for (const collection of ["daily", "weekly"] as const) {
        await this.#indexReportScope(subject, collection).catch(
          (error: unknown) =>
            memoryLogger().log("error", "memory.report_index_failed", {
              agent_id: subject.agentManagementId,
              collection,
              error,
            }),
        );
      }
    }
  }

  async #indexReportScope(
    subject: IndexSubject,
    collection: "daily" | "weekly",
  ): Promise<void> {
    await this.#inLane(
      `${subject.agentManagementId}\n${collection}`,
      async () => {
        const root = path.join(
          agentMemoryRoot(this.dataRoot, subject.agentManagementId),
          collection === "daily" ? "timeline/daily" : "timeline/weekly",
        );
        let names: string[];
        try {
          names = await fs.readdir(root);
        } catch (error) {
          // A missing directory is not an empty report inventory.
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        }
        const identity = identityOf(subject);
        const kept: string[] = [];
        for (const name of names.sort()) {
          if (!/^\d{4}-\d{2}-\d{2}\.md$/u.test(name)) continue;
          const file = path.join(root, name);
          const info = await fs.lstat(file);
          if (!info.isFile() || info.isSymbolicLink())
            throw new Error("Report inventory contains a non-regular file");
          const content = await fs.readFile(file, "utf8");
          if (!content.trim())
            throw new Error("Empty report cannot replace an indexed report");
          const source = periodReportSource({
            identity,
            collection,
            periodStart: name.slice(0, 10),
            title: parseMemoryMarkdown(content).title,
            markdown: content,
          });
          kept.push(source.id);
          await this.chunks.indexDatabaseSource(source, content);
        }
        await this.chunks.retireDatabaseSources(
          identity,
          "period_summary",
          kept,
          collection,
        );
      },
    );
  }

  /** Runs one scope's indexing after the previous one finished. */
  #inLane(key: string, run: () => Promise<void>): Promise<void> {
    const next = (this.#lanes.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => {
        if (this.#stopped) throw new Error("Wiki index is stopped");
        return run();
      });
    this.#lanes.set(key, next);
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.#lanes.get(key) === next) this.#lanes.delete(key);
      });
    return next;
  }
}

export function createWikiIndex(
  chunks: MemoryChunkIndex,
  dataRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): WikiIndex {
  return new WikiIndex(
    chunks,
    dataRoot,
    teamHubWikiAccess(environment),
    memoryDatabase(environment),
  );
}
