import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import type { LocalMcpRelayDescriptor } from "@linger/wire-contracts/runner-gateway/types";
import { Agent } from "undici";

import type { LocalMcpRelayRunIdentity } from "./runner-gateway.js";
import {
  createAgentLogger,
  logAgentEvent,
  type AgentLogger,
} from "../observability/agent-log.js";
import { isRecord } from "@linger/service-kit";

export interface LocalMcpRelayServer {
  readonly name: string;
  readonly url: string;
  readonly toolNames: readonly string[];
  readonly httpHeaders?: Readonly<Record<string, string>>;
}

export interface LocalMcpRelayOperationAuthorizer {
  authorizeLocalMcpRelay(options: {
    run: LocalMcpRelayRunIdentity;
    operationId: string;
    executionLeaseId: string;
    descriptor: LocalMcpRelayDescriptor;
    methodClass: LocalMcpRelayMethodClass;
    signal?: AbortSignal;
  }): void | Promise<void>;
}

export interface LocalMcpRelayRegistrar {
  register(options: {
    run: LocalMcpRelayRunIdentity;
    expiresAt: string;
    servers: readonly LocalMcpRelayServer[];
    signal?: AbortSignal;
  }): readonly LocalMcpRelayDescriptor[];
  rebind(
    previous: LocalMcpRelayRunIdentity,
    next: LocalMcpRelayRunIdentity,
  ): void;
  revoke(run: LocalMcpRelayRunIdentity): void;
}

interface RelayAuthority {
  readonly relayId: string;
  readonly tokenHash: Buffer;
  readonly descriptor: LocalMcpRelayDescriptor;
  run: LocalMcpRelayRunIdentity;
  readonly target: URL;
  readonly targetHeaders: Readonly<Record<string, string>>;
  readonly allowedTools: ReadonlySet<string>;
  readonly expiresAt: number;
  readonly activeControllers: Set<AbortController>;
  activeRequests: number;
}

interface AuditedToolCall {
  readonly auditId: string;
  readonly requestId: string | number;
  readonly toolName: string;
}

interface AuditedToolCallOutcome {
  readonly auditId: string;
  readonly outcome: "succeeded" | "failed" | "canceled";
  readonly httpStatus: number;
}

export type LocalMcpRelayMethodClass =
  | "initialize"
  | "initialized"
  | "tools_list"
  | "tools_call"
  | "other";

type LocalMcpRelayRequestOutcome =
  | "succeeded"
  | "rejected"
  | "failed"
  | "canceled";

interface InspectedRelayRequest {
  readonly methodClass: LocalMcpRelayMethodClass;
  readonly toolCalls: readonly Omit<AuditedToolCall, "auditId">[];
}

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_AUDIT_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_JSON_RPC_BATCH_ENTRIES = 32;
const MAX_TOOL_CALLS_PER_REQUEST = 8;
const MAX_ACTIVE_REQUESTS_PER_OPERATION = 8;
const MAX_ACTIVE_REQUESTS = 64;
const REQUEST_TIMEOUT_MS = 30_000;
const STREAMABLE_HTTP_METHODS = new Set(["GET", "POST", "DELETE"]);
const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
] as const;
const RELAY_IDENTITY_HEADERS = [
  "authorization",
  "host",
  "content-length",
  "cookie",
  "forwarded",
  "via",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-linger-operation-id",
  "x-linger-execution-lease-id",
] as const;

export class LocalMcpRelay implements LocalMcpRelayRegistrar {
  readonly #publicOrigin: URL;
  readonly #authorizer: LocalMcpRelayOperationAuthorizer;
  readonly #auditLog: AgentLogger;
  // Node 26.5.0's bundled Undici can queue POST bodies behind an open HTTP/2
  // subscription. Use the pinned, fixed client for this relay only.
  readonly #upstreamDispatcher = new Agent({ allowH2: true });
  readonly #authorities = new Map<string, RelayAuthority>();
  readonly #runAuthorities = new Map<string, Set<string>>();
  readonly #operationActiveRequests = new Map<string, number>();
  readonly #maxActiveRequestsPerOperation: number;
  readonly #maxActiveRequests: number;
  #activeRequests = 0;
  #closed = false;
  #closePromise?: Promise<void>;

