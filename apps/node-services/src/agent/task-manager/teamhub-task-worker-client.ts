import type { components } from "@linger/wire-contracts/teamhub-internal/types";
import { isRecord } from "@linger/service-kit";

export type TaskExecution = components["schemas"]["TaskExecution"];
export type TaskEffect = components["schemas"]["TaskEffect"];
export type TaskWorkerExecution = components["schemas"]["TaskWorkerExecution"];
export type TaskWorkerLease = components["schemas"]["TaskWorkerLease"];
export type TaskWorkerTransition =
  components["schemas"]["TaskWorkerTransitionRequest"]["transition"];

type TaskWorkerClaimRequest = components["schemas"]["TaskWorkerClaimRequest"];
type TaskWorkerHeartbeatRequest =
  components["schemas"]["TaskWorkerHeartbeatRequest"];
type TaskWorkerTransitionRequest =
  components["schemas"]["TaskWorkerTransitionRequest"];

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export type TeamHubTaskWorkerFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface TeamHubTaskWorkerClientOptions {
  readonly baseUrl: string;
  readonly serviceToken: string;
  readonly fetch?: TeamHubTaskWorkerFetch;
  readonly requestTimeoutMs?: number;
}

export interface TaskWorkerTransitionInput {
  readonly lease: TaskWorkerLease;
  readonly execution: TaskExecution;
  readonly transition: TaskWorkerTransition;
  readonly expectedControlRevision?: number;
  readonly operationId?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}

export interface TaskWorkerClaimResult {
  /** The claimed Task, or null when none is claimable. */
  readonly claimed: TaskWorkerExecution | null;
  /**
   * Milliseconds on TeamHub's clock until a Task becomes claimable without
   * another commit; absent when no Task is pending.
   */
  readonly nextClaimDelayMs?: number;
}

export interface TeamHubTaskWorkerClient {
  claim(input: {
    readonly workerId: string;
    readonly leaseSeconds: number;
    readonly signal?: AbortSignal;
  }): Promise<TaskWorkerClaimResult>;
  get(input: {
    readonly lease: TaskWorkerLease;
    readonly signal?: AbortSignal;
  }): Promise<TaskWorkerExecution>;
  heartbeat(input: {
    readonly lease: TaskWorkerLease;
    readonly leaseSeconds: number;
    readonly signal?: AbortSignal;
  }): Promise<TaskWorkerLease>;
  transition(input: TaskWorkerTransitionInput): Promise<TaskWorkerExecution>;
}

export class TeamHubTaskWorkerError extends Error {
  override readonly name = "TeamHubTaskWorkerError";

