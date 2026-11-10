import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Copy01Icon,
  Delete02Icon,
  Download01Icon,
  FileAddIcon,
  FileImportIcon,
  FolderAddIcon,
  FolderExportIcon,
  Loading03Icon,
  PencilEdit01Icon,
} from "@hugeicons/core-free-icons";
import {
  type DragEvent,
  type DragEventHandler,
  type FocusEventHandler,
  type ReactNode,
  useEffect,
  useRef,
} from "react";
import { Link } from "react-router";

import { ActionMenu } from "@/components/ui/action-menu";
import { Icon } from "@/components/ui/icon";
import { preloadUnifiedDocumentPage } from "@/features/rooms/documents/document-route-preload";
import type {
  TeamHubDocumentPlacementNode,
  TeamHubDocumentTreeSummary,
} from "@/features/teamhub/teamhub-types";

import { documentFileName } from "./document-display-name";
import { compareTreeItems } from "./document-tree-order";
import {
  readDroppedUploadSources,
  type PendingDocumentUpload,
  type UploadBatch,
} from "./library-upload-queue";
import {
  type DocumentTreeFolder,
  type ExternalDocumentDrop,
  hasDragType,
  isExternalFileTransfer,
  isFolderMoveCycle,
  personalPlacementDragType,
} from "./my-documents-tree-helpers";
import { canRenameDocument } from "./use-document-rename";
import { WorkspaceFileIcon } from "./workspace-file-icon";
import { WORKSPACE_TREE_CHEVRON_SIZE } from "./workspace-sidebar-styles";

export interface TreeLevelInput {
  activeDocumentId?: string;
  collapsed: ReadonlySet<string>;
  documentsById: ReadonlyMap<string, TeamHubDocumentTreeSummary>;
  folders: DocumentTreeFolder[];
  focusedNodeId: string | null;
  items: TeamHubDocumentPlacementNode[];
  deletingFolderId: string | null;
  externalDrop: ExternalDocumentDrop | null;
  onBeginRename: (folder: DocumentTreeFolder) => void;
  onRenameDocument: (document: TeamHubDocumentTreeSummary) => void;
  onCopyLink: (document: TeamHubDocumentTreeSummary) => void;
  onCreateDocument: (parentId?: string) => void;
  onCreateFolder: (parentId?: string) => void;
  onDeleteFolder: (folderId: string) => void;
  onDuplicateDocument: (
    document: TeamHubDocumentTreeSummary,
    targetFolderId?: string,
  ) => void;
  onExportDocument: (document: TeamHubDocumentTreeSummary) => void;
  onImportPick: (parentId?: string) => void;
  onExternalDropCancel: (parentId?: string) => void;
  onExternalDropEnter: (parentId?: string) => void;
  onExternalDropFiles: (batch: Promise<UploadBatch>, parentId?: string) => void;
  onFocusNode: (placementId: string) => void;
  onMove: (placement: TeamHubDocumentPlacementNode, parentId: string) => void;
  onMoveBegin: (placement: TeamHubDocumentPlacementNode) => void;
  onRenameCancel: () => void;
  onRenameChange: (name: string) => void;
  onRenameSubmit: () => void;
  onToggle: (folderId: string) => void;
  onTrashDocument: (document: TeamHubDocumentTreeSummary) => void;
  parentId: string | undefined;
  pendingUploads: readonly PendingDocumentUpload[];
  revealDocumentId: string | null;
  renamingFolder: { id: string; name: string } | null;
  tenantId: string;
}

type TreeDocumentPlacement = Extract<
  TeamHubDocumentPlacementNode,
  { node_kind: "document" }
>;

const rowActionButtonClass =
  "row-reveal-action flex size-7 shrink-0 items-center justify-center rounded-lg text-app-muted transition-colors hover:bg-accent hover:text-app-ink aria-expanded:bg-accent aria-expanded:text-app-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-focus";

