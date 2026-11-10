import { createTeamHubAgentRuntimeStateClient } from "@linger/wire-contracts/teamhub-internal/client";
import type { components } from "@linger/wire-contracts/teamhub-internal/types";
import type { TeamHubCliConfigurationSource } from "../../executor/local-backend.js";

export type MemoryDocument = components["schemas"]["AgentMemoryDocument"];
export interface MemoryClient {
  read(agentId: string, signal?: AbortSignal): Promise<MemoryDocument>;
  commit(
    agentId: string,
    document: MemoryDocument,
    signal?: AbortSignal,
  ): Promise<MemoryDocument>;
}
export function createMemoryClient(
  options: TeamHubCliConfigurationSource,
): MemoryClient {
  const client = createTeamHubAgentRuntimeStateClient(options);
  async function read(response: Response): Promise<MemoryDocument> {
    if (!response.ok)
      throw new Error(`Agent memory request failed (${response.status})`);
    return (await response.json()) as MemoryDocument;
  }
  return {
    read: async (id, signal) => read(await client.getMemory(id, signal)),
    commit: async (id, document, signal) =>
      read(await client.commitMemory(id, document, signal)),
  };
}
