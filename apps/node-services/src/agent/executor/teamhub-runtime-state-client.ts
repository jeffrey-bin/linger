import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { logAgentEvent } from "../observability/agent-log.js";
import {
  createTeamHubAgentRuntimeStateClient,
  type TeamHubAgentCallbackFetch,
} from "@linger/wire-contracts/teamhub-internal/client";
import type { components } from "@linger/wire-contracts/teamhub-internal/types";
import { isRecord } from "@linger/service-kit";

export type RuntimeStateSchemas = components["schemas"];
export type RuntimeConfigSnapshot =
  RuntimeStateSchemas["AgentRuntimeConfigSnapshot"];
export type RuntimeDeletionSnapshot =
  RuntimeStateSchemas["AgentRuntimeDeletionSnapshot"];
export type RuntimeContext = RuntimeStateSchemas["AgentExecutionContext"];
export type AcceptedContextState =
  RuntimeStateSchemas["AgentRuntimeAcceptedContextState"];
export type RuntimeInput = RuntimeStateSchemas["AgentRuntimeInput"];
export type RuntimeSession = RuntimeStateSchemas["AgentRuntimeSession"];
export type RuntimeSessionCheckpoint =
  RuntimeStateSchemas["AgentRuntimeSessionCheckpoint"];
type RuntimeLocalRun = RuntimeStateSchemas["AgentLocalRun"];

/** Each process start opens a new epoch; its start time only helps reading logs. */
const newAgentServiceEpoch = (): string =>
  `agent-epoch-v1:${Date.now()}:${randomUUID().replaceAll("-", "")}`;

export interface TeamHubRuntimeStateClientOptions {
  readonly baseUrl: string;
  readonly serviceToken: string;
  readonly fetch?: TeamHubAgentCallbackFetch;
  readonly requestTimeoutMs?: number;
  readonly epoch?: string;
}

export class TeamHubRuntimeStateError extends Error {
  override readonly name = "TeamHubRuntimeStateError";

  constructor(
    readonly status: number | null,
    message: string,
    readonly code?: string,
    readonly retryable = status === null || status >= 500,
    readonly priorAttemptOutcomeUnknown = false,
  ) {
    super(message);
  }
}

/** True when a TeamHub runtime-state call answered 404. */
export function isTeamHubNotFound(error: unknown): boolean {
  return isRecord(error) && error.status === 404;
}

