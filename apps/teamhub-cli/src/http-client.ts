import { randomUUID } from "node:crypto";
import createClient, { type Client } from "openapi-fetch";
import type { paths } from "@linger/wire-contracts/teamhub-agent-api/types";
import type { TeamHubConfig } from "./config.js";
import { CliError } from "./errors.js";
import type { CliTiming, TimingFields } from "./timing.js";

/** The TeamHub Agent API, typed by the generated contract `paths`. */
export type TeamHubApi = Client<paths>;
export type TeamHubApiPath = keyof paths;
export type TeamHubApiPostPath = {
  [Path in TeamHubApiPath]: paths[Path] extends { post: object } ? Path : never;
}[TeamHubApiPath];

export interface TeamHubHttpClient {
  readonly config: TeamHubConfig;
  /** JSON calls; a non-2xx response or an unreadable body throws CliError. */
  readonly api: TeamHubApi;
  /** Byte transfers and the anonymous shared-link read the contract client does not cover. */
  request(endpoint: string, options?: RequestInit): Promise<Response>;
}

/** The header TeamHub deduplicates a write by. */
export function operationHeaders(
  operationId: string | undefined,
): Record<string, string> {
  return operationId ? { "x-teamhub-operation-id": operationId } : {};
}

/**
 * Resolves a successful JSON call to its body. The transport has already
 * thrown for every non-2xx response and every body that is not an object.
 */
export async function teamHubData<T>(call: Promise<{ data?: T }>): Promise<T> {
  // A 204 has no body; callers read it as an empty result.
  return ((await call).data ?? {}) as T;
}

