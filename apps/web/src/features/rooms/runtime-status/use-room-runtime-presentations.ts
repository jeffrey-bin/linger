import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubRunStatus,
  TeamHubRuntimePresentationEventRecord,
} from "@/features/teamhub/teamhub-types";

import { roomRuntimePresentationEventsQueryOptions } from "./runtime-presentation-events-query";
import { createRuntimePresentationEventsSync } from "./runtime-presentation-events-sync";

export function useRoomRuntimePresentations({
  activeRunStatuses,
  runStatuses,
  roomId,
  tenantId,
}: {
  activeRunStatuses?: readonly TeamHubRunStatus[];
  runStatuses: readonly TeamHubRunStatus[];
  roomId: string;
  tenantId: string;
}) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const syncRef = useRef<ReturnType<
    typeof createRuntimePresentationEventsSync
  > | null>(null);
  const eagerlySyncedRunStatuses = useMemo(
    () => new Map<string, { revision: number; terminal: boolean }>(),
    // Eager-sync bookkeeping is scoped to the Room and its runtime clients.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scope identities are intentional reset keys
    [client, queryClient, roomId, tenantId],
  );
  // Counts eager syncs finished after their Run ended, so the observed set
  // drops them and React Query can collect their events.
  const [releasedSyncs, setReleasedSyncs] = useState(0);
  const runStatusesToSync = activeRunStatuses ?? runStatuses;
  const observedRunStatusIds = useMemo(() => {
    void releasedSyncs;
    const runStatusIds = runStatuses.map((runStatus) => runStatus.id);
    const visibleRunStatusIds = new Set(runStatusIds);
    for (const runStatusId of eagerlySyncedRunStatuses.keys()) {
      if (!visibleRunStatusIds.has(runStatusId)) runStatusIds.push(runStatusId);
    }
    return runStatusIds;
  }, [runStatuses, eagerlySyncedRunStatuses, releasedSyncs]);
  const queries = useQueries({
    queries: observedRunStatusIds.map((runStatusId) => ({
      ...roomRuntimePresentationEventsQueryOptions(
        client,
        tenantId,
        roomId,
        runStatusId,
      ),
      enabled: false,
    })),
  });

  useEffect(() => {
    const sync = createRuntimePresentationEventsSync({
      client,
      onRevisionComplete: (runStatusId) => {
        const target = eagerlySyncedRunStatuses.get(runStatusId);
        if (
          !target?.terminal ||
          !sync.isRevisionComplete(runStatusId, target.revision)
        ) {
          return;
        }
        eagerlySyncedRunStatuses.delete(runStatusId);
        setReleasedSyncs((count) => count + 1);
      },
      queryClient,
      roomId,
      tenantId,
    });
    syncRef.current = sync;
    return () => {
      sync.dispose();
      syncRef.current = null;
    };
  }, [client, queryClient, roomId, tenantId, eagerlySyncedRunStatuses]);
  useEffect(() => {
    const sync = syncRef.current;
    if (!sync) return;
    for (const runStatus of runStatusesToSync) {
      const current = eagerlySyncedRunStatuses.get(runStatus.id);
      eagerlySyncedRunStatuses.set(runStatus.id, {
        revision: Math.max(current?.revision ?? -1, runStatus.revision),
        terminal: runStatus.status !== "active",
      });
    }
    for (const runStatus of runStatuses) {
      const current = eagerlySyncedRunStatuses.get(runStatus.id);
      if (!current && runStatus.status !== "aborted") continue;
      const target = {
        revision: Math.max(current?.revision ?? -1, runStatus.revision),
        terminal: runStatus.status !== "active",
      };
      eagerlySyncedRunStatuses.set(runStatus.id, target);
      sync.request(runStatus.id, target.revision);
    }
    const shownRunStatusIds = new Set(
      [...runStatuses, ...runStatusesToSync].map((runStatus) => runStatus.id),
    );
    for (const [runStatusId, target] of eagerlySyncedRunStatuses) {
      if (target.terminal || shownRunStatusIds.has(runStatusId)) continue;
      // The Run left before its end reached this hook (a reconnect snapshot
      // omits succeeded Runs, or updates were batched): read once more now
      // that it has ended, then release it.
      const ended = { revision: target.revision + 1, terminal: true };
      eagerlySyncedRunStatuses.set(runStatusId, ended);
      sync.request(runStatusId, ended.revision);
    }
    for (const [runStatusId, target] of eagerlySyncedRunStatuses) {
      if (
        target.terminal &&
        sync.isRevisionComplete(runStatusId, target.revision)
      ) {
        eagerlySyncedRunStatuses.delete(runStatusId);
      }
    }
    const retainedRunStatusIds = new Set(
      runStatuses.map((runStatus) => runStatus.id),
    );
    for (const runStatusId of eagerlySyncedRunStatuses.keys()) {
      retainedRunStatusIds.add(runStatusId);
    }
    sync.retain(retainedRunStatusIds);
  }, [runStatuses, runStatusesToSync, eagerlySyncedRunStatuses, releasedSyncs]);

  return useMemo(() => {
    const eventsByRunStatusId: Record<
      string,
      readonly TeamHubRuntimePresentationEventRecord[]
    > = {};
    const publishedOrdinals: string[] = [];
    const queryIndexByRunStatusId = new Map(
      observedRunStatusIds.map((runStatusId, index) => [runStatusId, index]),
    );
    for (const runStatus of runStatuses) {
      const index = queryIndexByRunStatusId.get(runStatus.id);
      const page = index === undefined ? undefined : queries[index]?.data;
      if (!page) continue;
      eventsByRunStatusId[runStatus.id] = page.items;
      publishedOrdinals.push(
        `${runStatus.id}:${page.published_through_ordinal}`,
      );
    }
    return {
      eventsByRunStatusId,
      progressVersion: publishedOrdinals.join("|"),
    };
  }, [runStatuses, observedRunStatusIds, queries]);
}
