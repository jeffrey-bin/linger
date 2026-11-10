import {
  Alert02Icon,
  CloudOffIcon,
  Download04Icon,
} from "@hugeicons/core-free-icons";
import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore, type MutableRefObject } from "react";
import type * as Y from "yjs";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";
import { documentLogicalTitle } from "@/features/library/document-display-name";
import type { useWikiDocumentLinks } from "@/features/wiki/wiki-document-links";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import type { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubDocument } from "@/features/teamhub/teamhub-types";
import { documentQueryKey } from "../room-queries";

import { DocumentVersionPreview } from "./document-version-preview";
import { EditableDocumentTitle } from "./editable-document-title";
import { RoomDocumentBlockNoteEditor } from "./room-document-blocknote-editor-loader";
import type {
  RoomDocumentEditor,
  RoomDocumentHeading,
} from "./room-document-blocknote-editor";
import type { RoomDocumentCollaborationSession } from "./room-document-collaboration";
import type { UnifiedDocumentPageModel } from "./use-unified-document-page-model";

interface UnifiedDocumentBodyProps {
  documentContentRef: MutableRefObject<HTMLDivElement | null>;
  isWikiPage: boolean;
  knowledgeTitle: string | undefined;
  model: UnifiedDocumentPageModel;
  wikiLinks: ReturnType<typeof useWikiDocumentLinks>;
}

/**
 * The scrollable Document content: status banners, then the error, the
 * Version preview, the collaborative editor, or the loading skeleton.
 */
export function UnifiedDocumentBody({
  documentContentRef,
  isWikiPage,
  knowledgeTitle,
  model,
  wikiLinks,
}: UnifiedDocumentBodyProps) {
  const {
    actor,
    client,
    currentVersion,
    document,
    documentActionError,
    error,
    exportError,
    session,
  } = model;
  return (
    <div
      className="workspace-content-viewport workspace-scrollbar min-h-0 min-w-0 flex-1 overflow-y-auto [overflow-anchor:none]"
      data-document-scroll-container
      data-voice-scroll="document"
      ref={documentContentRef}
      onClickCapture={wikiLinks.openLink}
      onKeyDownCapture={(event) => {
        if (event.key === "Enter") wikiLinks.openLink(event);
      }}
    >
      <DocumentStatusBanner
        documentActionError={documentActionError}
        exportError={exportError}
      />
      {wikiLinks.pending ? (
        <p className="px-6 py-2 text-sm text-app-muted" role="status">
          Opening Wiki page...
        </p>
      ) : null}
      {wikiLinks.error ? (
        <p className="px-6 py-2 text-sm text-app-danger" role="alert">
          {wikiLinks.error}
        </p>
      ) : null}
      {error ? (
        <div className="flex h-full items-center justify-center px-6 text-center">
          <p className="max-w-md text-sm text-app-danger" role="alert">
            <Icon icon={Alert02Icon} size={20} className="mx-auto mb-3" />
            {error}
          </p>
        </div>
      ) : document &&
        (document.format !== "blocknote" ||
          document.representation_format === "html") ? (
        <DocumentVersionPreview
          client={client}
          document={document}
          knownVersion={currentVersion}
        />
      ) : session && document && actor ? (
        <UnifiedDocumentEditorLayout
          actorId={actor.id}
          document={document}
          isWikiPage={isWikiPage}
          knowledgeTitle={knowledgeTitle}
          model={model}
          session={session}
        />
      ) : (
        <DocumentBodySkeleton />
      )}
    </div>
  );
}

interface UnifiedDocumentEditorLayoutProps {
  actorId: string;
  document: TeamHubDocument;
  isWikiPage: boolean;
  knowledgeTitle: string | undefined;
  model: UnifiedDocumentPageModel;
  session: RoomDocumentCollaborationSession;
}

