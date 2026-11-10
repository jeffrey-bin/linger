import type {
  ContextViewRef,
  LocalMcpRelayDescriptor,
  RuntimeConfig,
} from "@linger/wire-contracts/runner-gateway/types";
import {
  RUNNER_GATEWAY_PROTOCOL_VERSION,
  parseAgentToDaemonEnvelope,
} from "@linger/wire-contracts/runner-gateway/validator";
import { logAgentEvent } from "../observability/agent-log.js";
import {
  findRuntimeModel,
  LocalComputerModelError,
  LocalRuntimeAuthenticationRequiredError,
  resolveRuntimeModel,
  runtimeModelCatalogForComputer,
  type LocalReasoningEffort,
  type LocalRuntimeModelCatalog,
  type LocalRuntimeModelDefinition,
  type LocalRuntimeType,
} from "./local-computer-management.js";
import { isServingConnection } from "./runner-connections.js";
import type {
  ConnectedRunner,
  LocalContextRunIdentity,
  LocalMcpRelayRunIdentity,
  RunnerGatewayContext,
  RunnerGatewayControllers,
} from "./runner-gateway-context.js";
import {
  contextViewRefIdentity,
  RunnerGatewayError,
  RunnerGatewayProtocolError,
  RunnerOperationState,
  type RunnerOperationTarget,
  type RunnerProviderPrepareOptions,
  type RunnerProviderPrepareTarget,
} from "./runner-operation.js";

export class RunnerOperationPreparation {
  constructor(
    private readonly context: RunnerGatewayContext,
    private readonly owners: Pick<
      RunnerGatewayControllers,
      "connections" | "lifecycle" | "operations"
    >,
  ) {}

  async authorizeLocalMcpRelay(options: {
    run: LocalMcpRelayRunIdentity;
    operationId: string;
    executionLeaseId: string;
    descriptor: LocalMcpRelayDescriptor;
    methodClass?:
      | "initialize"
      | "initialized"
      | "tools_list"
      | "tools_call"
      | "other";
    signal?: AbortSignal;
  }): Promise<void> {
    const operation = this.owners
      .operations()
      .getOperation(options.operationId);
    if (!operation || operation.terminal) {
      throw new RunnerGatewayError("Local MCP Relay Operation is not active");
    }
    const start = operation.start;
    const identityMatches = contextRunStartMatches(
      start,
      operation.currentContextViewRef,
      options.run,
    );
    if (
      !identityMatches ||
      start.execution_lease_id !== options.executionLeaseId ||
      !start.request.run_resources.mcp_servers.some((descriptor) =>
        sameLocalMcpRelayDescriptor(descriptor, options.descriptor),
      )
    ) {
      throw new RunnerGatewayError(
        "Local MCP Relay Operation identity mismatch",
      );
    }
    if (!operation.accepted) {
      const connection = this.owners
        .connections()
        .getConnection(start.runner_id);
      if (
        operation.prepareDispatched &&
        connection?.connected === true &&
        connection.connectionEpoch === start.connection_epoch &&
        (options.methodClass === "initialize" ||
          options.methodClass === "initialized" ||
          options.methodClass === "tools_list")
      ) {
        return;
      }
      // MCP HTTP can overtake operation.accepted on the separately authenticated
      // WebSocket. Only an exact dispatched identity may wait; it gains no access
      // until the accepted frame is processed. Revalidate after the wait.
      await operation.waitForAcceptance(
        options.signal ?? AbortSignal.timeout(10_000),
      );
      return this.authorizeLocalMcpRelay(options);
    }
  }

  requireEligibleRunner(
    target: Pick<
      RunnerOperationTarget,
      "runnerId" | "tenantId" | "ownerActorId" | "agentId" | "workspaceGrantId"
    >,
    runtime: RuntimeConfig,
  ): LocalRuntimeModelDefinition | undefined {
    const runtimeType = runtime.type;
    const connection = this.requireReadyRuntime(target.runnerId, runtimeType);
    const grant = connection.hello.workspace_grants.find(
      ({ grant_id }) => grant_id === target.workspaceGrantId,
    );
    const grantScope = grant?.scope ?? "bindings";
    const grantAuthorized =
      grantScope === "bindings" ||
      (grantScope === "owner" &&
        target.ownerActorId !== undefined &&
        connection.tenantOwners.get(target.tenantId) === target.ownerActorId);
    if (
      !connection.tenantOwners.has(target.tenantId) ||
      !grant ||
      grant.tenant_id !== target.tenantId ||
      !grantAuthorized
    ) {
      throw new RunnerGatewayError("Runner workspace grant is unavailable");
    }
    if (grant.mode !== "workspace-write") {
      throw new RunnerGatewayError("Runner workspace grant is read-only");
    }
    const selectedModel = runtime.model;
    if (selectedModel === undefined) {
      return undefined;
    }
    const model = findRuntimeModel(
      this.runtimeModelsForComputer(target.runnerId),
      runtimeType,
      selectedModel,
    );
    if (!model) {
      throw new RunnerGatewayError(
        `Runner model "${selectedModel}" is unavailable for Runtime "${runtimeType}"`,
      );
    }
    return model;
  }

