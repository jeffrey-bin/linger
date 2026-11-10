import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import { roomRuntimePresentationEventsQueryOptions } from "./runtime-presentation-events-query";
import { createRuntimePresentationEventsSync } from "./runtime-presentation-events-sync";

export function useTaskActivityEvents({
  tenantId,
  roomId,
  runStatusId,
  revision,
  enabled,
}: {
  tenantId: string;
  roomId: string;
  runStatusId: string;
  revision: number;
  enabled: boolean;
}) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const syncRef =
    useRef<ReturnType<typeof createRuntimePresentationEventsSync>>(undefined);
  const query = useQuery({
    ...roomRuntimePresentationEventsQueryOptions(
      client,
      tenantId,
      roomId,
      runStatusId,
    ),
    enabled: false,
  });
  useEffect(() => {
    if (!enabled) return;
    const sync = createRuntimePresentationEventsSync({
      client,
      queryClient,
      tenantId,
      roomId,
    });
    syncRef.current = sync;
    return () => {
      sync.dispose();
      syncRef.current = undefined;
    };
  }, [client, queryClient, tenantId, roomId, runStatusId, enabled]);
  useEffect(() => {
    if (enabled) syncRef.current?.request(runStatusId, revision);
  }, [runStatusId, revision, enabled, client, queryClient, tenantId, roomId]);
  return query;
}
