import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { components } from "@linger/wire-contracts/node-services-internal/types";

import type {
  LlmWikiBackend,
  LlmWikiGenerateRequest,
  WikiInput,
  WikiInputSnapshot,
} from "./backend.js";
import { WikiOperationState } from "./actor-wiki/wiki-operation-state.js";
import { ActorAssetError } from "./actor-wiki/actor-asset-client.js";
import {
  isWikiPageKey,
  MAX_WIKI_PAGE_BYTES,
  scanGeneratedWiki,
} from "./actor-wiki/wiki-workspace.js";
import { WikiCandidateValidationError } from "./wiki-candidate-validation.js";
import { writeWikiLog } from "./log.js";
import { finalizeEntityChangeLog } from "./wiki-page-template.js";
import { generateWikiCandidate } from "./wiki-initialization.js";
import {
  renderSessionSource,
  type WikiSessionDescriptor,
} from "./wiki-session-source.js";
import { sha256Hex } from "@linger/service-kit/node";
import type { AnotherMeActor } from "../runtime-model-call.js";

type CandidateResult =
  components["schemas"]["WikiRefreshCandidateGenerationResult"];
type FrozenSource = components["schemas"]["WikiRefreshFrozenSource"];
type SourceReference = components["schemas"]["WikiRefreshSourceReference"];

/** A request checked once against the contract, with its bytes decoded. */
interface CandidateRequest {
  wikiRefreshId: string;
  generator: AnotherMeActor;
  mode: "initialize" | "update";
  basePages: { pageKey: string; content: Uint8Array }[];
  added: DecodedSource[];
  modified: DecodedSource[];
  removed: SourceReference[];
}

interface DecodedSource {
  source: FrozenSource;
  content: Uint8Array;
  session?: WikiSessionDescriptor;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_SOURCE_BYTES = 50 * 1024 * 1024;

export class WikiRefreshCandidateError extends Error {
  constructor(
    readonly code:
      | "WIKI_COMPUTER_OFFLINE"
      | "WIKI_SERVICE_STOPPING"
      | "WIKI_REFRESH_CANDIDATE_REQUEST_INVALID"
      | "WIKI_REFRESH_GENERATION_INVALID"
      | "WIKI_REFRESH_GENERATION_UNAVAILABLE",
    readonly disposition: "retryable" | "terminal",
    readonly status: 400 | 413 | 500 | 503,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WikiRefreshCandidateError";
  }
}

interface WikiRefreshCandidateServiceOptions {
  dataDirectory: string;
  runtime: LlmWikiBackend;
}

export class WikiRefreshCandidateService {
  readonly #operations = new Set<{
    controller: AbortController;
    settled: Promise<unknown>;
  }>();
  readonly #runtime: LlmWikiBackend;
  readonly #state: WikiOperationState;
  #stopping = false;

