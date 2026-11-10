import {
  Comment01Icon,
  Share08Icon,
  ArrowDown01Icon,
  PencilEdit01Icon,
  SidebarLeftIcon,
  TableOfContentsIcon,
  Tick02Icon,
  ViewIcon,
} from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import {
  useSyncExternalStore,
  type MutableRefObject,
  type ReactNode,
} from "react";

import { extractRenderedDocumentHeadings } from "@/components/document-headings";
import { ActionMenu } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  documentFileName,
  documentLogicalTitle,
} from "@/features/library/document-display-name";
import {
  canRenameDocument,
  useDocumentRename,
} from "@/features/library/use-document-rename";
import { WORKSPACE_TREE_ID } from "@/features/library/workspace-tree";
import { writeDocumentLinkClipboard } from "@/features/rooms/files/document-clipboard-link";
import { documentDetailPath } from "@/features/rooms/files/document-detail-routes";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import type {
  TeamHubDocument,
  TeamHubDocumentPlacementNode,
} from "@/features/teamhub/teamhub-types";
import { roomMembersQueryOptions } from "../room-queries";

import type { RoomDocumentCollaborationSession } from "./room-document-collaboration";
import { RoomDocumentPresence } from "./room-document-presence";
import { collaborationColor } from "./room-document-presence-model";
import { DocumentActionsMenu } from "./room-document-actions-menu";
import type { UnifiedDocumentPageModel } from "./use-unified-document-page-model";

interface UnifiedDocumentPageHeaderProps {
  documentContentRef: MutableRefObject<HTMLDivElement | null>;
  isWikiPage: boolean;
  model: UnifiedDocumentPageModel;
}

/** Wires the page model's actions and presence into the Document header. */
export function UnifiedDocumentPageHeader({
  documentContentRef,
  isWikiPage,
  model,
}: UnifiedDocumentPageHeaderProps) {
  const {
    actor,
    sidebar,
    client,
    commentsOpen,
    document,
    documentId,
    duplicateDocument,
    duplicatePending,
    exportDocument,
    exportPending,
    canvasSent,
    isEditing,
    isSharedDocument,
    roomId,
    session,
    sharedTree,
    setCommentsOpen,
    setHeadings,
    setHistoryOpen,
    setIsEditing,
    setShareOpen,
    setTocOpen,
    setTrashConfirmOpen,
    setTreeOpen,
    tenantId,
    tocOpen,
    tree,
    treeOpen,
  } = model;
  return (
    <UnifiedDocumentHeader
      sidebar={sidebar}
      commentsOpen={commentsOpen}
      document={document}
      isWikiPage={isWikiPage}
      duplicatePending={duplicatePending}
      exportPending={exportPending}
      canvasSent={canvasSent}
      isEditing={isEditing}
      onComments={() => setCommentsOpen((value) => !value)}
      onCopyLink={() =>
        void writeDocumentLinkClipboard({
          documentId,
          tenantId,
          title: document ? documentLogicalTitle(document) : "Document",
          url: new URL(
            documentDetailPath({ documentId, tenantId }),
            window.location.origin,
          ).toString(),
        })
      }
      onDelete={() => setTrashConfirmOpen(true)}
      onDuplicate={() => void duplicateDocument()}
      onEditingChange={setIsEditing}
      onExport={() => void exportDocument()}
      onHistory={() => setHistoryOpen(true)}
      onOpenTree={() => setTreeOpen(!treeOpen)}
      onShare={() => setShareOpen(true)}
      onToc={() =>
        setTocOpen((value) => {
          const next = !value;
          if (next) {
            setHeadings(
              extractRenderedDocumentHeadings(documentContentRef.current),
            );
          }
          return next;
        })
      }
      presence={
        actor && session ? (
          roomId ? (
            <RoomDocumentRoomPresence
              actorDisplayName={actor.display_name}
              actorId={actor.id}
              client={client}
              roomId={roomId}
              session={session}
              showSelf
              tenantId={tenantId}
            />
          ) : (
            <RoomDocumentPresence
              awareness={session.awareness}
              currentActor={{
                color: collaborationColor(actor.id),
                displayName: actor.display_name,
                id: actor.id,
              }}
              members={undefined}
              showSelf
            />
          )
        ) : null
      }
      session={session}
      sharedDocument={isSharedDocument}
      sharedTreeItems={sharedTree.data?.items ?? []}
      tocOpen={tocOpen}
      treeItems={tree.data?.items ?? []}
      treeOpen={treeOpen}
      tenantId={tenantId}
    />
  );
}

