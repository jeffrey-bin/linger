import type {
  AgentCapability,
  AgentType,
  ResolvedAgentIdentity,
  LocalTurnTerminal,
  AgentDefinition,
  Message,
} from "../executor/types.js";
import type { RuntimeViewMapping } from "../executor/workspace.js";
import type {
  ExecutionContextRef,
  MetaRoomKind,
} from "../executor/context-ref.js";
import type { CanonicalInboxMessage } from "./inbox-source/types.js";
import type { AgentInput, RunEvent } from "../executor/provider.js";
import type { RuntimeStatusUpdate } from "../executor/runtime-status.js";

/** A type that may be returned directly or as a Promise. */
export type MaybePromise<T> = T | Promise<T>;

/**
 * Feature lifecycle scopes. "context" features live and die with one
 * ManagedContext instance, "activation" features with one Runtime activation,
 * and "run" features describe each Run-input preparation inside an activation.
 */
export type FeatureScope = "context" | "activation" | "run";

/**
 * Deterministic matching dimensions over trusted identity/config facts.
 * AND across dimensions, OR inside a dimension; an omitted dimension matches
 * everything. An empty array is invalid because it can never match and
 * usually means a wiring mistake.
 */
export interface FeatureMatch {
  readonly agentTypes?: readonly AgentType[];
  readonly contextKinds?: readonly ExecutionContextRef["kind"][];
  /**
   * Deployment capabilities from the Agent Runtime configuration. Only
   * Context-scope features may declare it.
   */
  readonly capabilities?: readonly AgentCapability[];
}

/**
 * Ordering and dependency metadata declared on one port binding. `after` only
 * orders handlers that declare the same port in the same scope; `requires`
 * declares membership dependencies that must be matched whenever this feature
 * is matched in that scope.
 */
export interface FeaturePortOrder {
  readonly after?: readonly string[];
  readonly requires?: readonly string[];
}

export type FeaturePortMap<H> = Partial<
  Record<keyof H & string, FeaturePortOrder>
>;

/**
 * Read-only Context facts visible to every feature: identity, trusted
 * configuration, and lifecycle-relevant flags only. Capabilities never live
 * on this view — submitting features use the bound FeatureContext passed to
 * their handlers, source capabilities are bound inside feature factories.
 */
export interface FeatureContextView {
  readonly ref: Readonly<ExecutionContextRef>;
  readonly configurationRevision: string;
  readonly runtime: unknown;
  readonly identity: Readonly<ResolvedAgentIdentity>;
  readonly tenantId: string;
  readonly actorId: string;
  readonly agentName: string;
  readonly agent: Readonly<AgentDefinition>;
  readonly roomKind?: MetaRoomKind;
  /** Deployment capabilities from the Agent Runtime configuration. */
  readonly capabilities: readonly AgentCapability[];
}

/**
 * Facts TeamHub reports with the Agent's effective resources, read again for
 * every Runtime activation, so a change reaches the next Run's instructions
 * without rebuilding the Context.
 */
export interface ContextInstructionFacts {
  /** TeamHub has a Composio API key now, so the connected app commands work. */
  readonly connectedApps: boolean;
  /**
   * The placed Runtime model's context window is at most 128K tokens, so
   * every section uses its compact version.
   */
  readonly compactInstructions: boolean;
}

/**
 * The bound Context instance as seen by feature handlers that must not
 * submit work: identity/config view plus invalidation. Runtime suspend keeps
 * this signal; Context release/replacement aborts it.
 */
export interface BoundFeatureContext extends FeatureContextView {
  readonly signal: AbortSignal;
}

/** Optional feature-owned validity check evaluated at the submission fence. */
export interface FeatureSubmitOptions {
  readonly canSubmit?: () => boolean;
}

/**
 * Result of a trusted feature submission. "skipped" means the final boundary
 * rejected it without side effects; authoritative errors propagate as throws.
 * "accepted" means durable acceptance, not that a model consumed the input.
 */
export type FeatureSubmitResult =
  | { readonly status: "accepted" }
  | { readonly status: "already_accepted" }
  | { readonly status: "skipped"; readonly reason: string };

/**
 * FeatureContext bound to one ManagedContext instance. It is invalidated when
 * that instance is released or replaced; submissions against an invalidated
 * or superseded instance resolve as skipped instead of reaching the new
 * instance. Only the `afterInboxInputAccepted` and `onTimer` ports receive
 * this full form.
 */
