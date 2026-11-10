import type {
  RuntimeViewPlan,
  AgentContextHost,
  StagedDocumentProjection,
} from "./workspace.js";
import type { SkillDescriptor, GhostResources } from "./ghost.js";
import {
  type ExecutionContextRef,
  encodeExecutionContextRef,
  type SharedTaskScope,
} from "./context-ref.js";
import {
  type AgentLogger,
  claimAgentFailureAlert,
} from "../observability/agent-log.js";
import {
  type AgentInput,
  type AgentProvider,
  type ProviderSessionOptions,
  type ProviderRunContext,
  type RuntimeSession,
  ProviderRunInterruptedError,
  ProviderRunAdmissionUnavailableError,
  ProviderRunStartError,
  type AgentRun,
  type ExecutionSpec,
  type ProviderSteerAck,
  type ProviderSteerOptions,
  runtimeSessionStartsFresh,
} from "./provider.js";
import type { ToolRunContext, AgentDefinition, AgentType } from "./types.js";
import type { BuiltinAgentFeatures } from "../agent-features/builtin.js";
import type { ComposedActivationFeatures } from "../agent-features/compose.js";
import type {
  ActivationFeatureView,
  ContextInstructionFacts,
} from "../agent-features/contracts.js";
import {
  isLocalComputerOfflineError,
  LocalRuntimeAdmissionUnavailableError,
} from "../runner-gateway/local-computer-management.js";
import type {
  AgentEffectiveResources,
  DocumentCommentRuntimeProjection,
  AgentResourcesResolver,
  McpContextResolver,
} from "./teamhub-context-resolvers.js";
import type { ExecutionResources } from "./context-runtime-state.js";

/** Cleanup did not prove that the old Runtime resources are safely retired. */
export class ContextRuntimeCleanupError extends AggregateError {
  constructor(errors: readonly unknown[]) {
    super(errors, "Context Runtime cleanup is unavailable or unconfirmed");
    this.name = "ContextRuntimeCleanupError";
  }
}

/** A physical retirement failure is a safety fence, including inside a combined cleanup failure. */
export const isUnconfirmedContextRuntimeCleanup = (error: unknown): boolean =>
  error instanceof ContextRuntimeCleanupError ||
  (error instanceof AggregateError &&
    error.errors.some(isUnconfirmedContextRuntimeCleanup));

export interface ContextRuntimeBackendRequest<TRuntimeSettings> {
  readonly ref: ExecutionContextRef;
  readonly tenantId: string;
  readonly actorId: string;
  readonly runtimeInstanceKey: string;
  readonly executionEpoch?: ProviderRunContext["executionEpoch"];
  /**
   * Runs review Runtime permission prompts through TeamHub's judge. Absent,
   * a Run declares no review and the Runtime's own rules decide alone.
   */
  readonly permissionReview?: true;
  /**
   * The developer instructions are the compact version, so the Runtime's own
   * instruction wrapper uses its compact version too.
   */
  readonly compactInstructions?: true;
  readonly previousSession?: RuntimeSession;
  readonly viewPlan: RuntimeViewPlan;
  readonly agent: AgentDefinition;
  readonly runtime: TRuntimeSettings;
  readonly resources: {
    readonly skills: readonly ContextRuntimeSkillDescriptor[];
  };
  readonly signal: AbortSignal;
  readonly logger: AgentLogger;
}

/** A Skill the Context View names; the Computer fetches it by manifest. */
export interface ContextRuntimeSkillDescriptor extends SkillDescriptor {
  readonly manifestId?: string;
}

export interface ContextRuntimeBackendPreflightRequest<TRuntimeSettings> {
  readonly ref: ExecutionContextRef;
  readonly runtime: TRuntimeSettings;
  readonly signal: AbortSignal;
}

/** What preflight learned about the placed Runtime model. */
export interface ContextRuntimeBackendPreflight {
  /** The model's context window calls for the compact instructions. */
  readonly compactInstructions: boolean;
}

export interface ContextRuntimeBackendActivation {
  readonly provider: AgentProvider;
  readonly runtimeName: string;
  readonly sessionSpec: ProviderSessionOptions;
  setActiveRunContext(context: ToolRunContext | null): void;
  /** Installs the Agent CLI credential and attaches the per-Run CLI context. */
  prepareRunInput?(input: AgentInput, signal: AbortSignal): Promise<AgentInput>;
  synchronize(
    viewPlan: RuntimeViewPlan,
    signal?: AbortSignal,
    session?: RuntimeSession,
  ): Promise<void>;
  deactivate(): Promise<void>;
}

export interface ContextRuntimeBackend<TRuntimeSettings> {
  preflight?(
    request: ContextRuntimeBackendPreflightRequest<TRuntimeSettings>,
  ):
    | void
    | ContextRuntimeBackendPreflight
    | Promise<void | ContextRuntimeBackendPreflight>;
  activate(
    request: ContextRuntimeBackendRequest<TRuntimeSettings>,
  ): Promise<ContextRuntimeBackendActivation>;
}

/**
 * One health signal per Context activation. It aborts when the activation
 * releases its session or the service closes, which cancels the activation's
 * Runs and refuses its next ones.
 */
export interface ContextViewSession {
  readonly healthSignal: AbortSignal;
  release(): void;
}

export interface ContextViewSessions {
  open(signal: AbortSignal): ContextViewSession;
  close(): void;
}

export function createContextViewSessions(): ContextViewSessions {
  const serviceController = new AbortController();
  return {
    open(signal) {
      serviceController.signal.throwIfAborted();
      signal.throwIfAborted();
      const controller = new AbortController();
      return {
        healthSignal: AbortSignal.any([
          signal,
          controller.signal,
          serviceController.signal,
        ]),
        release() {
          controller.abort(new Error("Context View released"));
        },
      };
    },
    close() {
      serviceController.abort(new Error("Context View sessions closed"));
    },
  };
}

type ContextActivationStage =
  | "validate"
  | "preflight_backend"
  | "resolve_mcp_context"
  | "stage_document_projection"
  | "prepare_runtime_view"
  | "activate_backend"
  | "create_session"
  | "resume_session"
  | "bind_mcp_context";

export class ContextActivationError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly stage: ContextActivationStage;

  constructor(stage: ContextActivationStage, cause: unknown) {
    super("Context Runtime activation failed", { cause });
    this.name = "ContextActivationError";
    this.code = contextActivationFailureCode(stage);
    this.retryable = stage === "prepare_runtime_view";
    this.stage = stage;
  }
}

