import { randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import * as AgentManagementRoutes from "@linger/wire-contracts/node-services-internal/server";
import type {
  AgentDebugInspectionApi,
  AgentManagerApi,
} from "../agent-manager-api.js";
import {
  encodeExecutionContextRef,
  type ExecutionContextRef,
} from "../context-ref.js";
import { AgentLifecycleCoordinator } from "../lifecycle-coordinator.js";
import { hasBearerToken } from "../../service-bearer-auth.js";
import {
  parseLocalPlacement,
  type LocalAgentRunnerManagement,
  type LocalComputerManagement,
  type LocalPlacementRequirement,
} from "../../runner-gateway/local-computer-management.js";
import type { RunnerCredentialAuthenticator } from "../../runner-gateway/runner-credential-authority.js";
import type { RunnerGateway } from "../../runner-gateway/runner-gateway.js";
import type { ContextViewContent } from "../../runner-gateway/context-view-content.js";
import type { LocalMcpRelay } from "../../runner-gateway/local-mcp-relay.js";
import { attachRunnerGatewayWebSocket } from "../../runner-gateway/runner-gateway-websocket.js";
import { logAgentEvent } from "../../observability/agent-log.js";
import {
  createLocalComputerRouteHandlers,
  LocalComputerHttpError,
  registerLocalComputerCompatibilityRoutes,
  registerLocalComputerPermissionRoutes,
} from "./local-computer-http.js";
import {
  startHttpHost,
  type HttpHost,
  type RoleReadiness,
} from "../../../http-host.js";
import type { components as AgentManagementSchemas } from "@linger/wire-contracts/node-services-internal/types";
import { redactRuntimeHistoryPage } from "../history.js";
import { isRecord } from "@linger/service-kit";
import {
  ModelCallError,
  type ModelCall,
  type ModelCallErrorKind,
} from "../../../runtime-model-call.js";
import { answerModelCall, readModelCallRequest } from "./model-call-http.js";

type ProactiveEventJudgeRequest =
  AgentManagementSchemas["schemas"]["ProactiveEventJudgeRequest"];

export interface ProactiveEventJudgePort {
  judge(
    request: ProactiveEventJudgeRequest,
  ): Promise<AgentManagementSchemas["schemas"]["ProactiveEventJudgement"]>;
}

export interface AgentManagerHttpServerOptions<TRuntimeSettings> {
  api: AgentManagerApi<TRuntimeSettings> & Partial<AgentDebugInspectionApi>;
  beforeReady?(
    address: AgentManagerHttpServerAddress,
    signal: AbortSignal,
  ): Promise<void>;
  operationalReadiness?():
    | AgentManagerOperationalReadiness
    | Promise<AgentManagerOperationalReadiness>;
  localComputerManagement?: LocalAgentRunnerManagement;
  runnerCredentialAuthority?: RunnerCredentialAuthenticator;
  runnerGateway?: RunnerGateway;
  localMcpRelay?: Pick<LocalMcpRelay, "handle">;
  /** Judges TeamHub's outside events for proactive reminders. */
  proactiveEvents?: ProactiveEventJudgePort;
  /** Answers TeamHub's stateless model calls; absent without the gateway. */
  modelCall?: ModelCall;
  serviceToken: string;
  /**
   * The process listener shared with the other roles. Without it
   * the server starts its own listener on host and port.
   */
  httpHost?: HttpHost;
  host?: string;
  port?: number;
}

export type AgentManagerOperationalReadiness =
  | { readonly ready: true }
  | {
      readonly ready: false;
      readonly reason: "dependency_check_failed" | "teamhub_unavailable";
    };

export interface AgentManagerHttpServerAddress {
  host: string;
  port: number;
  url: string;
}

export interface AgentManagerHttpServerHandle {
  start(): Promise<AgentManagerHttpServerAddress>;
  drain(): Promise<void>;
  close(): Promise<void>;
}

interface ProtocolErrorBody {
  error: {
    code: string;
    message: string;
    request_id: string;
    retryable?: boolean;
  };
}

const MAX_BODY_BYTES = 64 * 1024;
// A model call carries up to a million characters of input plus instructions.
const MODEL_CALL_MAX_BODY_BYTES = 16 * 1024 * 1024;
/** When an offline Computer's caller should ask again. */
const MODEL_CALL_RETRY_AFTER_SECONDS = 60;
type JsonStatus =
  | 200
  | 201
  | 202
  | 400
  | 401
  | 403
  | 404
  | 405
  | 409
  | 410
  | 413
  | 502
  | 500
  | 503
  | 504;

class RequestError extends Error {
  constructor(
    readonly status: JsonStatus,
    readonly errorCode: string,
    message: string,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

export const createAgentManagerHttpServer = <TRuntimeSettings>(
  options: AgentManagerHttpServerOptions<TRuntimeSettings>,
): AgentManagerHttpServerHandle => {
  const host = options.httpHost?.host ?? options.host ?? "127.0.0.1";
  const port = options.httpHost?.port ?? options.port ?? 4319;
  assertServerConfiguration(host, port);
  const serviceToken = requireServiceToken(options.serviceToken);
  let ready = false;
  let draining = false;
  const businessRequests = new Set<Promise<void>>();
  const admission = {
    isDraining: () => draining,
    enter: () => {
      let resolve!: () => void;
      const request = new Promise<void>((done) => {
        resolve = done;
      });
      businessRequests.add(request);
      return () => {
        businessRequests.delete(request);
        resolve();
      };
    },
  };

  const app = createAgentManagerHttpApp(
    options.api,
    options.localComputerManagement ?? options.runnerGateway,
    options.localComputerManagement ?? options.runnerGateway,
    serviceToken,
    () => ready,
    options.runnerGateway?.contextViewContent,
    options.localMcpRelay,
    admission,
    options.proactiveEvents,
    options.modelCall,
    options.runnerGateway,
  );
  const readiness = async (): Promise<RoleReadiness> => {
    if (draining) return { ready: false, reason: "draining" };
    if (!ready) return { ready: false, reason: "restoring" };
    try {
      return (await options.operationalReadiness?.()) ?? { ready: true };
    } catch {
      return { ready: false, reason: "dependency_check_failed" };
    }
  };
  let httpHost: HttpHost | undefined;
  let ownedHost: HttpHost | undefined;
  let runnerGatewayWebSocket: { close(): Promise<void> } | undefined;
  let lifecycle: ServerLifecycle = "idle";
  let starting: Promise<AgentManagerHttpServerAddress> | undefined;
  let closing: Promise<void> | undefined;
  let readinessController: AbortController | undefined;
  let failure: unknown;
  const isClosingOrClosed = (): boolean =>
    lifecycle === "closing" || lifecycle === "closed";

  // The Runner Gateway socket is always this server's own; the listener is
  // closed here only when the server started it.
  const closeOwnedNetwork = async (): Promise<void> => {
    await runnerGatewayWebSocket?.close();
    runnerGatewayWebSocket = undefined;
    await ownedHost?.close();
  };

  const mount = async (): Promise<AgentManagerHttpServerAddress> => {
    if (options.httpHost) {
      httpHost = options.httpHost;
    } else {
      ownedHost = await startHttpHost({ host, port });
      httpHost = ownedHost;
    }
    httpHost.mount({
      prefixes: ["/v1/"],
      fetch: (request) => app.fetch(request),
      readiness,
    });
    if (options.runnerGateway) {
      runnerGatewayWebSocket = attachRunnerGatewayWebSocket({
        server: httpHost.server,
        gateway: options.runnerGateway,
        credentialAuthenticators: options.runnerCredentialAuthority
          ? [options.runnerCredentialAuthority]
          : [],
        rejectUnmatchedUpgrades: true,
        onSessionError: (error, context) => {
          logAgentEvent("error", "runner.session.failed", {
            ...context,
            error,
          });
        },
      });
    }
    return hostAddress(httpHost);
  };

  return {
    drain: async () => {
      draining = true;
      readinessController?.abort();
      await Promise.all([...businessRequests]);
    },
    start: async () => {
      if (starting) {
        return starting;
      }
      if (lifecycle === "ready" && httpHost) {
        return hostAddress(httpHost);
      }
      if (lifecycle === "failed") {
        throw new Error(
          "AgentManager HTTP server cannot restart after readiness failed",
          { cause: failure },
        );
      }
      if (lifecycle === "closing" || lifecycle === "closed") {
        throw new Error("AgentManager HTTP server is closed");
      }
      lifecycle = "starting";
      const controller = new AbortController();
      readinessController = controller;
      starting = (async () => {
        try {
          const address = await mount();
          controller.signal.throwIfAborted();
          await waitForReadiness(
            options.beforeReady?.(address, controller.signal),
            controller.signal,
          );
          controller.signal.throwIfAborted();
          ready = true;
          lifecycle = "ready";
          ownedHost?.finishStartup();
          return address;
        } catch (error) {
          ready = false;
          if (!isClosingOrClosed()) {
            lifecycle = "failed";
            failure = error;
          }
          await closeOwnedNetwork();
          throw error;
        }
      })().finally(() => {
        starting = undefined;
        if (readinessController === controller) {
          readinessController = undefined;
        }
      });
      return starting;
    },
    close: async () => {
      closing ??= (async () => {
        if (lifecycle === "closed") return;
        lifecycle = "closing";
        draining = true;
        ready = false;
        readinessController?.abort();
        await starting?.catch(() => undefined);
        await closeOwnedNetwork();
        lifecycle = "closed";
      })();
      return closing;
    },
  };
};

type ServerLifecycle =
  | "idle"
  | "starting"
  | "ready"
  | "failed"
  | "closing"
  | "closed";

const waitForReadiness = async (
  readiness: Promise<void> | undefined,
  signal: AbortSignal,
): Promise<void> => {
  if (!readiness) return;
  if (signal.aborted) signal.throwIfAborted();
  let rejectAborted!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const onAbort = (): void => rejectAborted(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([readiness, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};

const createAgentManagerHttpApp = <TRuntimeSettings>(
  api: AgentManagerApi<TRuntimeSettings> & Partial<AgentDebugInspectionApi>,
  localComputerManagement: LocalComputerManagement | undefined,
  localAgentRunnerManagement: LocalAgentRunnerManagement | undefined,
  serviceToken: string,
  isReady: () => boolean,
  contextViewContent?: Pick<ContextViewContent, "handle">,
  localMcpRelay?: Pick<LocalMcpRelay, "handle">,
  admission?: { isDraining(): boolean; enter(): () => void },
  proactiveEvents?: ProactiveEventJudgePort,
  modelCall?: ModelCall,
  computerTools?: Pick<RunnerGateway, "callComputerTool">,
): Hono => {
  const app = new Hono();
  app.use("/v1/*", async (context, next) => {
    // These authenticated/signed channels belong to already active Runs.
    const control = /^\/v1\/(context-content|local-mcp-relay)\//.test(
      context.req.path,
    );
    if (control) return next();
    if (admission?.isDraining()) {
      return writeProtocolError(
        context,
        503,
        "SERVICE_NOT_READY",
        "Agent Service is shutting down",
      );
    }
    const leave = admission?.enter();
    try {
      await next();
    } finally {
      leave?.();
    }
  });
  const agentLifecycle = new AgentLifecycleCoordinator();
  if (contextViewContent) {
    app.all("/v1/context-content/:token/:kind/:id", (context) =>
      contextViewContent.handle(
        context.req.param("token"),
        context.req.param("kind"),
        context.req.param("id"),
        context.req.raw,
      ),
    );
  }
  if (localMcpRelay) {
    app.all("/v1/local-mcp-relay/:relayId", (context) =>
      localMcpRelay.handle(pathId(context, "relayId"), context.req.raw),
    );
  }
  app.use("/v1/*", async (context, next) => {
    if (!isReady()) {
      return writeProtocolError(
        context,
        503,
        "SERVICE_NOT_READY",
        "Agent Service is restoring state",
      );
    }
    if (!hasBearerToken(context.req.header("authorization"), serviceToken)) {
      return writeProtocolError(
        context,
        401,
        "unauthenticated",
        "Service bearer token is required",
      );
    }
    await next();
  });

  const localComputerHandlers = createLocalComputerRouteHandlers({
    localComputerManagement,
    pathId,
    readJsonBody,
  });
  const debugApi = api as Partial<AgentDebugInspectionApi>;
  const handlers = {
    ...localComputerHandlers,
    callLocalComputerTool: async (context: Context) => {
      const body = await readJsonBody(context);
      if (
        !isRecord(body) ||
        !isRecord(body.arguments) ||
        !["browser", "task_files"].includes(String(body.server)) ||
        [
          "tenant_id",
          "owner_actor_id",
          "computer_id",
          "agent_id",
          "tool_session_id",
          "tool_name",
        ].some((key) => typeof body[key] !== "string" || !body[key].trim())
      )
        return context.json(
          {
            error: {
              code: "INVALID_REQUEST",
              message: "Computer tool identity is invalid",
            },
          },
          400,
        );
      if (!computerTools)
        return context.json(
          {
            error: {
              code: "COMPUTER_UNAVAILABLE",
              message: "Runner Gateway is unavailable",
            },
          },
          503,
        );
      const request =
        body as unknown as AgentManagementSchemas["schemas"]["LocalComputerToolCall"];
      const scope = request.task_scope;
      const result = await computerTools.callComputerTool({
        tenantId: request.tenant_id,
        ownerActorId: request.owner_actor_id,
        computerId: request.computer_id,
        agentId: request.agent_id,
        toolSessionId: request.tool_session_id,
        server: request.server,
        toolName: request.tool_name,
        arguments: request.arguments,
        ...(scope
          ? {
              taskScope: {
                ...scope,
                version: 1 as const,
                role: "alter_ego" as const,
              },
            }
          : {}),
        signal: context.req.raw.signal,
      });
      return context.json({ result });
    },
    readAgentDebugContextHistory: async (context: Context) => {
      const inspection = requireAgentDebugInspectionApi(debugApi);
      const request = parseAgentDebugHistoryRequest(
        await readJsonBody(context),
      );
      await requireAgentDebugTenant(api, request);
      const history = await inspection.inspectDebugContextHistory(request.ref, {
        ...(request.cursor ? { cursor: request.cursor } : {}),
        ...(request.limit === undefined ? {} : { limit: request.limit }),
        signal: context.req.raw.signal,
      });
      const transportHistory = redactRuntimeHistoryPage(history);
      return writeJson(context, 200, {
        status: transportHistory.status,
        provider_kind: transportHistory.providerKind,
        ...(transportHistory.status === "available"
          ? {}
          : { reason: transportHistory.reason }),
        ...(transportHistory.status === "available"
          ? {
              source: transportHistory.source,
              snapshot: {
                id: transportHistory.snapshot.id,
                thread_id: transportHistory.snapshot.threadId,
                captured_at: transportHistory.snapshot.capturedAt,
                record_count: transportHistory.snapshot.recordCount,
                tail_state: transportHistory.snapshot.tailState,
              },
              ...(transportHistory.previousCursor
                ? { previous_cursor: transportHistory.previousCursor }
                : {}),
            }
          : {}),
        instructions: toAgentDebugHistoryInstructions(
          transportHistory.instructions,
        ),
        records:
          transportHistory.status === "available"
            ? transportHistory.records.map(toAgentDebugHistoryRecord)
            : [],
      });
    },
    judgeProactiveEvent: async (context: Context) => {
      if (!proactiveEvents)
        throw new RequestError(
          503,
          "proactive_judge_unavailable",
          "Proactive event judging is unavailable",
        );
      // Up to 1,000 open-item descriptions.
      const body = await readJsonBody(context, 1024 * 1024);
      if (!isProactiveEventJudgeRequest(body))
        throw new RequestError(
          400,
          "invalid_proactive_event",
          "specific and openItems are required",
        );
      return writeJson(context, 200, await proactiveEvents.judge(body));
    },
    callModel: async (context: Context) => {
      if (!modelCall)
        throw new RequestError(
          503,
          "local_runtime_unavailable",
          "Local Computers are not configured",
        );
      const request = readModelCallRequest(
        await readJsonBody(context, MODEL_CALL_MAX_BODY_BYTES),
        context.req.raw.signal,
      );
      if (!request)
        throw new RequestError(
          400,
          "invalid_model_call",
          "input and timeoutMs are required within their limits",
        );
      try {
        return writeJson(
          context,
          200,
          await answerModelCall(modelCall, request),
        );
      } catch (error) {
        if (!(error instanceof ModelCallError)) throw error;
        const [status, code] = modelCallFailures[error.kind];
        // Both answer later: the Computer reconnects, or the queued call
        // finishes and the same request receives its result.
        const later =
          error.kind === "computer_offline" || error.kind === "pending";
        if (later)
          context.header("retry-after", String(MODEL_CALL_RETRY_AFTER_SECONDS));
        return writeProtocolError(context, status, code, error.message, later);
      }
    },
    notifyAgentRegistrationChanged: async (context: Context) => {
      const agentId = pathId(context, "agentId");
      await agentLifecycle.run(agentId, async () => {
        const ghost = await api.refreshAgent(agentId);
        if (ghost) {
          // An active Agent picks its new configuration up at its next Run.
          await localAgentRunnerManagement?.noteAgentPlacement(
            agentId,
            readLocalPlacement(ghost.runtime).computerId,
          );
          return;
        }
        // A revoked Agent stops its Contexts after its Runners are removed,
        // so stopping does not wait for an offline Computer. Removal is
        // repeated for an Agent this process no longer knows.
        const finalizeRunners = async () => {
          await localAgentRunnerManagement?.finalizeDeletedLocalAgentRunner(
            agentId,
          );
        };
        await api.deleteAgent(agentId, {
          beforeIdentityRemoval: finalizeRunners,
        });
        await finalizeRunners();
      });
      return context.body(null, 204);
    },
    cancelAgentRun: async (context: Context) => {
      const runId = pathId(context, "runId");
      const body = await readJsonBody(context);
      if (
        !isRecord(body) ||
        Object.keys(body).some(
          (key) => !["request_id", "run_id", "context_ref"].includes(key),
        ) ||
        !isNonEmptyString(body.request_id) ||
        body.run_id !== runId
      ) {
        throw new RequestError(
          400,
          "invalid_run_cancel",
          "request_id and matching run_id are required",
        );
      }
      if (body.context_ref === undefined) {
        return writeJson(context, 200, { run_id: runId, status: "not_found" });
      }
      const ref = body.context_ref;
      if (
        !isRecord(ref) ||
        ref.kind !== "meta" ||
        !isNonEmptyString(ref.agent_id) ||
        !isNonEmptyString(ref.room_id) ||
        Object.keys(ref).some(
          (key) => !["kind", "agent_id", "room_id"].includes(key),
        )
      ) {
        throw new RequestError(
          400,
          "invalid_run_cancel",
          "A Meta Context reference is required",
        );
      }
      const status = await api.cancelLocalRun(
        { kind: "meta", agentId: ref.agent_id, roomId: ref.room_id },
        runId,
      );
      if (status === "not_found") {
        throw new RequestError(
          404,
          "run_not_found",
          "Run was not found in the requested Context",
        );
      }
      return writeJson(context, 200, { run_id: runId, status });
    },
    methodNotAllowed: (context: Context, allow: string) =>
      methodNotAllowed(context, allow),
  };
  AgentManagementRoutes.registerAgentManagementRoutes(app, handlers);
  app.post("/v1/local-computer-tools:call", handlers.callLocalComputerTool);
  registerLocalComputerCompatibilityRoutes(app, handlers);
  registerLocalComputerPermissionRoutes(app, handlers);

  app.notFound((context) =>
    writeProtocolError(context, 404, "not_found", "Not found"),
  );
  app.onError((error, context) => writeError(context, error));

  return app;
};

const readJsonBody = async (
  context: Context,
  maxBodyBytes = MAX_BODY_BYTES,
): Promise<unknown> => {
  const raw = await readBody(context, maxBodyBytes);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new RequestError(
      400,
      "invalid_json",
      "Request body must be valid JSON",
    );
  }
};

const readBody = async (
  context: Context,
  maxBodyBytes = MAX_BODY_BYTES,
): Promise<string> => {
  const contentLength = Number(context.req.header("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    throw payloadTooLarge(maxBodyBytes);
  }

  const body = context.req.raw.body;
  if (!body) {
    return "";
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > maxBodyBytes) {
        await reader.cancel();
        throw payloadTooLarge(maxBodyBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
};

/** How each model call failure answers POST /v1/model-calls. */
const modelCallFailures: Record<
  ModelCallErrorKind,
  readonly [JsonStatus, string]
> = {
  computer_offline: [503, "local_computer_offline"],
  pending: [503, "model_call_pending"],
  runtime_unavailable: [503, "local_runtime_unavailable"],
  owner_unresolved: [409, "model_owner_unresolved"],
  timed_out: [504, "model_call_timed_out"],
  // /v1/model-calls sets no output cap, so this only names the kind.
  output_limited: [502, "model_call_failed"],
  invalid_output: [502, "model_output_invalid"],
  invalid_request: [400, "invalid_model_call"],
  failed: [502, "model_call_failed"],
};

const payloadTooLarge = (maxBodyBytes = MAX_BODY_BYTES): RequestError =>
  new RequestError(
    413,
    "payload_too_large",
    `Request body must not exceed ${maxBodyBytes} bytes`,
  );

const pathId = (context: Context, name: string): string => {
  try {
    // Hono decodes path params leniently, so validate the original encoded path first.
    decodeURIComponent(new URL(context.req.url).pathname);
  } catch {
    throw new RequestError(400, "invalid_path", "Path identifier is invalid");
  }
  const value = context.req.param(name);
  if (!value) {
    throw new RequestError(400, "invalid_path", "Path identifier is invalid");
  }
  return value;
};

const methodNotAllowed = (context: Context, allow: string): Response => {
  context.header("allow", allow);
  return writeProtocolError(
    context,
    405,
    "method_not_allowed",
    "Method not allowed",
  );
};

interface ParsedAgentDebugTarget {
  readonly tenantId: string;
  readonly contextKey: string;
  readonly ref: ExecutionContextRef;
}

interface ParsedAgentDebugHistoryRequest extends ParsedAgentDebugTarget {
  readonly cursor?: string;
  readonly limit?: number;
}

const parseAgentDebugHistoryRequest = (
  value: unknown,
): ParsedAgentDebugHistoryRequest => {
  if (!isRecord(value)) throw invalidAgentDebugRequest();
  const keys = Object.keys(value);
  const allowed = new Set([
    "tenant_id",
    "context_key",
    "ref",
    "cursor",
    "limit",
  ]);
  if (keys.some((key) => !allowed.has(key))) throw invalidAgentDebugRequest();
  if (
    value.cursor !== undefined &&
    (typeof value.cursor !== "string" ||
      value.cursor.length < 1 ||
      value.cursor.length > 4096)
  ) {
    throw invalidAgentDebugRequest();
  }
  if (
    value.limit !== undefined &&
    (!Number.isInteger(value.limit) ||
      (value.limit as number) < 1 ||
      (value.limit as number) > 500)
  ) {
    throw invalidAgentDebugRequest();
  }
  const target = parseAgentDebugTarget({
    tenant_id: value.tenant_id,
    context_key: value.context_key,
    ref: value.ref,
  });
  return {
    ...target,
    ...(typeof value.cursor === "string" ? { cursor: value.cursor } : {}),
    ...(typeof value.limit === "number" ? { limit: value.limit } : {}),
  };
};

const toAgentDebugHistoryInstructions = (
  instructions: import("../history.js").RuntimeHistoryInstructions,
) => ({
  status: instructions.status,
  source: instructions.source,
  ...(instructions.status === "unavailable"
    ? { reason: instructions.reason }
    : {}),
  blocks: instructions.blocks.map((block) => ({
    record_ordinal: block.recordOrdinal,
    record_type: block.recordType,
    field: block.field,
    ...(block.contentOrdinal === undefined
      ? {}
      : { content_ordinal: block.contentOrdinal }),
    ...(block.timestamp ? { timestamp: block.timestamp } : {}),
    text: block.text,
  })),
});

const toAgentDebugHistoryRecord = (
  record: import("../history.js").RuntimeHistoryRecord,
) => ({
  ordinal: record.ordinal,
  ...(record.timestamp ? { timestamp: record.timestamp } : {}),
  ...(record.turnId ? { turn_id: record.turnId } : {}),
  category: record.category,
  native_type: record.nativeType,
  ...(record.toolCallId ? { tool_call_id: record.toolCallId } : {}),
  ...(record.toolName ? { tool_name: record.toolName } : {}),
  ...(record.role ? { role: record.role } : {}),
  ...(record.phase ? { phase: record.phase } : {}),
  native_record: record.nativeRecord,
  redacted_fields: record.redactedFields.map((field) => ({
    path: field.path,
    reason: field.reason,
    ...(field.byteCount === undefined ? {} : { byte_count: field.byteCount }),
  })),
});

const parseAgentDebugTarget = (value: unknown): ParsedAgentDebugTarget => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["tenant_id", "context_key", "ref"]) ||
    !isProtocolId(value.tenant_id) ||
    typeof value.context_key !== "string" ||
    value.context_key.length < 1 ||
    value.context_key.length > 1_000 ||
    !isRecord(value.ref)
  ) {
    throw invalidAgentDebugRequest();
  }
  let ref: ExecutionContextRef;
  if (
    value.ref.kind === "meta" &&
    hasExactKeys(value.ref, ["kind", "agent_id", "room_id"]) &&
    isProtocolId(value.ref.agent_id) &&
    isProtocolId(value.ref.room_id)
  ) {
    ref = {
      kind: "meta",
      agentId: value.ref.agent_id,
      roomId: value.ref.room_id,
    };
  } else if (
    value.ref.kind === "alter_ego" &&
    hasExactKeys(value.ref, ["kind", "agent_id", "task_id"]) &&
    isProtocolId(value.ref.agent_id) &&
    isProtocolId(value.ref.task_id)
  ) {
    ref = {
      kind: "alter_ego",
      agentId: value.ref.agent_id,
      taskId: value.ref.task_id,
    };
  } else if (
    value.ref.kind === "document" &&
    hasExactKeys(value.ref, ["kind", "agent_id", "document_id"]) &&
    isProtocolId(value.ref.agent_id) &&
    isProtocolId(value.ref.document_id)
  ) {
    ref = {
      kind: "document",
      agentId: value.ref.agent_id,
      documentId: value.ref.document_id,
    };
  } else {
    throw invalidAgentDebugRequest();
  }
  if (encodeExecutionContextRef(ref) !== value.context_key) {
    throw invalidAgentDebugRequest();
  }
  return {
    tenantId: value.tenant_id,
    contextKey: value.context_key,
    ref,
  };
};

const invalidAgentDebugRequest = (): RequestError =>
  new RequestError(
    400,
    "invalid_agent_debug_request",
    "Agent Debug inspection target is invalid",
  );

const requireAgentDebugInspectionApi = (
  api: Partial<AgentDebugInspectionApi>,
): AgentDebugInspectionApi => {
  if (!api.inspectDebugContextHistory) {
    throw new RequestError(
      503,
      "agent_debug_unavailable",
      "Agent Runtime inspection is unavailable",
    );
  }
  return api as AgentDebugInspectionApi;
};

const requireAgentDebugTenant = async <TRuntimeSettings>(
  api: AgentManagerApi<TRuntimeSettings>,
  target: ParsedAgentDebugTarget,
): Promise<void> => {
  const ghost = await api.getGhost(target.ref.agentId);
  if (!ghost || ghost.tenantId !== target.tenantId) {
    throw new RequestError(
      404,
      "agent_debug_context_not_found",
      "Agent Debug Context was not found",
    );
  }
};

const isText = (value: unknown, max: number, min = 1): value is string =>
  typeof value === "string" && value.length >= min && value.length <= max;

const isTime = (value: unknown): value is string =>
  typeof value === "string" && !Number.isNaN(Date.parse(value));

const hasOnly = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));

const isProactiveEventJudgeRequest = (
  value: unknown,
): value is ProactiveEventJudgeRequest => {
  if (!isRecord(value) || !hasOnly(value, ["specific", "openItems"]))
    return false;
  const { specific, openItems } = value;
  return (
    Array.isArray(specific) &&
    specific.length <= 20 &&
    specific.every((rule) => isText(rule, 200, 0)) &&
    Array.isArray(openItems) &&
    openItems.length <= 1000 &&
    openItems.every(
      (item) =>
        isRecord(item) &&
        hasOnly(item, ["content", "dueAt"]) &&
        isText(item.content, 200) &&
        (item.dueAt === undefined || isTime(item.dueAt)),
    )
  );
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isProtocolId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 64 &&
  /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);

// A Ghost's runtime always carries the Local placement TeamHub persisted.
const readLocalPlacement = (runtime: unknown): LocalPlacementRequirement =>
  parseLocalPlacement(isRecord(runtime) ? runtime.placement : undefined);

const writeError = (context: Context, error: unknown): Response => {
  if (
    error instanceof RequestError ||
    error instanceof LocalComputerHttpError
  ) {
    return writeProtocolError(
      context,
      error.status,
      error.errorCode,
      error.message,
    );
  }

  const coreCode = errorCode(error);
  const status = statusForCoreError(coreCode);
  return writeProtocolError(
    context,
    status,
    coreCode ?? "internal_error",
    coreCode ? errorMessage(error) : "Internal server error",
  );
};

const errorCode = (error: unknown): string | null => {
  if (isRecord(error) && typeof error.code === "string") {
    return error.code;
  }
  return null;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "AgentManager request failed";

const statusForCoreError = (code: string | null): JsonStatus => {
  switch (code) {
    case "invalid_runtime":
    case "invalid_run_command":
      return 400;
    case "agent_not_registered":
    case "binding_not_found":
    case "run_not_found":
      return 404;
    case "invalid_state":
    case "agent_busy":
    case "agent_activation_rejected":
    case "agent_revision_conflict":
    case "agent_deleting":
    case "message_conflict":
    case "run_cancel_conflict":
    case "run_command_conflict":
      return 409;
    case "manager_closed":
    case "agent_activation_pending":
    case "identity_unavailable":
      return 503;
    case "identity_resolution_failed":
      return 500;
    default:
      return 500;
  }
};

const writeProtocolError = (
  context: Context,
  status: JsonStatus,
  code: string,
  message: string,
  retryable = false,
): Response => {
  const body: ProtocolErrorBody = {
    error: {
      code: code.toUpperCase(),
      message,
      request_id: `request_${randomBytes(16).toString("hex")}`,
      ...(retryable ? { retryable: true } : {}),
    },
  };
  return writeJson(context, status, body);
};

const writeJson = (
  context: Context,
  status: JsonStatus,
  value: unknown,
): Response => {
  context.header("cache-control", "no-store");
  context.status(status);
  return context.json(value);
};

const assertServerConfiguration = (host: string, port: number): void => {
  if (host.length === 0) {
    throw new TypeError("AgentManager HTTP host must not be empty");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new TypeError(
      "AgentManager HTTP port must be an integer between 0 and 65535",
    );
  }
};

const requireServiceToken = (serviceToken: string): string => {
  if (!serviceToken.trim()) {
    throw new TypeError("AgentManager service token must not be empty");
  }
  return serviceToken;
};

const hostAddress = (httpHost: HttpHost): AgentManagerHttpServerAddress => ({
  host: httpHost.host,
  port: httpHost.port,
  url: httpHost.url,
});

const hasExactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean => {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
};