function UnifiedDocumentEditorLayout({
  actorId,
  document,
  isWikiPage,
  knowledgeTitle,
  model,
  session,
}: UnifiedDocumentEditorLayoutProps) {
  const {
    autoFocusTitle,
    client,
    commentsOpen,
    commentsPortalTarget,
    consumeAutoFocusTitle,
    editorRef,
    isEditing,
    onCanvasSentChange,
    queryClient,
    roomId,
    resyncSession,
    setCommentsOpen,
    setHeadings,
    tenantId,
  } = model;
  return (
    <div
      className={`room-document-layout mx-auto min-h-full${knowledgeTitle !== undefined ? " room-document-layout--knowledge" : ""}`}
    >
      <div
        className={`room-document-content-lane mx-auto ${knowledgeTitle !== undefined ? "mb-6 border-b border-app-border pb-5" : "mb-3"}`}
      >
        <RoomDocumentConnectionStatus
          onRetry={resyncSession}
          session={session}
        />
        <UnifiedDocumentDraftTitle
          // eslint-disable-next-line jsx-a11y/no-autofocus -- the field is focused on purpose because the user just opened this dialog or inline editor
          autoFocus={autoFocusTitle}
          client={client}
          document={document}
          editorRef={editorRef}
          isEditing={isEditing}
          onAutoFocusConsumed={consumeAutoFocusTitle}
          queryClient={queryClient}
          session={session}
          tenantId={tenantId}
        />
      </div>
      {knowledgeTitle === undefined ? (
        <div className="room-document-content-lane mx-auto mb-8 flex min-h-8 flex-wrap items-center gap-2 text-sm text-app-muted">
          <span>By {document.owner.display_name}</span>
          <span aria-hidden="true">·</span>
          <RoomDocumentSaveIndicator
            alwaysVisible
            isEditing={isEditing}
            session={session}
          />
        </div>
      ) : null}
      <div className="room-document-content-lane mx-auto mb-4">
        <RoomDocumentRecoveryButton name={document.title} session={session} />
      </div>
      <ActiveRoomDocumentEditor
        canComment={!isWikiPage && document.capabilities.comment}
        client={client}
        commentsOpen={commentsOpen}
        commentsPortalTarget={commentsPortalTarget}
        currentActorId={actorId}
        documentId={document.id}
        editorRef={editorRef}
        isEditing={isEditing}
        knowledgeDocumentTitle={knowledgeTitle}
        onCanvasSentChange={onCanvasSentChange}
        onCommentsOpenChange={setCommentsOpen}
        onHeadingsChange={setHeadings}
        onReadOnlySessionResync={resyncSession}
        roomId={roomId}
        session={session}
        tenantId={tenantId}
      />
    </div>
  );
}

function DocumentStatusBanner({
  documentActionError,
  exportError,
}: {
  documentActionError: string | null;
  exportError: string | null;
}) {
  return (
    <>
      {exportError ? (
        <p
          className="border-b border-app-border bg-app-sidebar px-4 py-2 text-sm text-app-danger"
          role="alert"
        >
          {exportError}
        </p>
      ) : null}
      {documentActionError ? (
        <p
          className="border-b border-app-border bg-app-sidebar px-4 py-2 text-sm text-app-danger"
          role="alert"
        >
          {documentActionError}
        </p>
      ) : null}
    </>
  );
}

function DocumentBodySkeleton() {
  return (
    <div
      aria-label="Opening document"
      className="workspace-content mx-auto min-h-full w-full px-5 py-12"
      role="status"
    >
      <span className="sr-only">Opening document...</span>
      <div className="h-10 w-3/5 animate-pulse rounded-sm bg-muted motion-reduce:animate-none" />
      <div className="mt-4 h-4 w-2/5 animate-pulse rounded-sm bg-muted motion-reduce:animate-none" />
      <div className="mt-12 space-y-3">
        {["100%", "94%", "86%", "98%", "72%"].map((width) => (
          <div
            className="h-4 animate-pulse rounded-sm bg-muted motion-reduce:animate-none"
            key={width}
            style={{ width }}
          />
        ))}
      </div>
    </div>
  );
}

