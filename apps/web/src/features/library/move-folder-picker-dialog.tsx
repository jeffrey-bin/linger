import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  Folder01Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";

export interface MoveFolder {
  id: string;
  name: string;
  parent_id?: string;
}

const rootId = "__root__";

export function MoveFolderPickerDialog({
  currentParentId,
  disabledFolderIds = new Set<string>(),
  folders,
  label,
  onCancel,
  onMove,
  rootLabel,
}: {
  currentParentId?: string;
  disabledFolderIds?: ReadonlySet<string>;
  folders: MoveFolder[];
  label: string;
  onCancel: () => void;
  onMove: (parentId: string) => void;
  rootLabel: string;
}) {
  const availableFolders = useMemo(
    () => folders.filter((folder) => !disabledFolderIds.has(folder.id)),
    [disabledFolderIds, folders],
  );
  const currentTargetId = currentParentId ?? rootId;
  const [targetId, setTargetId] = useState(currentTargetId);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    expandedCurrentPath(availableFolders, currentParentId),
  );
  const model = useMemo(
    () => createFolderModel(availableFolders),
    [availableFolders],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const searchResults: MoveFolder[] = [];
  if (normalizedQuery) {
    for (const folder of availableFolders) {
      if (
        model.pathsById
          .get(folder.id)
          ?.toLocaleLowerCase()
          .includes(normalizedQuery)
      ) {
        searchResults.push(folder);
      }
    }
    searchResults.sort((left, right) =>
      (model.pathsById.get(left.id) ?? left.name).localeCompare(
        model.pathsById.get(right.id) ?? right.name,
      ),
    );
  }

  function toggle(folderId: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }

  return (
    <ModalDialog
      closeOnBackdrop
      onClose={onCancel}
      size="lg"
      title={`Move ${label} to…`}
      footer={
        <>
          <Button onClick={onCancel} tone="secondary">
            Cancel
          </Button>
          <Button
            disabled={targetId === currentTargetId}
            onClick={() => onMove(targetId)}
            tone="primary"
          >
            Move here
          </Button>
        </>
      }
    >
      <div className="px-5 py-4">
        <label className="relative block">
          <span className="sr-only">Search folders</span>
          <Icon
            icon={Search01Icon}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-app-muted"
            size={16}
          />
          <input
            aria-label="Search folders"
            className="h-10 w-full rounded-lg border border-border bg-card pl-10 pr-9 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground hover:border-border-hover focus:border-foreground focus:ring-2 focus:ring-ring"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search folders…"
            role="searchbox"
            type="text"
            value={query}
          />
          {query ? (
            <button
              aria-label="Clear folder search"
              className="absolute right-2 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-sm text-app-muted hover:bg-app-hover hover:text-app-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-focus"
              onClick={() => setQuery("")}
              type="button"
            >
              <Icon icon={Cancel01Icon} size={14} />
            </button>
          ) : null}
        </label>

        <div className="workspace-scrollbar mt-3 min-h-56 overflow-y-auto rounded-lg border border-border bg-card p-1 sm:max-h-[48vh]">
          {normalizedQuery ? (
            <FolderSearchResults
              currentTargetId={currentTargetId}
              folders={searchResults}
              onSelect={setTargetId}
              pathsById={model.pathsById}
              targetId={targetId}
            />
          ) : (
            <div aria-label="Move destination folders" role="tree">
              <FolderTargetRow
                current={currentTargetId === rootId}
                folderId={rootId}
                level={1}
                name={rootLabel}
                onSelect={setTargetId}
                selected={targetId === rootId}
              />
              <div className="ml-4" role="group">
                <FolderTreeLevel
                  childrenByParent={model.childrenByParent}
                  currentTargetId={currentTargetId}
                  expanded={expanded}
                  level={2}
                  onSelect={setTargetId}
                  onToggle={toggle}
                  parentId={rootId}
                  targetId={targetId}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </ModalDialog>
  );
}

function FolderTreeLevel({
  childrenByParent,
  currentTargetId,
  expanded,
  level,
  onSelect,
  onToggle,
  parentId,
  targetId,
}: {
  childrenByParent: ReadonlyMap<string, MoveFolder[]>;
  currentTargetId: string;
  expanded: ReadonlySet<string>;
  level: number;
  onSelect: (folderId: string) => void;
  onToggle: (folderId: string) => void;
  parentId: string;
  targetId: string;
}) {
  return (childrenByParent.get(parentId) ?? []).map((folder) => {
    const children = childrenByParent.get(folder.id) ?? [];
    const open = expanded.has(folder.id);
    return (
      <div key={folder.id}>
        <FolderTargetRow
          current={currentTargetId === folder.id}
          expanded={children.length > 0 ? open : undefined}
          folderId={folder.id}
          level={level}
          name={folder.name}
          onSelect={onSelect}
          onToggle={children.length > 0 ? onToggle : undefined}
          selected={targetId === folder.id}
        />
        {children.length > 0 && open ? (
          <div className="ml-4" role="group">
            <FolderTreeLevel
              childrenByParent={childrenByParent}
              currentTargetId={currentTargetId}
              expanded={expanded}
              level={level + 1}
              onSelect={onSelect}
              onToggle={onToggle}
              parentId={folder.id}
              targetId={targetId}
            />
          </div>
        ) : null}
      </div>
    );
  });
}

function FolderTargetRow({
  current,
  expanded,
  folderId,
  level,
  name,
  onSelect,
  onToggle,
  selected,
}: {
  current: boolean;
  expanded?: boolean;
  folderId: string;
  level: number;
  name: string;
  onSelect: (folderId: string) => void;
  onToggle?: (folderId: string) => void;
  selected: boolean;
}) {
  return (
    <div
      aria-current={current ? "location" : undefined}
      aria-expanded={expanded}
      aria-level={level}
      aria-selected={selected}
      className={`group my-0.5 flex min-h-10 min-w-0 items-center rounded-md pr-2 ${
        selected
          ? "bg-app-selected text-app-ink"
          : "text-app-body hover:bg-app-hover"
      }`}
      role="treeitem"
    >
      {onToggle ? (
        <button
          aria-label={`${expanded ? "Collapse" : "Expand"} ${name}`}
          className="flex size-8 shrink-0 items-center justify-center rounded-sm text-app-muted hover:text-app-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-focus"
          onClick={() => onToggle(folderId)}
          type="button"
        >
          {expanded ? (
            <Icon icon={ArrowDown01Icon} size={14} />
          ) : (
            <Icon icon={ArrowRight01Icon} size={14} />
          )}
        </button>
      ) : (
        <span aria-hidden="true" className="size-8 shrink-0" />
      )}
      <button
        aria-label={`Select ${name}`}
        className="flex min-h-10 min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-app-focus"
        onClick={() => onSelect(folderId)}
        type="button"
      >
        <Icon
          icon={Folder01Icon}
          className="shrink-0 text-app-muted"
          size={16}
        />
        <span className="truncate text-sm">{name}</span>
      </button>
      {current ? (
        <span className="ml-2 shrink-0 text-xs text-app-muted">Current</span>
      ) : null}
    </div>
  );
}

function FolderSearchResults({
  currentTargetId,
  folders,
  onSelect,
  pathsById,
  targetId,
}: {
  currentTargetId: string;
  folders: MoveFolder[];
  onSelect: (folderId: string) => void;
  pathsById: ReadonlyMap<string, string>;
  targetId: string;
}) {
  if (folders.length === 0) {
    return (
      <p className="px-3 py-10 text-center text-sm text-app-muted">
        No folders found.
      </p>
    );
  }
  return (
    <ul aria-label="Folder search results">
      {folders.map((folder) => (
        <li
          className={`my-0.5 rounded-md ${
            targetId === folder.id ? "bg-app-selected" : "hover:bg-app-hover"
          }`}
          key={folder.id}
        >
          <button
            aria-label={`Select ${pathsById.get(folder.id) ?? folder.name}`}
            aria-pressed={targetId === folder.id}
            className="flex min-h-12 w-full min-w-0 items-center gap-2 px-3 text-left outline-none focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-app-focus"
            onClick={() => onSelect(folder.id)}
            type="button"
          >
            <Icon
              icon={Folder01Icon}
              className="shrink-0 text-app-muted"
              size={16}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-app-ink">
                {folder.name}
              </span>
              <span className="block truncate text-xs text-app-muted">
                {pathsById.get(folder.id)}
              </span>
            </span>
            {currentTargetId === folder.id ? (
              <span className="shrink-0 text-xs text-app-muted">Current</span>
            ) : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

function expandedCurrentPath(folders: MoveFolder[], currentParentId?: string) {
  const expanded = new Set<string>();
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const visited = new Set<string>();
  let folderId = currentParentId;
  while (folderId !== undefined && !visited.has(folderId)) {
    visited.add(folderId);
    expanded.add(folderId);
    folderId = byId.get(folderId)?.parent_id;
  }
  return expanded;
}

function createFolderModel(folders: MoveFolder[]) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const childrenByParent = new Map<string, MoveFolder[]>();
  const pathsById = new Map<string, string>();
  for (const folder of folders) {
    const parentId =
      folder.parent_id && byId.has(folder.parent_id)
        ? folder.parent_id
        : rootId;
    const children = childrenByParent.get(parentId) ?? [];
    children.push(folder);
    childrenByParent.set(parentId, children);
  }
  for (const children of childrenByParent.values()) {
    children.sort((left, right) => left.name.localeCompare(right.name));
  }
  for (const folder of folders) {
    const names = [folder.name];
    const visited = new Set([folder.id]);
    let parentId = folder.parent_id;
    while (parentId !== undefined && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      names.unshift(parent.name);
      parentId = parent.parent_id;
    }
    pathsById.set(folder.id, names.join(" / "));
  }
  return { childrenByParent, pathsById };
}
