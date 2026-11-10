import type {
  DaemonToAgentEnvelope,
  OperationPrepare,
  OperationPrepared,
  RunnerHello,
} from "@linger/wire-contracts/runner-gateway/types";
import { isRecord } from "@linger/service-kit";
import { isDeepStrictEqual } from "node:util";
import { RUN_PRIORITY } from "../../model-tasks.js";
import { logAgentEvent } from "../observability/agent-log.js";
import {
  LocalComputerOfflineError,
  resolveOperationModel,
} from "./local-computer-management.js";
import type { ModelEndpoint, ModelLease } from "./model-queue.js";
import { isServingConnection } from "./runner-connections.js";
import type {
  CapacitySignal,
  ConnectedRunner,
  InvalidOperationFrame,
  RetiredOperationPreparation,
  RunnerGatewayContext,
  RunnerGatewayControllers,
} from "./runner-gateway-context.js";
import type {
  RunnerCapacityPermit,
  RunnerCapacityTarget,
} from "./runner-operation.js";
import {
  acknowledgeDroppedOperationEvent,
  createOrphanCancel,
  RunnerGatewayError,
  RunnerGatewayProtocolError,
  RunnerOperationState,
  type OperationEnvelope,
  type RunnerOperation,
  type RunnerOperationTarget,
} from "./runner-operation.js";

// These events only change what the Room shows while a Run works; nothing the
// Run settles on reads them.
const DISPLAY_EVENT_TYPES = new Set([
  "status.changed",
  "plan.updated",
  "activity.started",
  "activity.updated",
  "activity.finished",
]);
const EVENT_KIND = /^[a-z_.]{1,64}$/;
const EVENT_FIELD = /^[a-z_]{1,64}$/;

/** The kind and field names of an invalid Run event, without values. */
const invalidEvent = (
  frame: OperationEnvelope,
): { kind: string; fields: string } | undefined => {
  if (frame.type !== "operation.event") return undefined;
  const event: unknown = (frame as { event?: unknown }).event;
  if (
    !isRecord(event) ||
    typeof event.type !== "string" ||
    !EVENT_KIND.test(event.type)
  )
    return undefined;
  return {
    kind: event.type,
    fields: Object.keys(event)
      .filter((key) => EVENT_FIELD.test(key))
      .slice(0, 16)
      .join(","),
  };
};

/**
 * The Runner Operations this Agent Service process started, kept in memory.
 * An Operation is admitted on the current connection of the Computer TeamHub
 * places its Agent on; anything a Computer reports for an Operation this
 * process does not hold is acknowledged and dropped.
 */
export class RunnerOperations {
  readonly #operations = new Map<string, RunnerOperationState>();

  // Retired Operations whose inputs still await a closed receipt from the
  // Daemon. They hold no capacity or lease; only receipts are routed to them.
  readonly #awaitingInputReceipts = new Map<string, RunnerOperationState>();

  // Each Operation's model place, keyed by operation id, held until it retires.
  readonly #leases = new Map<string, ModelLease>();

  // Reconstructible reservations only: TeamHub remains the durable Run queue.
  readonly #capacityReservations = new Map<
    string,
    {
      target: RunnerCapacityTarget;
      connection: ConnectedRunner;
      operationId?: string;
    }
  >();

  readonly #capacityWaiters = new Set<RunnerCapacityTarget>();

  #capacitySignal = capacitySignal();

  constructor(
    private readonly context: RunnerGatewayContext,
    private readonly owners: Pick<
      RunnerGatewayControllers,
      "connections" | "lifecycle" | "preparation" | "queue"
    >,
  ) {}

  // Every change that can free capacity or end a wait calls this.
  wakeCapacityWaiters(): void {
    const { notify } = this.#capacitySignal;
    this.#capacitySignal = capacitySignal();
    notify();
  }

