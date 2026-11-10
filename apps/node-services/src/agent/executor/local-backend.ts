import type { ExecutionContextRef } from "./context-ref.js";
import type { CliRunContext, AgentInput } from "./provider.js";
import type { ToolRunContext } from "./types.js";
import { displayText } from "@linger/service-kit";
import type {
  OpaqueObject,
  ContextViewRef,
  LocalMcpRelayDescriptor,
  LocalRunResources,
  RuntimeConfig,
} from "@linger/wire-contracts/runner-gateway/types";
import { createTeamHubAgentRuntimeStateClient } from "@linger/wire-contracts/teamhub-internal/client";
import type { AgentLogger } from "../observability/agent-log.js";
import type {
  ContextViewContent,
  ContextViewSkill,
  ContextViewSnapshot,
} from "../runner-gateway/context-view-content.js";
import type { LocalAgentRunnerManagement } from "../runner-gateway/local-computer-management.js";
import type {
  LocalMcpRelayRegistrar,
  LocalMcpRelayServer,
} from "../runner-gateway/local-mcp-relay.js";
import {
  RemoteCodexProvider,
  type RemoteContextRunResourceResolver,
} from "../runner-gateway/remote-codex-provider.js";
import type {
  LocalContextRunIdentity,
  LocalContextViewIdentity,
  RunnerAgentCliCredentialController,
  RunnerContextDebugInspector,
  RunnerGateway,
  RunnerOperationDispatcher,
} from "../runner-gateway/runner-gateway.js";
import type { LocalRuntimeSettings } from "../runtime-settings.js";
import type {
  ContextRuntimeBackend,
  ContextRuntimeBackendRequest,
  ContextRuntimeSkillDescriptor,
} from "./activation.js";
import type { RuntimeViewPlan } from "./workspace.js";

type CliRunContextScope = CliRunContext["scope"];

export interface TeamHubCliConfigurationSource {
  readonly baseUrl: string;
  readonly serviceToken: string;
}

export interface TeamHubCliRunContext {
  readonly run_id?: string;
  /** The Context the CLI acts for; the Computer writes it to config.json. */
  readonly scope: CliRunContextScope;
}

/** Per-run CLI fields; the Computer writes them to `.teamhub/cli/`. */
export function buildTeamHubCliRunContext(options: {
  readonly ref: ExecutionContextRef;
  readonly runId?: string;
}): TeamHubCliRunContext {
  return {
    ...(options.runId ? { run_id: options.runId } : {}),
    scope: cliScope(options.ref),
  };
}

function cliScope(ref: ExecutionContextRef): CliRunContextScope {
  return ref.kind === "document"
    ? { kind: "document", id: ref.documentId }
    : ref.kind === "alter_ego"
      ? { kind: "task", id: ref.taskId }
      : { kind: "room", id: ref.roomId };
}

/**
 * `ensure` asks the Runner Gateway to install the Agent's long-term CLI
 * credential on the Computer; it sends nothing while the Computer holds it
 * for the current placement. Each Run ensures before it starts; nothing
 * renews a held credential.
 */
export function createRuntimeTeamHubCliConfiguration(options: {
  readonly ensure: (signal: AbortSignal) => Promise<void>;
  /** Builds the per-run CLI context for the active Run. */
  readonly buildRunContext?: (state: {
    readonly runId?: string;
  }) => TeamHubCliRunContext;
}) {
  let activeRunId: string | undefined;
  const refresh = async (signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    await options.ensure(signal);
  };
  return {
    refresh,
    async prepareRunInput(
      input: AgentInput,
      signal: AbortSignal,
    ): Promise<AgentInput> {
      await refresh(signal);
      const cliRunContext = options.buildRunContext?.({ runId: activeRunId });
      return cliRunContext ? { ...input, cliRunContext } : input;
    },
    setActiveRunContext(context: ToolRunContext | null): void {
      activeRunId = context?.runId;
    },
  };
}

type RuntimeStateClient = ReturnType<
  typeof createTeamHubAgentRuntimeStateClient
>;

/**
 * Posts one native Runtime question card through TeamHub. A failure throws a
 * message saying whether TeamHub refused the card or the outcome is unknown
 * and the card may already be in the Room.
 */
