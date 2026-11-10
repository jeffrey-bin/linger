/**
 * Clients for the TeamHub internal contract: Agent Service callbacks, MCP
 * Context control, and Voice Runtime reports.
 */
import type { components } from "../generated/teamhub-internal/types.js";

type Schemas = components["schemas"];

export type AgentIdentity = components["schemas"]["AgentIdentity"];
export type AgentRuntimeConfigSnapshot =
  components["schemas"]["AgentRuntimeConfigSnapshot"];
export type AgentExecutionContext =
  components["schemas"]["AgentExecutionContext"];
export type AgentExecutionContextList =
  components["schemas"]["AgentExecutionContextList"];
export type ReconcileAgentExecutionContextsRequest =
  components["schemas"]["ReconcileAgentExecutionContextsRequest"];
export type EnsureAgentExecutionContextRequest =
  components["schemas"]["EnsureAgentExecutionContextRequest"];
export type EnsureAgentExecutionContextResult =
  components["schemas"]["EnsureAgentExecutionContextResult"];
export type SetAgentExecutionContextResidencyRequest =
  components["schemas"]["SetAgentExecutionContextResidencyRequest"];
export type DeleteAgentExecutionContextRequest =
  components["schemas"]["DeleteAgentExecutionContextRequest"];
export type StartAgentServiceEpochRequest =
  components["schemas"]["StartAgentServiceEpochRequest"];
export type AcceptAgentTrustedNotificationRequest =
  components["schemas"]["AcceptAgentTrustedNotificationRequest"];
export type ClearAgentRuntimeSessionRequest =
  components["schemas"]["ClearAgentRuntimeSessionRequest"];
export type SubmitAgentTrustedTurnRequest =
  components["schemas"]["SubmitAgentTrustedTurnRequest"];
export type ClaimAgentLocalRunRequest =
  components["schemas"]["ClaimAgentLocalRunRequest"];
export type RequeueAgentLocalRunRequest =
  components["schemas"]["RequeueAgentLocalRunRequest"];
export type FinishAgentLocalRunRequest =
  components["schemas"]["FinishAgentLocalRunRequest"];
export type CancelAgentLocalRunRequest =
  components["schemas"]["CancelAgentLocalRunRequest"];
export type EnqueueAgentSteerRequest =
  components["schemas"]["EnqueueAgentSteerRequest"];
export type AssignAgentSteerRunRequest =
  components["schemas"]["AssignAgentSteerRunRequest"];
export type CompleteAgentSteerRequest =
  components["schemas"]["CompleteAgentSteerRequest"];
export type CheckpointAgentRuntimeSessionRequest =
  components["schemas"]["CheckpointAgentRuntimeSessionRequest"];
export type OpenAgentRuntimeStatusRequest =
  components["schemas"]["OpenAgentRuntimeStatusRequest"];
export type OfferAgentRuntimePresentationEventsRequest =
  components["schemas"]["OfferAgentRuntimePresentationEventsRequest"];
export type ConnectAgentRuntimeLocalComputerRequest =
  components["schemas"]["ConnectAgentRuntimeLocalComputerRequest"];
export type TouchAgentRuntimeLocalComputerRequest =
  components["schemas"]["TouchAgentRuntimeLocalComputerRequest"];
export type RemoveAgentRuntimeLocalComputerRequest =
  components["schemas"]["AgentRuntimeLocalComputerCredentialRequest"];
export type RecordAgentLocalRunOperationRequest =
  components["schemas"]["RecordAgentLocalRunOperationRequest"];

export type TeamHubAgentCallbackFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function createTeamHubUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("TeamHub callback base URL must use HTTP or HTTPS");
  }
  url.search = "";
  url.hash = "";
  return url;
}

