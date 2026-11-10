import {
  AGENT_FEATURE_MODULES,
  type AgentFeatureModuleName,
} from "./catalog.generated.js";
import {
  assertValidFeatureCatalog,
  composeActivationFeatures,
  composeContextFeatures,
  composeRunFeatures,
  type ComposedActivationFeatures,
  type ComposedContextFeatures,
  type ComposedLogger,
  type ComposedRunFeatures,
  type InputContributionMerger,
} from "./compose.js";
import type {
  ActivationFeatureView,
  FeatureContext,
  FeatureDeclaration,
} from "./contracts.js";
import {
  createAgentMemoryFeature,
  type AgentMemoryFeatureDeps,
} from "./agent-memory/feature.js";
import { createContextInstructionsFeature } from "./context-instructions/feature.js";
import {
  createContextRestartFeature,
  type ContextRestartFeatureDeps,
} from "./context-restart/feature.js";
import { createFlashbackFeature } from "./flashback/feature.js";
import type { Flashback } from "../../flashback.js";
import type { FlashbackSettings } from "./flashback/index.js";
import { createInboxSourceFeature } from "./inbox-source/feature.js";
import type { RunWakeTargetRegistrar } from "./inbox-source/types.js";
import {
  createProactiveFeature,
  type ProactiveFeatureDeps,
} from "./proactive/feature.js";
import { createNotificationContextFeature } from "./notification-context/feature.js";
import { createEmojiReactionFeature } from "./emoji-reaction/feature.js";
import { createReplyRhythmFeature } from "./reply-rhythm/feature.js";
import type { ReplyRhythmSettings } from "./reply-rhythm/types.js";
import { createRunStatusFeature } from "./run-status/feature.js";
import {
  createUserMemoryFeature,
  type UserMemoryResolver,
  type UserMemoryTracker,
} from "./user-memory/index.js";
import { createUserMemoryUpdateFeature } from "./user-memory-update/index.js";
import { createTaskInputFeature } from "./task-input/feature.js";
import {
  createTaskProgressFeature,
  type TaskProgressFeatureDeps,
} from "./task-progress/feature.js";
import { createToolApprovalFeature } from "./tool-approval/feature.js";
import type { BuiltinFeatureHost, BuiltinRunBackend } from "./host-ports.js";
import { mergePromptInputContribution } from "../prompt/input-contribution-merger.js";
import type { AgentLogger } from "../observability/agent-log.js";

/**
 * Shared services the Application/composition root owns once for the whole
 * process — every entry is available before the AgentManager exists. A
 * feature's presence is selected by its capability: absent means the feature
 * is deliberately not assembled; a present but malformed capability fails
 * inside that feature's factory instead of silently disabling it.
 */
export interface BuiltinFeatureServices {
  readonly logger: AgentLogger;
  /**
   * Shared registrar for TeamHub's queued-input wakes. Absent means Inbox
   * input is not configured and the inbox-source feature is not assembled.
   */
  readonly runWakes?: RunWakeTargetRegistrar;
  /** Memory's flashback in this process; absent disables flashback. */
  readonly flashback?: {
    readonly client: Flashback;
    readonly settings?: FlashbackSettings;
  };
  /** AnotherMe proactive review: TeamHub client; absent disables it. */
  readonly proactive?: Pick<ProactiveFeatureDeps, "client">;
  /** Meta Task progress reminders: TeamHub client; absent disables them. */
  readonly taskProgress?: Pick<TaskProgressFeatureDeps, "client">;
  /**
   * `AgentMemoryServices.featureDeps` from agent-memory/services.ts: its
   * wake closure binds the late Coordinator at `services.start(host)`, so a
   * forgotten `start()` throws loudly on the first wake instead of leaving
   * the required wake capability silently undefined.
   */
  readonly agentMemory?: AgentMemoryFeatureDeps;
  /**
   * Context compaction settings; absent disables context-restart. The
   * composition root supplies it only when Agent Memory maintenance runs,
   * so compacted detail is still absorbed into memory.
   */
  readonly contextRestart?: Pick<ContextRestartFeatureDeps, "periodMs">;
  /** Reads the represented Human's memory.md; absent disables user-memory. */
  readonly resolveUserMemory?: UserMemoryResolver;
  /**
   * Latest memory.md recorded by those reads and shared by user-memory and
   * user-memory-update; absent disables both.
   */
  readonly userMemories?: UserMemoryTracker;
  /** Another Me reply rhythm and its offer settings; absent disables it. */
  readonly replyRhythm?: { readonly settings?: ReplyRhythmSettings };
  /**
   * Domain merger for per-message text contributions. Defaults to the
   * prompt-domain notification-sentinel merger.
   */
  readonly mergeInputContribution?: InputContributionMerger;
}

