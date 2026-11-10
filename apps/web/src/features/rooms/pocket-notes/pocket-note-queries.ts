import {
  infiniteQueryOptions,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";

import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import { teamHubQueryRoot } from "@/features/rooms/room-queries";
import type {
  TeamHubPocketNote,
  TeamHubPocketNotePage,
} from "@/features/teamhub/teamhub-types";

type PocketNotesData = InfiniteData<TeamHubPocketNotePage, string | undefined>;

export function pocketNotesQueryKey(tenantId: string) {
  return [...teamHubQueryRoot, tenantId, "pocket-notes"] as const;
}

export function pocketNotesQueryOptions(
  client: TeamHubClient,
  tenantId: string,
) {
  return infiniteQueryOptions({
    getNextPageParam: (page: TeamHubPocketNotePage) =>
      page.page.has_more ? page.page.next_cursor : undefined,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      teamHubData(
        client.api.GET("/v0/tenants/{tenantId}/me/pocket-notes", {
          params: { path: { tenantId }, query: { cursor: pageParam } },
        }),
      ),
    queryKey: pocketNotesQueryKey(tenantId),
    // The page list decides which day is "today", so refresh it whenever the
    // notepad opens again instead of trusting a page cached before midnight.
    staleTime: 0,
  });
}

/** Writes today's page into the cached list: newest first, empty pages dropped. */
export function storeTodayPocketNote(
  queryClient: QueryClient,
  tenantId: string,
  note: TeamHubPocketNote,
) {
  queryClient.setQueryData<PocketNotesData>(
    pocketNotesQueryKey(tenantId),
    (data) => {
      if (!data) return data;
      const pages = data.pages.map((page, index) => {
        const items = page.items.filter((item) => item.date !== note.date);
        return index === 0 && note.text
          ? { ...page, items: [note, ...items] }
          : { ...page, items };
      });
      return { ...data, pages };
    },
  );
}

/** Drops a deleted past day from the cached list. */
export function removePocketNote(
  queryClient: QueryClient,
  tenantId: string,
  date: string,
) {
  queryClient.setQueryData<PocketNotesData>(
    pocketNotesQueryKey(tenantId),
    (data) =>
      data && {
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          items: page.items.filter((item) => item.date !== date),
        })),
      },
  );
}
