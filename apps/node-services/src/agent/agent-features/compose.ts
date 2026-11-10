import {
  type AcceptedInboxFact,
  type ActivationFeatureView,
  type BoundFeatureContext,
  type ContextBoundInput,
  type ContextBoundSource,
  type FeatureContext,
  type ContextInstructionFacts,
  type FeatureDeclaration,
  type FeatureInputContribution,
  type FeaturePortMap,
  type FeaturePortOrder,
  type FeatureScope,
  type MaintenanceAction,
  type MaintenanceEvent,
  type MaintenanceTrigger,
  type NotificationContextInput,
  type RunTerminalEvent,
  type RuntimePreparation,
  type RuntimePreparationInput,
} from "./contracts.js";
import type { AgentInput, RunEvent } from "../executor/provider.js";
import type { ExecutionContextRef } from "../executor/context-ref.js";
import type { Message, AgentCapability, AgentType } from "../executor/types.js";
import type { RuntimeStatusUpdate } from "../executor/runtime-status.js";
import type { RuntimeViewMapping } from "../executor/workspace.js";

const FEATURE_SCOPES = ["context", "activation", "run"] as const;

const assertValidMatch = (feature: FeatureDeclaration): void => {
  const match = feature.match;
  if (!match) return;
  if (match.agentTypes !== undefined && match.agentTypes.length === 0)
    throw new Error(`Feature ${feature.id} declares an empty agentTypes match`);
  if (match.contextKinds !== undefined && match.contextKinds.length === 0)
    throw new Error(
      `Feature ${feature.id} declares an empty contextKinds match`,
    );
  if (match.capabilities !== undefined && match.capabilities.length === 0)
    throw new Error(
      `Feature ${feature.id} declares an empty capabilities match`,
    );
};

interface ScopeDeclaration<H> {
  readonly ports: FeaturePortMap<H>;
}

const scopePorts = (
  feature: FeatureDeclaration,
  scope: FeatureScope,
): Record<string, FeaturePortOrder | undefined> | undefined =>
  (feature[scope] as ScopeDeclaration<unknown> | undefined)?.ports;

/**
 * Validates the complete catalog once: unique identities, nonempty scope port
 * declarations, valid match shapes, existing references, and acyclic
 * same-scope/same-port `after` edges.
 */
export const assertValidFeatureCatalog = (
  features: readonly FeatureDeclaration[],
): void => {
  const byId = new Map<string, FeatureDeclaration>();
  for (const feature of features) {
    if (!feature.id || typeof feature.id !== "string")
      throw new Error("Feature identity must be a nonempty string");
    if (byId.has(feature.id))
      throw new Error(`Duplicate feature identity: ${feature.id}`);
    byId.set(feature.id, feature);
    assertValidMatch(feature);
    if (!FEATURE_SCOPES.some((scope) => feature[scope] !== undefined))
      throw new Error(`Feature ${feature.id} declares no lifecycle scope`);
  }
  const PORT_KEYS: Record<FeatureScope, readonly string[]> = {
    context: [
      "onContextBound",
      "contributeContextInstructions",
      "contributeNotificationContext",
      "prepareInput",
      "afterInboxInputAccepted",
      "onRunTerminal",
      "onRunEvent",
      "decideMaintenance",
      "onMaintenance",
      "onTimer",
    ],
    activation: ["prepareRuntime"],
    run: ["prepareRunInput"],
  };
  for (const feature of features) {
    for (const scope of FEATURE_SCOPES) {
      const ports = scopePorts(feature, scope);
      if (ports === undefined) continue;
      if (Object.keys(ports).length === 0)
        throw new Error(`Feature ${feature.id} declares no ${scope} ports`);
      for (const port of Object.keys(ports)) {
        if (!PORT_KEYS[scope].includes(port))
          throw new Error(
            `Feature ${feature.id} declares unknown port ${scope}.${port}`,
          );
        const order = ports[port];
        for (const reference of order?.after ?? []) {
          const target = byId.get(reference);
          if (!target)
            throw new Error(
              `Feature ${feature.id} orders after unknown feature ${reference}`,
            );
          const targetPorts = scopePorts(target, scope);
          if (!targetPorts || !(port in targetPorts))
            throw new Error(
              `Feature ${feature.id} orders ${scope}.${port} after ${reference}, which does not declare that port`,
            );
        }
        for (const reference of order?.requires ?? []) {
          const target = byId.get(reference);
          if (!target)
            throw new Error(
              `Feature ${feature.id} requires unknown feature ${reference}`,
            );
          if (!target[scope])
            throw new Error(
              `Feature ${feature.id} requires ${reference} in scope ${scope}, which that feature does not declare`,
            );
        }
      }
    }
  }
  for (const scope of FEATURE_SCOPES) {
    const ports = new Set<string>();
    for (const feature of features)
      for (const port of Object.keys(scopePorts(feature, scope) ?? {}))
        ports.add(port);
    for (const port of ports) {
      const edges = new Map<string, readonly string[]>();
      for (const feature of features) {
        const order = scopePorts(feature, scope)?.[port];
        if (order?.after?.length) edges.set(feature.id, order.after);
      }
      assertAcyclic(edges, `${scope}.${port}`);
    }
  }
};

