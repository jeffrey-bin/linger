import {
  readBodyWithLimit,
  startHttpHost,
  type HttpHost,
} from "../http-host.js";
import { withTeamHubTrace } from "./teamhub-transport.js";
import crypto from "node:crypto";
import path from "node:path";

import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import {
  PERSONAL_KNOWLEDGE_EVIDENCE_ID_PATTERN,
  type PersonalKnowledgeEvidenceReadRequest,
  type PersonalKnowledgeGraphVisualizationRequest,
  type PersonalKnowledgeQueryRequest,
  type PublishedWikiGraphUpdateRequest,
} from "@linger/wire-contracts/node-services-internal/client";
import type { components as NodeServicesInternal } from "@linger/wire-contracts/node-services-internal/types";

import {
  getPersonalKnowledgeGraphVisualization,
  PersonalKnowledgeGraphNotFoundError,
} from "./graph-visualization.js";
import {
  PersonalKnowledgeEvidenceNotFoundError,
  queryPersonalKnowledge,
  readPersonalKnowledgeEvidence,
} from "./knowledge-query.js";
import {
  MemoryRebuildUnavailableError,
  type MemoryScheduler,
} from "./scheduler.js";
import { loadAnotherMeSubjects } from "./collector.js";
import {
  archiveMemorySubjectState,
  discoverRebuildSessionDates,
  type RebuildSubject,
} from "./rebuild.js";
import {
  getMemoryEntry,
  listMemoryEntries,
  MemoryBrowserNotFoundError,
} from "./memory-browser.js";
import type { ChunkSearchProvider, MemoryChunkIndex } from "./chunk-index.js";
import { writeMemoryLog } from "./run-telemetry.js";

