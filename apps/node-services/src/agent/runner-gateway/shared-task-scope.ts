import type { SharedTaskScope as SharedTaskScopeWire } from "@linger/wire-contracts/runner-gateway/types";
import type { SharedTaskScope } from "../executor/context-ref.js";

/** The receiver resolves the scope under its own shared root. */
export const sharedTaskScopeWire = (
  scope: SharedTaskScope | undefined,
): { shared_task_scope?: SharedTaskScopeWire } =>
  scope
    ? {
        shared_task_scope: {
          version: scope.version,
          tenant_id: scope.tenantId,
          agent_id: scope.agentId,
          origin_room_id: scope.originRoomId,
          role: scope.role,
          ...(scope.role === "alter_ego" ? { task_id: scope.taskId } : {}),
        },
      }
    : {};
