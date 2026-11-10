import type {
  DaemonToAgentEnvelope,
  DebugInspect,
  DebugInspected,
  DebugHistoryInspectionRequest,
  DebugHistoryInspectionResult,
} from "@linger/wire-contracts/runner-gateway/types";
import {
  RUNNER_GATEWAY_PROTOCOL_VERSION,
  parseAgentToDaemonEnvelope,
} from "@linger/wire-contracts/runner-gateway/validator";
import {
  AgentRunnerDesiredStateError,
  type AgentRunnerDesiredRecord,
  type AgentRunnerDesiredState,
} from "./agent-runner-desired-state.js";
import { LocalComputerOfflineError } from "./local-computer-management.js";
import { isServingConnection } from "./runner-connections.js";
import type {
  ConnectedRunner,
  DebugInspectionWaiter,
  DetachedLocalHistoryRequest,
  LocalContextViewIdentity,
  RunnerGatewayContext,
  RunnerGatewayControllers,
} from "./runner-gateway-context.js";
import {
  RunnerGatewayError,
  RunnerGatewayProtocolError,
} from "./runner-operation.js";

export class RunnerDebugInspection {
  readonly #debugInspectionWaiters = new Map<string, DebugInspectionWaiter>();

  constructor(
    private readonly context: RunnerGatewayContext,
    private readonly owners: Pick<
      RunnerGatewayControllers,
      "connections" | "lifecycle" | "preparation"
    >,
  ) {}

  async inspectDetachedLocalHistory(
    options: DetachedLocalHistoryRequest,
  ): Promise<DebugHistoryInspectionResult> {
    options.signal?.throwIfAborted();
    const { placement } = options;
    const connection = this.owners
      .preparation()
      .requireReadyRuntime(placement.computerId, placement.runtimeType);
    if (
      connection.tenantOwners.get(placement.tenantId) !== placement.ownerActorId
    ) {
      throw new RunnerGatewayError(
        "Local History owner does not match Computer authorization",
      );
    }
    // A cold Context has no in-process Agent Runner desired state, and History
    // is a read-only request that must not create one. Send the Runner identity
    // when this process knows it, and otherwise let the Runner authorize the
    // read from its own ready Assignment. The identity is all-or-nothing so the
    // Runner never has to reconcile a half-specified one.
    const desired = this.owners.lifecycle().desiredReadyOperation({
      computerId: placement.computerId,
      tenantId: placement.tenantId,
      agentId: options.agentId,
      runtime: options.request.runtime,
      workspaceGrantId: placement.workspaceGrantId,
    });
    const command = parseAgentToDaemonEnvelope({
      type: "execute",
      kind: "debug_history",
      protocol_version: RUNNER_GATEWAY_PROTOCOL_VERSION,
      command_id: this.context.createId(),
      tenant_id: placement.tenantId,
      runner_id: placement.computerId,
      agent_id: options.agentId,
      connection_epoch: connection.connectionEpoch,
      workspace_grant_id: placement.workspaceGrantId,
      ...(desired
        ? {
            runner_revision: desired.runnerRevision,
            registration_id: desired.registrationId,
            assignment_revision: desired.assignmentRevision,
          }
        : {}),
      execution_context_key: options.executionContextKey,
      runtime_instance_id: options.runtimeInstanceId,
      detached_history: true,
      request: options.request,
    });
    if (command.type !== "execute" || command.kind !== "debug_history")
      throw new RunnerGatewayProtocolError("Invalid history command");
    const outcome = this.#waitForDebugInspection(command, options.signal);
    try {
      await this.owners.connections().sendToCurrentRunner(command);
    } catch (error) {
      this.#finishDebugInspection(command.command_id, { error });
    }
    return (await outcome).result;
  }

  inspectLocalContext(options: {
    readonly context: LocalContextViewIdentity;
    readonly request: DebugHistoryInspectionRequest;
    readonly signal?: AbortSignal;
  }): Promise<DebugHistoryInspectionResult> {
    return this.#dispatchDebugInspection(options);
  }

  /** Whether detached native history can be read from this Computer now. */
  canReadDetachedHistory(
    computerId: string,
    runtimeType: "codex" | "claude" | "pi",
  ): boolean {
    const connection = this.owners.connections().getConnection(computerId);
    if (!isServingConnection(connection)) return false;
    return (
      connection.hello.runtime_diagnostics?.find(
        ({ type }) => type === runtimeType,
      )?.status === "ready"
    );
  }