  async acquireOperationCapacity(
    target: RunnerCapacityTarget,
    signal: AbortSignal,
  ): Promise<RunnerCapacityPermit> {
    const waiter = { ...target };
    this.#capacityWaiters.add(waiter);
    try {
      for (;;) {
        signal.throwIfAborted();
        // Taken before any read, so a change during the reads still wakes us.
        const { changed } = this.#capacitySignal;
        const connection = this.owners
          .connections()
          .getConnection(target.runnerId);
        if (!isServingConnection(connection)) {
          // Waiting for capacity is not waiting for connectivity: an offline
          // Computer fails the Run visibly.
          throw new LocalComputerOfflineError(
            "Local Computer is offline or not yet reconciled",
          );
        }
        const active = this.activeOperations(target.runnerId);
        const reservations = [...this.#capacityReservations.values()].filter(
          (item) =>
            item.target.runnerId === target.runnerId && !item.operationId,
        );
        const occupied = [
          ...active.map((operation) => ({
            runnerId: operation.start.runner_id,
            tenantId: operation.start.tenant_id,
            agentId: operation.start.agent_id,
            executionContextKey: operation.start.execution_context_key,
          })),
          ...reservations.map((item) => item.target),
        ];
        const isBusy = (candidate: RunnerCapacityTarget): boolean =>
          occupied.some(
            (other) =>
              candidate.runnerId === other.runnerId &&
              candidate.tenantId === other.tenantId &&
              candidate.executionContextKey === other.executionContextKey,
          );
        const busy = isBusy(target);
        // FIFO among runnable waiters; a busy Context never blocks an unrelated one.
        const earlierConflict = [...this.#capacityWaiters]
          .slice(0, [...this.#capacityWaiters].indexOf(waiter))
          .some(
            (other) => other.runnerId === target.runnerId && !isBusy(other),
          );
        if (
          !busy &&
          !earlierConflict &&
          (connection.hello.capacity === undefined ||
            active.length + reservations.length < connection.hello.capacity)
        ) {
          const id = this.context.createId();
          this.#capacityReservations.set(id, { target, connection });
          return {
            id,
            release: () => {
              if (this.#capacityReservations.delete(id))
                this.wakeCapacityWaiters();
            },
          };
        }
        await waitForCapacityChange(changed, signal);
      }
    } finally {
      this.#capacityWaiters.delete(waiter);
      // A leaving waiter may have held the FIFO position others wait behind.
      this.wakeCapacityWaiters();
    }
  }

  async startOperation(
    target: RunnerOperationTarget,
  ): Promise<RunnerOperation> {
    // Readiness is checked once, after any capacity wait.
    const permit =
      target.capacityPermit ??
      (await this.acquireOperationCapacity(
        target,
        new AbortController().signal,
      ));
    try {
      // The whole Run is one unit of its endpoint's model queue. It waits
      // holding its capacity, and readiness is checked after both waits.
      const lease = await this.owners.queue().acquire(
        {
          computerId: target.runnerId,
          runtimeType: target.request.runtime.type,
        },
        {
          priority: RUN_PRIORITY,
          kind: target.runKind ?? "chat",
          key: target.request.run_context.execution_run_ref,
        },
        target.signal ?? new AbortController().signal,
      );
      try {
        const reservation = this.#capacityReservations.get(permit.id);
        if (
          !reservation ||
          reservation.operationId ||
          reservation.target.runnerId !== target.runnerId ||
          reservation.target.agentId !== target.agentId ||
          reservation.target.executionContextKey !==
            target.executionContextKey ||
          reservation.connection !==
            this.owners.connections().getConnection(target.runnerId)
        ) {
          throw new RunnerGatewayError(
            "Operation capacity reservation is no longer valid",
          );
        }
        return await this.#startReservedOperation(target, permit.id, lease);
      } catch (error) {
        lease.release({ outcome: "not_sent" });
        throw error;
      }
    } finally {
      permit.release();
    }
  }

  /** Whether this Run Operation holds its model place on endpoint, which an
   * approval of its actions borrows. */
  holdsModelPlace(
    operationId: string | undefined,
    endpoint: ModelEndpoint,
  ): boolean {
    if (!operationId || !this.#leases.has(operationId)) return false;
    const operation = this.#operations.get(operationId);
    return (
      operation?.start.runner_id === endpoint.computerId &&
      operation.start.runtime_type === endpoint.runtimeType
    );
  }

  /**
   * Admits an Operation on the Computer's current connection. Admission needs
   * the ready Agent Runner of the placement TeamHub's registration row named
   * for this Run: the Runner's revision and the connection epoch fence the
   * Operation on the Computer, so a Runner or connection replaced later ends
   * it there.
   */
  async #startReservedOperation(
    target: RunnerOperationTarget,
    capacityPermitId: string,
    lease: ModelLease,
  ): Promise<RunnerOperation> {
    const model = this.owners
      .preparation()
      .requireEligibleRunner(target, target.request.runtime);
    const resolvedTarget = resolveOperationModel(target, model);
    const desiredRunner = this.owners.lifecycle().desiredAssertOperation({
      computerId: resolvedTarget.runnerId,
      tenantId: resolvedTarget.tenantId,
      agentId: resolvedTarget.agentId,
      runtime: resolvedTarget.request.runtime,
      workspaceGrantId: resolvedTarget.workspaceGrantId,
    });
    const connection = this.owners
      .connections()
      .getConnection(resolvedTarget.runnerId);
    if (!isServingConnection(connection)) {
      throw new RunnerGatewayError(
        `Runner "${resolvedTarget.runnerId}" is not ready`,
      );
    }
    if (!resolvedTarget.ownerActorId) {
      throw new RunnerGatewayError("Operation target lacks the Computer owner");
    }
    const reservation = this.#capacityReservations.get(capacityPermitId);
    if (!reservation)
      throw new RunnerGatewayError(
        "Operation reservation was released before admission",
      );
    const operation = new RunnerOperationState({
      target: resolvedTarget,
      connectionEpoch: connection.connectionEpoch,
      runnerRevision: desiredRunner.runnerRevision,
      createId: this.context.createId,
      send: (command) => this.owners.connections().sendToCurrentRunner(command),
      cancelTimeoutMs: this.context.operationCancelTimeoutMs,
      runtimeAssignment: {
        registrationId: desiredRunner.registrationId,
        assignmentRevision: desiredRunner.assignmentRevision,
      },
    });
    this.#operations.set(operation.start.operation_id, operation);
    this.#leases.set(operation.start.operation_id, lease);
    reservation.operationId = operation.start.operation_id;
    const prepare = operation.prepareCommand();
    try {
      if (prepare) await this.owners.connections().send(connection, prepare);
      // Admission was validated against this exact connection.
      await this.owners.connections().send(connection, operation.start);
    } catch (error) {
      if (prepare) retireOperationPreparation(connection, prepare);
      this.#operations.delete(operation.start.operation_id);
      this.#releaseLease(operation, "not_sent");
      if (reservation.operationId === operation.start.operation_id)
        reservation.operationId = undefined;
      this.wakeCapacityWaiters();
      throw error;
    }
    this.#recordRunOperation(operation);
    return operation.handle();
  }

  /**
   * Records a run.start Operation on its Run, and its usage once it ends.
   * Message activities and usage totals read the record; the Run's own
   * outcome never waits for it.
   */
  #recordRunOperation(operation: RunnerOperationState): void {
    const record = this.context.options.recordRunOperation;
    const epoch = operation.epoch;
    if (!record || !epoch || operation.start.request.kind !== "run.start")
      return;
    const usage = operation.terminal ? operation.usage : undefined;
    if (operation.terminal && !usage) return;
    void record({
      contextKey: operation.start.execution_context_key,
      epoch,
      runId: operation.start.request.run_context.execution_run_ref,
      operationId: operation.start.operation_id,
      runtimeType: operation.start.runtime_type,
      ...(usage ? { usage } : {}),
    }).catch((error: unknown) =>
      logAgentEvent("warn", "runner.operation.record_failed", {
        operationId: operation.start.operation_id,
        terminal: operation.terminal,
        error,
      }),
    );
  }

  // One invalid event must not close every later connection: the Daemon
  // would replay it on each one. A frame whose identity matches a known
  // Operation fails that Operation; either way it is acknowledged. An invalid
  // display event of a running Operation is dropped instead: the Run goes on
  // and the Room keeps the last valid status.
  async receiveInvalidOperation(
    connection: ConnectedRunner,
    { frame, details }: InvalidOperationFrame,
  ): Promise<void> {
    this.owners.connections().assertCurrentConnection(connection);
    if (frame.runner_id !== connection.runnerId) {
      throw new RunnerGatewayProtocolError("Invalid Runner Gateway envelope");
    }
    const operation = this.#operations.get(frame.operation_id);
    operation?.assertIdentity(frame);
    const event = invalidEvent(frame);
    if (
      operation &&
      !operation.terminal &&
      event &&
      DISPLAY_EVENT_TYPES.has(event.kind)
    ) {
      const acknowledgement = await operation.receiveUnapplied(frame);
      logAgentEvent("error", "runner.operation.invalid_display_event_dropped", {
        runnerId: connection.runnerId,
        operationId: frame.operation_id,
        sequence: frame.seq,
        eventKind: event.kind,
        eventFields: event.fields,
        schemaErrors: details,
      });
      await this.owners.connections().send(connection, acknowledgement);
      return;
    }
    const failedActive = operation?.terminal === false;
    if (operation) {
      await operation.failInvalidEvent(frame.seq);
      this.#retireOperation(operation);
    }
    logAgentEvent("error", "runner.operation.invalid_event_rejected", {
      runnerId: connection.runnerId,
      operationId: frame.operation_id,
      eventType: frame.type,
      eventKind: event?.kind,
      eventFields: event?.fields,
      sequence: frame.seq,
      failedActiveOperation: failedActive,
      schemaErrors: details,
    });
    await this.owners
      .connections()
      .send(
        connection,
        acknowledgeDroppedOperationEvent(frame, this.context.createId()),
      );
  }

  /**
   * Runs once the connection's Agent Runners match the registration rows.
   * Operations of an Agent no longer placed on this Computer end here and
   * are cancelled there; the others resume by operation_id. An Operation the
   * Computer reports that this process does not hold is cancelled.
   */
  async completeOperationReconciliation(
    connection: ConnectedRunner,
  ): Promise<void> {
    this.owners.connections().assertCurrentConnection(connection);
    if (!connection.operationReconciled) {
      const abandoned = new Set<string>();
      for (const operation of this.retainedOperations(connection.runnerId)) {
        if (
          operation.terminal ||
          this.owners
            .lifecycle()
            .places(
              connection.runnerId,
              operation.start.tenant_id,
              operation.start.agent_id,
            )
        )
          continue;
        await operation.abandon(
          "agent_moved",
          "The Agent no longer runs on this Computer",
        );
        abandoned.add(operation.start.operation_id);
        this.#retireOperation(operation);
      }
      const retainedByDaemon = new Set(
        connection.reportedActiveOperations.map(
          (operation) => operation.operation_id,
        ),
      );
      for (const operation of this.retainedOperations(connection.runnerId)) {
        for (const command of operation.reconnectCommands({
          connectionEpoch: connection.connectionEpoch,
          retainedByDaemon: retainedByDaemon.has(operation.start.operation_id),
        })) {
          await this.owners.connections().send(connection, command);
        }
      }
      for (const orphan of connection.reportedActiveOperations) {
        if (
          !this.#operations.has(orphan.operation_id) &&
          !abandoned.has(orphan.operation_id)
        ) {
          await this.owners
            .connections()
            .send(
              connection,
              createOrphanCancel(orphan, this.context.createId()),
            );
        }
      }
      connection.operationReconciled = true;
    }
    this.owners.connections().assertCurrentConnection(connection);
    // Later Agent Runner changes call this again; the Computer is already ready.
    if (connection.phase === "ready") return;
    await this.context.computerRegistry?.touch(connection.runnerId, {
      status: "online",
      seenAt: new Date().toISOString(),
      activeOperations: this.activeOperations(connection.runnerId).length,
    });
    connection.phase = "ready";
    this.owners.connections().notifyLocalComputerReady(connection.runnerId);
    await this.owners.connections().send(connection, {
      type: "runner.reconciled",
      protocol_version: connection.hello.protocol_version,
      runner_id: connection.runnerId,
      connection_epoch: connection.connectionEpoch,
    });
    this.owners.connections().armHeartbeat(connection);
  }

  retainedOperations(runnerId: string): RunnerOperationState[] {
    return [...this.#operations.values()].filter(
      (operation) => operation.start.runner_id === runnerId,
    );
  }

  activeOperations(runnerId: string): RunnerOperationState[] {
    return this.retainedOperations(runnerId).filter(
      (operation) => !operation.terminal,
    );
  }

  /**
   * The Computer's connection closed or was replaced. A receipt answers on
   * the connection that carried its input, and a terminal Operation never
   * resends one, so its inputs still awaiting a receipt are uncertain now.
   */
  expireInputReceipts(runnerId: string): void {
    for (const operation of this.#awaitingInputReceipts.values())
      if (operation.start.runner_id === runnerId)
        operation.expireInputReceipts();
  }

  #retireOperation(operation: RunnerOperationState): void {
    const operationId = operation.start.operation_id;
    if (this.#operations.get(operationId) !== operation) {
      return;
    }
    // A terminal Operation no longer counts against capacity.
    this.wakeCapacityWaiters();
    this.#recordRunOperation(operation);
    const prepare = operation.prepareCommand();
    const connection = this.owners
      .connections()
      .getConnection(operation.start.runner_id);
    // Preparation can finish after the terminal wins the transport race.
    // Keep only its authenticated identity; the terminal owns measurement.
    if (prepare && connection) retireOperationPreparation(connection, prepare);
    this.#operations.delete(operationId);
    this.#releaseLease(operation, operation.outcomeType ?? "retired");
    const receipts = operation.inputReceipts();
    if (receipts) {
      this.#awaitingInputReceipts.set(operationId, operation);
      void receipts.then(() => {
        if (this.#awaitingInputReceipts.get(operationId) === operation)
          this.#awaitingInputReceipts.delete(operationId);
      });
    }
  }

  #releaseLease(operation: RunnerOperationState, outcome: string): void {
    const operationId = operation.start.operation_id;
    const usage = operation.usage;
    this.#leases.get(operationId)?.release({
      outcome,
      ...(usage ? { usage } : {}),
    });
    this.#leases.delete(operationId);
  }

  /** A hello must report this process's Operations with their own identity. */
  validateReconciliationInventory(hello: RunnerHello): void {
    for (const active of hello.active_operations)
      this.#operations.get(active.operation_id)?.assertIdentity(active);
  }

  async receiveOperation(
    connection: ConnectedRunner,
    envelope: Extract<DaemonToAgentEnvelope, { operation_id: string }>,
  ): Promise<void> {
    if (
      envelope.type === "operation.input_result" &&
      envelope.outcome === "closed"
    ) {
      // An input closed by an Operation this process no longer holds needs
      // no answer.
      await (
        this.#operations.get(envelope.operation_id) ??
        this.#awaitingInputReceipts.get(envelope.operation_id)
      )?.receiveClosedInput(envelope);
      return;
    }
    if (envelope.type === "prepared") {
      const operation = this.#operations.get(envelope.operation_id);
      if (!operation) {
        const retired = connection.retiredOperationPreparations.get(
          envelope.operation_id,
        );
        if (retired) {
          if (!operationPreparedMatches(retired, envelope)) {
            throw new RunnerGatewayProtocolError(
              "Runner emitted an unmatched Operation MCP prepare outcome",
            );
          }
          return;
        }
        throw new RunnerGatewayProtocolError(
          "Runner MCP prepare outcome targets an unknown operation",
        );
      }
      await operation.receivePrepared(envelope);
      return;
    }
    const operation = this.#operations.get(envelope.operation_id);
    if (!operation || operation.start.runner_id !== connection.runnerId) {
      logAgentEvent("warn", "runner.operation.late_event_dropped", {
        runnerId: connection.runnerId,
        operationId: envelope.operation_id,
        agentId: envelope.agent_id,
        eventType: envelope.type,
        sequence: envelope.seq,
      });
      await this.owners
        .connections()
        .send(
          connection,
          acknowledgeDroppedOperationEvent(envelope, this.context.createId()),
        );
      return;
    }
    const acknowledgement = await operation.receive(envelope);
    if (operation.terminal) this.#retireOperation(operation);
    if (acknowledgement)
      await this.owners.connections().send(connection, acknowledgement);
  }

  getOperation(operationId: string): RunnerOperationState | undefined {
    return this.#operations.get(operationId);
  }

  allOperations(): IterableIterator<RunnerOperationState> {
    return this.#operations.values();
  }
}

const capacitySignal = (): CapacitySignal => {
  let notify!: () => void;
  const changed = new Promise<void>((resolve) => {
    notify = resolve;
  });
  return { changed, notify };
};

// A missed wake costs at most this long.
const CAPACITY_RECHECK_INTERVAL_MS = 5_000;

const waitForCapacityChange = (
  changed: Promise<void>,
  signal: AbortSignal,
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      finish();
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      finish();
      resolve();
    }, CAPACITY_RECHECK_INTERVAL_MS);
    signal.addEventListener("abort", abort, { once: true });
    void changed.then(() => {
      finish();
      resolve();
    });
  });

