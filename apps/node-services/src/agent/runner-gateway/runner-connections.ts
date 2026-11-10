import type {
  AgentToDaemonEnvelope,
  DaemonToAgentEnvelope,
  RunnerHello,
  RunnerWelcome,
  RuntimeRegistration,
} from "@linger/wire-contracts/runner-gateway/types";
import {
  parseAgentToDaemonEnvelope,
  parseDaemonToAgentEnvelope,
} from "@linger/wire-contracts/runner-gateway/validator";
import { logAgentEvent } from "../observability/agent-log.js";
import { TeamHubRuntimeStateError } from "../executor/teamhub-runtime-state-client.js";
import { isAgentRunnerOutcome } from "./agent-runner-reconciliation.js";
import {
  assertRuntimeModelCatalogCapability,
  findRuntimeModel,
  isComputerVersionAtLeast,
  LocalComputerBusyError,
  LocalComputerHasAgentsError,
  LocalComputerModelError,
  LocalComputerNotFoundError,
  LocalComputerOfflineError,
  LocalComputerPlacementError,
  LocalRuntimeAdmissionUnavailableError,
  MINIMUM_CURRENT_COMPUTER_VERSION,
  type LocalPlacementRequirement,
  type LocalReasoningEffort,
  type LocalRuntimeModelDefinition,
} from "./local-computer-management.js";
import { computerTargetRelease } from "./computer-release.js";
import { runtimeRegistrationId } from "./local-computer-registry.js";
import { assertReasoningEffort } from "./runner-operation-preparation.js";
import { isAgentCliCredentialOutcome } from "./runner-cli-credentials.js";
import { isDebugInspectionOutcome } from "./runner-debug-inspection.js";
import type {
  ConnectedRunner,
  RunnerGatewayConnection,
  RunnerGatewayContext,
  RunnerGatewayControllers,
  RunnerGatewayPeer,
} from "./runner-gateway-context.js";
import {
  assertRunnerHelloScope,
  validateRunnerGatewayPrincipal,
  type RunnerGatewayPrincipal,
} from "./runner-gateway-principal.js";
import { isLocalSkillOutcome } from "./runner-local-capabilities.js";
import {
  RunnerGatewayError,
  RunnerGatewayProtocolError,
  RunnerOperationState,
  RunnerUpgradeRequiredError,
} from "./runner-operation.js";

export class RunnerConnections {
  readonly #startedAtMs = Date.now();

  readonly #lastDisconnectedAtMs = new Map<string, number>();

  readonly #localComputerReconnectWaiters = new Map<string, Set<() => void>>();

  readonly #connections = new Map<string, ConnectedRunner>();

  readonly #connectionEpochs = new Map<string, number>();

  readonly #computerMutationTails = new Map<string, Promise<void>>();

  readonly #localComputerReadyListeners = new Set<
    (computerId: string) => void
  >();

  #open: boolean;

  constructor(
    private readonly context: RunnerGatewayContext,
    private readonly owners: Pick<
      RunnerGatewayControllers,
      | "capabilities"
      | "cli"
      | "compaction"
      | "contextViewContent"
      | "debug"
      | "lifecycle"
      | "modelInvocation"
      | "computerTools"
      | "operations"
      | "preparation"
    >,
  ) {
    this.#open = context.options.openConnectionsLater !== true;
  }

  openConnections(): void {
    this.#open = true;
  }

  #requireOpen(): void {
    if (!this.#open)
      throw new LocalComputerOfflineError("Agent Service is starting");
  }

  subscribeLocalComputerReady(
    listener: (computerId: string) => void,
  ): () => void {
    this.#localComputerReadyListeners.add(listener);
    return () => this.#localComputerReadyListeners.delete(listener);
  }

  isLocalComputerExecutionReady(computerId: string): boolean {
    return isServingConnection(this.#connections.get(computerId));
  }

  /** Waits while a Computer that is expected to reconnect is not yet execution-ready. */
  async awaitLocalComputerReconnect(
    computerId: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (isServingConnection(this.#connections.get(computerId))) return;
    const deadline =
      Math.max(
        this.#startedAtMs,
        this.#lastDisconnectedAtMs.get(computerId) ?? 0,
      ) + this.context.localComputerReconnectWaitMs;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return;
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      let waiters = this.#localComputerReconnectWaiters.get(computerId);
      if (waiters === undefined) {
        waiters = new Set();
        this.#localComputerReconnectWaiters.set(computerId, waiters);
      }
      const ownWaiters = waiters;
      const finish = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        ownWaiters.delete(wake);
        if (ownWaiters.size === 0) {
          this.#localComputerReconnectWaiters.delete(computerId);
        }
      };
      const wake = (): void => {
        finish();
        resolve();
      };
      const onAbort = (): void => {
        finish();
        reject(signal.reason);
      };
      const timer = setTimeout(wake, remainingMs);
      timer.unref();
      signal.addEventListener("abort", onAbort, { once: true });
      ownWaiters.add(wake);
    });
  }

