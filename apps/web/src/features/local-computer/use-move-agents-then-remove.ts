import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import {
  type AgentMoveTarget,
  agentRuntimeUpdate,
} from "@/features/rooms/members/agent-move-target";
import {
  teamHubQueryRoot,
  tenantActorsQueryKey,
  tenantAgentsQueryKey,
  tenantRoomsQueryKey,
} from "@/features/rooms/room-queries";
import { teamHubData, teamHubDone } from "@/features/teamhub/teamhub-api";
import { type TeamHubClient } from "@/features/teamhub/teamhub-client";
import type { TeamHubTenantAgent } from "@/features/teamhub/teamhub-types";

import { localComputersQueryKey } from "./local-computer-queries";

export type AgentMovePlan =
  | { action: "delete"; agent: TeamHubTenantAgent }
  | { action: "move"; agent: TeamHubTenantAgent; target: AgentMoveTarget };

export type AgentMoveProgress =
  | { state: "deleting" | "deleted" | "moving" | "moved" }
  | { state: "failed"; message: string };

type MoveClient = Pick<TeamHubClient, "api">;

/** Moves the Agent to the target in one update. The target may be offline:
 * the Agent waits for it. An Agent already on the target is left alone, so a
 * retried run does not conflict with its own earlier move. */
export async function moveAgent(
  client: MoveClient,
  tenantId: string,
  plan: Extract<AgentMovePlan, { action: "move" }>,
) {
  const { agent, target } = plan;
  if (agent.runtime.placement?.computer_id === target.computerId) return agent;
  return teamHubData(
    client.api.PATCH("/v0/tenants/{tenantId}/agents/{agentId}", {
      params: { path: { tenantId, agentId: agent.actor.id } },
      body: {
        expected_configuration_revision: agent.configuration_revision,
        runtime: agentRuntimeUpdate(target),
      },
    }),
  );
}

/** Moves or deletes Agents one at a time so a Computer can be removed. The
 * first failure stops the run; a later run skips Agents already finished. */
export function useMoveAgentsThenRemove({
  client,
  tenantId,
}: {
  client: MoveClient;
  tenantId: string;
}) {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<
    ReadonlyMap<string, AgentMoveProgress>
  >(() => new Map());
  const [running, setRunning] = useState(false);
  const finished = useRef(new Set<string>());

  function report(actorId: string, next: AgentMoveProgress) {
    setProgress((current) => new Map(current).set(actorId, next));
  }

  async function refresh() {
    await Promise.all(
      [
        tenantAgentsQueryKey(tenantId),
        tenantActorsQueryKey(tenantId),
        tenantRoomsQueryKey(tenantId),
        [...teamHubQueryRoot, tenantId, "room"],
        localComputersQueryKey(tenantId),
      ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    );
  }

  /** Returns true once every planned Agent is moved or deleted. */
  async function run(plans: readonly AgentMovePlan[]) {
    setRunning(true);
    try {
      for (const plan of plans) {
        const actorId = plan.agent.actor.id;
        if (finished.current.has(actorId)) continue;
        report(actorId, {
          state: plan.action === "delete" ? "deleting" : "moving",
        });
        try {
          if (plan.action === "delete") {
            await teamHubDone(
              client.api.DELETE("/v0/tenants/{tenantId}/agents/{agentId}", {
                params: { path: { tenantId, agentId: actorId } },
              }),
            );
          } else {
            await moveAgent(client, tenantId, plan);
          }
        } catch (error) {
          report(actorId, {
            state: "failed",
            message: error instanceof Error ? error.message : String(error),
          });
          await refresh();
          return false;
        }
        finished.current.add(actorId);
        report(actorId, {
          state: plan.action === "delete" ? "deleted" : "moved",
        });
        await refresh();
      }
      return true;
    } finally {
      setRunning(false);
    }
  }

  return {
    failed: [...progress.values()].some((item) => item.state === "failed"),
    isFinished: (actorId: string) => finished.current.has(actorId),
    progress,
    run,
    running,
  };
}