export function createTeamHubClient(
  config: TeamHubConfig,
  dependencies: { fetch: typeof fetch; timing?: CliTiming },
): TeamHubHttpClient {
  const request = async (endpoint: string, options: RequestInit = {}) => {
    const requestPath = endpoint.split("?")[0]!;
    const sharedDocument = endpoint === "/v0/shared-documents/content";
    if (
      (!endpoint.startsWith("/api/agent/v1/") && !sharedDocument) ||
      endpoint.includes("\\") ||
      endpoint.includes("#") ||
      requestPath.split("/").includes("..") ||
      /%2e|%2f|%5c/iu.test(requestPath)
    )
      throw new CliError("invalid_input", "Invalid TeamHub API endpoint.");
    const headers = new Headers(options.headers);
    if (!sharedDocument) headers.set("authorization", `Bearer ${config.token}`);
    if (!sharedDocument && config.identity) {
      headers.set("x-teamhub-expected-tenant-id", config.identity.tenantId);
      headers.set("x-teamhub-expected-agent-id", config.identity.agentId);
    }
    if (!sharedDocument && config.scope) {
      headers.set("x-teamhub-context-kind", config.scope.kind);
      headers.set("x-teamhub-context-id", config.scope.id);
    }
    // The Run this CLI serves; TeamHub keeps it on a Message only after checking it.
    if (!sharedDocument && config.runId)
      headers.set("x-teamhub-run-id", config.runId);
    const operationId = headers.get("x-teamhub-operation-id");
    const operationTiming =
      operationId && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(operationId)
        ? { operation_id: operationId }
        : {};
    const timing = dependencies.timing;
    const started = timing?.now() ?? 0;
    const requestId = timing ? randomUUID() : undefined;
    if (requestId) headers.set("x-request-id", requestId);
    const method = options.method ?? "GET";
    let response: Response;
    try {
      response = await dependencies.fetch(`${config.url}${endpoint}`, {
        ...options,
        headers,
        redirect: "error",
        signal: options.signal ?? AbortSignal.timeout(180_000),
      });
    } catch {
      timing?.record("http", timing.now() - started, {
        request_id: requestId,
        ...operationTiming,
        method,
        outcome: "failure",
      });
      throw new CliError(
        operationId ? "outcome_unknown" : "connection_failed",
        operationId
          ? "The operation outcome is unknown. Retry with --operation-id set to this Operation ID."
          : "Could not reach TeamHub.",
        operationId ? { operation_id: operationId } : {},
      );
    }
    if (timing) {
      const returnedId = response.headers.get("x-request-id");
      const fields: TimingFields = {
        ...operationTiming,
        request_id:
          returnedId && /^[A-Za-z0-9._:-]{1,128}$/u.test(returnedId)
            ? returnedId
            : requestId,
        method,
        http_status: response.status,
      };
      timing.record("http_headers", timing.now() - started, fields);
      response = timedResponse(response, timing, started, fields);
    }
    if (!response.ok) {
      let value: unknown;
      try {
        value = await readJson(response);
      } catch {
        /* Preserve HTTP status below. */
      }
      const envelope =
        record(value) && record(value.error) ? value.error : undefined;
      if (envelope && typeof envelope.code === "string") {
        throw new CliError(
          envelope.code,
          typeof envelope.message === "string"
            ? envelope.message
            : "TeamHub rejected the request.",
          {
            ...envelope,
            ...(record(envelope.details) ? envelope.details : {}),
            http_status: response.status,
            ...(operationId ? { operation_id: operationId } : {}),
          },
        );
      }
      throw new CliError(
        response.status === 401
          ? "unauthorized"
          : response.status === 403
            ? "forbidden"
            : "server_error",
        `TeamHub request failed (HTTP ${response.status}).`,
        {
          http_status: response.status,
          ...(operationId ? { operation_id: operationId } : {}),
        },
      );
    }
    return response;
  };
  // The base URL only shapes the Request: the transport above prefixes the
  // configured TeamHub URL and checks the endpoint before any credential leaves.
  const api = createClient<paths>({
    baseUrl: "http://teamhub.invalid",
    fetch: async (call: Request) => {
      const url = new URL(call.url);
      const response = await request(url.pathname + url.search, {
        method: call.method,
        headers: call.headers,
        ...(call.body ? { body: await call.text() } : {}),
      });
      if (response.status === 204) return response;
      const value = await readJson(response);
      if (!record(value))
        throw new CliError(
          "invalid_response",
          "TeamHub returned an invalid JSON response.",
        );
      return Response.json(value, { status: response.status });
    },
  });
  return { config, api, request };
}

function timedResponse(
  response: Response,
  timing: CliTiming,
  started: number,
  fields: TimingFields,
): Response {
  const completed = (outcome: NonNullable<TimingFields["outcome"]>) =>
    timing.record("http", timing.now() - started, { ...fields, outcome });
  if (!response.body) {
    completed(response.ok ? "success" : "failure");
    return response;
  }
  const reader = response.body.getReader();
  let finished = false;
  let canceling = false;
  const finish = (outcome: NonNullable<TimingFields["outcome"]>) => {
    if (finished) return;
    finished = true;
    completed(outcome);
    reader.releaseLock();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          finish(canceling ? "canceled" : response.ok ? "success" : "failure");
          controller.close();
        } else controller.enqueue(next.value);
      } catch (error) {
        finish("failure");
        controller.error(error);
      }
    },
    async cancel(reason) {
      canceling = true;
      try {
        await reader.cancel(reason);
      } finally {
        finish("canceled");
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export async function readJson(response: Response): Promise<unknown> {
  const content = await readBounded(response, 8 * 1024 * 1024);
  try {
    return JSON.parse(content.toString("utf8"));
  } catch {
    throw new CliError(
      "invalid_response",
      "TeamHub returned an invalid JSON response.",
    );
  }
}
export async function readBounded(
  response: Response,
  limit: number,
): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return Buffer.concat(chunks, size);
      size += next.value.byteLength;
      if (size > limit)
        throw new CliError(
          "too_large",
          "TeamHub response exceeds the size limit.",
        );
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