/**
 * The assembled builtin feature set, created once per process before the
 * AgentManager exists. It holds only shared services; Context-scoped
 * declarations are built inside `composeContext` with that Context's host,
 * so the Manager injects its private capabilities per Context without a
 * construction-time cycle. Feature factories are cheap — they bind closures,
 * never duplicate shared clients, Coordinators, or budgets.
 */
export interface BuiltinAgentFeatures {
  /**
   * Activation-scope declarations bound once from shared services
   * (`agent-memory`, `user-memory`).
   */
  readonly activationDeclarations: readonly FeatureDeclaration[];
  /**
   * Context-scope declarations bound to one Context's host capabilities:
   * the service-bound declarations plus the host-bound sources/observers
   * (`inbox-source`, `flashback`).
   * Called per Context composition.
   */
  contextDeclarations(host: BuiltinFeatureHost): readonly FeatureDeclaration[];
  /**
   * Run-scope declarations bound to the backend activation obtained during
   * ONE Runtime activation — never a previous Runtime and never resolved at
   * steer time. A backend without `prepareRunInput` contributes nothing.
   */
  runDeclarations(backend: BuiltinRunBackend): readonly FeatureDeclaration[];
  /**
   * Per-Context composition: the Manager passes its narrow host capabilities
   * for THIS bound instance; the prompt-domain input merger is prebound.
   */
  composeContext(input: {
    readonly context: FeatureContext;
    readonly host: BuiltinFeatureHost;
    readonly logger?: ComposedLogger;
  }): ComposedContextFeatures;
  /** Per-Runtime-activation composition. */
  composeActivation(input: {
    readonly view: ActivationFeatureView;
    readonly logger?: ComposedLogger;
  }): ComposedActivationFeatures;
  /** Per-activation Run composition over that activation's backend. */
  composeRun(input: {
    readonly view: ActivationFeatureView;
    readonly backend: BuiltinRunBackend;
    readonly logger?: ComposedLogger;
  }): ComposedRunFeatures;
}

/**
 * One module's assembly decision per binding stage:
 * - `service`: built once from shared services; the declaration may carry
 *   any scope (agent-memory carries context+activation).
 * - `context`: built per Context with that Context's host bound.
 * - `run`: built per Runtime activation with that activation's backend.
 * A module with no builder for a stage is deliberately absent from it.
 */
interface BuiltinModuleAssembly {
  readonly service?: (
    services: BuiltinFeatureServices,
  ) => FeatureDeclaration | undefined;
  readonly context?: (input: {
    readonly services: BuiltinFeatureServices;
    readonly host: BuiltinFeatureHost;
  }) => FeatureDeclaration | undefined;
  readonly run?: (input: {
    readonly services: BuiltinFeatureServices;
    readonly backend: BuiltinRunBackend;
  }) => FeatureDeclaration | undefined;
}

/**
 * One explicit decision per generated manifest entry. The Record type makes
 * the check exhaustive at compile time: a regenerated catalog listing a new
 * feature directory fails typecheck here until its assembly decision is
 * written, so a module can never be silently skipped.
 */