export interface ContextRuntimeActivationRequest<TRuntimeSettings> {
  readonly ref: ExecutionContextRef;
  /** TeamHub-trusted shared Task directory identity of this Context. */
  readonly sharedTaskScope?: SharedTaskScope;
  readonly tenantId: string;
  readonly actorId: string;
  /**
   * Trusted Agent type forwarded to activation/run feature matching. Only
   * callers whose features never declare `agentTypes` matching may omit it.
   */
  readonly agentType?: AgentType;
  /** Runs review Runtime permission prompts through TeamHub's judge. */
  readonly permissionReview?: true;
  /**
   * Renders `agent.developerInstructions` with the facts this activation reads
   * from the Agent's effective resources.
   */
  readonly renderDeveloperInstructions?: (
    facts: ContextInstructionFacts,
  ) => string | undefined;
  /** Correlates all activation, provider, and native-session timing events. */
  readonly activationId?: string;
  readonly mode: "start" | "resume";
  readonly previousSession?: RuntimeSession;
  /**
   * Monotonic accept time of the earliest real input this process accepted and
   * has not yet claimed, or undefined. Read after the Provider session resolves.
   */
  readonly acceptedInputSinceMs?: () => number | undefined;
  readonly executionEpoch?: ProviderRunContext["executionEpoch"];
  readonly agent: AgentDefinition;
  readonly runtime: TRuntimeSettings;
  readonly resources: GhostResources;
  readonly checkpointRuntimeSession?: (
    session: RuntimeSession,
  ) => void | Promise<void>;
  readonly signal?: AbortSignal;
}

export interface ActivatedContextRuntime {
  readonly ref: ExecutionContextRef;
  readonly provider: AgentProvider;
  readonly runtimeName: string;
  readonly runtimeSession: RuntimeSession;
  readonly sessionSpec: ProviderSessionOptions;
  readonly executionResources?: ExecutionResources;
  /** Called only before claiming a new ordinary Run, never during steer. */
  prepareNextRun?(signal: AbortSignal): Promise<boolean>;
  setActiveRunContext(context: ToolRunContext | null): void;
  deactivate(): Promise<void>;
}

/** What a caller names when it runs backend preflight ahead of activation. */
interface ContextRuntimePreflightRequest<TRuntimeSettings> {
  readonly ref: ExecutionContextRef;
  readonly runtime: TRuntimeSettings;
  readonly signal: AbortSignal;
  readonly activationId?: string;
}

export interface ContextRuntimeActivator<TRuntimeSettings> {
  activate(
    request: ContextRuntimeActivationRequest<TRuntimeSettings>,
  ): Promise<ActivatedContextRuntime>;
  /** Runs backend preflight before the caller commits to an activation. */
  preflight?(
    request: ContextRuntimePreflightRequest<TRuntimeSettings>,
  ): Promise<void>;
}

interface ContextRuntimeActivatorOptions<TRuntimeSettings> {
  /**
   * Assembled builtin feature ports. `composeActivation` runs once per
   * activation; `composeRun` binds that activation's own backend — never an
   * earlier Runtime's — so each activation gets a fresh feature state.
   */
  readonly features: Pick<
    BuiltinAgentFeatures,
    "composeActivation" | "composeRun"
  >;
  readonly contextHost: Pick<
    AgentContextHost,
    "prepareRuntimeView" | "releaseRuntimeView"
  > &
    Partial<Pick<AgentContextHost, "stageDocumentProjection">>;
  readonly viewSessions: ContextViewSessions;
  readonly resolveBackend: (
    runtime: TRuntimeSettings,
    ref: ExecutionContextRef,
  ) => ContextRuntimeBackend<TRuntimeSettings>;
  readonly mcpContextResolver?: McpContextResolver;
  readonly agentResourcesResolver?: AgentResourcesResolver;
  readonly logger: AgentLogger;
}

export const createContextRuntimeActivator = <TRuntimeSettings>(
  options: ContextRuntimeActivatorOptions<TRuntimeSettings>,
): ContextRuntimeActivator<TRuntimeSettings> => ({
  preflight: (request) => preflightContextRuntime(options, request),
  activate: (request) => activateContextRuntime(options, request),
});

const activationLogger = (
  logger: AgentLogger,
  ref: ExecutionContextRef,
  activationId: string | undefined,
): AgentLogger =>
  logger.child({
    agentId: ref.agentId,
    contextKey: encodeExecutionContextRef(ref),
    contextKind: ref.kind,
    ...(activationId ? { activationId } : {}),
  });

async function preflightContextRuntime<TRuntimeSettings>(
  options: ContextRuntimeActivatorOptions<TRuntimeSettings>,
  request: ContextRuntimePreflightRequest<TRuntimeSettings>,
): Promise<void> {
  const logger = activationLogger(
    options.logger,
    request.ref,
    request.activationId,
  );
  const startedAt = performance.now();
  await options.resolveBackend(request.runtime, request.ref).preflight?.({
    ref: request.ref,
    runtime: request.runtime,
    signal: request.signal,
  });
  logger.log("info", "context_activation.preflight_finished", {
    durationMs: Math.round(performance.now() - startedAt),
  });
}

/** Resources one activation acquired so far; a failed activation retires them. */
interface ActivationAcquisitions {
  backendActivation: ContextRuntimeBackendActivation | null;
  viewSession: ContextViewSession | null;
  runtimeViewPrepared: boolean;
  documentProjection: StagedDocumentProjection | null;
  documentProjectionActivated: boolean;
  activationFeatures: ComposedActivationFeatures | null;
}

