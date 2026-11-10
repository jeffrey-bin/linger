import { DocumentVoiceSelectionControl } from "./document-voice-selection-control";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { useParams } from "react-router";

import { Spinner } from "@/components/ui/spinner";
import { DocumentTableOfContents } from "@/components/document-table-of-contents";
import { extractRenderedDocumentHeadings } from "@/components/document-headings";
import "./room-document-blocknote.css";
import { useLinkedDocumentScroll } from "./room-document-scroll";
import { useSidebarWidth } from "@/components/ui/use-sidebar-width";
import { DocumentDeleteDialog } from "@/features/library/document-delete-dialog";
import { documentLogicalTitle } from "@/features/library/document-display-name";
import { useWikiDocumentLinks } from "@/features/wiki/wiki-document-links";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import type { TeamHubDocument } from "@/features/teamhub/teamhub-types";

import { DocumentVersionSelectionCommentControl } from "./document-version-selection-comment-control";
import { DocumentShareDialog } from "./document-share-dialog";
import { UnifiedDocumentBody } from "./unified-document-body";
import { UnifiedDocumentPageHeader } from "./unified-document-header";
import {
  useUnifiedDocumentPageModel,
  type UnifiedDocumentPageModel,
} from "./use-unified-document-page-model";

const UnifiedDocumentTimelineDialog = lazy(() =>
  import("./unified-document-timeline-dialog").then((module) => ({
    default: module.UnifiedDocumentTimelineDialog,
  })),
);

const DocumentCommentsPanel = lazy(() =>
  import("./document-comments-panel").then((module) => ({
    default: module.DocumentCommentsPanel,
  })),
);

export type { RoomDocumentMenuActions } from "./room-document-actions-menu";

export function UnifiedDocumentPage() {
  const { documentId } = useParams();
  return <UnifiedDocumentPageContent key={documentId} />;
}

function UnifiedDocumentPageContent() {
  return <UnifiedDocumentPageView model={useUnifiedDocumentPageModel()} />;
}

