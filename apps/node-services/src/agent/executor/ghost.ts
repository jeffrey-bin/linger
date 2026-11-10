import type { ExecutionContextRef } from "./context-ref.js";
import type {
  ActorId,
  AgentDefinition,
  AgentId,
  JsonObject,
  JsonValue,
} from "./types.js";

export interface SkillDescriptor {
  readonly skillId: string;
  readonly manifestVersion: string;
  readonly name: string;
  readonly packageName: string;
  readonly packageSha256: string;
  readonly config: JsonObject;
}

export interface McpDescriptor {
  readonly mcpId: string;
  readonly manifestVersion: string;
  readonly name: string;
  readonly transport: "streamable_http";
  readonly url: string;
  readonly allowedTools: readonly string[];
}

export interface GhostResources {
  readonly skills: readonly SkillDescriptor[];
  readonly mcpServers: readonly McpDescriptor[];
}

export interface GhostResourcesInput {
  readonly skills?: readonly SkillDescriptor[];
  readonly mcpServers?: readonly McpDescriptor[];
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SKILL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,511}$/;
const MANIFEST_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const PACKAGE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export const materializeGhostResources = (
  input: GhostResourcesInput | undefined,
): Readonly<GhostResources> => {
  if (input !== undefined) {
    assertPlainObject(input, "resources");
    assertExactKeys(input, ["skills", "mcpServers"], "resources");
  }

  const sourceSkills = input?.skills === undefined ? [] : input.skills;
  if (!Array.isArray(sourceSkills)) {
    throw new TypeError("resources.skills must be an array");
  }
  const skills = sourceSkills.map((skill, index) =>
    snapshotSkill(skill, `resources.skills[${index}]`),
  );
  const skillIds = new Set<string>();
  const packageNames = new Set<string>();
  for (const skill of skills) {
    if (skillIds.has(skill.skillId)) {
      throw new TypeError(
        `resources.skills contains duplicate ${skill.skillId}`,
      );
    }
    if (packageNames.has(skill.packageName)) {
      throw new TypeError(
        `resources.skills contains duplicate packageName ${skill.packageName}`,
      );
    }
    skillIds.add(skill.skillId);
    packageNames.add(skill.packageName);
  }
  skills.sort(
    (left, right) =>
      compareStrings(left.skillId, right.skillId) ||
      compareStrings(left.manifestVersion, right.manifestVersion),
  );

  const sourceMcpServers =
    input?.mcpServers === undefined ? [] : input.mcpServers;
  if (!Array.isArray(sourceMcpServers)) {
    throw new TypeError("resources.mcpServers must be an array");
  }
  const mcpServers = sourceMcpServers.map((server, index) =>
    snapshotMcp(server, `resources.mcpServers[${index}]`),
  );
  const mcpIds = new Set<string>();
  for (const server of mcpServers) {
    if (mcpIds.has(server.mcpId)) {
      throw new TypeError(
        `resources.mcpServers contains duplicate ${server.mcpId}`,
      );
    }
    mcpIds.add(server.mcpId);
  }
  mcpServers.sort(
    (left, right) =>
      compareStrings(left.mcpId, right.mcpId) ||
      compareStrings(left.manifestVersion, right.manifestVersion),
  );

  return Object.freeze({
    skills: Object.freeze(skills),
    mcpServers: Object.freeze(mcpServers),
  });
};

export function assertGhostResources(
  value: unknown,
): asserts value is GhostResources {
  assertRecord(value, "resources");
  assertExactKeys(value, ["skills", "mcpServers"], "resources", true);
  if (!Array.isArray(value.skills)) {
    throw new TypeError("resources.skills must be an array");
  }
  if (!Array.isArray(value.mcpServers)) {
    throw new TypeError("resources.mcpServers must be an array");
  }
  materializeGhostResources({
    skills: value.skills as SkillDescriptor[],
    mcpServers: value.mcpServers as McpDescriptor[],
  });
}

const snapshotSkill = (
  value: SkillDescriptor,
  field: string,
): Readonly<SkillDescriptor> => {
  assertPlainObject(value, field);
  assertExactKeys(
    value,
    [
      "skillId",
      "manifestVersion",
      "name",
      "packageName",
      "packageSha256",
      "config",
    ],
    field,
    true,
  );
  assertIdentifier(value.skillId, `${field}.skillId`, SKILL_ID_PATTERN);
  assertManifestVersion(value.manifestVersion, `${field}.manifestVersion`);
  assertName(value.name, `${field}.name`);
  if (
    typeof value.packageName !== "string" ||
    value.packageName.length > 64 ||
    !PACKAGE_NAME_PATTERN.test(value.packageName)
  ) {
    throw new TypeError(`${field}.packageName is invalid`);
  }
  if (
    typeof value.packageSha256 !== "string" ||
    !SHA256_PATTERN.test(value.packageSha256)
  ) {
    throw new TypeError(`${field}.packageSha256 must be a lowercase SHA-256`);
  }
  const config = snapshotJsonObject(value.config, `${field}.config`);
  return Object.freeze({
    skillId: value.skillId,
    manifestVersion: value.manifestVersion,
    name: value.name,
    packageName: value.packageName,
    packageSha256: value.packageSha256,
    config,
  });
};