export interface FeatureContext extends BoundFeatureContext {
  /** Active Run of the bound Context instance only. */
  activeRunId(): string | undefined;
  /** Steer a trusted message into a specific active Run of this instance. */
  steer(
    runId: string,
    message: Message,
    options?: FeatureSubmitOptions,
  ): Promise<FeatureSubmitResult>;
  /** Submit a trusted follow-up turn on behalf of this instance. */
  followUp(
    message: Message,
    options?: FeatureSubmitOptions,
  ): Promise<FeatureSubmitResult>;
}

/** A Context-authorized source handle returned by onContextBound. */
export interface ContextBoundSource {
  stop(): Promise<void>;
}

/** How this Context instance was materialized. */
export type ContextBootstrap = "new" | "restored";

/**
 * Read-only lifecycle facts for this Context materialization. No
 * feature-owned products or capabilities — those are bound inside each
 * feature factory at assembly time.
 */
export interface ContextBoundInput {
  readonly bootstrap: ContextBootstrap;
}

export interface NotificationContextMessage {
  readonly teamProtocol?: string;
}

export interface NotificationContextInput {
  readonly inboxId: string;
  readonly messages: readonly NotificationContextMessage[];
}

/** A text contribution applied to one formatted Runtime input message. */
export interface FeatureInputContribution {
  readonly text: string;
}

/**
 * One TeamHub Inbox input this Context took up: a Run it claimed or a steer
 * it handed to the running Run. TeamHub queued it with the Message.
 */
export interface AcceptedInboxFact {
  readonly inboxId: string;
  /** Stable input identity of the queued Inbox input. */
  readonly inputId: string;
  readonly targeted: boolean;
  readonly dispatch?:
    | { readonly kind: "enqueue"; readonly runId: string }
    | { readonly kind: "steer"; readonly groupId: string };
  readonly messages?: readonly CanonicalInboxMessage[];
}

export interface RunTerminalEvent {
  readonly runId: string;
  readonly terminal: LocalTurnTerminal;
}

/** One maintenance action the core may run on an idle Context. */
export interface CompactMaintenanceAction {
  readonly kind: "compact";
  /** Short reason for logs and feature bookkeeping. */
  readonly reason: string;
  /** Extra keep-requirements appended to the native compaction prompt. */
  readonly instructions?: string;
}

export type MaintenanceAction = CompactMaintenanceAction;

/** Where the core asked for a maintenance decision. */
export type MaintenanceTrigger =
  | { readonly kind: "idle_suspend" }
  | { readonly kind: "timer"; readonly name: string };

/**
 * `unavailable`: the Computer is offline or its Runtime cannot compact.
 * `input_arrived`: new work preempted the action; history is unchanged.
 */
export type MaintenanceSkipReason =
  | "busy"
  | "input_arrived"
  | "unavailable"
  | "nothing_to_compact";

export type MaintenanceOutcome =
  | { readonly status: "completed" }
  | { readonly status: "skipped"; readonly reason: MaintenanceSkipReason }
  | { readonly status: "failed"; readonly error: unknown };

/**
 * Lifecycle of one maintenance action. `started` is observed before the core
 * touches the Runtime; `finished` carries the outcome, including skips.
 */
export type MaintenanceEvent =
  | {
      readonly phase: "started";
      readonly trigger: MaintenanceTrigger;
      readonly action: MaintenanceAction;
    }
  | {
      readonly phase: "finished";
      readonly trigger: MaintenanceTrigger;
      readonly action: MaintenanceAction;
      readonly outcome: MaintenanceOutcome;
    };

/**
 * Context-scope ports. Handlers run in deterministic declared order. Pure
 * contribution ports receive only FeatureContextView; `afterInboxInputAccepted`
 * and `onTimer` are the only submission-capable ports.
 */