const assertAcyclic = (
  edges: ReadonlyMap<string, readonly string[]>,
  label: string,
): void => {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (id: string, path: string[]): void => {
    if (visited.has(id)) return;
    if (visiting.has(id))
      throw new Error(
        `Feature ordering cycle at ${label}: ${[...path, id].join(" -> ")}`,
      );
    visiting.add(id);
    for (const next of edges.get(id) ?? []) walk(next, [...path, id]);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of edges.keys()) walk(id, []);
};

export interface FeatureMatchInput {
  readonly agentType?: AgentType | undefined;
  readonly contextKind: ExecutionContextRef["kind"];
  readonly capabilities?: readonly AgentCapability[] | undefined;
}

/**
 * AND across declared dimensions, OR inside one dimension. A declared
 * `agentTypes` or `capabilities` dimension without the supplied fact is a
 * wiring error, not a silent non-match.
 */
export const featureMatches = (
  feature: FeatureDeclaration,
  input: FeatureMatchInput,
): boolean => {
  const match = feature.match;
  if (!match) return true;
  if (
    match.agentTypes !== undefined &&
    match.agentTypes.length > 0 &&
    input.agentType === undefined
  )
    throw new Error(
      `Feature ${feature.id} declares an agentTypes match but no agentType was supplied`,
    );
  if (
    match.agentTypes !== undefined &&
    !match.agentTypes.includes(input.agentType as AgentType)
  )
    return false;
  if (
    match.contextKinds !== undefined &&
    !match.contextKinds.includes(input.contextKind)
  )
    return false;
  if (match.capabilities !== undefined) {
    const capabilities = input.capabilities;
    if (capabilities === undefined)
      throw new Error(
        `Feature ${feature.id} declares a capabilities match but no capabilities were supplied`,
      );
    if (!match.capabilities.some((needed) => capabilities.includes(needed)))
      return false;
  }
  return true;
};

interface BoundFeature<H> {
  readonly feature: FeatureDeclaration;
  readonly declaration: ScopeDeclaration<H>;
  readonly handlers: H;
}

const matchedFeatures = <
  S extends FeatureScope,
  D extends ScopeDeclaration<object>,
>(
  features: readonly FeatureDeclaration[],
  scope: S,
  input: FeatureMatchInput,
): { readonly feature: FeatureDeclaration; readonly declaration: D }[] => {
  const matched = features.filter(
    (feature) => feature[scope] !== undefined && featureMatches(feature, input),
  );
  const matchedIds = new Set(matched.map((feature) => feature.id));
  return matched.map((feature) => {
    const declaration = feature[scope] as unknown as D;
    const ports: Record<string, FeaturePortOrder | undefined> =
      declaration.ports;
    for (const order of Object.values(ports)) {
      for (const required of order?.requires ?? []) {
        if (!matchedIds.has(required))
          throw new Error(
            `Feature ${feature.id} requires ${required} in scope ${scope}, but it is not matched`,
          );
      }
    }
    return { feature, declaration };
  });
};