  constructor(options: WikiRefreshCandidateServiceOptions) {
    this.#runtime = options.runtime;
    this.#state = new WikiOperationState({
      dataDirectory: options.dataDirectory,
    });
  }

  /** Clears the operation directories a stopped process left behind. */
  async start(): Promise<void> {
    await this.#state.start();
  }

  /** Stops every running generation and waits until its files are gone. */
  async stop(): Promise<void> {
    this.#stopping = true;
    const operations = [...this.#operations];
    for (const operation of operations) operation.controller.abort();
    await Promise.allSettled(operations.map(({ settled }) => settled));
  }

  async generate(
    wikiRefreshId: string,
    value: unknown,
    signal?: AbortSignal,
    onPreviewPage?: LlmWikiGenerateRequest["onPreviewPage"],
  ): Promise<CandidateResult> {
    const request = parseCandidateRequest(wikiRefreshId, value);
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const settled = this.#generate(request, controller.signal, onPreviewPage);
    const operation = { controller, settled };
    this.#operations.add(operation);
    try {
      return await settled;
    } finally {
      this.#operations.delete(operation);
      signal?.removeEventListener("abort", abort);
    }
  }

  async #generate(
    request: CandidateRequest,
    signal: AbortSignal,
    onPreviewPage?: LlmWikiGenerateRequest["onPreviewPage"],
  ): Promise<CandidateResult> {
    const operation = await this.#state.createOperation();
    try {
      const inputsDirectory = join(operation.directory, "inputs");
      const outputDirectory = join(operation.directory, "candidate", "wiki");
      const added = await this.#materializeSources(
        request.added,
        inputsDirectory,
      );
      const modified = await this.#materializeSources(
        request.modified,
        inputsDirectory,
        added.length,
      );
      const existingOutputDirectory = join(
        operation.directory,
        "existing-wiki",
      );
      await this.#materializeBasePages(
        request.basePages,
        existingOutputDirectory,
      );
      const baseline = new Map(
        request.basePages.map((page) => [
          page.pageKey,
          sha256Hex(page.content),
        ]),
      );
      const backendRequest: LlmWikiGenerateRequest = {
        changes: {
          added,
          modified,
          removed: request.removed.map((source) =>
            sourceReferenceToSnapshot(source),
          ),
        },
        existingOutputDirectory,
        onPreviewPage:
          onPreviewPage &&
          ((path, markdown) => {
            onPreviewPage(
              path,
              markdown && sha256Hex(markdown) !== baseline.get(path)
                ? markdown
                : null,
            );
          }),
        generationId: request.wikiRefreshId,
        generator: request.generator,
        inputsDirectory,
        mode: request.mode,
        outputDirectory,
        signal,
      };
      let unsettled: readonly string[];
      let deferred: readonly string[];
      try {
        ({ unsettled, deferred } = await generateWikiCandidate(
          this.#runtime,
          backendRequest,
        ));
      } catch (error) {
        // A restart stopped this generation, not a fault of its own: TeamHub
        // runs it again later without spending an attempt.
        if (this.#stopping)
          throw new WikiRefreshCandidateError(
            "WIKI_SERVICE_STOPPING",
            "retryable",
            503,
            "The LLM Wiki service is stopping",
            { cause: error },
          );
        writeWikiLog(
          "llm_wiki_refresh_failed",
          {
            wiki_refresh_id: request.wikiRefreshId,
            error: generationErrorLabel(error),
          },
          "ERROR",
        );
        if (error instanceof WikiCandidateValidationError) {
          throw new WikiRefreshCandidateError(
            "WIKI_REFRESH_GENERATION_INVALID",
            "terminal",
            500,
            "Wiki refresh candidate output is invalid",
            { cause: error },
          );
        }
        if (
          error instanceof ActorAssetError &&
          error.disposition === "terminal"
        ) {
          throw new WikiRefreshCandidateError(
            "WIKI_REFRESH_GENERATION_INVALID",
            "terminal",
            500,
            "Wiki refresh candidate generation cannot be completed",
            { cause: error },
          );
        }
        if (
          error instanceof ActorAssetError &&
          error.code === "WIKI_COMPUTER_OFFLINE"
        ) {
          throw new WikiRefreshCandidateError(
            "WIKI_COMPUTER_OFFLINE",
            "retryable",
            503,
            "The Wiki owner's Computer is offline",
            { cause: error },
          );
        }
        throw new WikiRefreshCandidateError(
          "WIKI_REFRESH_GENERATION_UNAVAILABLE",
          "retryable",
          503,
          "Wiki refresh candidate generation is temporarily unavailable",
          { cause: error },
        );
      }

      try {
        const candidate = await scanGeneratedWiki(outputDirectory);
        return candidateResult(request, candidate.files, unsettled, deferred);
      } catch (error) {
        throw new WikiRefreshCandidateError(
          "WIKI_REFRESH_GENERATION_INVALID",
          "terminal",
          500,
          "Wiki refresh candidate output is invalid",
          { cause: error },
        );
      }
    } finally {
      await operation.release().catch(() => undefined);
    }
  }

  /**
   * Stages each source's Markdown: a Document's text as TeamHub normalized it
   * once, or a Session's indexed text with its routing and citation tokens.
   */
  async #materializeSources(
    sources: DecodedSource[],
    inputsDirectory: string,
    discoveryOffset = 0,
  ): Promise<WikiInput[]> {
    await mkdir(inputsDirectory, { recursive: true, mode: 0o700 });
    const inputs: WikiInput[] = [];
    for (const { source, content, session } of sources) {
      const assetKey = assetKeyOf(source);
      const assetDirectory = join(inputsDirectory, assetKey);
      await mkdir(assetDirectory, { mode: 0o700 });
      let rendered: ReturnType<typeof renderSessionSource> | undefined;
      try {
        rendered = session
          ? renderSessionSource(
              source.filename.replace(/\.md$/u, ""),
              new TextDecoder().decode(content),
              session,
            )
          : undefined;
      } catch {
        // The same frozen Session would fail again.
        throw invalidRequest();
      }
      const markdown = rendered
        ? new TextEncoder().encode(rendered.markdown)
        : content;
      await writeFile(join(assetDirectory, "document.md"), markdown, {
        mode: 0o600,
      });
      const sourceUrl = `document://${source.document_id}/versions/${source.document_version_id}`;
      await writeFile(
        join(assetDirectory, "metadata.json"),
        `${JSON.stringify({
          assetKey,
          contentFile: "document.md",
          discoveryIndex: discoveryOffset + inputs.length,
          sourceUrl,
          title: source.filename,
        })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      inputs.push({
        assetKey,
        contentPath: `${assetKey}/document.md`,
        contentSha256: sha256Hex(markdown),
        sourceUrl,
        title: source.filename,
        ...(rendered ? { session: rendered.routing } : {}),
      });
    }
    return inputs;
  }

  async #materializeBasePages(
    pages: CandidateRequest["basePages"],
    outputDirectory: string,
  ): Promise<void> {
    if (pages.length === 0) return;
    await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
    for (const { pageKey, content } of pages) {
      await mkdir(join(outputDirectory, dirname(pageKey)), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(join(outputDirectory, pageKey), content, {
        mode: 0o600,
      });
    }
  }
}

function candidateResult(
  request: CandidateRequest,
  files: readonly { relativePath: string; content: Uint8Array }[],
  unsettled: readonly string[],
  deferred: readonly string[],
): CandidateResult {
  const base = new Map(
    request.basePages.map((page) => [page.pageKey, page.content]),
  );
  const pages = files
    .map((file) => {
      const prior = base.get(file.relativePath);
      let content = Buffer.from(file.content);
      if (
        (!prior || !content.equals(prior)) &&
        content.includes("\n## Change Log\n")
      ) {
        const staged = content.toString("utf8");
        const published = finalizeEntityChangeLog(
          file.relativePath,
          staged,
          prior && Buffer.from(prior).toString("utf8"),
        );
        if (published !== staged) content = Buffer.from(published);
        if (content.length > MAX_WIKI_PAGE_BYTES)
          throw new Error("Final Wiki page exceeds the size limit");
      }
      return {
        markdown_content: content.toString("base64"),
        markdown_sha256: sha256Hex(content),
        page_key: file.relativePath,
      };
    })
    .sort((left, right) =>
      left.page_key < right.page_key
        ? -1
        : left.page_key > right.page_key
          ? 1
          : 0,
    );
  const references = (keys: readonly string[]) => {
    const pending = new Set(keys);
    return [...request.added, ...request.modified]
      .map(({ source }) => source)
      .filter((source) => pending.has(assetKeyOf(source)))
      .map(({ document_id, document_version_id, filename }) => ({
        document_id,
        document_version_id,
        filename,
      }));
  };
  return {
    deferred_sources: references(deferred),
    pages,
    unsettled_sources: references(unsettled),
    wiki_refresh_id: request.wikiRefreshId,
  };
}

/** The key a source's staged input is named by. */
function assetKeyOf(source: SourceReference): string {
  return `${source.document_id}_${source.document_version_id}`;
}

function generationErrorLabel(error: unknown): string {
  const code =
    error instanceof ActorAssetError
      ? error.code
      : error instanceof WikiCandidateValidationError
        ? "candidate_validation"
        : error instanceof Error
          ? error.name
          : "unknown";
  const detail =
    error instanceof Error && error.message.trim()
      ? error.message
          .replace(
            /(?:sk|Bearer)_[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._~-]+/gu,
            "[redacted]",
          )
          .replace(/\s+/gu, " ")
          .slice(0, 300)
      : undefined;
  return detail && detail !== code ? `${code}: ${detail}` : code;
}

function parseCandidateRequest(
  wikiRefreshId: string,
  value: unknown,
): CandidateRequest {
  if (
    !isExactObject(value, [
      "base_pages",
      "changes",
      "generator_agent_actor_id",
      "mode",
      "tenant_id",
      "wiki_refresh_id",
    ])
  ) {
    throw invalidRequest();
  }
  const request = value;
  if (
    !isId(wikiRefreshId) ||
    request.wiki_refresh_id !== wikiRefreshId ||
    !isId(request.tenant_id) ||
    !isId(request.generator_agent_actor_id) ||
    (request.mode !== "initialize" && request.mode !== "update") ||
    !Array.isArray(request.base_pages) ||
    request.base_pages.length > 10000
  ) {
    throw invalidRequest();
  }
  const basePages = request.base_pages.map((page) => parseBasePage(page));
  if (
    new Set(basePages.map((page) => page.pageKey)).size !== basePages.length ||
    (request.mode === "initialize" && basePages.length !== 0) ||
    (request.mode === "update" && basePages.length === 0)
  ) {
    throw invalidRequest();
  }
  const changes = parseSourceChanges(request.changes);
  const total =
    changes.added.length + changes.modified.length + changes.removed.length;
  if (
    total < 1 ||
    total > 1000 ||
    (request.mode === "initialize" && changes.added.length === 0)
  ) {
    throw invalidRequest();
  }
  const documentIds = new Set<string>();
  const versionIds = new Set<string>();
  for (const { source, session } of [...changes.added, ...changes.modified]) {
    // A Session's version is its text digest, which two Sessions with the
    // same text share; Document versions are unique.
    if (
      documentIds.has(source.document_id) ||
      (!session && versionIds.has(source.document_version_id))
    ) {
      throw invalidRequest();
    }
    documentIds.add(source.document_id);
    if (!session) versionIds.add(source.document_version_id);
  }
  return {
    wikiRefreshId,
    generator: {
      tenantId: request.tenant_id,
      agentActorId: request.generator_agent_actor_id,
    },
    mode: request.mode,
    basePages,
    ...changes,
  };
}

function parseSourceChanges(
  value: unknown,
): Pick<CandidateRequest, "added" | "modified" | "removed"> {
  if (!isExactObject(value, ["added", "modified", "removed"])) {
    throw invalidRequest();
  }
  const changes = value;
  if (
    !Array.isArray(changes.added) ||
    !Array.isArray(changes.modified) ||
    !Array.isArray(changes.removed) ||
    changes.added.length > 1000 ||
    changes.modified.length > 1000 ||
    changes.removed.length > 1000
  ) {
    throw invalidRequest();
  }
  return {
    added: changes.added.map((source) => parseFrozenSource(source)),
    modified: changes.modified.map((source) => parseFrozenSource(source)),
    removed: changes.removed.map((source) => parseSourceReference(source)),
  };
}

function parseBasePage(value: unknown): CandidateRequest["basePages"][number] {
  if (
    !isExactObject(value, ["markdown_content", "markdown_sha256", "page_key"])
  ) {
    throw invalidRequest();
  }
  const page = value;
  if (
    typeof page.page_key !== "string" ||
    !isWikiPageKey(page.page_key) ||
    typeof page.markdown_content !== "string" ||
    typeof page.markdown_sha256 !== "string" ||
    !SHA256_PATTERN.test(page.markdown_sha256)
  ) {
    throw invalidRequest();
  }
  const content = decodeCanonicalBase64(page.markdown_content);
  if (
    content.byteLength > MAX_WIKI_PAGE_BYTES ||
    sha256Hex(content) !== page.markdown_sha256
  ) {
    throw invalidRequest();
  }
  return { pageKey: page.page_key, content };
}

function parseSourceReference(value: unknown): SourceReference {
  if (
    !isExactObject(value, ["document_id", "document_version_id", "filename"])
  ) {
    throw invalidRequest();
  }
  const source = value;
  if (
    !isId(source.document_id) ||
    !isId(source.document_version_id) ||
    !isBoundedText(source.filename, 255)
  ) {
    throw invalidRequest();
  }
  return source as unknown as SourceReference;
}

function sourceReferenceToSnapshot(source: SourceReference): WikiInputSnapshot {
  const assetKey = `${source.document_id}_${source.document_version_id}`;
  return {
    assetKey,
    contentSha256: "",
    sourceUrl: `document://${source.document_id}/versions/${source.document_version_id}`,
    title: source.filename,
  };
}

function parseFrozenSource(value: unknown): DecodedSource {
  const keys = [
    "content",
    "document_id",
    "document_version_id",
    "filename",
    "sha256",
    "size_bytes",
  ];
  if (
    !isExactObject(value, keys) &&
    !isExactObject(value, [...keys, "session"].sort())
  ) {
    throw invalidRequest();
  }
  const source = value;
  if (
    !isId(source.document_id) ||
    !isId(source.document_version_id) ||
    !isBoundedText(source.filename, 255) ||
    !Number.isSafeInteger(source.size_bytes) ||
    (source.size_bytes as number) < 0 ||
    (source.size_bytes as number) > MAX_SOURCE_BYTES ||
    typeof source.sha256 !== "string" ||
    !SHA256_PATTERN.test(source.sha256) ||
    typeof source.content !== "string"
  ) {
    throw invalidRequest();
  }
  const content = decodeCanonicalBase64(source.content);
  if (
    content.byteLength !== source.size_bytes ||
    sha256Hex(content) !== source.sha256 ||
    !isUtf8(content)
  ) {
    throw invalidRequest();
  }
  return {
    source: source as unknown as FrozenSource,
    content,
    ...("session" in source ? { session: parseSession(source.session) } : {}),
  };
}

function parseSession(value: unknown): WikiSessionDescriptor {
  const required = [
    "date",
    "kind",
    "represented_human_actor_id",
    "represented_human_display_name",
    "room_id",
    "session_id",
  ];
  const transcript = [
    "transcript_document_id",
    "transcript_document_version_id",
  ];
  const room = isExactObject(value, required);
  if (!room && !isExactObject(value, [...required, ...transcript].sort()))
    throw invalidRequest();
  const session = value;
  if (
    session.kind !== (room ? "room" : "recording") ||
    typeof session.date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(session.date) ||
    !isId(session.session_id) ||
    !isId(session.room_id) ||
    !isId(session.represented_human_actor_id) ||
    !isBoundedText(session.represented_human_display_name, 255) ||
    (!room &&
      (!isId(session.transcript_document_id) ||
        !isId(session.transcript_document_version_id)))
  )
    throw invalidRequest();
  return {
    kind: room ? "room" : "recording",
    date: session.date,
    sessionId: session.session_id,
    roomId: session.room_id,
    representedHumanActorId: session.represented_human_actor_id,
    representedHumanDisplayName: session.represented_human_display_name,
    ...(room
      ? {}
      : {
          transcriptDocumentId: session.transcript_document_id as string,
          transcriptDocumentVersionId:
            session.transcript_document_version_id as string,
        }),
  };
}

/** A frozen source is Markdown text; anything else is a corrupt request. */
function isUtf8(content: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(content);
    return true;
  } catch {
    return false;
  }
}

function decodeCanonicalBase64(value: string): Uint8Array {
  // Buffer drops characters outside the alphabet, so only canonical Base64
  // re-encodes to the same string. A grouped regex here recursed once per
  // 4 characters and overflowed the stack on multi-MiB sources.
  if (value.length % 4 !== 0) throw invalidRequest();
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw invalidRequest();
  return decoded;
}

function isExactObject(
  value: unknown,
  expectedKeys: string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index])
  );
}

function isId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maxLength &&
    !containsControlCharacter(value)
  );
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function invalidRequest(): WikiRefreshCandidateError {
  return new WikiRefreshCandidateError(
    "WIKI_REFRESH_CANDIDATE_REQUEST_INVALID",
    "terminal",
    400,
    "Wiki refresh candidate request is invalid",
  );
}
