import { streamWikiCandidateResponse } from "./wiki-refresh-preview.js";
import { timingSafeEqual } from "node:crypto";

import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import {
  readBodyWithLimit,
  type HttpHost,
  type HttpRoute,
} from "../http-host.js";
import {
  DocumentNormalizationError,
  DOCUMENT_NORMALIZER_NAME,
  DOCUMENT_NORMALIZER_VERSION,
  MAX_DOCUMENT_SOURCE_BYTES,
  type DocumentNormalizer,
} from "../document-normalizer/document-normalizer.js";
import {
  WikiRefreshCandidateError,
  type WikiRefreshCandidateService,
} from "./wiki-refresh-candidates.js";
import { writeWikiLog } from "./log.js";

interface WikiServerOptions {
  candidateService?: WikiRefreshCandidateService;
  /** The process listener shared with the other roles. */
  http: HttpHost;
  /** The process's one normalizer, shared with Memory. */
  normalizer: DocumentNormalizer;
  readiness?: HttpRoute["readiness"];
  serviceToken: string;
}

const DOCUMENT_NORMALIZATION_PATH = "/v0/document-normalizations";
const CANDIDATE_PATH_PREFIX = "/internal/v1/wiki-refreshes/";
const CANDIDATE_PATH = `${CANDIDATE_PATH_PREFIX}:id/candidates`;
const WIKI_REFRESH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const MAX_CANDIDATE_BODY_BYTES = 256 * 1024 * 1024;

export class WikiServer {
  readonly #candidateService: WikiRefreshCandidateService | undefined;
  readonly #http: HttpHost;
  readonly #normalizer: DocumentNormalizer;
  readonly #readiness: HttpRoute["readiness"];
  readonly #serviceToken: string;
  #unmount: (() => void) | undefined;

  constructor(options: WikiServerOptions) {
    this.#candidateService = options.candidateService;
    this.#http = options.http;
    this.#normalizer = options.normalizer;
    this.#readiness = options.readiness;
    this.#serviceToken = options.serviceToken;
  }

