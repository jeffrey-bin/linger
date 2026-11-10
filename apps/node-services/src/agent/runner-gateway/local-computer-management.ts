import type { RuntimeExecutionFailure } from "../executor/provider.js";
import type {
  BrowserConnectionStatus,
  ComputerPermissionStatus,
} from "@linger/wire-contracts/runner-gateway/types";

export type LocalRuntimeType = "claude" | "codex" | "pi";

export const isSupportedLocalRuntimeType = (
  value: unknown,
): value is LocalRuntimeType =>
  value === "codex" || value === "claude" || value === "pi";
// A Computer below this release is refused with `upgrade_required` and the
// user reruns the installer.
export const MINIMUM_COMPUTER_VERSION = "0.22.0";
// A Computer below this release, or without every required capability,
// connects only to receive `target_release` and runs no work until it
// reconnects as a current release. 0.44.0 adds the model call output cap.
export const MINIMUM_CURRENT_COMPUTER_VERSION = "0.44.0";
// The first release that speaks Runner protocol 2. A protocol 2 Computer
// below the current release updates itself from the welcome's
// `target_release`; an older protocol 2 build is refused.
export const FIRST_PROTOCOL_2_COMPUTER_VERSION = "0.43.0";

const COMPUTER_RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Source builds report `dev` and follow the current wire contract. */
export const isComputerVersionAtLeast = (
  version: unknown,
  minimum: string,
): boolean => {
  if (version === "dev") return true;
  const observed =
    typeof version === "string" ? COMPUTER_RELEASE_VERSION.exec(version) : null;
  const required = COMPUTER_RELEASE_VERSION.exec(minimum);
  if (!observed || !required) return false;
  const left = observed.slice(1, 4).map(Number);
  const right = required.slice(1, 4).map(Number);
  if (![...left, ...right].every(Number.isSafeInteger)) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index]! > right[index]!;
  }
  return true;
};

/** Local Computer Context executors and parked Codex share this idle window. */
export const LOCAL_COMPUTER_IDLE_TIMEOUT_MS = 20 * 60 * 1000;

export interface LocalComputerModel {
  readonly id: string;
  readonly label: string;
  readonly allowedReasoningEffort?: readonly LocalReasoningEffort[];
  readonly defaultReasoningEffort?: LocalReasoningEffort;
  /** Context length in tokens as the Computer reports it. */
  readonly contextWindow?: number;
  /** The model the Runtime runs when none is selected. */
  readonly isDefault?: boolean;
  /** How the Runtime reaches the model: through a configured gateway (api)
   * or the signed-in account (subscription). */
  readonly link?: "api" | "subscription";
}

export type LocalReasoningEffort =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";

export interface LocalRuntimeModelDefinition extends LocalComputerModel {
  /** Exact provider model sent over the Gateway; omitted selects the host Runtime default. */
  readonly runtimeModel?: string;
}

export type LocalRuntimeModelCatalog = Readonly<
  Record<LocalRuntimeType, readonly LocalRuntimeModelDefinition[]>
>;

export const DEFAULT_LOCAL_RUNTIME_MODELS: LocalRuntimeModelCatalog = {
  pi: [{ id: "pi-default", label: "Pi default", allowedReasoningEffort: [] }],
  claude: [
    {
      id: "claude-default",
      label: "Claude default",
      allowedReasoningEffort: [],
    },
  ],
  codex: [
    { id: "codex-default", label: "Codex default", allowedReasoningEffort: [] },
  ],
};

export interface LocalPlacementRequirement {
  readonly type: "local";
  readonly tenantId: string;
  readonly ownerActorId: string;
  readonly computerId: string;
  readonly runtimeType: LocalRuntimeType;
  readonly workspaceGrantId: string;
  /** Advances whenever TeamHub moves the Agent to another Computer, Runtime or grant. */
  readonly assignmentRevision: number;
}

export interface LocalComputerManagement {
  removeLocalComputer(command: {
    readonly tenantId: string;
    readonly ownerActorId: string;
    readonly computerId: string;
  }): void | Promise<void>;

  runLocalComputerMutation<T>(
    computerId: string,
    operation: () => Promise<T>,
  ): Promise<T>;

  scanLocalSkills?(
    command: LocalSkillScanCommand,
  ): Promise<LocalSkillScanResult>;

  connectLocalBrowser?(
    command: LocalBrowserConnectionCommand,
  ): Promise<LocalBrowserConnectionStatus>;

  computerPermissions?(
    command: LocalComputerPermissionCommand,
  ): Promise<LocalComputerPermissionStatus>;

  /** Returns the placed model as the connected Computer reports it. */
  requireLocalPlacement(
    requirement: LocalPlacementRequirement,
    modelId: string,
    reasoningEffort?: LocalReasoningEffort,
  ): LocalRuntimeModelDefinition;
}