export interface TeamHubRuntimeStateClient {
  /** The Agent Service epoch every Runtime write of this process names. */
  readonly epoch: string;
  /**
   * Opens this process's epoch: TeamHub interrupts the Runs of the previous
   * one and lists the Contexts with queued work.
   */
  startEpoch(
    signal?: AbortSignal,
  ): Promise<RuntimeStateSchemas["AgentServiceEpochStart"]>;
  getConfig(
    agentId: string,
    revision?: string,
    signal?: AbortSignal,
    configReadId?: string,
  ): Promise<RuntimeConfigSnapshot>;
  getDeletionSnapshot(
    agentId: string,
    signal?: AbortSignal,
  ): Promise<RuntimeDeletionSnapshot>;
  listContexts(
    agentId?: string,
    signal?: AbortSignal,
  ): Promise<RuntimeContext[]>;
  reconcileContexts(
    body: RuntimeStateSchemas["ReconcileAgentExecutionContextsRequest"],
    signal?: AbortSignal,
  ): Promise<RuntimeStateSchemas["ReconcileAgentExecutionContextsResult"]>;
  /** Read only: lists recently run Context keys without activating them. */
  listRecentlyUsedContexts(signal?: AbortSignal): Promise<readonly string[]>;
  getContext(contextKey: string, signal?: AbortSignal): Promise<RuntimeContext>;
  ensureContext(
    body: RuntimeStateSchemas["EnsureAgentExecutionContextRequest"],
    signal?: AbortSignal,
  ): Promise<RuntimeStateSchemas["EnsureAgentExecutionContextResult"]>;
  setContextResidency(
    body: RuntimeStateSchemas["SetAgentExecutionContextResidencyRequest"],
    signal?: AbortSignal,
  ): Promise<RuntimeContext>;
  deleteContext(
    body: RuntimeStateSchemas["DeleteAgentExecutionContextRequest"],
    signal?: AbortSignal,
  ): Promise<RuntimeStateSchemas["AgentRuntimeDeletedResult"]>;
  acceptTrustedNotification(
    body: RuntimeStateSchemas["AcceptAgentTrustedNotificationRequest"],
    signal?: AbortSignal,
  ): Promise<RuntimeStateSchemas["AcceptAgentTrustedNotificationResult"]>;
  submitTrustedTurn(
    body: RuntimeStateSchemas["SubmitAgentTrustedTurnRequest"],
    signal?: AbortSignal,
  ): Promise<RuntimeStateSchemas["SubmitAgentTrustedTurnResult"]>;
  getRun(
    contextKey: string,
    runId: string,
    signal?: AbortSignal,
  ): Promise<RuntimeStateSchemas["AgentLocalRun"]>;
  /** Contexts whose queued Run or Message steer waited past its wake hint. */
  listWaitingContexts(signal?: AbortSignal): Promise<readonly string[]>;
  claimRun(
    body: RuntimeStateSchemas["ClaimAgentLocalRunRequest"],
    signal?: AbortSignal,
  ): Promise<RuntimeStateSchemas["ClaimAgentLocalRunResult"]>;
  requeueRun(
    body: RuntimeStateSchemas["RequeueAgentLocalRunRequest"],
    signal?: AbortSignal,
  ): Promise<RuntimeStateSchemas["AgentRuntimeSuccessResult"]>;
  finishRun(
    body: RuntimeStateSchemas["FinishAgentLocalRunRequest"],
    signal?: AbortSignal,
  ): Promise<RuntimeStateSchemas["FinishAgentLocalRunResult"]>;
  cancelRun(
    body: RuntimeStateSchemas["CancelAgentLocalRunRequest"],
    signal?: AbortSignal,
  ): Promise<RuntimeStateSchemas["CancelAgentLocalRunResult"]>;
  enqueueSteer(
    body: RuntimeStateSchemas["EnqueueAgentSteerRequest"],
    signal?: AbortSignal,
  ): Promise<RuntimeStateSchemas["EnqueueAgentSteerResult"]>;
  assignSteerRun(
    body: RuntimeStateSchemas["AssignAgentSteerRunRequest"],
    signal?: AbortSignal,
  ): Promise<RuntimeStateSchemas["AgentRuntimeSuccessResult"]>;
  completeSteer(
    body: RuntimeStateSchemas["CompleteAgentSteerRequest"],
    signal?: AbortSignal,
  ): Promise<RuntimeStateSchemas["AgentRuntimeSuccessResult"]>;
  getSession(
    contextKey: string,
    signal?: AbortSignal,
  ): Promise<RuntimeStateSchemas["GetAgentRuntimeSessionResult"]>;
  checkpointSession(
    body: RuntimeStateSchemas["CheckpointAgentRuntimeSessionRequest"],
    signal?: AbortSignal,
  ): Promise<RuntimeSession>;
  clearSession(
    body: RuntimeStateSchemas["ClearAgentRuntimeSessionRequest"],
    signal?: AbortSignal,
  ): Promise<RuntimeStateSchemas["ClearAgentRuntimeSessionResult"]>;
  getWorkState(
    contextKey: string,
    signal?: AbortSignal,
  ): Promise<RuntimeStateSchemas["AgentRuntimeWorkState"]>;
  openStatus(
    body: RuntimeStateSchemas["OpenAgentRuntimeStatusRequest"],
    signal?: AbortSignal,
  ): Promise<RuntimeStateSchemas["OpenAgentRuntimeStatusResult"]>;
  offerPresentationEvents(
    body: RuntimeStateSchemas["OfferAgentRuntimePresentationEventsRequest"],
    signal?: AbortSignal,
  ): Promise<RuntimeStateSchemas["OfferAgentRuntimePresentationEventsResult"]>;
  getLocalComputer(
    computerId: string,
    signal?: AbortSignal,
  ): Promise<RuntimeStateSchemas["AgentRuntimeLocalComputer"]>;
  connectLocalComputer(
    body: RuntimeStateSchemas["ConnectAgentRuntimeLocalComputerRequest"],
    signal?: AbortSignal,
  ): Promise<RuntimeStateSchemas["ConnectAgentRuntimeLocalComputerResult"]>;
  touchLocalComputer(
    body: RuntimeStateSchemas["TouchAgentRuntimeLocalComputerRequest"],
    signal?: AbortSignal,
  ): Promise<RuntimeStateSchemas["AgentRuntimeLocalComputer"]>;
  removeLocalComputer(
    body: RuntimeStateSchemas["AgentRuntimeLocalComputerCredentialRequest"],
    signal?: AbortSignal,
  ): Promise<RuntimeStateSchemas["AgentRuntimeLocalComputerRemovalResult"]>;
  recordRunOperation(
    body: RuntimeStateSchemas["RecordAgentLocalRunOperationRequest"],
    signal?: AbortSignal,
  ): Promise<RuntimeStateSchemas["AgentRuntimeSuccessResult"]>;
}