const MAX_RETIRED_OPERATION_PREPARATIONS = 1_024;

const retireOperationPreparation = (
  connection: ConnectedRunner,
  prepare: OperationPrepare,
): void => {
  const retired = connection.retiredOperationPreparations;
  if (
    retired.size >= MAX_RETIRED_OPERATION_PREPARATIONS &&
    !retired.has(prepare.operation_id)
  ) {
    const oldestOperationId = retired.keys().next().value;
    if (oldestOperationId !== undefined) retired.delete(oldestOperationId);
  }
  retired.set(prepare.operation_id, {
    commandId: prepare.command_id,
    identity: operationMCPPrepareIdentity(prepare),
  });
};

const operationPreparedMatches = (
  prepare: RetiredOperationPreparation,
  outcome: OperationPrepared,
): boolean =>
  outcome.command_id === prepare.commandId &&
  outcome.prepare_command_id === prepare.commandId &&
  isDeepStrictEqual(operationMCPPrepareIdentity(outcome), prepare.identity);

export const operationMCPPrepareIdentity = (
  value: OperationPrepare | OperationPrepared,
) => ({
  protocol_version: value.protocol_version,
  host_access: value.host_access,
  tenant_id: value.tenant_id,
  registration_id: value.registration_id,
  assignment_revision: value.assignment_revision,
  runner_id: value.runner_id,
  execution_context_key: value.execution_context_key,
  runtime_instance_id: value.runtime_instance_id,
  context_view_ref: value.context_view_ref,
  agent_id: value.agent_id,
  operation_id: value.operation_id,
  connection_epoch: value.connection_epoch,
  runner_revision: value.runner_revision,
  generation: value.generation,
  execution_lease_id: value.execution_lease_id,
  workspace_grant_id: value.workspace_grant_id,
  runtime_type: value.runtime_type,
});
