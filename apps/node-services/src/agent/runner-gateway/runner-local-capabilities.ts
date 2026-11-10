import type {
  CapabilityBrowserConnected,
  CapabilityBrowserFailed,
  CapabilityComputerPermissionFailed,
  CapabilityComputerPermissionSucceeded,
  CapabilitySkillsScanned,
  DaemonToAgentEnvelope,
} from "@linger/wire-contracts/runner-gateway/types";
import {
  RUNNER_GATEWAY_PROTOCOL_VERSION,
  parseAgentToDaemonEnvelope,
} from "@linger/wire-contracts/runner-gateway/validator";
import {
  LocalBrowserConnectionError,
  LocalComputerCapabilityError,
  LocalComputerNotFoundError,
  LocalComputerOfflineError,
  LocalComputerPermissionError,
  LocalSkillOperationError,
  type LocalBrowserConnectionCommand,
  type LocalBrowserConnectionStatus,
  type LocalComputerPermissionCommand,
  type LocalComputerPermissionStatus,
  type LocalSkillScanCommand,
  type LocalSkillScanResult,
} from "./local-computer-management.js";
import { isServingConnection } from "./runner-connections.js";
import type {
  ConnectedRunner,
  LocalSkillOutcome,
  RunnerGatewayContext,
  RunnerGatewayControllers,
} from "./runner-gateway-context.js";
import { RunnerGatewayProtocolError } from "./runner-operation.js";

export class RunnerLocalCapabilities {
  readonly #localSkillWaiters = new Map<
    string,
    Set<{
      readonly runnerId: string;
      resolve(outcome: LocalSkillOutcome): void;
      reject(error: unknown): void;
    }>
  >();

  readonly #browserWaiters = new Map<
    string,
    {
      readonly connection: ConnectedRunner;
      readonly tenantId: string;
      readonly ownerActorId: string;
      readonly action: LocalBrowserConnectionCommand["action"];
      readonly resolve: (
        outcome: CapabilityBrowserConnected | CapabilityBrowserFailed,
      ) => void;
      readonly reject: (error: unknown) => void;
    }
  >();

  readonly #permissionWaiters = new Map<
    string,
    {
      readonly connection: ConnectedRunner;
      readonly tenantId: string;
      readonly ownerActorId: string;
      readonly action: LocalComputerPermissionCommand["action"];
      readonly resolve: (
        outcome:
          | CapabilityComputerPermissionSucceeded
          | CapabilityComputerPermissionFailed,
      ) => void;
      readonly reject: (error: unknown) => void;
    }
  >();

  constructor(
    private readonly context: RunnerGatewayContext,
    private readonly owners: Pick<RunnerGatewayControllers, "connections">,
  ) {}