export async function startMemoryServer(options: {
  /** The process listener shared with the other roles. */
  http?: HttpHost;
  /** Without `http`, the server starts its own listener here. */
  host?: string;
  dataRoot: string;
  port?: number;
  scheduler: MemoryScheduler;
  serviceToken: string;
  onPocketNoteChanged?: (
    change: PocketNoteTrackingRefreshRequest,
  ) => Promise<void>;
  onWikiPublished?: (
    publication: PublishedWikiGraphUpdateRequest,
  ) => Promise<void>;
  onProfilePublished?: (change: ProfileMemorySyncRequest) => Promise<void>;
  graphVisualization?: typeof getPersonalKnowledgeGraphVisualization;
  query?: typeof queryPersonalKnowledge;
  evidenceRead?: typeof readPersonalKnowledgeEvidence;
  listMemoryEntries?: typeof listMemoryEntries;
  getMemoryEntry?: typeof getMemoryEntry;
  chunkSearch?: ChunkSearchProvider;
  chunkFailures?: Pick<MemoryChunkIndex, "failedSources">;
  rebuildSubjects?: () => Promise<RebuildSubject[]>;
  rebuildSessionDates?: (subject: RebuildSubject) => Promise<string[]>;
  /** Drops the subject's indexed Wiki and reports when a rebuild starts. */
  clearRebuildIndexes?: (subject: RebuildSubject) => Promise<void>;
}): Promise<{ close(): Promise<void>; url: string }> {
  const app = new Hono();
  app.notFound((context) => context.body(null, 404));
  app.onError((error, context) => {
    if (error instanceof SyntaxError || error instanceof TypeError) {
      return respondError(context, 400, "invalid_request", error.message);
    }
    return respondError(context, 503, "query_unavailable", "Query unavailable");
  });
  app.use((context, next) =>
    withTeamHubTrace(context.req.header("traceparent"), next),
  );
  const requireAuth: MiddlewareHandler = async (context, next) => {
    if (!authorized(context, options.serviceToken)) {
      return respondError(context, 401, "unauthenticated", "Unauthorized");
    }
    await next();
  };

  app.get("/internal/v1/memory/entries", requireAuth, async (context) => {
    try {
      const input = parseMemoryEntryListRequest(
        new URL(context.req.url).searchParams,
      );
      return respondJson(
        context,
        200,
        await (options.listMemoryEntries ?? listMemoryEntries)({
          dataRoot: options.dataRoot,
          ...input,
        }),
      );
    } catch (error) {
      if (error instanceof MemoryBrowserNotFoundError) {
        return respondError(
          context,
          404,
          "memory_not_found",
          "Memory was not found",
        );
      }
      throw error;
    }
  });
  app.get(
    "/internal/v1/memory/entries/:entryId",
    async (context, next) => {
      if (!MEMORY_ENTRY_ID_PATTERN.test(context.req.param("entryId"))) {
        return context.body(null, 404);
      }
      await next();
    },
    requireAuth,
    async (context) => {
      try {
        const input = parseMemoryEntryDetailRequest(
          new URL(context.req.url).searchParams,
          context.req.param("entryId"),
        );
        return respondJson(
          context,
          200,
          await (options.getMemoryEntry ?? getMemoryEntry)({
            dataRoot: options.dataRoot,
            ...input,
          }),
        );
      } catch (error) {
        if (error instanceof MemoryBrowserNotFoundError) {
          return respondError(
            context,
            404,
            "memory_not_found",
            "Memory entry was not found",
          );
        }
        throw error;
      }
    },
  );
  app.post(
    "/internal/v1/personal-knowledge-graph-visualization",
    requireAuth,
    async (context) => {
      const input = parseGraphVisualizationRequest(await readJsonBody(context));
      try {
        const html = await (
          options.graphVisualization ?? getPersonalKnowledgeGraphVisualization
        )(input);
        context.header("x-content-type-options", "nosniff");
        return respondHtml(context, 200, html);
      } catch (error) {
        if (error instanceof PersonalKnowledgeGraphNotFoundError) {
          return respondError(
            context,
            404,
            "graph_not_found",
            "Personal knowledge graph was not found",
          );
        }
        return respondError(
          context,
          503,
          "graph_visualization_unavailable",
          "Personal knowledge graph visualization is unavailable",
        );
      }
    },
  );
  app.post(
    "/internal/v1/published-wiki-graph-updates",
    requireAuth,
    async (context) => {
      try {
        if (!options.onWikiPublished) {
          throw new Error("Published Wiki consumer is not configured");
        }
        const publication = parsePublishedWikiGraphUpdate(
          await readJsonBody(context),
        );
        await options.onWikiPublished(publication);
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof TypeError) {
          throw error;
        }
        return respondError(
          context,
          503,
          "wiki_index_unavailable",
          "Wiki index unavailable",
        );
      }
      return context.body(null, 204);
    },
  );
  app.post(
    "/internal/v1/pocket-note-tracking-refreshes",
    requireAuth,
    async (context) => {
      const change = parsePocketNoteTrackingRefresh(
        await readJsonBody(context),
      );
      try {
        if (!options.onPocketNoteChanged)
          throw new Error("Pocket Note tracking is not configured");
        await options.onPocketNoteChanged(change);
      } catch (error) {
        writeMemoryLog("memory_pocket_note_tracking_failed", {
          tenant_id: change.tenant_id,
          owner_actor_id: change.owner_actor_id,
          date: change.date,
          error,
        });
        return respondError(
          context,
          503,
          "tracking_unavailable",
          "Tracking Items could not follow the Pocket Note",
        );
      }
      return context.body(null, 204);
    },
  );
  app.post(
    "/internal/v1/profile-memory-syncs",
    requireAuth,
    async (context) => {
      const change = parseProfileMemorySync(await readJsonBody(context));
      try {
        if (!options.onProfilePublished)
          throw new Error("Profile memory sync is not configured");
        await options.onProfilePublished(change);
      } catch (error) {
        writeMemoryLog("memory_user_memory_profile_failed", {
          tenant_id: change.tenant_id,
          owner_actor_id: change.owner_actor_id,
          error,
        });
        return respondError(
          context,
          503,
          "user_memory_unavailable",
          "memory.md could not take in the Profile",
        );
      }
      return context.body(null, 204);
    },
  );
  app.get("/internal/v1/health/failures", requireAuth, async (context) =>
    respondJson(context, 200, await failureSummary(options)),
  );
  app.post(
    "/internal/v1/health/failures:retry",
    requireAuth,
    async (context) => {
      const input = parseFailureRetryRequest(await readJsonBody(context));
      const result: Record<string, unknown> = {};
      if (input.scheduler) {
        const keys = await options.scheduler.retryFailed(
          input.scheduler.task_keys,
        );
        result.scheduler = { revived: keys.length, task_keys: keys };
      }
      return respondJson(context, 200, result);
    },
  );
  app.on(
    ["GET", "POST"],
    "/internal/v1/rebuild",
    requireAuth,
    async (context) => {
      const post = context.req.method === "POST";
      const input = parseRebuildRequest(
        post
          ? await readJsonBody(context)
          : Object.fromEntries(new URL(context.req.url).searchParams),
        post,
      );
      // Only a subject the calendar itself would process can be rebuilt. A
      // Human has at most one Another Me, so at most one subject matches.
      const subject = (
        await (options.rebuildSubjects ?? loadAnotherMeSubjects)()
      ).find((subject) =>
        input.memory_subject_key
          ? subject.memorySubjectKey === input.memory_subject_key
          : subject.representedHumanActorId === input.owner_actor_id,
      );
      if (!subject) {
        return respondError(
          context,
          404,
          "subject_not_found",
          "No Another Me subject matched",
        );
      }
      const key = subject.memorySubjectKey;
      if (!post) {
        return respondJson(context, 200, options.scheduler.rebuildStatus(key));
      }
      try {
        const result = await options.scheduler.enqueueRebuild(
          {
            memorySubjectKey: key,
            sessionDates: await (
              options.rebuildSessionDates ?? discoverRebuildSessionDates
            )(subject),
            from: input.from,
            restart: input.restart,
          },
          async () => {
            const archive = await archiveMemorySubjectState(
              options.dataRoot,
              key,
            );
            await options.clearRebuildIndexes?.(subject);
            writeMemoryLog("memory_rebuild_state_archived", {
              memory_subject_key: key,
              archive: path.basename(archive),
            });
          },
        );
        return respondJson(context, 202, {
          memory_subject_key: key,
          count: result.task_keys.length,
          queued_count: result.queued.length,
          ...result,
        });
      } catch (error) {
        if (!(error instanceof MemoryRebuildUnavailableError)) throw error;
        return respondError(context, 409, "rebuild_unavailable", error.message);
      }
    },
  );
  app.post("/internal/v1/query", requireAuth, async (context) => {
    const input = parseQueryRequest(await readJsonBody(context));
    return respondJson(
      context,
      200,
      await (options.query ?? queryPersonalKnowledge)(options.dataRoot, input, {
        chunkSearch: options.chunkSearch,
      }),
    );
  });
  app.post(
    "/internal/v1/personal-knowledge/evidence",
    requireAuth,
    async (context) => {
      const input = parseEvidenceReadRequest(await readJsonBody(context));
      try {
        const result = await (
          options.evidenceRead ?? readPersonalKnowledgeEvidence
        )(options.dataRoot, input, {
          rawSourceProvider: options.chunkSearch,
        });
        return respondJson(context, 200, result);
      } catch (error) {
        if (error instanceof PersonalKnowledgeEvidenceNotFoundError) {
          return respondError(
            context,
            404,
            "source_not_found",
            "Personal knowledge evidence was not found",
          );
        }
        throw error;
      }
    },
  );
  const ownedHost = options.http
    ? undefined
    : await startHttpHost({
        host: options.host ?? "127.0.0.1",
        port: options.port ?? 0,
      });
  const http = options.http ?? ownedHost!;
  http.mount({
    prefixes: ["/internal/v1/"],
    fetch: (request) => app.fetch(request),
  });
  ownedHost?.finishStartup();
  return {
    close: async () => {
      await ownedHost?.close();
    },
    url: http.url,
  };
}

