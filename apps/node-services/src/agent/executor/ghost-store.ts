import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { logIgnoredRuntimeConfigRead } from "./teamhub-runtime-state-client.js";
import { AgentManagerError } from "./agent-manager-api.js";
import {
  isTeamHubNotFound,
  TeamHubRuntimeStateError,
} from "./teamhub-runtime-state-client.js";
import { toWireRef } from "./context-store.js";

import type { ActorId, AgentId } from "./types.js";
import type { LocalRuntimeSettings } from "../runtime-settings.js";
import { decodeExecutionContextKey } from "./context-ref.js";
import type {
  RuntimeConfigSnapshot,
  TeamHubRuntimeStateClient,
} from "./teamhub-runtime-state-client.js";
import type {
  AgentDeletionIdentity,
  Ghost,
  GhostInput,
  GhostReadFailureHandler,
  GhostStore,
} from "./ghost.js";
import {
  materializeGhostResources,
  type SkillDescriptor,
  snapshotGhost,
} from "./ghost.js";

/** How long a TeamHub 404 for a missing Agent registration suppresses re-reads. */
const NOT_FOUND_CACHE_TTL_MS = 5 * 60 * 1000;

export interface TeamHubGhostStoreOptions {
  readonly client: TeamHubRuntimeStateClient;
  readonly listAgentIds: () => Promise<readonly AgentId[]>;
  readonly parseRuntime: (value: unknown) => LocalRuntimeSettings;
  readonly now?: () => number;
}

/**
 * Projects TeamHub's immutable Runtime configuration snapshot into the
 * AgentManager's historical Ghost shape. No Ghost JSON is written locally.
 */
export const createTeamHubGhostStore = (
  options: TeamHubGhostStoreOptions,
): GhostStore<LocalRuntimeSettings> => new TeamHubGhostStore(options);

class TeamHubGhostStore implements GhostStore<LocalRuntimeSettings> {
  readonly #client: TeamHubRuntimeStateClient;
  readonly #listAgentIds: () => Promise<readonly AgentId[]>;
  readonly #parseRuntime: (value: unknown) => LocalRuntimeSettings;
  readonly #cache = new Map<AgentId, Readonly<Ghost<LocalRuntimeSettings>>>();
  readonly #refreshReads = new Map<
    AgentId,
    {
      readonly token: symbol;
      readonly shareable: boolean;
      readonly promise: ReturnType<
        NonNullable<GhostStore<LocalRuntimeSettings>["refresh"]>
      >;
    }
  >();
  readonly #readinessReads = new Map<AgentId, Promise<RuntimeConfigSnapshot>>();
  readonly #notFoundUntil = new Map<AgentId, number>();
  readonly #now: () => number;
  #closed = false;

  constructor(options: TeamHubGhostStoreOptions) {
    this.#client = options.client;
    this.#listAgentIds = options.listAgentIds;
    this.#parseRuntime = options.parseRuntime;
    this.#now = options.now ?? Date.now;
  }

  async getDeletionIdentity(
    agentId: AgentId,
  ): Promise<AgentDeletionIdentity<LocalRuntimeSettings> | null> {
    this.#assertOpen();
    let snapshot;
    try {
      snapshot = await this.#client.getDeletionSnapshot(agentId);
    } catch (error) {
      if (isTeamHubNotFound(error)) return null;
      throw error;
    }
    this.#assertOpen();
    if (
      snapshot.agent_id !== agentId ||
      !snapshot.actor_id?.trim() ||
      !snapshot.tenant_id?.trim()
    ) {
      throw new Error("TeamHub deletion identity does not match Agent");
    }
    const keys = new Set<string>();
    const contextRefs = snapshot.contexts.map((context) => {
      const ref = decodeExecutionContextKey(context.context_key);
      if (
        ref.agentId !== agentId ||
        !isDeepStrictEqual(context.ref, toWireRef(ref)) ||
        context.tenant_id !== snapshot.tenant_id ||
        context.agent_actor_id !== snapshot.actor_id ||
        keys.has(context.context_key)
      ) {
        throw new Error(
          "TeamHub deletion Context identity does not match Agent",
        );
      }
      keys.add(context.context_key);
      return ref;
    });
    // Do not populate the Ghost cache: deletion identity cannot activate work.
    return Object.freeze({
      agentId,
      actorId: snapshot.actor_id,
      tenantId: snapshot.tenant_id,
      runtime: this.#parseRuntime(projectRuntime(snapshot.runtime)),
      contextRefs: Object.freeze(contextRefs),
    });
  }

