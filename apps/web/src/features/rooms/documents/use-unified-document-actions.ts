import type { QueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { NavigateFunction } from "react-router";

import { documentFileName } from "@/features/library/document-display-name";
import { documentAfterRemoval } from "@/features/library/document-tree-order";
import { triggerArtifactDownload } from "@/features/rooms/files/artifact-preview-loader";
import { teamHubData, teamHubDone } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import type {
  TeamHubDocument,
  TeamHubDocumentPlacementNode,
} from "@/features/teamhub/teamhub-types";

interface UnifiedDocumentActionsInput {
  client: TeamHubClient;
  closeSession: () => void;
  document: TeamHubDocument | undefined;
  navigate: NavigateFunction;
  queryClient: QueryClient;
  tenantId: string;
}

/** Trash, export, and duplicate actions of the Document page menu. */
export function useUnifiedDocumentActions({
  client,
  closeSession,
  document,
  navigate,
  queryClient,
  tenantId,
}: UnifiedDocumentActionsInput) {
  const [documentActionError, setDocumentActionError] = useState<string | null>(
    null,
  );
  const [duplicatePending, setDuplicatePending] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportPending, setExportPending] = useState(false);
  const [trashConfirmOpen, setTrashConfirmOpen] = useState(false);
  const [trashError, setTrashError] = useState<string | null>(null);
  const [trashPending, setTrashPending] = useState(false);
  const libraryPath = `/t/${encodeURIComponent(tenantId)}/library`;

  async function trashDocument() {
    if (!document || trashPending) return;
    setTrashPending(true);
    setTrashError(null);
    try {
      await teamHubDone(
        client.api.DELETE("/v0/documents/{documentId}", {
          params: { path: { documentId: document.id } },
        }),
      );
      closeSession();
      // Move on to the Document listed next in My pages, as the tree does.
      const nextDocumentId = documentAfterRemoval(
        queryClient.getQueryData<{ items: TeamHubDocumentPlacementNode[] }>([
          "teamhub",
          tenantId,
          "document-tree",
        ])?.items ?? [],
        document.id,
      );
      void navigate(
        nextDocumentId
          ? `/t/${encodeURIComponent(tenantId)}/documents/${encodeURIComponent(nextDocumentId)}`
          : libraryPath,
        { replace: true },
      );
      void queryClient.invalidateQueries({
        queryKey: ["teamhub", tenantId, "document-tree"],
      });
    } catch (trashDocumentError) {
      setTrashError(
        trashDocumentError instanceof Error
          ? trashDocumentError.message
          : "The Document could not be moved to trash.",
      );
    } finally {
      setTrashPending(false);
    }
  }

  async function exportDocument() {
    if (!document || exportPending) return;
    setExportPending(true);
    setExportError(null);
    try {
      const filename = documentFileName(document).replaceAll(
        /[\\/:*?"<>|]/g,
        "-",
      );
      const content = await client.downloadLatestDocument(document.id);
      triggerArtifactDownload(content.blob, filename);
    } catch (exportDocumentError) {
      setExportError(
        exportDocumentError instanceof Error
          ? exportDocumentError.message
          : "The Document could not be exported.",
      );
    } finally {
      setExportPending(false);
    }
  }

  async function duplicateDocument() {
    if (!document || duplicatePending) return;
    setDuplicatePending(true);
    setDocumentActionError(null);
    try {
      const duplicate = await teamHubData(
        client.api.POST("/v0/documents/{documentId}/duplicates", {
          params: { path: { documentId: document.id } },
          body: {},
        }),
      );
      closeSession();
      await queryClient.invalidateQueries({
        queryKey: ["teamhub", tenantId, "document-tree"],
      });
      void navigate(
        `/t/${encodeURIComponent(tenantId)}/documents/${encodeURIComponent(duplicate.id)}`,
      );
    } catch (duplicateError) {
      setDocumentActionError(
        duplicateError instanceof Error
          ? duplicateError.message
          : "The Document could not be duplicated.",
      );
    } finally {
      setDuplicatePending(false);
    }
  }

  return {
    documentActionError,
    duplicateDocument,
    duplicatePending,
    exportDocument,
    exportError,
    exportPending,
    setTrashConfirmOpen,
    trashConfirmOpen,
    trashDocument,
    trashError,
    trashPending,
  };
}