const MEMORY_ENTRY_ID_PATTERN = /^(?:memory|meeting)_[a-f0-9]{24}$/u;

const FAILURE_LIST_LIMIT = 200;

async function failureSummary(options: {
  scheduler: Pick<MemoryScheduler, "failures">;
  chunkFailures?: Pick<MemoryChunkIndex, "failedSources">;
}) {
  // Each store degrades alone so one broken database still shows the others.
  const section = async <T extends object>(
    name: string,
    read: (() => Promise<T>) | undefined,
  ) => {
    if (!read) return { configured: false };
    try {
      return { configured: true, ...(await read()) };
    } catch {
      writeMemoryLog(
        "memory_failure_summary_unavailable",
        { section: name },
        "ERROR",
      );
      return { error: "unavailable" };
    }
  };
  const { exhausted, pending_retries } = options.scheduler.failures();
  const rawChunkSources = await section(
    "raw_chunk_sources",
    options.chunkFailures &&
      (() => options.chunkFailures!.failedSources(FAILURE_LIST_LIMIT)),
  );
  return {
    scheduler: {
      exhausted_total: exhausted.length,
      exhausted: exhausted.slice(0, FAILURE_LIST_LIMIT),
      pending_retries_total: pending_retries.length,
      pending_retries: pending_retries.slice(0, FAILURE_LIST_LIMIT),
    },
    raw_chunk_sources: rawChunkSources,
  };
}

