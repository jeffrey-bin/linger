import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";

import { roomMessageRunStatusesQueryOptions } from "../room-queries";

export function useRoomMessageRunStatuses({
  messageIds,
  roomId,
  tenantId,
}: {
  messageIds: readonly string[];
  roomId: string;
  tenantId: string;
}) {
  const { client } = useTeamHubRuntime();
  const normalizedMessageIds = useMemo(
    () => normalizeRuntimePresentationMessageIds(messageIds),
    [messageIds],
  );
  const query = useQuery({
    ...roomMessageRunStatusesQueryOptions(
      client,
      tenantId,
      roomId,
      normalizedMessageIds,
    ),
    enabled: normalizedMessageIds.length > 0,
  });
  return query.data?.items ?? [];
}

export function normalizeRuntimePresentationMessageIds(
  messageIds: readonly string[],
) {
  return [...new Set(messageIds.slice(-100))].sort();
}