export function revealCurrentTreeNode(
  node: HTMLElement | null,
  current: boolean,
) {
  if (
    !node ||
    !current ||
    node.dataset.centered === "true" ||
    typeof node.scrollIntoView !== "function"
  ) {
    return;
  }
  const scrollContainer = node.closest<HTMLElement>(
    'aside[aria-label="Library sidebar"]',
  );
  if (scrollContainer) {
    const nodeRect = node.getBoundingClientRect();
    const containerRect = scrollContainer.getBoundingClientRect();
    if (
      nodeRect.top >= containerRect.top &&
      nodeRect.bottom <= containerRect.bottom
    ) {
      node.dataset.centered = "true";
      return;
    }
  }
  node.scrollIntoView({ block: "nearest", inline: "nearest" });
  node.dataset.centered = "true";
}

function RevealingRow({
  ariaLabel,
  children,
  className,
  current,
  documentId,
  draggable,
  onDragStart,
  onFocus,
  placementId,
  reveal,
  role,
  tabIndex,
}: {
  ariaLabel: string;
  children: ReactNode;
  className: string;
  current: boolean;
  documentId: string;
  draggable?: boolean;
  onDragStart?: DragEventHandler<HTMLDivElement>;
  onFocus?: FocusEventHandler<HTMLDivElement>;
  placementId?: string;
  reveal?: boolean;
  role?: "treeitem";
  tabIndex?: number;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(
    () => revealCurrentTreeNode(rowRef.current, current || Boolean(reveal)),
    [current, reveal],
  );
  return (
    <div
      aria-label={ariaLabel}
      className={className}
      data-document-id={documentId}
      data-placement-id={placementId}
      draggable={draggable}
      onDragStart={onDragStart}
      onFocus={onFocus}
      ref={rowRef}
      role={role}
      tabIndex={tabIndex}
    >
      {children}
    </div>
  );
}

function moveFromDrag(
  event: DragEvent,
  parentId: string,
  input: TreeLevelInput,
) {
  if (!hasDragType(event.dataTransfer, personalPlacementDragType)) return;
  event.preventDefault();
  const sourceId = event.dataTransfer.getData(personalPlacementDragType);
  const source = input.items.find((candidate) => candidate.id === sourceId);
  if (
    !source ||
    source.id === parentId ||
    (source.node_kind === "folder" &&
      isFolderMoveCycle(source.id, parentId, input.items))
  ) {
    return;
  }
  input.onMove(source, parentId);
}

/** Renders one level of the personal tree, then the uploads queued into it. */
export function renderTreeLevel(input: TreeLevelInput): ReactNode[] {
  const nodes = input.items
    .filter((item) => item.parent_id === input.parentId)
    .sort(compareTreeItems)
    .map((item) =>
      item.node_kind === "folder"
        ? renderFolderNode(item, input)
        : renderDocumentNode(item, input),
    );
  const uploads = input.pendingUploads.flatMap((upload) =>
    upload.parentId === input.parentId ? [renderUploadNode(upload)] : [],
  );
  return [...nodes, ...uploads];
}

function renderFolderNode(item: DocumentTreeFolder, input: TreeLevelInput) {
  const isCollapsed = input.collapsed.has(item.id);
  const isRenaming = input.renamingFolder?.id === item.id;
  return (
    <div
      aria-expanded={!isCollapsed}
      aria-label={item.name}
      className="my-0.5"
      data-placement-id={item.id}
      draggable={!isRenaming}
      key={item.id}
      onDragOver={(event) => {
        if (isExternalFileTransfer(event.dataTransfer)) {
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "copy";
          return;
        }
        if (hasDragType(event.dataTransfer, personalPlacementDragType)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }
      }}
      onDragStart={(event) => {
        event.stopPropagation();
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(personalPlacementDragType, item.id);
      }}
      onDragEnter={(event) => {
        if (!isExternalFileTransfer(event.dataTransfer)) return;
        if (event.currentTarget.contains(event.relatedTarget as Node | null))
          return;
        event.preventDefault();
        event.stopPropagation();
        input.onExternalDropEnter(item.id);
      }}
      onDragLeave={(event) => {
        event.stopPropagation();
        if (event.currentTarget.contains(event.relatedTarget as Node | null))
          return;
        input.onExternalDropCancel(item.id);
      }}
      onDrop={(event) => {
        if (isExternalFileTransfer(event.dataTransfer)) {
          event.preventDefault();
          event.stopPropagation();
          input.onExternalDropFiles(
            readDroppedUploadSources(event.dataTransfer),
            item.id,
          );
          return;
        }
        moveFromDrag(event, item.id, input);
      }}
      onFocus={(event) => {
        if (event.target === event.currentTarget) input.onFocusNode(item.id);
      }}
      // eslint-disable-next-line jsx-a11y/role-has-required-aria-props -- selection is not tracked for this tree item
      role="treeitem"
      tabIndex={input.focusedNodeId === item.id ? 0 : -1}
    >
      <div
        className={`group flex h-[33px] min-w-0 items-center gap-1 rounded-md hover:bg-app-hover focus-within:bg-app-hover ${input.externalDrop?.parentId === item.id ? "bg-app-selected" : ""}`}
      >
        {isRenaming
          ? renderFolderRenameInput(input)
          : renderFolderLabel(item, input, isCollapsed)}
      </div>
      {!isCollapsed ? (
        <div className="ml-4" role="group">
          {renderTreeLevel({ ...input, parentId: item.id })}
        </div>
      ) : null}
    </div>
  );
}

function renderFolderRenameInput(input: TreeLevelInput) {
  return (
    <input
      aria-label="Rename folder"
      className="h-[33px] min-w-0 flex-1 rounded-md border border-app-focus bg-app-surface px-2 text-[14px] leading-[18px] outline-none"
      onChange={(event) => input.onRenameChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") input.onRenameSubmit();
        if (event.key === "Escape") input.onRenameCancel();
      }}
      ref={(node) => {
        if (node && node.ownerDocument.activeElement !== node) {
          revealCurrentTreeNode(
            node.closest<HTMLElement>('[role="treeitem"]'),
            true,
          );
          node.focus();
          node.select();
        }
      }}
      value={input.renamingFolder?.name ?? ""}
    />
  );
}