function parseFailureRetryRequest(value: unknown): {
  scheduler?: { task_keys?: string[] };
} {
  const object = (item: unknown, keys: readonly string[]) =>
    !!item &&
    typeof item === "object" &&
    !Array.isArray(item) &&
    Object.keys(item).every((key) => keys.includes(key));
  const input = value as Record<string, Record<string, unknown> | undefined>;
  const taskKeys = input?.scheduler?.task_keys;
  if (
    !object(input, ["scheduler"]) ||
    (input.scheduler !== undefined &&
      (!object(input.scheduler, ["task_keys"]) ||
        (taskKeys !== undefined &&
          (!Array.isArray(taskKeys) ||
            taskKeys.length < 1 ||
            taskKeys.length > FAILURE_LIST_LIMIT ||
            !taskKeys.every(
              (key) =>
                typeof key === "string" &&
                /^(?:(?:wiki|sessionly|daily|weekly):[0-9T-]{10,13}|(?:wiki|daily|weekly):rebuild:[A-Za-z0-9][A-Za-z0-9_-]{0,63}:\d{4}-\d{2}-\d{2}|(?:init|index-initial|index-final):rebuild:[A-Za-z0-9][A-Za-z0-9_-]{0,63})$/u.test(
                  key,
                ),
            )))))
  ) {
    throw new TypeError("Request body is invalid");
  }
  return input;
}

function parseRebuildRequest(
  value: unknown,
  start: boolean,
): {
  memory_subject_key?: string;
  owner_actor_id?: string;
  from?: string;
  restart?: boolean;
} {
  const input = value as Record<string, unknown>;
  const keys = start
    ? ["memory_subject_key", "owner_actor_id", "from", "restart"]
    : ["memory_subject_key", "owner_actor_id"];
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !keys.includes(key)) ||
    (input.memory_subject_key === undefined) ===
      (input.owner_actor_id === undefined) ||
    (input.memory_subject_key !== undefined &&
      !isId(input.memory_subject_key)) ||
    (input.owner_actor_id !== undefined && !isId(input.owner_actor_id)) ||
    (input.from !== undefined &&
      (typeof input.from !== "string" || !isDate(input.from))) ||
    (input.restart !== undefined && typeof input.restart !== "boolean")
  ) {
    throw new TypeError("Request body is invalid");
  }
  return input;
}

