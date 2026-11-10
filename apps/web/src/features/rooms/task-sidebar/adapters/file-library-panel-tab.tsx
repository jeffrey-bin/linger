import {
  Copy01Icon,
  Download01Icon,
  File01Icon,
  FolderOpenIcon,
} from "@hugeicons/core-free-icons";
import { dateTimeFormat } from "@/lib/date-format";
import { useMemo, useState } from "react";

import { ActionMenu } from "@/components/ui/action-menu";
import { Icon } from "@/components/ui/icon";
import { documentDetailPath } from "@/features/rooms/files/document-detail-routes";
import { triggerArtifactDownload } from "@/features/rooms/files/artifact-preview-loader";
import { writeDocumentLinkClipboard } from "@/features/rooms/files/document-clipboard-link";
import { ActorAvatar } from "@/features/rooms/members/actor-avatar";

import { documentFileName } from "@/features/library/document-display-name";
import { WorkspaceFileIcon } from "@/features/library/workspace-file-icon";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubDocument } from "@/features/teamhub/teamhub-types";

import { PanelCollectionChrome } from "../panel-collection-chrome";

function copyDocumentLink(document: TeamHubDocument) {
  const filename = documentFileName(document);
  const url = new URL(
    documentDetailPath({
      documentId: document.id,
      tenantId: document.tenant_id,
    }),
    window.location.origin,
  ).toString();
  return writeDocumentLinkClipboard({
    documentId: document.id,
    tenantId: document.tenant_id,
    title: filename,
    url,
  });
}

export function FileLibraryPanelTab({
  documents,
  hidden = false,
  onOpenDocument,
}: {
  documents: TeamHubDocument[];
  hidden?: boolean;
  onOpenDocument: (document: TeamHubDocument) => void;
}) {
  const { client } = useTeamHubRuntime();
  const [busyDocumentId, setBusyDocumentId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Newest first, matching the Library recency view; the name breaks ties so
  // documents sharing a timestamp keep a stable order.
  const rows = useMemo(
    () =>
      [...documents].sort(
        (left, right) =>
          right.updated_at.localeCompare(left.updated_at) ||
          documentFileName(left).localeCompare(documentFileName(right)),
      ),
    [documents],
  );

  async function runDocumentAction(
    document: TeamHubDocument,
    action: () => Promise<void>,
    message: string,
  ) {
    if (busyDocumentId !== null) return;
    setBusyDocumentId(document.id);
    setActionError(null);
    try {
      await action();
    } catch {
      setActionError(message);
    } finally {
      setBusyDocumentId(null);
    }
  }

  async function downloadDocument(document: TeamHubDocument) {
    const filename = documentFileName(document);
    const content = await client.downloadLatestDocument(document.id);
    triggerArtifactDownload(content.blob, filename);
  }

  return (
    <div
      className={
        hidden
          ? "hidden"
          : "flex min-h-0 flex-1 flex-col overflow-hidden bg-app-surface"
      }
      data-testid="panel-tab-file-library"
      hidden={hidden || undefined}
      inert={hidden || undefined}
    >
      <PanelCollectionChrome
        icon={FolderOpenIcon}
        subtitle={
          rows.length === 0
            ? "This Room has no documents yet"
            : `${rows.length} ${rows.length === 1 ? "file" : "files"}`
        }
        title="Files"
      />
      <nav
        aria-label="Room files"
        className="room-file-library workspace-scrollbar min-h-0 flex-1 overflow-y-auto bg-app-surface px-1.5 py-2"
      >
        {actionError ? (
          <p className="px-2 py-1 text-xs text-app-danger" role="alert">
            {actionError}
          </p>
        ) : null}
        {rows.length ? (
          rows.map((document) => {
            const filename = documentFileName(document);
            const busy = busyDocumentId === document.id;
            return (
              <div className="workspace-file-row group" key={document.id}>
                <button
                  aria-label={filename}
                  className="workspace-file-name min-w-0 text-left text-app-body"
                  onClick={() => onOpenDocument(document)}
                  title={`Open ${filename}`}
                  type="button"
                >
                  <WorkspaceFileIcon className="shrink-0" filename={filename} />
                  <span className="min-w-0">
                    <strong>{filename}</strong>
                  </span>
                </button>
                <RoomFileMetadata document={document} />
                <button
                  aria-label={`Download ${filename}`}
                  className="workspace-file-action"
                  disabled={!document.capabilities.export || busy}
                  onClick={() =>
                    void runDocumentAction(
                      document,
                      () => downloadDocument(document),
                      "The file could not be downloaded.",
                    )
                  }
                  title={`Download ${filename}`}
                  type="button"
                >
                  <Icon icon={Download01Icon} size={16} />
                </button>
                <ActionMenu
                  buttonClassName="workspace-file-action"
                  items={[
                    {
                      disabled: busy,
                      icon: <Icon icon={Copy01Icon} size={14} />,
                      label: "Copy link",
                      onSelect: () =>
                        void runDocumentAction(
                          document,
                          () => copyDocumentLink(document),
                          "The file link could not be copied.",
                        ),
                    },
                  ]}
                  label={`Actions for ${filename}`}
                />
              </div>
            );
          })
        ) : (
          <div className="flex h-full min-h-40 flex-col items-center justify-center px-4 text-center">
            <Icon className="text-app-subtle" icon={File01Icon} size={20} />
            <p className="mt-2 text-sm font-medium text-app-ink">
              No Room Documents yet
            </p>
            <p className="mt-1 max-w-52 text-xs leading-5 text-app-muted">
              Documents shared in this Room will show up here.
            </p>
          </div>
        )}
      </nav>
    </div>
  );
}

const documentDateFormatter = dateTimeFormat({
  day: "numeric",
  month: "short",
  year: "numeric",
});

function RoomFileMetadata({ document }: { document: TeamHubDocument }) {
  const owner = document.owner;
  const date = new Date(document.updated_at);
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
      <time dateTime={document.updated_at} title={document.updated_at}>
        {Number.isNaN(date.valueOf())
          ? "—"
          : documentDateFormatter.format(date)}
      </time>
    </div>
  );
}
