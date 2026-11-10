import {
  getTeamHubAgentEffectiveResources,
  type TeamHubAgentCallbackFetch,
  createTeamHubMcpInternalClient,
  TEAMHUB_AGENT_SERVICE_AUDIENCE,
  TeamHubMcpInternalClientError,
  type TeamHubMcpInternalFetch,
} from "@linger/wire-contracts/teamhub-internal/client";
import {
  parseExecutionResources,
  type ExecutionResources,
} from "./context-runtime-state.js";
import { isRecord } from "@linger/service-kit";
import { createHash } from "node:crypto";
import type { ExecutionContextRef } from "./context-ref.js";

/** Current Agent configuration, with no Context resource authorization session. */
export interface AgentEffectiveResources {
  /** Covers the Skills and connectedApps. */
  readonly effectiveSha256: string;
  readonly skills: ExecutionResources["skills"];
  /** TeamHub has a Composio API key now. */
  readonly connectedApps: boolean;
}

export interface AgentResourcesResolver {
  resolve(request: {
    readonly agentId: string;
    readonly signal: AbortSignal;
  }): Promise<AgentEffectiveResources>;
}

export const createTeamHubAgentResourcesResolver = (options: {
  readonly baseUrl: string;
  readonly serviceToken: string;
  readonly fetch?: TeamHubAgentCallbackFetch;
  readonly requestTimeoutMs?: number;
}): AgentResourcesResolver => ({
  async resolve({ agentId, signal }) {
    const response = await getTeamHubAgentEffectiveResources({
      baseUrl: options.baseUrl,
      serviceToken: options.serviceToken,
      agentId,
      fetch: options.fetch,
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(options.requestTimeoutMs ?? 30_000),
      ]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Agent resource configuration could not be read (HTTP ${response.status})`,
      );
    }
    const parsed = parseAgentEffectiveResources(await response.json());
    signal.throwIfAborted();
    return parsed;
  },
});

export const parseAgentEffectiveResources = (
  value: unknown,
): AgentEffectiveResources => {
  if (
    !isRecord(value) ||
    !Array.isArray(value.skills) ||
    typeof value.connected_apps !== "boolean"
  )
    throw new TypeError("Invalid Agent effective resources");
  const resources = parseExecutionResources({
    version: 1,
    effectiveSha256: value.effective_sha256,
    skills: value.skills.map((skill: unknown) => {
      if (!isRecord(skill))
        throw new TypeError("Invalid Agent Skill configuration");
      return {
        skillId: skill.skill_id,
        manifestId: skill.manifest_id,
        manifestVersion: skill.manifest_version,
        name: skill.name,
        packageName: skill.name,
        packageSha256: skill.package_sha256,
        config: skill.config,
        source: skill.source,
      };
    }),
  });
  return Object.freeze({
    effectiveSha256: resources.effectiveSha256,
    skills: resources.skills,
    connectedApps: value.connected_apps,
  });
};

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DOCUMENT_AUTHORITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export interface TeamHubMcpContextResolverOptions {
  readonly baseUrl: string;
  readonly serviceToken: string;
  readonly requestTimeoutMs?: number;
  readonly fetch?: TeamHubMcpInternalFetch;
}

/** Current authority of one Context; a Document Context adds its Run inputs. */
export interface McpContextResolution {
  readonly documentCommentRuntime?: DocumentCommentRuntimeProjection;
}

export interface DocumentCommentRuntimeProjection {
  readonly commentsMarkdown: string;
  readonly currentDocument: DocumentInputContent;
}

export interface DocumentInputContent {
  readonly bytes: Uint8Array;
  readonly documentId: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly sha256: string;
}

export interface McpContextResolver {
  resolve(request: {
    readonly ref: ExecutionContextRef;
    readonly signal: AbortSignal;
  }): Promise<McpContextResolution>;
}

export interface TeamHubMcpContextResolvePort {
  resolveContext(request: {
    readonly agentId: string;
    readonly context:
      | { readonly kind: "meta"; readonly room_id: string }
      | { readonly kind: "alter_ego"; readonly task_id: string }
      | { readonly kind: "document"; readonly document_id: string };
    readonly signal: AbortSignal;
  }): Promise<unknown>;
}

export class TeamHubMcpContextResolverError extends Error {
  override readonly name = "TeamHubMcpContextResolverError";

  constructor(
    readonly code:
      | "context_identity_invalid"
      | "invalid_resolver_response"
      | "resolver_rejected"
      | "resolver_unavailable"
      | "download_unavailable",
    readonly upstream?: {
      readonly code: string;
      readonly status?: number;
      readonly requestId?: string;
    },
  ) {
    super(`TeamHub MCP Context resolution failed (${code})`);
  }
}

export const createTeamHubMcpContextResolver = (
  port: TeamHubMcpContextResolvePort,
): McpContextResolver => ({
  async resolve(request) {
    request.signal.throwIfAborted();
    const ref = snapshotContextRef(request.ref);
    let response: unknown;
    try {
      response = await port.resolveContext({
        agentId: ref.agentId,
        context:
          ref.kind === "meta"
            ? Object.freeze({ kind: "meta" as const, room_id: ref.roomId })
            : ref.kind === "alter_ego"
              ? Object.freeze({
                  kind: "alter_ego" as const,
                  task_id: ref.taskId,
                })
              : Object.freeze({
                  kind: "document" as const,
                  document_id: ref.documentId,
                }),
        signal: request.signal,
      });
    } catch (error) {
      request.signal.throwIfAborted();
      throw classifyResolveFailure(error);
    }

    request.signal.throwIfAborted();
    return parseResolveResponse(response, ref);
  },
});

const classifyResolveFailure = (
  error: unknown,
): TeamHubMcpContextResolverError => {
  if (!(error instanceof TeamHubMcpInternalClientError)) {
    return new TeamHubMcpContextResolverError("resolver_unavailable");
  }
  const upstream = {
    code: error.code,
    ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
    ...(error.status === undefined ? {} : { status: error.status }),
  };
  if (error.code === "context_identity_invalid") {
    return new TeamHubMcpContextResolverError(
      "context_identity_invalid",
      upstream,
    );
  }
  if (
    error.status === undefined ||
    error.status === 408 ||
    error.status === 429 ||
    error.status >= 500
  ) {
    return new TeamHubMcpContextResolverError("resolver_unavailable", upstream);
  }
  return new TeamHubMcpContextResolverError("resolver_rejected", upstream);
};

export const createTeamHubMcpContextResolverClient = (
  options: TeamHubMcpContextResolverOptions,
): McpContextResolver => {
  const serviceToken = requireServiceToken(options.serviceToken);
  const client = createTeamHubMcpInternalClient({
    baseUrl: options.baseUrl,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { timeoutMs: options.requestTimeoutMs }),
    getAccessToken({ audience }) {
      if (audience !== TEAMHUB_AGENT_SERVICE_AUDIENCE) {
        throw new TypeError("Unexpected TeamHub workload audience");
      }
      return serviceToken;
    },
  });
  return createTeamHubMcpContextResolver({
    resolveContext: ({ agentId, context, signal }) =>
      client.resolveMcpContext(agentId, { context }, { signal }),
  });
};

const parseResolveResponse = (
  value: unknown,
  ref: ExecutionContextRef,
): McpContextResolution => {
  try {
    assertRecord(value);
    assertExactKeys(value, [
      "agent_id",
      "context",
      ...("document_comment_runtime" in value
        ? ["document_comment_runtime"]
        : []),
    ]);
    if (value.agent_id !== ref.agentId) failInvalidResponse();
    assertResolvedContext(value.context, ref);
    const documentCommentRuntime = parseDocumentCommentRuntime(
      value.document_comment_runtime,
      ref,
    );
    return Object.freeze(
      documentCommentRuntime ? { documentCommentRuntime } : {},
    );
  } catch (error) {
    if (error instanceof TeamHubMcpContextResolverError) throw error;
    throw new TeamHubMcpContextResolverError("invalid_resolver_response");
  }
};

function assertDocumentAuthorityId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !DOCUMENT_AUTHORITY_ID_PATTERN.test(value)) {
    failInvalidResponse();
  }
}

const parseDocumentCommentRuntime = (
  value: unknown,
  ref: ExecutionContextRef,
): DocumentCommentRuntimeProjection | undefined => {
  if (ref.kind !== "document") {
    if (value !== undefined) failInvalidResponse();
    return undefined;
  }
  assertRecord(value);
  assertExactKeys(value, ["comments_markdown", "current_document"]);
  assertNonEmptyString(value.comments_markdown, 4 * 1024 * 1024);
  assertRecord(value.current_document);
  assertExactKeys(value.current_document, [
    "content",
    "document_id",
    "filename",
    "media_type",
    "sha256",
    "size_bytes",
  ]);
  assertDocumentAuthorityId(value.current_document.document_id);
  if (
    !validProjectionFilename(value.current_document.filename) ||
    value.current_document.media_type !== "text/markdown" ||
    typeof value.current_document.content !== "string" ||
    !Number.isSafeInteger(value.current_document.size_bytes) ||
    (value.current_document.size_bytes as number) < 0 ||
    (value.current_document.size_bytes as number) > 32 * 1024 * 1024 ||
    typeof value.current_document.sha256 !== "string" ||
    !SHA256_PATTERN.test(value.current_document.sha256)
  ) {
    failInvalidResponse();
  }
  const currentBytes = decodeCanonicalBase64(
    value.current_document.content,
    value.current_document.size_bytes as number,
  );
  if (
    createHash("sha256").update(currentBytes).digest("hex") !==
    value.current_document.sha256
  ) {
    failInvalidResponse();
  }
  return Object.freeze({
    commentsMarkdown: value.comments_markdown,
    currentDocument: Object.freeze({
      bytes: currentBytes,
      documentId: value.current_document.document_id,
      filename: value.current_document.filename,
      mediaType: value.current_document.media_type,
      sha256: value.current_document.sha256,
    }),
  });
};

const decodeCanonicalBase64 = (
  value: string,
  expectedSize: number,
): Uint8Array => {
  if (
    value.length > 44_739_244 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  ) {
    failInvalidResponse();
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength !== expectedSize || bytes.toString("base64") !== value) {
    failInvalidResponse();
  }
  return new Uint8Array(bytes);
};

const validProjectionFilename = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= 255 &&
  value !== "." &&
  value !== ".." &&
  !value.includes("\u0000") &&
  !value.includes("/") &&
  !value.includes("\\");

const assertResolvedContext = (
  value: unknown,
  ref: ExecutionContextRef,
): void => {
  assertRecord(value);
  if (ref.kind === "meta") {
    assertExactKeys(value, ["kind", "room_id"]);
    if (value.kind !== "meta" || value.room_id !== ref.roomId) {
      failInvalidResponse();
    }
    return;
  }
  if (ref.kind === "document") {
    assertExactKeys(value, ["kind", "document_id"]);
    if (value.kind !== "document" || value.document_id !== ref.documentId) {
      failInvalidResponse();
    }
    return;
  }
  assertExactKeys(value, ["kind", "task_id"]);
  if (
    ref.kind !== "alter_ego" ||
    value.kind !== "alter_ego" ||
    value.task_id !== ref.taskId
  ) {
    failInvalidResponse();
  }
};

const snapshotContextRef = (
  ref: ExecutionContextRef,
): Readonly<ExecutionContextRef> => {
  assertIdentifier(ref.agentId);
  if (ref.kind === "meta") {
    return Object.freeze({
      kind: "meta",
      agentId: ref.agentId,
      roomId: ref.roomId,
    });
  }
  if (ref.kind === "document") {
    if (!IDENTIFIER_PATTERN.test(ref.documentId)) {
      failInvalidResponse();
    }
    return Object.freeze({
      kind: "document",
      agentId: ref.agentId,
      documentId: ref.documentId,
    });
  }
  if (ref.kind !== "alter_ego" || !TASK_ID_PATTERN.test(ref.taskId)) {
    failInvalidResponse();
  }
  return Object.freeze({
    kind: "alter_ego",
    agentId: ref.agentId,
    taskId: ref.taskId,
  });
};

function assertRecord(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) failInvalidResponse();
}

const assertExactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
): void => {
  const actual = Object.keys(value).sort(compareStrings);
  const sortedExpected = [...expected].sort(compareStrings);
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    failInvalidResponse();
  }
};

function assertIdentifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    failInvalidResponse();
  }
}

function assertNonEmptyString(
  value: unknown,
  maximumLength: number,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > maximumLength
  ) {
    failInvalidResponse();
  }
}

function failInvalidResponse(): never {
  throw new TeamHubMcpContextResolverError("invalid_resolver_response");
}

const requireServiceToken = (value: string): string => {
  if (typeof value !== "string" || value.length === 0 || /\s/u.test(value)) {
    throw new TypeError("TeamHub Agent Service token is invalid");
  }
  return value;
};

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