export interface LocalSkillScanCommand {
  readonly tenantId: string;
  readonly ownerActorId: string;
  readonly computerId: string;
  readonly commandId: string;
  readonly scanId: string;
  readonly runtimeType: LocalRuntimeType;
  readonly expiresAt: string;
  readonly signal?: AbortSignal;
}

export type LocalBrowserConnectionStatus = BrowserConnectionStatus;

/**
 * Reads, configures, or disconnects the owner's own Chrome on one Local
 * Computer. `extensionToken` is only valid with `configure` and must never be
 * logged, persisted, or returned.
 */
export interface LocalBrowserConnectionCommand {
  readonly tenantId: string;
  readonly ownerActorId: string;
  readonly computerId: string;
  readonly action: "status" | "configure" | "disconnect";
  readonly profile?: string;
  readonly extensionToken?: string;
  readonly signal?: AbortSignal;
}

export type LocalComputerPermissionStatus = ComputerPermissionStatus;

/**
 * Reads or acts on the macOS privacy permissions of one Local Computer.
 * `subject` is required for every action except status, and `permission`
 * for prompt and open_settings.
 */
export interface LocalComputerPermissionCommand {
  readonly tenantId: string;
  readonly ownerActorId: string;
  readonly computerId: string;
  readonly action: "status" | "prompt" | "open_settings" | "relaunch";
  readonly subject?: "linger" | "computer_use";
  readonly permission?: "screen_recording" | "accessibility";
  readonly signal?: AbortSignal;
}

export interface LocalSkillScanResult {
  readonly scanId: string;
  readonly computerId: string;
  readonly runtimeType: LocalRuntimeType;
  readonly expiresAt: string;
  readonly items: readonly LocalSkillCandidate[];
}

export interface LocalSkillCandidate {
  readonly nativeSource?: string;
  readonly nativeEnabled?: boolean;
  readonly candidateRef: string;
  readonly name: string;
  readonly description: string;
  readonly packageSha256: string;
  readonly fileCount: number;
  readonly sizeBytes: number;
  readonly normalizations: readonly string[];
  readonly riskFlags: readonly string[];
  readonly importability: "ready" | "unsupported";
  readonly errorCode?: string;
  readonly errorDetail?: string;
  readonly manifestExcerpt?: string;
}

export interface LocalAgentRunnerManagement extends LocalComputerManagement {
  ensureReadyLocalAgentRunner(options: {
    readonly placement: LocalPlacementRequirement;
    readonly modelId: string;
    readonly reasoningEffort?: LocalReasoningEffort;
    readonly agentId: string;
    readonly signal?: AbortSignal;
  }): Promise<number>;

  /**
   * TeamHub committed the Agent on this Computer. Releasing the Agent's
   * Contexts on a Computer it left does not wait for that Computer.
   */
  noteAgentPlacement(agentId: string, computerId: string): Promise<void>;

  /** Persist removal of every Runner of a revoked Agent; an offline Computer applies it when it reconnects. */
  finalizeDeletedLocalAgentRunner(agentId: string): Promise<void>;
}

export class LocalComputerPlacementError extends Error {
  constructor(message = "Local Computer is unavailable") {
    super(message);
    this.name = "LocalComputerPlacementError";
  }
}

export class LocalComputerOfflineError extends LocalComputerPlacementError {
  constructor(message = "Local Computer is offline") {
    super(message);
    this.name = "LocalComputerOfflineError";
  }
}

/** A new-runtime admission diagnostic, not proof that an active Turn stopped. */
export class LocalRuntimeAdmissionUnavailableError extends LocalComputerOfflineError {
  constructor() {
    super("Local Computer runtime is unavailable");
    this.name = "LocalRuntimeAdmissionUnavailableError";
  }
}

/** Only pure offline failures are waiting; mixed cleanup/provider failures still alert. */
export const isLocalComputerOfflineError = (error: unknown): boolean =>
  error instanceof LocalComputerOfflineError ||
  (error instanceof AggregateError &&
    error.errors.length > 0 &&
    error.errors.every(isLocalComputerOfflineError));

/**
 * The Computer does not offer the Agent's model or reasoning effort. Only a
 * configuration change fixes it, so activation fails the queued Runs with
 * this public failure instead of leaving them silently queued.
 */
export class LocalComputerModelError extends LocalComputerPlacementError {
  readonly failure: RuntimeExecutionFailure;

  constructor(
    runtimeType: LocalRuntimeType,
    message = "Local Computer model is unavailable",
  ) {
    super(message);
    this.name = "LocalComputerModelError";
    this.failure = { code: "model_not_offered", runtime_type: runtimeType };
  }
}