export const createTeamHubRuntimeStateClient = (
  options: TeamHubRuntimeStateClientOptions,
): TeamHubRuntimeStateClient => {
  const timeout = options.requestTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new TypeError("requestTimeoutMs must be a positive safe integer");
  }
  const fetchRequest = options.fetch ?? globalThis.fetch;
  const responsesAfterUnknownAttempt = new WeakSet<Response>();
  const retryingFetch: TeamHubAgentCallbackFetch = async (input, init) => {
    const retryableRequest =
      init?.method === "GET" ||
      requestBodyIsRepeatable(init?.body) ||
      isRepeatableRequest(input, init);
    const attempts = retryableRequest ? 3 : 1;
    let lastError: unknown;
    let priorAttemptOutcomeUnknown = false;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const configRead = recordRuntimeConfigFetchAttempt();
      const timeoutSignal = AbortSignal.timeout(timeout);
      const signal = init?.signal
        ? AbortSignal.any([init.signal, timeoutSignal])
        : timeoutSignal;
      try {
        const response = await Promise.race([
          fetchRequest(input, { ...init, signal }),
          rejectWhenAborted(signal),
        ]);
        if (configRead) configRead.httpStatus = response.status;
        if (response.status >= 500 && attempt < attempts) {
          priorAttemptOutcomeUnknown = true;
          await response.body?.cancel().catch(() => undefined);
          lastError = new Error(`HTTP ${response.status}`);
          continue;
        }
        const result = retryableRequest
          ? await bufferResponse(response, signal)
          : response;
        if (priorAttemptOutcomeUnknown)
          responsesAfterUnknownAttempt.add(result);
        return result;
      } catch (error) {
        priorAttemptOutcomeUnknown = true;
        lastError = error;
        if (init?.signal?.aborted || attempt === attempts) throw error;
      }
    }
    throw lastError;
  };
  const raw = createTeamHubAgentRuntimeStateClient({
    baseUrl: options.baseUrl,
    serviceToken: options.serviceToken,
    fetch: retryingFetch,
  });
  const epoch = options.epoch?.trim() || newAgentServiceEpoch();

  const request = async <T>(
    responsePromise: Promise<Response>,
    _signal?: AbortSignal,
  ): Promise<T> => {
    let response: Response;
    try {
      response = await responsePromise;
    } catch (error) {
      throw new TeamHubRuntimeStateError(
        null,
        `TeamHub Runtime State request failed: ${errorMessage(error)}`,
      );
    }
    if (!response.ok) {
      const detail = await readErrorDetail(response);
      throw new TeamHubRuntimeStateError(
        response.status,
        `TeamHub Runtime State returned HTTP ${response.status}${detail.text ? `: ${detail.text}` : ""}`,
        detail.code,
        detail.retryable,
        responsesAfterUnknownAttempt.has(response),
      );
    }
    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new TeamHubRuntimeStateError(
        response.status,
        `TeamHub Runtime State response JSON could not be read: ${errorMessage(error)}`,
        undefined,
        // Response headers may arrive before a transport failure. The claim
        // caller must reconcile ownership, not treat this as invalid wire data.
        error instanceof Error &&
          ["AbortError", "TimeoutError", "TypeError"].includes(error.name),
      );
    }
  };
  return {
    epoch,
    startEpoch: (signal) =>
      request<RuntimeStateSchemas["AgentServiceEpochStart"]>(
        raw.startEpoch({ epoch }, signal),
        signal,
      ),
    getConfig: (agentId, revision, signal, configReadId = randomUUID()) =>
      timeRuntimeConfigRead(agentId, signal, configReadId, () =>
        request<RuntimeConfigSnapshot>(
          raw.getConfig(agentId, revision, signal),
          signal,
        ),
      ),
    getDeletionSnapshot: (agentId, signal) =>
      request<RuntimeDeletionSnapshot>(
        raw.getDeletionSnapshot(agentId, signal),
        signal,
      ),
    listContexts: async (agentId, signal) =>
      (
        await request<RuntimeStateSchemas["AgentExecutionContextList"]>(
          raw.listContexts(agentId, signal),
          signal,
        )
      ).contexts,
    listRecentlyUsedContexts: async (signal) =>
      (
        await request<
          RuntimeStateSchemas["ListRecentlyUsedAgentRuntimeContextsResult"]
        >(raw.listRecentlyUsedContexts(signal), signal)
      ).contexts.map(({ context_key }) => context_key),
    reconcileContexts: (body, signal) =>
      request<RuntimeStateSchemas["ReconcileAgentExecutionContextsResult"]>(
        raw.reconcileContexts(body, signal),
        signal,
      ),
    getContext: (contextKey, signal) =>
      request<RuntimeContext>(raw.getContext(contextKey, signal), signal),
    ensureContext: (body, signal) =>
      request<RuntimeStateSchemas["EnsureAgentExecutionContextResult"]>(
        raw.ensureContext(body, signal),
        signal,
      ),
    setContextResidency: (body, signal) =>
      request<RuntimeContext>(raw.setContextResidency(body, signal), signal),
    deleteContext: (body, signal) =>
      request<RuntimeStateSchemas["AgentRuntimeDeletedResult"]>(
        raw.deleteContext(body, signal),
        signal,
      ),
    acceptTrustedNotification: (body, signal) =>
      request<RuntimeStateSchemas["AcceptAgentTrustedNotificationResult"]>(
        raw.acceptTrustedNotification(body, signal),
        signal,
      ),
    submitTrustedTurn: (body, signal) =>
      request<RuntimeStateSchemas["SubmitAgentTrustedTurnResult"]>(
        raw.submitTrustedTurn(body, signal),
        signal,
      ),
    getRun: (contextKey, runId, signal) =>
      request<RuntimeLocalRun>(raw.getRun(contextKey, runId, signal), signal),
    listWaitingContexts: async (signal) =>
      (
        await request<RuntimeStateSchemas["AgentRuntimeWaitingContexts"]>(
          raw.listWaitingContexts(signal),
          signal,
        )
      ).context_keys,
    claimRun: (body, signal) =>
      request<RuntimeStateSchemas["ClaimAgentLocalRunResult"]>(
        raw.claimRun(body, signal),
        signal,
      ),
    requeueRun: (body, signal) =>
      request<RuntimeStateSchemas["AgentRuntimeSuccessResult"]>(
        raw.requeueRun(body, signal),
        signal,
      ),
    finishRun: (body, signal) =>
      request<RuntimeStateSchemas["FinishAgentLocalRunResult"]>(
        raw.finishRun(body, signal),
        signal,
      ),
    cancelRun: (body, signal) =>
      request<RuntimeStateSchemas["CancelAgentLocalRunResult"]>(
        raw.cancelRun(body, signal),
        signal,
      ),
    enqueueSteer: (body, signal) =>
      request<RuntimeStateSchemas["EnqueueAgentSteerResult"]>(
        raw.enqueueSteer(body, signal),
        signal,
      ),
    assignSteerRun: (body, signal) =>
      request<RuntimeStateSchemas["AgentRuntimeSuccessResult"]>(
        raw.assignSteerRun(body, signal),
        signal,
      ),
    completeSteer: (body, signal) =>
      request<RuntimeStateSchemas["AgentRuntimeSuccessResult"]>(
        raw.completeSteer(body, signal),
        signal,
      ),
    getSession: (contextKey, signal) =>
      request<RuntimeStateSchemas["GetAgentRuntimeSessionResult"]>(
        raw.getSession(contextKey, signal),
        signal,
      ),
    checkpointSession: (body, signal) =>
      request<RuntimeSession>(raw.checkpointSession(body, signal), signal),
    clearSession: (body, signal) =>
      request<RuntimeStateSchemas["ClearAgentRuntimeSessionResult"]>(
        raw.clearSession(body, signal),
        signal,
      ),
    getWorkState: (contextKey, signal) =>
      request<RuntimeStateSchemas["AgentRuntimeWorkState"]>(
        raw.getWorkState(contextKey, signal),
        signal,
      ),
    openStatus: (body, signal) =>
      request<RuntimeStateSchemas["OpenAgentRuntimeStatusResult"]>(
        raw.openStatus(body, signal),
        signal,
      ),
    offerPresentationEvents: (body, signal) =>
      request<RuntimeStateSchemas["OfferAgentRuntimePresentationEventsResult"]>(
        raw.offerPresentationEvents(body, signal),
        signal,
      ),
    getLocalComputer: (computerId, signal) =>
      request<RuntimeStateSchemas["AgentRuntimeLocalComputer"]>(
        raw.getLocalComputer(computerId, signal),
        signal,
      ),
    connectLocalComputer: (body, signal) =>
      request<RuntimeStateSchemas["ConnectAgentRuntimeLocalComputerResult"]>(
        raw.connectLocalComputer(body, signal),
        signal,
      ),
    touchLocalComputer: (body, signal) =>
      request<RuntimeStateSchemas["AgentRuntimeLocalComputer"]>(
        raw.touchLocalComputer(body, signal),
        signal,
      ),
    removeLocalComputer: (body, signal) =>
      request<RuntimeStateSchemas["AgentRuntimeLocalComputerRemovalResult"]>(
        raw.removeLocalComputer(body, signal),
        signal,
      ),
    recordRunOperation: (body, signal) =>
      request<RuntimeStateSchemas["AgentRuntimeSuccessResult"]>(
        raw.recordRunOperation(body, signal),
        signal,
      ),
  };
};