const snapshotMcp = (
  value: McpDescriptor,
  field: string,
): Readonly<McpDescriptor> => {
  assertPlainObject(value, field);
  assertExactKeys(
    value,
    ["mcpId", "manifestVersion", "name", "transport", "url", "allowedTools"],
    field,
    true,
  );
  assertIdentifier(value.mcpId, `${field}.mcpId`);
  assertManifestVersion(value.manifestVersion, `${field}.manifestVersion`);
  assertName(value.name, `${field}.name`);
  if (value.transport !== "streamable_http") {
    throw new TypeError(`${field}.transport must be "streamable_http"`);
  }
  assertMcpUrl(value.url, `${field}.url`);
  if (
    !Array.isArray(value.allowedTools) ||
    value.allowedTools.length === 0 ||
    value.allowedTools.length > 100
  ) {
    throw new TypeError(`${field}.allowedTools must contain 1 to 100 tools`);
  }
  const allowedTools = value.allowedTools.map((tool, index) => {
    if (typeof tool !== "string" || tool.length === 0) {
      throw new TypeError(
        `${field}.allowedTools[${index}] must be a non-empty string`,
      );
    }
    return tool;
  });
  if (new Set(allowedTools).size !== allowedTools.length) {
    throw new TypeError(`${field}.allowedTools must be unique`);
  }
  allowedTools.sort(compareStrings);
  return Object.freeze({
    mcpId: value.mcpId,
    manifestVersion: value.manifestVersion,
    name: value.name,
    transport: "streamable_http",
    url: value.url,
    allowedTools: Object.freeze(allowedTools),
  });
};

const snapshotJsonObject = (value: unknown, field: string): JsonObject => {
  assertRecord(value, field);
  return snapshotJsonValue(value, field, new WeakSet()) as JsonObject;
};

const snapshotJsonValue = (
  value: unknown,
  field: string,
  ancestors: WeakSet<object>,
): JsonValue => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${field} contains a non-finite number`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object" || value === null) {
    throw new TypeError(`${field} must contain only JSON values`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${field} must not contain a cycle`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(
        value.map((entry, index) =>
          snapshotJsonValue(entry, `${field}[${index}]`, ancestors),
        ),
      ) as unknown as JsonValue;
    }
    assertRecord(value, field);
    const result: JsonObject = {};
    for (const key of Object.keys(value).sort(compareStrings)) {
      Object.defineProperty(result, key, {
        configurable: false,
        enumerable: true,
        value: snapshotJsonValue(value[key], `${field}.${key}`, ancestors),
        writable: false,
      });
    }
    return Object.freeze(result);
  } finally {
    ancestors.delete(value);
  }
};

function assertIdentifier(
  value: unknown,
  field: string,
  pattern = ID_PATTERN,
): asserts value is string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new TypeError(`${field} is invalid`);
  }
}

function assertManifestVersion(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== "string" || !MANIFEST_VERSION_PATTERN.test(value)) {
    throw new TypeError(`${field} is invalid`);
  }
}

function assertName(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 120) {
    throw new TypeError(`${field} must contain 1 to 120 characters`);
  }
}

function assertMcpUrl(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    throw new TypeError(`${field} is invalid`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new TypeError(`${field} is invalid`, { cause: error });
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    throw new TypeError(`${field} must be an HTTP URL without credentials`);
  }
}

function assertRecord(
  value: unknown,
  field: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${field} must be a plain object`);
  }
}

const assertExactKeys = (
  value: object,
  expected: readonly string[],
  field: string,
  requireAll = false,
): void => {
  const allowed = new Set(expected);
  const unknownKey = Object.keys(value).find((key) => !allowed.has(key));
  if (unknownKey !== undefined) {
    throw new TypeError(`${field}.${unknownKey} is not supported`);
  }
  if (!requireAll) return;
  const missingKey = expected.find((key) => !Object.hasOwn(value, key));
  if (missingKey !== undefined) {
    throw new TypeError(`${field}.${missingKey} is required`);
  }
};

const assertPlainObject = (value: unknown, field: string): void => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${field} must be a plain object`);
  }
};

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export interface Ghost<TRuntimeSettings> {
  agentId: AgentId;
  actorId?: ActorId;
  tenantId: string;
  revision: string;
  /**
   * The revision of the last Runtime or placement change; later revisions
   * changed only the profile, which a running Runtime adopts in place
   * from its next claim. Absent, every revision changes the Runtime.
   */
  runtimeRevision?: string;
  agent: AgentDefinition;
  runtime: TRuntimeSettings;
  resources: GhostResources;
  /** TeamHub has a Runtime permission judge; absent, no Run reviews. */
  permissionReview?: true;
}