async function activateContextRuntime<TRuntimeSettings>(
  options: ContextRuntimeActivatorOptions<TRuntimeSettings>,
  request: ContextRuntimeActivationRequest<TRuntimeSettings>,
): Promise<ActivatedContextRuntime> {
  const signal = request.signal ?? new AbortController().signal;
  const runtimeInstanceKey = encodeExecutionContextRef(request.ref);
  const logger = activationLogger(
    options.logger,
    request.ref,
    request.activationId,
  );
  const startedAt = Date.now();
  let stage: ContextActivationStage = "validate";
  let stageStartedAt = performance.now();
  const logStageFinished = () =>
    logger.log("info", "context_activation.stage_finished", {
      stage,
      durationMs: Math.round(performance.now() - stageStartedAt),
      totalDurationMs: Date.now() - startedAt,
      mode: request.mode,
    });
  const enterStage = (next: ContextActivationStage) => {
    logStageFinished();
    stageStartedAt = performance.now();
    stage = next;
  };
  const acquired: ActivationAcquisitions = {
    backendActivation: null,
    viewSession: null,
    runtimeViewPrepared: false,
    documentProjection: null,
    documentProjectionActivated: false,
    activationFeatures: null,
  };
  // Stops early Memory and memory.md work when this activation fails.
  const earlyWorkController = new AbortController();
  // Every Context loads the Agent's effective Skills. Every Context except
  // ordinary Meta is also resolved by TeamHub before activation.
  const ordinaryMeta = request.ref.kind === "meta";
  const contextResolutionRequired = !(
    options.agentResourcesResolver && ordinaryMeta
  );
  logger.log("info", "context_activation.started", {
    mcpContextMode: options.mcpContextResolver ? "resolved" : "disabled",
    mode: request.mode,
    skillCount: request.resources.skills.length,
  });
  try {
    if (request.mode === "resume") {
      requirePreviousSession(request.previousSession);
    }
    signal.throwIfAborted();
    enterStage("activate_backend");
    const backend = options.resolveBackend(request.runtime, request.ref);
    enterStage("preflight_backend");
    const preflight = await backend.preflight?.({
      ref: request.ref,
      runtime: request.runtime,
      signal,
    });
    const compactInstructions = preflight?.compactInstructions === true;
    signal.throwIfAborted();
    // A-class activation features own memory.md resolution and
    // Agent Memory projection. They do not depend on the resource,
    // MCP, or Document steps below, so they start now. The no-op catch
    // keeps an early failure from being unhandled; the await below still
    // surfaces it.
    const earlyWorkSignal = AbortSignal.any([
      signal,
      earlyWorkController.signal,
    ]);
    const activationView: ActivationFeatureView = {
      ref: request.ref,
      runtime: request.runtime,
      agentId: request.ref.agentId,
      actorId: request.actorId,
      tenantId: request.tenantId,
      ...(request.agentType ? { agentType: request.agentType } : {}),
    };
    acquired.activationFeatures = options.features.composeActivation({
      view: activationView,
      logger: (level, event, fields) => logger.log(level, event, fields),
    });
    const featurePreparationPromise = acquired.activationFeatures.prepare({
      signal: earlyWorkSignal,
      newSession:
        request.mode === "start" ||
        runtimeSessionStartsFresh(request.previousSession),
    });
    void featurePreparationPromise.catch(() => undefined);
    const { executionResources, connectedApps } = await resolveActivationInputs(
      {
        options,
        request,
        acquired,
        signal,
        earlyWorkSignal,
        logger,
        enterStage,
        runtimeInstanceKey,
        ordinaryMeta,
        contextResolutionRequired,
      },
    );
    signal.throwIfAborted();
    const featurePreparation = await featurePreparationPromise;
    enterStage("prepare_runtime_view");
    const backendRequest = activationBackendRequest(request, {
      runtimeInstanceKey,
      compactInstructions,
      agent: instructedAgent(
        request,
        featurePreparation.developerInstructions,
        connectedApps,
        compactInstructions,
      ),
      executionResources,
      signal,
      logger,
    });
    const viewPlan = await prepareActivationRuntimeView(
      options,
      request,
      acquired,
      featurePreparation.runtimeViewMappings,
      signal,
      logger,
    );

    enterStage("activate_backend");
    const backendActivation = await backend.activate({
      ...backendRequest,
      viewPlan,
    });
    acquired.backendActivation = backendActivation;
    signal.throwIfAborted();

    enterStage(request.mode === "resume" ? "resume_session" : "create_session");
    const runtimeSession =
      request.mode === "resume"
        ? await backendActivation.provider.resumeSession(
            request.previousSession,
            backendActivation.sessionSpec,
          )
        : await backendActivation.provider.createSession(
            backendActivation.sessionSpec,
          );
    signal.throwIfAborted();
    startAcceptedInputPrepare(
      request,
      backendActivation.provider,
      runtimeSession,
      logger,
    );
    logger.log("info", "context_activation.completed", {
      durationMs: Date.now() - startedAt,
      mode: request.mode,
      runtimeName: backendActivation.runtimeName,
    });
    return createActivatedContextRuntime({
      options,
      request,
      signal,
      logger,
      runtimeInstanceKey,
      contextResolutionRequired,
      ordinaryMeta,
      activationView,
      backend: backendActivation,
      activationFeatures: acquired.activationFeatures,
      featureChecks: featurePreparation.checks,
      viewSession: acquired.viewSession!,
      viewPlan,
      runtimeSession,
      documentProjection: acquired.documentProjection,
      executionResources,
    });
  } catch (error) {
    earlyWorkController.abort();
    throw await retireFailedActivation({
      error,
      stage,
      acquired,
      options,
      ref: request.ref,
      logger,
      startedAt,
    });
  } finally {
    logStageFinished();
  }
}

interface ActivationInputsRequest<TRuntimeSettings> {
  readonly options: ContextRuntimeActivatorOptions<TRuntimeSettings>;
  readonly request: ContextRuntimeActivationRequest<TRuntimeSettings>;
  readonly acquired: ActivationAcquisitions;
  readonly signal: AbortSignal;
  readonly earlyWorkSignal: AbortSignal;
  readonly logger: AgentLogger;
  readonly enterStage: (next: ContextActivationStage) => void;
  readonly runtimeInstanceKey: string;
  readonly ordinaryMeta: boolean;
  readonly contextResolutionRequired: boolean;
}

/**
 * Reads the Agent's effective resources and, when TeamHub must resolve this
 * Context, its MCP Context and Document Comment projection.
 */
