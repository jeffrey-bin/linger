import {
  RunnerComputerTools,
  type ComputerToolRequest,
} from "./runner-computer-tools.js";
import type {
  DebugHistoryInspectionRequest,
  DebugHistoryInspectionResult,
  LocalMcpRelayDescriptor,
  RunnerHello,
} from "@linger/wire-contracts/runner-gateway/types";
import { AgentRunnerLifecycle } from "./agent-runner-lifecycle.js";
import {
  type LocalAgentRunnerManagement,
  type LocalBrowserConnectionCommand,
  type LocalBrowserConnectionStatus,
  type LocalComputerPermissionCommand,
  type LocalComputerPermissionStatus,
  type LocalPlacementRequirement,
  type LocalReasoningEffort,
  type LocalRuntimeModelDefinition,
  type LocalRuntimeType,
  type LocalSkillScanCommand,
  type LocalSkillScanResult,
} from "./local-computer-management.js";
import { RunnerCliCredentials } from "./runner-cli-credentials.js";
import {
  RunnerConnections,
  type OutdatedComputerHello,
  type OutdatedComputerWelcome,
} from "./runner-connections.js";
import {
  createContextViewContent,
  type ContextViewContent,
} from "./context-view-content.js";
import { RunnerDebugInspection } from "./runner-debug-inspection.js";
import type {
  AgentCliCredentialEnsure,
  DetachedLocalHistoryRequest,
  LocalAgentRunnerOptions,
  LocalContextViewIdentity,
  LocalMcpRelayRunIdentity,
  RunnerAgentCliCredentialController,
  RunnerContextDebugInspector,
  RunnerGatewayConnection,
  RunnerGatewayControllers,
  RunnerGatewayOptions,
  RunnerGatewayPeer,
} from "./runner-gateway-context.js";
import {
  createRunnerGatewayContext,
  validateRunnerGatewayContext,
} from "./runner-gateway-context.js";
import { type RunnerGatewayPrincipal } from "./runner-gateway-principal.js";
import { RunnerLocalCapabilities } from "./runner-local-capabilities.js";
import { RunnerOperationPreparation } from "./runner-operation-preparation.js";
import type {
  RunnerCapacityPermit,
  RunnerCapacityTarget,
} from "./runner-operation.js";
import {
  type RunnerOperation,
  type RunnerOperationDispatcher,
  type RunnerOperationTarget,
  type RunnerProviderPrepareOptions,
  type RunnerProviderPrepareTarget,
  type RunnerSessionCompactOptions,
  type RunnerSessionCompactOutcome,
  type RunnerSessionCompactTarget,
} from "./runner-operation.js";
import { RunnerOperations } from "./runner-operations.js";
import {
  endpointConcurrency,
  ModelQueue,
  type ModelEndpoint,
  type ModelLease,
  type ModelWork,
} from "./model-queue.js";
import {
  RunnerModelInvocation,
  type RunnerModelInvokeOutcome,
  type RunnerModelInvokeRequest,
} from "./runner-model-invocation.js";
import { RunnerSessionCompaction } from "./runner-session-compaction.js";
export type {
  AgentRunnerIdentity,
  AgentRunnerPlacement,
} from "./agent-runner-desired-state.js";
export type {
  AgentCliCredentialEnsure,
  DetachedLocalHistoryRequest,
  InvalidOperationFrame,
  LocalContextRunIdentity,
  LocalContextViewIdentity,
  LocalMcpRelayRunIdentity,
  RunnerAgentCliCredentialController,
  RunnerContextDebugInspector,
  RunnerGatewayConnection,
  RunnerGatewayOptions,
  RunnerGatewayPeer,
  RunnerGatewayWriteGuard,
} from "./runner-gateway-context.js";
export type { RunnerGatewayPrincipal } from "./runner-gateway-principal.js";
export {
  MODEL_INVOKE_MAX_PROMPT_BYTES,
  RunnerModelInvokeUnavailableError,
} from "./runner-model-invocation.js";
export type {
  RunnerModelInvokeOutcome,
  RunnerModelInvokeRequest,
} from "./runner-model-invocation.js";
export {
  RunnerGatewayError,
  RunnerGatewayProtocolError,
  RunnerOperationError,
  RunnerOperationInputError,
  RunnerUpgradeRequiredError,
} from "./runner-operation.js";
export type {
  RunnerOperation,
  RunnerOperationDispatcher,
  RunnerOperationInput,
  RunnerOperationScope,
  RunnerOperationTarget,
} from "./runner-operation.js";
export class RunnerGateway
  implements
    RunnerOperationDispatcher,
    LocalAgentRunnerManagement,
    RunnerAgentCliCredentialController,
    RunnerContextDebugInspector
{
  /** Serves Context View manifests and files to connected Computers. */
  readonly contextViewContent?: ContextViewContent;
  readonly #connections: RunnerConnections;
  readonly #lifecycle: AgentRunnerLifecycle;
  readonly #operations: RunnerOperations;
  readonly #debug: RunnerDebugInspection;
  readonly #capabilities: RunnerLocalCapabilities;
  readonly #cli: RunnerCliCredentials;
  readonly #preparation: RunnerOperationPreparation;
  readonly #compaction: RunnerSessionCompaction;
  readonly #modelInvocation: RunnerModelInvocation;
  readonly #queue: ModelQueue;
  readonly #computerTools: RunnerComputerTools;
  constructor(options: RunnerGatewayOptions) {
    const context = createRunnerGatewayContext(options);
    const owners: RunnerGatewayControllers = {
      connections: () => this.#connections,
      lifecycle: () => this.#lifecycle,
      operations: () => this.#operations,
      debug: () => this.#debug,
      capabilities: () => this.#capabilities,
      cli: () => this.#cli,
      preparation: () => this.#preparation,
      compaction: () => this.#compaction,
      modelInvocation: () => this.#modelInvocation,
      queue: () => this.#queue,
      computerTools: () => this.#computerTools,
      contextViewContent: () => this.contextViewContent,
    };
    this.#connections = new RunnerConnections(context, owners);
    this.#lifecycle = new AgentRunnerLifecycle(context, owners);
    this.#operations = new RunnerOperations(context, owners);
    this.#debug = new RunnerDebugInspection(context, owners);
    this.#capabilities = new RunnerLocalCapabilities(context, owners);
    this.#cli = new RunnerCliCredentials(context, owners);
    this.#preparation = new RunnerOperationPreparation(context, owners);
    this.#compaction = new RunnerSessionCompaction(context, owners);
    this.#modelInvocation = new RunnerModelInvocation(context, owners);
    this.#queue = new ModelQueue((endpoint) =>
      endpointConcurrency(
        this.runtimeModels(endpoint.computerId, endpoint.runtimeType),
      ),
    );
    this.#computerTools = new RunnerComputerTools(context, owners);
    validateRunnerGatewayContext(context);
    if (options.contextContent) {
      this.contextViewContent = createContextViewContent({
        ...options.contextContent,
        isCurrentConnection: (computerId, connectionEpoch) =>
          this.#connections.isCurrentConnection(computerId, connectionEpoch),
      });
    }
  }
  subscribeLocalComputerReady(
    listener: (computerId: string) => void,
  ): () => void {
    return this.#connections.subscribeLocalComputerReady(listener);
  }

  async awaitLocalComputerReconnect(
    computerId: string,
    signal: AbortSignal,
  ): Promise<void> {
    return this.#connections.awaitLocalComputerReconnect(computerId, signal);
  }

  isLocalComputerExecutionReady(computerId: string): boolean {
    return this.#connections.isLocalComputerExecutionReady(computerId);
  }

  /** Admits Computers once this process has opened its epoch. */
  openConnections(): void {
    this.#connections.openConnections();
  }

  async acceptConnection(
    principal: RunnerGatewayPrincipal,
    value: RunnerHello,
    peer: RunnerGatewayPeer,
  ): Promise<RunnerGatewayConnection> {
    return this.#connections.acceptConnection(principal, value, peer);
  }

  async requireComputerReinstall(
    principal: RunnerGatewayPrincipal,
  ): Promise<void> {
    return this.#connections.requireComputerReinstall(principal);
  }

  async acceptOutdatedComputer(
    principal: RunnerGatewayPrincipal,
    hello: OutdatedComputerHello,
  ): Promise<OutdatedComputerWelcome> {
    return this.#connections.acceptOutdatedComputer(principal, hello);
  }

  readReadyLocalAgentRunnerRevision(options: LocalAgentRunnerOptions): number {
    return this.#lifecycle.readReadyLocalAgentRunnerRevision(options);
  }

  async ensureReadyLocalAgentRunner(
    options: LocalAgentRunnerOptions,
  ): Promise<number> {
    return this.#lifecycle.ensureReadyLocalAgentRunner(options);
  }

  noteAgentPlacement(agentId: string, computerId: string): Promise<void> {
    return this.#lifecycle.noteAgentPlacement(agentId, computerId);
  }

  async finalizeDeletedLocalAgentRunner(agentId: string): Promise<void> {
    return this.#lifecycle.finalizeDeletedLocalAgentRunner(agentId);
  }

  async acquireOperationCapacity(
    target: RunnerCapacityTarget,
    signal: AbortSignal,
  ): Promise<RunnerCapacityPermit> {
    return this.#operations.acquireOperationCapacity(target, signal);
  }

  async startOperation(
    target: RunnerOperationTarget,
  ): Promise<RunnerOperation> {
    return this.#operations.startOperation(target);
  }

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
    return this.#preparation.authorizeLocalMcpRelay(options);
  }

  async ensureAgentCliCredential(
    options: AgentCliCredentialEnsure,
  ): Promise<void> {
    return this.#cli.ensureAgentCliCredential(options);
  }

  async inspectDetachedLocalHistory(
    options: DetachedLocalHistoryRequest,
  ): Promise<DebugHistoryInspectionResult> {
    return this.#debug.inspectDetachedLocalHistory(options);
  }

  inspectLocalContext(options: {
    readonly context: LocalContextViewIdentity;
    readonly request: DebugHistoryInspectionRequest;
    readonly signal?: AbortSignal;
  }): Promise<DebugHistoryInspectionResult> {
    return this.#debug.inspectLocalContext(options);
  }

  canReadDetachedHistory(
    computerId: string,
    runtimeType: "codex" | "claude" | "pi",
  ): boolean {
    return this.#debug.canReadDetachedHistory(computerId, runtimeType);
  }

  async connectLocalBrowser(
    command: LocalBrowserConnectionCommand,
  ): Promise<LocalBrowserConnectionStatus> {
    return this.#capabilities.connectLocalBrowser(command);
  }

  async computerPermissions(
    command: LocalComputerPermissionCommand,
  ): Promise<LocalComputerPermissionStatus> {
    return this.#capabilities.computerPermissions(command);
  }

  async scanLocalSkills(
    command: LocalSkillScanCommand,
  ): Promise<LocalSkillScanResult> {
    return this.#capabilities.scanLocalSkills(command);
  }

  async runLocalComputerMutation<T>(
    computerId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.#connections.runLocalComputerMutation(computerId, operation);
  }

  async removeLocalComputer(command: {
    readonly tenantId: string;
    readonly ownerActorId: string;
    readonly computerId: string;
  }): Promise<void> {
    return this.#connections.removeLocalComputer(command);
  }

  requireLocalPlacement(
    requirement: LocalPlacementRequirement,
    modelId: string,
    reasoningEffort?: LocalReasoningEffort,
  ): LocalRuntimeModelDefinition {
    return this.#connections.requireLocalPlacement(
      requirement,
      modelId,
      reasoningEffort,
    );
  }

  /** The models a connected Computer reports for a Runtime; undefined while
   * it is offline. */
  runtimeModels(
    computerId: string,
    runtimeType: LocalRuntimeType,
  ): readonly LocalRuntimeModelDefinition[] | undefined {
    return this.#connections.getConnection(computerId)?.connected
      ? this.#preparation.runtimeModelsForComputer(computerId)[runtimeType]
      : undefined;
  }

  supportsDurableCodexSession(runnerId: string): boolean {
    return this.#connections.supportsDurableCodexSession(runnerId);
  }

  prepareProvider(
    target: RunnerProviderPrepareTarget,
    options: RunnerProviderPrepareOptions,
  ): { readonly prepareId: string } | undefined {
    return this.#preparation.prepareProvider(target, options);
  }

  compactParkedSession(
    target: RunnerSessionCompactTarget,
    options: RunnerSessionCompactOptions,
  ): Promise<RunnerSessionCompactOutcome> {
    return this.#compaction.compactParkedSession(target, options);
  }

  supportsSessionCompaction(
    computerId: string,
    runtimeType: "codex" | "claude" | "pi",
  ): boolean {
    return this.#connections.supportsSessionCompaction(computerId, runtimeType);
  }

  /**
   * Runs one model call on the Computer's signed-in Runtime once the model
   * queue admits it. It takes no Operation slot. Throws
   * LocalComputerOfflineError when the Computer is offline or drops, and
   * RunnerModelInvokeUnavailableError when it cannot run this Runtime.
   */
  invokeModel(
    computerId: string,
    request: RunnerModelInvokeRequest,
  ): Promise<RunnerModelInvokeOutcome> {
    return this.#modelInvocation.invokeModel(computerId, request);
  }

  /** Admits a chain, which then holds its place on the endpoint until it ends. */
  acquireModelChain(
    endpoint: ModelEndpoint,
    work: ModelWork,
    signal: AbortSignal,
  ): Promise<ModelLease> {
    return this.#queue.acquire(endpoint, work, signal);
  }

  callComputerTool(request: ComputerToolRequest) {
    return this.#computerTools.call(request);
  }

  supportsModelInvoke(
    computerId: string,
    runtimeType: "codex" | "claude" | "pi",
  ): boolean {
    return this.#connections.supportsModelInvoke(computerId, runtimeType);
  }
}
