import { useLocalRuntimeSelection } from "./use-local-runtime-selection";

export function useAgentPlacementFlow({ tenantId }: { tenantId: string }) {
  const selection = useLocalRuntimeSelection({
    tenantId,
    watchForComputer: true,
  });
  const localPlacement =
    !selection.error &&
    selection.computer &&
    selection.runtime &&
    selection.workspaceGrant
      ? {
          computerId: selection.computer.computer_id,
          runtimeType: selection.runtime,
          type: "local" as const,
          workspaceGrantId: selection.workspaceGrant.grant_id,
        }
      : undefined;

  return { localPlacement, selection };
}