export function createTeamHubAgentIdentityUrl(
  baseUrl: string,
  agentId: string,
): string {
  const url = createTeamHubUrl(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/v0/agents/${encodeURIComponent(agentId)}/identity`;
  return url.toString();
}

export function getTeamHubAgentIdentity(options: {
  baseUrl: string;
  agentId: string;
  fetch?: TeamHubAgentCallbackFetch;
  serviceToken: string;
  signal?: AbortSignal;
}): Promise<Response> {
  const fetchRequest = options.fetch ?? globalThis.fetch;
  return fetchRequest(
    createTeamHubAgentIdentityUrl(options.baseUrl, options.agentId),
    {
      method: "GET",
      redirect: "error",
      signal: options.signal,
      headers: { authorization: `Bearer ${options.serviceToken}` },
    },
  );
}

export function getTeamHubPersonalWikiDocumentRevision(options: {
  actorId: string;
  baseUrl: string;
  fetch?: TeamHubAgentCallbackFetch;
  serviceToken: string;
  signal?: AbortSignal;
  ifNoneMatch?: string;
}): Promise<Response> {
  const url = createTeamHubUrl(options.baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/v0/personal-wikis/${segment(options.actorId)}/document-revision`;
  return getTeamHubResource(url, options);
}

export function getTeamHubPersonalWikiDocumentVersion(options: {
  actorId: string;
  baseUrl: string;
  documentId: string;
  documentVersionId: string;
  fetch?: TeamHubAgentCallbackFetch;
  serviceToken: string;
  signal?: AbortSignal;
  wikiRevisionId: string;
}): Promise<Response> {
  const url = createTeamHubUrl(options.baseUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname =
    `${basePath}/v0/personal-wikis/${segment(options.actorId)}` +
    `/document-revisions/${segment(options.wikiRevisionId)}` +
    `/documents/${segment(options.documentId)}` +
    `/versions/${segment(options.documentVersionId)}/content`;
  return getTeamHubResource(url, options);
}

export function fetchTeamHubSession(options: {
  baseUrl: string;
  documentVersionId: string;
  fetch?: TeamHubAgentCallbackFetch;
  serviceToken: string;
  signal?: AbortSignal;
  tenantId: string;
}): Promise<Response> {
  const url = createTeamHubUrl(options.baseUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname =
    `${basePath}/v0/memory/fetch_session/tenants/${segment(options.tenantId)}` +
    `/document-versions/${segment(options.documentVersionId)}`;
  return getTeamHubResource(url, options);
}

export function postTeamHubMemoryWikiRefresh(options: {
  actorId: string;
  baseUrl: string;
  body: components["schemas"]["MemoryWikiRefreshRequest"];
  fetch?: TeamHubAgentCallbackFetch;
  serviceToken: string;
  signal?: AbortSignal;
}): Promise<Response> {
  const url = createTeamHubUrl(options.baseUrl);
  url.pathname =
    `${url.pathname.replace(/\/+$/, "")}/v0/personal-wikis/${segment(options.actorId)}` +
    "/memory-refresh";
  return (options.fetch ?? globalThis.fetch)(url, {
    body: JSON.stringify(options.body),
    headers: {
      authorization: `Bearer ${options.serviceToken}`,
      "content-type": "application/json",
    },
    method: "POST",
    redirect: "error",
    signal: options.signal,
  });
}

export function createTeamHubTrackingItemClient(options: {
  baseUrl: string;
  serviceToken: string;
  fetch?: TeamHubAgentCallbackFetch;
}) {
  const post = (
    actorId: string,
    action: string,
    body: unknown,
    signal?: AbortSignal,
  ) => {
    const url = createTeamHubUrl(options.baseUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/v0/tracking-items/${segment(actorId)}/${action}`;
    return (options.fetch ?? globalThis.fetch)(url, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        authorization: `Bearer ${options.serviceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  };
  return {
    list: (
      actorId: string,
      body: components["schemas"]["TrackingItemList"],
      signal?: AbortSignal,
    ) => post(actorId, "list", body, signal),
    apply: (
      actorId: string,
      body: components["schemas"]["TrackingItemChanges"],
      signal?: AbortSignal,
    ) => post(actorId, "apply", body, signal),
    plan: (
      actorId: string,
      body: components["schemas"]["TrackingItemPlanRequest"],
      signal?: AbortSignal,
    ) => post(actorId, "plan", body, signal),
  };
}

function getTeamHubResource(
  url: URL,
  options: {
    fetch?: TeamHubAgentCallbackFetch;
    serviceToken: string;
    signal?: AbortSignal;
    ifNoneMatch?: string;
  },
): Promise<Response> {
  return (options.fetch ?? globalThis.fetch)(url, {
    headers: {
      authorization: `Bearer ${options.serviceToken}`,
      ...(options.ifNoneMatch ? { "if-none-match": options.ifNoneMatch } : {}),
    },
    method: "GET",
    redirect: "error",
    signal: options.signal,
  });
}

export function createTeamHubAgentRuntimeStateClient(options: {
  baseUrl: string;
  fetch?: TeamHubAgentCallbackFetch;
  serviceToken: string;
}) {
  const send = (
    path: string,
    request: {
      body?: unknown;
      method: "GET" | "POST";
      query?: Readonly<Record<string, string | undefined>>;
      signal?: AbortSignal;
    },
  ): Promise<Response> => {
    const url = createTeamHubUrl(options.baseUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/v0/agent-runtime/${path}`;
    for (const [name, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, value);
    }
    return (options.fetch ?? globalThis.fetch)(url, {
      method: request.method,
      redirect: "error",
      signal: request.signal,
      headers: {
        authorization: `Bearer ${options.serviceToken}`,
        ...(request.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(request.body === undefined
        ? {}
        : { body: JSON.stringify(request.body) }),
    });
  };
  const post = <T>(path: string, body: T, signal?: AbortSignal) =>
    send(path, { body, method: "POST", signal });
  const get = (
    path: string,
    query: Readonly<Record<string, string | undefined>>,
    signal?: AbortSignal,
  ) => send(path, { method: "GET", query, signal });

  return Object.freeze({
    getConfig: (agentId: string, revision?: string, signal?: AbortSignal) =>
      get("config", { agent_id: agentId, revision }, signal),
    listAnotherMePlacements: (
      owner?: { readonly tenantId: string; readonly ownerActorId: string },
      signal?: AbortSignal,
    ) =>
      get(
        "another-me-placements",
        { tenant_id: owner?.tenantId, owner_actor_id: owner?.ownerActorId },
        signal,
      ),
    getMemory: (agentId: string, signal?: AbortSignal) =>
      get(`agents/${encodeURIComponent(agentId)}/memory`, {}, signal),
    commitMemory: (
      agentId: string,
      body: components["schemas"]["AgentMemoryDocument"],
      signal?: AbortSignal,
    ) => post(`agents/${encodeURIComponent(agentId)}/memory`, body, signal),
    getDeletionSnapshot: (agentId: string, signal?: AbortSignal) =>
      get("deletion-snapshot", { agent_id: agentId }, signal),
    listContexts: (agentId?: string, signal?: AbortSignal) =>
      get("contexts", { agent_id: agentId }, signal),
    listRecentlyUsedContexts: (signal?: AbortSignal) =>
      post("contexts/recently-used", {}, signal),
    reconcileContexts: (
      body: ReconcileAgentExecutionContextsRequest,
      signal?: AbortSignal,
    ) => post("contexts/reconcile", body, signal),
    getContext: (contextKey: string, signal?: AbortSignal) =>
      get("context", { context_key: contextKey }, signal),
    ensureContext: (
      body: EnsureAgentExecutionContextRequest,
      signal?: AbortSignal,
    ) => post("contexts", body, signal),
    setContextResidency: (
      body: SetAgentExecutionContextResidencyRequest,
      signal?: AbortSignal,
    ) => post("contexts/residency", body, signal),
    deleteContext: (
      body: DeleteAgentExecutionContextRequest,
      signal?: AbortSignal,
    ) => post("contexts/delete", body, signal),
    startEpoch: (body: StartAgentServiceEpochRequest, signal?: AbortSignal) =>
      post("epochs", body, signal),
    createRuntimeHumanInteraction: (
      body: components["schemas"]["CreateRuntimeHumanInteractionRequest"],
      signal?: AbortSignal,
    ) => post("human-interactions", body, signal),
    createRuntimePermissionReview: (
      body: components["schemas"]["CreateRuntimePermissionReviewRequest"],
      signal?: AbortSignal,
    ) => post("permission-reviews", body, signal),
    acceptTrustedNotification: (
      body: AcceptAgentTrustedNotificationRequest,
      signal?: AbortSignal,
    ) => post("inputs/accept-trusted-notification", body, signal),
    submitTrustedTurn: (
      body: SubmitAgentTrustedTurnRequest,
      signal?: AbortSignal,
    ) => post("trusted-turns", body, signal),
    getRun: (contextKey: string, runId: string, signal?: AbortSignal) =>
      get("run", { context_key: contextKey, local_run_id: runId }, signal),
    listWaitingContexts: (signal?: AbortSignal) =>
      get("runs/waiting", {}, signal),
    claimRun: (body: ClaimAgentLocalRunRequest, signal?: AbortSignal) =>
      post("runs/claim", body, signal),
    requeueRun: (body: RequeueAgentLocalRunRequest, signal?: AbortSignal) =>
      post("runs/requeue", body, signal),
    finishRun: (body: FinishAgentLocalRunRequest, signal?: AbortSignal) =>
      post("runs/finish", body, signal),
    cancelRun: (body: CancelAgentLocalRunRequest, signal?: AbortSignal) =>
      post("runs/cancel", body, signal),
    enqueueSteer: (body: EnqueueAgentSteerRequest, signal?: AbortSignal) =>
      post("steers/enqueue", body, signal),
    assignSteerRun: (body: AssignAgentSteerRunRequest, signal?: AbortSignal) =>
      post("steers/assign", body, signal),
    completeSteer: (body: CompleteAgentSteerRequest, signal?: AbortSignal) =>
      post("steers/complete", body, signal),
    getSession: (contextKey: string, signal?: AbortSignal) =>
      get("session", { context_key: contextKey }, signal),
    checkpointSession: (
      body: CheckpointAgentRuntimeSessionRequest,
      signal?: AbortSignal,
    ) => post("sessions/checkpoint", body, signal),
    clearSession: (
      body: ClearAgentRuntimeSessionRequest,
      signal?: AbortSignal,
    ) => post("sessions/clear", body, signal),
    getWorkState: (contextKey: string, signal?: AbortSignal) =>
      get("work-state", { context_key: contextKey }, signal),
    openStatus: (body: OpenAgentRuntimeStatusRequest, signal?: AbortSignal) =>
      post("statuses/open", body, signal),
    offerPresentationEvents: (
      body: OfferAgentRuntimePresentationEventsRequest,
      signal?: AbortSignal,
    ) => post("presentation-events/offer", body, signal),
    getLocalComputer: (computerId: string, signal?: AbortSignal) =>
      get("local-computer", { computer_id: computerId }, signal),
    connectLocalComputer: (
      body: ConnectAgentRuntimeLocalComputerRequest,
      signal?: AbortSignal,
    ) => post("local-computers/connect", body, signal),
    touchLocalComputer: (
      body: TouchAgentRuntimeLocalComputerRequest,
      signal?: AbortSignal,
    ) => post("local-computers/touch", body, signal),
    removeLocalComputer: (
      body: RemoveAgentRuntimeLocalComputerRequest,
      signal?: AbortSignal,
    ) => post("local-computers/remove", body, signal),
    recordRunOperation: (
      body: RecordAgentLocalRunOperationRequest,
      signal?: AbortSignal,
    ) => post("runs/operations", body, signal),
  });
}

export type TeamHubAgentRuntimeStateClient = ReturnType<
  typeof createTeamHubAgentRuntimeStateClient
>;

export function getTeamHubAgentEffectiveResources(options: {
  baseUrl: string;
  serviceToken: string;
  agentId: string;
  signal?: AbortSignal;
  fetch?: TeamHubAgentCallbackFetch;
}): Promise<Response> {
  const url = createTeamHubUrl(options.baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/v0/agents/${encodeURIComponent(options.agentId)}/effective-resources`;
  return (options.fetch ?? globalThis.fetch)(url, {
    method: "GET",
    redirect: "error",
    signal: options.signal,
    headers: { authorization: `Bearer ${options.serviceToken}` },
  });
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

// MCP Context control plane.

export const TEAMHUB_AGENT_SERVICE_AUDIENCE = "teamhub-agent-callback" as const;
export const TEAMHUB_MCP_INTERNAL_DEFAULT_TIMEOUT_MS = 5_000;

export type McpContextResolveRequest = Schemas["McpContextResolveRequest"];
export type McpContextResolveResponse = Schemas["McpContextResolveResponse"];
type McpContextErrorEnvelope = Schemas["McpContextErrorEnvelope"];

export type TeamHubMcpInternalFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type TeamHubMcpInternalAccessTokenProvider = (input: {
  audience: typeof TEAMHUB_AGENT_SERVICE_AUDIENCE;
  signal: AbortSignal;
}) => Promise<string> | string;

export interface TeamHubMcpInternalRequestOptions {
  signal?: AbortSignal;
}

export interface TeamHubMcpInternalClientOptions {
  baseUrl: string;
  fetch?: TeamHubMcpInternalFetch;
  getAccessToken: TeamHubMcpInternalAccessTokenProvider;
  timeoutMs?: number;
}

export interface TeamHubMcpInternalClient {
  resolveMcpContext(
    agentId: string,
    body: McpContextResolveRequest,
    options?: TeamHubMcpInternalRequestOptions,
  ): Promise<McpContextResolveResponse>;
}

export class TeamHubMcpInternalClientError extends Error {
  readonly code: string;
  readonly issues: readonly TeamHubMcpInternalErrorIssue[] | undefined;
  readonly requestId: string | undefined;
  readonly status: number | undefined;

  constructor(input: {
    code: string;
    issues?: readonly TeamHubMcpInternalErrorIssue[];
    requestId?: string;
    status?: number;
  }) {
    const status =
      input.status === undefined ? "client" : `HTTP ${input.status}`;
    const request = input.requestId ? `, request_id=${input.requestId}` : "";
    super(
      `TeamHub MCP internal request failed (${status}, ${input.code}${request})`,
    );
    this.name = "TeamHubMcpInternalClientError";
    this.code = input.code;
    this.issues = input.issues;
    this.requestId = input.requestId;
    this.status = input.status;
  }
}

export type TeamHubMcpInternalErrorIssue = Readonly<{
  path: string;
  code: string;
  message: string;
}>;

interface McpInternalRequestInput {
  audience: typeof TEAMHUB_AGENT_SERVICE_AUDIENCE;
  body?: unknown;
  method: "GET" | "POST";
  path: string;
  signal: AbortSignal | undefined;
}

function normalizeBaseUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError("TeamHub MCP internal base URL must be a valid URL");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new TypeError(
      "TeamHub MCP internal base URL must use HTTP or HTTPS without user credentials",
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url;
}

function createMcpInternalUrl(baseUrl: URL, path: string): string {
  const url = new URL(baseUrl);
  url.pathname = `${baseUrl.pathname.replace(/\/+$/, "")}${path}`;
  return url.toString();
}

function requestSignal(
  timeoutMs: number,
  callerSignal?: AbortSignal,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return callerSignal
    ? AbortSignal.any([callerSignal, timeoutSignal])
    : timeoutSignal;
}

async function waitForSignal<T>(
  value: Promise<T> | T,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    throw new TeamHubMcpInternalClientError({ code: "request_aborted" });
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      reject(new TeamHubMcpInternalClientError({ code: "request_aborted" }));
    };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(value).then(
      (result) => {
        signal.removeEventListener("abort", abort);
        resolve(result);
      },
      () => {
        signal.removeEventListener("abort", abort);
        reject(
          new TeamHubMcpInternalClientError({
            code: "access_token_unavailable",
          }),
        );
      },
    );
  });
}

function isErrorEnvelope(value: unknown): value is McpContextErrorEnvelope {
  if (!value || typeof value !== "object") return false;
  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: unknown;
    message?: unknown;
    request_id?: unknown;
  };
  return (
    typeof candidate.code === "string" &&
    /^[a-z0-9_]{1,64}$/u.test(candidate.code) &&
    typeof candidate.message === "string" &&
    typeof candidate.request_id === "string" &&
    /^[A-Za-z0-9._:-]{1,128}$/u.test(candidate.request_id)
  );
}

function readErrorIssues(
  value: McpContextErrorEnvelope,
): readonly TeamHubMcpInternalErrorIssue[] | undefined {
  const issues = value.error.issues;
  if (!Array.isArray(issues) || issues.length === 0 || issues.length > 100) {
    return undefined;
  }
  const result: TeamHubMcpInternalErrorIssue[] = [];
  for (const issue of issues) {
    if (
      !issue ||
      typeof issue !== "object" ||
      typeof issue.path !== "string" ||
      typeof issue.code !== "string" ||
      typeof issue.message !== "string"
    ) {
      return undefined;
    }
    result.push(
      Object.freeze({
        path: issue.path,
        code: issue.code,
        message: issue.message,
      }),
    );
  }
  return Object.freeze(result);
}

function validateTimeoutMs(timeoutMs: number): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError(
      "TeamHub MCP internal timeout must be a positive integer",
    );
  }
  return timeoutMs;
}

function validateAccessToken(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || /\s/u.test(value)) {
    throw new TeamHubMcpInternalClientError({
      code: "invalid_access_token",
    });
  }
}

export function createTeamHubMcpInternalClient(
  options: TeamHubMcpInternalClientOptions,
): TeamHubMcpInternalClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchRequest = options.fetch ?? globalThis.fetch;
  const configuredTimeoutMs =
    options.timeoutMs === undefined
      ? undefined
      : validateTimeoutMs(options.timeoutMs);

  async function request<ResponseBody>(
    input: McpInternalRequestInput,
  ): Promise<ResponseBody> {
    const operationTimeoutMs =
      configuredTimeoutMs ?? TEAMHUB_MCP_INTERNAL_DEFAULT_TIMEOUT_MS;
    const signal = requestSignal(operationTimeoutMs, input.signal);
    let accessToken: string;
    try {
      accessToken = await waitForSignal(
        options.getAccessToken({
          audience: input.audience,
          signal,
        }),
        signal,
      );
    } catch (error) {
      if (error instanceof TeamHubMcpInternalClientError) throw error;
      throw new TeamHubMcpInternalClientError({
        code: "access_token_unavailable",
      });
    }
    validateAccessToken(accessToken);

    const encodedBody =
      input.body === undefined ? undefined : JSON.stringify(input.body);
    let response: Response;
    try {
      const requestInit: RequestInit & { duplex?: "half" } = {
        method: input.method,
        cache: "no-store",
        redirect: "error",
        signal,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${accessToken}`,
          ...(encodedBody === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        ...(encodedBody === undefined ? {} : { body: encodedBody }),
      };
      response = await fetchRequest(
        createMcpInternalUrl(baseUrl, input.path),
        requestInit,
      );
    } catch {
      throw new TeamHubMcpInternalClientError({
        code: signal.aborted ? "request_aborted" : "network_error",
      });
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new TeamHubMcpInternalClientError({
        code: "malformed_response",
        status: response.status,
      });
    }
    if (!response.ok) {
      if (isErrorEnvelope(payload)) {
        throw new TeamHubMcpInternalClientError({
          code: payload.error.code,
          issues: readErrorIssues(payload),
          requestId: payload.error.request_id,
          status: response.status,
        });
      }
      throw new TeamHubMcpInternalClientError({
        code: "malformed_error",
        status: response.status,
      });
    }
    return payload as ResponseBody;
  }

  return {
    resolveMcpContext: (agentId, body, requestOptions) =>
      request({
        audience: TEAMHUB_AGENT_SERVICE_AUDIENCE,
        body,
        method: "POST",
        path: `/internal/agents/${encodeURIComponent(agentId)}/mcp-context/actions/resolve`,
        signal: requestOptions?.signal,
      }),
  };
}

// Voice Runtime reports.

export type VoiceObservation = components["schemas"]["VoiceObservation"];
export type VoiceDictationCommitRequest =
  components["schemas"]["VoiceDictationCommitRequest"];
export type VoiceSessionPurpose = components["schemas"]["VoiceSessionPurpose"];
export type VoiceObservationReceipt =
  components["schemas"]["VoiceObservationReceipt"];
export type VoiceMediaObjectKey = components["schemas"]["VoiceMediaObjectKey"];
export type VoiceRecordingReport =
  components["schemas"]["VoiceRecordingReport"];

export class TeamHubVoiceRuntimeError extends Error {
  constructor(readonly status: number) {
    super(`TeamHub Voice Runtime request failed with ${status}`);
    this.name = "TeamHubVoiceRuntimeError";
  }
}

export class TeamHubVoiceRuntimeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string | (() => Promise<string>),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async reportObservation(
    observation: VoiceObservation,
    signal?: AbortSignal,
  ): Promise<VoiceObservationReceipt> {
    return this.request(
      "POST",
      "/internal/v1/voice/observations",
      observation,
      signal,
    );
  }

  async putMediaObject(
    key: VoiceMediaObjectKey,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request(
      "PUT",
      `/internal/v1/voice/media-objects?key=${encodeURIComponent(key)}`,
      bytes,
      signal,
    );
  }

  async reportRecording(
    report: VoiceRecordingReport,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request("POST", "/internal/v1/voice/recordings", report, signal);
  }

  private async request<T>(
    method: "POST" | "PUT",
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const token =
      typeof this.token === "string" ? this.token : await this.token();
    const binary = body instanceof Uint8Array;
    const response = await this.fetchImpl(new URL(path, this.baseUrl), {
      method,
      signal: signal ?? AbortSignal.timeout(2_000),
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined
          ? {}
          : {
              "content-type": binary
                ? "application/octet-stream"
                : "application/json",
            }),
      },
      body:
        body === undefined
          ? undefined
          : binary
            ? (body as NonNullable<RequestInit["body"]>)
            : JSON.stringify(body),
    });
    if (!response.ok) {
      throw new TeamHubVoiceRuntimeError(response.status);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}