  notifyLocalComputerReady(computerId: string): void {
    if (isServingConnection(this.#connections.get(computerId))) {
      this.#lastDisconnectedAtMs.delete(computerId);
      for (const wake of [
        ...(this.#localComputerReconnectWaiters.get(computerId) ?? []),
      ])
        wake();
    }
    for (const listener of this.#localComputerReadyListeners) {
      try {
        listener(computerId);
      } catch {
        // Runner readiness is committed; one recovery observer cannot roll it back.
      }
    }
  }

  async acceptConnection(
    principal: RunnerGatewayPrincipal,
    value: RunnerHello,
    peer: RunnerGatewayPeer,
  ): Promise<RunnerGatewayConnection> {
    return this.runLocalComputerMutation(principal.runnerId, () =>
      this.#acceptConnectionInternal(principal, value, peer),
    );
  }

  /**
   * Records the reinstall instruction for a Computer refused before its hello
   * is parsed: it is below the release that can update itself.
   */
  async requireComputerReinstall(
    principal: RunnerGatewayPrincipal,
  ): Promise<void> {
    const claims = validateRunnerGatewayPrincipal(principal);
    await this.runLocalComputerMutation(claims.runnerId, async () => {
      this.#requireOpen();
      await this.context.computerRegistry?.touch(claims.runnerId, {
        status: "upgrade_required",
        seenAt: new Date().toISOString(),
      });
    });
  }

  /**
   * Answers a Computer that connected with an older protocol or release with
   * only the release to update itself to. It is not a Runner
   * connection: it gets no Operations, Agent Runners or Context Views, and
   * reconnects as the current release once it has updated.
   */
  async acceptOutdatedComputer(
    principal: RunnerGatewayPrincipal,
    hello: OutdatedComputerHello,
  ): Promise<OutdatedComputerWelcome> {
    const claims = validateRunnerGatewayPrincipal(principal);
    const release = this.context.options.computerRelease;
    if (!release) throw new RunnerUpgradeRequiredError();
    return this.runLocalComputerMutation(claims.runnerId, async () => {
      this.#requireOpen();
      await this.context.computerRegistry?.touch(claims.runnerId, {
        status: "offline",
        seenAt: new Date().toISOString(),
        daemonVersion: hello.daemonVersion,
        recommendedVersion: release.version,
      });
      const connectionEpoch = nextConnectionEpoch(
        this.#connectionEpochs.get(claims.runnerId) ?? 0,
      );
      this.#connectionEpochs.set(claims.runnerId, connectionEpoch);
      return {
        type: "runner.welcome",
        protocol_version: hello.protocolVersion,
        runner_id: claims.runnerId,
        connection_id: this.context.createId(),
        connection_epoch: connectionEpoch,
        heartbeat_interval_ms: this.context.heartbeatIntervalMs,
        reconcile_operation_ids: [],
        target_release: computerTargetRelease(release),
      };
    });
  }

  /**
   * Admits a current Computer. TeamHub records the hello and returns the
   * Agents placed on the Computer; its Agent Runners are computed from them
   * and from the Runners it reports, so a Computer an Agent left learns of the
   * move here and its Operations for that Agent end without being applied.
   */
  async #acceptConnectionInternal(
    principal: RunnerGatewayPrincipal,
    value: RunnerHello,
    peer: RunnerGatewayPeer,
  ): Promise<RunnerGatewayConnection> {
    this.#requireOpen();
    const claims = validateRunnerGatewayPrincipal(principal);
    const hello = this.#parseHello(claims.runnerId, value);
    assertRunnerHelloScope(claims, hello);
    // An older release is answered by acceptOutdatedComputer, never admitted.
    if (
      !isComputerVersionAtLeast(
        hello.daemon_version,
        MINIMUM_CURRENT_COMPUTER_VERSION,
      )
    ) {
      throw new RunnerUpgradeRequiredError();
    }
    assertRuntimeModelCatalogCapability(hello);
    this.context.computerDaemonIdentityVerifier.verify({
      computerId: claims.runnerId,
      hello,
    });
    const owner = claims.tenantOwners[0];
    if (claims.tenantOwners.length !== 1 || !owner)
      throw new RunnerGatewayProtocolError(
        "A Local Computer has exactly one owner",
      );
    const registrations = runtimeRegistrationSnapshot(owner, hello);
    this.owners.operations().validateReconciliationInventory(hello);
    const previous = this.#connections.get(hello.runner_id);
    const placements =
      (await this.context.computerRegistry?.connect({
        computerId: hello.runner_id,
        owner,
        credentialGeneration: claims.credentialGeneration,
        hello,
        status: isServingConnection(previous) ? "online" : "offline",
        ...(this.context.options.computerRelease
          ? { recommendedVersion: this.context.options.computerRelease.version }
          : {}),
      })) ?? [];
    const pending = this.owners
      .operations()
      .retainedOperations(hello.runner_id);
    const connection = this.#replaceConnection(claims, hello, pending, peer);
    try {
      await this.send(connection, this.#welcome(connection, pending));
      const commandId = `registration-snapshot-${this.context.createId()}`;
      connection.registrationSnapshotCommandId = commandId;
      await this.send(connection, {
        type: "runtime.registration.snapshot",
        protocol_version: hello.protocol_version,
        command_id: commandId,
        runner_id: connection.runnerId,
        connection_epoch: connection.connectionEpoch,
        registrations,
      });
      this.armHeartbeat(connection);
      await connection.agentRunnerReconciliation.start(
        this.owners
          .lifecycle()
          .connectionPlacements(connection.runnerId, placements),
        hello.agent_runners,
      );
      return this.#connectionHandle(connection);
    } catch (error) {
      this.disconnect(connection);
      throw error;
    }
  }

  async runLocalComputerMutation<T>(
    computerId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#computerMutationTails.get(computerId);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => gate);
    this.#computerMutationTails.set(computerId, current);
    await previous?.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.#computerMutationTails.get(computerId) === current) {
        this.#computerMutationTails.delete(computerId);
      }
    }
  }