export const createRuntimeQuestion = async (
  teamhub: Parameters<typeof createTeamHubAgentRuntimeStateClient>[0],
  body: Parameters<RuntimeStateClient["createRuntimeHumanInteraction"]>[0],
  signal: AbortSignal,
  logger: AgentLogger,
): Promise<OpaqueObject> => {
  const fields = {
    execution_run_ref: body.execution_run_ref,
    operation_id: body.operation_id,
    request_id: displayText(body.request.request_id),
  };
  let response: Response;
  try {
    response = await createTeamHubAgentRuntimeStateClient(
      teamhub,
    ).createRuntimeHumanInteraction(
      body,
      AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    );
  } catch (error) {
    if (signal.aborted) throw error;
    logger.log("warn", "runtime_question.create_failed", {
      ...fields,
      outcome: "unknown",
      error: error instanceof Error ? error.message : displayText(error),
    });
    throw new Error(
      "Posting the question timed out or lost its connection, so the card may already be in the Room. Check the Room before asking again; do not post it twice.",
      { cause: error },
    );
  }
  if (response.ok) return (await response.json()) as OpaqueObject;
  const error = await response.json().then(
    (parsed: { error?: { code?: unknown; message?: unknown } }) => parsed.error,
    () => undefined,
  );
  const code = typeof error?.code === "string" ? error.code : "";
  const message = typeof error?.message === "string" ? error.message : "";
  const refused = response.status < 500;
  logger.log("warn", "runtime_question.create_failed", {
    ...fields,
    outcome: refused ? "refused" : "unknown",
    status: response.status,
    code,
  });
  const answer = `TeamHub answered ${response.status}${code ? ` ${code}` : ""}${message ? `: ${message}` : ""}`;
  throw new Error(
    response.status === 400
      ? `The question was not posted (${answer}). Correct the input and ask again.`
      : refused
        ? `The question was not posted (${answer}). This Run can no longer ask questions; do not post it again.`
        : `The question may not have been posted (${answer}). Check the Room before asking again; do not post it twice.`,
  );
};

const RUNTIME_WORKSPACE = "/workspace";
// Models with at most a 128K-token context window, such as local models, get
// the compact instructions.
const COMPACT_INSTRUCTIONS_MAX_CONTEXT_WINDOW = 128 * 1024;
const DEFAULT_RELAY_CAPABILITY_TTL_MS = 24 * 60 * 60 * 1_000;

export interface LocalContextRuntimeGateway
  extends
    RunnerOperationDispatcher,
    Pick<
      LocalAgentRunnerManagement,
      "ensureReadyLocalAgentRunner" | "requireLocalPlacement"
    > {
  readonly readReadyLocalAgentRunnerRevision?: RunnerGateway["readReadyLocalAgentRunnerRevision"];
  readonly contextViewContent?: ContextViewContent;
  readonly awaitLocalComputerReconnect?: RunnerGateway["awaitLocalComputerReconnect"];
  readonly inspectDetachedLocalHistory?: RunnerContextDebugInspector["inspectDetachedLocalHistory"];
  readonly inspectLocalContext?: RunnerContextDebugInspector["inspectLocalContext"];
  readonly ensureAgentCliCredential?: RunnerAgentCliCredentialController["ensureAgentCliCredential"];
}

interface CleanupStep {
  completed?: boolean;
  readonly run: () => Promise<void>;
}

interface LocalContextRuntimeBackendOptions {
  readonly gateway: LocalContextRuntimeGateway;
  readonly contextViewContent: ContextViewContent;
  readonly mcpRelay: LocalMcpRelayRegistrar;
  readonly teamhubFiles?: TeamHubCliConfigurationSource;
  readonly relayCapabilityTtlMs?: number;
  readonly now?: () => number;
}