  constructor(options: {
    publicOrigin: string;
    authorizer: LocalMcpRelayOperationAuthorizer;
    auditLog?: AgentLogger;
    maxActiveRequestsPerOperation?: number;
    maxActiveRequests?: number;
  }) {
    this.#publicOrigin = parsePublicOrigin(options.publicOrigin);
    this.#authorizer = options.authorizer;
    this.#auditLog = options.auditLog ?? createAgentLogger();
    this.#maxActiveRequestsPerOperation = positiveIntegerOrDefault(
      options.maxActiveRequestsPerOperation,
      MAX_ACTIVE_REQUESTS_PER_OPERATION,
      "maxActiveRequestsPerOperation",
    );
    this.#maxActiveRequests = positiveIntegerOrDefault(
      options.maxActiveRequests,
      MAX_ACTIVE_REQUESTS,
      "maxActiveRequests",
    );
  }

  register(options: {
    run: LocalMcpRelayRunIdentity;
    expiresAt: string;
    servers: readonly LocalMcpRelayServer[];
    signal?: AbortSignal;
  }): readonly LocalMcpRelayDescriptor[] {
    if (this.#closed) throw new Error("Local MCP Relay is closed");
    options.signal?.throwIfAborted();
    const expiresAt = Date.parse(options.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new Error("Local MCP Relay expiry is invalid");
    }
    const names = new Set<string>();
    const descriptors: LocalMcpRelayDescriptor[] = [];
    const pendingAuthorities: RelayAuthority[] = [];
    for (const server of options.servers) {
      options.signal?.throwIfAborted();
      if (names.has(server.name)) {
        throw new Error(`Local MCP Relay server is duplicated: ${server.name}`);
      }
      names.add(server.name);
      const target = parseRelayTarget(server.url);
      const toolNames = [...server.toolNames];
      if (new Set(toolNames).size !== toolNames.length) {
        throw new Error(`Local MCP Relay tool is duplicated: ${server.name}`);
      }
      const relayId = randomUUID();
      const token = randomBytes(32).toString("base64url");
      const descriptor: LocalMcpRelayDescriptor = {
        name: server.name,
        relay_url: new URL(
          `v1/local-mcp-relay/${relayId}`,
          this.#publicOrigin,
        ).toString(),
        relay_token: token,
        tool_names: toolNames,
        expires_at: new Date(expiresAt).toISOString(),
      };
      pendingAuthorities.push({
        relayId,
        tokenHash: tokenHash(token),
        descriptor,
        run: { ...options.run },
        target,
        targetHeaders: normalizeTargetHeaders(server.httpHeaders),
        allowedTools: new Set(descriptor.tool_names),
        expiresAt: Date.parse(descriptor.expires_at),
        activeControllers: new Set(),
        activeRequests: 0,
      });
      descriptors.push(structuredClone(descriptor));
    }
    this.revoke(options.run);
    if (pendingAuthorities.length > 0) {
      const runKey = localRunKey(options.run);
      const owned = new Set<string>();
      for (const authority of pendingAuthorities) {
        this.#authorities.set(authority.relayId, authority);
        owned.add(authority.relayId);
      }
      this.#runAuthorities.set(runKey, owned);
    }
    return descriptors;
  }

  revoke(run: LocalMcpRelayRunIdentity): void {
    const runKey = localRunKey(run);
    const relayIds = this.#runAuthorities.get(runKey);
    if (!relayIds) return;
    this.#runAuthorities.delete(runKey);
    for (const relayId of relayIds) {
      const authority = this.#authorities.get(relayId);
      for (const controller of authority?.activeControllers ?? []) {
        controller.abort();
      }
      this.#authorities.delete(relayId);
    }
  }

  rebind(
    previous: LocalMcpRelayRunIdentity,
    next: LocalMcpRelayRunIdentity,
  ): void {
    const previousKey = localRunKey(previous);
    const relayIds = this.#runAuthorities.get(previousKey);
    if (!relayIds) return;
    const nextKey = localRunKey(next);
    if (nextKey !== previousKey && this.#runAuthorities.has(nextKey)) {
      throw new Error("Local MCP Relay authority already exists for this Run");
    }
    this.#runAuthorities.delete(previousKey);
    this.#runAuthorities.set(nextKey, relayIds);
    for (const relayId of relayIds) {
      const authority = this.#authorities.get(relayId);
      if (authority) authority.run = { ...next };
    }
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    for (const authority of this.#authorities.values()) {
      for (const controller of authority.activeControllers) controller.abort();
    }
    this.#authorities.clear();
    this.#runAuthorities.clear();
    this.#closePromise = this.#upstreamDispatcher.destroy();
    return this.#closePromise;
  }

  async handle(relayId: string, request: Request): Promise<Response> {
    const totalStartedAt = performance.now();
    if (this.#closed) {
      return relayError(503, "Local MCP Relay is closed", {
        "x-linger-relay-not-dispatched": "1",
      });
    }
    const authority = this.#authorities.get(relayId);
    if (!authority) {
      return relayError(404, "Local MCP Relay authority is unavailable");
    }
    if (authority.expiresAt <= Date.now()) {
      if (authority) this.revoke(authority.run);
      return relayError(404, "Local MCP Relay authority is unavailable");
    }
    if (!STREAMABLE_HTTP_METHODS.has(request.method)) {
      return relayError(405, "Local MCP Relay method is not allowed", {
        allow: "GET, POST, DELETE",
      });
    }
    if (!hasValidContentType(request)) {
      return relayError(415, "Local MCP Relay POST requires application/json");
    }
    const token = bearerToken(request.headers.get("authorization"));
    if (!token || !matchesToken(authority.tokenHash, token)) {
      return relayError(401, "Local MCP Relay token is invalid");
    }
    const operationId = request.headers.get("x-linger-operation-id");
    const executionLeaseId = request.headers.get("x-linger-execution-lease-id");
    if (!operationId || !executionLeaseId) {
      return relayError(401, "Local MCP Relay operation identity is missing");
    }
    const authorizedRun = { ...authority.run };
    let authorizationMs = 0;
    let upstreamMs = 0;
    let methodClass: LocalMcpRelayMethodClass = "other";
    let timingLogged = false;
    const logRequestTiming = (
      httpStatus: number,
      outcome: LocalMcpRelayRequestOutcome,
    ): void => {
      if (timingLogged) return;
      timingLogged = true;
      const totalMs = Math.max(
        Math.round(performance.now() - totalStartedAt),
        authorizationMs + upstreamMs,
      );
      logAgentEvent(
        methodClass === "initialize" ||
          methodClass === "initialized" ||
          methodClass === "tools_list"
          ? "info"
          : "debug",
        "local_mcp_relay.request_timing",
        {
          serverName: authority.descriptor.name,
          operationId,
          runId: authorizedRun.executionRunRef,
          methodClass,
          authorizationMs,
          upstreamMs,
          totalMs,
          httpStatus,
          outcome,
        },
      );
    };
    const operationKey = `${operationId}\0${executionLeaseId}`;
    const operationActiveRequests =
      this.#operationActiveRequests.get(operationKey) ?? 0;
    if (
      operationActiveRequests + 1 > this.#maxActiveRequestsPerOperation ||
      this.#activeRequests + 1 > this.#maxActiveRequests
    ) {
      logRequestTiming(429, "rejected");
      return relayError(429, "Local MCP Relay concurrency limit reached");
    }
    let requestUnits = 1;
    authority.activeRequests += 1;
    this.#activeRequests += 1;
    this.#operationActiveRequests.set(
      operationKey,
      operationActiveRequests + 1,
    );
    const requestController = new AbortController();
    authority.activeControllers.add(requestController);
    let released = false;
    const releaseRequest = (): void => {
      if (released) return;
      released = true;
      authority.activeControllers.delete(requestController);
      authority.activeRequests -= requestUnits;
      this.#activeRequests -= requestUnits;
      const remaining =
        (this.#operationActiveRequests.get(operationKey) ?? requestUnits) -
        requestUnits;
      if (remaining === 0) this.#operationActiveRequests.delete(operationKey);
      else this.#operationActiveRequests.set(operationKey, remaining);
    };
    const authorizationSignal = AbortSignal.any([
      request.signal,
      requestController.signal,
      AbortSignal.timeout(
        Math.max(1, Math.min(10_000, authority.expiresAt - Date.now())),
      ),
    ]);
    let body: Uint8Array | undefined;
    let toolCalls: readonly Omit<AuditedToolCall, "auditId">[];
    try {
      body = await readBoundedBody(
        request,
        AbortSignal.any([request.signal, requestController.signal]),
      );
      const inspected = inspectRelayRequestBody(body, authority.allowedTools);
      methodClass = inspected.methodClass;
      toolCalls = inspected.toolCalls;
    } catch (error) {
      releaseRequest();
      const httpStatus =
        requestController.signal.aborted && !request.signal.aborted
          ? 403
          : error instanceof RelayRequestError
            ? error.status
            : 400;
      logRequestTiming(httpStatus, "rejected");
      return relayError(
        httpStatus,
        error instanceof Error
          ? error.message
          : "Local MCP Relay request is invalid",
      );
    }
    const authorizationStartedAt = performance.now();
    let upstreamStartedAt: number | undefined;
    try {
      await this.#authorizer.authorizeLocalMcpRelay({
        run: authorizedRun,
        operationId,
        executionLeaseId,
        descriptor: authority.descriptor,
        methodClass,
        signal: authorizationSignal,
      });
      authorizationSignal.throwIfAborted();
    } catch {
      authorizationMs = Math.round(performance.now() - authorizationStartedAt);
      releaseRequest();
      logRequestTiming(403, "rejected");
      return relayError(403, "Local MCP Relay operation is not authorized");
    }
    authorizationMs = Math.round(performance.now() - authorizationStartedAt);
    const additionalUnits = Math.max(1, toolCalls.length) - requestUnits;
    if (
      additionalUnits > 0 &&
      ((this.#operationActiveRequests.get(operationKey) ?? requestUnits) +
        additionalUnits >
        this.#maxActiveRequestsPerOperation ||
        this.#activeRequests + additionalUnits > this.#maxActiveRequests)
    ) {
      releaseRequest();
      logRequestTiming(429, "rejected");
      return relayError(429, "Local MCP Relay concurrency limit reached");
    }
    if (additionalUnits > 0) {
      requestUnits += additionalUnits;
      authority.activeRequests += additionalUnits;
      this.#activeRequests += additionalUnits;
      this.#operationActiveRequests.set(
        operationKey,
        (this.#operationActiveRequests.get(operationKey) ?? 1) +
          additionalUnits,
      );
    }
    const auditedToolCalls: AuditedToolCall[] = toolCalls.map((call) => ({
      ...call,
      auditId: randomUUID(),
    }));
    // The audit is a structured log line; it carries identities and outcomes
    // only, never tool arguments, results, or relay credentials.
    const auditFields = (call: AuditedToolCall) => ({
      auditId: call.auditId,
      runId: authorizedRun.executionRunRef,
      operationId,
      serverName: authority.descriptor.name,
      toolName: call.toolName,
    });
    for (const call of auditedToolCalls) {
      this.#auditLog.log(
        "info",
        "local_mcp_relay.tool_call_started",
        auditFields(call),
      );
    }
    let auditFinished = false;
    const finishAudit = (outcomes: readonly AuditedToolCallOutcome[]): void => {
      if (auditFinished) return;
      auditFinished = true;
      for (const [index, call] of auditedToolCalls.entries()) {
        const { outcome, httpStatus } = outcomes[index]!;
        this.#auditLog.log(
          outcome === "succeeded" ? "info" : "warn",
          "local_mcp_relay.tool_call_finished",
          { ...auditFields(call), outcome, httpStatus },
        );
      }
    };
    try {
      const headers = relayHeaders(request.headers, authority.targetHeaders);
      const remainingAuthorityMs = Math.max(
        1,
        authority.expiresAt - Date.now(),
      );
      upstreamStartedAt = performance.now();
      const upstreamRequest: RequestInit & { dispatcher: Agent } = {
        dispatcher: this.#upstreamDispatcher,
        method: request.method,
        headers,
        body: body === undefined ? undefined : Uint8Array.from(body).buffer,
        redirect: "error",
        signal: AbortSignal.any([
          request.signal,
          requestController.signal,
          AbortSignal.timeout(
            Math.min(REQUEST_TIMEOUT_MS, remainingAuthorityMs),
          ),
        ]),
      };
      const response = await fetch(authority.target, upstreamRequest);
      upstreamMs = Math.round(performance.now() - upstreamStartedAt);
      logRequestTiming(response.status, response.ok ? "succeeded" : "failed");
      // Only this relay may attest non-dispatch. Never trust an upstream's hint.
      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete("x-linger-relay-not-dispatched");
      if (!response.body) {
        finishAudit(
          auditOutcomes({
            calls: auditedToolCalls,
            body: new Uint8Array(),
            contentType: response.headers.get("content-type"),
            httpStatus: response.status,
          }),
        );
        releaseRequest();
        return new Response(null, {
          status: response.status,
          headers: responseHeaders,
        });
      }
      return new Response(
        retainActiveResponse({
          source: response.body,
          abort: () => requestController.abort(),
          canceled: () =>
            request.signal.aborted || requestController.signal.aborted,
          release: releaseRequest,
          complete: (responseBody) =>
            finishAudit(
              auditOutcomes({
                calls: auditedToolCalls,
                body: responseBody,
                contentType: response.headers.get("content-type"),
                httpStatus: response.status,
              }),
            ),
          fail: (canceled) =>
            finishAudit(
              uniformAuditOutcomes(
                auditedToolCalls,
                canceled ? "canceled" : "failed",
                canceled ? 499 : 502,
              ),
            ),
        }),
        {
          status: response.status,
          headers: responseHeaders,
        },
      );
    } catch {
      if (upstreamStartedAt !== undefined) {
        upstreamMs = Math.round(performance.now() - upstreamStartedAt);
      }
      const canceled =
        request.signal.aborted || requestController.signal.aborted;
      finishAudit(
        uniformAuditOutcomes(
          auditedToolCalls,
          canceled ? "canceled" : "failed",
          canceled ? 499 : 502,
        ),
      );
      releaseRequest();
      logRequestTiming(502, canceled ? "canceled" : "failed");
      return relayError(502, "Local MCP Relay upstream request failed");
    }
  }
}

