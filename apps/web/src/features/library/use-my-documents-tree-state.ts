import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useState,
} from "react";

import type { TeamHubDocumentPlacementNode } from "@/features/teamhub/teamhub-types";

import { compareTreeItems } from "./document-tree-order";
import type { DocumentTreeFolder } from "./my-documents-tree-helpers";
import { useLibraryTreeState } from "./use-library-tree-state";

interface MyDocumentsTreeStateInput {
  activeDocumentId?: string;
  collapseFoldersInitially: boolean;
  items: TeamHubDocumentPlacementNode[];
  loadError?: Error | null;
  pending: boolean;
  tenantId: string;
}

/**
 * Folder collapse, roving focus and keyboard navigation of the personal tree.
 */
export function useMyDocumentsTreeState({
  activeDocumentId,
  collapseFoldersInitially,
  items,
  loadError,
  pending,
  tenantId,
}: MyDocumentsTreeStateInput) {
  const [collapsed, setCollapsed] = useLibraryTreeState<Set<string>>(
    tenantId,
    "owned-folders",
    () => new Set(),
  );
  const [foldersCollapseSeeded, setFoldersCollapseSeeded] = useLibraryTreeState(
    tenantId,
    "owned-folders-initialized",
    () => !collapseFoldersInitially,
  );
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
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
    (item): item is DocumentTreeFolder => item.node_kind === "folder",
  );
  useEffect(() => {
    if (!foldersCollapseSeeded && !pending && !loadError && items.length > 0) {
      setFoldersCollapseSeeded(true);
      setCollapsed(
        new Set(
          items.flatMap((item) =>
            item.node_kind === "folder" ? [item.id] : [],
          ),
        ),
      );
    }
  }, [
    foldersCollapseSeeded,
    items,
    loadError,
    pending,
    setCollapsed,
    setFoldersCollapseSeeded,
  ]);

  useEffect(() => {
    if (
      items.length > 0 &&
      (focusedNodeId === null ||
        !items.some((item) => item.id === focusedNodeId))
    ) {
      const firstRoot = items
        .filter((item) => item.parent_id === undefined)
        .sort(compareTreeItems)[0];
      setFocusedNodeId(firstRoot?.id ?? null);
    }
  }, [focusedNodeId, items]);

  // Runs after the collapse seeding above so a first visit still opens the
  // active Document's ancestors.
  useEffect(() => {
    if (!activeDocumentId) return;
    const itemsById = new Map(items.map((item) => [item.id, item]));
    const activePlacement = items.find(
      (item) =>
        item.node_kind === "document" && item.document_id === activeDocumentId,
    );
    const ancestors = new Set<string>();
    let parentId = activePlacement?.parent_id;
    while (parentId !== undefined) {
      ancestors.add(parentId);
      parentId = itemsById.get(parentId)?.parent_id;
    }
    if (ancestors.size === 0) return;
    setCollapsed((current) => {
      if (![...ancestors].some((id) => current.has(id))) return current;
      return new Set([...current].filter((id) => !ancestors.has(id)));
    });
  }, [activeDocumentId, items, setCollapsed]);

  function expandFolder(folderId?: string) {
    if (!folderId) return;
    setCollapsed((current) => {
      if (!current.has(folderId)) return current;
      const next = new Set(current);
      next.delete(folderId);
      return next;
    });
  }

  function toggle(folderId: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }

  // A new or imported entry must be visible where it lands, so expand the
  // folder receiving it instead of leaving the entry hidden behind a chevron.
  function revealFolder(folderId?: string) {
    if (!folderId) return;
    setCollapsed((current) => {
      if (!current.has(folderId)) return current;
      const next = new Set(current);
      next.delete(folderId);
      return next;
    });
  }

  function handleTreeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const tree = event.currentTarget;
    const current = (event.target as HTMLElement).closest<HTMLElement>(
      '[role="treeitem"]',
    );
    if (!current || !tree.contains(current)) return;
    const placementId = current.dataset.placementId;
    const placement = items.find((item) => item.id === placementId);
    if (!placement) return;
    const visibleItems = Array.from(
      tree.querySelectorAll<HTMLElement>('[role="treeitem"]'),
    );
    const currentIndex = visibleItems.indexOf(current);

    const focusItem = (target: HTMLElement | undefined) => {
      if (!target) return;
      setFocusedNodeId(target.dataset.placementId ?? null);
      target.focus();
    };

    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusItem(
        visibleItems[Math.min(currentIndex + 1, visibleItems.length - 1)],
      );
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusItem(visibleItems[Math.max(currentIndex - 1, 0)]);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusItem(visibleItems[0]);
    } else if (event.key === "End") {
      event.preventDefault();
      focusItem(visibleItems.at(-1));
    } else if (event.key === "ArrowRight" && placement.node_kind === "folder") {
      event.preventDefault();
      if (collapsed.has(placement.id)) {
        toggle(placement.id);
      } else {
        focusItem(
          current.querySelector<HTMLElement>(
            ':scope > [role="group"] > [role="treeitem"]',
          ) ?? undefined,
        );
      }
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (placement.node_kind === "folder" && !collapsed.has(placement.id)) {
        toggle(placement.id);
      } else {
        focusItem(
          current.parentElement?.closest<HTMLElement>('[role="treeitem"]') ??
            undefined,
        );
      }
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (placement.node_kind === "folder") toggle(placement.id);
      else current.querySelector<HTMLAnchorElement>("a")?.click();
    }
  }

  return {
    collapsed,
    documentsById,
    expandFolder,
    focusedNodeId,
    folders,
    handleTreeKeyDown,
    revealFolder,
    setFocusedNodeId,
    toggle,
  };
}