  constructor(
    readonly status: number | null,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export const createTeamHubTaskWorkerClient = (
  options: TeamHubTaskWorkerClientOptions,
): TeamHubTaskWorkerClient => {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const serviceToken = requiredString(options.serviceToken, "service token");
  const fetchRequest = options.fetch ?? globalThis.fetch;
  const requestTimeoutMs =
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new TypeError("requestTimeoutMs must be a positive safe integer");
  }

  const request = async <T>(input: {
    readonly path: readonly string[];
    readonly method: "GET" | "POST";
    readonly body?: object;
    readonly leaseToken?: string;
    readonly query?: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly response: Response; readonly value?: T }> => {
    const signal = boundedSignal(input.signal, requestTimeoutMs);
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetchRequest(
        callbackUrl(baseUrl, input.path, input.query),
        {
          method: input.method,
          redirect: "error",
          signal,
          headers: {
            authorization: `Bearer ${serviceToken}`,
            ...(input.body === undefined
              ? {}
              : { "content-type": "application/json" }),
            ...(input.leaseToken === undefined
              ? {}
              : { "Task-Lease-Token": input.leaseToken }),
          },
          ...(input.body === undefined
            ? {}
            : { body: JSON.stringify(input.body) }),
        },
      );
    } catch (error) {
      throw new TeamHubTaskWorkerError(
        null,
        `TeamHub Task Worker request failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1_000).trim();
      throw new TeamHubTaskWorkerError(
        response.status,
        `TeamHub Task Worker request returned HTTP ${response.status}${
          detail ? `: ${detail}` : ""
        }`,
      );
    }
    if (response.status === 204) return { response };
    try {
      return { response, value: (await response.json()) as T };
    } catch (error) {
      throw new TeamHubTaskWorkerError(
        502,
        `TeamHub Task Worker response was not JSON: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  };

  return Object.freeze({
    async claim(input: Parameters<TeamHubTaskWorkerClient["claim"]>[0]) {
      const body = {
        worker_id: requiredString(input.workerId, "worker ID"),
        lease_seconds: leaseSeconds(input.leaseSeconds),
      } satisfies TaskWorkerClaimRequest;
      const result = await request<TaskWorkerExecution>({
        path: ["task-execution-claims"],
        method: "POST",
        body,
        signal: input.signal,
      });
      if (result.response.status === 204) {
        const nextClaimDelayMs = claimDelayMs(
          result.response.headers.get("Task-Next-Claim-Delay-Ms"),
        );
        return nextClaimDelayMs === undefined
          ? { claimed: null }
          : { claimed: null, nextClaimDelayMs };
      }
      const bundle = requireExecutionBundle(result.value);
      requireLease(bundle.lease, body.worker_id, bundle.execution.task_id);
      return { claimed: bundle };
    },

    async get(input: Parameters<TeamHubTaskWorkerClient["get"]>[0]) {
      const lease = requireLease(input.lease);
      const result = await request<TaskWorkerExecution>({
        path: ["task-executions", lease.task_id],
        method: "GET",
        leaseToken: lease.lease_token,
        query: {
          worker_id: lease.worker_id,
          lease_generation: String(lease.lease_generation),
        },
        signal: input.signal,
      });
      return requireMatchingBundle(result.value, lease);
    },

    async heartbeat(
      input: Parameters<TeamHubTaskWorkerClient["heartbeat"]>[0],
    ) {
      const lease = requireLease(input.lease);
      const body = {
        worker_id: lease.worker_id,
        lease_generation: lease.lease_generation,
        lease_seconds: leaseSeconds(input.leaseSeconds),
      } satisfies TaskWorkerHeartbeatRequest;
      const result = await request<TaskWorkerLease>({
        path: ["task-executions", lease.task_id, "heartbeat"],
        method: "POST",
        body,
        leaseToken: lease.lease_token,
        signal: input.signal,
      });
      return requireMatchingLease(result.value, lease);
    },

    async transition(input: TaskWorkerTransitionInput) {
      const lease = requireLease(input.lease);
      const execution = requireExecution(input.execution);
      if (execution.task_id !== lease.task_id) {
        throw new TypeError("Task execution does not match its Worker lease");
      }
      const body = {
        worker_id: lease.worker_id,
        lease_generation: lease.lease_generation,
        execution_generation: execution.generation,
        expected_execution_revision: execution.execution_revision,
        ...(input.expectedControlRevision === undefined
          ? {}
          : {
              expected_control_revision: nonNegativeSafeInteger(
                input.expectedControlRevision,
                "expected control revision",
              ),
            }),
        transition: input.transition,
        ...(input.operationId === undefined
          ? {}
          : {
              operation_id: requiredString(
                input.operationId,
                "transition operation ID",
              ),
            }),
        ...(input.payload === undefined ? {} : { payload: input.payload }),
      } satisfies TaskWorkerTransitionRequest;
      const result = await request<TaskWorkerExecution>({
        path: ["task-executions", lease.task_id, "transitions"],
        method: "POST",
        body,
        leaseToken: lease.lease_token,
        signal: input.signal,
      });
      return requireMatchingBundle(result.value, lease);
    },
  });
};

const requireMatchingBundle = (
  value: unknown,
  lease: TaskWorkerLease,
): TaskWorkerExecution => {
  const bundle = requireExecutionBundle(value);
  if (bundle.execution.task_id !== lease.task_id) {
    throw new TeamHubTaskWorkerError(
      502,
      "TeamHub returned a Task execution for a different lease",
    );
  }
  if (bundle.lease !== undefined) {
    requireMatchingLease(bundle.lease, lease);
  }
  return bundle;
};

const requireExecutionBundle = (value: unknown): TaskWorkerExecution => {
  if (!isRecord(value) || !Object.hasOwn(value, "execution")) {
    throw new TeamHubTaskWorkerError(
      502,
      "TeamHub omitted the Task execution bundle",
    );
  }
  requireExecution(value.execution);
  if (value.lease !== undefined) requireLease(value.lease);
  return value as TaskWorkerExecution;
};

const requireExecution = (value: unknown): TaskExecution => {
  if (!isRecord(value)) {
    throw new TeamHubTaskWorkerError(
      502,
      "TeamHub returned an invalid Task execution",
    );
  }
  requiredString(value.task_id, "Task execution ID");
  positiveSafeInteger(value.generation, "Task execution generation");
  positiveSafeInteger(value.execution_revision, "Task execution revision");
  nonNegativeSafeInteger(value.control_revision, "Task control revision");
  if (
    !Array.isArray(value.participants) ||
    !Array.isArray(value.pending_effects)
  ) {
    throw new TeamHubTaskWorkerError(
      502,
      "TeamHub returned an incomplete Task execution",
    );
  }
  return value as unknown as TaskExecution;
};

const requireMatchingLease = (
  value: unknown,
  expected: TaskWorkerLease,
): TaskWorkerLease => {
  const lease = requireLease(value);
  if (
    lease.task_id !== expected.task_id ||
    lease.worker_id !== expected.worker_id ||
    lease.lease_token !== expected.lease_token ||
    lease.lease_generation !== expected.lease_generation
  ) {
    throw new TeamHubTaskWorkerError(
      502,
      "TeamHub returned a mismatched Task Worker lease",
    );
  }
  return lease;
};

const requireLease = (
  value: unknown,
  expectedWorkerId?: string,
  expectedTaskId?: string,
): TaskWorkerLease => {
  if (!isRecord(value)) {
    throw new TeamHubTaskWorkerError(
      502,
      "TeamHub omitted the Task Worker lease",
    );
  }
  const taskId = requiredString(value.task_id, "Task Worker lease Task ID");
  const workerId = requiredString(
    value.worker_id,
    "Task Worker lease worker ID",
  );
  requiredString(value.lease_token, "Task Worker lease token");
  positiveSafeInteger(value.lease_generation, "Task Worker lease generation");
  requiredString(value.lease_expires_at, "Task Worker lease expiration");
  if (
    (expectedWorkerId !== undefined && workerId !== expectedWorkerId) ||
    (expectedTaskId !== undefined && taskId !== expectedTaskId)
  ) {
    throw new TeamHubTaskWorkerError(
      502,
      "TeamHub returned a Task Worker lease for a different claim",
    );
  }
  return value as unknown as TaskWorkerLease;
};

const callbackUrl = (
  baseUrl: URL,
  segments: readonly string[],
  query?: Readonly<Record<string, string>>,
): string => {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/v0/${segments
    .map(encodeURIComponent)
    .join("/")}`;
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
};

const normalizeBaseUrl = (value: string): URL => {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("TeamHub callback base URL must use HTTP or HTTPS");
  }
  url.search = "";
  url.hash = "";
  return url;
};

const boundedSignal = (
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal =>
  signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);

// A malformed delay is treated as absent: the Worker then waits for a wake or
// its idle cap instead of retrying at once.
const claimDelayMs = (value: string | null): number | undefined => {
  if (value === null || !/^[0-9]{1,15}$/u.test(value)) return undefined;
  return Number(value);
};

const leaseSeconds = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 5 || value > 300) {
    throw new TypeError("leaseSeconds must be an integer between 5 and 300");
  }
  return value;
};

const positiveSafeInteger = (value: unknown, name: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TeamHubTaskWorkerError(502, `${name} is invalid`);
  }
  return value as number;
};

const nonNegativeSafeInteger = (value: unknown, name: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value as number;
};

const requiredString = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