function authorized(context: Context, token: string): boolean {
  const value = context.req.header("authorization");
  if (!value?.startsWith("Bearer ")) return false;
  const candidate = Buffer.from(value.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return (
    candidate.length === expected.length &&
    crypto.timingSafeEqual(candidate, expected)
  );
}

async function readJsonBody(context: Context): Promise<unknown> {
  const body = await readBodyWithLimit(context.req.raw, 16_384);
  if (!body) throw new TypeError("Request body is too large");
  return JSON.parse(body.toString("utf8"));
}

function parseQueryRequest(value: unknown): PersonalKnowledgeQueryRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Request body must be an object");
  }
  const input = value as Record<string, unknown>;
  const requiredKeys = [
    "agent_actor_id",
    "agent_id",
    "query",
    "tenant_id",
    "user_artifact_owner_actor_id",
  ];
  const allowedKeys = [
    ...requiredKeys,
    "alternates",
    "date_from",
    "date_to",
    "event_from",
    "event_to",
  ];
  if (
    !requiredKeys.every((key) => Object.hasOwn(input, key)) ||
    !Object.keys(input).every((key) => allowedKeys.includes(key)) ||
    !isId(input.agent_id) ||
    !isId(input.agent_actor_id) ||
    !isId(input.user_artifact_owner_actor_id) ||
    !isId(input.tenant_id) ||
    typeof input.query !== "string" ||
    !input.query.trim() ||
    input.query.length > 10_000 ||
    !validOptionalAlternates(input.alternates) ||
    !validOptionalDate(input.date_from) ||
    !validOptionalDate(input.date_to) ||
    (typeof input.date_from === "string" &&
      typeof input.date_to === "string" &&
      input.date_from > input.date_to) ||
    !validOptionalDate(input.event_from) ||
    !validOptionalDate(input.event_to) ||
    (typeof input.event_from === "string" &&
      typeof input.event_to === "string" &&
      input.event_from > input.event_to)
  ) {
    throw new TypeError("Request body is invalid");
  }
  return input as unknown as PersonalKnowledgeQueryRequest;
}

/** At most six short alternate wordings beside the query. */
function validOptionalAlternates(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= 6 &&
      value.every(
        (alternate) =>
          typeof alternate === "string" &&
          alternate.trim() !== "" &&
          alternate.length <= 200,
      ))
  );
}

function parseEvidenceReadRequest(
  value: unknown,
): PersonalKnowledgeEvidenceReadRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Request body must be an object");
  }
  const input = value as Record<string, unknown>;
  const keys = [
    "agent_actor_id",
    "agent_id",
    "evidence_id",
    "section_requests",
    "tenant_id",
    "user_artifact_owner_actor_id",
  ];
  const sectionRequests = input.section_requests;
  if (
    Object.keys(input).sort().join("\0") !== keys.sort().join("\0") ||
    !isId(input.agent_id) ||
    !isId(input.agent_actor_id) ||
    !isId(input.user_artifact_owner_actor_id) ||
    !isId(input.tenant_id) ||
    typeof input.evidence_id !== "string" ||
    !PERSONAL_KNOWLEDGE_EVIDENCE_ID_PATTERN.test(input.evidence_id) ||
    !Array.isArray(sectionRequests) ||
    sectionRequests.length < 1 ||
    sectionRequests.length > 8 ||
    !sectionRequests.every(validSectionReadRequest) ||
    new Set(
      sectionRequests.map(
        (request) => (request as Record<string, unknown>).section_id,
      ),
    ).size !== sectionRequests.length
  ) {
    throw new TypeError("Request body is invalid");
  }
  return input as unknown as PersonalKnowledgeEvidenceReadRequest;
}

function validSectionReadRequest(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (
    !Object.keys(input).every(
      (key) => key === "section_id" || key === "offset",
    ) ||
    typeof input.section_id !== "string" ||
    !/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(input.section_id)
  ) {
    return false;
  }
  return (
    input.offset === undefined ||
    (Number.isInteger(input.offset) &&
      Number(input.offset) >= 0 &&
      Number(input.offset) <= 200_000)
  );
}

function validOptionalDate(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && isDate(value));
}

function isDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value
  );
}

function parseMemoryEntryListRequest(search: URLSearchParams): {
  tenantId: string;
  ownerActorId: string;
  kind?: string;
  cursor?: string;
  limit?: number;
} {
  const tenantId = search.get("tenant_id");
  const ownerActorId = search.get("owner_actor_id");
  const kind = search.get("kind") ?? undefined;
  const cursor = search.get("cursor") ?? undefined;
  const limitValue = search.get("limit");
  if (
    !isId(tenantId) ||
    !isId(ownerActorId) ||
    (kind !== undefined && !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/u.test(kind)) ||
    (cursor !== undefined && !/^[0-9]{1,9}$/u.test(cursor))
  ) {
    throw new TypeError("Memory entry list request is invalid");
  }
  const limit = limitValue === null ? undefined : Number(limitValue);
  if (
    limit !== undefined &&
    (!Number.isInteger(limit) || limit < 1 || limit > 100)
  ) {
    throw new TypeError("Memory entry limit is invalid");
  }
  return {
    tenantId,
    ownerActorId,
    ...(kind ? { kind } : {}),
    ...(cursor ? { cursor } : {}),
    ...(limit ? { limit } : {}),
  };
}