  // An inspection result over the frame limits fails that inspection only;
  // closing the connection would repeat the same request after reconnect.
  receiveInvalidDebugInspection(
    connection: ConnectedRunner,
    commandId: string,
  ): void {
    const waiter = this.#debugInspectionWaiters.get(commandId);
    if (waiter?.command.runner_id !== connection.runnerId) return;
    this.#finishDebugInspection(commandId, {
      error: new RunnerGatewayError(
        "Debug inspection result violates the Runner contract",
      ),
    });
  }

  async #dispatchDebugInspection(options: {
    readonly context: LocalContextViewIdentity;
    readonly request: DebugHistoryInspectionRequest;
    readonly signal?: AbortSignal;
  }): Promise<DebugHistoryInspectionResult> {
    options.signal?.throwIfAborted();
    const connection = this.owners
      .connections()
      .getConnection(options.context.computerId);
    // Bound to the Context's current View, so it serves existing work.
    if (!isServingConnection(connection)) {
      throw new LocalComputerOfflineError();
    }
    const desiredRunner = assertContextRead(
      options.context,
      this.owners.lifecycle().contextReadAuthority(),
    );
    if (
      connection !==
        this.owners.connections().getConnection(options.context.computerId) ||
      !isServingConnection(connection)
    ) {
      throw new LocalComputerOfflineError(
        "Local Computer connection changed during Context read",
      );
    }
    options.signal?.throwIfAborted();
    const command = parseAgentToDaemonEnvelope({
      type: "execute",
      kind: "debug_history",
      protocol_version: RUNNER_GATEWAY_PROTOCOL_VERSION,
      command_id: this.context.createId(),
      tenant_id: options.context.tenantId,
      registration_id: desiredRunner.registrationId,
      assignment_revision: desiredRunner.assignmentRevision,
      runner_id: options.context.computerId,
      agent_id: options.context.agentId,
      connection_epoch: connection.connectionEpoch,
      runner_revision: options.context.runnerRevision,
      workspace_grant_id: options.context.workspaceGrantId,
      execution_context_key: options.context.executionContextKey,
      runtime_instance_id: options.context.runtimeInstanceId,
      view_digest: options.context.viewDigest,
      request: options.request,
    });
    if (command.type !== "execute" || command.kind !== "debug_history") {
      throw new RunnerGatewayProtocolError("Invalid Debug inspection command");
    }
    const outcome = this.#waitForDebugInspection(command, options.signal);
    try {
      await this.owners.connections().sendToCurrentRunner(command);
    } catch (error) {
      this.#finishDebugInspection(command.command_id, { error });
    }
    return (await outcome).result;
  }

  receiveDebugInspection(outcome: DebugInspected): void {
    const waiter = this.#debugInspectionWaiters.get(outcome.command_id);
    if (!waiter) return;
    assertDebugInspectionOutcome(waiter.command, outcome);
    this.#finishDebugInspection(outcome.command_id, { outcome });
  }

  #waitForDebugInspection(
    command: DebugInspect,
    signal?: AbortSignal,
  ): Promise<DebugInspected> {
    return new Promise<DebugInspected>((resolve, reject) => {
      if (this.#debugInspectionWaiters.has(command.command_id)) {
        reject(new RunnerGatewayProtocolError("Duplicate Debug inspection id"));
        return;
      }
      const onAbort = () =>
        this.#finishDebugInspection(command.command_id, {
          error: signal?.reason ?? new Error("Debug inspection was cancelled"),
        });
      const timer = setTimeout(
        () =>
          this.#finishDebugInspection(command.command_id, {
            error: new RunnerGatewayError("Debug inspection timed out"),
          }),
        this.context.debugInspectionTimeoutMs,
      );
      timer.unref();
      this.#debugInspectionWaiters.set(command.command_id, {
        command,
        signal,
        timer,
        onAbort,
        resolve,
        reject,
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  #finishDebugInspection(
    commandId: string,
    result: { readonly outcome: DebugInspected } | { readonly error: unknown },
  ): void {
    const waiter = this.#debugInspectionWaiters.get(commandId);
    if (!waiter) return;
    this.#debugInspectionWaiters.delete(commandId);
    clearTimeout(waiter.timer);
    waiter.signal?.removeEventListener("abort", waiter.onAbort);
    if ("outcome" in result) waiter.resolve(result.outcome);
    else waiter.reject(result.error);
  }

  rejectWaitersForComputer(runnerId: string): void {
    for (const [commandId, waiter] of this.#debugInspectionWaiters) {
      if (waiter.command.runner_id !== runnerId) continue;
      this.#finishDebugInspection(commandId, {
        error: new LocalComputerOfflineError(),
      });
    }
  }
}

export const isDebugInspectionOutcome = (
  envelope: DaemonToAgentEnvelope,
): envelope is DebugInspected =>
  envelope.type === "executed" && envelope.kind === "debug_history";

const assertContextRead = (
  context: LocalContextViewIdentity,
  coordinator: Pick<AgentRunnerDesiredState, "assertContextView">,
): AgentRunnerDesiredRecord => {
  try {
    return coordinator.assertContextView({
      computerId: context.computerId,
      tenantId: context.tenantId,
      agentId: context.agentId,
      runnerRevision: context.runnerRevision,
      workspaceGrantId: context.workspaceGrantId,
    });
  } catch (error) {
    if (error instanceof AgentRunnerDesiredStateError) {
      throw new RunnerGatewayError(error.message);
    }
    throw error;
  }
};

const assertDebugInspectionOutcome = (
  command: DebugInspect,
  outcome: DebugInspected,
): void => {
  if (
    outcome.protocol_version !== command.protocol_version ||
    outcome.command_id !== command.command_id ||
    outcome.tenant_id !== command.tenant_id ||
    outcome.registration_id !== command.registration_id ||
    outcome.assignment_revision !== command.assignment_revision ||
    outcome.runner_id !== command.runner_id ||
    outcome.agent_id !== command.agent_id ||
    outcome.connection_epoch !== command.connection_epoch ||
    outcome.runner_revision !== command.runner_revision ||
    outcome.workspace_grant_id !== command.workspace_grant_id ||
    outcome.execution_context_key !== command.execution_context_key ||
    outcome.runtime_instance_id !== command.runtime_instance_id ||
    outcome.view_digest !== command.view_digest ||
    outcome.detached_history !== command.detached_history
  ) {
    throw new RunnerGatewayProtocolError(
      "Debug inspection outcome identity mismatch",
    );
  }
};
