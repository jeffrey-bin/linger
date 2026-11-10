import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { personalWikiDocumentsQueryKey } from "@/features/teamhub/document-queries";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";

export interface WikiRefreshStatus {
  preview?: Record<string, string>;
  failed: boolean;
  initializing: boolean;
  refreshing: boolean;
}

const wikiRefreshPollIntervalMs = 2_000;

/**
 * Observes the refreshes the server runs on its own (after a meeting, the
 * nightly refresh, initialization): polls the Wiki status while one runs and
 * reloads the Wiki and Memory once it completes.
 */
export function usePersonalWikiRefresh(tenantId: string): WikiRefreshStatus {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const refreshStateSeen = useRef(false);
  const seenGeneration = useRef<number | undefined>(undefined);
  const wiki = useQuery({
    queryFn: () =>
      teamHubData(
        client.api.GET("/v0/tenants/{tenantId}/personal-wiki", {
          params: { path: { tenantId } },
        }),
      ),
    queryKey: ["teamhub", tenantId, "personal-wiki", "status"],
    refetchInterval: (query) =>
      query.state.data?.state === "refreshing"
        ? wikiRefreshPollIntervalMs
        : 30_000,
  });
  const refreshing = wiki.data?.state === "refreshing";

  const refreshId = wiki.data?.latest_refresh_id;
  const revision = wiki.data?.preview_revision;
  const preview = useQuery({
    enabled: Boolean(refreshing && refreshId && revision),
    queryKey: [
      "teamhub",
      tenantId,
      "personal-wiki-preview",
      refreshId,
      revision,
    ],
    gcTime: 0,
    placeholderData: (previous, query) =>
      query && query.queryKey[3] === refreshId && query.queryKey[1] === tenantId
        ? previous
        : undefined,
    queryFn: async () => {
      const response = await client.api.GET(
        "/v0/tenants/{tenantId}/personal-wiki/preview",
        {
          params: { path: { tenantId }, query: { refresh_id: refreshId! } },
        },
      );
      if (!response.data) throw new Error("Wiki preview unavailable");
      return response.data;
    },
  });

  useEffect(() => {
    const generation = wiki.data?.published_generation;
    if (generation === undefined) return;
    const published =
      seenGeneration.current !== undefined &&
      generation !== seenGeneration.current;
    const ended = refreshStateSeen.current && !refreshing;
    seenGeneration.current = generation;
    refreshStateSeen.current = refreshing;
    if (!published && !ended) return;
    void queryClient.invalidateQueries({
      queryKey: ["teamhub", tenantId, "personal-wiki"],
    });
    void queryClient.invalidateQueries({
      queryKey: ["teamhub", tenantId, "personal-memory"],
    });
    void queryClient.invalidateQueries({
      queryKey: personalWikiDocumentsQueryKey(tenantId),
    });
  }, [queryClient, refreshing, tenantId, wiki.data?.published_generation]);

  return {
    preview: refreshing && revision ? preview.data : undefined,
    failed: wiki.data?.state === "failed",
    initializing: refreshing && wiki.data?.published_generation === 0,
    refreshing,
  };
}