async function resolveActivationInputs<TRuntimeSettings>({
  options,
  request,
  acquired,
  signal,
  earlyWorkSignal,
  logger,
  enterStage,
  runtimeInstanceKey,
  ordinaryMeta,
  contextResolutionRequired,
}: ActivationInputsRequest<TRuntimeSettings>): Promise<{
  readonly executionResources: ExecutionResources | undefined;
  readonly connectedApps: boolean | undefined;
}> {
  const agentResourcesResolver = options.agentResourcesResolver;
  const mcpContextResolver = options.mcpContextResolver;
  // Read with the Agent's effective resources; renders the instructions.
  let connectedApps: boolean | undefined;
  const readAgentResources = async (resolveSignal: AbortSignal) => {
    const resourcesResolveStartedAt = performance.now();
    const current = await agentResourcesResolver!.resolve({
      agentId: request.ref.agentId,
      signal: resolveSignal,
    });
    logger.log("info", "context_activation.agent_resources_resolved", {
      durationMs: performance.now() - resourcesResolveStartedAt,
    });
    connectedApps = current.connectedApps;
    return current;
  };
  let executionResources: ExecutionResources | undefined;
  let pendingExecutionResources: Promise<ExecutionResources> | undefined;
  if (agentResourcesResolver && ordinaryMeta) {
    executionResources = currentExecutionResources(
      await readAgentResources(signal),
    );
  } else if (agentResourcesResolver) {
    // Read the Skills while TeamHub resolves the Context.
    pendingExecutionResources = readAgentResources(earlyWorkSignal).then(
      currentExecutionResources,
    );
    void pendingExecutionResources.catch(() => undefined);
  }
  if (mcpContextResolver && contextResolutionRequired) {
    if (!request.checkpointRuntimeSession) {
      throw new Error(
        "Resolved MCP Context requires Runtime Session checkpointing",
      );
    }
    enterStage("resolve_mcp_context");
    const resolution = await mcpContextResolver.resolve({
      ref: request.ref,
      signal,
    });
    logger.log("info", "context_activation.mcp_context_resolved");
    if (request.ref.kind === "document" && resolution.documentCommentRuntime) {
      if (!options.contextHost.stageDocumentProjection) {
        throw new Error(
          "Resolved MCP Context requires Document projection staging",
        );
      }
      enterStage("stage_document_projection");
      acquired.documentProjection =
        await options.contextHost.stageDocumentProjection(
          documentCommentStaging(
            request.ref.agentId,
            runtimeInstanceKey,
            resolution.documentCommentRuntime,
          ),
        );
      await acquired.documentProjection.activate();
      acquired.documentProjectionActivated = true;
    }
  }
  if (pendingExecutionResources) {
    executionResources = await pendingExecutionResources;
  }
  return { executionResources, connectedApps };
}

const currentExecutionResources = (
  current: AgentEffectiveResources,
): ExecutionResources =>
  Object.freeze({
    version: 1 as const,
    effectiveSha256: current.effectiveSha256,
    skills: current.skills,
  });

const documentCommentStaging = (
  agentId: string,
  runtimeInstanceKey: string,
  documentCommentRuntime: DocumentCommentRuntimeProjection,
): Parameters<AgentContextHost["stageDocumentProjection"]>[0] => ({
  agentId,
  runtimeInstanceKey,
  documentComment: {
    commentsMarkdown: documentCommentRuntime.commentsMarkdown,
    currentDocument: documentCommentRuntime.currentDocument,
  },
});

/**
 * The bound instructions render again with this activation's facts; feature
 * instructions follow them.
 */
const instructedAgent = <TRuntimeSettings>(
  request: ContextRuntimeActivationRequest<TRuntimeSettings>,
  featureInstructions: readonly string[],
  connectedApps: boolean | undefined,
  compactInstructions: boolean,
): AgentDefinition => {
  const instructed =
    request.renderDeveloperInstructions &&
    (connectedApps !== undefined || compactInstructions)
      ? request.renderDeveloperInstructions({
          connectedApps: connectedApps ?? true,
          compactInstructions,
        })
      : request.agent.developerInstructions;
  return {
    ...request.agent,
    developerInstructions:
      [instructed, ...featureInstructions].filter(Boolean).join("\n\n") ||
      request.agent.developerInstructions,
  };
};

const activationBackendRequest = <TRuntimeSettings>(
  request: ContextRuntimeActivationRequest<TRuntimeSettings>,
  activation: {
    readonly runtimeInstanceKey: string;
    readonly compactInstructions: boolean;
    readonly agent: AgentDefinition;
    readonly executionResources: ExecutionResources | undefined;
    readonly signal: AbortSignal;
    readonly logger: AgentLogger;
  },
): Omit<ContextRuntimeBackendRequest<TRuntimeSettings>, "viewPlan"> => ({
  ref: request.ref,
  tenantId: request.tenantId,
  actorId: request.actorId,
  runtimeInstanceKey: activation.runtimeInstanceKey,
  ...(request.executionEpoch ? { executionEpoch: request.executionEpoch } : {}),
  ...(request.permissionReview ? { permissionReview: true as const } : {}),
  ...(activation.compactInstructions
    ? { compactInstructions: true as const }
    : {}),
  ...(request.mode === "resume"
    ? { previousSession: request.previousSession }
    : {}),
  agent: activation.agent,
  runtime: request.runtime,
  resources: activation.executionResources
    ? Object.freeze({ skills: activation.executionResources.skills })
    : request.resources,
  signal: activation.signal,
  logger: activation.logger,
});

async function prepareActivationRuntimeView<TRuntimeSettings>(
  options: ContextRuntimeActivatorOptions<TRuntimeSettings>,
  request: ContextRuntimeActivationRequest<TRuntimeSettings>,
  acquired: ActivationAcquisitions,
  featureMappings: RuntimeViewPlan["mappings"],
  signal: AbortSignal,
  logger: AgentLogger,
): Promise<RuntimeViewPlan> {
  const phaseStartedAt = performance.now();
  let baseViewPlan: RuntimeViewPlan;
  try {
    baseViewPlan = await options.contextHost.prepareRuntimeView(
      request.ref,
      request.sharedTaskScope,
    );
  } finally {
    logger.log("info", "context_activation.runtime_view_phase", {
      phase: "prepare_runtime_view",
      durationMs: Math.round(performance.now() - phaseStartedAt),
    });
  }
  acquired.runtimeViewPrepared = true;
  logger.log("debug", "context_activation.runtime_view_prepared", {
    mappingCount: baseViewPlan.mappings.length,
  });
  const viewPlan: RuntimeViewPlan = featureMappings.length
    ? {
        ...baseViewPlan,
        mappings: [...baseViewPlan.mappings, ...featureMappings],
      }
    : baseViewPlan;
  acquired.viewSession = options.viewSessions.open(signal);
  signal.throwIfAborted();
  return viewPlan;
}

/**
 * Only a real accepted input may start a Provider prepare. Fire and forget:
 * the Provider contains its own failures, so activation never waits for or
 * fails on it.
 */