export class LocalRuntimeAuthenticationRequiredError extends LocalComputerPlacementError {
  readonly code = "RUNTIME_AUTHENTICATION_REQUIRED";

  constructor(message = "Local Runtime authentication is required") {
    super(message);
    this.name = "LocalRuntimeAuthenticationRequiredError";
  }
}

export class LocalAgentRunnerReadinessError extends LocalComputerPlacementError {
  constructor(message = "Local Agent Runner is not ready") {
    super(message);
    this.name = "LocalAgentRunnerReadinessError";
  }
}

export class LocalComputerNotFoundError extends Error {
  constructor(message = "Local Computer was not found") {
    super(message);
    this.name = "LocalComputerNotFoundError";
  }
}

export class LocalComputerCapabilityError extends LocalComputerPlacementError {
  constructor(message = "Local Computer does not support this capability") {
    super(message);
    this.name = "LocalComputerCapabilityError";
  }
}

export class LocalSkillOperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "LocalSkillOperationError";
  }
}

/** The Computer rejected a browser connection command or did not answer. */
export class LocalBrowserConnectionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "LocalBrowserConnectionError";
  }
}

/** The Computer rejected a permission command or did not answer. */
export class LocalComputerPermissionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "LocalComputerPermissionError";
  }
}

export class LocalComputerHasAgentsError extends Error {
  readonly code = "local_computer_has_agents";

  constructor(readonly agentCount: number) {
    super(
      `Local Computer has ${agentCount} assigned ${agentCount === 1 ? "Agent" : "Agents"}`,
    );
    this.name = "LocalComputerHasAgentsError";
  }
}

export class LocalComputerBusyError extends Error {
  readonly code = "local_computer_busy";

  constructor(readonly operationCount: number) {
    super(
      `Local Computer is busy with ${operationCount} ${operationCount === 1 ? "Operation" : "Operations"}`,
    );
    this.name = "LocalComputerBusyError";
  }
}

export const resolveRuntimeModel = (
  runtime: RuntimeConfig,
  model: LocalRuntimeModelDefinition | undefined,
): RuntimeConfig => {
  if (!model) {
    return runtime;
  }
  const { model: _productModel, ...rest } = runtime;
  const supported = withSupportedReasoningEffort(rest, model);
  return model.runtimeModel === undefined
    ? supported
    : { ...supported, model: model.runtimeModel };
};

/**
 * Leaves out the reasoning effort for a model that offers none: a CLI that
 * predates effort levels (e.g. an old Claude Code) would reject the flag.
 */
export const withSupportedReasoningEffort = <
  T extends { readonly reasoning_effort?: LocalReasoningEffort },
>(
  runtime: T,
  model: LocalRuntimeModelDefinition,
): T => {
  if (
    runtime.reasoning_effort === undefined ||
    (model.allowedReasoningEffort?.length ?? 0) > 0
  ) {
    return runtime;
  }
  const { reasoning_effort: _unsupported, ...rest } = runtime;
  return rest as T;
};

export const resolveOperationModel = (
  target: RunnerOperationTarget,
  model: LocalRuntimeModelDefinition | undefined,
): RunnerOperationTarget => {
  if (!model) {
    return target;
  }
  return {
    ...target,
    request: {
      ...target.request,
      runtime: resolveRuntimeModel(target.request.runtime, model),
    },
  };
};

export const findRuntimeModel = (
  catalog: LocalRuntimeModelCatalog,
  runtimeType: LocalRuntimeType,
  modelId: string,
): LocalRuntimeModelDefinition | undefined =>
  catalog[runtimeType].find(({ id }) => id === modelId);

/** Claude reports no context window. On the signed-in account a model runs
 * with Anthropic's standard window unless its id selects the 1M one. */
function claudeSubscriptionWindow(id: string): number {
  return id.endsWith("[1m]") ? 1_000_000 : 200_000;
}

export const runtimeModelCatalogForComputer = (
  hello: RunnerHello,
  fallback: LocalRuntimeModelCatalog,
): LocalRuntimeModelCatalog => {
  const catalog = {} as Record<
    LocalRuntimeType,
    readonly LocalRuntimeModelDefinition[]
  >;
  for (const runtimeType of ["claude", "codex", "pi"] as const) {
    const diagnostic = hello.runtime_diagnostics.find(
      ({ type }) => type === runtimeType,
    );
    const legacyDefaults = fallback[runtimeType].filter(
      ({ runtimeModel }) => runtimeModel === undefined,
    );
    const legacyDefaultIds = new Set(legacyDefaults.map(({ id }) => id));
    const discovered = (diagnostic?.models ?? []).map((model) => ({
      id: model.id,
      label: model.label,
      ...(legacyDefaultIds.has(model.id) ? {} : { runtimeModel: model.id }),
      allowedReasoningEffort: model.allowed_reasoning_effort,
      ...(model.default_reasoning_effort
        ? { defaultReasoningEffort: model.default_reasoning_effort }
        : {}),
      ...(model.context_window !== undefined
        ? { contextWindow: model.context_window }
        : runtimeType === "claude" && model.link === "subscription"
          ? { contextWindow: claudeSubscriptionWindow(model.id) }
          : {}),
      ...(model.is_default ? { isDefault: true } : {}),
      ...(model.link ? { link: model.link } : {}),
    }));
    catalog[runtimeType] = diagnostic?.model_catalog_error ? [] : discovered;
  }
  validateRuntimeModelCatalog(catalog);

  return catalog;
};