class RelayRequestError extends Error {
  constructor(
    readonly status: 400 | 413 | 429,
    message: string,
  ) {
    super(message);
  }
}

const readBoundedBody = async (
  request: Request,
  signal: AbortSignal,
): Promise<Uint8Array | undefined> => {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new RelayRequestError(413, "Local MCP Relay body is too large");
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const abort = (): void => void reader.cancel(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > MAX_BODY_BYTES) {
        await reader.cancel("Local MCP Relay body is too large");
        throw new RelayRequestError(413, "Local MCP Relay body is too large");
      }
      chunks.push(Uint8Array.from(next.value));
    }
    return concatChunks(chunks, totalBytes);
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
};

const hasValidContentType = (request: Request): boolean =>
  request.method !== "POST" ||
  request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase() === "application/json";

const inspectRelayRequestBody = (
  body: Uint8Array | undefined,
  allowedTools: ReadonlySet<string>,
): InspectedRelayRequest => {
  if (!body || body.byteLength === 0) {
    return { methodClass: "other", toolCalls: [] };
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(body).toString("utf8")) as unknown;
  } catch {
    return { methodClass: "other", toolCalls: [] };
  }
  const requests = Array.isArray(value) ? value : [value];
  if (requests.length > MAX_JSON_RPC_BATCH_ENTRIES) {
    throw new RelayRequestError(413, "Local MCP Relay batch is too large");
  }
  const calls: Omit<AuditedToolCall, "auditId">[] = [];
  const requestIds = new Set<string>();
  for (const request of requests) {
    if (!isRecord(request) || request.method !== "tools/call") continue;
    const name = isRecord(request.params) ? request.params.name : undefined;
    if (typeof name !== "string" || !allowedTools.has(name)) {
      throw new RelayRequestError(400, "Local MCP Relay tool is not allowed");
    }
    const requestId = request.id;
    if (typeof requestId !== "string" && typeof requestId !== "number") {
      throw new RelayRequestError(
        400,
        "Local MCP Relay tool call identity is invalid",
      );
    }
    const key = jsonRpcIdKey(requestId);
    if (requestIds.has(key)) {
      throw new RelayRequestError(
        400,
        "Local MCP Relay tool call identity is duplicated",
      );
    }
    requestIds.add(key);
    calls.push({ requestId, toolName: name });
    if (calls.length > MAX_TOOL_CALLS_PER_REQUEST) {
      throw new RelayRequestError(
        429,
        "Local MCP Relay tool call limit reached",
      );
    }
  }
  return { methodClass: classifyRelayMethod(requests), toolCalls: calls };
};