/**
 * Declared ports and returned handlers must agree exactly: a declared port
 * without a handler fails assembly, and so does a handler the declaration did
 * not announce.
 */
const assertHandlersMatchPorts = <H>(
  feature: FeatureDeclaration,
  scope: FeatureScope,
  declaration: ScopeDeclaration<H>,
  handlers: H,
): void => {
  for (const port of Object.keys(declaration.ports)) {
    if (typeof handlers[port as keyof H] !== "function")
      throw new Error(
        `Feature ${feature.id} declares port ${scope}.${port} but returned no handler`,
      );
  }
  for (const key of Object.keys(handlers as object)) {
    if (!(key in declaration.ports))
      throw new Error(
        `Feature ${feature.id} returned undeclared handler ${scope}.${key}`,
      );
  }
};

/**
 * Deterministic per-port order: topological on same-scope/same-port `after`
 * edges with the stable feature id as tie-break. No implicit parallelism.
 */
const orderedHandlers = <H, K extends keyof H & string>(
  bound: readonly BoundFeature<H>[],
  port: K,
): readonly {
  readonly feature: FeatureDeclaration;
  readonly handler: NonNullable<H[K]>;
}[] => {
  const entries = bound
    .map((entry) => ({ entry, handler: entry.handlers[port] }))
    .filter(
      (
        entry,
      ): entry is { entry: BoundFeature<H>; handler: NonNullable<H[K]> } =>
        entry.handler != null,
    );
  const entriesById = new Map(
    entries.map((entry) => [entry.entry.feature.id, entry]),
  );
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const { entry } of entries) {
    incoming.set(entry.feature.id, incoming.get(entry.feature.id) ?? 0);
    const order = (
      entry.declaration.ports as Record<string, FeaturePortOrder | undefined>
    )[port];
    for (const after of order?.after ?? []) {
      if (!entriesById.has(after)) continue;
      incoming.set(entry.feature.id, (incoming.get(entry.feature.id) ?? 0) + 1);
      outgoing.set(after, [...(outgoing.get(after) ?? []), entry.feature.id]);
    }
  }
  const ready = [...incoming.entries()]
    .filter(([, count]) => count === 0)
    .map(([id]) => id)
    .sort();
  const ordered: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    ordered.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const count = (incoming.get(next) ?? 0) - 1;
      incoming.set(next, count);
      if (count === 0) {
        const at = ready.findIndex((candidate) => candidate > next);
        if (at < 0) ready.push(next);
        else ready.splice(at, 0, next);
      }
    }
  }
  if (ordered.length !== entries.length)
    throw new Error(`Feature ordering cycle in ${port} handlers`);
  return ordered.map((id) => {
    const entry = entriesById.get(id)!;
    return { feature: entry.entry.feature, handler: entry.handler };
  });
};

export type ComposedLogger = (
  level: "debug" | "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown>,
) => void;

const silentLogger: ComposedLogger = () => undefined;

/**
 * Merges one text contribution into a Runtime input message. The host injects
 * the domain renderer (e.g. an anchor-aware prompt merger); the default is a
 * plain append that keeps the first text segment in sync with rawMessage.
 */
export type InputContributionMerger = (
  message: Message,
  contribution: FeatureInputContribution,
) => Message;