  start(): void {
    if (this.#unmount) {
      throw new Error("Wiki server is already running");
    }
    const app = this.#createApp();
    this.#unmount = this.#http.mount({
      prefixes: [DOCUMENT_NORMALIZATION_PATH, CANDIDATE_PATH_PREFIX],
      fetch: (request) => app.fetch(request),
      ...(this.#readiness ? { readiness: this.#readiness } : {}),
    });
  }

  close(): void {
    this.#unmount?.();
    this.#unmount = undefined;
  }

  #createApp(): Hono {
    const app = new Hono();
    app.notFound((context) => context.body(null, 404));
    // Unknown paths answer 404 before authentication; known paths
    // authenticate before the method is checked.
    const requireService = async (
      context: Context,
      next: () => Promise<void>,
    ): Promise<Response | void> => {
      if (!hasServiceAuthorization(context, this.#serviceToken)) {
        return respondJson(context, 401, {
          error: {
            code: "SERVICE_TOKEN_INVALID",
            message: "Service token is invalid",
          },
        });
      }
      if (context.req.method !== "POST") {
        return respondJson(context, 405, {
          error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" },
        });
      }
      await next();
    };
    app.all(DOCUMENT_NORMALIZATION_PATH, requireService, (context) =>
      this.#handleDocumentNormalization(context),
    );
    app.all(
      CANDIDATE_PATH,
      async (context, next) => {
        if (!WIKI_REFRESH_ID_PATTERN.test(context.req.param("id") ?? "")) {
          return context.body(null, 404);
        }
        await next();
      },
      requireService,
      (context) =>
        this.#handleCandidateOperation(context.req.param("id")!, context),
    );
    return app;
  }

  async #handleCandidateOperation(
    wikiRefreshId: string,
    context: Context,
  ): Promise<Response> {
    if (context.req.header("accept") === "application/x-ndjson") {
      // Read the whole request before the preview stream sends its headers:
      // TeamHub stops uploading its body once the response headers arrive,
      // so a body still in flight would be cut off. A body that cannot be
      // read is answered as plain JSON, which TeamHub also accepts.
      let body: unknown;
      try {
        body = await readCandidateBody(context);
      } catch (error) {
        return this.#generateCandidates(
          wikiRefreshId,
          context,
          () => Promise.reject(error),
          context.req.raw.signal,
        );
      }
      return streamWikiCandidateResponse(
        context.req.raw.signal,
        (signal, onPage) =>
          this.#generateCandidates(
            wikiRefreshId,
            context,
            () => Promise.resolve(body),
            signal,
            onPage,
          ),
      );
    }
    return this.#generateCandidates(
      wikiRefreshId,
      context,
      () => readCandidateBody(context),
      context.req.raw.signal,
    );
  }

  async #generateCandidates(
    wikiRefreshId: string,
    context: Context,
    readBody: () => Promise<unknown>,
    signal: AbortSignal,
    onPreviewPage?: (path: string, markdown: string | null) => void,
  ): Promise<Response> {
    const startedAt = Date.now();
    if (!this.#candidateService) {
      return respondJson(context, 503, {
        error: {
          code: "WIKI_REFRESH_GENERATION_UNAVAILABLE",
          disposition: "retryable",
          message:
            "Wiki refresh candidate generation is temporarily unavailable",
        },
      });
    }
    try {
      const body = await readBody();
      // TeamHub retries a timed-out call; the request signal aborts when its
      // caller disconnects so two runs for one refresh never overlap.
      const result = await this.#candidateService.generate(
        wikiRefreshId,
        body,
        signal,
        onPreviewPage,
      );
      process.stderr.write(
        `[llm-wiki] candidate response ready wiki_refresh_id=${wikiRefreshId} page_count=${result.pages.length} duration_ms=${Date.now() - startedAt}\n`,
      );
      return respondJson(context, 200, result);
    } catch (error) {
      if (error instanceof WikiRefreshCandidateError) {
        writeWikiLog(
          "llm_wiki_refresh_failed",
          {
            wiki_refresh_id: wikiRefreshId,
            code: error.code,
            disposition: error.disposition,
            duration_ms: Date.now() - startedAt,
          },
          "ERROR",
        );
        return respondJson(context, error.status, {
          error: {
            code: error.code,
            disposition: error.disposition,
            message: error.message,
          },
        });
      }
      writeWikiLog(
        "llm_wiki_refresh_failed",
        {
          wiki_refresh_id: wikiRefreshId,
          code: "unexpected_error",
          error: error instanceof Error ? error.name : "unknown",
          duration_ms: Date.now() - startedAt,
        },
        "ERROR",
      );
      return respondJson(context, 503, {
        error: {
          code: "WIKI_REFRESH_GENERATION_UNAVAILABLE",
          disposition: "retryable",
          message:
            "Wiki refresh candidate generation is temporarily unavailable",
        },
      });
    }
  }

  async #handleDocumentNormalization(context: Context): Promise<Response> {
    try {
      const mediaType = readDocumentMediaType(context);
      const filename = readSourceFilename(context);
      const representationFormat = readSourceHeader(
        context,
        "x-source-representation-format",
        120,
      );
      const source = await readDocumentSource(context);
      // A caller that goes away leaves the queue and stops its conversion.
      const markdown = await this.#normalizer.normalizeDocument(
        {
          filename,
          mediaType,
          source,
          ...(representationFormat ? { representationFormat } : {}),
        },
        context.req.raw.signal,
      );
      return context.body(markdown as Uint8Array<ArrayBuffer>, 200, {
        "content-length": String(markdown.byteLength),
        "content-type": "text/markdown; charset=utf-8",
        "x-normalizer-name": DOCUMENT_NORMALIZER_NAME,
        "x-normalizer-version": DOCUMENT_NORMALIZER_VERSION,
      });
    } catch (error) {
      const normalizationError =
        error instanceof DocumentNormalizationError
          ? error
          : new DocumentNormalizationError(
              "DOCUMENT_NORMALIZATION_UNAVAILABLE",
            );
      return respondJson(context, normalizationError.status, {
        error: {
          code: normalizationError.code,
          disposition: normalizationError.disposition,
          message: normalizationError.message,
        },
      });
    }
  }
}

