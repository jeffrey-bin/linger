import type { RoomDocumentMenuActions } from "@/features/rooms/documents/room-document-actions-menu";
import { Select, SelectItem } from "@/components/ui/select";
import type { TeamHubDocumentTreeSummary } from "@/features/teamhub/teamhub-types";

import { documentFileName } from "./document-display-name";
import {
  documentFileTypes,
  matchesDocumentFileType,
} from "./document-file-types";
import {
  LibraryDocumentResults,
  type LibraryRowDocument,
} from "./library-document-results";
import {
  type LibraryFolder,
  LibraryFolderBreadcrumb,
  LibraryUploadSummary,
} from "./library-folder-browser";
import type { PendingDocumentUpload } from "./library-upload-queue";
import type { WorkspaceTab } from "./library-workspace-tabs";

/**
 * One open folder level of My pages or Shared with me: type and sort filters,
 * the breadcrumb, errors, queued uploads and the rows themselves.
 */
export function LibraryFolderListing({
  activeView,
  browsedError,
  browsedPending,
  documentActions,
  documents,
  error,
  fileType,
  folderId,
  folders,
  onCopy,
  onDismissError,
  onFileTypeChange,
  onOpenFolder,
  onSortByChange,
  pendingUploads,
  sortBy,
  tab,
  tenantId,
  trail,
}: {
  activeView: { empty: string; label: string };
  browsedError: Error | null;
  browsedPending: boolean;
  documentActions: (
    document: TeamHubDocumentTreeSummary,
  ) => RoomDocumentMenuActions;
  documents: LibraryRowDocument[];
  error: string | null;
  fileType: string;
  folderId: string | undefined;
  folders: LibraryFolder[];
  onCopy: (document: LibraryRowDocument) => void;
  onDismissError: () => void;
  onFileTypeChange: (fileType: string) => void;
  onOpenFolder: (folderId?: string) => void;
  onSortByChange: (sortBy: string) => void;
  pendingUploads: readonly PendingDocumentUpload[];
  sortBy: string;
  tab: Exclude<WorkspaceTab, "meetings">;
  tenantId: string;
  trail: readonly LibraryFolder[];
}) {
  return (
    <>
      <div className="workspace-file-filters">
        <Select
          aria-label="File type"
          onValueChange={onFileTypeChange}
          value={fileType}
          variant="pill"
        >
          {documentFileTypes.map(({ value, label }) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </Select>
        <Select
          aria-label="Sort documents"
          onValueChange={onSortByChange}
          value={sortBy}
          variant="pill"
        >
          <SelectItem value="updated">Sort by last modified</SelectItem>
          <SelectItem value="name">Sort by name</SelectItem>
        </Select>
      </div>
      {folderId ? (
        <LibraryFolderBreadcrumb
          onOpen={onOpenFolder}
          rootLabel={activeView.label}
          trail={trail}
        />
      ) : null}
      {error ? (
        <div className="flex items-start gap-2 py-2 text-sm text-app-danger">
          <p className="min-w-0 flex-1" role="alert">
            {error}
          </p>
          <button
            className="shrink-0 rounded-md px-1.5 text-app-muted hover:bg-app-hover hover:text-app-body"
            onClick={onDismissError}
            type="button"
          >
            Dismiss
          </button>
        </div>
      ) : null}
      {tab === "owned" ? (
        <LibraryUploadSummary uploads={pendingUploads} />
      ) : null}
      <LibraryDocumentResults
        activeView={
          folderId
            ? {
                empty: "This folder is empty",
                label: trail.at(-1)!.name,
              }
            : activeView
        }
        documents={documents
          .filter((document) => matchesDocumentFileType(document, fileType))
          .sort((a, b) =>
            sortBy === "name"
              ? documentFileName(a).localeCompare(documentFileName(b))
              : b.updated_at.localeCompare(a.updated_at),
          )}
        documentActions={documentActions}
        error={browsedError}
        folders={folders.sort((a, b) =>
          sortBy === "name"
            ? a.name.localeCompare(b.name)
            : b.updated_at.localeCompare(a.updated_at),
        )}
        onCopy={onCopy}
        onOpenFolder={onOpenFolder}
        pending={browsedPending}
        pendingUploads={
          tab === "owned"
            ? pendingUploads.filter((upload) => upload.parentId === folderId)
            : []
        }
        section={tab === "shared" ? "shared-with-me" : "my-documents"}
        tenantId={tenantId}
      />
    </>
  );
}
