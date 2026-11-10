import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { teamHubData, teamHubDone } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubMemoryEntry } from "@/features/teamhub/teamhub-types";

/** The read-only page of one meeting. */
export function meetingPath(tenantId: string, meetingId: string) {
  return `/t/${encodeURIComponent(tenantId)}/library/meetings?entry=${encodeURIComponent(meetingId)}`;
}

export function useMeetings(tenantId: string) {
  const { client } = useTeamHubRuntime();
  return useQuery({
    queryFn: () => listEveryMeetingPage(client, tenantId),
    queryKey: ["teamhub", tenantId, "personal-memory", "meetings"],
    staleTime: 15_000,
    refetchInterval: 15_000,
  });
}

/**
 * Hides a meeting from the caller's own Meetings; others who can read it
 * still see it, and what Memory already took in stays.
 */
export function useHideMeeting(tenantId: string) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const key = ["teamhub", tenantId, "personal-memory", "meetings"];
  return useMutation({
    mutationFn: (captureId: string) =>
      teamHubDone(
        client.api.DELETE(
          "/v0/tenants/{tenantId}/me/meetings/{captureSessionId}",
          { params: { path: { tenantId, captureSessionId: captureId } } },
        ),
      ),
    onSuccess: (_, captureId) => {
      queryClient.setQueryData<TeamHubMemoryEntry[]>(key, (entries) =>
        entries?.filter((entry) => entry.meeting?.capture_id !== captureId),
      );
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
}

async function listEveryMeetingPage(client: TeamHubClient, tenantId: string) {
  const items: TeamHubMemoryEntry[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  while (true) {
    const page = await teamHubData(
      client.api.GET("/v0/tenants/{tenantId}/memory", {
        params: {
          path: { tenantId },
          query: { ...(cursor ? { cursor } : {}), kind: "meeting", limit: 100 },
        },
      }),
    );
    items.push(...page.items);
    if (!page.next_cursor) return items;
    if (seenCursors.has(page.next_cursor)) {
      throw new Error("Memory pagination returned a repeated cursor.");
    }
    seenCursors.add(page.next_cursor);
    cursor = page.next_cursor;
  }
}
