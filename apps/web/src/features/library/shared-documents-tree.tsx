import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Copy01Icon,
  Delete02Icon,
  Download01Icon,
  FolderAddIcon,
  FolderExportIcon,
  MoreHorizontalIcon,
  PencilEdit01Icon,
  PlusSignIcon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type DragEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Link, useNavigate } from "react-router";

import { ActionMenu } from "@/components/ui/action-menu";
import { Spinner } from "@/components/ui/spinner";
import { writeDocumentLinkClipboard } from "@/features/rooms/files/document-clipboard-link";
import { revealCurrentTreeNode } from "./my-documents-tree-level";
import { WorkspaceFileIcon } from "./workspace-file-icon";
import { triggerArtifactDownload } from "@/features/rooms/files/artifact-preview-loader";
import { documentDetailPath } from "@/features/rooms/files/document-detail-routes";
import { preloadUnifiedDocumentPage } from "@/features/rooms/documents/document-route-preload";
import { teamHubData, teamHubDone } from "@/features/teamhub/teamhub-api";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubDocumentPlacementNode,
  TeamHubDocumentTreeSummary,
} from "@/features/teamhub/teamhub-types";

import { DocumentDeleteDialog } from "./document-delete-dialog";
import { documentFileName } from "./document-display-name";
import { useLibraryTreeState } from "./use-library-tree-state";
import { MoveFolderPickerDialog } from "./move-folder-picker-dialog";
import {
  WORKSPACE_HEADING_ICON_SIZE,
  WORKSPACE_TREE_CHEVRON_SIZE,
  workspaceHeadingActionClass,
  workspaceHeadingToggleClass,
} from "./workspace-sidebar-styles";

type SharedFolder = Extract<
  TeamHubDocumentPlacementNode,
  { node_kind: "folder" }
>;
type SharedTreeRenaming = { id: string; name: string } | null;
const sharedPlacementDragType = "application/x-linger-shared-placement";

export function SharedDocumentsTree({
  activeDocumentId,
  tenantId,
}: {
  activeDocumentId?: string;
  tenantId: string;
}) {
  return (
    <SharedDocumentsTreeSurface
      {...useSharedDocumentsTreeModel({ activeDocumentId, tenantId })}
    />
  );
}