  /**
   * Sends one browser connection command and waits for its outcome. The
   * extension token travels only inside the envelope; it is never logged,
   * stored, or echoed back.
   */
  async connectLocalBrowser(
    command: LocalBrowserConnectionCommand,
  ): Promise<LocalBrowserConnectionStatus> {
    command.signal?.throwIfAborted();
    const connection = this.owners
      .connections()
      .getConnection(command.computerId);
    if (!isServingConnection(connection)) {
      throw new LocalComputerOfflineError();
    }
    if (
      connection.tenantOwners.get(command.tenantId) !== command.ownerActorId
    ) {
      throw new LocalComputerNotFoundError();
    }
    if (!connection.capabilities.has("browser_connection")) {
      throw new LocalComputerCapabilityError(
        "Local Computer must be upgraded to connect the user's browser",
      );
    }
    if (
      (command.action === "configure") !==
      (command.extensionToken !== undefined)
    ) {
      throw new LocalBrowserConnectionError(
        "BROWSER_CONNECTION_INVALID",
        "Only configure carries an extension token",
        false,
      );
    }
    const commandId = this.context.createId();
    const envelope = parseAgentToDaemonEnvelope({
      type: "execute",
      kind: "browser_connect",
      protocol_version: RUNNER_GATEWAY_PROTOCOL_VERSION,
      command_id: commandId,
      runner_id: command.computerId,
      tenant_id: command.tenantId,
      owner_actor_id: command.ownerActorId,
      connection_epoch: connection.connectionEpoch,
      expires_at: new Date(
        Date.now() + BROWSER_CONNECTION_TIMEOUT_MS,
      ).toISOString(),
      action: command.action,
      ...(command.profile ? { profile: command.profile } : {}),
      ...(command.extensionToken !== undefined
        ? { extension_token: command.extensionToken }
        : {}),
    });
    const signal = command.signal;
    let onAbort: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = new Promise<
      CapabilityBrowserConnected | CapabilityBrowserFailed
    >((resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new LocalBrowserConnectionError(
            "BROWSER_CONNECTION_TIMEOUT",
            "Local Computer did not answer the browser connection command",
            true,
          ),
        );
      }, BROWSER_CONNECTION_TIMEOUT_MS);
      timer.unref();
      onAbort = () => reject(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#browserWaiters.set(commandId, {
        connection,
        tenantId: command.tenantId,
        ownerActorId: command.ownerActorId,
        action: command.action,
        resolve,
        reject,
      });
    });
    let result: CapabilityBrowserConnected | CapabilityBrowserFailed;
    try {
      [, result] = await Promise.all([
        this.owners.connections().sendToCurrentRunner(envelope),
        outcome,
      ]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      this.#browserWaiters.delete(commandId);
    }
    if (result.outcome === "failed") {
      throw new LocalBrowserConnectionError(
        result.error.code,
        result.error.message,
        result.error.retryable,
      );
    }
    return result.status;
  }

  /** Sends one macOS permission command and waits for the resulting status. */
  async computerPermissions(
    command: LocalComputerPermissionCommand,
  ): Promise<LocalComputerPermissionStatus> {
    command.signal?.throwIfAborted();
    const connection = this.owners
      .connections()
      .getConnection(command.computerId);
    if (!isServingConnection(connection)) {
      throw new LocalComputerOfflineError();
    }
    if (
      connection.tenantOwners.get(command.tenantId) !== command.ownerActorId
    ) {
      throw new LocalComputerNotFoundError();
    }
    if (!connection.capabilities.has("computer_permissions")) {
      throw new LocalComputerCapabilityError(
        "Local Computer must be upgraded to manage macOS permissions",
      );
    }
    if (
      (command.action === "status") !== (command.subject === undefined) ||
      (command.action === "prompt" || command.action === "open_settings") !==
        (command.permission !== undefined)
    ) {
      throw new LocalComputerPermissionError(
        "COMPUTER_PERMISSION_INVALID",
        "Only prompt and open_settings name a permission, and only status omits the subject",
        false,
      );
    }
    const commandId = this.context.createId();
    const envelope = parseAgentToDaemonEnvelope({
      type: "execute",
      kind: "computer_permission",
      protocol_version: RUNNER_GATEWAY_PROTOCOL_VERSION,
      command_id: commandId,
      runner_id: command.computerId,
      tenant_id: command.tenantId,
      owner_actor_id: command.ownerActorId,
      connection_epoch: connection.connectionEpoch,
      expires_at: new Date(
        Date.now() + COMPUTER_PERMISSION_TIMEOUT_MS,
      ).toISOString(),
      action: command.action,
      ...(command.subject ? { subject: command.subject } : {}),
      ...(command.permission ? { permission: command.permission } : {}),
    });
    const signal = command.signal;
    let onAbort: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = new Promise<
      CapabilityComputerPermissionSucceeded | CapabilityComputerPermissionFailed
    >((resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new LocalComputerPermissionError(
            "COMPUTER_PERMISSION_TIMEOUT",
            "Local Computer did not answer the permission command",
            true,
          ),
        );
      }, COMPUTER_PERMISSION_TIMEOUT_MS);
      timer.unref();
      onAbort = () => reject(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#permissionWaiters.set(commandId, {
        connection,
        tenantId: command.tenantId,
        ownerActorId: command.ownerActorId,
        action: command.action,
        resolve,
        reject,
      });
    });
    let result:
      | CapabilityComputerPermissionSucceeded
      | CapabilityComputerPermissionFailed;
    try {
      [, result] = await Promise.all([
        this.owners.connections().sendToCurrentRunner(envelope),
        outcome,
      ]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      this.#permissionWaiters.delete(commandId);
    }
    if (result.outcome === "failed") {
      throw new LocalComputerPermissionError(
        result.error.code,
        result.error.message,
        result.error.retryable,
      );
    }
    return result.status;
  }

  /** Fails every browser and permission command still waiting on this connection. */
  rejectConnectionWaiters(connection: ConnectedRunner): void {
    for (const [commandId, waiter] of this.#browserWaiters) {
      if (waiter.connection !== connection) continue;
      this.#browserWaiters.delete(commandId);
      waiter.reject(new LocalComputerOfflineError());
    }
    for (const [commandId, waiter] of this.#permissionWaiters) {
      if (waiter.connection !== connection) continue;
      this.#permissionWaiters.delete(commandId);
      waiter.reject(new LocalComputerOfflineError());
    }
  }

  async scanLocalSkills(
    command: LocalSkillScanCommand,
  ): Promise<LocalSkillScanResult> {
    command.signal?.throwIfAborted();
    const connection = this.#requireLocalSkillConnection(command);
    if (!connection.hello.runtimes.includes(command.runtimeType)) {
      throw new LocalComputerCapabilityError(
        `Local Computer does not support Runtime "${command.runtimeType}"`,
      );
    }
    const envelope = parseAgentToDaemonEnvelope({
      type: "execute",
      kind: "skills_scan",
      protocol_version: RUNNER_GATEWAY_PROTOCOL_VERSION,
      command_id: command.commandId,
      runner_id: command.computerId,
      tenant_id: command.tenantId,
      owner_actor_id: command.ownerActorId,
      connection_epoch: connection.connectionEpoch,
      expires_at: command.expiresAt,
      scan_id: command.scanId,
      runtime_type: command.runtimeType,
    });
    if (envelope.type !== "execute" || envelope.kind !== "skills_scan") {
      throw new RunnerGatewayProtocolError("Invalid Local Skill scan command");
    }
    const outcome = this.#waitForLocalSkillOutcome(
      command.commandId,
      command.computerId,
      command.expiresAt,
      command.signal,
    );
    await this.owners
      .connections()
      .sendToCurrentRunner(envelope)
      .catch(() => undefined);
    const result = requireLocalSkillScan(await outcome);
    return {
      scanId: result.scan_id,
      computerId: result.runner_id,
      runtimeType: result.runtime_type,
      expiresAt: result.expires_at,
      items: result.items.map((item) => ({
        candidateRef: item.candidate_ref,
        ...(item.native_source
          ? {
              nativeSource: item.native_source,
              nativeEnabled: item.native_enabled,
            }
          : {}),
        name: item.name,
        description: item.description,
        packageSha256: item.package_sha256,
        fileCount: item.file_count,
        sizeBytes: item.size_bytes,
        normalizations: [...item.normalizations],
        riskFlags: [...item.risk_flags],
        importability: item.importability,
        ...(item.error_code ? { errorCode: item.error_code } : {}),
        ...(item.error_detail ? { errorDetail: item.error_detail } : {}),
        ...(item.manifest_excerpt
          ? { manifestExcerpt: item.manifest_excerpt }
          : {}),
      })),
    };
  }

  receiveLocalSkillOutcome(outcome: LocalSkillOutcome): void {
    const waiters = this.#localSkillWaiters.get(outcome.command_id);
    if (!waiters) return;
    this.#localSkillWaiters.delete(outcome.command_id);
    for (const waiter of waiters) waiter.resolve(outcome);
  }

  #waitForLocalSkillOutcome(
    commandId: string,
    runnerId: string,
    expiresAt: string,
    signal?: AbortSignal,
  ): Promise<LocalSkillOutcome> {
    return new Promise<LocalSkillOutcome>((resolve, reject) => {
      const waiters = this.#localSkillWaiters.get(commandId) ?? new Set();
      const finish = (
        result:
          | { readonly outcome: LocalSkillOutcome }
          | { readonly error: unknown },
      ) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        waiters.delete(waiter);
        if (waiters.size === 0) this.#localSkillWaiters.delete(commandId);
        if ("outcome" in result) resolve(result.outcome);
        else reject(result.error);
      };
      const waiter = {
        runnerId,
        resolve: (outcome: LocalSkillOutcome) => finish({ outcome }),
        reject: (error: unknown) => finish({ error }),
      };
      const onAbort = () => finish({ error: signal?.reason });
      const timeoutMs = Math.min(
        2_147_483_647,
        Math.max(0, Date.parse(expiresAt) - Date.now()),
      );
      const timer = setTimeout(
        () =>
          finish({
            error: new LocalSkillOperationError(
              "LOCAL_SKILL_COMMAND_EXPIRED",
              "Local Skill command expired",
              false,
            ),
          }),
        timeoutMs,
      );
      timer.unref();
      waiters.add(waiter);
      this.#localSkillWaiters.set(commandId, waiters);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  #requireLocalSkillConnection(command: {
    readonly computerId: string;
    readonly tenantId: string;
    readonly ownerActorId: string;
  }): ConnectedRunner {
    const connection = this.owners
      .connections()
      .getConnection(command.computerId);
    if (!isServingConnection(connection)) {
      throw new LocalComputerOfflineError();
    }
    if (
      connection.tenantOwners.get(command.tenantId) !== command.ownerActorId
    ) {
      throw new LocalComputerNotFoundError();
    }
    return connection;
  }

  receiveBrowserOutcome(
    connection: ConnectedRunner,
    envelope: CapabilityBrowserConnected | CapabilityBrowserFailed,
  ): void {
    if (
      envelope.connection_epoch !== connection.connectionEpoch ||
      connection.tenantOwners.get(envelope.tenant_id) !==
        envelope.owner_actor_id
    ) {
      throw new RunnerGatewayProtocolError(
        "Runner browser connection outcome identity mismatch",
      );
    }
    const waiter = this.#browserWaiters.get(envelope.command_id);
    if (!waiter) return;
    if (
      waiter.connection !== connection ||
      waiter.tenantId !== envelope.tenant_id ||
      waiter.ownerActorId !== envelope.owner_actor_id ||
      waiter.action !== envelope.action
    ) {
      throw new RunnerGatewayProtocolError(
        "Runner browser connection command identity mismatch",
      );
    }
    this.#browserWaiters.delete(envelope.command_id);
    waiter.resolve(envelope);
    return;
  }

  receivePermissionOutcome(
    connection: ConnectedRunner,
    envelope:
      | CapabilityComputerPermissionSucceeded
      | CapabilityComputerPermissionFailed,
  ): void {
    if (
      envelope.connection_epoch !== connection.connectionEpoch ||
      connection.tenantOwners.get(envelope.tenant_id) !==
        envelope.owner_actor_id
    ) {
      throw new RunnerGatewayProtocolError(
        "Runner computer permission outcome identity mismatch",
      );
    }
    const waiter = this.#permissionWaiters.get(envelope.command_id);
    if (!waiter) return;
    if (
      waiter.connection !== connection ||
      waiter.tenantId !== envelope.tenant_id ||
      waiter.ownerActorId !== envelope.owner_actor_id ||
      waiter.action !== envelope.action
    ) {
      throw new RunnerGatewayProtocolError(
        "Runner computer permission command identity mismatch",
      );
    }
    this.#permissionWaiters.delete(envelope.command_id);
    waiter.resolve(envelope);
  }

  rejectLocalSkillWaiters(runnerId: string): void {
    for (const [commandId, waiters] of this.#localSkillWaiters) {
      for (const waiter of [...waiters]) {
        if (waiter.runnerId !== runnerId) continue;
        waiter.reject(new LocalComputerOfflineError());
      }
      if (waiters.size === 0) this.#localSkillWaiters.delete(commandId);
    }
  }
}

export const isLocalSkillOutcome = (
  envelope: DaemonToAgentEnvelope,
): envelope is LocalSkillOutcome =>
  envelope.type === "executed" && envelope.kind === "skills_scan";

// The Computer verifies a configure by connecting through the extension.
const BROWSER_CONNECTION_TIMEOUT_MS = 60_000;
// A prompt can hold the Computer briefly while macOS shows its dialog; the
// Computer itself gives Desktop 10 s per step.
const COMPUTER_PERMISSION_TIMEOUT_MS = 30_000;

const requireLocalSkillScan = (
  outcome: LocalSkillOutcome,
): CapabilitySkillsScanned => {
  if (outcome.outcome === "failed") {
    throw new LocalSkillOperationError(
      outcome.error.code,
      outcome.error.message,
      outcome.error.retryable,
    );
  }
  return outcome;
};