export type GhostInput<TRuntimeSettings> = Omit<
  Ghost<TRuntimeSettings>,
  "resources"
> & {
  resources?: GhostResourcesInput;
};

export type GhostRegistration<TRuntimeSettings> = Omit<
  GhostInput<TRuntimeSettings>,
  "agentId" | "actorId"
>;

export interface AgentUpdate<TRuntimeSettings> {
  expectedRevision: string;
  revision: string;
  agent: AgentDefinition;
  runtime: TRuntimeSettings;
  resources: GhostResourcesInput;
}

/** Cleanup identity is never an activatable Ghost or a native Session. */
export interface AgentDeletionIdentity<TRuntimeSettings> {
  readonly agentId: AgentId;
  readonly actorId: ActorId;
  readonly tenantId: string;
  readonly runtime: TRuntimeSettings;
  readonly contextRefs: readonly Readonly<ExecutionContextRef>[];
}

export type GhostReadFailureHandler = (
  agentId: AgentId,
  error: unknown,
) => void;

export interface GhostStore<TRuntimeSettings> {
  getDeletionIdentity?(
    agentId: AgentId,
  ): Promise<AgentDeletionIdentity<TRuntimeSettings> | null>;
  /** Only concurrent cold creations may share a pending read; no completed cache. */
  refresh?(
    agentId: AgentId,
    options?: {
      readonly shareInFlight: boolean;
    },
  ): Promise<void | {
    readonly revision: string;
    readonly activationReady: boolean;
  }>;
  /** Validate a replacement against durable authority without mutating the cache. */
  isReplacementCurrent?(
    agentId: AgentId,
    ghost: Ghost<TRuntimeSettings>,
  ): Promise<boolean>;
  /** Fresh authority check; cached configuration is not activation permission. */
  isActivationReady?(agentId: AgentId, revision: string): Promise<boolean>;
  insert(
    ghost: GhostInput<TRuntimeSettings>,
  ): Promise<"inserted" | "agent_id_conflict">;
  get(agentId: AgentId): Promise<Readonly<Ghost<TRuntimeSettings>> | null>;
  /** Recovery may collect per-Agent failures; ordinary inventory stays strict. */
  list(
    signal?: AbortSignal,
    onReadFailure?: GhostReadFailureHandler,
  ): Promise<readonly Readonly<Ghost<TRuntimeSettings>>[]>;
  setActorId(
    agentId: AgentId,
    actorId: ActorId,
  ): Promise<"updated" | "not_found">;
  replace?(
    agentId: AgentId,
    expectedRevision: string,
    ghost: Ghost<TRuntimeSettings>,
  ): Promise<"updated" | "not_found" | "revision_conflict">;
  remove(agentId: AgentId): Promise<"removed" | "not_found">;
  close(): Promise<void>;
}

export const snapshotGhost = <TRuntimeSettings>(
  ghost: GhostInput<TRuntimeSettings>,
): Readonly<Ghost<TRuntimeSettings>> => {
  if (!isProtocolId(ghost.tenantId)) {
    throw new TypeError("tenantId must be a valid protocol ID");
  }
  if (
    ghost.actorId !== undefined &&
    (typeof ghost.actorId !== "string" || ghost.actorId.length === 0)
  ) {
    throw new TypeError("actorId must be a non-empty string");
  }
  const canonicalGhost: Ghost<TRuntimeSettings> = {
    ...ghost,
    resources: materializeGhostResources(ghost.resources),
  };
  return snapshotValue(canonicalGhost, new WeakMap()) as Readonly<
    Ghost<TRuntimeSettings>
  >;
};

const isProtocolId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 64 &&
  /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);

const snapshotValue = (
  value: unknown,
  snapshots: WeakMap<object, unknown>,
): unknown => {
  if (typeof value !== "object" || value === null) {
    return value;
  }

  const existing = snapshots.get(value);
  if (existing !== undefined) {
    return existing;
  }

  if (Array.isArray(value)) {
    const snapshot: unknown[] = [];
    snapshots.set(value, snapshot);
    for (const entry of value) {
      snapshot.push(snapshotValue(entry, snapshots));
    }
    return Object.freeze(snapshot);
  }

  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(
      "Ghost configuration must contain only plain objects, arrays, primitives, and functions",
    );
  }

  const snapshot = Object.create(prototype) as Record<string, unknown>;
  snapshots.set(value, snapshot);
  for (const [key, entry] of Object.entries(value)) {
    snapshot[key] = snapshotValue(entry, snapshots);
  }
  return Object.freeze(snapshot);
};
