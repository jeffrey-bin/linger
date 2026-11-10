import { useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useRef, type ComponentProps } from "react";

import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import { Button } from "@/components/ui/button";
import { ArtifactPreviewSurface } from "@/features/rooms/files/artifact-preview-surface";
import type {
  TeamHubDocument,
  TeamHubDocumentVersion,
} from "@/features/teamhub/teamhub-types";
import { TeamHubError } from "@/features/teamhub/teamhub-client";
import { documentQueryOptions } from "../../room-queries";
import { PanelLoading } from "../panel-loading";
import { documentDetailPath } from "../../files/document-detail-routes";
import { documentCardVersionQueryKey } from "../../files/use-document-card-metadata";

import { DocumentVoiceSelectionControl } from "../../documents/document-voice-selection-control";

const LazyUnifiedDocumentSidebar = lazy(() =>
  import("../../documents/room-document-surface").then((module) => ({
    default: module.UnifiedDocumentSidebar,
  })),
);
function UnifiedDocumentSidebar(
  props: ComponentProps<typeof LazyUnifiedDocumentSidebar>,
) {
  return (
    <Suspense fallback={<div role="status">Opening document...</div>}>
      <LazyUnifiedDocumentSidebar {...props} />
    </Suspense>
  );
}

export function ConnectedFilePanelTab(props: {
  documentId: string;
  tenantId: string;
  currentActorId?: string;
  hidden?: boolean;
  versionId?: string;
  previewCurrentVersion?: boolean;
}) {
  if (!props.versionId && !props.previewCurrentVersion) {
    return (
      <UnifiedDocumentSidebar
        key={props.documentId}
        documentId={props.documentId}
        tenantId={props.tenantId}
        hidden={props.hidden}
      />
    );
  }
  return <ConnectedVersionPanelTab {...props} />;
}

function ConnectedVersionPanelTab({
  documentId,
  tenantId,
  previewCurrentVersion = false,
  hidden = false,
  ...props
}: {
  documentId: string;
  tenantId: string;
  currentActorId?: string;
  hidden?: boolean;
  versionId?: string;
  previewCurrentVersion?: boolean;
}) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const query = useQuery({
    ...documentQueryOptions(client, tenantId, documentId),
    enabled: !hidden,
    retry: false,
  });
  if (query.isPending) return <PanelLoading label="Loading file" />;
  const unavailable =
    (query.error instanceof TeamHubError &&
      [403, 404].includes(query.error.status)) ||
    (query.data && query.data.status !== "active");
  if (query.isError || unavailable)
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center"
        role="alert"
      >
        <h3 className="text-sm font-semibold">
          {unavailable
            ? "This file is no longer available"
            : "File could not be loaded"}
        </h3>
        <p className="text-xs text-app-muted">
          {unavailable
            ? "The file was removed or you no longer have access."
            : "Please retry loading this file."}
        </p>
        {!unavailable ? (
          <Button onClick={() => void query.refetch()} size="compact">
            Retry
          </Button>
        ) : null}
      </div>
    );
  const currentVersionId = query.data.current_version?.id;
  return (
    <FilePanelTab
      document={query.data}
      hidden={hidden}
      {...props}
      // Only the card click path re-reads this Document, so only it may skip
      // the Version lookup with immutable card metadata for the same Version.
      knownVersion={
        previewCurrentVersion && currentVersionId
          ? queryClient.getQueryData<TeamHubDocumentVersion>(
              documentCardVersionQueryKey(
                tenantId,
                documentId,
                currentVersionId,
              ),
            )
          : undefined
      }
      versionId={previewCurrentVersion ? currentVersionId : props.versionId}
    />
  );
}

/**
 * Per-file panel tab.
 * Explicit Versions preview in-place, including source Versions retained by
 * native Documents. A native Draft without a requested Version opens the
 * collaborative editor with Edit. The sidebar remains secondary to the Room,
 * so previews stay inside the resizable panel instead of expanding fullscreen.
 */
export function FilePanelTab({
  hidden = false,
  document,
  knownVersion,
  versionId,
}: {
  currentActorId?: string;
  hidden?: boolean;
  document: TeamHubDocument;
  knownVersion?: TeamHubDocumentVersion;
  versionId?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const documentHref = documentDetailPath({
    documentId: document.id,
    tenantId: document.tenant_id,
  });

  if (!versionId) {
    return (
      <UnifiedDocumentSidebar
        key={document.id}
        documentId={document.id}
        tenantId={document.tenant_id}
        hidden={hidden}
      />
    );
  }

  return (
    <div
      className={
        hidden
          ? "hidden"
          : "flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-app-surface-soft"
      }
      data-testid={`panel-tab-file-${document.id}`}
      ref={rootRef}
      hidden={hidden || undefined}
      inert={hidden || undefined}
    >
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <ArtifactPreviewSurface
          node={document}
          knownVersion={knownVersion}
          openDocumentHref={documentHref}
          variant="sidebar"
          versionId={versionId}
        />
      </div>
      {!hidden ? (
        <DocumentVoiceSelectionControl
          key={`${document.id}:${versionId}`}
          documentId={document.id}
          title={document.title}
          versionId={versionId}
          rootRef={rootRef}
        />
      ) : null}
    </div>
  );
}