  requireReadyRuntime(
    runnerId: string,
    runtimeType: RuntimeConfig["type"],
  ): ConnectedRunner {
    const connection = this.owners.connections().getConnection(runnerId);
    if (!isServingConnection(connection)) {
      throw new RunnerGatewayError(`Runner "${runnerId}" is not ready`);
    }
    const runtimeDiagnostic = connection.hello.runtime_diagnostics.find(
      ({ type }) => type === runtimeType,
    );
    if (runtimeDiagnostic?.status === "authentication_required") {
      throw new LocalRuntimeAuthenticationRequiredError();
    }
    if (runtimeDiagnostic?.status !== "ready") {
      throw new RunnerGatewayError(
        `Runner Runtime "${runtimeType}" is unavailable`,
      );
    }
    if (!connection.hello.runtimes.includes(runtimeType)) {
      throw new RunnerGatewayError(
        `Runner does not support Runtime "${runtimeType}"`,
      );
    }
    return connection;
  }

  runtimeModelsForComputer(computerId: string): LocalRuntimeModelCatalog {
    const connection = this.owners.connections().getConnection(computerId);
    return connection
      ? runtimeModelCatalogForComputer(
          connection.hello,
          this.context.runtimeModels,
        )
      : this.context.runtimeModels;
  }

  /**
   * Starts the Daemon's Codex resume for a Context whose real input was
   * accepted. It is fire-and-forget: no capacity permit, no Operation, and no
   * reply is awaited. The start that follows adopts the prepared process.
   */
  prepareProvider(
    target: RunnerProviderPrepareTarget,
    options: RunnerProviderPrepareOptions,
  ): { readonly prepareId: string } | undefined {
    const connection = this.owners.connections().getConnection(target.runnerId);
    if (!isServingConnection(connection)) return undefined;
    // Resolve the model exactly as the following run.start will, so the
    // Daemon resolves the same spec and does not recycle the prepared process.
    let runtime: RuntimeConfig;
    try {
      const model = this.requireEligibleRunner(target, options.runtime);
      runtime = resolveRuntimeModel(options.runtime, model);
    } catch {
      // An ineligible Runtime or grant is left to the run.start that follows.
      return undefined;
    }
    const desired = this.owners.lifecycle().desiredReadyOperation({
      computerId: target.runnerId,
      tenantId: target.tenantId,
      agentId: target.agentId,
      runtime,
      workspaceGrantId: target.workspaceGrantId,
    });
    if (!desired) return undefined;
    const prepareId = this.context.createId();
    const command = parseAgentToDaemonEnvelope({
      type: "prepare",
      target: "provider",
      protocol_version: RUNNER_GATEWAY_PROTOCOL_VERSION,
      host_access: "trusted",
      command_id: this.context.createId(),
      prepare_id: prepareId,
      tenant_id: target.tenantId,
      registration_id: desired.registrationId,
      assignment_revision: desired.assignmentRevision,
      runner_id: target.runnerId,
      runner_revision: desired.runnerRevision,
      connection_epoch: connection.connectionEpoch,
      agent_id: target.agentId,
      workspace_grant_id: target.workspaceGrantId,
      runtime_type: runtime.type,
      execution_context_key: target.executionContextKey,
      runtime_instance_id: target.runtimeInstanceId,
      context_view_ref: contextViewRefIdentity(options.contextViewRef),
      runtime,
      session_options: options.sessionOptions,
      session: options.session,
      ...(options.runContext !== undefined &&
      Object.keys(options.runContext).length > 0
        ? { run_context: options.runContext }
        : {}),
    });
    if (command.type !== "prepare" || command.target !== "provider") {
      throw new RunnerGatewayProtocolError("Invalid Provider prepare command");
    }
    void this.owners
      .connections()
      .sendToCurrentRunner(command)
      .catch((error: unknown) => {
        logAgentEvent("warn", "runner.provider.prepare_send_failed", {
          prepareId,
          runnerId: target.runnerId,
          executionContextKey: target.executionContextKey,
          error,
        });
      });
    return { prepareId };
  }
}

export const assertReasoningEffort = (
  model: LocalRuntimeModelDefinition,
  reasoningEffort: LocalReasoningEffort | undefined,
  runtimeType: LocalRuntimeType,
): void => {
  const allowed = model.allowedReasoningEffort ?? [];
  // A model without effort levels runs without one (withSupportedReasoningEffort).
  if (allowed.length === 0) return;
  if (reasoningEffort === undefined || !allowed.includes(reasoningEffort)) {
    throw new LocalComputerModelError(
      runtimeType,
      "Local Computer model reasoning effort is unavailable",
    );
  }
};

const contextRunStartMatches = (
  start: RunnerOperationState["start"],
  currentView: ContextViewRef | undefined,
  run: LocalContextRunIdentity,
): boolean => {
  const context = start.request.run_context;
  return (
    start.runner_id === run.computerId &&
    start.tenant_id === run.tenantId &&
    start.agent_id === run.agentId &&
    start.runner_revision === run.runnerRevision &&
    start.workspace_grant_id === run.workspaceGrantId &&
    start.execution_context_key === run.executionContextKey &&
    start.runtime_instance_id === run.runtimeInstanceId &&
    context.execution_run_ref === run.executionRunRef &&
    currentView?.view_digest === run.viewDigest
  );
};

const sameLocalMcpRelayDescriptor = (
  left: LocalMcpRelayDescriptor,
  right: LocalMcpRelayDescriptor,
): boolean =>
  left.name === right.name &&
  left.relay_url === right.relay_url &&
  left.relay_token === right.relay_token &&
  left.expires_at === right.expires_at &&
  left.tool_names.length === right.tool_names.length &&
  left.tool_names.every((tool, index) => tool === right.tool_names[index]);
