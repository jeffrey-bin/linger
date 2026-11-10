import type { QueryClient } from "@tanstack/react-query";

import { clearRoomDrafts } from "@/features/rooms/room-drafts";
import { clearTeamHubQueries } from "@/features/rooms/room-queries";
import { clearGlobalSearchHistory } from "@/features/search/global-search-recent";

export function clearLocalAuthenticatedState(queryClient: QueryClient) {
  clearTeamHubQueries(queryClient);
  clearRoomDrafts();
  clearGlobalSearchHistory();
}