  #parseHello(authenticatedRunnerId: string, value: RunnerHello): RunnerHello {
    const hello = parseDaemonToAgentEnvelope(value);
    if (hello.type !== "runner.hello") {
      throw new RunnerGatewayProtocolError(
        "First Runner frame must be runner.hello",
      );
    }
    if (hello.runner_id !== authenticatedRunnerId) {
      throw new RunnerGatewayProtocolError(
        "Runner credential does not match runner.hello identity",
      );
    }
    if (
      !sameRuntimeTypes(
        hello.runtimes,
        compatibleRuntimeTypes(hello.runtime_diagnostics),
      )
    ) {
      throw new RunnerGatewayProtocolError(
        "Runner Runtime inventory does not match diagnostics",
      );
    }
    return hello;
  }

  #replaceConnection(
    principal: RunnerGatewayPrincipal,
    hello: RunnerHello,
    pendingOperations: readonly RunnerOperationState[],
    peer: RunnerGatewayPeer,
  ): ConnectedRunner {
    const previous = this.#connections.get(hello.runner_id);
    const connectionEpoch = nextConnectionEpoch(
      this.#connectionEpochs.get(hello.runner_id) ?? 0,
    );
    this.#connectionEpochs.set(hello.runner_id, connectionEpoch);
    const agentRunnerReconciliation = this.owners
      .lifecycle()
      .createReconciliation({
        computerId: hello.runner_id,
        connectionEpoch,
        createId: this.context.createId,
        send: (command) => this.send(connection, command),
        onReady: () =>
          this.owners.operations().completeOperationReconciliation(connection),
      });
    const connection: ConnectedRunner = {
      connectionId: this.context.createId(),
      runnerId: hello.runner_id,
      tenantOwners: new Map(
        principal.tenantOwners.map(({ tenantId, ownerActorId }) => [
          tenantId,
          ownerActorId,
        ]),
      ),
      peer,
      hello,
      capabilities: new Set(hello.capabilities),
      connectionEpoch,
      pendingOperations,
      reportedActiveOperations: hello.active_operations,
      agentRunnerReconciliation,
      connected: true,
      retiredOperationPreparations: new Map(),
      phase: "reconciling",
      operationReconciled: false,
      runtimeDiagnosticsRevision: 0,
    };
    this.#connections.set(hello.runner_id, connection);
    if (previous?.connected) {
      this.owners.capabilities().rejectConnectionWaiters(previous);
      this.#clearHeartbeat(previous);
      previous.connected = false;
      previous.peer.close(1012, "Runner connection replaced");
      this.owners.operations().expireInputReceipts(previous.runnerId);
    }
    this.owners.operations().wakeCapacityWaiters();
    return connection;
  }

  #welcome(
    connection: ConnectedRunner,
    pending: readonly RunnerOperationState[],
  ): RunnerWelcome {
    return {
      type: "runner.welcome",
      protocol_version: connection.hello.protocol_version,
      runner_id: connection.runnerId,
      connection_id: connection.connectionId,
      connection_epoch: connection.connectionEpoch,
      heartbeat_interval_ms: this.context.heartbeatIntervalMs,
      reconcile_operation_ids: pending.map(({ start }) => start.operation_id),
      ...(this.owners.contextViewContent()
        ? {
            context_content_url: this.owners
              .contextViewContent()!
              .contentUrl(connection.runnerId, connection.connectionEpoch),
          }
        : {}),
      ...(this.context.options.computerRelease
        ? {
            target_release: computerTargetRelease(
              this.context.options.computerRelease,
            ),
          }
        : {}),
    };
  }

  #connectionHandle(connection: ConnectedRunner): RunnerGatewayConnection {
    return {
      recordActivity: (envelope) => {
        this.assertCurrentConnection(connection);
        const frame = parseDaemonToAgentEnvelope(envelope);
        if (
          frame.runner_id !== connection.runnerId ||
          frame.type === "runner.hello"
        ) {
          throw new RunnerGatewayProtocolError(
            "Runner frame identity mismatch",
          );
        }
        this.armHeartbeat(connection);
      },
      receive: async (envelope) => {
        try {
          await this.#receive(connection, envelope);
        } catch (error) {
          const protocol = error instanceof RunnerGatewayProtocolError;
          connection.peer.close(
            protocol ? 1002 : 1011,
            protocol ? "Runner protocol violation" : "Runner service failure",
          );
          this.disconnect(connection);
          throw error;
        }
      },
      receiveInvalidOperation: async (invalid) => {
        try {
          await this.owners
            .operations()
            .receiveInvalidOperation(connection, invalid);
        } catch (error) {
          const protocol = error instanceof RunnerGatewayProtocolError;
          connection.peer.close(
            protocol ? 1002 : 1011,
            protocol ? "Runner protocol violation" : "Runner service failure",
          );
          this.disconnect(connection);
          throw error;
        }
      },
      receiveInvalidDebugInspection: (commandId) =>
        this.owners
          .debug()
          .receiveInvalidDebugInspection(connection, commandId),
      disconnect: () => this.disconnect(connection),
    };
  }

  async #receive(
    connection: ConnectedRunner,
    value: DaemonToAgentEnvelope,
  ): Promise<void> {
    this.assertCurrentConnection(connection);
    const envelope = parseDaemonToAgentEnvelope(value);
    if (envelope.runner_id !== connection.runnerId) {
      throw new RunnerGatewayProtocolError("Runner frame identity mismatch");
    }
    this.armHeartbeat(connection);
    if (envelope.type === "runner.hello") {
      throw new RunnerGatewayProtocolError("Runner sent runner.hello twice");
    }
    if (envelope.type === "runner.heartbeat") {
      if (connection.operationReconciled) {
        const now = Date.now();
        try {
          if (
            connection.lastSeenWrittenAtMs === undefined ||
            now - connection.lastSeenWrittenAtMs >= LAST_SEEN_WRITE_INTERVAL_MS
          ) {
            await this.context.computerRegistry?.touch(connection.runnerId, {
              status: "online",
              seenAt: new Date(now).toISOString(),
              activeOperations: this.owners
                .operations()
                .activeOperations(connection.runnerId).length,
            });
            connection.lastSeenWrittenAtMs = now;
          }
        } catch (error) {
          // A missed liveness write only delays the projection; the next
          // heartbeat retries it. A removed Computer (404) still disconnects.
          if (
            !(error instanceof TeamHubRuntimeStateError) ||
            !(error.retryable || error.status === 429)
          )
            throw error;
          logAgentEvent("warn", "runner.heartbeat.touch_failed", {
            runnerId: connection.runnerId,
            status: error.status,
            code: error.code,
          });
        }
      }
      return;
    }
    if (envelope.type === "runner.runtime_diagnostics") {
      if (envelope.revision <= connection.runtimeDiagnosticsRevision) {
        throw new RunnerGatewayProtocolError(
          "Runner Runtime diagnostic revision is stale",
        );
      }
      assertRuntimeModelCatalogCapability({
        ...connection.hello,
        runtime_diagnostics: envelope.runtime_diagnostics,
      });
      connection.runtimeDiagnosticsRevision = envelope.revision;
      connection.hello.runtime_diagnostics = envelope.runtime_diagnostics;
      const previousRuntimes = connection.hello.runtimes;
      connection.hello.runtimes = compatibleRuntimeTypes(
        envelope.runtime_diagnostics,
      );
      if (!sameRuntimeTypes(previousRuntimes, connection.hello.runtimes)) {
        this.notifyLocalComputerReady(connection.runnerId);
      }
      await this.context.computerRegistry?.touch(connection.runnerId, {
        status: "online",
        seenAt: envelope.sent_at,
        runtimes: connection.hello.runtimes,
        runtimeDiagnostics: envelope.runtime_diagnostics,
      });
      connection.hello.runtime_registrations =
        connection.hello.runtime_registrations.map((observation) => {
          const diagnostic = envelope.runtime_diagnostics.find(
            ({ type }) => type === observation.provider_type,
          );
          if (!diagnostic) return observation;
          const available =
            diagnostic.status === "ready" ||
            diagnostic.status === "authentication_required";
          return {
            ...observation,
            status: available ? ("online" as const) : ("unavailable" as const),
            revision: envelope.revision,
            capabilities: available ? ["turn"] : [],
            runtime_diagnostics: structuredClone(
              diagnostic,
            ) as unknown as RunnerHello["runtime_registrations"][number]["runtime_diagnostics"],
          };
        });
      const commandId = `registration-snapshot-${this.context.createId()}`;
      connection.registrationSnapshotCommandId = commandId;
      await this.send(connection, {
        type: "runtime.registration.snapshot",
        protocol_version: connection.hello.protocol_version,
        command_id: commandId,
        runner_id: connection.runnerId,
        connection_epoch: connection.connectionEpoch,
        registrations: runtimeRegistrationSnapshot(
          {
            tenantId: owner(connection).tenantId,
            ownerActorId: owner(connection).ownerActorId,
          },
          connection.hello,
        ),
      });
      return;
    }
    if (envelope.type === "runtime.registration.observed") {
      if (
        envelope.connection_epoch !== connection.connectionEpoch ||
        envelope.command_id !== connection.registrationSnapshotCommandId
      ) {
        throw new RunnerGatewayProtocolError(
          "Local Runtime Registration receipt identity mismatch",
        );
      }
      return;
    }
    if (isAgentRunnerOutcome(envelope)) {
      await this.owners
        .lifecycle()
        .receiveAgentRunnerOutcome(connection, envelope);
      return;
    }
    if (isAgentCliCredentialOutcome(envelope)) {
      this.owners.cli().receiveAgentCliCredentialOutcome(connection, envelope);
      return;
    }
    if (isDebugInspectionOutcome(envelope)) {
      this.owners.debug().receiveDebugInspection(envelope);
      return;
    }
    if (envelope.type === "executed" && envelope.kind === "browser_connect") {
      this.owners.capabilities().receiveBrowserOutcome(connection, envelope);
      return;
    }
    if (
      envelope.type === "executed" &&
      envelope.kind === "computer_permission"
    ) {
      this.owners.capabilities().receivePermissionOutcome(connection, envelope);
      return;
    }
    if (envelope.type === "executed" && envelope.kind === "computer_tool") {
      this.owners.computerTools().receive(connection, envelope);
      return;
    }
    if (isLocalSkillOutcome(envelope)) {
      if (
        envelope.connection_epoch !== connection.connectionEpoch ||
        connection.tenantOwners.get(envelope.tenant_id) !==
          envelope.owner_actor_id
      ) {
        throw new RunnerGatewayProtocolError(
          "Runner Local Skill outcome identity mismatch",
        );
      }
      this.owners.capabilities().receiveLocalSkillOutcome(envelope);
      return;
    }
    if (envelope.type === "prepared" && envelope.target === "provider") {
      // Advisory: a prepare outcome carries no Operation identity or state.
      logAgentEvent("info", "runner.provider.prepared", {
        runnerId: connection.runnerId,
        prepareId: envelope.prepare_id,
        executionContextKey: envelope.execution_context_key,
        outcome: envelope.outcome,
        reason: envelope.reason,
        durationMs: envelope.duration_ms,
      });
      return;
    }
    if (envelope.type === "executed" && envelope.kind === "session_compact") {
      // Advisory: an outcome whose wait was abandoned arrives late and is
      // ignored, never treated as a protocol violation.
      logAgentEvent("info", "runner.session.compacted", {
        runnerId: connection.runnerId,
        compactId: envelope.compact_id,
        executionContextKey: envelope.execution_context_key,
        outcome: envelope.outcome,
        preTokens: envelope.pre_tokens,
        reason: envelope.reason,
        durationMs: envelope.duration_ms,
      });
      this.owners
        .compaction()
        .receiveSessionCompacted(connection.runnerId, envelope);
      return;
    }
    if (envelope.type === "executed" && envelope.kind === "model_invoke") {
      // Advisory: a reply whose caller stopped waiting only frees its slot.
      logAgentEvent("info", "runner.model.invoked", {
        runnerId: connection.runnerId,
        invokeId: envelope.invoke_id,
        outcome: envelope.outcome,
        model: envelope.model,
        runtimeVersion: envelope.runtime_version,
        reason: envelope.reason,
        durationMs: envelope.duration_ms,
      });
      this.owners
        .modelInvocation()
        .receiveModelInvoked(connection.runnerId, envelope);
      return;
    }
    await this.owners.operations().receiveOperation(connection, envelope);
  }

  async sendToCurrentRunner(envelope: AgentToDaemonEnvelope): Promise<void> {
    const runnerId = "runner_id" in envelope ? envelope.runner_id : undefined;
    const connection = runnerId ? this.#connections.get(runnerId) : undefined;
    if (!connection?.connected) {
      throw new RunnerGatewayError(
        `Runner "${runnerId ?? "unknown"}" is not connected`,
      );
    }
    // Until reconciliation replays an Operation's start, its later commands
    // would reach the Computer first; the replay resends them in order.
    if (
      !connection.operationReconciled &&
      (envelope.type === "operation.start" ||
        envelope.type === "operation.input" ||
        (envelope.type === "prepare" && envelope.target === "operation"))
    ) {
      throw new RunnerGatewayError(
        `Runner "${connection.runnerId}" is not yet reconciled`,
      );
    }
    try {
      await this.send(connection, envelope);
    } catch (error) {
      this.disconnect(connection);
      throw error;
    }
  }

  // Read the current connection each time: only a current release, whose
  // empty-session creation is a durable boundary, takes Room preparation.
  supportsDurableCodexSession(runnerId: string): boolean {
    const connection = this.#connections.get(runnerId);
    return (
      isServingConnection(connection) &&
      connection.hello.runtime_diagnostics.some(
        ({ type, status }) => type === "codex" && status === "ready",
      )
    );
  }

  /** Whether the Computer can compact a parked session of this Runtime now. */
  supportsSessionCompaction(
    runnerId: string,
    runtimeType: "codex" | "claude" | "pi",
  ): boolean {
    const connection = this.#connections.get(runnerId);
    return (
      isServingConnection(connection) &&
      (runtimeType === "codex" || runtimeType === "claude") &&
      connection.hello.runtime_diagnostics.some(
        ({ type, status }) => type === runtimeType && status === "ready",
      )
    );
  }

  /** Whether the Computer can run a model invocation on this Runtime now. */
  supportsModelInvoke(
    runnerId: string,
    runtimeType: "codex" | "claude" | "pi",
  ): boolean {
    const connection = this.#connections.get(runnerId);
    return (
      isServingConnection(connection) &&
      (runtimeType === "codex" || runtimeType === "claude") &&
      connection.hello.runtime_diagnostics.some(
        ({ type, status }) => type === runtimeType && status === "ready",
      )
    );
  }

  /** Whether this is the Computer's current connection, for content fetches. */
  isCurrentConnection(runnerId: string, connectionEpoch: number): boolean {
    const connection = this.#connections.get(runnerId);
    return (
      connection?.connected === true &&
      connection.connectionEpoch === connectionEpoch
    );
  }

  async send(
    connection: ConnectedRunner,
    envelope: AgentToDaemonEnvelope,
  ): Promise<void> {
    this.assertCurrentConnection(connection);
    await connection.peer.send(parseAgentToDaemonEnvelope(envelope));
    if (envelope.type === "operation.start")
      this.owners
        .operations()
        .getOperation(envelope.operation_id)
        ?.noteStartSent();
  }

  assertCurrentConnection(connection: ConnectedRunner): void {
    if (
      !connection.connected ||
      this.#connections.get(connection.runnerId) !== connection
    ) {
      throw new RunnerGatewayError("Runner connection is no longer current");
    }
  }

  async removeLocalComputer(command: {
    readonly tenantId: string;
    readonly ownerActorId: string;
    readonly computerId: string;
  }): Promise<void> {
    const registry = this.context.computerRegistry;
    if (!registry) throw new LocalComputerNotFoundError();
    const running = this.owners
      .operations()
      .activeOperations(command.computerId).length;
    if (running > 0) throw new LocalComputerBusyError(running);
    const removal = await registry.remove(command);
    if (removal === "not-found") {
      throw new LocalComputerNotFoundError();
    }
    if (removal === "has-agents") {
      throw new LocalComputerHasAgentsError(1);
    }
    const connection = this.getConnection(command.computerId);
    if (connection?.connected) {
      connection.peer.close(1008, "Local Computer was removed");
      this.disconnect(connection);
    }
    this.owners.lifecycle().forgetComputer(command.computerId);
  }

  /** Checks a placement against the connected Computer before it runs work. */
  requireLocalPlacement(
    requirement: LocalPlacementRequirement,
    modelId: string,
    reasoningEffort?: LocalReasoningEffort,
  ): LocalRuntimeModelDefinition {
    const connection = this.getConnection(requirement.computerId);
    if (connection === undefined || !connection.connected) {
      throw new LocalComputerOfflineError();
    }
    const grant = connection.hello.workspace_grants.find(
      ({ grant_id }) => grant_id === requirement.workspaceGrantId,
    );
    if (
      connection.tenantOwners.get(requirement.tenantId) !==
        requirement.ownerActorId ||
      !grant ||
      grant.tenant_id !== requirement.tenantId ||
      grant.scope !== "owner"
    ) {
      throw new LocalComputerPlacementError();
    }
    // A transient new-Run diagnostic must never mask a revoked owner/grant.
    if (!connection.hello.runtimes.includes(requirement.runtimeType)) {
      throw new LocalRuntimeAdmissionUnavailableError();
    }
    const model = findRuntimeModel(
      this.owners
        .preparation()
        .runtimeModelsForComputer(requirement.computerId),
      requirement.runtimeType,
      modelId,
    );
    if (!model) {
      throw new LocalComputerModelError(requirement.runtimeType);
    }
    assertReasoningEffort(model, reasoningEffort, requirement.runtimeType);
    return model;
  }

  disconnect(connection: ConnectedRunner): void {
    this.owners.capabilities().rejectConnectionWaiters(connection);
    this.#clearHeartbeat(connection);
    connection.connected = false;
    this.owners.operations().wakeCapacityWaiters();
    // A replaced connection's inputs were expired at its replacement; the
    // current one may carry receipts still to come.
    if (this.#connections.get(connection.runnerId) === connection) {
      this.owners.operations().expireInputReceipts(connection.runnerId);
      this.#connections.delete(connection.runnerId);
      this.#lastDisconnectedAtMs.set(connection.runnerId, Date.now());
      this.owners
        .lifecycle()
        .rejectAgentRunnerStateWaitersForComputer(connection.runnerId);
      void this.context.computerRegistry
        ?.touch(connection.runnerId, {
          status: "offline",
          seenAt: new Date().toISOString(),
        })
        .catch(() => undefined);
    }
    this.owners.capabilities().rejectLocalSkillWaiters(connection.runnerId);
    this.owners.debug().rejectWaitersForComputer(connection.runnerId);
    this.owners.compaction().rejectWaitersForComputer(connection.runnerId);
    this.owners.modelInvocation().rejectWaitersForComputer(connection.runnerId);
    this.owners.computerTools().disconnected(connection);
    this.owners.cli().rejectCredentialWaitersForComputer(connection.runnerId);
  }

  armHeartbeat(connection: ConnectedRunner): void {
    this.#clearHeartbeat(connection);
    connection.lastActivityAtMs = Date.now();
    connection.heartbeatTimer = setTimeout(() => {
      if (
        connection.connected &&
        this.#connections.get(connection.runnerId) === connection
      ) {
        logAgentEvent("warn", "runner.connection.heartbeat_timeout", {
          computerId: connection.runnerId,
          connectionEpoch: connection.connectionEpoch,
          lastActivityAtMs: connection.lastActivityAtMs,
          heartbeatTimeoutMs: this.context.heartbeatTimeoutMs,
        });
        connection.peer.close(1001, "Runner heartbeat timed out");
        this.disconnect(connection);
      }
    }, this.context.heartbeatTimeoutMs);
    connection.heartbeatTimer.unref();
  }

  #clearHeartbeat(connection: ConnectedRunner): void {
    if (connection.heartbeatTimer) {
      clearTimeout(connection.heartbeatTimer);
      connection.heartbeatTimer = undefined;
    }
  }

  getConnection(computerId: string): ConnectedRunner | undefined {
    return this.#connections.get(computerId);
  }

  hasConnection(computerId: string): boolean {
    return this.#connections.has(computerId);
  }

  allConnections(): IterableIterator<ConnectedRunner> {
    return this.#connections.values();
  }
}