export function UnifiedDocumentSidebar({
  documentId,
  tenantId,
  hidden = false,
}: {
  documentId: string;
  tenantId: string;
  hidden?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const model = useUnifiedDocumentPageModel({ documentId, tenantId });
  return (
    <div
      className={
        hidden
          ? "hidden"
          : "flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      }
      ref={rootRef}
      data-testid={`panel-tab-file-${documentId}`}
      hidden={hidden || undefined}
      inert={hidden || undefined}
    >
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <UnifiedDocumentPageView model={model} />
      </div>
      {!hidden && model.document && !model.error ? (
        <DocumentVoiceSelectionControl
          documentId={documentId}
          title={model.document.title}
          rootRef={rootRef}
        />
      ) : null}
    </div>
  );
}

function UnifiedDocumentPageView({
  model,
}: {
  model: UnifiedDocumentPageModel;
}) {
  const {
    client,
    commentsOpen,
    commentsPortalTarget,
    document,
    documentId,
    headings,
    historyOpen,
    isEditing,
    roomId,
    shareOpen,
    setCommentsOpen,
    setCommentsPortalTarget,
    setHeadings,
    setHistoryOpen,
    setShareOpen,
    setTocOpen,
    setTrashConfirmOpen,
    tenantId,
    tocOpen,
    trashConfirmOpen,
    trashDocument,
    trashError,
    trashPending,
  } = model;
  const documentContentRef = useRef<HTMLDivElement>(null);
  const previewOutline = Boolean(
    document &&
    (document.format !== "blocknote" ||
      document.representation_format === "html"),
  );
  useEffect(() => {
    const root = documentContentRef.current;
    if (!previewOutline || !tocOpen || !root) return;
    const refresh = () => setHeadings(extractRenderedDocumentHeadings(root));
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => observer.disconnect();
  }, [documentId, previewOutline, setHeadings, tocOpen]);

  const isWikiPage =
    document?.from.some((source) => source.binding_kind === "wiki_page") ??
    false;
  const knowledgeTitle =
    !isEditing && isWikiPage && document
      ? documentLogicalTitle(document)
      : undefined;
  const wikiLinks = useWikiDocumentLinks(
    client,
    knowledgeTitle !== undefined ? document : undefined,
    documentContentRef,
  );

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <main className="room-document-main flex min-h-0 min-w-0 flex-1 flex-col bg-app-surface">
        <UnifiedDocumentPageHeader
          documentContentRef={documentContentRef}
          isWikiPage={isWikiPage}
          model={model}
        />
        <DocumentScrollContainer
          commentLane={Boolean(
            document &&
            document.format === "blocknote" &&
            document.representation_format !== "html",
          )}
          outline={
            tocOpen ? (
              <DocumentTableOfContents
                contentRef={documentContentRef}
                headings={headings}
                onClose={() => setTocOpen(false)}
              />
            ) : null
          }
        >
          <UnifiedDocumentBody
            documentContentRef={documentContentRef}
            isWikiPage={isWikiPage}
            knowledgeTitle={knowledgeTitle}
            model={model}
            wikiLinks={wikiLinks}
          />
          <UnifiedDocumentCommentsSurface
            client={client}
            commentsOpen={commentsOpen}
            document={document}
            onCommentsOpenChange={setCommentsOpen}
            onPortalTargetChange={setCommentsPortalTarget}
            portalTarget={commentsPortalTarget}
            roomId={roomId}
            rootRef={documentContentRef}
            tenantId={tenantId}
          />
        </DocumentScrollContainer>
        <UnifiedDocumentPageDialogs
          client={client}
          document={document}
          documentId={documentId}
          historyOpen={historyOpen}
          isWikiPage={isWikiPage}
          setHistoryOpen={setHistoryOpen}
          setShareOpen={setShareOpen}
          setTrashConfirmOpen={setTrashConfirmOpen}
          shareOpen={shareOpen}
          tenantId={tenantId}
          trashConfirmOpen={trashConfirmOpen}
          trashDocument={trashDocument}
          trashError={trashError}
          trashPending={trashPending}
        />
      </main>
    </div>
  );
}

function DocumentScrollContainer({
  children,
  commentLane,
  outline,
}: {
  children: ReactNode;
  commentLane: boolean;
  outline: ReactNode;
}) {
  const layoutRef = useRef<HTMLDivElement>(null);
  useLinkedDocumentScroll(layoutRef);
  return (
    <div
      ref={layoutRef}
      data-document-scroll-layout
      data-voice-scroll="document"
      // Only the collaborative editor has a comments lane to keep aligned, so
      // only it hands its scrollbar to this layout. A file preview keeps its
      // own scroller, which also owns its reading position.
      data-document-comment-lane={commentLane ? "true" : undefined}
      className="workspace-scrollbar relative flex min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
    >
      <div className="room-document-columns relative flex min-h-full min-w-0 flex-1 items-stretch overflow-visible">
        {children}
      </div>
      {outline}
    </div>
  );
}

function UnifiedDocumentPageDialogs({
  client,
  document,
  documentId,
  historyOpen,
  isWikiPage,
  setHistoryOpen,
  setShareOpen,
  setTrashConfirmOpen,
  shareOpen,
  tenantId,
  trashConfirmOpen,
  trashDocument,
  trashError,
  trashPending,
}: {
  client: TeamHubClient;
  document: TeamHubDocument | undefined;
  documentId: string;
  historyOpen: boolean;
  isWikiPage: boolean;
  setHistoryOpen: (open: boolean) => void;
  setShareOpen: (open: boolean) => void;
  setTrashConfirmOpen: (open: boolean) => void;
  shareOpen: boolean;
  tenantId: string;
  trashConfirmOpen: boolean;
  trashDocument: () => Promise<unknown> | void;
  trashError: string | null;
  trashPending: boolean;
}) {
  return (
    <>
      {historyOpen ? (
        <Suspense
          fallback={
            <div
              className="flex items-center justify-center gap-2 py-8 text-sm text-app-muted"
              role="status"
            >
              <Spinner size={16} />
              Loading history…
            </div>
          }
        >
          <UnifiedDocumentTimelineDialog
            client={client}
            documentId={documentId}
            onClose={() => setHistoryOpen(false)}
            tenantId={tenantId}
          />
        </Suspense>
      ) : null}
      {trashConfirmOpen && document && !isWikiPage ? (
        <DocumentDeleteDialog
          error={trashError}
          onCancel={() => setTrashConfirmOpen(false)}
          onConfirm={() => void trashDocument()}
          pending={trashPending}
          title={document.title}
        />
      ) : null}
      {shareOpen && document && !isWikiPage ? (
        <DocumentShareDialog
          client={client}
          documentId={document.id}
          onClose={() => setShareOpen(false)}
          ownerActorId={document.owner.id}
          tenantId={tenantId}
        />
      ) : null}
    </>
  );
}

function UnifiedDocumentCommentsSurface({
  client,
  commentsOpen,
  document,
  onCommentsOpenChange,
  onPortalTargetChange,
  portalTarget,
  roomId,
  rootRef,
  tenantId,
}: {
  client: TeamHubClient;
  commentsOpen: boolean;
  document: TeamHubDocument | undefined;
  onCommentsOpenChange: (open: boolean) => void;
  onPortalTargetChange: (target: HTMLDivElement | null) => void;
  portalTarget: HTMLDivElement | null;
  roomId?: string;
  rootRef: MutableRefObject<HTMLDivElement | null>;
  tenantId: string;
}) {
  const [versionSelection, setVersionSelection] = useState<string | null>(null);
  const [commentsMounted, setCommentsMounted] = useState(false);
  useEffect(() => {
    if (commentsOpen) setCommentsMounted(true);
  }, [commentsOpen]);
  const versionDocument =
    document?.format !== "blocknote" ? document : undefined;
  const commentsWidth = useSidebarWidth(
    `linger:document-comments-width:${tenantId}`,
    336,
    { edge: "left", max: 540, min: 272 },
  );

  const commentsStyleRef = commentsWidth.styleRef;
  const setCommentsPortalNode = useCallback(
    (node: HTMLDivElement | null) => {
      commentsStyleRef.current = node;
      onPortalTargetChange(node);
    },
    [commentsStyleRef, onPortalTargetChange],
  );

  return (
    <>
      <DocumentVersionSelectionCommentControl
        enabled={Boolean(versionDocument?.capabilities.comment)}
        onComment={(quotedText) => {
          setVersionSelection(quotedText);
          onCommentsOpenChange(true);
        }}
        rootRef={rootRef}
      />
      <div
        className={
          commentsOpen
            ? "room-document-comments-portal absolute inset-y-0 right-0 z-30 w-full shrink-0 border-l border-app-border bg-app-surface lg:relative lg:z-auto lg:w-[var(--sidebar-width)]"
            : "room-document-comments-portal hidden"
        }
        ref={setCommentsPortalNode}
        style={commentsWidth.style}
      >
        {commentsOpen ? (
          <div
            {...commentsWidth.handleProps}
            aria-label="Resize Document comments"
            className={`${commentsWidth.handleProps.className} document-comments-resize-handle`}
          />
        ) : null}
      </div>
      {versionDocument && (commentsOpen || commentsMounted) ? (
        <Suspense fallback={null}>
          <DocumentCommentsPanel
            client={client}
            documentId={versionDocument.id}
            documentVersionId={versionDocument.current_version?.id}
            onClose={() => {
              onCommentsOpenChange(false);
              setVersionSelection(null);
            }}
            onSelectionConsumed={() => setVersionSelection(null)}
            open={commentsOpen}
            portalTarget={portalTarget}
            roomId={roomId}
            scopeId={roomId ?? versionDocument.id}
            selectionQuote={versionSelection}
            tenantId={tenantId}
          />
        </Suspense>
      ) : null}
    </>
  );
}
