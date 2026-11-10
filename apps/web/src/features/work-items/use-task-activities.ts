import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { reportTeamHubAuthenticationRequired } from "@/features/teamhub/teamhub-authentication";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { TeamHubError } from "@/features/teamhub/teamhub-error";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubTaskActivityPage,
  TeamHubRunStatus,
  TeamHubTaskExecution,
} from "@/features/teamhub/teamhub-types";
import { roomMessagesQueryKey } from "@/features/rooms/room-queries";
import { tenantWorkItemTargetQueryOptions } from "./work-item-queries";

export function taskActivitiesQueryKey(tenantId: string, taskId: string) {
  return ["teamhub", tenantId, "task-activities", taskId] as const;
}

export function taskExecutionStopped(execution?: TeamHubTaskExecution | null) {
  return Boolean(execution && execution.status !== "running");
}

export function isTaskActivityNotFound(error: unknown) {
  return error instanceof TeamHubError && error.status === 404;
}

async function optionalTaskRead<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (isTaskActivityNotFound(error)) return null;
    throw error;
  }
}

export function useTaskActivities({
  tenantId,
  taskId,
  enabled,
}: {
  tenantId: string;
  taskId: string;
  enabled: boolean;
}) {
  const { client, runStatuses } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const [connectedRoom, setConnectedRoom] = useState<string>();
  const item = useQuery({
    ...tenantWorkItemTargetQueryOptions(client, tenantId, taskId),
    enabled,
    refetchInterval: enabled ? 2_000 : false,
  });
  const execution = useQuery({
    queryKey: ["teamhub", tenantId, "task-execution", taskId],
    queryFn: () =>
      optionalTaskRead(() =>
        teamHubData(
          client.api.GET("/v0/tasks/{taskId}/execution", {
            params: { path: { taskId } },
          }),
        ),
      ),
    enabled: enabled && Boolean(item.data),
    // A delegated Task has no terminal state: its Meta can wake an idle,
    // failed or canceled Task at any time, so those are polled slowly.
    refetchInterval: (query) =>
      !enabled || query.state.data === null
        ? false
        : ["idle", "failed", "canceled"].includes(
              query.state.data?.status ?? "",
            )
          ? 10_000
          : 2_000,
  });
  const activities = useInfiniteQuery({
    queryKey: taskActivitiesQueryKey(tenantId, taskId),
    queryFn: ({ pageParam, signal }) =>
      client.workItems.listActivities(
        taskId,
        { cursor: pageParam, limit: 50 },
        { signal },
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor,
    enabled: enabled && Boolean(item.data),
    retry: (count, error) => !isTaskActivityNotFound(error) && count < 2,
    refetchInterval: (query) => {
      if (!enabled || isTaskActivityNotFound(query.state.error)) return false;
      const page = query.state.data?.pages[0];
      return page?.work_room_id && connectedRoom !== page.work_room_id
        ? 2_000
        : false;
    },
  });
  const roomId = !activities.error
    ? activities.data?.pages[0]?.work_room_id
    : undefined;

  // Resource identity alone owns the subscription. Every snapshot, including an
  // empty reconnect snapshot, recovers completed Run Statuses from persisted history.
  useEffect(() => {
    if (!enabled || !roomId) return;
    let refresh: ReturnType<typeof setTimeout> | undefined;
    const key = taskActivitiesQueryKey(tenantId, taskId);
    const unsubscribe = runStatuses.subscribe({
      roomId,
      onSessionExpired: reportTeamHubAuthenticationRequired,
      onError: () => setConnectedRoom(undefined),
      onCollection: (items) => {
        setConnectedRoom(roomId);
        const updates = new Map(
          items.map((runStatus) => [runStatus.id, runStatus]),
        );
        queryClient.setQueryData<InfiniteData<TeamHubTaskActivityPage>>(
          key,
          (current) =>
            current
              ? {
                  ...current,
                  pages: current.pages.map((page) => ({
                    ...page,
                    active_items: page.active_items.map((runStatus) =>
                      newerRunStatus(runStatus, updates.get(runStatus.id)),
                    ),
                    history_items: page.history_items.map((runStatus) =>
                      newerRunStatus(runStatus, updates.get(runStatus.id)),
                    ),
                  })),
                }
              : current,
        );
        if (refresh !== undefined) return;
        refresh = setTimeout(() => {
          refresh = undefined;
          void queryClient.invalidateQueries({ queryKey: key });
          void queryClient.invalidateQueries({
            queryKey: roomMessagesQueryKey(tenantId, roomId),
          });
        }, 100);
      },
    });
    return () => {
      unsubscribe();
      if (refresh !== undefined) clearTimeout(refresh);
    };
  }, [enabled, runStatuses, queryClient, roomId, taskId, tenantId]);

  const runStatusesById = new Map<string, TeamHubRunStatus>();
  for (const page of activities.data?.pages ?? []) {
    for (const runStatus of [...page.active_items, ...page.history_items]) {
      runStatusesById.set(
        runStatus.id,
        newerRunStatus(runStatus, runStatusesById.get(runStatus.id)),
      );
    }
  }
  return {
    item,
    execution,
    activities,
    roomId,
    runStatuses: [...runStatusesById.values()],
    connected: connectedRoom === roomId && Boolean(roomId),
  };
}

function newerRunStatus(
  runStatus: TeamHubRunStatus,
  update?: TeamHubRunStatus,
) {
  return update && update.revision > runStatus.revision ? update : runStatus;
}