const classifyRelayMethod = (
  requests: readonly unknown[],
): LocalMcpRelayMethodClass => {
  if (requests.length === 0) return "other";
  const methods = requests.map((request) =>
    isRecord(request) && typeof request.method === "string"
      ? request.method
      : undefined,
  );
  const method = methods[0];
  if (method === undefined || methods.some((candidate) => candidate !== method))
    return "other";
  switch (method) {
    case "tools/call":
      return "tools_call";
    case "initialize":
      return "initialize";
    case "notifications/initialized":
      return "initialized";
    case "tools/list":
      return "tools_list";
    default:
      return "other";
  }
};

const relayHeaders = (
  source: Headers,
  target: Readonly<Record<string, string>>,
): Headers => {
  const headers = new Headers(source);
  for (const name of [...HOP_BY_HOP_HEADERS, ...RELAY_IDENTITY_HEADERS]) {
    headers.delete(name);
  }
  for (const [name, value] of Object.entries(target)) headers.set(name, value);
  return headers;
};

const normalizeTargetHeaders = (
  input: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> => {
  const headers = new Headers(input);
  for (const name of [
    ...HOP_BY_HOP_HEADERS,
    ...RELAY_IDENTITY_HEADERS.filter((name) => name !== "authorization"),
  ]) {
    if (headers.has(name)) {
      throw new TypeError(
        `Local MCP Relay target header is forbidden: ${name}`,
      );
    }
  }
  return Object.freeze(Object.fromEntries(headers.entries()));
};

const retainActiveResponse = (options: {
  source: ReadableStream<Uint8Array>;
  abort: () => void;
  canceled: () => boolean;
  complete: (body: Uint8Array | undefined) => void;
  fail: (canceled: boolean) => void;
  release: () => void;
}): ReadableStream<Uint8Array> => {
  const reader = options.source.getReader();
  const chunks: Uint8Array[] = [];
  let capturedBytes = 0;
  let captureOverflow = false;
  let settled = false;
  const settle = (action: () => void): void => {
    if (settled) return;
    settled = true;
    try {
      action();
    } finally {
      options.release();
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          settle(() =>
            options.complete(
              captureOverflow ? undefined : concatChunks(chunks, capturedBytes),
            ),
          );
          controller.close();
        } else {
          capturedBytes += next.value.byteLength;
          if (capturedBytes <= MAX_AUDIT_RESPONSE_BYTES) {
            chunks.push(Uint8Array.from(next.value));
          } else {
            captureOverflow = true;
            chunks.length = 0;
          }
          controller.enqueue(next.value);
        }
      } catch (error) {
        settle(() => options.fail(options.canceled()));
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } catch {
        // Cancellation is represented by the audit outcome, not a second error.
      } finally {
        options.abort();
        settle(() => options.fail(true));
      }
    },
  });
};