function requestContentType(context: Context): string | undefined {
  return context.req
    .header("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLocaleLowerCase("en-US");
}

async function readCandidateBody(context: Context): Promise<unknown> {
  const contentType = requestContentType(context);
  const contentLength = context.req.header("content-length");
  if (
    contentType !== "application/json" ||
    (contentLength !== undefined &&
      (!/^\d+$/u.test(contentLength) ||
        Number(contentLength) > MAX_CANDIDATE_BODY_BYTES))
  ) {
    throw new WikiRefreshCandidateError(
      "WIKI_REFRESH_CANDIDATE_REQUEST_INVALID",
      "terminal",
      contentLength !== undefined &&
        Number(contentLength) > MAX_CANDIDATE_BODY_BYTES
        ? 413
        : 400,
      "Wiki refresh candidate request is invalid",
    );
  }
  try {
    const bytes = await readBodyWithLimit(
      context.req.raw,
      MAX_CANDIDATE_BODY_BYTES,
    );
    if (!bytes) {
      throw new WikiRefreshCandidateError(
        "WIKI_REFRESH_CANDIDATE_REQUEST_INVALID",
        "terminal",
        413,
        "Wiki refresh candidate request is invalid",
      );
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof WikiRefreshCandidateError) throw error;
    throw new WikiRefreshCandidateError(
      "WIKI_REFRESH_CANDIDATE_REQUEST_INVALID",
      "terminal",
      400,
      "Wiki refresh candidate request is invalid",
      { cause: error },
    );
  }
}

function readDocumentMediaType(context: Context): string {
  const mediaType = readSourceHeader(context, "x-source-media-type", 255);
  if (!mediaType) {
    throw new DocumentNormalizationError("DOCUMENT_NORMALIZATION_INVALID");
  }
  return mediaType;
}

/**
 * One source metadata header. An absent or empty header reads as unset;
 * control characters or an overlong value reject the request.
 */
function readSourceHeader(
  context: Context,
  name: string,
  maxLength: number,
): string | undefined {
  const value = context.req.header(name)?.trim();
  if (!value) return undefined;
  return requireSafeText(value, maxLength);
}

/** The original filename travels percent-encoded so any UTF-8 name fits a header. */
function readSourceFilename(context: Context): string {
  const encoded = readSourceHeader(context, "x-source-filename", 1024);
  if (!encoded) {
    throw new DocumentNormalizationError("DOCUMENT_NORMALIZATION_INVALID");
  }
  let filename: string;
  try {
    filename = decodeURIComponent(encoded);
  } catch {
    throw new DocumentNormalizationError("DOCUMENT_NORMALIZATION_INVALID");
  }
  return requireSafeText(filename, 255);
}

function requireSafeText(value: string, maxLength: number): string {
  if (
    value.length > maxLength ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new DocumentNormalizationError("DOCUMENT_NORMALIZATION_INVALID");
  }
  return value;
}

async function readDocumentSource(context: Context): Promise<Uint8Array> {
  const contentLength = context.req.header("content-length");
  if (
    requestContentType(context) !== "application/octet-stream" ||
    (contentLength !== undefined && !/^\d+$/u.test(contentLength))
  ) {
    throw new DocumentNormalizationError("DOCUMENT_NORMALIZATION_INVALID");
  }
  if (
    contentLength !== undefined &&
    Number(contentLength) > MAX_DOCUMENT_SOURCE_BYTES
  ) {
    throw new DocumentNormalizationError("DOCUMENT_SOURCE_TOO_LARGE");
  }
  let source: Buffer | undefined;
  try {
    source = await readBodyWithLimit(
      context.req.raw,
      MAX_DOCUMENT_SOURCE_BYTES,
    );
  } catch {
    throw new DocumentNormalizationError("DOCUMENT_NORMALIZATION_INVALID");
  }
  if (!source)
    throw new DocumentNormalizationError("DOCUMENT_SOURCE_TOO_LARGE");
  return source;
}

function hasServiceAuthorization(
  context: Context,
  serviceToken: string,
): boolean {
  const provided = Buffer.from(
    context.req.header("authorization") ?? "",
    "utf8",
  );
  const expected = Buffer.from(`Bearer ${serviceToken}`, "utf8");
  return (
    provided.length === expected.length && timingSafeEqual(provided, expected)
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
