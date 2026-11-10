import { teamHubBaseUrl } from "../teamhub-base-url.js";
import { createHash } from "node:crypto";

import {
  getTeamHubPersonalWikiDocumentRevision,
  getTeamHubPersonalWikiDocumentVersion,
  type TeamHubAgentCallbackFetch,
} from "@linger/wire-contracts/teamhub-internal/client";

import { memoryTeamHubToken } from "./teamhub-content.js";
import { teamHubFetch } from "./teamhub-transport.js";
import { isRecord } from "@linger/service-kit";

export interface WikiPage {
  documentId: string;
  documentVersionId: string;
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface PublishedWiki {
  isCurrent?: boolean;
  state?: string;
  pages: WikiPage[];
  publishedAt: string;
  revision: string;
}

export interface TeamHubWikiAccess {
  baseUrl: string;
  fetch?: TeamHubAgentCallbackFetch;
  token: string;
}

export class TeamHubWikiReadError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
    readonly retryAfterMs?: number,
  ) {
    super(message, options);
    this.name = "TeamHubWikiReadError";
  }
}

export function teamHubWikiAccess(
  environment: NodeJS.ProcessEnv = process.env,
): TeamHubWikiAccess {
  const token = memoryTeamHubToken(environment);
  if (!token) throw new Error("LINGER_SECRET_SEED is required");
  return { baseUrl: teamHubBaseUrl(environment), token };
}

interface WikiReadCache {
  etag?: string;
  wiki?: PublishedWiki;
}

export async function readPublishedWiki(
  access: TeamHubWikiAccess,
  actorId: string,
  options: {
    signal?: AbortSignal;
    cache?: WikiReadCache;
    failOnGenerationFailure?: boolean;
  } = {},
): Promise<PublishedWiki | undefined> {
  try {
    const response = await getTeamHubPersonalWikiDocumentRevision({
      actorId,
      baseUrl: access.baseUrl,
      fetch: teamHubFetch(access.fetch),
      serviceToken: access.token,
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(120_000)])
        : AbortSignal.timeout(120_000),
      ifNoneMatch: options.cache?.etag,
    });
    if (response.status === 304) {
      if (options.cache?.etag && options.cache.wiki) return options.cache.wiki;
      // An unsolicited 304 has no usable representation; recover once unconditionally.
      if (options.cache) {
        delete options.cache.etag;
        return readPublishedWiki(access, actorId, {
          signal: options.signal,
          failOnGenerationFailure: options.failOnGenerationFailure,
        });
      }
      throw new TeamHubWikiReadError(
        "TeamHub returned 304 without a cached Wiki",
        false,
      );
    }
    if (response.status === 409) {
      const body: unknown = await response
        .clone()
        .json()
        .catch(() => null);
      if (
        isRecord(body) &&
        isRecord(body.error) &&
        body.error.code === "WIKI_GENERATION_FAILED"
      ) {
        if (options.failOnGenerationFailure)
          throw new PersonalWikiGenerationFailedError();
        if (options.cache) {
          delete options.cache.etag;
          delete options.cache.wiki;
        }
        return undefined;
      }
    }
    if (response.status === 404) {
      if (options.cache) {
        delete options.cache.etag;
        delete options.cache.wiki;
      }
      return undefined;
    }
    if (!response.ok) {
      const retryAfter = response.headers.get("retry-after");
      const retryAfterMs =
        retryAfter === null
          ? undefined
          : /^\d+$/u.test(retryAfter)
            ? Number(retryAfter) * 1000
            : Math.max(0, Date.parse(retryAfter) - Date.now());
      throw new TeamHubWikiReadError(
        `TeamHub Wiki read failed with HTTP ${response.status}`,
        [408, 429, 500, 502, 503, 504].includes(response.status),
        undefined,
        response.status === 429 && Number.isFinite(retryAfterMs)
          ? retryAfterMs
          : undefined,
      );
    }
    const wiki = parsePublishedWiki(await response.json());
    if (options.cache) {
      options.cache.wiki = wiki;
      options.cache.etag = response.headers.get("etag") ?? undefined;
    }
    return wiki;
  } catch (error) {
    if (
      error instanceof TypeError ||
      (error instanceof Error && error.name === "TimeoutError")
    ) {
      throw new TeamHubWikiReadError(
        `TeamHub Wiki read interrupted (${error.name})`,
        true,
        { cause: error },
      );
    }
    throw error;
  }
}

/** Downloads one page of a published Wiki and checks its size and hash. */
export async function downloadPublishedWikiPage(
  access: TeamHubWikiAccess,
  actorId: string,
  wikiRevision: string,
  page: WikiPage,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const response = await getTeamHubPersonalWikiDocumentVersion({
    actorId,
    baseUrl: access.baseUrl,
    documentId: page.documentId,
    documentVersionId: page.documentVersionId,
    fetch: teamHubFetch(access.fetch),
    serviceToken: access.token,
    signal: AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(120_000),
    ]),
    wikiRevisionId: wikiRevision,
  });
  if (!response.ok) {
    throw new TeamHubWikiReadError(
      `TeamHub Wiki download failed with HTTP ${response.status}`,
      [404, 408, 429, 500, 502, 503, 504].includes(response.status),
    );
  }
  const content = new Uint8Array(await response.arrayBuffer());
  if (
    content.byteLength !== page.sizeBytes ||
    createHash("sha256").update(content).digest("hex") !== page.sha256
  )
    throw new Error(`TeamHub Wiki page integrity failed: ${page.path}`);
  return content;
}