const startAcceptedInputPrepare = <TRuntimeSettings>(
  request: ContextRuntimeActivationRequest<TRuntimeSettings>,
  provider: AgentProvider,
  runtimeSession: RuntimeSession,
  logger: AgentLogger,
): void => {
  const acceptedInputSinceMs = request.acceptedInputSinceMs?.();
  if (acceptedInputSinceMs === undefined) return;
  try {
    provider.prepareForAcceptedInput?.(runtimeSession, {
      acceptedInputSinceMs,
    });
  } catch (error) {
    logger.log("warn", "context_activation.provider_prepare_failed", {
      error,
    });
  }
};

/** Everything one completed activation hands to its live Runtime. */
interface ActiveContextRuntimeScope<TRuntimeSettings> {
  readonly options: ContextRuntimeActivatorOptions<TRuntimeSettings>;
  readonly request: ContextRuntimeActivationRequest<TRuntimeSettings>;
  readonly signal: AbortSignal;
  readonly logger: AgentLogger;
  readonly runtimeInstanceKey: string;
  readonly contextResolutionRequired: boolean;
  readonly ordinaryMeta: boolean;
  readonly activationView: ActivationFeatureView;
  readonly backend: ContextRuntimeBackendActivation;
  readonly activationFeatures: ComposedActivationFeatures | null;
  readonly featureChecks: readonly ((
    signal: AbortSignal,
  ) => Promise<boolean>)[];
  readonly viewSession: ContextViewSession;
  readonly viewPlan: RuntimeViewPlan;
  readonly runtimeSession: RuntimeSession;
  readonly documentProjection: StagedDocumentProjection | null;
  readonly executionResources: ExecutionResources | undefined;
}

/** Mutable state shared by synchronization and deactivation of one Runtime. */
interface ActiveContextRuntimeState {
  documentProjection: StagedDocumentProjection | null;
  synchronizationTail: Promise<void>;
  readonly synchronizationController: AbortController;
  deactivationPromise: Promise<void> | null;
  deactivationSteps:
    | Array<{ run: () => Promise<void>; completed?: boolean }>
    | undefined;
}

function createActivatedContextRuntime<TRuntimeSettings>(
  scope: ActiveContextRuntimeScope<TRuntimeSettings>,
): ActivatedContextRuntime {
  const {
    options,
    request,
    logger,
    backend,
    viewSession,
    executionResources,
    ordinaryMeta,
  } = scope;
  const agentResourcesResolver = options.agentResourcesResolver;
  const state: ActiveContextRuntimeState = {
    documentProjection: scope.documentProjection,
    synchronizationTail: Promise.resolve(),
    synchronizationController: new AbortController(),
    deactivationPromise: null,
    deactivationSteps: undefined,
  };
  const synchronize = (
    callerSignal?: AbortSignal,
    phase: ContextSynchronizationPhase = "before_run",
    executionRunRef?: string,
  ): Promise<void> =>
    synchronizeContextRuntime(
      scope,
      state,
      callerSignal,
      phase,
      executionRunRef,
    );
  // Run features bind THIS activation's backend activation: the
  // composed prepare installs each new Run's Agent CLI credential and
  // per-Run CLI context, and is an identity when no Run feature matched.
  const runFeatures = options.features.composeRun({
    view: scope.activationView,
    backend,
    logger: (level, event, fields) => logger.log(level, event, fields),
  });
  const provider = new SynchronizedContextProvider(
    backend.provider,
    synchronize,
    viewSession.healthSignal,
    logger,
    (input, runSignal) => runFeatures.prepareRunInput(input, runSignal),
  );
  return Object.freeze({
    ref: request.ref,
    provider,
    runtimeName: backend.runtimeName,
    runtimeSession: scope.runtimeSession,
    sessionSpec: backend.sessionSpec,
    ...(executionResources ? { executionResources } : {}),
    ...(agentResourcesResolver && ordinaryMeta && executionResources
      ? {
          async prepareNextRun(nextSignal: AbortSignal): Promise<boolean> {
            const current = await agentResourcesResolver.resolve({
              agentId: request.ref.agentId,
              signal: nextSignal,
            });
            // Feature-owned next-Run checks (e.g. the memory.md refresh)
            // keep their accept-time snapshot as the comparison basis.
            for (const check of scope.featureChecks) {
              if (!(await check(nextSignal))) return false;
            }
            return (
              current.effectiveSha256 === executionResources.effectiveSha256
            );
          },
        }
      : {}),
    setActiveRunContext: (context) => backend.setActiveRunContext(context),
    deactivate: () => deactivateContextRuntime(scope, state),
  }) satisfies ActivatedContextRuntime;
}

function synchronizeContextRuntime<TRuntimeSettings>(
  scope: ActiveContextRuntimeScope<TRuntimeSettings>,
  state: ActiveContextRuntimeState,
  callerSignal: AbortSignal | undefined,
  phase: ContextSynchronizationPhase,
  executionRunRef: string | undefined,
): Promise<void> {
  const { options, logger } = scope;
  const synchronizeSignal = AbortSignal.any([
    scope.signal,
    state.synchronizationController.signal,
    scope.viewSession.healthSignal,
    ...(callerSignal ? [callerSignal] : []),
  ]);
  const enqueuedAt = performance.now();
  const synchronized = state.synchronizationTail
    .catch(() => undefined)
    .then(async () => {
      let stageStartedAt = performance.now();
      const queueMs = Math.round(stageStartedAt - enqueuedAt);
      const startedAtUnixMs = Date.now();
      const stages: Record<string, number> = {};
      const recordStage = (stage: string) => {
        stages[stage] = Math.round(performance.now() - stageStartedAt);
        stageStartedAt = performance.now();
      };
      logger.log("info", "context_runtime.synchronize_started", {
        executionRunRef,
        phase,
        queueMs,
        startedAtUnixMs,
      });
      synchronizeSignal?.throwIfAborted();
      // The Context is re-resolved before a Run, never within one.
      const refreshMcpContext =
        options.mcpContextResolver &&
        scope.contextResolutionRequired &&
        phase === "before_run";
      if (refreshMcpContext) {
        await refreshMcpContextAndSynchronize(
          scope,
          state,
          options.mcpContextResolver,
          synchronizeSignal,
          recordStage,
        );
      } else {
        await scope.backend.synchronize(
          scope.viewPlan,
          synchronizeSignal,
          scope.runtimeSession ?? undefined,
        );
        recordStage("backend_synchronize");
      }
      recordStage("settle");
      const elapsedMs = performance.now() - enqueuedAt;
      logger.log("info", "context_runtime.synchronize_finished", {
        executionRunRef,
        phase,
        queueMs,
        stages,
        elapsedMs: Math.round(elapsedMs),
        startedAtUnixMs,
        finishedAtUnixMs: Date.now(),
      });
    });
  state.synchronizationTail = synchronized.then(
    () => undefined,
    () => undefined,
  );
  return synchronized;
}

