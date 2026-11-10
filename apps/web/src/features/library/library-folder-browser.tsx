import { ArrowRight01Icon, Folder01Icon } from "@hugeicons/core-free-icons";
import { type FormEvent, useState } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { ModalDialog } from "@/components/ui/modal-dialog";
import type {
  TeamHubDocumentPlacementNode,
  TeamHubDocumentTreeSummary,
} from "@/features/teamhub/teamhub-types";

import type { PendingDocumentUpload } from "./library-upload-queue";

export type LibraryFolder = Extract<
  TeamHubDocumentPlacementNode,
  { node_kind: "folder" }
>;

const folderDateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

/** Folders and Documents placed directly in one My pages folder (root when undefined). */
export function folderChildren(
  items: readonly TeamHubDocumentPlacementNode[],
  folderId: string | undefined,
) {
  const folders: LibraryFolder[] = [];
  const documents: TeamHubDocumentTreeSummary[] = [];
  for (const item of items) {
    if (item.parent_id !== folderId) continue;
    if (item.node_kind === "folder") folders.push(item);
    else documents.push(item.document);
  }
  return { documents, folders };
}

/** Every Document below a folder (the whole tree when undefined), at any depth. */
export function folderDescendantDocuments(
  items: readonly TeamHubDocumentPlacementNode[],
  folderId: string | undefined,
) {
  const childrenByParent = new Map<
    string | undefined,
    TeamHubDocumentPlacementNode[]
  >();
  for (const item of items) {
    const siblings = childrenByParent.get(item.parent_id) ?? [];
    siblings.push(item);
    childrenByParent.set(item.parent_id, siblings);
  }
  const documents: TeamHubDocumentTreeSummary[] = [];
  const pending = [...(childrenByParent.get(folderId) ?? [])];
  for (let item = pending.pop(); item; item = pending.pop()) {
    if (item.node_kind === "document") documents.push(item.document);
    else pending.push(...(childrenByParent.get(item.id) ?? []));
  }
  return documents;
}

/** The folder and its ancestors, outermost first; empty when the folder is gone. */
export function folderTrail(
  items: readonly TeamHubDocumentPlacementNode[],
  folderId: string | undefined,
) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const trail: LibraryFolder[] = [];
  let current = folderId ? byId.get(folderId) : undefined;
  while (current?.node_kind === "folder") {
    trail.unshift(current);
    current = current.parent_id ? byId.get(current.parent_id) : undefined;
  }
  return trail;
}

export function LibraryFolderBreadcrumb({
  onOpen,
  rootLabel,
  trail,
}: {
  onOpen: (folderId?: string) => void;
  rootLabel: string;
  trail: readonly LibraryFolder[];
}) {
  return (
    <nav
      aria-label="Folder path"
      className="mb-3 flex flex-wrap items-center gap-1 text-sm"
    >
      <button
        className="rounded-md px-1.5 py-0.5 text-app-muted hover:bg-app-hover hover:text-app-body"
        onClick={() => onOpen(undefined)}
        type="button"
      >
        {rootLabel}
      </button>
      {trail.map((folder, index) => (
        <span className="flex min-w-0 items-center gap-1" key={folder.id}>
          <Icon className="text-app-muted" icon={ArrowRight01Icon} size={14} />
          {index === trail.length - 1 ? (
            <span aria-current="page" className="truncate px-1.5 font-medium">
              {folder.name}
            </span>
          ) : (
            <button
              className="truncate rounded-md px-1.5 py-0.5 text-app-muted hover:bg-app-hover hover:text-app-body"
              onClick={() => onOpen(folder.id)}
              type="button"
            >
              {folder.name}
            </button>
          )}
        </span>
      ))}
    </nav>
  );
}

export function LibraryFolderRow({
  folder,
  onOpen,
}: {
  folder: LibraryFolder;
  onOpen: (folderId: string) => void;
}) {
  const date = new Date(folder.updated_at);
  return (
    <div className="workspace-file-row">
      <button
        aria-label={`Open folder ${folder.name}`}
        className="workspace-file-name text-left"
        onClick={() => onOpen(folder.id)}
        type="button"
      >
        <span className="workspace-file-icon bg-muted text-muted-foreground">
          <Icon icon={Folder01Icon} size={18} />
        </span>
        <span className="min-w-0">
          <strong>{folder.name}</strong>
          <span className="workspace-file-context">Folder</span>
        </span>
      </button>
      <div className="workspace-file-metadata">
        <time dateTime={folder.updated_at} title={folder.updated_at}>
          {Number.isNaN(date.valueOf())
            ? "—"
            : folderDateFormatter.format(date)}
        </time>
      </div>
      <span aria-hidden="true" />
    </div>
  );
}

/** A compact queue summary that survives leaving and reopening the Library. */
export function LibraryUploadSummary({
  uploads,
}: {
  uploads: readonly PendingDocumentUpload[];
}) {
  if (uploads.length === 0) return null;
  const current = uploads.find((upload) => upload.status === "uploading");
  const percent = Math.round((current?.progress ?? 0) * 100);
  return (
    <div
      aria-label="Upload progress"
      className="mb-2 rounded-lg border border-app-border px-3 py-2 text-xs text-app-muted"
      role="status"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="truncate">
          {current ? `Uploading ${current.filename}` : "Preparing upload…"}
        </span>
        <span className="shrink-0">
          {uploads.length === 1
            ? "1 file left"
            : `${uploads.length} files left`}
        </span>
      </div>
      <div
        aria-label="Current file upload"
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={percent}
        className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted"
        role="progressbar"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-150"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

export function NewFolderDialog({
  defaultName,
  onCancel,
  onCreate,
}: {
  defaultName: string;
  onCancel: () => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(defaultName);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!trimmed || pending) return;
    setPending(true);
    setError(null);
    try {
      await onCreate(trimmed);
    } catch (createError) {
      setError(
        createError instanceof Error
          ? createError.message
          : "The folder could not be created.",
      );
      setPending(false);
    }
  }

  return (
    <ModalDialog
      closeOnBackdrop={!pending}
      footer={
        <>
          <Button disabled={pending} onClick={onCancel} tone="secondary">
            Cancel
          </Button>
          <Button
            disabled={!trimmed}
            loading={pending}
            onClick={() => void submit()}
            tone="primary"
          >
            Create
          </Button>
        </>
      }
      onClose={() => {
        if (!pending) onCancel();
      }}
      size="sm"
      title="New folder"
    >
      <form className="px-5 py-4" onSubmit={(event) => void submit(event)}>
        <label className="block text-sm font-medium text-app-body">
          Folder name
          <input
            aria-label="Folder name"
            className="mt-1 h-9 w-full rounded-md border border-app-border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            maxLength={255}
            onChange={(event) => setName(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            value={name}
          />
        </label>
        {error ? (
          <p className="mt-3 text-sm text-app-danger" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </ModalDialog>
  );
}