const auditOutcomes = (options: {
  calls: readonly AuditedToolCall[];
  body: Uint8Array | undefined;
  contentType: string | null;
  httpStatus: number;
}): readonly AuditedToolCallOutcome[] => {
  if (options.calls.length === 0) return [];
  if (
    options.httpStatus < 200 ||
    options.httpStatus >= 300 ||
    options.body === undefined
  ) {
    return uniformAuditOutcomes(options.calls, "failed", options.httpStatus);
  }
  const responses = parseJsonRpcResponses(options.body, options.contentType);
  if (!responses) {
    return uniformAuditOutcomes(options.calls, "failed", options.httpStatus);
  }
  const byId = new Map<string, Record<string, unknown>>();
  const duplicateIds = new Set<string>();
  for (const response of responses) {
    const responseId = response.id;
    if (typeof responseId !== "string" && typeof responseId !== "number") {
      continue;
    }
    const key = jsonRpcIdKey(responseId);
    if (byId.has(key)) duplicateIds.add(key);
    byId.set(key, response);
  }
  return options.calls.map((call) => {
    const responseId = jsonRpcIdKey(call.requestId);
    const response = byId.get(responseId);
    const failed =
      !response ||
      duplicateIds.has(responseId) ||
      response.jsonrpc !== "2.0" ||
      Object.hasOwn(response, "error") ||
      !Object.hasOwn(response, "result") ||
      (isRecord(response.result) && response.result.isError === true);
    return {
      auditId: call.auditId,
      outcome: failed ? "failed" : "succeeded",
      httpStatus: options.httpStatus,
    };
  });
};