// Serves work once its retained Operations are reconciled.
export const isServingConnection = (
  connection: ConnectedRunner | undefined,
): connection is ConnectedRunner =>
  connection?.connected === true && connection.operationReconciled;

// TeamHub treats a connection observation as fresh for 60s.
const LAST_SEEN_WRITE_INTERVAL_MS = 20_000;

/**
 * The Computer's Runtimes as the Gateway names them: one Registration per
 * Runtime the owner's Daemon observes, with an id derived from the owner and
 * Runtime so every connection and process names it the same way.
 */
const runtimeRegistrationSnapshot = (
  owner: { readonly tenantId: string; readonly ownerActorId: string },
  hello: RunnerHello,
): RuntimeRegistration[] =>
  hello.runtime_registrations.map((observation) => {
    if (
      observation.tenant_id !== owner.tenantId ||
      observation.owner_actor_id !== owner.ownerActorId
    ) {
      throw new RunnerGatewayProtocolError(
        "Local Runtime Registration exceeds authenticated owner scope",
      );
    }
    return {
      registration_id: runtimeRegistrationId(owner, observation.provider_type),
      observation: structuredClone(observation),
    };
  });

const owner = (
  connection: ConnectedRunner,
): { readonly tenantId: string; readonly ownerActorId: string } => {
  const [entry] = connection.tenantOwners;
  if (!entry)
    throw new RunnerGatewayProtocolError(
      "A Local Computer has exactly one owner",
    );
  return { tenantId: entry[0], ownerActorId: entry[1] };
};