export interface ContextFeatureHandlers {
  /**
   * Installs Context-authorized sources. Runs during Context materialization
   * in declared order; on failure already-bound sources of this composition
   * stop in reverse order exactly once.
   */
  onContextBound?(
    context: BoundFeatureContext,
    input: ContextBoundInput,
  ): MaybePromise<ContextBoundSource | void>;
  /**
   * Pure contribution to the Context developer instructions. It runs again at
   * every Runtime activation with that activation's facts.
   */
  contributeContextInstructions?(
    view: FeatureContextView,
    facts: ContextInstructionFacts,
  ): string | undefined;
  /** Pure contribution to notification prompt context (first render + replay). */
  contributeNotificationContext?(
    view: FeatureContextView,
    input: NotificationContextInput,
  ): readonly string[];
  /**
   * Pure text contribution for one input message. Every handler reads the
   * same original message; contributions merge in declared order afterwards.
   */
  prepareInput?(
    view: FeatureContextView,
    message: Message,
  ): FeatureInputContribution | null;
  /**
   * Synchronous observation of one Inbox input this Context took up; it may
   * submit follow-up work. Errors are isolated per feature; background work
   * stays owned by the feature.
   */
  afterInboxInputAccepted?(
    context: FeatureContext,
    fact: AcceptedInboxFact,
  ): void;
  /**
   * One FeatureTimers timer of this instance fired; every feature sees every
   * name and acts only on the names it set. It may submit work; errors are
   * isolated per feature and background work stays owned by the feature.
   */
  onTimer?(context: FeatureContext, name: string): void;
  /**
   * Observation of one durable Run terminal; errors isolated per feature.
   * Still dispatched while the Context is stopping so terminal forwarding
   * during shutdown is preserved.
   */
  onRunTerminal?(context: BoundFeatureContext, event: RunTerminalEvent): void;
  /** Per-provider-Run-event status projection; errors isolated per feature. */
  onRunEvent?(
    view: FeatureContextView,
    event: RunEvent,
  ): RuntimeStatusUpdate | null;
  /**
   * Pure, synchronous maintenance decision; the first non-null decision in
   * declared order wins. A feature answers a timer trigger only for timer
   * names it registered. The core executes the action and checks idleness
   * itself.
   */
  decideMaintenance?(
    view: FeatureContextView,
    trigger: MaintenanceTrigger,
  ): MaintenanceAction | null;
  /** Observation of one maintenance action; errors isolated per feature. */
  onMaintenance?(context: BoundFeatureContext, event: MaintenanceEvent): void;
}

/** Facts available during one Runtime activation. */
export interface RuntimePreparationInput {
  readonly signal: AbortSignal;
  /** The next Run starts the native conversation; absent means it continues one. */
  readonly newSession?: boolean;
}

/** One feature's contribution to Runtime activation. */
export interface RuntimePreparation {
  /**
   * Developer instructions fixed at activation, so the Runtime prefix stays
   * stable until the next activation.
   */
  readonly developerInstructions?: string;
  /** Extra Runtime View mappings appended to the fallback plan. */
  readonly runtimeViewMappings?: readonly RuntimeViewMapping[];
  /** Revalidate this contribution before claiming a new ordinary Run. */
  checkNextRun?(signal: AbortSignal): Promise<boolean>;
  /** Release activation-scoped resources on deactivation or failure. */
  release?(): Promise<void>;
}

export interface ActivationFeatureHandlers {
  prepareRuntime?(
    view: ActivationFeatureView,
    input: RuntimePreparationInput,
  ): Promise<RuntimePreparation>;
}

/** Facts available to activation/run-scoped features. */
export interface ActivationFeatureView {
  readonly ref: Readonly<ExecutionContextRef>;
  readonly runtime: unknown;
  readonly agentId: string;
  readonly actorId: string;
  readonly tenantId: string;
  /**
   * Trusted Agent type for matching. Required whenever any catalog feature
   * in this scope declares an `agentTypes` match.
   */
  readonly agentType?: AgentType;
}

export interface RunFeatureHandlers {
  /** Prepares one new Run's input before the model sees it. Sequential composition. */
  prepareRunInput?(
    view: ActivationFeatureView,
    input: AgentInput,
    signal: AbortSignal,
  ): Promise<AgentInput>;
}

export interface FeatureScopeHandlers {
  readonly context: ContextFeatureHandlers;
  readonly activation: ActivationFeatureHandlers;
  readonly run: RunFeatureHandlers;
}

/**
 * Declarative feature definition. Feature modules expose factories that bind
 * their own narrow dependencies and return this declaration; `create` only
 * assembles handlers — source registration, network calls, and resource
 * acquisition happen in the ports.
 */
export interface FeatureDeclaration {
  /** Stable identity used by ordering, diagnostics, and duplicate checks. */
  readonly id: string;
  readonly match?: FeatureMatch;
  readonly context?: {
    readonly ports: FeaturePortMap<ContextFeatureHandlers>;
    create(context: BoundFeatureContext): ContextFeatureHandlers;
  };
  readonly activation?: {
    readonly ports: FeaturePortMap<ActivationFeatureHandlers>;
    create(view: ActivationFeatureView): ActivationFeatureHandlers;
  };
  readonly run?: {
    readonly ports: FeaturePortMap<RunFeatureHandlers>;
    create(view: ActivationFeatureView): RunFeatureHandlers;
  };
}

export const defineFeature = (
  feature: FeatureDeclaration,
): FeatureDeclaration => feature;
