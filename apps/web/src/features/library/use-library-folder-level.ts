import {
  type InfiniteData,
  type UseQueryResult,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import { useEffect } from "react";

import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubDocumentPage,
  TeamHubMyDocumentTree,
} from "@/features/teamhub/teamhub-types";

import type { LibraryRowDocument } from "./library-document-results";
import {
  folderChildren,
  folderDescendantDocuments,
  folderTrail,
} from "./library-folder-browser";
import type { WorkspaceTab } from "./library-workspace-tabs";

export type LibraryView = "owned" | "recent" | "shared";

interface LibraryFolderLevelInput {
  client: TeamHubClient;
  fileType: string;
  requestedFolder: string | null;
  tab: WorkspaceTab;
  tenantId: string;
  tree: UseQueryResult<TeamHubMyDocumentTree, Error>;
}

/**
 * The open folder level of the active tab, with each row's "Visible in"
 * sources joined from the smart view.
 */
export function useLibraryFolderLevel({
  client,
  fileType,
  requestedFolder,
  tab,
  tenantId,
  tree,
}: LibraryFolderLevelInput) {
  const view: LibraryView = tab === "shared" ? "shared" : "owned";
  const sharedTree = useQuery({
    enabled: tab === "shared",
    queryFn: () =>
      teamHubData(
        client.api.GET("/v0/tenants/{tenantId}/me/shared-document-tree", {
          params: { path: { tenantId } },
        }),
      ),
    queryKey: ["teamhub", tenantId, "shared-document-tree"],
  });
  // My pages and Shared with me list exactly what their sidebar trees show:
  // one folder level at a time, never Documents that sit inside a folder.
  const browsedTree = tab === "shared" ? sharedTree : tree;
  const browsedItems = browsedTree.data?.items ?? [];
  const requestedFolderId =
    tab === "meetings" ? undefined : (requestedFolder ?? undefined);
  const trail = folderTrail(browsedItems, requestedFolderId);
  // A deleted or unknown folder falls back to the tab root.
  const folderId = trail.length > 0 ? requestedFolderId : undefined;
  // A type filter searches the whole open folder, not only its first level.
  const openedFolder = fileType
    ? {
        documents: folderDescendantDocuments(browsedItems, folderId),
        folders: [],
      }
    : folderChildren(browsedItems, folderId);
  // The smart view only supplies each row's "Visible in" sources.
  const library = useLibraryDocuments(view, tab !== "meetings");
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = library;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);
  const sourcesById = new Map(
    (library.data?.pages ?? []).flatMap((page) =>
      page.items.map((document) => [document.id, document.from] as const),
    ),
  );
  const levelDocuments: LibraryRowDocument[] = openedFolder.documents.map(
    (document) => ({ ...document, from: sourcesById.get(document.id) }),
  );
  return { browsedTree, folderId, levelDocuments, openedFolder, trail };
}

export function useLibraryDocuments(view: LibraryView, enabled: boolean) {
  const { client } = useTeamHubRuntime();
  return useInfiniteQuery<
    TeamHubDocumentPage,
    Error,
    InfiniteData<TeamHubDocumentPage>,
    readonly ["teamhub", "library-documents", LibraryView],
    string | undefined
  >({
    enabled,
    getNextPageParam: (lastPage) =>
      lastPage.page.has_more ? lastPage.page.next_cursor : undefined,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      teamHubData(
        client.api.GET("/v0/library/documents", {
          params: {
            query: {
              view,
              ...(pageParam ? { cursor: pageParam } : {}),
              limit: 50,
            },
          },
        }),
      ),
    queryKey: ["teamhub", "library-documents", view],
  });
}