/**
 * Re-resolves the MCP Context and swaps in its new Document Comment
 * projection; on failure the previous projection is restored before the
 * refresh error fails the Run.
 */
async function refreshMcpContextAndSynchronize<TRuntimeSettings>(
  scope: ActiveContextRuntimeScope<TRuntimeSettings>,
  state: ActiveContextRuntimeState,
  mcpContextResolver: McpContextResolver,
  synchronizeSignal: AbortSignal,
  recordStage: (stage: string) => void,
): Promise<void> {
  const { options, request, backend, viewPlan } = scope;
  const runtimeSession = scope.runtimeSession ?? undefined;
  const previousProjection = state.documentProjection;
  state.documentProjection = null;
  let nextProjection: StagedDocumentProjection | null = null;
  let nextProjectionActivated = false;
  try {
    const resolution = await mcpContextResolver.resolve({
      ref: request.ref,
      signal: synchronizeSignal,
    });
    recordStage("mcp_resolve");
    if (request.ref.kind === "document" && resolution.documentCommentRuntime) {
      if (!options.contextHost.stageDocumentProjection) {
        throw new Error(
          "Resolved MCP Context requires Document projection staging",
        );
      }
      nextProjection = await options.contextHost.stageDocumentProjection(
        documentCommentStaging(
          request.ref.agentId,
          scope.runtimeInstanceKey,
          resolution.documentCommentRuntime,
        ),
      );
      await nextProjection.activate();
      nextProjectionActivated = true;
    }
    recordStage("document_prepare");
    await backend.synchronize(viewPlan, synchronizeSignal, runtimeSession);
    recordStage("backend_synchronize");
    synchronizeSignal.throwIfAborted();
    state.documentProjection = nextProjection;
  } catch (error) {
    if (previousProjection) {
      await previousProjection.activate().catch(() => undefined);
      try {
        await backend.synchronize(viewPlan, synchronizeSignal, runtimeSession);
      } catch {
        // The refresh error below still fails this Run.
      }
    }
    if (nextProjection) {
      await (
        nextProjectionActivated
          ? nextProjection.release()
          : nextProjection.discard()
      ).catch(() => undefined);
    }
    await previousProjection?.release().catch(() => undefined);
    throw safeMcpContextError(error, "Resolved MCP Context refresh failed");
  }
  await previousProjection?.release().catch(() => undefined);
  scope.logger.log("debug", "context_runtime.mcp_context_refreshed");
}

function deactivateContextRuntime<TRuntimeSettings>(
  scope: ActiveContextRuntimeScope<TRuntimeSettings>,
  state: ActiveContextRuntimeState,
): Promise<void> {
  const { options, request, logger, backend, viewSession } = scope;
  const protectsMcpContextCredentials =
    options.mcpContextResolver !== undefined;
  if (!state.deactivationPromise) {
    const deactivationStartedAt = Date.now();
    logger.log("info", "context_deactivation.started", {
      continuingCleanup: state.deactivationSteps !== undefined,
    });
    if (!state.deactivationSteps) {
      const projectionToRelease = state.documentProjection;
      state.documentProjection = null;
      state.synchronizationController.abort(
        new Error("Context Runtime is deactivating"),
      );
      state.deactivationSteps = [
        () => backend.deactivate(),
        async () => viewSession.release(),
        ...(projectionToRelease ? [() => projectionToRelease.release()] : []),
        () => scope.activationFeatures?.release() ?? Promise.resolve(),
        () => options.contextHost.releaseRuntimeView(request.ref),
      ].map((run) => ({ run }));
    }
    const deactivationSteps = state.deactivationSteps;
    state.deactivationPromise = Promise.allSettled([state.synchronizationTail])
      .then(async () => {
        const failures: unknown[] = [];
        for (const step of deactivationSteps) {
          if (step.completed) continue;
          try {
            await step.run();
            step.completed = true;
          } catch (error) {
            failures.push(
              protectsMcpContextCredentials
                ? safeMcpContextError(
                    error,
                    "Resolved MCP Context deactivation failed",
                  )
                : error,
            );
          }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
          throw new AggregateError(
            failures,
            "Context Runtime deactivation failed",
          );
        }
      })
      .then(
        () => {
          logger.log("info", "context_deactivation.completed", {
            durationMs: Date.now() - deactivationStartedAt,
          });
        },
        (error: unknown) => {
          logger.log("error", "context_deactivation.failed", {
            durationMs: Date.now() - deactivationStartedAt,
            error,
          });
          if (!isUnconfirmedContextRuntimeCleanup(error))
            state.deactivationPromise = null;
          throw error;
        },
      );
  }
  return state.deactivationPromise;
}

/**
 * Retires every resource a failed activation acquired and returns the error
 * the activation throws.
 */