function UnifiedDocumentHeader({
  sidebar,
  commentsOpen,
  document,
  isWikiPage,
  duplicatePending,
  exportPending,
  canvasSent,
  isEditing,
  onComments,
  onCopyLink,
  onDelete,
  onDuplicate,
  onEditingChange,
  onExport,
  onHistory,
  onOpenTree,
  onShare,
  onToc,
  presence,
  session,
  sharedDocument,
  sharedTreeItems,
  tocOpen,
  treeItems,
  treeOpen,
  tenantId,
}: {
  sidebar: boolean;
  commentsOpen: boolean;
  document: TeamHubDocument | undefined;
  isWikiPage: boolean;
  duplicatePending: boolean;
  exportPending: boolean;
  canvasSent: boolean;
  isEditing: boolean;
  onComments: () => void;
  onCopyLink: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onEditingChange: (editing: boolean) => void;
  onExport: () => void;
  onHistory: () => void;
  onOpenTree: () => void;
  onShare: () => void;
  onToc: () => void;
  presence?: ReactNode;
  session: RoomDocumentCollaborationSession | null;
  sharedDocument: boolean;
  sharedTreeItems: TeamHubDocumentPlacementNode[];
  tocOpen: boolean;
  treeItems: TeamHubDocumentPlacementNode[];
  treeOpen: boolean;
  tenantId: string;
}) {
  const rename = useDocumentRename(tenantId);
  const actionsMenu =
    document && !isWikiPage ? (
      <DocumentActionsMenu
        actions={{
          busy: duplicatePending || exportPending,
          canRename: canRenameDocument(document),
          onRename: () => rename.beginRename(document),
          canDelete: document.capabilities.delete,
          canDuplicate: document.capabilities.duplicate,
          canExport: document.capabilities.export,
          canUseVersion: true,
          onCopyLink,
          onDelete,
          onDuplicate,
          onExport,
          onShowHistory: onHistory,
        }}
      />
    ) : null;
  return (
    <header className="room-document-header border-b border-app-border/60">
      <div className="room-document-header-identity">
        {!sidebar ? (
          <>
            <Button
              aria-controls={WORKSPACE_TREE_ID}
              aria-expanded={treeOpen}
              aria-label="Open Library pages"
              className="sm:hidden"
              onClick={onOpenTree}
              size="icon"
              title="Library pages"
              tone="ghost"
            >
              <Icon icon={SidebarLeftIcon} />
            </Button>
          </>
        ) : null}
        {document ? (
          <div className="room-document-header-file">
            <span className="truncate text-sm font-semibold text-app-ink">
              {documentFileName(document)}
            </span>
          </div>
        ) : null}
        {!sidebar && document ? (
          <div className="sr-only">
            <UnifiedDocumentBreadcrumb
              document={document}
              items={treeItems}
              sharedDocument={sharedDocument}
              sharedItems={sharedTreeItems}
            />
          </div>
        ) : (
          <span className="truncate text-sm font-semibold text-app-ink">
            {sidebar ? "" : "Document"}
          </span>
        )}
      </div>
      <div className="room-document-header-actions">
        {!isWikiPage ? presence : null}
        {document && !isWikiPage ? (
          <Button
            aria-label="Share"
            size="compactIcon"
            onClick={onShare}
            title="Share"
            tone="ghost"
          >
            <Icon icon={Share08Icon} />
          </Button>
        ) : null}

        {!sidebar &&
        !isWikiPage &&
        document?.status === "active" &&
        document.capabilities.read &&
        document.capabilities.comment ? (
          <Button
            aria-label="Comments"
            aria-pressed={commentsOpen}
            onClick={onComments}
            size="icon"
            title="Comments"
            tone="ghost"
          >
            <Icon icon={Comment01Icon} />
          </Button>
        ) : null}
        {!sidebar ? (
          <Button
            aria-label="Table of contents"
            aria-pressed={tocOpen}
            onClick={onToc}
            size="icon"
            title="Table of contents"
            tone="ghost"
          >
            <Icon icon={TableOfContentsIcon} />
          </Button>
        ) : null}
        {!sidebar ? actionsMenu : null}
        {!isWikiPage &&
        session &&
        document?.format === "blocknote" &&
        document.representation_format !== "html" ? (
          <RoomDocumentActions
            canEdit={
              document.status === "active" &&
              document.capabilities.write &&
              document.can_edit_native_content &&
              !canvasSent
            }
            isEditing={isEditing}
            onEditingChange={onEditingChange}
            session={session}
          />
        ) : null}
        {sidebar ? actionsMenu : null}
      </div>
      {rename.dialog}
    </header>
  );
}