const uniformAuditOutcomes = (
  calls: readonly AuditedToolCall[],
  outcome: "failed" | "canceled",
  httpStatus: number,
): readonly AuditedToolCallOutcome[] =>
  calls.map(({ auditId }) => ({ auditId, outcome, httpStatus }));

const parseJsonRpcResponses = (
  body: Uint8Array,
  contentType: string | null,
): readonly Record<string, unknown>[] | undefined => {
  const text = Buffer.from(body).toString("utf8");
  const values: unknown[] = [];
  try {
    if (contentType?.toLowerCase().includes("text/event-stream")) {
      for (const event of text.split(/\r?\n\r?\n/)) {
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data && data !== "[DONE]") values.push(JSON.parse(data));
      }
    } else {
      values.push(JSON.parse(text));
    }
  } catch {
    return undefined;
  }
  const flattened = values.flatMap((value) =>
    Array.isArray(value) ? value : [value],
  );
  return flattened.filter(isRecord);
};

const jsonRpcIdKey = (value: string | number): string =>
  `${typeof value}:${String(value)}`;

const concatChunks = (
  chunks: readonly Uint8Array[],
  totalBytes: number,
): Uint8Array => {
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
};

const parsePublicOrigin = (value: string): URL => {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("Local MCP Relay public origin is invalid");
  }
  url.pathname = `${url.pathname.replace(/\/?$/, "/")}`;
  return url;
};

const parseRelayTarget = (value: string): URL => {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("Local MCP Relay target is invalid");
  }
  return url;
};

const bearerToken = (value: string | null): string | undefined => {
  const match = /^Bearer ([^\s]+)$/.exec(value ?? "");
  return match?.[1];
};

const tokenHash = (token: string): Buffer =>
  createHash("sha256").update(token, "utf8").digest();

const matchesToken = (expected: Buffer, actual: string): boolean =>
  timingSafeEqual(expected, tokenHash(actual));

const localRunKey = (run: LocalMcpRelayRunIdentity): string =>
  [
    "context",
    run.computerId,
    run.tenantId,
    run.agentId,
    run.executionRunRef,
    run.executionContextKey,
    run.runtimeInstanceId,
    run.viewDigest,
  ].join("\0");

const relayError = (
  status: number,
  message: string,
  headers?: Readonly<Record<string, string>>,
): Response =>
  Response.json(
    { error: { code: "local_mcp_relay_error", message } },
    { status, headers },
  );

const positiveIntegerOrDefault = (
  value: number | undefined,
  defaultValue: number,
  label: string,
): number => {
  const resolved = value ?? defaultValue;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return resolved;
};
