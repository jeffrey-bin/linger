import type { RuntimeConfig } from "@linger/wire-contracts/runner-gateway/types";
import {
  AgentRunnerDesiredState,
  AgentRunnerDesiredStateError,
  agentRunnerKey,
  type AgentRunnerDesiredRecord,
  type AgentRunnerOutcome,
  type AgentRunnerPlacement,
} from "./agent-runner-desired-state.js";
import { AgentRunnerConnectionReconciliation } from "./agent-runner-reconciliation.js";
import {
  findRuntimeModel,
  LocalAgentRunnerReadinessError,
  type LocalPlacementRequirement,
  type LocalRuntimeModelCatalog,
  withSupportedReasoningEffort,
} from "./local-computer-management.js";
import {
  runtimeRegistrationId,
  type RunnerPlacement,
} from "./local-computer-registry.js";
import type {
  AgentRunnerStateWaiter,
  ConnectedRunner,
  LocalAgentRunnerOptions,
  RunnerGatewayContext,
  RunnerGatewayControllers,
} from "./runner-gateway-context.js";
import {
  RunnerGatewayError,
  RunnerGatewayProtocolError,
} from "./runner-operation.js";
import { logAgentEvent } from "../observability/agent-log.js";

import { assertReasoningEffort } from "./runner-operation-preparation.js";

/**
 * Keeps each connected Computer's Agent Runners on the placement TeamHub's
 * registration rows name. A Computer's Runners are computed when it connects;
 * a Run, a registration change or a deletion adjusts the connected
 * Computers. A Computer that is not connected learns of a move or deletion
 * when it connects again.
 */
export class AgentRunnerLifecycle {
  readonly #agentRunners = new AgentRunnerDesiredState();

  readonly #agentRunnerStateWaiters = new Map<
    string,
    Set<AgentRunnerStateWaiter>
  >();

  readonly #agentMutationTails = new Map<string, Promise<void>>();

  constructor(
    private readonly context: RunnerGatewayContext,
    private readonly owners: Pick<
      RunnerGatewayControllers,
      "cli" | "connections" | "operations" | "preparation"
    >,
  ) {}