async function retireFailedActivation<TRuntimeSettings>({
  error,
  stage,
  acquired,
  options,
  ref,
  logger,
  startedAt,
}: {
  readonly error: unknown;
  readonly stage: ContextActivationStage;
  readonly acquired: ActivationAcquisitions;
  readonly options: ContextRuntimeActivatorOptions<TRuntimeSettings>;
  readonly ref: ExecutionContextRef;
  readonly logger: AgentLogger;
  readonly startedAt: number;
}): Promise<unknown> {
  const protectsMcpContextCredentials =
    options.mcpContextResolver !== undefined;
  const safeActivationError = protectsMcpContextCredentials
    ? safeMcpContextError(
        error,
        "Resolved MCP Context Runtime activation failed",
      )
    : error;
  const activationError =
    stage === "prepare_runtime_view"
      ? new ContextActivationError(stage, safeActivationError)
      : safeActivationError;
  let failure: unknown = activationError;
  let cleanupErrorCount = 0;
  if (acquired.backendActivation) {
    try {
      await acquired.backendActivation.deactivate();
    } catch (cleanupError) {
      const cleanupErrors =
        cleanupError instanceof AggregateError
          ? cleanupError.errors
          : [cleanupError];
      cleanupErrorCount += cleanupErrors.length;
      failure = new AggregateError(
        [
          failure,
          ...cleanupErrors.map((cleanupError) =>
            protectsMcpContextCredentials
              ? safeMcpContextError(
                  cleanupError,
                  "Resolved MCP Context Runtime cleanup failed",
                )
              : cleanupError,
          ),
        ],
        "Context Runtime activation failed",
      );
    }
  }
  if (acquired.activationFeatures) {
    try {
      await acquired.activationFeatures.release();
    } catch (cleanupError) {
      cleanupErrorCount += 1;
      failure = new AggregateError(
        [failure, cleanupError],
        "Context Runtime activation failed",
      );
    }
  }
  acquired.viewSession?.release();
  if (acquired.documentProjection) {
    try {
      if (acquired.documentProjectionActivated) {
        await acquired.documentProjection.release();
      } else {
        await acquired.documentProjection.discard();
      }
    } catch (cleanupError) {
      cleanupErrorCount += 1;
      failure = new AggregateError(
        [failure, cleanupError],
        "Context Runtime activation failed",
      );
    }
  }
  if (acquired.runtimeViewPrepared) {
    try {
      await options.contextHost.releaseRuntimeView(ref);
    } catch (cleanupError) {
      cleanupErrorCount += 1;
      const safeCleanupError = protectsMcpContextCredentials
        ? safeMcpContextError(
            cleanupError,
            "Resolved MCP Context Runtime view cleanup failed",
          )
        : cleanupError;
      failure = new AggregateError(
        [failure, safeCleanupError],
        "Context Runtime activation failed",
      );
      logger.log("warn", "context_activation.runtime_view_release_failed", {
        error: safeCleanupError,
      });
    }
  }
  // Keep cleanup classification after credential sanitization. An aborted
  // activation is benign only when every acquired resource was retired.
  if (cleanupErrorCount > 0 || error instanceof ContextRuntimeCleanupError)
    failure = new ContextRuntimeCleanupError(
      failure instanceof AggregateError ? failure.errors : [failure],
    );
  const waitingForComputer =
    cleanupErrorCount === 0 && isLocalComputerOfflineError(failure);
  const ownsFailureAlert = waitingForComputer
    ? false
    : claimAgentFailureAlert(failure);
  logger.log(
    waitingForComputer ? "info" : ownsFailureAlert ? "error" : "warn",
    waitingForComputer
      ? "context_activation.waiting_for_computer"
      : "context_activation.failed",
    {
      cleanupErrorCount,
      durationMs: Date.now() - startedAt,
      error: activationError,
      ...(waitingForComputer
        ? {}
        : {
            ...(ownsFailureAlert ? {} : { alertAggregated: true }),
            failureCode: contextActivationFailureCode(stage),
          }),
      stage,
    },
  );
  return failure;
}

const contextActivationFailureCode = (stage: ContextActivationStage): string =>
  `CONTEXT_ACTIVATION_${stage.toUpperCase()}_FAILED`;

/** No Provider input was sent; the executor can defer this steer to a later Run. */
class SteerAdmissionDeferredError extends Error {
  readonly effect = "definitely_not_applied";

  constructor(cause: LocalRuntimeAdmissionUnavailableError) {
    super("Local Runtime admission diagnostic is unavailable during steer", {
      cause,
    });
    this.name = "SteerAdmissionDeferredError";
  }
}

type ContextSynchronizationPhase = "before_run" | "within_run";