  async refresh(
    agentId: AgentId,
    options?: { readonly shareInFlight: boolean },
  ): ReturnType<NonNullable<GhostStore<LocalRuntimeSettings>["refresh"]>> {
    this.#assertOpen();
    const pending = this.#refreshReads.get(agentId);
    if (options?.shareInFlight && pending?.shareable) return pending.promise;
    const refreshToken = Symbol();
    // Install the fence before even a synchronously throwing client is invoked.
    const promise = Promise.resolve().then(() =>
      this.#refreshSnapshot(agentId, refreshToken),
    );
    this.#refreshReads.set(agentId, {
      token: refreshToken,
      shareable: options?.shareInFlight === true,
      promise,
    });
    return promise;
  }

  async #refreshSnapshot(
    agentId: AgentId,
    refreshToken: symbol,
  ): ReturnType<NonNullable<GhostStore<LocalRuntimeSettings>["refresh"]>> {
    this.#assertOpen();
    const configReadId = randomUUID();
    try {
      const snapshot = await this.#client.getConfig(
        agentId,
        undefined,
        undefined,
        configReadId,
      );
      this.#assertOpen();
      // A callback/cache mutation or newer refresh superseded this response.
      if (this.#refreshReads.get(agentId)?.token !== refreshToken) {
        logIgnoredRuntimeConfigRead(agentId, configReadId);
        return;
      }
      const ghost = snapshotGhost(
        projectSnapshot(snapshot, this.#parseRuntime),
      );
      const activationReady = snapshotActivationReady(snapshot, ghost.revision);
      this.#updateCache(agentId, ghost);
      return { revision: ghost.revision, activationReady };
    } finally {
      if (this.#refreshReads.get(agentId)?.token === refreshToken) {
        this.#refreshReads.delete(agentId);
      }
    }
  }

  async isActivationReady(
    agentId: AgentId,
    revision: string,
  ): Promise<boolean> {
    this.#assertOpen();
    let snapshot: RuntimeConfigSnapshot;
    try {
      let pending = this.#readinessReads.get(agentId);
      if (!pending) {
        pending = this.#client.getConfig(agentId).finally(() => {
          if (this.#readinessReads.get(agentId) === pending) {
            this.#readinessReads.delete(agentId);
          }
        });
        this.#readinessReads.set(agentId, pending);
      }
      snapshot = await pending;
    } catch (error) {
      if (isTeamHubNotFound(error)) {
        throw new AgentManagerError(
          "agent_activation_rejected",
          "Agent registration is no longer materializable",
        );
      }
      if (error instanceof TeamHubRuntimeStateError && error.retryable) {
        throw new AgentManagerError(
          "agent_activation_pending",
          "Registration readiness is temporarily unavailable",
        );
      }
      throw error;
    }
    return snapshotActivationReady(snapshot, revision);
  }

  async insert(
    ghost: GhostInput<LocalRuntimeSettings>,
  ): Promise<"inserted" | "agent_id_conflict"> {
    this.#assertOpen();
    const requested = snapshotGhost(ghost);
    let current: Readonly<Ghost<LocalRuntimeSettings>>;
    try {
      current = await this.#readSnapshot(requested.agentId);
    } catch (error) {
      if (isTeamHubNotFound(error)) return "agent_id_conflict";
      throw error;
    }
    if (!sameRegistration(current, requested)) return "agent_id_conflict";
    this.#updateCache(requested.agentId, current);
    return "inserted";
  }

  async get(
    agentId: AgentId,
  ): Promise<Readonly<Ghost<LocalRuntimeSettings>> | null> {
    this.#assertOpen();
    const cached = this.#cache.get(agentId);
    if (cached) return cached;
    const notFoundUntil = this.#notFoundUntil.get(agentId);
    if (notFoundUntil !== undefined) {
      if (this.#now() < notFoundUntil) return null;
      this.#notFoundUntil.delete(agentId);
    }
    try {
      const ghost = await this.#readSnapshot(agentId);
      this.#updateCache(agentId, ghost);
      return ghost;
    } catch (error) {
      if (isTeamHubNotFound(error)) {
        this.#notFoundUntil.set(agentId, this.#now() + NOT_FOUND_CACHE_TTL_MS);
        // A deletion callback can race the TeamHub registration transition;
        // retain only the in-process projection long enough for that saga.
        return this.#cache.get(agentId) ?? null;
      }
      throw error;
    }
  }

  async list(
    signal?: AbortSignal,
    onReadFailure?: GhostReadFailureHandler,
  ): Promise<readonly Readonly<Ghost<LocalRuntimeSettings>>[]> {
    this.#assertOpen();
    signal?.throwIfAborted();
    const agentIds = [...new Set(await this.#listAgentIds())].sort();
    signal?.throwIfAborted();
    const ghosts: Readonly<Ghost<LocalRuntimeSettings>>[] = [];
    for (const agentId of agentIds) {
      signal?.throwIfAborted();
      const cached = this.#cache.get(agentId);
      if (cached) {
        ghosts.push(cached);
        continue;
      }
      try {
        const ghost = await this.#readSnapshot(agentId, undefined, signal);
        this.#updateCache(agentId, ghost);
        ghosts.push(ghost);
      } catch (error) {
        signal?.throwIfAborted();
        if (isTeamHubNotFound(error)) this.#updateCache(agentId);
        else if (onReadFailure) onReadFailure(agentId, error);
        else throw error;
      }
    }
    return ghosts;
  }

  async setActorId(
    agentId: AgentId,
    actorId: ActorId,
  ): Promise<"updated" | "not_found"> {
    this.#assertOpen();
    const current = await this.get(agentId);
    if (!current) return "not_found";
    if (current.actorId !== undefined && current.actorId !== actorId) {
      throw new Error(`TeamHub Actor identity for Agent "${agentId}" changed`);
    }
    return "updated";
  }

  async replace(
    agentId: AgentId,
    expectedRevision: string,
    ghost: Ghost<LocalRuntimeSettings>,
  ): Promise<"updated" | "not_found" | "revision_conflict"> {
    this.#assertOpen();
    const current = this.#cache.get(agentId);
    // TeamHub already reserved the replacement with business CAS. A profile
    // saved by standalone CLI can leave this process several revisions behind.
    void expectedRevision;
    let projected: Readonly<Ghost<LocalRuntimeSettings>>;
    try {
      projected = await this.#readSnapshot(agentId, ghost.revision);
    } catch (error) {
      if (isTeamHubNotFound(error))
        return current ? "revision_conflict" : "not_found";
      throw error;
    }
    if (!sameRegistration(projected, ghost)) return "revision_conflict";
    if (!current && projected.revision !== ghost.revision) {
      return "revision_conflict";
    }
    this.#updateCache(agentId, projected);
    return "updated";
  }

  async isReplacementCurrent(
    agentId: AgentId,
    ghost: Ghost<LocalRuntimeSettings>,
  ): Promise<boolean> {
    this.#assertOpen();
    try {
      return sameRegistration(await this.#readSnapshot(agentId), ghost);
    } catch (error) {
      if (isTeamHubNotFound(error)) return false;
      throw error;
    }
  }

  async remove(agentId: AgentId): Promise<"removed" | "not_found"> {
    this.#assertOpen();
    const existed =
      this.#cache.has(agentId) || (await this.get(agentId)) !== null;
    this.#updateCache(agentId);
    return existed ? "removed" : "not_found";
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#cache.clear();
    this.#notFoundUntil.clear();
    this.#refreshReads.clear();
    this.#readinessReads.clear();
  }

  #updateCache(
    agentId: AgentId,
    ghost?: Readonly<Ghost<LocalRuntimeSettings>>,
  ): void {
    if (ghost) this.#assertOpen();
    this.#refreshReads.delete(agentId);
    if (ghost) {
      this.#notFoundUntil.delete(agentId);
      this.#cache.set(agentId, ghost);
    } else this.#cache.delete(agentId);
  }

  async #readSnapshot(
    agentId: AgentId,
    revision?: string,
    signal?: AbortSignal,
  ): Promise<Readonly<Ghost<LocalRuntimeSettings>>> {
    signal?.throwIfAborted();
    const snapshot = await this.#client.getConfig(agentId, revision, signal);
    signal?.throwIfAborted();
    return snapshotGhost(projectSnapshot(snapshot, this.#parseRuntime));
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("TeamHub Ghost store is closed");
  }
}

// TeamHub serves the configuration of active registrations only, so a
// snapshot at the Context's revision authorizes activation.
const snapshotActivationReady = (
  snapshot: RuntimeConfigSnapshot,
  revision: string,
): boolean => {
  if (snapshot.configuration_revision !== revision) {
    throw new AgentManagerError(
      "agent_revision_conflict",
      "Context configuration has been superseded; the next input adopts the current one",
    );
  }
  return true;
};

const projectSnapshot = (
  snapshot: RuntimeConfigSnapshot,
  parseRuntime: (value: unknown) => LocalRuntimeSettings,
): GhostInput<LocalRuntimeSettings> => {
  return {
    agentId: snapshot.agent_id,
    actorId: snapshot.actor_id,
    tenantId: snapshot.tenant_id,
    revision: snapshot.configuration_revision,
    runtimeRevision: snapshot.runtime_configuration_revision,
    agent: snapshot.agent,
    ...(snapshot.permission_review ? { permissionReview: true as const } : {}),
    runtime: parseRuntime(projectRuntime(snapshot.runtime)),
    resources: materializeGhostResources({
      skills: snapshot.resources.skills.map((skill) => ({
        skillId: skill.skill_id,
        manifestVersion: skill.manifest_version,
        name: skill.name,
        packageName: skill.package_name,
        packageSha256: skill.package_sha256,
        // materializeGhostResources validates and snapshots the JSON config.
        config: skill.config as SkillDescriptor["config"],
      })),
      mcpServers: snapshot.resources.mcp_servers.map((server) => ({
        mcpId: server.mcp_id,
        manifestVersion: server.manifest_version,
        name: server.name,
        transport: server.transport,
        url: server.url,
        allowedTools: server.allowed_tools,
      })),
    }),
  };
};

/** A Runtime configuration snapshot's runtime in the shape parseRuntimeSettings reads. */
export const projectRuntime = (runtime: RuntimeConfigSnapshot["runtime"]) => ({
  type: "local" as const,
  model: runtime.model,
  ...(runtime.reasoning_effort === undefined
    ? {}
    : { reasoningEffort: runtime.reasoning_effort }),
  placement: {
    type: "local" as const,
    tenantId: runtime.placement.tenant_id,
    ownerActorId: runtime.placement.owner_actor_id,
    computerId: runtime.placement.computer_id,
    runtimeType: runtime.placement.runtime_type,
    workspaceGrantId: runtime.placement.workspace_grant_id,
    assignmentRevision: positiveRevision(runtime.placement.assignment_revision),
  },
});

const positiveRevision = (value: string): number => {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1)
    throw new TypeError("Runtime Assignment revision is invalid");
  return revision;
};

const sameRegistration = (
  left: Readonly<Ghost<LocalRuntimeSettings>>,
  right: Readonly<Ghost<LocalRuntimeSettings>>,
): boolean => {
  // permissionReview is TeamHub's deployment fact, not part of a registration;
  // the Runtime revision comes only from TeamHub's snapshot.
  const withoutActor = (value: Readonly<Ghost<LocalRuntimeSettings>>) => {
    const {
      actorId: _actorId,
      permissionReview: _permissionReview,
      runtimeRevision: _runtimeRevision,
      ...rest
    } = value;
    return rest;
  };
  return isDeepStrictEqual(withoutActor(left), withoutActor(right));
};