function renderFolderLabel(
  item: DocumentTreeFolder,
  input: TreeLevelInput,
  isCollapsed: boolean,
) {
  return (
    <>
      <button
        className="flex h-[33px] min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-[14px] leading-[18px] text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-app-focus"
        onClick={() => input.onToggle(item.id)}
        type="button"
      >
        {isCollapsed ? (
          <Icon
            icon={ArrowRight01Icon}
            className="shrink-0"
            size={WORKSPACE_TREE_CHEVRON_SIZE}
          />
        ) : (
          <Icon
            icon={ArrowDown01Icon}
            className="shrink-0"
            size={WORKSPACE_TREE_CHEVRON_SIZE}
          />
        )}
        <span className="truncate">{item.name}</span>
      </button>
      <ActionMenu
        placement="right-start"
        buttonClassName={rowActionButtonClass}
        items={[
          {
            children: [
              {
                label: "md",
                onSelect: () => input.onCreateDocument(item.id),
              },
            ],
            icon: <Icon icon={FileAddIcon} size={14} />,
            label: "New file",
          },
          {
            icon: <Icon icon={FolderAddIcon} size={14} />,
            label: "New folder",
            onSelect: () => input.onCreateFolder(item.id),
          },
          {
            icon: <Icon icon={FileImportIcon} size={14} />,
            label: "Import",
            onSelect: () => input.onImportPick(item.id),
          },
          {
            icon: <Icon icon={PencilEdit01Icon} size={14} />,
            label: "Rename",
            onSelect: () => input.onBeginRename(item),
            separatorBefore: true,
          },
          {
            icon: <Icon icon={FolderExportIcon} size={14} />,
            label: "Move",
            onSelect: () => input.onMoveBegin(item),
          },
          {
            danger: true,
            disabled: input.deletingFolderId === item.id,
            icon: <Icon icon={Delete02Icon} size={14} />,
            label: "Delete",
            onSelect: () => input.onDeleteFolder(item.id),
            separatorBefore: true,
          },
        ]}
        label={`Actions for ${item.name}`}
      />
    </>
  );
}

