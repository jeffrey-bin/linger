import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";

import { writeDocumentLinkClipboard } from "@/features/rooms/files/document-clipboard-link";
import { triggerArtifactDownload } from "@/features/rooms/files/artifact-preview-loader";
import { documentDetailPath } from "@/features/rooms/files/document-detail-routes";
import { teamHubData, teamHubDone } from "@/features/teamhub/teamhub-api";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubDocumentPlacementNode,
  TeamHubDocumentTreeSummary,
} from "@/features/teamhub/teamhub-types";

import { documentFileName } from "./document-display-name";
import { documentAfterRemoval } from "./document-tree-order";
import {
  myDocumentTreeQueryKey,
  updateMyDocumentTreeCache,
} from "./my-documents-tree-helpers";

interface MyDocumentsDocumentActionsInput {
  activeDocumentId?: string;
  items: TeamHubDocumentPlacementNode[];
  onChanged: () => Promise<unknown>;
  setError: (error: string | null) => void;
  tenantId: string;
}

/** Copy link, Duplicate, Download and trash for Documents in the personal tree. */
export function useMyDocumentsDocumentActions({
  activeDocumentId,
  items,
  onChanged,
  setError,
  tenantId,
}: MyDocumentsDocumentActionsInput) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [trashingDocument, setTrashingDocument] =
    useState<TeamHubDocumentTreeSummary | null>(null);
  const [trashPending, setTrashPending] = useState(false);
  const treeQueryKey = myDocumentTreeQueryKey(tenantId);

  function copyLink(document: TeamHubDocumentTreeSummary) {
    const url = new URL(
      documentDetailPath({ documentId: document.id, tenantId }),
      window.location.origin,
    ).toString();
    void writeDocumentLinkClipboard({
      documentId: document.id,
      tenantId,
      title: document.title,
      url,
    });
  }

  async function duplicateDocument(
    document: TeamHubDocumentTreeSummary,
    targetFolderId?: string,
  ) {
    setError(null);
    try {
      const duplicate = await teamHubData(
        client.api.POST("/v0/documents/{documentId}/duplicates", {
          params: { path: { documentId: document.id } },
          body: targetFolderId ? { target_folder_id: targetFolderId } : {},
        }),
      );
      await Promise.all([
        onChanged(),
        queryClient.invalidateQueries({
          queryKey: ["teamhub", "library-documents"],
        }),
      ]);
      void navigate(
        `/t/${encodeURIComponent(tenantId)}/documents/${encodeURIComponent(duplicate.id)}`,
      );
    } catch (duplicateError) {
      setError(
        duplicateError instanceof Error
          ? duplicateError.message
          : "The document could not be duplicated.",
      );
    }
  }

  async function exportDocument(summary: TeamHubDocumentTreeSummary) {
    setError(null);
    try {
      const document = await teamHubData(
        client.api.GET("/v0/documents/{documentId}", {
          params: { path: { documentId: summary.id } },
        }),
      );
      const filename = documentFileName(document);
      const content = await client.downloadLatestDocument(document.id);
      triggerArtifactDownload(content.blob, filename);
    } catch (exportError) {
      setError(
        exportError instanceof Error
          ? exportError.message
          : "The document could not be exported.",
      );
    }
  }

  async function trashDocument(document: TeamHubDocumentTreeSummary) {
    if (trashPending) return;
    setTrashPending(true);
    setError(null);
    // Deleting the open Document moves on to its neighbour in the tree instead
    // of leaving the reader on a page that no longer exists.
    const nextDocumentId =
      activeDocumentId === document.id
        ? documentAfterRemoval(items, document.id)
        : undefined;
    const rollback = updateMyDocumentTreeCache(
      queryClient,
      treeQueryKey,
      (current) =>
        current.filter(
          (item) =>
            item.node_kind !== "document" || item.document_id !== document.id,
        ),
    );
    setTrashingDocument(null);
    try {
      await teamHubDone(
        client.api.DELETE("/v0/documents/{documentId}", {
          params: { path: { documentId: document.id } },
        }),
      );
      if (activeDocumentId === document.id) {
        void navigate(
          nextDocumentId
            ? `/t/${encodeURIComponent(tenantId)}/documents/${encodeURIComponent(nextDocumentId)}`
            : `/t/${encodeURIComponent(tenantId)}/library`,
          { replace: true },
        );
      }
      await Promise.all([
        onChanged(),
        queryClient.invalidateQueries({
          queryKey: ["teamhub", "library-documents"],
        }),
      ]);
    } catch (trashError) {
      rollback();
      setTrashingDocument(document);
      setError(
        trashError instanceof Error
          ? trashError.message
          : "The document could not be moved to trash.",
      );
    } finally {
      setTrashPending(false);
    }
  }

  return {
    copyLink,
    duplicateDocument,
    exportDocument,
    setTrashingDocument,
    trashDocument,
    trashingDocument,
    trashPending,
  };
}