export function createLocalContextRuntimeBackend(
  options: LocalContextRuntimeBackendOptions,
): ContextRuntimeBackend<LocalRuntimeSettings> {
  return {
    async preflight(request) {
      const modelId = requireLocalRuntimeModel(request.runtime);
      request.signal.throwIfAborted();
      await options.gateway.awaitLocalComputerReconnect?.(
        request.runtime.placement.computerId,
        request.signal,
      );
      request.signal.throwIfAborted();
      const model = options.gateway.requireLocalPlacement(
        request.runtime.placement,
        modelId,
        request.runtime.reasoningEffort,
      );
      return {
        compactInstructions:
          model.contextWindow !== undefined &&
          model.contextWindow <= COMPACT_INSTRUCTIONS_MAX_CONTEXT_WINDOW,
      };
    },
    activate: (request) => activateLocalContextRuntime(options, request),
  };
}

async function activateLocalContextRuntime(
  options: LocalContextRuntimeBackendOptions,
  request: ContextRuntimeBackendRequest<LocalRuntimeSettings>,
) {
  const cleanup: CleanupStep[] = [];
  let activeRunContext: ToolRunContext | null = null;
  let activeRelayRun: LocalContextRunIdentity | null = null;
  try {
    const modelId = requireLocalRuntimeModel(request.runtime);
    const now = options.now ?? Date.now;
    const relayCapabilityTtlMs = positiveInteger(
      options.relayCapabilityTtlMs ?? DEFAULT_RELAY_CAPABILITY_TTL_MS,
      "relayCapabilityTtlMs",
    );
    request.signal.throwIfAborted();
    const runnerOptions = {
      placement: request.runtime.placement,
      modelId,
      ...(request.runtime.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: request.runtime.reasoningEffort }),
      agentId: request.ref.agentId,
    };
    const skills = contextViewSkills(request.resources.skills);
    // No Agent Service MCP server rides the Local MCP Relay today, so a Run
    // registers none.
    const relayServers: readonly LocalMcpRelayServer[] = Object.freeze([]);
    const snapshotView = (
      plan: RuntimeViewPlan,
      signal: AbortSignal,
    ): Promise<ContextViewSnapshot> =>
      options.contextViewContent.snapshot({
        computerId: request.runtime.placement.computerId,
        plan,
        runtimeInstanceId: request.runtimeInstanceKey,
        skills,
        signal,
      });
    const startedAt = now();
    // Settle both branches so a snapshot published while the Runner failed
    // is released instead of staying downloadable for the process lifetime.
    const [revisionResult, snapshotResult] = await Promise.allSettled([
      options.gateway.ensureReadyLocalAgentRunner({
        ...runnerOptions,
        signal: request.signal,
      }),
      snapshotView(request.viewPlan, request.signal),
    ]);
    if (revisionResult.status === "rejected") {
      if (snapshotResult.status === "fulfilled") snapshotResult.value.release();
      throw revisionResult.reason;
    }
    if (snapshotResult.status === "rejected") throw snapshotResult.reason;
    const runnerRevision = revisionResult.value;
    const initialSnapshot = snapshotResult.value;
    request.logger.log(
      "info",
      "context_activation.local_preparation_finished",
      {
        durationMs: now() - startedAt,
      },
    );
    // The current View and the one it replaced stay published, so a Computer
    // still fetching the replaced View for an earlier start can finish.
    let current = initialSnapshot;
    let replaced: ContextViewSnapshot | undefined;
    cleanup.push({
      run: async () => {
        current.release();
        replaced?.release();
      },
    });
    let contextIdentity: LocalContextViewIdentity = {
      computerId: request.runtime.placement.computerId,
      tenantId: request.runtime.placement.tenantId,
      agentId: request.ref.agentId,
      runnerRevision,
      workspaceGrantId: request.runtime.placement.workspaceGrantId,
      executionContextKey: request.viewPlan.contextKey,
      runtimeInstanceId: request.runtimeInstanceKey,
      viewDigest: current.viewDigest,
    };
    const contextViewRef = (): ContextViewRef => ({
      view_digest: contextIdentity.viewDigest,
    });
    const debugGateway: RunnerContextDebugInspector | undefined = options
      .gateway.inspectLocalContext
      ? Object.freeze({
          inspectLocalContext: (
            input: Parameters<
              RunnerContextDebugInspector["inspectLocalContext"]
            >[0],
          ) => {
            const signal = AbortSignal.any([
              request.signal,
              viewController.signal,
              ...(input.signal ? [input.signal] : []),
            ]);
            signal.throwIfAborted();
            if (!options.gateway.readReadyLocalAgentRunnerRevision) {
              throw new Error(
                "Local Computer requires read-only Runner inspection",
              );
            }
            // Reading history must never recreate or move a Runner. Reconnect
            // may advance its revision, but every placement field must match.
            const revision =
              options.gateway.readReadyLocalAgentRunnerRevision(runnerOptions);
            return options.gateway.inspectLocalContext!({
              ...input,
              signal,
              context: { ...input.context, runnerRevision: revision },
            });
          },
        })
      : undefined;
    const ensureCliCredential = async (signal: AbortSignal) => {
      if (!options.gateway.ensureAgentCliCredential)
        throw new Error("Local Computer requires Agent CLI credential support");
      if (!options.gateway.readReadyLocalAgentRunnerRevision)
        throw new Error("Local Computer requires read-only Runner inspection");
      const revision =
        options.gateway.readReadyLocalAgentRunnerRevision(runnerOptions);
      await options.gateway.ensureAgentCliCredential({
        computerId: contextIdentity.computerId,
        tenantId: contextIdentity.tenantId,
        agentId: contextIdentity.agentId,
        runnerRevision: revision,
        workspaceGrantId: contextIdentity.workspaceGrantId,
        signal,
      });
    };
    const cliRuntimeConfiguration = options.teamhubFiles
      ? createRuntimeTeamHubCliConfiguration({
          buildRunContext: (state) =>
            buildTeamHubCliRunContext({ ref: request.ref, ...state }),
          ensure: ensureCliCredential,
        })
      : undefined;
    // A start or input runs with one View, so a synchronization never swaps
    // the View between choosing it and the Computer admitting it.
    let viewTail = Promise.resolve();
    const viewController = new AbortController();
    const withContextView = <T>(
      operation: () => Promise<T>,
      signal?: AbortSignal,
    ): Promise<T> => {
      const queuedSignal = AbortSignal.any([
        request.signal,
        viewController.signal,
        ...(signal ? [signal] : []),
      ]);
      const queued = viewTail
        .catch(() => undefined)
        .then(() => {
          queuedSignal.throwIfAborted();
          return operation();
        });
      viewTail = queued.then(
        () => undefined,
        () => undefined,
      );
      return queued;
    };
    cleanup.push({ run: () => viewTail });
    const synchronizeContextView = (
      viewPlan: RuntimeViewPlan,
      signal?: AbortSignal,
    ): Promise<void> =>
      withContextView(async () => {
        const synchronizeSignal = signal ?? request.signal;
        const startedAt = now();
        // CLI files and the View snapshot are independent. Drain both
        // branches before returning, including when either one fails.
        const revision = options.gateway.ensureReadyLocalAgentRunner({
          ...runnerOptions,
          signal: synchronizeSignal,
        });
        const [revisionResult, cliResult, snapshotResult] =
          await Promise.allSettled([
            revision,
            // The credential belongs to the Runner the Computer holds now. A
            // reconnect (or the switch from runtime-host to the daemon) can
            // advance its revision; the old one would be refused every time.
            revision.then((runnerRevision) => {
              contextIdentity = { ...contextIdentity, runnerRevision };
              return cliRuntimeConfiguration?.refresh(synchronizeSignal);
            }),
            snapshotView(viewPlan, synchronizeSignal),
          ]);
        request.logger.log(
          "info",
          "context_runtime.local_synchronization_prepared",
          {
            durationMs: now() - startedAt,
            cliOutcome: cliResult.status,
            snapshotOutcome: snapshotResult.status,
          },
        );
        const failure = [revisionResult, cliResult, snapshotResult].find(
          (result) => result.status === "rejected",
        );
        if (failure) {
          if (snapshotResult.status === "fulfilled")
            snapshotResult.value.release();
          throw failure.reason;
        }
        const next = (
          snapshotResult as PromiseFulfilledResult<ContextViewSnapshot>
        ).value;
        if (next.viewDigest === current.viewDigest) {
          next.release();
          return;
        }
        replaced?.release();
        replaced = current;
        current = next;
        contextIdentity = { ...contextIdentity, viewDigest: next.viewDigest };
        request.logger.log("info", "context_runtime.context_view_changed", {
          viewDigest: next.viewDigest,
        });
        // An active Turn's relay identity follows the View its next input names.
        if (activeRelayRun && activeRunContext) {
          const rebound = contextRunIdentity(
            contextIdentity,
            activeRunContext.runId,
          );
          options.mcpRelay.rebind(activeRelayRun, rebound);
          activeRelayRun = rebound;
        }
      }, signal);
    const runResources: RemoteContextRunResourceResolver = {
      withContextView,
      currentContextViewRef: contextViewRef,
      async resolve(context, signal): Promise<LocalRunResources> {
        signal?.throwIfAborted();
        if (
          !activeRunContext ||
          activeRunContext.runId !== context.executionRunRef
        ) {
          throw new Error(
            "Local Context Run resources require the active Shell Run",
          );
        }
        if (activeRelayRun) options.mcpRelay.revoke(activeRelayRun);
        const relayRun = contextRunIdentity(
          contextIdentity,
          context.executionRunRef,
        );
        const descriptors: readonly LocalMcpRelayDescriptor[] =
          relayServers.length === 0
            ? []
            : options.mcpRelay.register({
                run: relayRun,
                expiresAt: new Date(now() + relayCapabilityTtlMs).toISOString(),
                servers: relayServers,
                signal,
              });
        activeRelayRun = relayServers.length === 0 ? null : relayRun;
        return { mcp_servers: [...descriptors] };
      },
    };
    cleanup.push({
      run: async () => {
        if (activeRelayRun) options.mcpRelay.revoke(activeRelayRun);
        activeRelayRun = null;
        activeRunContext = null;
      },
    });

    const runtime: RuntimeConfig = {
      type: request.runtime.placement.runtimeType,
      model: modelId,
      ...(request.runtime.reasoningEffort === undefined
        ? {}
        : { reasoning_effort: request.runtime.reasoningEffort }),
    };
    const provider = new RemoteCodexProvider({
      ...(request.compactInstructions ? { compactInstructions: true } : {}),
      ...(cliRuntimeConfiguration
        ? { beforePresencePrepare: cliRuntimeConfiguration.refresh }
        : {}),
      // A reviewing Context asks TeamHub, which picks the approval Room for
      // the Context kind. Without review the Run declares none, so no
      // permission prompt makes the round trip.
      ...(options.teamhubFiles && request.permissionReview
        ? {
            onPermissionReview: async (input, signal) => {
              const client = createTeamHubAgentRuntimeStateClient(
                options.teamhubFiles!,
              );
              const { kind: _kind, request_id, ...review } = input.request;
              const response = await client.createRuntimePermissionReview(
                {
                  ...(review as Omit<
                    import("@linger/wire-contracts/teamhub-internal/types").components["schemas"]["CreateRuntimePermissionReviewRequest"],
                    | "context_key"
                    | "execution_run_ref"
                    | "operation_id"
                    | "request_id"
                  >),
                  context_key: request.viewPlan.contextKey,
                  execution_run_ref: input.executionRunRef,
                  operation_id: input.operationId,
                  request_id: displayText(request_id),
                },
                // Leave time after the judge's 15s limit to create an approval
                // card, and deliver it before the Daemon's 20s deadline.
                AbortSignal.any([signal, AbortSignal.timeout(18_000)]),
              );
              if (!response.ok) {
                await response.body?.cancel();
                throw new Error(
                  `Runtime permission review failed (${response.status})`,
                );
              }
              return (await response.json()) as import("@linger/wire-contracts/runner-gateway/types").OpaqueObject;
            },
          }
        : {}),
      ...(options.teamhubFiles && request.ref.kind === "meta"
        ? {
            onHumanInteraction: (input, signal) =>
              createRuntimeQuestion(
                options.teamhubFiles!,
                {
                  context_key: request.viewPlan.contextKey,
                  execution_run_ref: input.executionRunRef,
                  operation_id: input.operationId,
                  request: input.request,
                },
                signal,
                request.logger,
              ),
          }
        : {}),
      dispatcher: options.gateway,
      logger: request.logger,
      ...(debugGateway
        ? {
            debugInspector: debugGateway,
            debugRunnerRevision: () => contextIdentity.runnerRevision,
          }
        : {}),
      target: {
        tenantId: request.runtime.placement.tenantId,
        ownerActorId: request.runtime.placement.ownerActorId,
        runnerId: request.runtime.placement.computerId,
        agentId: request.ref.agentId,
        workspaceGrantId: request.runtime.placement.workspaceGrantId,
        executionContextKey: request.viewPlan.contextKey,
        runtimeInstanceId: request.runtimeInstanceKey,
        contextViewRef: contextViewRef(),
      },
      runtime,
      contextRunResources: runResources,
    });
    cleanup.push({ run: () => provider.close() });
    request.signal.throwIfAborted();

    let deactivationPromise: Promise<void> | null = null;
    return Object.freeze({
      provider,
      runtimeName: request.runtime.placement.runtimeType,
      sessionSpec: Object.freeze({
        workingDirectory: RUNTIME_WORKSPACE,
        threadName: request.agent.name,
        model: modelId,
        sandboxMode: "workspace-write" as const,
        baseInstructions: request.agent.instructions,
        developerInstructions: request.agent.developerInstructions,
        resources: Object.freeze({ mcpServers: Object.freeze([]) }),
      }),
      setActiveRunContext(context: ToolRunContext | null): void {
        cliRuntimeConfiguration?.setActiveRunContext(context);
        if (!context && activeRelayRun) {
          options.mcpRelay.revoke(activeRelayRun);
          activeRelayRun = null;
        }
        activeRunContext = context;
      },
      ...(cliRuntimeConfiguration
        ? { prepareRunInput: cliRuntimeConfiguration.prepareRunInput }
        : {}),
      synchronize: (viewPlan: RuntimeViewPlan, signal?: AbortSignal) =>
        synchronizeContextView(viewPlan, signal),
      deactivate(): Promise<void> {
        viewController.abort(
          new Error("Local Context Runtime is deactivating"),
        );
        if (!deactivationPromise) {
          deactivationPromise = cleanupReverse(
            cleanup,
            "Local Context Runtime deactivation failed",
          ).catch((error: unknown) => {
            deactivationPromise = null;
            throw error;
          });
        }
        return deactivationPromise;
      },
    });
  } catch (error) {
    const cleanupErrors = await runCleanupReverse(cleanup);
    throw combineFailure(
      error,
      cleanupErrors,
      "Local Context Runtime activation failed",
    );
  }
}

