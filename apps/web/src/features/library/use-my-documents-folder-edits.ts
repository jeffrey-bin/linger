import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { teamHubData, teamHubDone } from "@/features/teamhub/teamhub-api";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubDocumentPlacementNode } from "@/features/teamhub/teamhub-types";

import {
  myDocumentTreeQueryKey,
  updateMyDocumentTreeCache,
} from "./my-documents-tree-helpers";

interface MyDocumentsFolderEditsInput {
  onChanged: () => Promise<unknown>;
  setError: (error: string | null) => void;
  tenantId: string;
}

/** Optimistic Folder rename, delete and Placement move in the personal tree. */
export function useMyDocumentsFolderEdits({
  onChanged,
  setError,
  tenantId,
}: MyDocumentsFolderEditsInput) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const [renamingFolder, setRenamingFolder] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [movingPlacement, setMovingPlacement] =
    useState<TeamHubDocumentPlacementNode | null>(null);
  const [deletingFolderId, setDeletingFolderId] = useState<string | null>(null);
  const treeQueryKey = myDocumentTreeQueryKey(tenantId);

  async function movePlacement(
    placement: TeamHubDocumentPlacementNode,
    parentId: string,
  ) {
    setError(null);
    const rollback = updateMyDocumentTreeCache(
      queryClient,
      treeQueryKey,
      (current) =>
        current.map((item) =>
          item.id === placement.id
            ? {
                ...item,
                parent_id: parentId === "__root__" ? undefined : parentId,
              }
            : item,
        ),
    );
    setMovingPlacement(null);
    try {
      await teamHubData(
        client.api.PATCH(
          "/v0/tenants/{tenantId}/me/document-placements/{placementId}",
          {
            params: { path: { tenantId, placementId: placement.id } },
            body:
              parentId === "__root__"
                ? { move_to_root: true }
                : { parent_id: parentId },
          },
        ),
      );
      await onChanged();
    } catch (moveError) {
      rollback();
      setError(
        moveError instanceof Error
          ? moveError.message
          : "The document could not be moved.",
      );
    }
  }

  async function renameFolder() {
    if (!renamingFolder) return;
    const renameState = renamingFolder;
    const trimmed = renamingFolder.name.trim();
    if (!trimmed) return;
    setError(null);
    const rollback = updateMyDocumentTreeCache(
      queryClient,
      treeQueryKey,
      (current) =>
        current.map((item) =>
          item.id === renamingFolder.id && item.node_kind === "folder"
            ? { ...item, name: trimmed }
            : item,
        ),
    );
    setRenamingFolder(null);
    try {
      await teamHubData(
        client.api.PATCH(
          "/v0/tenants/{tenantId}/me/document-placements/{placementId}",
          {
            params: { path: { tenantId, placementId: renamingFolder.id } },
            body: { name: trimmed },
          },
        ),
      );
      await onChanged();
    } catch (renameError) {
      rollback();
      setRenamingFolder(renameState);
      setError(
        renameError instanceof Error
          ? renameError.message
          : "The folder could not be renamed.",
      );
    }
  }

  async function deleteFolder(folderId: string) {
    if (deletingFolderId) return;
    setDeletingFolderId(folderId);
    setError(null);
    const rollback = updateMyDocumentTreeCache(
      queryClient,
      treeQueryKey,
      (current) => current.filter((item) => item.id !== folderId),
    );
    try {
      await teamHubDone(
        client.api.DELETE(
          "/v0/tenants/{tenantId}/me/document-folders/{placementId}",
          { params: { path: { tenantId, placementId: folderId } } },
        ),
      );
      await onChanged();
    } catch (deleteError) {
      rollback();
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "The folder could not be deleted.",
      );
    } finally {
      setDeletingFolderId(null);
    }
  }

  return {
    deleteFolder,
    deletingFolderId,
    movePlacement,
    movingPlacement,
    renameFolder,
    renamingFolder,
    setMovingPlacement,
    setRenamingFolder,
  };
}
