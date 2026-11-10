import type { RunnerHello } from "@linger/wire-contracts/runner-gateway/types";

import { RunnerGatewayProtocolError } from "./runner-operation.js";

export interface RunnerGatewayPrincipal {
  readonly runnerId: string;
  /** The credential generation the Computer authenticated with. */
  readonly credentialGeneration: number;
  readonly tenantOwners: readonly {
    readonly tenantId: string;
    readonly ownerActorId: string;
  }[];
}

export const validateRunnerGatewayPrincipal = (
  principal: RunnerGatewayPrincipal,
): RunnerGatewayPrincipal => {
  if (
    typeof principal !== "object" ||
    principal === null ||
    typeof principal.runnerId !== "string" ||
    principal.runnerId.trim().length === 0 ||
    !Number.isSafeInteger(principal.credentialGeneration) ||
    principal.credentialGeneration < 0 ||
    !Array.isArray(principal.tenantOwners) ||
    principal.tenantOwners.length === 0
  ) {
    throw new RunnerGatewayProtocolError(
      "Authenticated Runner principal is invalid",
    );
  }
  const tenantIds = new Set<string>();
  const tenantOwners = principal.tenantOwners.map((tenantOwner) => {
    if (
      typeof tenantOwner !== "object" ||
      tenantOwner === null ||
      typeof tenantOwner.tenantId !== "string" ||
      tenantOwner.tenantId.trim().length === 0 ||
      typeof tenantOwner.ownerActorId !== "string" ||
      tenantOwner.ownerActorId.trim().length === 0 ||
      tenantIds.has(tenantOwner.tenantId)
    ) {
      throw new RunnerGatewayProtocolError(
        "Authenticated Runner principal is invalid",
      );
    }
    tenantIds.add(tenantOwner.tenantId);
    return {
      tenantId: tenantOwner.tenantId,
      ownerActorId: tenantOwner.ownerActorId,
    };
  });
  return {
    runnerId: principal.runnerId,
    credentialGeneration: principal.credentialGeneration,
    tenantOwners,
  };
};

export const assertRunnerHelloScope = (
  principal: RunnerGatewayPrincipal,
  hello: RunnerHello,
): void => {
  const tenantIds = new Set(
    principal.tenantOwners.map(({ tenantId }) => tenantId),
  );
  if (
    hello.workspace_grants.some(
      ({ tenant_id: tenantId }) => !tenantIds.has(tenantId),
    ) ||
    hello.agent_runners.some(
      ({ tenant_id: tenantId }) => !tenantIds.has(tenantId),
    ) ||
    hello.active_operations.some(
      ({ tenant_id: tenantId }) => !tenantIds.has(tenantId),
    )
  ) {
    throw new RunnerGatewayProtocolError(
      "Runner inventory exceeds authenticated Tenant scope",
    );
  }
};
