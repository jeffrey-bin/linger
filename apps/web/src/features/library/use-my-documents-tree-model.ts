import { useState } from "react";

import type {
  TeamHubDocumentPlacementNode,
  TeamHubDocumentTreeSummary,
} from "@/features/teamhub/teamhub-types";

import {
  pickedFolderUploadSources,
  tenantUploads,
  type UploadBatch,
} from "./library-upload-queue";
import type { DocumentTreeFolder } from "./my-documents-tree-helpers";
import { useMyDocumentsDocumentActions } from "./use-my-documents-document-actions";
import { useMyDocumentsFolderEdits } from "./use-my-documents-folder-edits";
import { useMyDocumentsTreeCreate } from "./use-my-documents-tree-create";
import { useMyDocumentsTreeState } from "./use-my-documents-tree-state";
import { useMyDocumentsUploads } from "./use-my-documents-uploads";

export interface MyDocumentsTreeProps {
  activeDocumentId?: string;
  collapseFoldersInitially?: boolean;
  collapseCollectionInitially?: boolean;
  items: TeamHubDocumentPlacementNode[];
  loadError?: Error | null;
  onChanged: () => Promise<unknown>;
  pending: boolean;
  tenantId: string;
}

export type MyDocumentsTreeModel = ReturnType<typeof useMyDocumentsTreeModel>;

/** Composes the personal tree's state, mutations and uploads into one view model. */
export function useMyDocumentsTreeModel({
  activeDocumentId,
  collapseFoldersInitially = false,
  items,
  loadError,
  onChanged,
  pending,
  tenantId,
}: MyDocumentsTreeProps) {
  const treeState = useMyDocumentsTreeState({
    activeDocumentId,
    collapseFoldersInitially,
    items,
    loadError,
    pending,
    tenantId,
  });
  const [error, setError] = useState<string | null>(null);
  const folderEdits = useMyDocumentsFolderEdits({
    onChanged,
    setError,
    tenantId,
  });
  const create = useMyDocumentsTreeCreate({
    expandFolder: treeState.expandFolder,
    items,
    onChanged,
    setError,
    setFocusedNodeId: treeState.setFocusedNodeId,
    setRenamingFolder: folderEdits.setRenamingFolder,
    tenantId,
  });
  const documentActions = useMyDocumentsDocumentActions({
    activeDocumentId,
    items,
    onChanged,
    setError,
    tenantId,
  });
  const uploads = useMyDocumentsUploads({
    creating: create.creating,
    expandFolder: treeState.expandFolder,
    items,
    onChanged,
    setCreating: create.setCreating,
    setError,
    tenantId,
  });
  const { revealFolder } = treeState;
  const { setExternalDrop } = uploads;
  const { trashingDocument, trashPending } = documentActions;

  return {
    activeDocumentId,
    collapsed: treeState.collapsed,
    creating: create.creating ?? (uploads.uploadsActive ? "import" : null),
    deletingFolderId: folderEdits.deletingFolderId,
    documentsById: treeState.documentsById,
    error: error ?? uploads.uploadError,
    externalDrop: uploads.externalDrop,
    focusedNodeId: treeState.focusedNodeId,
    folders: treeState.folders,
    importRef: create.importRef,
    items,
    loadError,
    movingPlacement: folderEdits.movingPlacement,
    onBeginRename: (folder: DocumentTreeFolder) =>
      folderEdits.setRenamingFolder({ id: folder.id, name: folder.name }),
    onCopyLink: documentActions.copyLink,
    onCreateDocument: (parentId?: string) => {
      revealFolder(parentId);
      void create.createDocument(parentId);
    },
    onCreateFolder: (parentId?: string) => {
      revealFolder(parentId);
      void create.createFolder(parentId);
    },
    onCreateNamedFolder: create.createNamedFolder,
    onDeleteFolder: (folderId: string) =>
      void folderEdits.deleteFolder(folderId),
    onDuplicateDocument: (
      document: TeamHubDocumentTreeSummary,
      targetFolderId?: string,
    ) => void documentActions.duplicateDocument(document, targetFolderId),
    onExportDocument: (document: TeamHubDocumentTreeSummary) =>
      void documentActions.exportDocument(document),
    onFocusNode: treeState.setFocusedNodeId,
    onImport: (file: File, parentId?: string) => {
      revealFolder(parentId);
      void uploads.importDocument(file, parentId);
    },
    onExternalDropCancel: (parentId?: string) => {
      const key = parentId ?? "__root__";
      setExternalDrop((current) =>
        (current?.parentId ?? "__root__") === key ? null : current,
      );
    },
    onExternalDropEnter: (parentId?: string) => {
      setExternalDrop({ parentId });
    },
    onDismissError: () => {
      setError(null);
      tenantUploads.setError(tenantId, null);
    },
    onExternalDropFiles: (batch: Promise<UploadBatch>, parentId?: string) => {
      revealFolder(parentId);
      void uploads.importDroppedDocuments(batch, parentId);
    },
    onUploadFolder: (files: Iterable<File>, parentId?: string) => {
      revealFolder(parentId);
      void uploads.importDocuments(
        pickedFolderUploadSources(files),
        parentId,
        false,
      );
    },
    onImportPick: (parentId?: string) => {
      revealFolder(parentId);
      create.importTargetRef.current = parentId;
      create.importRef.current?.click();
    },
    importTargetRef: create.importTargetRef,
    onMove: (placement: TeamHubDocumentPlacementNode, parentId: string) =>
      void folderEdits.movePlacement(placement, parentId),
    onMoveBegin: folderEdits.setMovingPlacement,
    onMoveCancel: () => folderEdits.setMovingPlacement(null),
    onRenameCancel: () => folderEdits.setRenamingFolder(null),
    onRenameChange: (name: string) =>
      folderEdits.setRenamingFolder((current) =>
        current ? { ...current, name } : current,
      ),
    onRenameSubmit: () => void folderEdits.renameFolder(),
    onToggle: treeState.toggle,
    onTrashDocument: documentActions.setTrashingDocument,
    onTreeKeyDown: treeState.handleTreeKeyDown,
    pending,
    pendingUploads: uploads.pendingUploads,
    revealDocumentId: uploads.revealDocumentId,
    renamingFolder: folderEdits.renamingFolder,
    tenantId,
    trashPending,
    trashingDocument,
    onTrashCancel: () => {
      if (!trashPending) documentActions.setTrashingDocument(null);
    },
    onTrashConfirm: () =>
      trashingDocument
        ? void documentActions.trashDocument(trashingDocument)
        : undefined,
  };
}