function parseMemoryEntryDetailRequest(
  search: URLSearchParams,
  entryId: string,
): { tenantId: string; ownerActorId: string; entryId: string } {
  const tenantId = search.get("tenant_id");
  const ownerActorId = search.get("owner_actor_id");
  if (
    !isId(tenantId) ||
    !isId(ownerActorId) ||
    !/^(?:memory|meeting)_[a-f0-9]{24}$/u.test(entryId)
  ) {
    throw new TypeError("Memory entry request is invalid");
  }
  return { tenantId, ownerActorId, entryId };
}

function parsePublishedWikiGraphUpdate(
  value: unknown,
): PublishedWikiGraphUpdateRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Request body must be an object");
  }
  const input = value as Record<string, unknown>;
  const keys = ["owner_actor_id", "wiki_revision_id", "tenant_id"];
  if (
    Object.keys(input).some((key) => !keys.includes(key)) ||
    !isId(input.owner_actor_id) ||
    !isId(input.wiki_revision_id) ||
    !isId(input.tenant_id)
  ) {
    throw new TypeError("Request body is invalid");
  }
  return input as unknown as PublishedWikiGraphUpdateRequest;
}

type PocketNoteTrackingRefreshRequest =
  NodeServicesInternal["schemas"]["PocketNoteTrackingRefreshRequest"];
type ProfileMemorySyncRequest =
  NodeServicesInternal["schemas"]["ProfileMemorySyncRequest"];

function parsePocketNoteTrackingRefresh(
  value: unknown,
): PocketNoteTrackingRefreshRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Request body must be an object");
  }
  const input = value as Record<string, unknown>;
  const keys = ["date", "owner_actor_id", "tenant_id"];
  if (
    Object.keys(input).sort().join("\0") !== keys.join("\0") ||
    !isId(input.owner_actor_id) ||
    !isId(input.tenant_id) ||
    typeof input.date !== "string" ||
    !isDate(input.date)
  ) {
    throw new TypeError("Request body is invalid");
  }
  return input as unknown as PocketNoteTrackingRefreshRequest;
}

function parseProfileMemorySync(value: unknown): ProfileMemorySyncRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Request body must be an object");
  }
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).sort().join("\0") !== "owner_actor_id\0tenant_id" ||
    !isId(input.owner_actor_id) ||
    !isId(input.tenant_id)
  ) {
    throw new TypeError("Request body is invalid");
  }
  return input as unknown as ProfileMemorySyncRequest;
}

function parseGraphVisualizationRequest(
  value: unknown,
): PersonalKnowledgeGraphVisualizationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Request body must be an object");
  }
  const input = value as Record<string, unknown>;
  const keys = ["owner_actor_id", "tenant_id"];
  if (
    Object.keys(input).sort().join("\0") !== keys.join("\0") ||
    !isId(input.owner_actor_id) ||
    !isId(input.tenant_id)
  ) {
    throw new TypeError("Request body is invalid");
  }
  return input as unknown as PersonalKnowledgeGraphVisualizationRequest;
}

function isId(value: unknown): value is string {
  return (
    typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(value)
  );
}

function respondJson(
  context: Context,
  status: ContentfulStatusCode,
  body: unknown,
): Response {
  return context.body(JSON.stringify(body), status, {
    "content-type": "application/json",
  });
}

function respondHtml(
  context: Context,
  status: ContentfulStatusCode,
  body: string,
): Response {
  return context.body(body, status, {
    "content-type": "text/html; charset=utf-8",
  });
}

function respondError(
  context: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string,
): Response {
  return respondJson(context, status, { error: { code, message } });
}
