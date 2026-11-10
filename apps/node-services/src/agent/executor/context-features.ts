import type { ComposedContextFeatures } from "../agent-features/compose.js";
import type { BuiltinAgentFeatures } from "../agent-features/builtin.js";
import type { BuiltinFeatureHost } from "../agent-features/host-ports.js";
import type { RunWakeKind } from "../agent-features/inbox-source/types.js";
import type {
  BoundFeatureContext,
  ContextInstructionFacts,
  FeatureContext,
  FeatureSubmitOptions,
  FeatureSubmitResult,
} from "../agent-features/contracts.js";
import type { AgentLogger } from "../observability/agent-log.js";
import { AgentManagerError } from "./agent-manager-api.js";
import type {
  ExecutionContextRecord,
  ExecutionContextRef,
  MetaRoomKind,
} from "./context-ref.js";
import type { Ghost } from "./ghost.js";
import type {
  ActorId,
  AgentDefinition,
  Message,
  ResolvedAgentIdentity,
} from "./types.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** What the composed Context features may reach of their executor. */
export interface ContextFeatureBinding {
  /** Aborted before feature release so late submissions skip deterministically. */
  readonly signal: AbortSignal;
  /** The executor is bound: still the instance its sources deliver into. */
  isBound(): boolean;
  activeRunId(): string | undefined;
  steer(
    runId: string,
    message: Message,
    options?: FeatureSubmitOptions,
  ): Promise<FeatureSubmitResult>;
  followUp(
    message: Message,
    options?: FeatureSubmitOptions,
  ): Promise<FeatureSubmitResult>;
  takeUpQueuedInput(kind: RunWakeKind): Promise<void>;
  /** A feature timer fired on the bound executor. */
  onTimer(name: string): void;
  trackBackground(
    operation: Promise<unknown>,
    ref: ExecutionContextRef,
    event: string,
    fields?: Readonly<Record<string, unknown>>,
  ): void;
}

/**
 * Composes the Context features of one executor. Host callbacks reach only
 * this executor: each revalidates the BoundFeatureContext against the
 * executor's feature signal instead of a ref lookup, so a stale source can
 * never deliver into a same-ref successor. Feature timers die with the
 * feature signal, never with a Runtime suspend.
 */
export function composeExecutorFeatures(input: {
  readonly record: ExecutionContextRecord;
  readonly ghost: Readonly<Ghost<unknown>> & { readonly actorId: ActorId };
  readonly identity: ResolvedAgentIdentity;
  readonly binding: ContextFeatureBinding;
  readonly features: Pick<BuiltinAgentFeatures, "composeContext">;
  readonly logger: AgentLogger;
}): ComposedContextFeatures {
  const { record, ghost, binding } = input;
  const featureTimers = new Map<string, ReturnType<typeof setTimeout>>();
  binding.signal.addEventListener(
    "abort",
    () => {
      for (const timer of featureTimers.values()) clearTimeout(timer);
      featureTimers.clear();
    },
    { once: true },
  );
  const featureContext: FeatureContext = {
    ref: Object.freeze({ ...record.ref }),
    configurationRevision: ghost.revision,
    runtime: ghost.runtime,
    identity: input.identity,
    tenantId: ghost.tenantId,
    actorId: ghost.actorId,
    agentName: ghost.agent.name,
    agent: ghost.agent,
    ...(record.roomKind !== undefined ? { roomKind: record.roomKind } : {}),
    capabilities: ghost.permissionReview ? ["permissionReview"] : [],
    signal: binding.signal,
    activeRunId: () => binding.activeRunId(),
    steer: (runId, message, options) => binding.steer(runId, message, options),
    followUp: (message, options) => binding.followUp(message, options),
  };
  const bound = (context: BoundFeatureContext): boolean =>
    context.signal === binding.signal &&
    !context.signal.aborted &&
    binding.isBound();
  const host: BuiltinFeatureHost = {
    inbox: {
      takeUpQueuedInput: (context, kind) => {
        if (!bound(context)) return;
        binding.trackBackground(
          binding.takeUpQueuedInput(kind),
          record.ref,
          "activation.after_queued_input_failed",
          { kind },
        );
      },
    },
    trackBackground: (operation, ref, event) =>
      binding.trackBackground(operation, ref, event),
    timers: {
      set: (context, name, dueAtMs) => {
        if (context.signal !== binding.signal || context.signal.aborted) return;
        clearTimeout(featureTimers.get(name));
        const timer = setTimeout(
          () => {
            featureTimers.delete(name);
            if (bound(context)) binding.onTimer(name);
          },
          Math.min(Math.max(0, dueAtMs - Date.now()), MAX_TIMER_DELAY_MS),
        );
        timer.unref?.();
        featureTimers.set(name, timer);
      },
      clear: (context, name) => {
        if (context.signal !== binding.signal) return;
        clearTimeout(featureTimers.get(name));
        featureTimers.delete(name);
      },
    },
  };
  return input.features.composeContext({
    context: featureContext,
    host,
    logger: (level, event, fields) => input.logger.log(level, event, fields),
  });
}

/**
 * The Agent definition one Runtime activation runs with: the context
 * instructions feature renders the developer instructions from the facts
 * that activation reads.
 */
export function instructedAgent(
  composed: Pick<ComposedContextFeatures, "contextInstructions">,
  agent: AgentDefinition,
  record: Pick<ExecutionContextRecord, "ref" | "roomKind">,
  facts: ContextInstructionFacts,
): AgentDefinition {
  return withExecutionContextContract(
    agent,
    record.ref,
    record.roomKind,
    composed.contextInstructions(facts),
  );
}

const withExecutionContextContract = (
  agent: AgentDefinition,
  ref: ExecutionContextRef,
  roomKind: MetaRoomKind | undefined,
  /** Assembled by the context-instructions feature; absent = none. */
  featureInstructions: string | undefined,
): AgentDefinition => {
  if (ref.kind === "meta" && roomKind === undefined) {
    throw new AgentManagerError(
      "invalid_state",
      "Meta Context is missing trusted Room kind",
    );
  }
  return {
    ...agent,
    developerInstructions: featureInstructions ?? agent.developerInstructions,
  };
};