function renderDocumentNode(
  item: TreeDocumentPlacement,
  input: TreeLevelInput,
) {
  const document = input.documentsById.get(item.document_id);
  if (!document || document.status !== "active") return null;
  const fileName = documentFileName(document);
  return (
    <RevealingRow
      ariaLabel={fileName}
      className={`group my-0.5 flex h-[33px] min-w-0 items-center gap-1 rounded-md ${
        // The row carries the open-file tint, so the title fade beneath
        // the revealed actions never fades the tint too.
        document.id === input.activeDocumentId
          ? "bg-muted"
          : "hover:bg-app-hover focus-within:bg-app-hover"
      }`}
      current={document.id === input.activeDocumentId}
      documentId={document.id}
      draggable
      key={item.id}
      onFocus={(event) => {
        if (event.target === event.currentTarget) input.onFocusNode(item.id);
      }}
      onDragStart={(event) => {
        event.stopPropagation();
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(personalPlacementDragType, item.id);
      }}
      placementId={item.id}
      reveal={document.id === input.revealDocumentId}
      role="treeitem"
      tabIndex={input.focusedNodeId === item.id ? 0 : -1}
    >
      <Link
        aria-current={
          document.id === input.activeDocumentId ? "page" : undefined
        }
        className={`flex h-[33px] min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-[14px] leading-[18px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-app-focus ${
          document.id === input.activeDocumentId
            ? "text-foreground"
            : "text-muted-foreground"
        }`}
        onFocus={() => void preloadUnifiedDocumentPage()}
        onPointerEnter={() => void preloadUnifiedDocumentPage()}
        to={`/t/${encodeURIComponent(input.tenantId)}/documents/${encodeURIComponent(document.id)}`}
      >
        <span aria-hidden="true" className="size-3.5 shrink-0" />
        <WorkspaceFileIcon className="shrink-0" filename={fileName} compact />
        <span className="min-w-0 truncate">{fileName}</span>
      </Link>
      {renderDocumentActions(item, document, fileName, input)}
    </RevealingRow>
  );
}

function renderDocumentActions(
  item: TreeDocumentPlacement,
  document: TeamHubDocumentTreeSummary,
  fileName: string,
  input: TreeLevelInput,
) {
  return (
    <ActionMenu
      placement="right-start"
      buttonClassName={rowActionButtonClass}
      items={[
        {
          icon: <Icon icon={Copy01Icon} size={14} />,
          label: "Copy link",
          onSelect: () => input.onCopyLink(document),
        },
        {
          disabled: !canRenameDocument(document),
          icon: <Icon icon={PencilEdit01Icon} size={14} />,
          label: "Rename",
          onSelect: () => input.onRenameDocument(document),
        },
        {
          disabled: !document.capabilities.export,
          icon: <Icon icon={Download01Icon} size={14} />,
          label: "Download",
          onSelect: () => input.onExportDocument(document),
        },
        {
          disabled: !document.capabilities.duplicate,
          icon: <Icon icon={Copy01Icon} size={14} />,
          label: "Duplicate",
          onSelect: () => input.onDuplicateDocument(document, item.parent_id),
        },
        {
          icon: <Icon icon={FolderExportIcon} size={14} />,
          label: "Move",
          onSelect: () => input.onMoveBegin(item),
        },
        {
          danger: true,
          disabled: !document.capabilities.delete,
          icon: <Icon icon={Delete02Icon} size={14} />,
          label: "Delete",
          onSelect: () => input.onTrashDocument(document),
          separatorBefore: true,
        },
      ]}
      label={`Actions for ${fileName}`}
    />
  );
}

function renderUploadNode(upload: PendingDocumentUpload) {
  return (
    <div
      aria-label={`${upload.filename} upload ${upload.status}`}
      className="my-0.5 flex h-[33px] min-w-0 items-center gap-2 rounded-md px-2 text-[14px] leading-[18px] text-app-muted"
      key={upload.id}
      // eslint-disable-next-line jsx-a11y/role-has-required-aria-props -- selection is not tracked for this tree item
      role="treeitem"
    >
      <span aria-hidden="true" className="size-3.5 shrink-0" />
      {upload.status === "uploading" ? (
        <Icon
          icon={Loading03Icon}
          className="shrink-0 animate-spin"
          size={16}
        />
      ) : (
        <WorkspaceFileIcon
          className="shrink-0 opacity-65"
          filename={upload.filename}
          compact
        />
      )}
      <span className="truncate">{upload.filename}</span>
    </div>
  );
}