export const assertRuntimeModelCatalogCapability = (
  hello: RunnerHello,
): void => {
  runtimeModelCatalogForComputer(hello, DEFAULT_LOCAL_RUNTIME_MODELS);
};

export const validateRuntimeModelCatalog = (
  catalog: LocalRuntimeModelCatalog,
): LocalRuntimeModelCatalog => {
  const result = {} as Record<
    LocalRuntimeType,
    readonly LocalRuntimeModelDefinition[]
  >;
  for (const runtimeType of ["claude", "codex", "pi"] as const) {
    const models = catalog[runtimeType];
    const ids = new Set<string>();
    if (!Array.isArray(models) || models.length > 100) {
      throw new TypeError(
        `Local Runtime "${runtimeType}" must configure 0-100 models`,
      );
    }
    result[runtimeType] = models.map((model) => {
      if (
        typeof model !== "object" ||
        model === null ||
        typeof model.id !== "string" ||
        model.id.trim().length === 0 ||
        Array.from(model.id).length > 160 ||
        ids.has(model.id) ||
        typeof model.label !== "string" ||
        model.label.trim().length === 0 ||
        Array.from(model.label).length > 160 ||
        (model.runtimeModel !== undefined &&
          (typeof model.runtimeModel !== "string" ||
            model.runtimeModel.trim().length === 0 ||
            Array.from(model.runtimeModel).length > 160)) ||
        (model.contextWindow !== undefined &&
          (!Number.isSafeInteger(model.contextWindow) ||
            model.contextWindow < 1)) ||
        (model.isDefault !== undefined &&
          typeof model.isDefault !== "boolean") ||
        (model.link !== undefined &&
          model.link !== "api" &&
          model.link !== "subscription")
      ) {
        throw new TypeError(
          `Local Runtime "${runtimeType}" has an invalid model`,
        );
      }
      ids.add(model.id);
      const allowedReasoningEffort = model.allowedReasoningEffort ?? [];
      if (
        !Array.isArray(allowedReasoningEffort) ||
        allowedReasoningEffort.some(
          (effort, index) =>
            !isLocalReasoningEffort(effort) ||
            allowedReasoningEffort.indexOf(effort) !== index,
        ) ||
        (model.defaultReasoningEffort !== undefined &&
          !allowedReasoningEffort.includes(model.defaultReasoningEffort))
      ) {
        throw new TypeError(
          `Local Runtime "${runtimeType}" has invalid reasoning efforts`,
        );
      }
      return { ...model, allowedReasoningEffort: [...allowedReasoningEffort] };
    });
  }
  return result;
};

export const isLocalReasoningEffort = (
  value: unknown,
): value is LocalReasoningEffort =>
  typeof value === "string" &&
  ["none", "low", "medium", "high", "xhigh", "max", "ultra"].includes(value);

export const parseLocalPlacement = (
  value: unknown,
): LocalPlacementRequirement => {
  if (!isRecord(value)) {
    throw new TypeError("Local placement must be an object");
  }
  const expectedKeys = [
    "assignmentRevision",
    "computerId",
    "ownerActorId",
    "runtimeType",
    "tenantId",
    "type",
    "workspaceGrantId",
  ] as const;
  if (
    Object.keys(value).length !== expectedKeys.length ||
    !expectedKeys.every((key) => key in value) ||
    value.type !== "local" ||
    !isProtocolId(value.tenantId) ||
    !isProtocolId(value.ownerActorId) ||
    !isProtocolId(value.computerId) ||
    !isSupportedLocalRuntimeType(value.runtimeType) ||
    !isProtocolId(value.workspaceGrantId) ||
    !Number.isSafeInteger(value.assignmentRevision) ||
    (value.assignmentRevision as number) < 1
  ) {
    throw new TypeError("Local placement is invalid");
  }
  return value as unknown as LocalPlacementRequirement;
};

const isProtocolId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 64 &&
  /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);

import type {
  RunnerHello,
  RuntimeConfig,
} from "@linger/wire-contracts/runner-gateway/types";

import type { RunnerOperationTarget } from "./runner-operation.js";
import { isRecord } from "@linger/service-kit";
