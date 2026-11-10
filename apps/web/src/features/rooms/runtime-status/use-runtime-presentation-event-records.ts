import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";

import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";

import { roomRunStatusesQueryOptions } from "../room-queries";

import { roomRuntimePresentationEventsQueryOptions } from "./runtime-presentation-events-query";
import { createRuntimePresentationEventsSync } from "./runtime-presentation-events-sync";

export function useRuntimePresentationEventRecords({
  runStatusId: inputRunStatusId,
  runId,
  actorId,
  enabled = true,
  roomId,
  tenantId,
}: {
  runStatusId: string;
  runId?: string;
  actorId?: string;
  enabled?: boolean;
  roomId: string;
  tenantId: string;
}) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  // The conversation owns the Run Status stream; observing its Query adds no SSE.
  const collection = useQuery({
    ...roomRunStatusesQueryOptions(client, tenantId, roomId),
    enabled: false,
  });
  const liveRunStatus = collection.data?.items.find(
    (item) =>
      (runId ? item.run_id === runId : item.id === inputRunStatusId) &&
      (!actorId || item.agent.id === actorId),
  );
  const runStatusQueryKey = useMemo(
    () => [
      "teamhub",
      tenantId,
      "room",
      roomId,
      "activity-run-status",
      runId,
      actorId,
    ],
    [tenantId, roomId, runId, actorId],
  );
  const runStatusQuery = useQuery({
    queryKey: runStatusQueryKey,
    queryFn: () => client.listRoomRuntimePresentationRuns(roomId, [], runId),
    enabled: enabled && Boolean(runId) && !liveRunStatus,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
  useEffect(() => {
    if (runId && liveRunStatus) {
      // Keep the latest observed Run Status when a later snapshot drops a terminal
      // Run. The one fallback lookup may have preceded its first publication.
      void queryClient.cancelQueries({
        queryKey: runStatusQueryKey,
        exact: true,
      });
      queryClient.setQueryData(runStatusQueryKey, { items: [liveRunStatus] });
    }
  }, [queryClient, runStatusQueryKey, runId, liveRunStatus]);
  // A completed Run may have left the live collection. Resolve it once.
  const runStatus =
    liveRunStatus ??
    (runId
      ? runStatusQuery.data?.items.find(
          (item) =>
            item.run_id === runId && (!actorId || item.agent.id === actorId),
        )
      : undefined);
  const runStatusId = runId ? (runStatus?.id ?? "") : inputRunStatusId;
  const syncRef =
    useRef<ReturnType<typeof createRuntimePresentationEventsSync>>(undefined);
  const query = useQuery({
    ...roomRuntimePresentationEventsQueryOptions(
      client,
      tenantId,
      roomId,
      runStatusId,
    ),
    enabled: enabled && Boolean(runStatusId),
    retry: false,
  });

  useEffect(() => {
    if (!enabled || !runStatusId) return;
    const sync = createRuntimePresentationEventsSync({
      client,
      queryClient,
      roomId,
      tenantId,
    });
    syncRef.current = sync;
    sync.retain(new Set([runStatusId]));
    return () => {
      sync.dispose();
      syncRef.current = undefined;
    };
  }, [client, queryClient, roomId, tenantId, runStatusId, enabled]);
  useEffect(() => {
    if (enabled && runStatusId)
      syncRef.current?.request(runStatusId, runStatus?.revision ?? 0);
  }, [
    client,
    queryClient,
    roomId,
    tenantId,
    runStatusId,
    runStatus?.revision,
    enabled,
  ]);

  return {
    error:
      runId && !liveRunStatus
        ? (runStatusQuery.error ?? query.error)
        : query.error,
    items: query.data?.items ?? [],
    pending:
      (Boolean(runId) && !liveRunStatus && runStatusQuery.isLoading) ||
      (Boolean(runStatusId) && query.isLoading),
  };
}