class SynchronizedContextProvider implements AgentProvider {
  readonly #provider: AgentProvider;
  readonly #synchronize: (
    signal?: AbortSignal,
    phase?: ContextSynchronizationPhase,
    executionRunRef?: string,
  ) => Promise<void>;
  readonly clearRunResources?: (session: RuntimeSession) => Promise<void>;
  readonly inspectHistory?: NonNullable<AgentProvider["inspectHistory"]>;
  readonly compactSession?: NonNullable<AgentProvider["compactSession"]>;
  readonly #healthSignal: AbortSignal;
  readonly #logger: AgentLogger;
  readonly #prepareRunInput: NonNullable<
    ContextRuntimeBackendActivation["prepareRunInput"]
  >;
  readonly #sourceRuns = new WeakMap<AgentRun, AgentRun>();
  readonly #runGuards = new WeakMap<AgentRun, InterruptibleRun>();
  #steerTail: Promise<void> = Promise.resolve();

  readonly acquireRunCapacity?: (signal: AbortSignal) => Promise<() => void>;

  constructor(
    provider: AgentProvider,
    synchronize: (
      signal?: AbortSignal,
      phase?: ContextSynchronizationPhase,
      executionRunRef?: string,
    ) => Promise<void>,
    healthSignal: AbortSignal,
    logger: AgentLogger,
    prepareRunInput: NonNullable<
      ContextRuntimeBackendActivation["prepareRunInput"]
    >,
  ) {
    this.#provider = provider;
    if (provider.acquireRunCapacity)
      this.acquireRunCapacity = provider.acquireRunCapacity.bind(provider);
    this.#synchronize = synchronize;
    this.#healthSignal = healthSignal;
    this.#logger = logger;
    this.#prepareRunInput = prepareRunInput;
    if (provider.clearRunResources) {
      this.clearRunResources = (session) =>
        provider.clearRunResources!(session);
    }
    if (provider.inspectHistory) {
      this.inspectHistory = async (session, options) => {
        options.signal?.throwIfAborted();
        this.#healthSignal.throwIfAborted();
        const history = await provider.inspectHistory!(session, options);
        options.signal?.throwIfAborted();
        this.#healthSignal.throwIfAborted();
        return history;
      };
    }
    if (provider.compactSession) {
      this.compactSession = async (session, options) => {
        this.#healthSignal.throwIfAborted();
        const result = await provider.compactSession!(session, {
          ...options,
          signal: AbortSignal.any([options.signal, this.#healthSignal]),
        });
        this.#healthSignal.throwIfAborted();
        return result;
      };
    }
  }

  prepareForPresence(session: RuntimeSession): void {
    if (!this.#healthSignal.aborted)
      this.#provider.prepareForPresence?.(session);
  }

  async createSession(
    options: ProviderSessionOptions,
  ): Promise<RuntimeSession> {
    this.#healthSignal.throwIfAborted();
    const session = await this.#provider.createSession(options);
    this.#healthSignal.throwIfAborted();
    return session;
  }

  async resumeSession(
    session: RuntimeSession,
    options: ProviderSessionOptions,
  ): Promise<RuntimeSession> {
    this.#healthSignal.throwIfAborted();
    const resumed = await this.#provider.resumeSession(session, options);
    this.#healthSignal.throwIfAborted();
    return resumed;
  }

  async startRun(
    session: RuntimeSession,
    input: AgentInput,
    spec: ExecutionSpec,
  ): Promise<AgentRun> {
    let preparedInput = input;
    try {
      await this.#synchronize(
        spec.signal,
        "before_run",
        spec.runContext?.executionRunRef,
      );
      spec.signal?.throwIfAborted();
      this.#healthSignal.throwIfAborted();
      preparedInput = await this.#prepareRunInput(
        preparedInput,
        AbortSignal.any([
          this.#healthSignal,
          ...(spec.signal ? [spec.signal] : []),
        ]),
      );
      spec.signal?.throwIfAborted();
      this.#healthSignal.throwIfAborted();
    } catch (error) {
      if (spec.signal?.aborted) throw error;
      if (
        error instanceof LocalRuntimeAdmissionUnavailableError &&
        !this.#healthSignal.aborted
      ) {
        throw new ProviderRunAdmissionUnavailableError({ cause: error });
      }
      throw new ProviderRunStartError(
        "definitely_not_started",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
    const run = await this.#provider.startRun(session, preparedInput, spec);
    const runGuard = new InterruptibleRun(run);
    const healthSignal = this.#healthSignal;
    const onHealthFailure = () => run.cancel();
    healthSignal.addEventListener("abort", onHealthFailure, { once: true });
    if (healthSignal.aborted) onHealthFailure();
    const synchronizedRun = Object.freeze({
      ...(run.respond
        ? {
            respond: async (
              operationId: string,
              requestId: string,
              payload: Record<string, unknown>,
            ) => {
              healthSignal.throwIfAborted();
              await run.respond!(operationId, requestId, payload);
            },
          }
        : {}),
      ...(run.processReused === undefined
        ? {}
        : { processReused: run.processReused }),
      ...(run.dispatchedAtUnixMs === undefined
        ? {}
        : { dispatchedAtUnixMs: run.dispatchedAtUnixMs }),
      events: run.events,
      async wait() {
        try {
          return await runGuard.wait();
        } finally {
          healthSignal.removeEventListener("abort", onHealthFailure);
        }
      },
      cancel: () => {
        healthSignal.removeEventListener("abort", onHealthFailure);
        run.cancel();
      },
    });
    this.#sourceRuns.set(synchronizedRun, run);
    this.#runGuards.set(synchronizedRun, runGuard);
    return synchronizedRun;
  }

  async steer(
    run: AgentRun,
    options: ProviderSteerOptions,
  ): Promise<ProviderSteerAck> {
    const enqueuedAt = performance.now();
    const steer = this.#steerTail
      .catch(() => undefined)
      .then(async () => {
        const sourceRun = this.#sourceRuns.get(run) ?? run;
        const runGuard = this.#runGuards.get(run);
        const preparedInput = options.input;
        try {
          await this.#synchronize(
            options.signal,
            "within_run",
            options.runContext?.executionRunRef,
          );
          options.signal?.throwIfAborted();
          this.#healthSignal.throwIfAborted();
        } catch (error) {
          // The daemon's new-Run diagnostic can fail while this Turn remains
          // healthy. The input has not reached the Provider yet: defer it,
          // without cancelling the active Run. Real fences and other
          // synchronization errors still interrupt as before.
          if (
            error instanceof LocalRuntimeAdmissionUnavailableError &&
            runGuard &&
            !this.#healthSignal.aborted &&
            !options.signal?.aborted
          ) {
            throw new SteerAdmissionDeferredError(error);
          }
          if (runGuard) runGuard.interrupt();
          else sourceRun.cancel();
          throw error;
        }
        return this.#provider.steer(sourceRun, {
          ...options,
          input: preparedInput,
        });
      });
    this.#steerTail = steer.then(
      () => undefined,
      () => undefined,
    );
    const recordOutcome = (outcome: "accepted" | "rejected") =>
      this.#logger.log("info", "context_runtime.steer_admission_finished", {
        executionRunRef: options.runContext?.executionRunRef,
        elapsedMs: Math.round(performance.now() - enqueuedAt),
        outcome,
      });
    return steer.then(
      (ack) => {
        recordOutcome("accepted");
        return ack;
      },
      (error: unknown) => {
        recordOutcome("rejected");
        throw error;
      },
    );
  }

  close(): Promise<void> {
    return this.#provider.close();
  }
}

/** Reports a Run cancelled by a failed steer synchronization as interrupted. */
class InterruptibleRun {
  readonly #run: AgentRun;
  #interrupted = false;

  constructor(run: AgentRun) {
    this.#run = run;
  }

  interrupt(): void {
    if (this.#interrupted) return;
    this.#interrupted = true;
    try {
      this.#run.cancel();
    } catch {
      // The interruption owns the terminal error; provider cancellation is best effort.
    }
  }

  async wait() {
    try {
      const result = await this.#run.wait();
      if (this.#interrupted) throw interruptedRun();
      return result;
    } catch (error) {
      if (this.#interrupted) throw interruptedRun();
      throw error;
    }
  }
}

const interruptedRun = (): ProviderRunInterruptedError =>
  new ProviderRunInterruptedError(
    "Provider Run was interrupted because Context synchronization failed",
  );

const requirePreviousSession = (session: RuntimeSession): RuntimeSession => {
  if (session === undefined || session === null) {
    throw new TypeError("Context Runtime resume requires a previous Session");
  }
  return session;
};

const safeMcpContextError = (error: unknown, message: string): unknown =>
  containsMcpContextCredential(error) ? new Error(message) : error;

const containsMcpContextCredential = (value: unknown): boolean => {
  const seen = new Set<object>();
  const visit = (current: unknown): boolean => {
    if (typeof current === "string") {
      return /(?:mcp_ctx_|cli_ctx_)[A-Za-z0-9_-]{43}/u.test(current);
    }
    if (typeof current !== "object" || current === null || seen.has(current)) {
      return false;
    }
    seen.add(current);
    if (Array.isArray(current)) return current.some(visit);
    for (const property of Object.getOwnPropertyNames(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, property);
      if (descriptor && "value" in descriptor && visit(descriptor.value)) {
        return true;
      }
    }
    return false;
  };
  return visit(value);
};
