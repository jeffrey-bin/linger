/** Generated client ownership for the Memory internal contract. */
import type { components } from "../generated/node-services-internal/types.js";

export const MEMORY_INTERNAL_AUDIENCE = "memory-internal" as const;
export const MEMORY_INTERNAL_DEFAULT_TIMEOUT_MS = 120_000;
export const PERSONAL_KNOWLEDGE_EVIDENCE_ID_PATTERN =
  /^raw_[a-f0-9]{16}_[a-f0-9]{16}$/u;

type Schemas = components["schemas"];
export type PersonalKnowledgeGraphVisualizationRequest =
  Schemas["PersonalKnowledgeGraphVisualizationRequest"];
export type PersonalKnowledgeQueryRequest =
  Schemas["PersonalKnowledgeQueryRequest"];
export type PersonalKnowledgeQueryResponse =
  Schemas["PersonalKnowledgeQueryResponse"];
export type PersonalKnowledgeEvidenceReadRequest =
  Schemas["PersonalKnowledgeEvidenceReadRequest"];
export type PersonalKnowledgeEvidenceReadResponse =
  Schemas["PersonalKnowledgeEvidenceReadResponse"];
export type PublishedWikiGraphUpdateRequest =
  Schemas["PublishedWikiGraphUpdateRequest"];
type ErrorResponse = Schemas["MemoryErrorResponse"];

export type MemoryInternalFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface MemoryInternalClient {
  query(
    body: PersonalKnowledgeQueryRequest,
    options?: { signal?: AbortSignal },
  ): Promise<PersonalKnowledgeQueryResponse>;
  readEvidence(
    body: PersonalKnowledgeEvidenceReadRequest,
    options?: { signal?: AbortSignal },
  ): Promise<PersonalKnowledgeEvidenceReadResponse>;
  updateGraphForPublishedWiki(
    body: PublishedWikiGraphUpdateRequest,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
}

export class MemoryInternalClientError extends Error {
  readonly code: string;
  readonly status: number | undefined;

  constructor(input: { code: string; status?: number }) {
    super(
      `Memory internal request failed (${input.status === undefined ? "client" : `HTTP ${input.status}`}, ${input.code})`,
    );
    this.name = "MemoryInternalClientError";
    this.code = input.code;
    this.status = input.status;
  }
}

export function createMemoryInternalClient(options: {
  baseUrl: string;
  fetch?: MemoryInternalFetch;
  getAccessToken: (input: {
    audience: typeof MEMORY_INTERNAL_AUDIENCE;
    signal: AbortSignal;
  }) => Promise<string> | string;
  timeoutMs?: number;
}): MemoryInternalClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchRequest = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? MEMORY_INTERNAL_DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("Memory internal timeout must be a positive integer");
  }

  return {
    async query(body, requestOptions) {
      const signal = requestOptions?.signal
        ? AbortSignal.any([
            requestOptions.signal,
            AbortSignal.timeout(timeoutMs),
          ])
        : AbortSignal.timeout(timeoutMs);
      let token: string;
      try {
        token = await options.getAccessToken({
          audience: MEMORY_INTERNAL_AUDIENCE,
          signal,
        });
      } catch {
        throw new MemoryInternalClientError({
          code: "access_token_unavailable",
        });
      }
      if (!token || token.length > 4_096 || /[\s,]/u.test(token)) {
        throw new MemoryInternalClientError({ code: "invalid_access_token" });
      }
      let response: Response;
      try {
        response = await fetchRequest(new URL("/internal/v1/query", baseUrl), {
          body: JSON.stringify(body),
          cache: "no-store",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          method: "POST",
          redirect: "error",
          signal,
        });
      } catch {
        throw new MemoryInternalClientError({
          code: signal.aborted ? "request_aborted" : "network_error",
        });
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new MemoryInternalClientError({
          code: "malformed_response",
          status: response.status,
        });
      }
      if (!response.ok) {
        throw new MemoryInternalClientError({
          code: errorCode(payload),
          status: response.status,
        });
      }
      return payload as PersonalKnowledgeQueryResponse;
    },
    async readEvidence(body, requestOptions) {
      const signal = requestOptions?.signal
        ? AbortSignal.any([
            requestOptions.signal,
            AbortSignal.timeout(timeoutMs),
          ])
        : AbortSignal.timeout(timeoutMs);
      let token: string;
      try {
        token = await options.getAccessToken({
          audience: MEMORY_INTERNAL_AUDIENCE,
          signal,
        });
      } catch {
        throw new MemoryInternalClientError({
          code: "access_token_unavailable",
        });
      }
      if (!token || token.length > 4_096 || /[\s,]/u.test(token)) {
        throw new MemoryInternalClientError({ code: "invalid_access_token" });
      }
      let response: Response;
      try {
        response = await fetchRequest(
          new URL("/internal/v1/personal-knowledge/evidence", baseUrl),
          {
            body: JSON.stringify(body),
            cache: "no-store",
            headers: {
              accept: "application/json",
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            method: "POST",
            redirect: "error",
            signal,
          },
        );
      } catch {
        throw new MemoryInternalClientError({
          code: signal.aborted ? "request_aborted" : "network_error",
        });
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new MemoryInternalClientError({
          code: "malformed_response",
          status: response.status,
        });
      }
      if (!response.ok) {
        throw new MemoryInternalClientError({
          code: errorCode(payload),
          status: response.status,
        });
      }
      return payload as PersonalKnowledgeEvidenceReadResponse;
    },
    async updateGraphForPublishedWiki(body, requestOptions) {
      const signal = requestOptions?.signal
        ? AbortSignal.any([
            requestOptions.signal,
            AbortSignal.timeout(timeoutMs),
          ])
        : AbortSignal.timeout(timeoutMs);
      let token: string;
      try {
        token = await options.getAccessToken({
          audience: MEMORY_INTERNAL_AUDIENCE,
          signal,
        });
      } catch {
        throw new MemoryInternalClientError({
          code: "access_token_unavailable",
        });
      }
      if (!token || token.length > 4_096 || /[\s,]/u.test(token)) {
        throw new MemoryInternalClientError({ code: "invalid_access_token" });
      }
      let response: Response;
      try {
        response = await fetchRequest(
          new URL("/internal/v1/published-wiki-graph-updates", baseUrl),
          {
            body: JSON.stringify(body),
            cache: "no-store",
            headers: {
              accept: "application/json",
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            method: "POST",
            redirect: "error",
            signal,
          },
        );
      } catch {
        throw new MemoryInternalClientError({
          code: signal.aborted ? "request_aborted" : "network_error",
        });
      }
      if (response.status === 204) return;
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new MemoryInternalClientError({
          code: "malformed_response",
          status: response.status,
        });
      }
      throw new MemoryInternalClientError({
        code: errorCode(payload),
        status: response.status,
      });
    },
  };
}

function normalizeBaseUrl(value: string): URL {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new TypeError(
      "Memory internal base URL must be an HTTP(S) origin without credentials, path, query, or fragment",
    );
  }
  return url;
}

function errorCode(value: unknown): string {
  const error = (value as Partial<ErrorResponse> | undefined)?.error;
  return error && typeof error.code === "string"
    ? error.code
    : "malformed_error";
}