function contextViewSkills(
  skills: readonly ContextRuntimeSkillDescriptor[],
): readonly ContextViewSkill[] {
  return skills.map((skill) => {
    if (!skill.manifestId)
      throw new TypeError(`Skill ${skill.skillId} has no package manifest`);
    return {
      package_name: skill.packageName,
      manifest_id: skill.manifestId,
      package_sha256: skill.packageSha256,
    };
  });
}

function requireLocalRuntimeModel(runtime: LocalRuntimeSettings): string {
  return requireNonEmpty(runtime.model, "runtime.model");
}

function contextRunIdentity(
  context: LocalContextViewIdentity,
  executionRunRef: string,
): LocalContextRunIdentity {
  return { ...context, executionRunRef };
}

async function cleanupReverse(
  steps: readonly CleanupStep[],
  message: string,
): Promise<void> {
  const errors = await runCleanupReverse(steps);
  if (errors.length > 0) throw new AggregateError(errors, message);
}

async function runCleanupReverse(
  steps: readonly CleanupStep[],
): Promise<Error[]> {
  const errors: Error[] = [];
  for (const step of [...steps].reverse()) {
    if (step.completed) continue;
    try {
      await step.run();
      step.completed = true;
    } catch (error) {
      errors.push(asError(error));
    }
  }
  return errors;
}

function combineFailure(
  failure: unknown,
  cleanupErrors: readonly Error[],
  message: string,
): unknown {
  return cleanupErrors.length === 0
    ? failure
    : new AggregateError([failure, ...cleanupErrors], message, {
        cause: failure,
      });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function requireNonEmpty(value: string | undefined, field: string): string {
  if (!value?.trim()) throw new TypeError(`${field} must not be empty`);
  return value;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value;
}