export const appendInputContribution: InputContributionMerger = (
  message,
  contribution,
) => {
  const [first, ...rest] = message.segments;
  if (!message.rawMessage) {
    // An empty rawMessage falls back to the segment contents at format time;
    // writing a rawMessage holding only the contribution would shadow the
    // original body. Merge into the segments instead.
    const segments =
      first.type === "text"
        ? ([
            {
              ...first,
              content: first.content
                ? `${first.content}\n\n${contribution.text}`
                : contribution.text,
            },
            ...rest,
          ] as const)
        : ([
            ...message.segments,
            { type: "text" as const, content: contribution.text },
          ] as const);
    return Object.freeze({ ...message, segments });
  }
  const rawMessage = `${message.rawMessage}\n\n${contribution.text}`;
  const segments =
    first.type === "text"
      ? ([{ ...first, content: rawMessage }, ...rest] as const)
      : ([
          { type: "text" as const, content: rawMessage },
          ...message.segments,
        ] as const);
  return Object.freeze({ ...message, rawMessage, segments });
};

export interface ComposedContextFeatures {
  readonly matched: readonly string[];
  /** Joined developer-instruction contributions in deterministic order. */
  contextInstructions(facts: ContextInstructionFacts): string | undefined;
  /** Ordered notification-context contributions. */
  notificationContext(input: NotificationContextInput): readonly string[];
  /** Ordered per-message input contributions merged into the original. */
  prepareInput(message: Message): Message;
  /**
   * Bind Context sources in declared order. On failure or abort every
   * already-bound source stops in reverse order exactly once.
   */
  bindSources(input: ContextBoundInput): Promise<void>;
  afterInboxInputAccepted(fact: AcceptedInboxFact): void;
  onRunTerminal(event: RunTerminalEvent): void;
  onRunEvent(event: RunEvent): readonly RuntimeStatusUpdate[];
  /**
   * First non-null maintenance decision in declared order. A throwing
   * handler is isolated and counts as no decision.
   */
  decideMaintenance(trigger: MaintenanceTrigger): MaintenanceAction | null;
  onMaintenance(event: MaintenanceEvent): void;
  onTimer(name: string): void;
  /**
   * Stop bound sources in reverse order. FeatureContext invalidation is owned
   * by the Manager; release only cleans up the resources this composition
   * acquired. Observer ports keep dispatching afterwards so terminal
   * forwarding during shutdown is preserved.
   */
  release(): Promise<void>;
}

/** The bound context minus submission capabilities, for non-submitting ports. */
const restrictedContext = (context: FeatureContext): BoundFeatureContext => {
  const {
    activeRunId: _activeRunId,
    steer: _steer,
    followUp: _followUp,
    ...view
  } = context;
  return view;
};

const throwAggregated = (
  errors: readonly unknown[],
  message: string,
): never => {
  if (errors.length === 1) throw errors[0];
  throw new AggregateError([...errors], message);
};