function UnifiedDocumentDraftTitle({
  autoFocus,
  client,
  document,
  editorRef,
  isEditing,
  onAutoFocusConsumed,
  queryClient,
  session,
  tenantId,
}: {
  autoFocus: boolean;
  client: TeamHubClient;
  document: TeamHubDocument;
  editorRef: MutableRefObject<RoomDocumentEditor | null>;
  isEditing: boolean;
  onAutoFocusConsumed: () => void;
  queryClient: QueryClient;
  session: RoomDocumentCollaborationSession;
  tenantId: string;
}) {
  const save = useSyncExternalStore(
    session.subscribeSaveState,
    session.getSaveSnapshot,
    session.getSaveSnapshot,
  );
  return (
    <EditableDocumentTitle
      // eslint-disable-next-line jsx-a11y/no-autofocus -- the field is focused on purpose because the user just opened this dialog or inline editor
      autoFocus={autoFocus}
      display="page"
      isEditing={isEditing && document.capabilities.write && save.canEdit}
      key={`${document.id}:${isEditing}`}
      name={documentLogicalTitle(document)}
      onAutoFocusConsumed={onAutoFocusConsumed}
      onCommit={() => focusDocumentBody(editorRef.current)}
      onRename={async (title) => {
        const updated = await teamHubData(
          client.api.PATCH("/v0/documents/{documentId}/draft-title", {
            params: { path: { documentId: document.id } },
            body: { title },
          }),
        );
        queryClient.setQueryData(
          documentQueryKey(tenantId, document.id),
          updated,
        );
        await queryClient.invalidateQueries({
          queryKey: ["teamhub", tenantId, "document-tree"],
        });
      }}
    />
  );
}

function focusDocumentBody(editor: RoomDocumentEditor | null) {
  if (!editor) return;
  const firstBlock = editor.document[0];
  if (firstBlock) editor.setTextCursorPosition(firstBlock.id, "start");
  editor.focus();
}

function RoomDocumentRecoveryButton({
  name,
  session,
}: {
  name: string;
  session: RoomDocumentCollaborationSession;
}) {
  const save = useSyncExternalStore(
    session.subscribeSaveState,
    session.getSaveSnapshot,
    session.getSaveSnapshot,
  );
  if (save.protocolError !== "durable_save_failed") {
    return null;
  }
  return (
    <Button
      aria-label="Download recovery copy"
      onClick={() => {
        void downloadRecoveryCopy(name, session.document);
      }}
      title="Download recovery copy"
      tone="ghost"
    >
      <Icon icon={Download04Icon} />
      Recovery copy
    </Button>
  );
}

