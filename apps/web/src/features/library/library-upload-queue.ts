import { useSyncExternalStore } from "react";

/** One file to upload and the folder path, relative to the drop target, it came from. */
export interface UploadSource {
  file: File;
  folderPath: readonly string[];
}

export interface UploadFailure {
  filename: string;
  message: string;
}

/** Everything one drop or folder pick asks to upload. */
export interface UploadBatch {
  /** Folders to recreate even when they hold no files. */
  folderPaths: readonly (readonly string[])[];
  /** Entries the browser could not read; reported with the upload failures. */
  readFailures: readonly UploadFailure[];
  sources: readonly UploadSource[];
}

export interface PendingDocumentUpload {
  /** Display name; files from a dropped folder keep their relative path. */
  filename: string;
  id: string;
  parentId?: string;
  /** Upload fraction from 0 to 1 while the request body is sent. */
  progress: number;
  status: "queued" | "uploading";
}

interface TenantUploads {
  /** True while a batch runs, so a second batch cannot race it from another view. */
  active: boolean;
  error: string | null;
  uploads: readonly PendingDocumentUpload[];
}

const emptyUploads: TenantUploads = { active: false, error: null, uploads: [] };
const uploadsByTenant = new Map<string, TenantUploads>();
const listeners = new Set<() => void>();

/**
 * Library uploads outlive the page that started them: leaving the Library and
 * coming back must still show the queue, so it lives outside React state.
 */
export function useTenantUploads(tenantId: string): TenantUploads {
  return useSyncExternalStore(
    subscribe,
    () => uploadsByTenant.get(tenantId) ?? emptyUploads,
  );
}

export const tenantUploads = {
  add(tenantId: string, uploads: readonly PendingDocumentUpload[]) {
    update(tenantId, (current) => ({
      ...current,
      uploads: [...current.uploads, ...uploads],
    }));
  },
  patch(
    tenantId: string,
    uploadId: string,
    patch: Partial<Pick<PendingDocumentUpload, "progress" | "status">>,
  ) {
    update(tenantId, (current) => ({
      ...current,
      uploads: current.uploads.map((upload) =>
        upload.id === uploadId ? { ...upload, ...patch } : upload,
      ),
    }));
  },
  remove(tenantId: string, uploadIds: ReadonlySet<string>) {
    update(tenantId, (current) => ({
      ...current,
      uploads: current.uploads.filter((upload) => !uploadIds.has(upload.id)),
    }));
  },
  setActive(tenantId: string, active: boolean) {
    update(tenantId, (current) => ({ ...current, active }));
  },
  setError(tenantId: string, error: string | null) {
    update(tenantId, (current) => ({ ...current, error }));
  },
};

export function fileUploadBatch(files: readonly File[]): UploadBatch {
  return {
    folderPaths: [],
    readFailures: [],
    sources: files.map((file) => ({ file, folderPath: [] })),
  };
}

export function resetTenantUploadsForTest() {
  uploadsByTenant.clear();
  notify();
}

function update(
  tenantId: string,
  change: (current: TenantUploads) => TenantUploads,
) {
  uploadsByTenant.set(
    tenantId,
    change(uploadsByTenant.get(tenantId) ?? emptyUploads),
  );
  notify();
}

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Reads files and whole folders from an OS drop. Directory entries must be
 * taken while the drop event is still dispatching, so call this synchronously
 * from the drop handler and await the result afterwards.
 */
export function readDroppedUploadSources(
  transfer: DataTransfer,
): Promise<UploadBatch> {
  const entries = Array.from(transfer.items ?? []).flatMap((item) => {
    if (item.kind !== "file") return [];
    const entry = item.webkitGetAsEntry?.();
    return entry && !isHiddenName(entry.name) ? [entry] : [];
  });
  if (entries.length === 0) {
    return Promise.resolve(
      fileUploadBatch(
        Array.from(transfer.files ?? []).filter(
          (file) => !isHiddenName(file.name),
        ),
      ),
    );
  }
  const batch = {
    folderPaths: [] as string[][],
    readFailures: [] as UploadFailure[],
    sources: [] as UploadSource[],
  };
  return Promise.all(entries.map((entry) => readEntry(entry, [], batch))).then(
    () => batch,
  );
}

/** Files chosen through a directory picker carry their path from the chosen folder. */
export function pickedFolderUploadSources(files: Iterable<File>): UploadBatch {
  const sources = Array.from(files).flatMap((file): UploadSource[] => {
    const segments = (file.webkitRelativePath || file.name)
      .split("/")
      .filter(Boolean);
    if (segments.some(isHiddenName)) return [];
    return [{ file, folderPath: segments.slice(0, -1) }];
  });
  return { folderPaths: [], readFailures: [], sources };
}

/** Reads one entry into the batch; an unreadable entry is recorded, not thrown. */
async function readEntry(
  entry: FileSystemEntry,
  folderPath: readonly string[],
  batch: {
    folderPaths: string[][];
    readFailures: UploadFailure[];
    sources: UploadSource[];
  },
): Promise<void> {
  const path = [...folderPath, entry.name].join("/");
  try {
    if (isFileEntry(entry)) {
      const file = await new Promise<File>((resolve, reject) =>
        entry.file(resolve, reject),
      );
      batch.sources.push({ file, folderPath });
      return;
    }
    if (!isDirectoryEntry(entry)) return;
    const children = (await readAllDirectoryEntries(entry)).filter(
      (child) => !isHiddenName(child.name),
    );
    const childPath = [...folderPath, entry.name];
    batch.folderPaths.push(childPath);
    await Promise.all(
      children.map((child) => readEntry(child, childPath, batch)),
    );
  } catch (readError) {
    batch.readFailures.push({
      filename: path,
      message:
        readError instanceof Error
          ? readError.message
          : "It could not be read.",
    });
  }
}

async function readAllDirectoryEntries(directory: FileSystemDirectoryEntry) {
  const reader = directory.createReader();
  const entries: FileSystemEntry[] = [];
  // readEntries returns at most about 100 entries per call; read until empty.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (batch.length === 0) return entries;
    entries.push(...batch);
  }
}

function isFileEntry(entry: FileSystemEntry): entry is FileSystemFileEntry {
  return entry.isFile;
}

function isDirectoryEntry(
  entry: FileSystemEntry,
): entry is FileSystemDirectoryEntry {
  return entry.isDirectory;
}

/** Skips OS metadata such as .DS_Store inside uploaded folders. */
function isHiddenName(name: string) {
  return name.startsWith(".");
}