function useSharedDocumentsTreeModel({
  activeDocumentId,
  tenantId,
}: {
  activeDocumentId?: string;
  tenantId: string;
}) {
  const { client } = useTeamHubRuntime();
  const navigate = useNavigate();
  const [trashingDocument, setTrashingDocument] =
    useState<TeamHubDocumentTreeSummary | null>(null);
  const [trashPending, setTrashPending] = useState(false);
  const queryClient = useQueryClient();
  const queryKey = ["teamhub", tenantId, "shared-document-tree"] as const;
  const tree = useQuery({
    queryFn: () =>
      teamHubData(
        client.api.GET("/v0/tenants/{tenantId}/me/shared-document-tree", {
          params: { path: { tenantId } },
        }),
      ),
    queryKey,
    staleTime: 60_000,
  });
  const items = useMemo(() => tree.data?.items ?? [], [tree.data?.items]);
  const documentsById = useMemo(
    () =>
      new Map(
        items.flatMap((item) =>
          item.node_kind === "document"
            ? ([[item.document_id, item.document]] as const)
            : [],
        ),
      ),
    [items],
  );
  const folders = items.filter(
    (item): item is SharedFolder => item.node_kind === "folder",
  );
  const collectionCollapsedKey = `linger:library-shared-collapsed:v2:${tenantId}`;
  const [collectionCollapsed, setCollectionCollapsed] = useState(
    () => window.sessionStorage.getItem(collectionCollapsedKey) !== "false",
  );
  const holdsActiveDocument = documentsById.has(activeDocumentId ?? "");
  // A Document opened in the Library shows where it is kept.
  useEffect(() => {
    if (!holdsActiveDocument) return;
    window.sessionStorage.setItem(collectionCollapsedKey, "false");
    setCollectionCollapsed(false);
  }, [collectionCollapsedKey, holdsActiveDocument]);
  const [collapsed, setCollapsed] = useLibraryTreeState<Set<string>>(
    tenantId,
    "shared-folders",
    () => new Set(),
  );
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<SharedTreeRenaming>(null);
  const [moving, setMoving] = useState<TeamHubDocumentPlacementNode | null>(
    null,
  );
  const [deletingFolderId, setDeletingFolderId] = useState<string | null>(null);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [dragTargetId, setDragTargetId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey });
  }

  async function trashDocument() {
    if (!trashingDocument || trashPending) return;
    setTrashPending(true);
    setError(null);
    try {
      await teamHubDone(
        client.api.DELETE("/v0/documents/{documentId}", {
          params: { path: { documentId: trashingDocument.id } },
        }),
      );
      await queryClient.invalidateQueries({ queryKey: ["teamhub"] });
      if (activeDocumentId === trashingDocument.id)
        void navigate(`/t/${encodeURIComponent(tenantId)}/library`);
      setTrashingDocument(null);
    } catch (cause) {
      setError(sharedTreeError(cause, "The document could not be deleted."));
    } finally {
      setTrashPending(false);
    }
  }

  async function copyLink(document: TeamHubDocumentTreeSummary) {
    const url = new URL(
      documentDetailPath({ documentId: document.id, tenantId }),
      window.location.origin,
    ).toString();
    await writeDocumentLinkClipboard({
      documentId: document.id,
      tenantId,
      title: documentFileName(document),
      url,
    });
  }

  async function exportDocument(summary: TeamHubDocumentTreeSummary) {
    setError(null);
    try {
      const document = await teamHubData(
        client.api.GET("/v0/documents/{documentId}", {
          params: { path: { documentId: summary.id } },
        }),
      );
      const filename = documentFileName(document);
      const content = await client.downloadLatestDocument(document.id);
      triggerArtifactDownload(content.blob, filename);
    } catch (cause) {
      setError(sharedTreeError(cause, "The document could not be exported."));
    }
  }

  useEffect(() => {
    if (
      items.length > 0 &&
      (focusedNodeId === null ||
        !items.some((item) => item.id === focusedNodeId))
    ) {
      setFocusedNodeId(
        items
          .filter((item) => item.parent_id === undefined)
          .sort(compareSharedTreeItems)[0]?.id ?? null,
      );
    }
  }, [focusedNodeId, items]);

  useEffect(() => {
    if (!activeDocumentId) return;
    const byId = new Map(items.map((item) => [item.id, item]));
    const active = items.find(
      (item) =>
        item.node_kind === "document" && item.document_id === activeDocumentId,
    );
    const ancestors = new Set<string>();
    let parentId = active?.parent_id;
    while (parentId !== undefined) {
      ancestors.add(parentId);
      parentId = byId.get(parentId)?.parent_id;
    }
    if (ancestors.size === 0) return;
    setCollapsed((current) => {
      if (![...ancestors].some((id) => current.has(id))) return current;
      return new Set([...current].filter((id) => !ancestors.has(id)));
    });
  }, [activeDocumentId, items, setCollapsed]);

  function toggle(folderId: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }

  async function createFolder(parentId?: string) {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const folder = await teamHubData(
        client.api.POST("/v0/tenants/{tenantId}/me/shared-document-folders", {
          params: { path: { tenantId } },
          body: {
            name: nextSharedFolderName(folders),
            ...(parentId ? { parent_id: parentId } : {}),
          },
        }),
      );
      await refresh();
      if (parentId) {
        setCollapsed((current) => {
          const next = new Set(current);
          next.delete(parentId);
          return next;
        });
      }
      setFocusedNodeId(folder.id);
      setRenaming({ id: folder.id, name: folder.name });
    } catch (cause) {
      setError(sharedTreeError(cause, "The folder could not be created."));
    } finally {
      setCreating(false);
    }
  }

  async function renameFolder() {
    if (!renaming) return;
    const name = renaming.name.trim();
    if (!name) return;
    setError(null);
    try {
      await teamHubData(
        client.api.PATCH(
          "/v0/tenants/{tenantId}/me/shared-document-folders/{folderId}",
          {
            params: { path: { tenantId, folderId: renaming.id } },
            body: { name },
          },
        ),
      );
      setRenaming(null);
      await refresh();
    } catch (cause) {
      setError(sharedTreeError(cause, "The folder could not be renamed."));
    }
  }

  async function moveNode(
    node: TeamHubDocumentPlacementNode,
    parentId: string,
  ) {
    setError(null);
    const input =
      parentId === "__root__"
        ? ({ move_to_root: true } as const)
        : { parent_id: parentId };
    try {
      if (node.node_kind === "folder") {
        await teamHubData(
          client.api.PATCH(
            "/v0/tenants/{tenantId}/me/shared-document-folders/{folderId}",
            { params: { path: { tenantId, folderId: node.id } }, body: input },
          ),
        );
      } else {
        await teamHubData(
          client.api.PUT(
            "/v0/tenants/{tenantId}/me/shared-documents/{documentId}",
            {
              params: { path: { tenantId, documentId: node.document_id } },
              body: input,
            },
          ),
        );
      }
      setMoving(null);
      await refresh();
    } catch (cause) {
      setError(sharedTreeError(cause, "The item could not be moved."));
    }
  }

  async function deleteFolder(folderId: string) {
    if (deletingFolderId) return;
    setDeletingFolderId(folderId);
    setError(null);
    try {
      await teamHubDone(
        client.api.DELETE(
          "/v0/tenants/{tenantId}/me/shared-document-folders/{folderId}",
          { params: { path: { tenantId, folderId } } },
        ),
      );
      await refresh();
    } catch (cause) {
      setError(sharedTreeError(cause, "The folder could not be deleted."));
    } finally {
      setDeletingFolderId(null);
    }
  }

  function handleTreeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const treeRoot = event.currentTarget;
    const current = (event.target as HTMLElement).closest<HTMLElement>(
      '[role="treeitem"]',
    );
    if (!current || !treeRoot.contains(current)) return;
    const item = items.find(
      (candidate) => candidate.id === current.dataset.placementId,
    );
    if (!item) return;
    const visible = Array.from(
      treeRoot.querySelectorAll<HTMLElement>('[role="treeitem"]'),
    );
    const index = visible.indexOf(current);
    const focus = (target: HTMLElement | undefined) => {
      if (!target) return;
      setFocusedNodeId(target.dataset.placementId ?? null);
      target.focus();
    };
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focus(visible[Math.min(index + 1, visible.length - 1)]);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focus(visible[Math.max(index - 1, 0)]);
    } else if (event.key === "Home") {
      event.preventDefault();
      focus(visible[0]);
    } else if (event.key === "End") {
      event.preventDefault();
      focus(visible.at(-1));
    } else if (event.key === "ArrowRight" && item.node_kind === "folder") {
      event.preventDefault();
      if (collapsed.has(item.id)) toggle(item.id);
      else
        focus(
          current.querySelector<HTMLElement>(
            ':scope > [role="group"] > [role="treeitem"]',
          ) ?? undefined,
        );
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (item.node_kind === "folder" && !collapsed.has(item.id)) {
        toggle(item.id);
      } else {
        focus(
          current.parentElement?.closest<HTMLElement>('[role="treeitem"]') ??
            undefined,
        );
      }
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (item.node_kind === "folder") toggle(item.id);
      else current.querySelector<HTMLAnchorElement>("a")?.click();
    }
  }

  return {
    trashingDocument,
    trashPending,
    onTrashDocument: setTrashingDocument,
    onTrashCancel: () => setTrashingDocument(null),
    onTrashConfirm: () => void trashDocument(),
    activeDocumentId,
    collapsed,
    collectionCollapsed,
    creating,
    deletingFolderId,
    documentsById,
    dragTargetId,
    error,
    focusedNodeId,
    folders,
    items,
    moving,
    onBeginRename: (folder: SharedFolder) =>
      setRenaming({ id: folder.id, name: folder.name }),
    onCollectionToggle: () => {
      const next = !collectionCollapsed;
      window.sessionStorage.setItem(collectionCollapsedKey, String(next));
      setCollectionCollapsed(next);
    },
    onCreateFolder: (parentId?: string) => void createFolder(parentId),
    onCopyLink: (document: TeamHubDocumentTreeSummary) =>
      void copyLink(document),
    onDeleteFolder: (folderId: string) => void deleteFolder(folderId),
    onDragTargetChange: setDragTargetId,
    onFocusNode: setFocusedNodeId,
    onExport: (document: TeamHubDocumentTreeSummary) =>
      void exportDocument(document),
    onMove: (node: TeamHubDocumentPlacementNode, parentId: string) =>
      void moveNode(node, parentId),
    onMoveBegin: setMoving,
    onMoveCancel: () => setMoving(null),
    onRenameCancel: () => setRenaming(null),
    onRenameChange: (name: string) =>
      setRenaming((current) => (current ? { ...current, name } : current)),
    onRenameSubmit: () => void renameFolder(),
    onToggle: toggle,
    onTreeKeyDown: handleTreeKeyDown,
    renaming,
    tenantId,
    treeError: tree.isError ? tree.error : null,
    treePending: tree.isPending,
  };
}