  /** Read current authority without creating, moving or waiting for a Runner. */
  readReadyLocalAgentRunnerRevision(options: LocalAgentRunnerOptions): number {
    options.signal?.throwIfAborted();
    this.owners
      .connections()
      .requireLocalPlacement(
        options.placement,
        options.modelId,
        options.reasoningEffort,
      );
    const placement = this.#runnerPlacement(
      options.agentId,
      options.placement,
      {
        type: options.placement.runtimeType,
        model: options.modelId,
        ...(options.reasoningEffort
          ? { reasoning_effort: options.reasoningEffort }
          : {}),
      },
    );
    const record = this.#agentRunners.assertOperation(placement);
    if (
      record.registrationId !== placement.registrationId ||
      record.assignmentRevision !== placement.assignmentRevision
    ) {
      throw new AgentRunnerDesiredStateError(
        "Agent Runner assignment does not match History",
      );
    }
    return record.runnerRevision;
  }

  async ensureReadyLocalAgentRunner(
    options: LocalAgentRunnerOptions,
  ): Promise<number> {
    options.signal?.throwIfAborted();
    return this.runAgentMutation(options.agentId, async () => {
      this.owners
        .connections()
        .requireLocalPlacement(
          options.placement,
          options.modelId,
          options.reasoningEffort,
        );
      await this.#leaveOtherComputers(
        options.agentId,
        options.placement.computerId,
      );
      const { changed, record } = this.#agentRunners.ensure(
        this.#runnerPlacement(options.agentId, options.placement, {
          type: options.placement.runtimeType,
          model: options.modelId,
          ...(options.reasoningEffort
            ? { reasoning_effort: options.reasoningEffort }
            : {}),
        }),
      );
      if (changed) await this.#apply(record);
      await this.#waitForAgentRunnerReady(record, options.signal);
      return record.runnerRevision;
    });
  }

  /**
   * TeamHub changed the Agent's registration row. The Runner on a Computer it
   * left is removed now when that Computer is connected, and at its next
   * connection otherwise; the new placement is ensured at the next Run.
   */
  async noteAgentPlacement(agentId: string, computerId: string): Promise<void> {
    await this.runAgentMutation(agentId, () =>
      this.#leaveOtherComputers(agentId, computerId),
    );
  }

  /** Removes every Runner of a revoked Agent from its connected Computers. */
  async finalizeDeletedLocalAgentRunner(agentId: string): Promise<void> {
    await this.runAgentMutation(agentId, () =>
      this.#leaveOtherComputers(agentId, undefined),
    );
  }

  async #leaveOtherComputers(
    agentId: string,
    computerId: string | undefined,
  ): Promise<void> {
    for (const record of this.#agentRunners.recordsForAgent(agentId)) {
      if (record.computerId === computerId) continue;
      if (
        !this.owners.connections().getConnection(record.computerId)?.connected
      ) {
        this.#agentRunners.forget(record);
        continue;
      }
      const removal = this.#agentRunners.remove(record);
      this.owners.operations().wakeCapacityWaiters();
      if (removal) await this.#apply(removal);
    }
  }

  /**
   * The Runners a connecting Computer should hold, from the Agents TeamHub
   * places on it. A placement whose model the Computer cannot run is left out;
   * its next Run reports the model error.
   */
  connectionPlacements(
    computerId: string,
    placements: readonly RunnerPlacement[],
  ): AgentRunnerPlacement[] {
    return placements.flatMap((placement) => {
      try {
        return [
          this.#runnerPlacement(
            placement.agentId,
            {
              type: "local",
              tenantId: placement.tenantId,
              ownerActorId: placement.ownerActorId,
              computerId,
              runtimeType: placement.runtimeType,
              workspaceGrantId: placement.workspaceGrantId,
              assignmentRevision: placement.assignmentRevision,
            },
            {
              type: placement.runtimeType,
              model: placement.model,
              ...(placement.reasoningEffort
                ? { reasoning_effort: placement.reasoningEffort }
                : {}),
            },
          ),
        ];
      } catch (error) {
        logAgentEvent("warn", "runner.placement.unavailable", {
          computerId,
          agentId: placement.agentId,
          error,
        });
        return [];
      }
    });
  }

  #runnerPlacement(
    agentId: string,
    placement: LocalPlacementRequirement,
    runtime: RuntimeConfig,
  ): AgentRunnerPlacement {
    return {
      computerId: placement.computerId,
      tenantId: placement.tenantId,
      agentId,
      runtime: resolveRuntimeConfig(
        runtime,
        this.owners
          .preparation()
          .runtimeModelsForComputer(placement.computerId),
      ),
      workspaceGrantId: placement.workspaceGrantId,
      registrationId: runtimeRegistrationId(placement, placement.runtimeType),
      assignmentRevision: placement.assignmentRevision,
    };
  }

  async #apply(record: AgentRunnerDesiredRecord): Promise<void> {
    const connection = this.owners
      .connections()
      .getConnection(record.computerId);
    if (!connection?.connected) return;
    try {
      await connection.agentRunnerReconciliation.apply(record);
    } catch (error) {
      // The next connection computes the Computer's Runners again.
      this.owners.connections().disconnect(connection);
      throw error;
    }
  }

  async runAgentMutation<T>(
    agentId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#agentMutationTails.get(agentId);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => gate);
    this.#agentMutationTails.set(agentId, current);
    await previous?.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.#agentMutationTails.get(agentId) === current) {
        this.#agentMutationTails.delete(agentId);
      }
    }
  }

  async receiveAgentRunnerOutcome(
    connection: ConnectedRunner,
    outcome: AgentRunnerOutcome,
  ): Promise<void> {
    this.owners.cli().observeAgentRunnerOutcome(connection, outcome);
    try {
      await connection.agentRunnerReconciliation.receive(outcome);
      this.#settleAgentRunnerStateWaiters(outcome);
    } catch (error) {
      if (error instanceof AgentRunnerDesiredStateError) {
        throw new RunnerGatewayProtocolError(error.message);
      }
      throw error;
    }
  }

  #waitForAgentRunnerReady(
    record: AgentRunnerDesiredRecord,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const runnerRevision = record.runnerRevision;
    const observed = this.#agentRunners.observedState(record, runnerRevision);
    if (observed.state === "matched") return Promise.resolve();
    if (observed.state === "failed") {
      return Promise.reject(
        new LocalAgentRunnerReadinessError(observed.message),
      );
    }
    return new Promise<void>((resolve, reject) => {
      const key = agentRunnerKey(record);
      const waiters = this.#agentRunnerStateWaiters.get(key) ?? new Set();
      const onAbort = signal
        ? () => {
            const reason =
              signal.reason instanceof Error
                ? signal.reason
                : new DOMException(
                    "Local Agent Runner readiness cancelled",
                    "AbortError",
                  );
            this.#finishAgentRunnerStateWaiter(key, waiter, reason);
          }
        : undefined;
      const waiter: AgentRunnerStateWaiter = {
        runnerRevision,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#finishAgentRunnerStateWaiter(
            key,
            waiter,
            new LocalAgentRunnerReadinessError(),
          );
        }, this.context.agentRunnerReadyTimeoutMs),
        ...(signal ? { signal } : {}),
        ...(onAbort ? { onAbort } : {}),
      };
      waiters.add(waiter);
      this.#agentRunnerStateWaiters.set(key, waiters);
      signal?.addEventListener("abort", onAbort!, { once: true });
      if (signal?.aborted) {
        onAbort!();
        return;
      }
      if (
        !this.owners.connections().getConnection(record.computerId)?.connected
      ) {
        this.#finishAgentRunnerStateWaiter(
          key,
          waiter,
          new LocalAgentRunnerReadinessError("Local Computer disconnected"),
        );
        return;
      }
      const current = this.#agentRunners.observedState(record, runnerRevision);
      if (current.state === "matched") {
        this.#finishAgentRunnerStateWaiter(key, waiter, undefined);
      } else if (current.state === "failed") {
        this.#finishAgentRunnerStateWaiter(
          key,
          waiter,
          new LocalAgentRunnerReadinessError(current.message),
        );
      }
    });
  }

  #settleAgentRunnerStateWaiters(outcome: AgentRunnerOutcome): void {
    const key = agentRunnerKey({
      computerId: outcome.runner_id,
      tenantId: outcome.tenant_id,
      agentId: outcome.agent_id,
    });
    const waiters = this.#agentRunnerStateWaiters.get(key);
    if (!waiters) return;
    for (const waiter of [...waiters]) {
      if (waiter.runnerRevision !== outcome.runner_revision) continue;
      if (outcome.state === "ready") {
        this.#finishAgentRunnerStateWaiter(key, waiter, undefined);
      } else if (outcome.state === "failed") {
        this.#finishAgentRunnerStateWaiter(
          key,
          waiter,
          new LocalAgentRunnerReadinessError(outcome.error.message),
        );
      }
    }
  }

  #finishAgentRunnerStateWaiter(
    key: string,
    waiter: AgentRunnerStateWaiter,
    error: Error | undefined,
  ): void {
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    const waiters = this.#agentRunnerStateWaiters.get(key);
    waiters?.delete(waiter);
    if (waiters?.size === 0) this.#agentRunnerStateWaiters.delete(key);
    if (error) waiter.reject(error);
    else waiter.resolve();
  }

  rejectAgentRunnerStateWaitersForComputer(computerId: string): void {
    for (const [key, waiters] of this.#agentRunnerStateWaiters) {
      if (!key.startsWith(`${computerId}\u0000`)) continue;
      for (const waiter of [...waiters]) {
        this.#finishAgentRunnerStateWaiter(
          key,
          waiter,
          new LocalAgentRunnerReadinessError("Local Computer disconnected"),
        );
      }
    }
  }

  createReconciliation(
    options: Omit<
      ConstructorParameters<typeof AgentRunnerConnectionReconciliation>[0],
      "desiredState"
    >,
  ): AgentRunnerConnectionReconciliation {
    return new AgentRunnerConnectionReconciliation({
      ...options,
      desiredState: this.#agentRunners,
    });
  }

  contextReadAuthority(): Pick<AgentRunnerDesiredState, "assertContextView"> {
    return this.#agentRunners;
  }

  /** Whether the Computer should hold a ready Runner for the Agent. */
  places(computerId: string, tenantId: string, agentId: string): boolean {
    return this.#agentRunners.places(computerId, tenantId, agentId);
  }

  desiredAssertOperation(
    ...args: Parameters<AgentRunnerDesiredState["assertOperation"]>
  ): ReturnType<AgentRunnerDesiredState["assertOperation"]> {
    return this.#agentRunners.assertOperation(...args);
  }

  desiredAssertContextView(
    ...args: Parameters<AgentRunnerDesiredState["assertContextView"]>
  ): ReturnType<AgentRunnerDesiredState["assertContextView"]> {
    return this.#agentRunners.assertContextView(...args);
  }

  desiredReadyOperation(
    ...args: Parameters<AgentRunnerDesiredState["readyOperation"]>
  ): ReturnType<AgentRunnerDesiredState["readyOperation"]> {
    return this.#agentRunners.readyOperation(...args);
  }

  forgetComputer(computerId: string): void {
    this.#agentRunners.forgetComputer(computerId);
  }
}

const resolveRuntimeConfig = (
  runtime: RuntimeConfig,
  catalog: LocalRuntimeModelCatalog,
): RuntimeConfig => {
  if (runtime.model === undefined) {
    return { ...runtime };
  }
  const model = findRuntimeModel(catalog, runtime.type, runtime.model);
  if (!model) {
    throw new RunnerGatewayError(
      `Runner model "${runtime.model}" is unavailable for Runtime "${runtime.type}"`,
    );
  }
  assertReasoningEffort(model, runtime.reasoning_effort, runtime.type);
  const { reasoning_effort } = withSupportedReasoningEffort(runtime, model);
  return {
    type: runtime.type,
    ...(model.runtimeModel === undefined ? {} : { model: model.runtimeModel }),
    ...(reasoning_effort === undefined ? {} : { reasoning_effort }),
  };
};