async function downloadRecoveryCopy(
  name: string,
  document: Y.Doc,
): Promise<void> {
  const { encodeStateAsUpdate } = await import("yjs");
  const state = encodeStateAsUpdate(document);
  const buffer = new ArrayBuffer(state.byteLength);
  new Uint8Array(buffer).set(state);
  const blob = new Blob([buffer], {
    type: "application/vnd.yjs",
  });
  const url = URL.createObjectURL(blob);
  const link = globalThis.document.createElement("a");
  const basename = name.replaceAll(/[^A-Za-z0-9._-]/g, "_") || "document";
  link.download = `${basename}.recovery.yjs`;
  link.href = url;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function ActiveRoomDocumentEditor({
  canComment,
  client,
  commentsOpen,
  commentsPortalTarget,
  currentActorId,
  documentId,
  isEditing,
  knowledgeDocumentTitle,
  editorRef,
  onCanvasSentChange,
  onHeadingsChange,
  onCommentsOpenChange,
  onReadOnlySessionResync,
  roomId,
  session,
  tenantId,
}: {
  canComment: boolean;
  client: ReturnType<typeof useTeamHubRuntime>["client"];
  commentsOpen: boolean;
  commentsPortalTarget: HTMLDivElement | null;
  currentActorId: string;
  documentId: string;
  isEditing: boolean;
  knowledgeDocumentTitle?: string;
  editorRef: MutableRefObject<RoomDocumentEditor | null>;
  onCanvasSentChange: (sent: boolean) => void;
  onHeadingsChange: (headings: RoomDocumentHeading[]) => void;
  onCommentsOpenChange: (open: boolean) => void;
  onReadOnlySessionResync: () => void;
  roomId?: string;
  session: RoomDocumentCollaborationSession;
  tenantId: string;
}) {
  const save = useSyncExternalStore(
    session.subscribeSaveState,
    session.getSaveSnapshot,
    session.getSaveSnapshot,
  );
  return (
    <RoomDocumentBlockNoteEditor
      canComment={canComment}
      client={client}
      commentsOpen={commentsOpen}
      commentsPortalTarget={commentsPortalTarget}
      currentActorId={currentActorId}
      documentId={documentId}
      editable={isEditing && save.canEdit}
      knowledgeDocumentTitle={knowledgeDocumentTitle}
      surfaceEditorRef={editorRef}
      onCanvasSentChange={onCanvasSentChange}
      onHeadingsChange={onHeadingsChange}
      onCommentsOpenChange={onCommentsOpenChange}
      onReadOnlySessionResync={onReadOnlySessionResync}
      roomId={roomId}
      session={session}
      tenantId={tenantId}
    />
  );
}

function RoomDocumentConnectionStatus({
  onRetry,
  session,
}: {
  onRetry(): void;
  session: RoomDocumentCollaborationSession;
}) {
  const save = useSyncExternalStore(
    session.subscribeSaveState,
    session.getSaveSnapshot,
    session.getSaveSnapshot,
  );
  if (save.status !== "Connection failed") return null;
  return (
    <div className="mb-3 flex items-center gap-2 text-sm text-app-danger">
      <span aria-label="Document connection status" role="status">
        Connection failed
      </span>
      <button className="underline" onClick={onRetry} type="button">
        Retry connection
      </button>
    </div>
  );
}

function RoomDocumentSaveIndicator({
  alwaysVisible = false,
  isEditing,
  session,
}: {
  alwaysVisible?: boolean;
  isEditing: boolean;
  session: RoomDocumentCollaborationSession;
}) {
  const save = useSyncExternalStore(
    session.subscribeSaveState,
    session.getSaveSnapshot,
    session.getSaveSnapshot,
  );
  const saveStatusProbe = (
    <span
      data-room-document-durable-sequence={save.durableSequence}
      data-room-document-save-status={
        save.protocolError ? "Save protocol error" : save.status
      }
      hidden
    />
  );
  if (save.status === "Connection failed") return saveStatusProbe;
  if (session.readOnly) {
    return (
      <span aria-label="Document access mode" role="status">
        Read only
      </span>
    );
  }
  if (
    !alwaysVisible &&
    save.protocolError === undefined &&
    (isEditing || save.status === "Saved") &&
    !["Connecting", "Offline", "Offline pending"].includes(save.status)
  ) {
    return saveStatusProbe;
  }

  if (save.protocolError === undefined && save.status === "Saved") {
    return (
      <>
        {saveStatusProbe}
        <span aria-label="Document save status" role="status">
          Saved
        </span>
      </>
    );
  }

  const indicator = save.protocolError
    ? {
        icon: Alert02Icon,
        label: "Save protocol error",
        tone: "text-app-danger",
      }
    : save.status === "Offline pending"
      ? {
          icon: CloudOffIcon,
          label: "Offline changes pending",
          tone: "text-app-warning",
        }
      : save.status === "Offline"
        ? {
            icon: CloudOffIcon,
            label: "Offline",
            tone: "text-app-muted",
          }
        : save.status === "Connecting"
          ? {
              icon: null,
              label: "Connecting...",
              tone: "text-app-muted",
            }
          : {
              icon: null,
              label: "Saving...",
              tone: "text-app-muted",
            };

  return (
    <>
      {saveStatusProbe}
      <p
        aria-label="Document save status"
        className={`mt-0.5 flex items-center gap-1 text-[12px] leading-4 ${indicator.tone}`}
        role="status"
      >
        {indicator.icon ? (
          <Icon icon={indicator.icon} size={12} />
        ) : (
          <Spinner size={12} />
        )}
        {indicator.label}
      </p>
    </>
  );
}