export const composeContextFeatures = (input: {
  readonly context: FeatureContext;
  readonly features: readonly FeatureDeclaration[];
  readonly mergeInputContribution?: InputContributionMerger;
  readonly logger?: ComposedLogger;
}): ComposedContextFeatures => {
  const catalog = input.features;
  assertValidFeatureCatalog(catalog);
  const log = input.logger ?? silentLogger;
  const merge = input.mergeInputContribution ?? appendInputContribution;
  const boundContext = restrictedContext(input.context);
  const bound = matchedFeatures<
    "context",
    NonNullable<FeatureDeclaration["context"]>
  >(catalog, "context", {
    agentType: input.context.identity.agentType,
    contextKind: input.context.ref.kind,
    capabilities: input.context.capabilities,
  }).map(({ feature, declaration }) => {
    const handlers = declaration.create(boundContext);
    assertHandlersMatchPorts(feature, "context", declaration, handlers);
    return { feature, declaration, handlers };
  });
  const boundSources: {
    feature: FeatureDeclaration;
    source: ContextBoundSource;
  }[] = [];
  let bindStarted = false;
  let releasePromise: Promise<void> | null = null;

  /**
   * Splices ownership out BEFORE awaiting so an overlapping release or a
   * bind-failure rollback can never stop the same handle twice.
   */
  const stopBoundSources = async (): Promise<unknown[]> => {
    const owned = boundSources.splice(0, boundSources.length).reverse();
    const errors: unknown[] = [];
    for (const { source } of owned) {
      try {
        await source.stop();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  };

  const isolated =
    (event: string) => (feature: FeatureDeclaration, error: unknown) =>
      log("warn", event, { feature: feature.id, error });

  return {
    matched: bound.map((entry) => entry.feature.id),
    contextInstructions(facts) {
      const parts = orderedHandlers(bound, "contributeContextInstructions")
        .map(({ handler }) => handler(boundContext, facts))
        .filter(
          (part): part is string => part !== undefined && part.length > 0,
        );
      return parts.length > 0 ? parts.join("\n\n") : undefined;
    },
    notificationContext(notificationInput) {
      return orderedHandlers(bound, "contributeNotificationContext").flatMap(
        ({ handler }) => handler(boundContext, notificationInput),
      );
    },
    prepareInput(message) {
      let current = message;
      // Pure contributions all read the same original message; the merged
      // result applies them afterwards in declared order.
      for (const { handler } of orderedHandlers(bound, "prepareInput")) {
        const contribution = handler(boundContext, message);
        if (contribution?.text) current = merge(current, contribution);
      }
      return current;
    },
    async bindSources(bindInput) {
      // One-shot install: with per-instance source ownership there is no
      // global dedup safety net, so any second attempt is a caller bug.
      if (bindStarted)
        throw new Error("Context feature sources can bind only once");
      bindStarted = true;
      if (releasePromise)
        throw new Error("Context feature sources cannot bind after release");
      for (const { feature, handler } of orderedHandlers(
        bound,
        "onContextBound",
      )) {
        try {
          input.context.signal.throwIfAborted();
          const source = await handler(boundContext, bindInput);
          if (releasePromise || input.context.signal.aborted) {
            // A release or abort won the handler wait: the late handle never
            // joins the owned set, so it is stopped here before unwinding.
            const errors: unknown[] = [];
            if (source) {
              try {
                await source.stop();
              } catch (stopError) {
                errors.push(stopError);
              }
            }
            try {
              input.context.signal.throwIfAborted();
            } catch (abortError) {
              errors.unshift(abortError);
            }
            if (!input.context.signal.aborted)
              errors.unshift(
                new Error("Context features released during binding"),
              );
            throwAggregated(
              errors,
              "Context feature binding lost the release race",
            );
          }
          if (source) boundSources.push({ feature, source });
        } catch (error) {
          const cleanupErrors = await stopBoundSources();
          throwAggregated(
            [error, ...cleanupErrors],
            "Context feature binding failed",
          );
        }
      }
    },
    afterInboxInputAccepted(fact) {
      for (const { feature, handler } of orderedHandlers(
        bound,
        "afterInboxInputAccepted",
      )) {
        try {
          handler(input.context, fact);
        } catch (error) {
          isolated("feature.after_inbox_input_failed")(feature, error);
        }
      }
    },
    onRunTerminal(event) {
      for (const { feature, handler } of orderedHandlers(
        bound,
        "onRunTerminal",
      )) {
        try {
          handler(boundContext, event);
        } catch (error) {
          isolated("feature.run_terminal_failed")(feature, error);
        }
      }
    },
    onRunEvent(event) {
      const updates: RuntimeStatusUpdate[] = [];
      for (const { feature, handler } of orderedHandlers(bound, "onRunEvent")) {
        try {
          const update = handler(boundContext, event);
          if (update) updates.push(update);
        } catch (error) {
          isolated("feature.run_event_failed")(feature, error);
        }
      }
      return updates;
    },
    decideMaintenance(trigger) {
      for (const { feature, handler } of orderedHandlers(
        bound,
        "decideMaintenance",
      )) {
        try {
          const action = handler(boundContext, trigger);
          if (action) return action;
        } catch (error) {
          isolated("feature.maintenance_decision_failed")(feature, error);
        }
      }
      return null;
    },
    onMaintenance(event) {
      for (const { feature, handler } of orderedHandlers(
        bound,
        "onMaintenance",
      )) {
        try {
          handler(boundContext, event);
        } catch (error) {
          isolated("feature.maintenance_observer_failed")(feature, error);
        }
      }
    },
    onTimer(name) {
      for (const { feature, handler } of orderedHandlers(bound, "onTimer")) {
        try {
          handler(input.context, name);
        } catch (error) {
          isolated("feature.timer_failed")(feature, error);
        }
      }
    },
    release() {
      // Repeated/concurrent calls share one cleanup promise: ownership is
      // spliced exactly once, so a rollback overlapping release cannot stop
      // the same handle twice.
      return (releasePromise ??= (async () => {
        const errors = await stopBoundSources();
        if (errors.length > 0)
          throwAggregated(errors, "Context feature release failed");
      })());
    },
  };
};

export interface ComposedActivationFeatures {
  readonly matched: readonly string[];
  /**
   * Run prepareRuntime handlers concurrently except along `after` edges and
   * merge contributions in declared order.
   */
  prepare(input: RuntimePreparationInput): Promise<{
    /** Activation-time developer instructions appended in declared order. */
    readonly developerInstructions: readonly string[];
    readonly runtimeViewMappings: readonly RuntimeViewMapping[];
    readonly checks: readonly ((signal: AbortSignal) => Promise<boolean>)[];
  }>;
  /** Release activation-scoped contributions in reverse order. */
  release(): Promise<void>;
}

export const composeActivationFeatures = (input: {
  readonly view: ActivationFeatureView;
  readonly features: readonly FeatureDeclaration[];
  readonly logger?: ComposedLogger;
}): ComposedActivationFeatures => {
  const catalog = input.features;
  assertValidFeatureCatalog(catalog);
  const log = input.logger ?? silentLogger;
  const bound = matchedFeatures<
    "activation",
    NonNullable<FeatureDeclaration["activation"]>
  >(catalog, "activation", {
    agentType: input.view.agentType,
    contextKind: input.view.ref.kind,
  }).map(({ feature, declaration }) => {
    const handlers = declaration.create(input.view);
    assertHandlersMatchPorts(feature, "activation", declaration, handlers);
    return { feature, declaration, handlers };
  });
  const releases: {
    feature: FeatureDeclaration;
    release: () => Promise<void>;
  }[] = [];
  let releasePromise: Promise<void> | null = null;

  /**
   * Splices ownership out BEFORE awaiting so an overlapping release or a
   * prepare-failure rollback can never run the same release twice.
   */
  const releaseAcquired = async (): Promise<unknown[]> => {
    const owned = releases.splice(0, releases.length).reverse();
    const errors: unknown[] = [];
    for (const { release } of owned) {
      try {
        await release();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  };

  return {
    matched: bound.map((entry) => entry.feature.id),
    async prepare(preparationInput) {
      if (releasePromise)
        throw new Error("Runtime features cannot prepare after release");
      // Independent preparations run together; an `after` edge waits for its
      // named predecessor. The first failure aborts the branches still running.
      const branches = new AbortController();
      const branchInput: RuntimePreparationInput = {
        ...preparationInput,
        signal: AbortSignal.any([preparationInput.signal, branches.signal]),
      };
      const started = new Map<string, Promise<RuntimePreparation>>();
      const ordered = orderedHandlers(bound, "prepareRuntime").map(
        ({ feature, handler }) => {
          const after = scopePorts(feature, "activation")?.prepareRuntime
            ?.after;
          const predecessors = (after ?? []).flatMap(
            (id) => started.get(id) ?? [],
          );
          const promise = Promise.all(predecessors).then(async () => {
            branchInput.signal.throwIfAborted();
            const startedAt = performance.now();
            try {
              const preparation = await handler(input.view, branchInput);
              log("info", "context_activation.runtime_feature_prepared", {
                feature: feature.id,
                durationMs: performance.now() - startedAt,
                outcome: "fulfilled",
              });
              return preparation;
            } catch (error) {
              log("info", "context_activation.runtime_feature_prepared", {
                feature: feature.id,
                durationMs: performance.now() - startedAt,
                outcome: "rejected",
              });
              throw error;
            }
          });
          promise.catch((error: unknown) => branches.abort(error));
          started.set(feature.id, promise);
          return { feature, promise };
        },
      );
      const outcomes = await Promise.allSettled(
        ordered.map((entry) => entry.promise),
      );
      // Register every acquired release before merging so a failure or a
      // contribution conflict still cleans each preparation exactly once.
      outcomes.forEach((outcome, index) => {
        if (outcome.status === "fulfilled" && outcome.value.release)
          releases.push({
            feature: ordered[index]!.feature,
            release: outcome.value.release,
          });
      });
      const failures = [
        ...new Set(
          outcomes.flatMap((outcome) =>
            outcome.status === "rejected" ? [outcome.reason as unknown] : [],
          ),
        ),
      ];
      if (preparationInput.signal.aborted && failures.length === 0)
        failures.push(preparationInput.signal.reason);
      if (releasePromise && failures.length === 0)
        failures.push(
          new Error("Runtime features released during preparation"),
        );
      const developerInstructions: string[] = [];
      const runtimeViewMappings: RuntimeViewMapping[] = [];
      const checks: ((signal: AbortSignal) => Promise<boolean>)[] = [];
      try {
        if (failures.length > 0)
          throwAggregated(failures, "Runtime feature preparation failed");
        outcomes.forEach((outcome) => {
          if (outcome.status !== "fulfilled") return;
          const preparation = outcome.value;
          if (preparation.developerInstructions)
            developerInstructions.push(preparation.developerInstructions);
          if (preparation.runtimeViewMappings)
            runtimeViewMappings.push(...preparation.runtimeViewMappings);
          if (preparation.checkNextRun) checks.push(preparation.checkNextRun);
        });
      } catch (error) {
        const cleanupErrors = await releaseAcquired();
        throwAggregated(
          [error, ...cleanupErrors],
          "Runtime feature preparation failed",
        );
      }
      return {
        developerInstructions,
        runtimeViewMappings,
        checks,
      };
    },
    release() {
      // Repeated/concurrent calls share one cleanup promise.
      return (releasePromise ??= (async () => {
        const errors = await releaseAcquired();
        for (const error of errors)
          log("warn", "feature.runtime_release_failed", { error });
        if (errors.length > 0)
          throwAggregated(errors, "Runtime feature release failed");
      })());
    },
  };
};

export interface ComposedRunFeatures {
  readonly matched: readonly string[];
  prepareRunInput(input: AgentInput, signal: AbortSignal): Promise<AgentInput>;
}

export const composeRunFeatures = (input: {
  readonly view: ActivationFeatureView;
  readonly features: readonly FeatureDeclaration[];
  readonly logger?: ComposedLogger;
}): ComposedRunFeatures => {
  const catalog = input.features;
  assertValidFeatureCatalog(catalog);
  const bound = matchedFeatures<"run", NonNullable<FeatureDeclaration["run"]>>(
    catalog,
    "run",
    {
      agentType: input.view.agentType,
      contextKind: input.view.ref.kind,
    },
  ).map(({ feature, declaration }) => {
    const handlers = declaration.create(input.view);
    assertHandlersMatchPorts(feature, "run", declaration, handlers);
    return { feature, declaration, handlers };
  });
  return {
    matched: bound.map((entry) => entry.feature.id),
    async prepareRunInput(runInput, signal) {
      let current = runInput;
      for (const { handler } of orderedHandlers(bound, "prepareRunInput")) {
        signal.throwIfAborted();
        current = await handler(input.view, current, signal);
        // A cancellation landing during the wait must still unwind here.
        signal.throwIfAborted();
      }
      // An empty composition (no prepareRunInput handlers) still honors cancel.
      signal.throwIfAborted();
      return current;
    },
  };
};