const compatibleRuntimeTypes = (
  diagnostics: RunnerHello["runtime_diagnostics"],
): RunnerHello["runtimes"] =>
  diagnostics
    .filter(
      ({ status }) =>
        status === "ready" || status === "authentication_required",
    )
    .map(({ type }) => type);

const sameRuntimeTypes = (
  left: RunnerHello["runtimes"],
  right: RunnerHello["runtimes"],
): boolean =>
  left.length === right.length &&
  left.every((runtime) => right.includes(runtime));

/** The fields of an older runner.hello the update answer reads. */
export interface OutdatedComputerHello {
  readonly protocolVersion: string;
  readonly daemonVersion: string;
}

/**
 * The runner.welcome every Computer since self_update_v2 accepts: its older
 * protocol is only echoed, never spoken.
 */
export interface OutdatedComputerWelcome {
  readonly type: "runner.welcome";
  readonly protocol_version: string;
  readonly runner_id: string;
  readonly connection_id: string;
  readonly connection_epoch: number;
  readonly heartbeat_interval_ms: number;
  readonly reconcile_operation_ids: readonly string[];
  readonly target_release: RunnerWelcome["target_release"];
}

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const nextConnectionEpoch = (current: number): number => {
  if (
    !Number.isSafeInteger(current) ||
    current < 0 ||
    current >= Number.MAX_SAFE_INTEGER
  ) {
    throw new RunnerGatewayError("Runner connection epoch is exhausted");
  }
  return current + 1;
};