function parsePublishedWiki(value: unknown): PublishedWiki {
  if (!isRecord(value) || !Array.isArray(value.pages)) {
    throw invalidPublishedWiki();
  }
  const revision = id(value.wiki_revision_id);
  if (
    typeof value.published_at !== "string" ||
    Number.isNaN(Date.parse(value.published_at)) ||
    value.pages.length === 0
  ) {
    throw invalidPublishedWiki();
  }
  const paths = new Set<string>();
  const pages = value.pages.map((candidate): WikiPage => {
    if (!isRecord(candidate)) throw invalidPublishedWiki();
    const pagePath = wikiPagePath(candidate.page_key);
    if (paths.has(pagePath)) throw invalidPublishedWiki();
    paths.add(pagePath);
    if (
      candidate.media_type !== "text/markdown" ||
      !Number.isSafeInteger(candidate.size_bytes) ||
      Number(candidate.size_bytes) < 0 ||
      typeof candidate.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(candidate.sha256)
    ) {
      throw invalidPublishedWiki();
    }
    return {
      documentId: id(candidate.document_id),
      documentVersionId: id(candidate.document_version_id),
      path: pagePath,
      sha256: candidate.sha256,
      sizeBytes: Number(candidate.size_bytes),
    };
  });
  if (
    (value.is_current !== undefined && typeof value.is_current !== "boolean") ||
    (value.wiki_state !== undefined && typeof value.wiki_state !== "string")
  )
    throw invalidPublishedWiki();
  return {
    pages,
    publishedAt: value.published_at,
    revision,
    ...(typeof value.is_current === "boolean"
      ? { isCurrent: value.is_current }
      : {}),
    ...(typeof value.wiki_state === "string"
      ? { state: value.wiki_state }
      : {}),
  };
}

function isWikiPagePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 512 &&
    /^[a-z0-9][a-z0-9._/-]*\.md$/u.test(value) &&
    !value.split("/").some((segment) => segment === "." || segment === "..")
  );
}

function wikiPagePath(value: unknown): string {
  if (!isWikiPagePath(value)) throw invalidPublishedWiki();
  return value;
}

function id(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(value)
  ) {
    throw invalidPublishedWiki();
  }
  return value;
}

function invalidPublishedWiki(): Error {
  return new Error("TeamHub returned an invalid published Wiki");
}

/** The latest Wiki refresh reached a terminal failure. */
export class PersonalWikiGenerationFailedError extends Error {
  constructor() {
    super("Personal Wiki generation failed");
  }
}

interface WaitForPublishedWikiOptions {
  timeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
  random?: () => number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Waits for a Wiki published from the current sources, not merely for any
 * newer revision; with `until: "idle"`, only until no refresh runs, whether
 * the last one published or failed. An idle wait resolves `undefined` when the
 * first generation failed and no Revision was ever published. */
export function waitForCurrentPublishedWiki(
  access: TeamHubWikiAccess,
  actorId: string,
  options: WaitForPublishedWikiOptions & { until: "idle" },
): Promise<PublishedWiki | undefined>;
export function waitForCurrentPublishedWiki(
  access: TeamHubWikiAccess,
  actorId: string,
  options?: WaitForPublishedWikiOptions & { until?: "current" },
): Promise<PublishedWiki>;
export async function waitForCurrentPublishedWiki(
  access: TeamHubWikiAccess,
  actorId: string,
  options: WaitForPublishedWikiOptions & { until?: "current" | "idle" } = {},
): Promise<PublishedWiki | undefined> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    (async (ms: number, signal?: AbortSignal) => {
      const { setTimeout } = await import("node:timers/promises");
      await setTimeout(ms, undefined, { signal });
    });
  const deadline = now() + (options.timeoutMs ?? 35 * 60_000);
  const cache: WikiReadCache = {};
  let delay = options.pollMs ?? 2_000;
  while (now() < deadline) {
    options.signal?.throwIfAborted();
    let wiki: PublishedWiki | undefined;
    let retryAfterMs = 0;
    try {
      wiki = await readPublishedWiki(access, actorId, {
        cache,
        failOnGenerationFailure: true,
        signal: AbortSignal.any([
          ...(options.signal ? [options.signal] : []),
          AbortSignal.timeout(Math.max(1, Math.min(120_000, deadline - now()))),
        ]),
      });
    } catch (error) {
      // A failed first generation is terminal: idle has nothing published.
      if (
        error instanceof PersonalWikiGenerationFailedError &&
        options.until === "idle"
      )
        return undefined;
      if (!(error instanceof TeamHubWikiReadError) || !error.retryable)
        throw error;
      retryAfterMs = error.retryAfterMs ?? 0;
    }
    if (wiki && options.until === "idle") {
      if (wiki.state !== "refreshing") return wiki;
    } else if (wiki) {
      if (wiki.isCurrent === undefined)
        throw new Error("TeamHub does not provide Wiki publication freshness");
      if (wiki.isCurrent) return wiki;
      if (wiki.state === "failed")
        throw new PersonalWikiGenerationFailedError();
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    const jitter =
      options.pollMs === undefined
        ? 0.9 + (options.random ?? Math.random)() * 0.1
        : 1;
    await sleep(
      Math.min(remaining, Math.max(retryAfterMs, Math.round(delay * jitter))),
      options.signal,
    );
    delay = Math.min(15_000, delay * 2);
  }
  throw new Error("Timed out waiting for current Personal Wiki publication");
}
