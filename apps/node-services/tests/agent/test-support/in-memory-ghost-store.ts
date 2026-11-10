import type { ActorId, AgentId } from "../../../src/agent/executor/types.js";
import type {
  Ghost,
  GhostInput,
  GhostStore,
} from "../../../src/agent/executor/ghost.js";
import { snapshotGhost } from "../../../src/agent/executor/ghost.js";

export const createInMemoryGhostStore = <
  TRuntimeSettings,
>(): GhostStore<TRuntimeSettings> => new InMemoryGhostStore<TRuntimeSettings>();

class InMemoryGhostStore<
  TRuntimeSettings,
> implements GhostStore<TRuntimeSettings> {
  readonly #ghosts = new Map<AgentId, Readonly<Ghost<TRuntimeSettings>>>();

  async insert(
    ghost: GhostInput<TRuntimeSettings>,
  ): Promise<"inserted" | "agent_id_conflict"> {
    if (this.#ghosts.has(ghost.agentId)) {
      return "agent_id_conflict";
    }
    this.#ghosts.set(ghost.agentId, snapshotGhost(ghost));
    return "inserted";
  }

  async get(
    agentId: AgentId,
  ): Promise<Readonly<Ghost<TRuntimeSettings>> | null> {
    const ghost = this.#ghosts.get(agentId);
    return ghost ? snapshotGhost(ghost) : null;
  }

  async list(): Promise<readonly Readonly<Ghost<TRuntimeSettings>>[]> {
    return [...this.#ghosts.values()]
      .map((ghost) => snapshotGhost(ghost))
      .sort((left, right) => left.agentId.localeCompare(right.agentId));
  }

  async setActorId(
    agentId: AgentId,
    actorId: ActorId,
  ): Promise<"updated" | "not_found"> {
    const ghost = this.#ghosts.get(agentId);
    if (!ghost) {
      return "not_found";
    }
    this.#ghosts.set(agentId, snapshotGhost({ ...ghost, actorId }));
    return "updated";
  }

  async replace(
    agentId: AgentId,
    expectedRevision: string,
    ghost: Ghost<TRuntimeSettings>,
  ): Promise<"updated" | "not_found" | "revision_conflict"> {
    const current = this.#ghosts.get(agentId);
    if (!current) return "not_found";
    if (current.revision !== expectedRevision) return "revision_conflict";
    this.#ghosts.set(agentId, snapshotGhost(ghost));
    return "updated";
  }

  async remove(agentId: AgentId): Promise<"removed" | "not_found"> {
    return this.#ghosts.delete(agentId) ? "removed" : "not_found";
  }

  async close(): Promise<void> {}
}