/** Names one claim, so a claim repeated after a lost response gets its Run. */
export const runtimeClaimId = (): string =>
  `claim-${randomUUID().replaceAll("-", "")}`;

const readErrorDetail = async (
  response: Response,
): Promise<{ code?: string; retryable: boolean; text: string }> => {
  try {
    const value = (await response.json()) as unknown;
    if (isRecord(value) && isRecord(value.error)) {
      return {
        code:
          typeof value.error.code === "string" ? value.error.code : undefined,
        retryable:
          typeof value.error.retryable === "boolean"
            ? value.error.retryable
            : response.status >= 500,
        text:
          typeof value.error.message === "string" ? value.error.message : "",
      };
    }
  } catch {
    // Fall through to the bounded text body for non-JSON responses.
  }
  return { retryable: response.status >= 500, text: "" };
};

// Runtime writes name the epoch and are idempotent; presentation events carry
// their own command identity.
const requestBodyIsRepeatable = (body: RequestInit["body"]): boolean => {
  if (typeof body !== "string") return false;
  try {
    const value = JSON.parse(body) as unknown;
    if (!isRecord(value)) return false;
    if (typeof value.epoch === "string" && value.epoch.trim().length > 0)
      return true;
    return (
      typeof value.command_id === "string" && value.command_id.trim().length > 0
    );
  } catch {
    return false;
  }
};