function SharedDocumentsTreeSurface({
  trashingDocument,
  trashPending,
  onTrashDocument,
  onTrashCancel,
  onTrashConfirm,
  activeDocumentId,
  collapsed,
  collectionCollapsed,
  creating,
  deletingFolderId,
  documentsById,
  dragTargetId,
  error,
  focusedNodeId,
  folders,
  items,
  moving,
  onBeginRename,
  onCollectionToggle,
  onCreateFolder,
  onCopyLink,
  onDeleteFolder,
  onDragTargetChange,
  onFocusNode,
  onExport,
  onMove,
  onMoveBegin,
  onMoveCancel,
  onRenameCancel,
  onRenameChange,
  onRenameSubmit,
  onToggle,
  onTreeKeyDown,
  renaming,
  tenantId,
  treeError,
  treePending,
}: {
  trashingDocument: TeamHubDocumentTreeSummary | null;
  trashPending: boolean;
  onTrashDocument: (document: TeamHubDocumentTreeSummary) => void;
  onTrashCancel: () => void;
  onTrashConfirm: () => void;
  activeDocumentId?: string;
  collapsed: ReadonlySet<string>;
  collectionCollapsed: boolean;
  creating: boolean;
  deletingFolderId: string | null;
  documentsById: ReadonlyMap<string, TeamHubDocumentTreeSummary>;
  dragTargetId: string | null;
  error: string | null;
  focusedNodeId: string | null;
  folders: SharedFolder[];
  items: TeamHubDocumentPlacementNode[];
  moving: TeamHubDocumentPlacementNode | null;
  onBeginRename: (folder: SharedFolder) => void;
  onCollectionToggle: () => void;
  onCreateFolder: (parentId?: string) => void;
  onCopyLink: (document: TeamHubDocumentTreeSummary) => void;
  onDeleteFolder: (folderId: string) => void;
  onDragTargetChange: (folderId: string | null) => void;
  onFocusNode: (nodeId: string) => void;
  onExport: (document: TeamHubDocumentTreeSummary) => void;
  onMove: (node: TeamHubDocumentPlacementNode, parentId: string) => void;
  onMoveBegin: (node: TeamHubDocumentPlacementNode) => void;
  onMoveCancel: () => void;
  onRenameCancel: () => void;
  onRenameChange: (name: string) => void;
  onRenameSubmit: () => void;
  onToggle: (folderId: string) => void;
  onTreeKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  renaming: SharedTreeRenaming;
  tenantId: string;
  treeError: Error | null;
  treePending: boolean;
}) {
  return (
    <section aria-label="Shared with me tree">
      {trashingDocument ? (
        <DocumentDeleteDialog
          title={documentFileName(trashingDocument)}
          pending={trashPending}
          error={error}
          onCancel={onTrashCancel}
          onConfirm={onTrashConfirm}
        />
      ) : null}
      <div className="flex items-center justify-between gap-1">
        <button
          aria-expanded={!collectionCollapsed}
          aria-label={`${collectionCollapsed ? "Expand" : "Collapse"} Shared with me`}
          className={workspaceHeadingToggleClass}
          onClick={onCollectionToggle}
          type="button"
        >
          <Icon
            icon={UserGroupIcon}
            className="shrink-0 text-app-muted"
            size={WORKSPACE_HEADING_ICON_SIZE}
          />
          <span className="truncate">Shared with me</span>
        </button>
        <ActionMenu
          placement="right-start"
          buttonClassName={workspaceHeadingActionClass}
          items={[
            {
              disabled: creating || treePending || treeError !== null,
              icon: <Icon icon={FolderAddIcon} size={16} />,
              label: "New folder",
              onSelect: () => onCreateFolder(),
            },
          ]}
          label="Organize Shared with me"
          trigger={
            <Icon icon={PlusSignIcon} size={WORKSPACE_HEADING_ICON_SIZE} />
          }
        />
      </div>
      {!collectionCollapsed ? (
        <>
          {error ? (
            <p className="px-1 py-2 text-xs text-app-danger" role="alert">
              {error}
            </p>
          ) : null}
          {moving ? (
            <SharedMoveDialog
              folders={folders}
              items={items}
              label={
                moving.node_kind === "folder"
                  ? moving.name
                  : (documentsById.get(moving.document_id)?.title ?? "document")
              }
              node={moving}
              onCancel={onMoveCancel}
              onMove={(parentId) => onMove(moving, parentId)}
            />
          ) : null}
          {treeError ? (
            <p className="px-1 py-2 text-xs text-app-danger" role="alert">
              {treeError.message || "Shared with me is unavailable."}
            </p>
          ) : treePending ? (
            <p className="flex items-center gap-2 px-1 py-2 text-xs text-app-muted">
              <Spinner size={14} />
              Loading tree…
            </p>
          ) : items.length > 0 ? (
            // eslint-disable-next-line jsx-a11y/interactive-supports-focus -- composite widget: focus is managed on its child items
            <div
              aria-label="Shared with me"
              className="mt-2 ml-4"
              onKeyDown={onTreeKeyDown}
              role="tree"
            >
              {renderSharedTreeLevel({
                onTrashDocument,
                activeDocumentId,
                collapsed,
                deletingFolderId,
                documentsById,
                dragTargetId,
                focusedNodeId,
                items,
                onBeginRename,
                onCreateFolder,
                onCopyLink,
                onDeleteFolder,
                onDragTargetChange,
                onFocusNode,
                onExport,
                onMove,
                onMoveBegin,
                onRenameCancel,
                onRenameChange,
                onRenameSubmit,
                onToggle,
                parentId: undefined,
                renaming,
                tenantId,
              })}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function renderSharedTreeLevel(input: {
  onTrashDocument: (document: TeamHubDocumentTreeSummary) => void;
  activeDocumentId?: string;
  collapsed: ReadonlySet<string>;
  deletingFolderId: string | null;
  documentsById: ReadonlyMap<string, TeamHubDocumentTreeSummary>;
  dragTargetId: string | null;
  focusedNodeId: string | null;
  items: TeamHubDocumentPlacementNode[];
  onBeginRename: (folder: SharedFolder) => void;
  onCreateFolder: (parentId?: string) => void;
  onCopyLink: (document: TeamHubDocumentTreeSummary) => void;
  onDeleteFolder: (folderId: string) => void;
  onDragTargetChange: (folderId: string | null) => void;
  onFocusNode: (nodeId: string) => void;
  onExport: (document: TeamHubDocumentTreeSummary) => void;
  onMove: (node: TeamHubDocumentPlacementNode, parentId: string) => void;
  onMoveBegin: (node: TeamHubDocumentPlacementNode) => void;
  onRenameCancel: () => void;
  onRenameChange: (name: string) => void;
  onRenameSubmit: () => void;
  onToggle: (folderId: string) => void;
  parentId: string | undefined;
  renaming: SharedTreeRenaming;
  tenantId: string;
}): ReactNode {
  const moveFromDrag = (event: DragEvent, parentId: string) => {
    if (!hasDragType(event.dataTransfer, sharedPlacementDragType)) return;
    event.preventDefault();
    event.stopPropagation();
    input.onDragTargetChange(null);
    const sourceId = event.dataTransfer.getData(sharedPlacementDragType);
    const source = input.items.find((candidate) => candidate.id === sourceId);
    if (
      !source ||
      source.id === parentId ||
      (source.node_kind === "folder" &&
        descendants(source.id, input.items).includes(parentId))
    ) {
      return;
    }
    input.onMove(source, parentId);
  };
  return input.items
    .filter((item) => item.parent_id === input.parentId)
    .sort(compareSharedTreeItems)
    .map((item) => {
      if (item.node_kind === "folder") {
        const isCollapsed = input.collapsed.has(item.id);
        const isRenaming = input.renaming?.id === item.id;
        return (
          <div
            aria-expanded={!isCollapsed}
            aria-label={item.name}
            className="my-0.5"
            data-placement-id={item.id}
            draggable={!isRenaming}
            key={item.id}
            onDragOver={(event) => {
              if (!hasDragType(event.dataTransfer, sharedPlacementDragType))
                return;
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = "move";
              input.onDragTargetChange(item.id);
            }}
            onDragLeave={(event) => {
              if (
                event.currentTarget.contains(event.relatedTarget as Node | null)
              )
                return;
              input.onDragTargetChange(null);
            }}
            onDragStart={(event) => {
              event.stopPropagation();
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData(sharedPlacementDragType, item.id);
            }}
            onDragEnd={() => input.onDragTargetChange(null)}
            onDrop={(event) => moveFromDrag(event, item.id)}
            onFocus={(event) => {
              if (event.target === event.currentTarget)
                input.onFocusNode(item.id);
            }}
            // eslint-disable-next-line jsx-a11y/role-has-required-aria-props -- selection is not tracked for this tree item
            role="treeitem"
            tabIndex={input.focusedNodeId === item.id ? 0 : -1}
          >
            <div
              className={`group flex h-[33px] min-w-0 items-center gap-1 rounded-md hover:bg-app-hover focus-within:bg-app-hover ${input.dragTargetId === item.id ? "bg-app-selected" : ""}`}
            >
              {isRenaming ? (
                <input
                  aria-label="Rename shared folder"
                  className="h-[33px] min-w-0 flex-1 rounded-md border border-app-focus bg-app-surface px-2 text-[14px] leading-[18px] outline-none"
                  onChange={(event) => input.onRenameChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") input.onRenameSubmit();
                    if (event.key === "Escape") input.onRenameCancel();
                  }}
                  ref={(node) => {
                    if (node && node.ownerDocument.activeElement !== node) {
                      node.focus();
                      node.select();
                    }
                  }}
                  value={input.renaming?.name ?? ""}
                />
              ) : (
                <>
                  <button
                    className="flex h-[33px] min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-[14px] leading-[18px] text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-app-focus"
                    onClick={() => input.onToggle(item.id)}
                    type="button"
                  >
                    {isCollapsed ? (
                      <Icon
                        icon={ArrowRight01Icon}
                        size={WORKSPACE_TREE_CHEVRON_SIZE}
                      />
                    ) : (
                      <Icon
                        icon={ArrowDown01Icon}
                        size={WORKSPACE_TREE_CHEVRON_SIZE}
                      />
                    )}
                    <span className="truncate">{item.name}</span>
                  </button>
                  <ActionMenu
                    placement="right-start"
                    buttonClassName="row-reveal-action flex size-7 shrink-0 items-center justify-center rounded-lg text-app-muted transition-colors hover:bg-accent hover:text-app-ink aria-expanded:bg-accent aria-expanded:text-app-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-focus"
                    items={[
                      {
                        icon: <Icon icon={FolderAddIcon} size={14} />,
                        label: "New folder",
                        onSelect: () => input.onCreateFolder(item.id),
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
                    label={`Actions for shared folder ${item.name}`}
                    trigger={<Icon icon={MoreHorizontalIcon} size={14} />}
                  />
                </>
              )}
            </div>
            {!isCollapsed ? (
              <div className="ml-4" role="group">
                {renderSharedTreeLevel({ ...input, parentId: item.id })}
              </div>
            ) : null}
          </div>
        );
      }
      const document = input.documentsById.get(item.document_id);
      if (!document || document.status !== "active") return null;
      const fileName = documentFileName(document);
      const provenance = sharedAccessProvenanceLabel(document);
      const current = document.id === input.activeDocumentId;
      return (
        <div
          aria-label={fileName}
          className={`group my-0.5 flex min-h-[33px] min-w-0 items-center gap-1 rounded-md ${
            current
              ? "bg-app-selected"
              : "hover:bg-app-hover focus-within:bg-app-hover"
          }`}
          data-placement-id={item.id}
          draggable
          key={item.id}
          // The open Document's row scrolls into view, as in My pages.
          ref={(node) => revealCurrentTreeNode(node, current)}
          onDragStart={(event) => {
            event.stopPropagation();
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData(sharedPlacementDragType, item.id);
          }}
          onDragEnd={() => input.onDragTargetChange(null)}
          onFocus={(event) => {
            if (event.target === event.currentTarget)
              input.onFocusNode(item.id);
          }}
          // eslint-disable-next-line jsx-a11y/role-has-required-aria-props -- selection is not tracked for this tree item
          role="treeitem"
          tabIndex={input.focusedNodeId === item.id ? 0 : -1}
        >
          <Link
            aria-current={current ? "page" : undefined}
            className={`flex min-h-[33px] min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-[14px] leading-[18px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-app-focus ${
              current ? "text-app-ink" : "text-app-body"
            }`}
            onFocus={() => void preloadUnifiedDocumentPage()}
            onPointerEnter={() => void preloadUnifiedDocumentPage()}
            to={`/t/${encodeURIComponent(input.tenantId)}/documents/${encodeURIComponent(document.id)}`}
          >
            <span aria-hidden="true" className="size-3.5 shrink-0" />
            <WorkspaceFileIcon filename={fileName} compact />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{fileName}</span>
              {provenance ? (
                <span className="block truncate text-[12px] text-app-muted">
                  {provenance}
                </span>
              ) : null}
            </span>
          </Link>
          <ActionMenu
            placement="right-start"
            buttonClassName="row-reveal-action flex size-7 shrink-0 items-center justify-center rounded-lg text-app-muted transition-colors hover:bg-accent hover:text-app-ink aria-expanded:bg-accent aria-expanded:text-app-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-focus"
            items={[
              {
                icon: <Icon icon={Copy01Icon} size={14} />,
                label: "Copy link",
                onSelect: () => input.onCopyLink(document),
              },
              {
                disabled: !document.capabilities.export,
                icon: <Icon icon={Download01Icon} size={14} />,
                label: "Download",
                onSelect: () => input.onExport(document),
              },
              {
                icon: <Icon icon={FolderExportIcon} size={14} />,
                label: "Move",
                onSelect: () => input.onMoveBegin(item),
              },
              ...(document.capabilities.delete
                ? [
                    {
                      icon: <Icon icon={Delete02Icon} size={14} />,
                      label: "Delete",
                      onSelect: () => input.onTrashDocument(document),
                    },
                  ]
                : []),
            ]}
            label={`Actions for shared document ${fileName}`}
            trigger={<Icon icon={MoreHorizontalIcon} size={14} />}
          />
        </div>
      );
    });
}

function sharedAccessProvenanceLabel(document: TeamHubDocumentTreeSummary) {
  const labels: string[] = [];
  for (const source of document.access_sources ?? []) {
    if (source.status === "active") {
      const sourceLabel =
        source.source_kind === "direct"
          ? "Direct"
          : source.source_kind === "context"
            ? source.provenance.binding_kind === "room"
              ? "Room context"
              : source.provenance.binding_kind === "task"
                ? "Task context"
                : "Wiki context"
            : source.source_kind === "link"
              ? "Link audience"
              : "Owner";
      labels.push(
        `${sourceLabel} ${source.role.charAt(0).toUpperCase()}${source.role.slice(1)}`,
      );
    }
  }
  return labels.join(" + ");
}

function SharedMoveDialog({
  folders,
  items,
  label,
  node,
  onCancel,
  onMove,
}: {
  folders: SharedFolder[];
  items: TeamHubDocumentPlacementNode[];
  label: string;
  node: TeamHubDocumentPlacementNode;
  onCancel: () => void;
  onMove: (parentId: string) => void;
}) {
  const invalid = new Set<string>(
    node.node_kind === "folder"
      ? [node.id, ...descendants(node.id, items)]
      : [],
  );
  return (
    <MoveFolderPickerDialog
      currentParentId={node.parent_id}
      disabledFolderIds={invalid}
      folders={folders}
      label={label}
      onCancel={onCancel}
      onMove={onMove}
      rootLabel="Shared with me"
    />
  );
}

function descendants(folderId: string, items: TeamHubDocumentPlacementNode[]) {
  const result: string[] = [];
  const pending = [folderId];
  while (pending.length > 0) {
    const parentId = pending.pop()!;
    for (const item of items) {
      if (item.node_kind !== "folder" || item.parent_id !== parentId) continue;
      result.push(item.id);
      pending.push(item.id);
    }
  }
  return result;
}

function hasDragType(transfer: DataTransfer, type: string) {
  return Array.from(transfer.types).includes(type);
}

function nextSharedFolderName(folders: SharedFolder[]) {
  const names = new Set(folders.map((folder) => folder.name));
  if (!names.has("New Folder")) return "New Folder";
  let suffix = 2;
  while (names.has(`New Folder ${suffix}`)) suffix += 1;
  return `New Folder ${suffix}`;
}

function compareSharedTreeItems(
  left: TeamHubDocumentPlacementNode,
  right: TeamHubDocumentPlacementNode,
) {
  if (left.node_kind !== right.node_kind) {
    return left.node_kind === "folder" ? -1 : 1;
  }
  return (
    left.sort_key.localeCompare(right.sort_key) ||
    left.id.localeCompare(right.id)
  );
}

function sharedTreeError(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}
