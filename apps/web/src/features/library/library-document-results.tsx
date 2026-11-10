import { Loading03Icon } from "@hugeicons/core-free-icons";
import { Link } from "react-router";

import { Icon } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";
import { ActorAvatar } from "@/features/rooms/members/actor-avatar";
import {
  DocumentActionsMenu,
  type RoomDocumentMenuActions,
} from "@/features/rooms/documents/room-document-actions-menu";
import type {
  TeamHubDocument,
  TeamHubDocumentTreeSummary,
} from "@/features/teamhub/teamhub-types";
import { formatDateTime, formatUpdatedAt } from "@/lib/date-format";

import { documentFileName } from "./document-display-name";
import { type LibraryFolder, LibraryFolderRow } from "./library-folder-browser";
import type { LibrarySection } from "./library-sidebar";
import type { PendingDocumentUpload } from "./library-upload-queue";
import { WorkspaceFileIcon } from "./workspace-file-icon";

/** Library rows come from the smart view (with access sources) or a folder's tree items. */
export type LibraryRowDocument = TeamHubDocumentTreeSummary &
  Partial<Pick<TeamHubDocument, "from">>;

/**
 * The most recently updated Documents as one row of cards above the tabs, so
 * the file a reader was just in is one click away.
 */
export function RecentDocumentCards({
  documentActions,
  documents,
  error,
  pending,
  tenantId,
}: {
  documentActions: (document: TeamHubDocument) => RoomDocumentMenuActions;
  documents: TeamHubDocument[];
  error: Error | null;
  pending: boolean;
  tenantId: string;
}) {
  const recentShowUnlinked = anyLinked(documents);
  return (
    <section aria-label="Recent" className="workspace-recent">
      <h3 className="workspace-recent-title">Recent</h3>
      {pending ? (
        <p className="flex items-center gap-2 py-6 text-sm text-app-muted">
          <Spinner size={15} />
          Loading documents…
        </p>
      ) : error ? (
        <p className="py-6 text-sm text-app-danger" role="alert">
          {error.message || "Recent documents are unavailable."}
        </p>
      ) : documents.length === 0 ? (
        <p className="py-6 text-sm text-app-muted">
          No recently updated documents
        </p>
      ) : (
        <div className="workspace-recent-cards">
          {documents.map((document) => {
            const fileName = documentFileName(document);
            const context = documentContext(document, recentShowUnlinked);
            return (
              <article className="workspace-recent-card" key={document.id}>
                <Link
                  aria-label={fileName}
                  className="workspace-recent-link"
                  to={`/t/${encodeURIComponent(tenantId)}/documents/${encodeURIComponent(document.id)}`}
                >
                  <span className="workspace-recent-icon">
                    <WorkspaceFileIcon filename={fileName} />
                  </span>
                  <span className="workspace-recent-name">{fileName}</span>
                  <span className="workspace-recent-meta">
                    <span>{document.owner.display_name}</span>
                    {context ? (
                      <>
                        {" · "}
                        <span>{context}</span>
                      </>
                    ) : null}
                  </span>
                  <time
                    dateTime={document.updated_at}
                    title={exactTime(document.updated_at)}
                  >
                    {formatUpdatedAt(document.updated_at)}
                  </time>
                </Link>
                <DocumentActionsMenu
                  actions={documentActions(document)}
                  buttonClassName="workspace-file-action"
                  label={`Actions for ${document.title}`}
                />
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

/**
 * Where a Document is visible. "No linked context" only says something when
 * some Document beside it does have a source, so a list where none do omits it.
 */
function documentContext(document: LibraryRowDocument, showUnlinked: boolean) {
  if (!document.from) return "";
  if (document.from.length)
    return `Visible in ${document.from.map((source) => source.label ?? source.binding_kind).join(", ")}`;
  return showUnlinked ? "No linked context" : "";
}

function anyLinked(documents: readonly LibraryRowDocument[]) {
  return documents.some((document) => (document.from?.length ?? 0) > 0);
}

export function LibraryDocumentResults({
  activeView,
  documents,
  error,
  folders,
  onCopy,
  onOpenFolder,
  documentActions,
  pending,
  pendingUploads,
  section,
  tenantId,
}: {
  activeView: { empty: string; label: string };
  documents: LibraryRowDocument[];
  error: Error | null;
  folders: readonly LibraryFolder[];
  onCopy: (document: LibraryRowDocument) => void;
  onOpenFolder: (folderId: string) => void;
  documentActions: (
    document: TeamHubDocumentTreeSummary,
  ) => RoomDocumentMenuActions;
  pending: boolean;
  pendingUploads: readonly PendingDocumentUpload[];
  section: LibrarySection;
  tenantId: string;
}) {
  if (pending) {
    return (
      <p className="flex items-center justify-center gap-2 py-16 text-center text-sm text-app-muted">
        <Spinner size={16} />
        Loading documents…
      </p>
    );
  }
  if (error) {
    return (
      <p className="py-16 text-center text-sm text-app-danger" role="alert">
        {error.message || "Document list is unavailable."}
      </p>
    );
  }
  const showUnlinked = anyLinked(documents);
  if (
    documents.length === 0 &&
    folders.length === 0 &&
    pendingUploads.length === 0
  ) {
    return (
      <p className="border-y border-app-border py-16 text-center text-sm text-app-muted">
        {activeView.empty}
      </p>
    );
  }
  return (
    <div
      aria-label={`${activeView.label} documents`}
      className="workspace-file-list"
    >
      {folders.map((folder) => (
        <LibraryFolderRow
          folder={folder}
          key={folder.id}
          onOpen={onOpenFolder}
        />
      ))}
      {pendingUploads.map((upload) => (
        <div
          aria-label={`${upload.filename} upload ${upload.status}`}
          className="workspace-file-row text-app-muted"
          key={upload.id}
          role="status"
        >
          <span className="workspace-file-name">
            {upload.status === "uploading" ? (
              <Icon
                icon={Loading03Icon}
                className="shrink-0 animate-spin"
                size={16}
              />
            ) : (
              <WorkspaceFileIcon filename={upload.filename} />
            )}
            <strong className="truncate">{upload.filename}</strong>
          </span>
          {upload.status === "uploading" ? (
            <span aria-hidden="true" className="text-xs">
              {Math.round(upload.progress * 100)}%
            </span>
          ) : null}
        </div>
      ))}
      {documents.map((document) => (
        <DocumentRow
          context={documentContext(document, showUnlinked)}
          document={document}
          key={document.id}
          actions={documentActions(document)}
          onCopyToMyDocuments={
            section === "shared-with-me" && document.capabilities.duplicate
              ? () => onCopy(document)
              : undefined
          }
          tenantId={tenantId}
        />
      ))}
    </div>
  );
}

/** The full date and time behind a relative label, shown on hover. */
function exactTime(iso: string) {
  return Number.isFinite(Date.parse(iso)) ? formatDateTime(iso) : undefined;
}

function DocumentRow({
  context,
  document,
  actions,
  onCopyToMyDocuments,
  tenantId,
}: {
  context: string;
  document: LibraryRowDocument;
  actions: RoomDocumentMenuActions;
  onCopyToMyDocuments?: () => void;
  tenantId: string;
}) {
  const fileName = documentFileName(document);
  return (
    <div className="workspace-file-row">
      <Link
        aria-label={fileName}
        className="workspace-file-name"
        to={`/t/${encodeURIComponent(tenantId)}/documents/${encodeURIComponent(document.id)}`}
      >
        <WorkspaceFileIcon filename={fileName} />
        <span className="min-w-0">
          <strong>{fileName}</strong>
          {context ? (
            <span className="workspace-file-context">{context}</span>
          ) : null}
        </span>
      </Link>
      <WorkspaceFileMetadata document={document} />
      <DocumentActionsMenu
        actions={{ ...actions, onCopyToMyDocuments }}
        buttonClassName="workspace-file-action"
        label={`Actions for ${document.title}`}
      />
    </div>
  );
}

function WorkspaceFileMetadata({
  document,
}: {
  document: TeamHubDocumentTreeSummary;
}) {
  const owner = document.owner;
  return (
    <div className="workspace-file-metadata">
      <span
        className="workspace-file-owner"
        data-kind={owner.kind}
        title={owner.display_name}
      >
        <ActorAvatar
          actorId={owner.id}
          kind={owner.kind}
          name={owner.display_name}
          size="micro"
        />
        <span>{owner.display_name}</span>
      </span>
      <time
        dateTime={document.updated_at}
        title={exactTime(document.updated_at)}
      >
        {formatUpdatedAt(document.updated_at)}
      </time>
    </div>
  );
}