// Context identity and Runtime registration writes converge on a repeat.
const REPEATABLE_POST_PATHS = [
  "/v0/agent-runtime/contexts",
  "/v0/agent-runtime/contexts/reconcile",
  "/v0/agent-runtime/contexts/residency",
  "/v0/agent-runtime/contexts/delete",
  "/v0/agent-runtime/computer-daemon-identity/bind",
  "/v0/agent-runtime/local-runtime-registrations/observe",
  "/v0/agent-runtime/assignments/set",
];

const isRepeatableRequest = (
  input: string | URL | Request,
  init?: RequestInit,
): boolean => {
  if (init?.method !== "POST") return false;
  try {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return REPEATABLE_POST_PATHS.some((path) => url.pathname.endsWith(path));
  } catch {
    return false;
  }
};

const bufferResponse = async (
  response: Response,
  signal: AbortSignal,
): Promise<Response> => {
  if (!response.body) return response;
  let body: ArrayBuffer;
  try {
    body = await Promise.race([
      response.arrayBuffer(),
      rejectWhenAborted(signal),
    ]);
  } catch (error) {
    await response.body?.cancel().catch(() => undefined);
    throw error;
  }
  return new Response(body.byteLength === 0 ? null : body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
};

const rejectWhenAborted = (signal: AbortSignal): Promise<never> =>
  new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export interface RuntimeConfigTimingContext {
  readonly agentId: string;
  readonly contextKey: string;
  readonly contextKind: string;
  readonly phase: "create" | "preaccept" | "activation" | "unscoped";
}

// Diagnostic context follows only the current async call chain. It is neither
// registration authority nor a completed configuration/readiness cache.
const configTimingContext = new AsyncLocalStorage<{
  readonly context?: RuntimeConfigTimingContext & {
    readonly configTraceId: string;
  };
  readonly read?: { attemptCount: number; httpStatus: number | null };
}>();

export const withRuntimeConfigTimingContext = <T>(
  context: RuntimeConfigTimingContext,
  operation: () => T,
  newTrace = false,
): T => {
  const scope = configTimingContext.getStore();
  const parent = scope?.context;
  const configTraceId =
    !newTrace &&
    parent?.agentId === context.agentId &&
    parent.contextKey === context.contextKey
      ? parent.configTraceId
      : randomUUID();
  return configTimingContext.run(
    { ...scope, context: { ...context, configTraceId } },
    operation,
  );
};

const runtimeConfigReadFields = (agentId: string, configReadId: string) => {
  const context = configTimingContext.getStore()?.context;
  return {
    component: "runtime-state",
    ...(context?.agentId === agentId
      ? context
      : { agentId, phase: "unscoped", configTraceId: configReadId }),
    configReadId,
    method: "GET",
    endpoint: "getConfig",
  };
};

export const recordRuntimeConfigFetchAttempt = () => {
  const read = configTimingContext.getStore()?.read;
  if (read) {
    read.attemptCount += 1;
    read.httpStatus = null;
  }
  return read;
};

export const timeRuntimeConfigRead = async <T>(
  agentId: string,
  signal: AbortSignal | undefined,
  configReadId: string,
  operation: () => Promise<T>,
): Promise<T> => {
  const fields = runtimeConfigReadFields(agentId, configReadId);
  const read = { attemptCount: 0, httpStatus: null as number | null };
  const startedAt = new Date().toISOString();
  const startedMonotonic = performance.now();
  try {
    const snapshot = await configTimingContext.run(
      { ...configTimingContext.getStore(), read },
      operation,
    );
    logConfigRead("completed", {
      ...fields,
      ...read,
      startedAt,
      durationMs: performance.now() - startedMonotonic,
      outcome: "success",
    });
    return snapshot;
  } catch (error) {
    logConfigRead("completed", {
      ...fields,
      ...read,
      startedAt,
      durationMs: performance.now() - startedMonotonic,
      outcome: signal?.aborted ? "cancelled" : "failed",
    });
    throw error;
  }
};

export const logIgnoredRuntimeConfigRead = (
  agentId: string,
  configReadId: string,
): void => {
  logConfigRead("ignored", {
    ...runtimeConfigReadFields(agentId, configReadId),
    reason: "superseded",
  });
};

const logConfigRead = (
  event: "completed" | "ignored",
  fields: Readonly<Record<string, unknown>>,
): void => {
  try {
    logAgentEvent("info", `runtime_config.get_config_${event}`, fields);
  } catch {
    // Diagnostics never change the result or the caller's freshness fence.
  }
};