function UnifiedDocumentBreadcrumb({
  document,
  items,
  sharedDocument,
  sharedItems,
}: {
  document: TeamHubDocument;
  items: TeamHubDocumentPlacementNode[];
  sharedDocument: boolean;
  sharedItems: TeamHubDocumentPlacementNode[];
}) {
  const personalPlacement = items.find(
    (item) => item.node_kind === "document" && item.document_id === document.id,
  );
  const sharedPlacement = sharedItems.find(
    (item) => item.node_kind === "document" && item.document_id === document.id,
  );
  const placement = personalPlacement ?? sharedPlacement;
  const placementItems = personalPlacement ? items : sharedItems;
  const folders = new Map(
    placementItems
      .filter(
        (
          item,
        ): item is Extract<
          TeamHubDocumentPlacementNode,
          { node_kind: "folder" }
        > => item.node_kind === "folder",
      )
      .map((folder) => [folder.id, folder]),
  );
  const ancestors: Array<{ id: string; name: string }> = [];
  let parentId = placement?.parent_id;
  while (parentId !== undefined) {
    const folder = folders.get(parentId);
    if (folder === undefined) break;
    ancestors.unshift(folder);
    parentId = folder.parent_id;
  }
  const context = document.from[0];
  const contextLabel =
    context?.label ??
    (context?.binding_kind === "room"
      ? "Room"
      : context?.binding_kind === "task"
        ? "Work Item"
        : context?.binding_kind === "wiki_page" ||
            context?.binding_kind === "wiki_source"
          ? "Wiki"
          : "Documents");
  return (
    <DocumentBreadcrumb
      ancestors={ancestors}
      currentName={documentFileName(document)}
      rootLabel={
        personalPlacement
          ? "Owned by Me"
          : sharedDocument
            ? "Shared with me"
            : placement === undefined
              ? contextLabel
              : "Owned by Me"
      }
    />
  );
}

function DocumentBreadcrumb<T extends { id: string; name: string }>({
  ancestors,
  currentName,
  rootLabel,
}: {
  ancestors: T[];
  currentName: string;
  rootLabel: string;
}) {
  const visible = ancestors.length > 2 ? ancestors.slice(-2) : ancestors;
  const items = [
    { key: "root", label: rootLabel },
    ...visible.map((folder) => ({
      key: folder.id,
      label: folder.name,
    })),
    { key: "current", label: currentName },
  ];

  return (
    <nav
      aria-label="Breadcrumb"
      className="hidden min-w-0 flex-1 items-center gap-1 overflow-hidden text-sm text-app-muted sm:flex"
    >
      {items.map((item, index) => (
        <span className="flex min-w-0 items-center gap-1" key={item.key}>
          {index > 0 ? <span aria-hidden="true">›</span> : null}
          <span
            className={
              index === items.length - 1
                ? "truncate font-semibold text-app-ink"
                : "max-w-32 truncate"
            }
            title={item.label}
          >
            {item.label}
          </span>
        </span>
      ))}
    </nav>
  );
}

function RoomDocumentRoomPresence({
  actorDisplayName,
  actorId,
  client,
  roomId,
  session,
  showSelf = false,
  tenantId,
}: {
  actorDisplayName: string;
  actorId: string;
  client: TeamHubClient;
  roomId: string;
  session: RoomDocumentCollaborationSession;
  showSelf?: boolean;
  tenantId: string;
}) {
  const members = useQuery(roomMembersQueryOptions(client, tenantId, roomId));

  return (
    <RoomDocumentPresence
      awareness={session.awareness}
      currentActor={{
        color: collaborationColor(actorId),
        displayName: actorDisplayName,
        id: actorId,
      }}
      members={members.data?.items}
      showSelf={showSelf}
    />
  );
}

function RoomDocumentActions({
  canEdit,
  isEditing,
  onEditingChange,
  session,
}: {
  canEdit: boolean;
  isEditing: boolean;
  onEditingChange: (editing: boolean) => void;
  session: RoomDocumentCollaborationSession;
}) {
  const save = useSyncExternalStore(
    session.subscribeSaveState,
    session.getSaveSnapshot,
    session.getSaveSnapshot,
  );

  return (
    <ActionMenu
      buttonClassName="room-document-mode-trigger"
      initialFocusIndex={isEditing ? 0 : 1}
      itemClassName="flex min-h-9 w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm outline-none hover:bg-app-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-app-focus disabled:pointer-events-none disabled:opacity-45"
      label="Document mode"
      items={[
        {
          label: "Edit",
          icon: isEditing ? (
            <span aria-label="Current mode" className="inline-flex" role="img">
              <Icon icon={Tick02Icon} size={14} />
            </span>
          ) : (
            <Icon icon={PencilEdit01Icon} size={14} />
          ),
          disabled: !canEdit || !save.canEdit,
          onSelect: () => onEditingChange(true),
        },
        {
          label: "Read",
          icon: !isEditing ? (
            <span aria-label="Current mode" className="inline-flex" role="img">
              <Icon icon={Tick02Icon} size={14} />
            </span>
          ) : (
            <Icon icon={ViewIcon} size={14} />
          ),
          onSelect: () => onEditingChange(false),
        },
      ]}
      trigger={
        <>
          <span>{isEditing ? "Edit mode" : "Read mode"}</span>
          <Icon icon={ArrowDown01Icon} size={14} />
        </>
      }
    />
  );
}
