import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { localComputersQueryKey } from "@/features/local-computer/local-computer-queries";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubLocalComputerPage,
  TeamHubLocalRuntimeType,
} from "@/features/teamhub/teamhub-types";

export function useLocalRuntimeSelection({
  tenantId,
  watchForComputer = false,
}: {
  tenantId: string;
  watchForComputer?: boolean;
}) {
  const [requestedComputerId, setRequestedComputerId] = useState("");
  const [requestedRuntime, setRequestedRuntime] = useState("");
  const { client } = useTeamHubRuntime();
  const query = useQuery({
    queryFn: () => client.listTenantLocalComputers(tenantId),
    queryKey: localComputersQueryKey(tenantId),
    refetchInterval: (current) => {
      if (!watchForComputer || current.state.error) return false;
      const online = (current.state.data?.items ?? []).some(
        (computer) => computer.status === "online",
      );
      return online ? false : 2_000;
    },
    retry: false,
    staleTime: 30_000,
  });
  // An offline Computer can take a new Agent; it runs once it connects.
  const computers = (query.data?.items ?? []).filter(
    ({ upgrade_required }) => !upgrade_required,
  );
  const computer =
    computers.find(({ computer_id }) => computer_id === requestedComputerId) ??
    computers[0];
  const selectableRuntimes =
    computer?.runtimes.filter(isCreationCapableRuntime) ?? [];
  const fallbackRuntime =
    selectableRuntimes.find(({ status }) => status === "ready") ??
    selectableRuntimes[0];
  const runtimeDiagnostic =
    selectableRuntimes.find(({ type }) => type === requestedRuntime) ??
    fallbackRuntime;
  const workspaceGrant = computer?.workspace_grants[0];
  const runtimeType: TeamHubLocalRuntimeType | "" =
    runtimeDiagnostic?.type ?? "";

  return {
    computer,
    computers,
    error: query.error,
    isPending: query.isPending,
    refetch: query.refetch,
    runtime: runtimeType,
    runtimeDiagnostic,
    runtimeModels: runtimeDiagnostic?.models ?? [],
    selectComputer(computerId: string) {
      setRequestedComputerId(computerId);
      setRequestedRuntime("");
    },
    selectRuntime: setRequestedRuntime,
    workspaceGrant,
  };
}

const isCreationCapableRuntime = (
  runtime: TeamHubLocalComputerPage["items"][number]["runtimes"][number],
): boolean =>
  runtime.status === "ready" || runtime.status === "authentication_required";
