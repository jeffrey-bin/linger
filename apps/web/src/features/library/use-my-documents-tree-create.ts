import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useNavigate } from "react-router";

import { documentQueryKey } from "@/features/rooms/room-queries";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubDocumentPlacementNode } from "@/features/teamhub/teamhub-types";

import { nextFolderName } from "./my-documents-tree-helpers";

export type MyDocumentsCreating = "document" | "folder" | "import" | null;

interface MyDocumentsTreeCreateInput {
  expandFolder: (folderId?: string) => void;
  items: TeamHubDocumentPlacementNode[];
  onChanged: () => Promise<unknown>;
  setError: (error: string | null) => void;
  setFocusedNodeId: (placementId: string | null) => void;
  setRenamingFolder: (folder: { id: string; name: string } | null) => void;
  tenantId: string;
}

/** Creates Folders and Documents in the personal tree and owns the Import picker. */
export function useMyDocumentsTreeCreate({
  expandFolder,
  items,
  onChanged,
  setError,
  setFocusedNodeId,
  setRenamingFolder,
  tenantId,
}: MyDocumentsTreeCreateInput) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const importRef = useRef<HTMLInputElement>(null);
  const importTargetRef = useRef<string | undefined>(undefined);
  const [creating, setCreating] = useState<MyDocumentsCreating>(null);

  async function createFolder(parentId?: string) {
    if (creating) return;
    setCreating("folder");
    setError(null);
    try {
      const folder = await teamHubData(
        client.api.POST("/v0/tenants/{tenantId}/me/document-folders", {
          params: { path: { tenantId } },
          body: {
            name: nextFolderName(items, parentId),
            ...(parentId ? { parent_id: parentId } : {}),
          },
        }),
      );
      await onChanged();
      expandFolder(parentId);
      setFocusedNodeId(folder.id);
      setRenamingFolder({ id: folder.id, name: folder.name });
    } catch (createError) {
      setError(
        createError instanceof Error
          ? createError.message
          : "The folder could not be created.",
      );
    } finally {
      setCreating(null);
    }
  }

  async function createDocument(parentId?: string) {
    if (creating) return;
    setCreating("document");
    setError(null);
    try {
      const document = await teamHubData(
        client.api.POST("/v0/tenants/{tenantId}/documents", {
          params: { path: { tenantId } },
          body: {
            ...(parentId ? { parent_id: parentId } : {}),
            representation_format: "markdown",
          },
        }),
      );
      await teamHubData(
        client.api.PUT(
          "/v0/tenants/{tenantId}/personal-wiki/documents/{documentId}",
          { params: { path: { tenantId, documentId: document.id } } },
        ),
      );
      await onChanged();
      expandFolder(parentId);
      // A Document surface already mounted on this id holds a failed read, and
      // navigating to the same path would not refetch it.
      await queryClient.invalidateQueries({
        queryKey: documentQueryKey(tenantId, document.id),
      });
      void navigate(
        `/t/${encodeURIComponent(tenantId)}/documents/${encodeURIComponent(document.id)}`,
        { state: { editDocumentTitle: true, selectTitleBaseName: true } },
      );
    } catch (createError) {
      setError(
        createError instanceof Error
          ? createError.message
          : "The document could not be created.",
      );
    } finally {
      setCreating(null);
    }
  }

  async function createNamedFolder(name: string, parentId?: string) {
    await teamHubData(
      client.api.POST("/v0/tenants/{tenantId}/me/document-folders", {
        params: { path: { tenantId } },
        body: {
          name,
          ...(parentId ? { parent_id: parentId } : {}),
        },
      }),
    );
    await onChanged();
  }

  return {
    createDocument,
    createFolder,
    createNamedFolder,
    creating,
    importRef,
    importTargetRef,
    setCreating,
  };
}