const MODULE_ASSEMBLY: Record<AgentFeatureModuleName, BuiltinModuleAssembly> = {
  "agent-memory": {
    service: (services) =>
      services.agentMemory
        ? createAgentMemoryFeature(services.agentMemory)
        : undefined,
  },
  "context-instructions": {
    service: () => createContextInstructionsFeature(),
  },
  "context-restart": {
    context: ({ services, host }) =>
      services.contextRestart
        ? createContextRestartFeature({
            ...services.contextRestart,
            timers: host.timers,
          })
        : undefined,
  },
  "emoji-reaction": {
    service: () => createEmojiReactionFeature(),
  },
  flashback: {
    context: ({ services, host }) =>
      services.flashback
        ? createFlashbackFeature({
            client: services.flashback.client,
            logger: services.logger,
            trackBackground: host.trackBackground,
            ...(services.flashback.settings
              ? { settings: services.flashback.settings }
              : {}),
          })
        : undefined,
  },
  "inbox-source": {
    context: ({ services, host }) => {
      if (!services.runWakes) return undefined;
      if (!host.inbox)
        throw new Error(
          "builtin features: inbox-source requires host.inbox when run wakes are configured",
        );
      return createInboxSourceFeature({
        wakes: services.runWakes,
        host: host.inbox,
      });
    },
  },
  "notification-context": {
    service: () => createNotificationContextFeature(),
  },
  proactive: {
    context: ({ services, host }) =>
      services.proactive
        ? createProactiveFeature({
            ...services.proactive,
            logger: services.logger,
            trackBackground: host.trackBackground,
          })
        : undefined,
  },
  "reply-rhythm": {
    service: (services) =>
      services.replyRhythm
        ? createReplyRhythmFeature(services.replyRhythm)
        : undefined,
  },
  "run-status": {
    service: () => createRunStatusFeature(),
  },
  "user-memory": {
    service: (services) =>
      services.userMemories && services.resolveUserMemory
        ? createUserMemoryFeature({
            memories: services.userMemories,
            resolveUserMemory: services.resolveUserMemory,
          })
        : undefined,
  },
  "task-progress": {
    context: ({ services, host }) =>
      services.taskProgress
        ? createTaskProgressFeature({
            ...services.taskProgress,
            logger: services.logger,
            timers: host.timers,
            trackBackground: host.trackBackground,
          })
        : undefined,
  },
  "user-memory-update": {
    service: (services) =>
      services.userMemories && services.resolveUserMemory
        ? createUserMemoryUpdateFeature({ memories: services.userMemories })
        : undefined,
  },
  "tool-approval": {
    service: () => createToolApprovalFeature(),
  },
  // Run-scope only: the backend capability exists per Runtime activation,
  // so it is bound in runDeclarations(), never statically.
  "task-input": {
    run: ({ backend }) =>
      backend.prepareRunInput
        ? // Bind the capability to this activation's backend instance so a
          // method using `this` keeps its receiver.
          createTaskInputFeature({
            prepareRunInput: backend.prepareRunInput.bind(backend),
          })
        : undefined,
  },
};

const MODULE_NAMES = Object.keys(
  AGENT_FEATURE_MODULES,
) as AgentFeatureModuleName[];

const withScope = (
  declarations: readonly FeatureDeclaration[],
  scope: "context" | "activation" | "run",
): FeatureDeclaration[] => declarations.filter((d) => d[scope] !== undefined);

/**
 * The explicit builtin assembly: shared services first, host per Context.
 * Factories bind their narrow dependencies by closure; no dependencies bag,
 * service tokens, or locator is involved. Optional features are skipped
 * when their capability is absent, and catalogs are validated so
 * mis-assembly fails loudly rather than at first use.
 */
export const createBuiltinAgentFeatures = (input: {
  readonly services: BuiltinFeatureServices;
}): BuiltinAgentFeatures => {
  const { services } = input;
  const serviceDeclarations = MODULE_NAMES.flatMap((name) => {
    const build = MODULE_ASSEMBLY[name].service;
    const declaration = build?.(services);
    return declaration ? [declaration] : [];
  });
  assertValidFeatureCatalog(serviceDeclarations);
  const merge = services.mergeInputContribution ?? mergePromptInputContribution;
  const defaultLogger: ComposedLogger = (level, event, fields) =>
    services.logger.log(level, event, fields);

  const contextDeclarations = (
    host: BuiltinFeatureHost,
  ): FeatureDeclaration[] => {
    const hostDeclarations = MODULE_NAMES.flatMap((name) => {
      const build = MODULE_ASSEMBLY[name].context;
      const declaration = build?.({ services, host });
      return declaration ? [declaration] : [];
    });
    const declarations = [
      ...withScope(serviceDeclarations, "context"),
      ...hostDeclarations,
    ];
    assertValidFeatureCatalog(declarations);
    return declarations;
  };
  const activationDeclarations = withScope(serviceDeclarations, "activation");
  const runDeclarations = (
    backend: BuiltinRunBackend,
  ): FeatureDeclaration[] => {
    const runBound = MODULE_NAMES.flatMap((name) => {
      const build = MODULE_ASSEMBLY[name].run;
      const declaration = build?.({ services, backend });
      return declaration ? [declaration] : [];
    });
    return [...withScope(serviceDeclarations, "run"), ...runBound];
  };

  return {
    activationDeclarations,
    contextDeclarations,
    runDeclarations,
    composeContext: ({ context, host, logger }) =>
      composeContextFeatures({
        context,
        features: contextDeclarations(host),
        mergeInputContribution: merge,
        logger: logger ?? defaultLogger,
      }),
    composeActivation: ({ view, logger }) =>
      composeActivationFeatures({
        view,
        features: activationDeclarations,
        logger: logger ?? defaultLogger,
      }),
    composeRun: ({ view, backend, logger }) =>
      composeRunFeatures({
        view,
        features: runDeclarations(backend),
        logger: logger ?? defaultLogger,
      }),
  };
};
