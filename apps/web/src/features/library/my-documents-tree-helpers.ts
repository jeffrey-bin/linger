import type { QueryClient } from "@tanstack/react-query";

import type { TeamHubDocumentPlacementNode } from "@/features/teamhub/teamhub-types";

import { documentFileName } from "./document-display-name";
import type { UploadFailure } from "./library-upload-queue";

export type DocumentTreeFolder = Extract<
  TeamHubDocumentPlacementNode,
  { node_kind: "folder" }
>;
export interface ExternalDocumentDrop {
  parentId?: string;
}
interface MyDocumentTreeCache {
  items: TeamHubDocumentPlacementNode[];
}
export const personalPlacementDragType = "application/x-linger-placement";

export function myDocumentTreeQueryKey(tenantId: string) {
  return ["teamhub", tenantId, "document-tree"] as const;
}

/** Applies an optimistic tree change and returns its rollback. */
export function updateMyDocumentTreeCache(
  queryClient: QueryClient,
  treeQueryKey: ReturnType<typeof myDocumentTreeQueryKey>,
  update: (
    items: TeamHubDocumentPlacementNode[],
  ) => TeamHubDocumentPlacementNode[],
) {
  const previous = queryClient.getQueryData<MyDocumentTreeCache>(treeQueryKey);
  if (previous) {
    queryClient.setQueryData<MyDocumentTreeCache>(treeQueryKey, {
      ...previous,
      items: update(previous.items),
    });
  }
  return () => {
    if (previous) queryClient.setQueryData(treeQueryKey, previous);
  };
}

export function isFolderMoveCycle(
  sourceId: string,
  targetId: string,
  items: TeamHubDocumentPlacementNode[],
) {
  const itemsById = new Map(items.map((item) => [item.id, item]));
  let currentId: string | undefined = targetId;
  while (currentId !== undefined) {
    if (currentId === sourceId) return true;
    currentId = itemsById.get(currentId)?.parent_id;
  }
  return false;
}

export function nextFolderName(
  items: readonly TeamHubDocumentPlacementNode[],
  parentId?: string,
) {
  const rootNames = new Set(
    items
      .filter(
        (item): item is DocumentTreeFolder =>
          item.node_kind === "folder" && item.parent_id === parentId,
      )
      .map((item) => item.name.toLocaleLowerCase()),
  );
  if (!rootNames.has("new folder")) return "New Folder";
  for (let index = 2; ; index += 1) {
    const candidate = `New Folder ${index}`;
    if (!rootNames.has(candidate.toLocaleLowerCase())) return candidate;
  }
}

export function usedDocumentFilenames(
  items: readonly TeamHubDocumentPlacementNode[],
  parentId?: string,
) {
  return new Set(
    items
      .filter(
        (
          item,
        ): item is Extract<
          TeamHubDocumentPlacementNode,
          { node_kind: "document" }
        > => item.parent_id === parentId && item.node_kind === "document",
      )
      .map((item) => documentFileName(item.document).toLocaleLowerCase()),
  );
}

/** Folder names are unique case-insensitively in TeamHub, so paths are too. */
export function folderKey(path: readonly string[]) {
  return path.join("/").toLocaleLowerCase();
}

export function nextAvailableFolderName(
  name: string,
  usedNames: ReadonlySet<string>,
) {
  if (!usedNames.has(name.toLocaleLowerCase())) return name;
  for (let index = 2; ; index += 1) {
    const candidate = `${name} (${index})`;
    if (!usedNames.has(candidate.toLocaleLowerCase())) return candidate;
  }
}

export function uploadFailureMessage(failures: readonly UploadFailure[]) {
  if (failures.length === 1) {
    const [failure] = failures;
    return `${failure!.filename}: ${failure!.message}`;
  }
  const names = failures
    .slice(0, 3)
    .map((failure) => failure.filename)
    .join(", ");
  const more = failures.length > 3 ? ` and ${failures.length - 3} more` : "";
  return `${failures.length} files could not be uploaded (${names}${more}). ${failures[0]!.message}`;
}

export function nextAvailableUploadFilename(
  filename: string,
  usedNames: Set<string>,
) {
  const normalized = filename.toLocaleLowerCase();
  if (!usedNames.has(normalized)) return filename;
  const extensionIndex = filename.lastIndexOf(".");
  const basename =
    extensionIndex > 0 ? filename.slice(0, extensionIndex) : filename;
  const extension = extensionIndex > 0 ? filename.slice(extensionIndex) : "";
  for (let index = 2; ; index += 1) {
    const candidate = `${basename} (${index})${extension}`;
    if (!usedNames.has(candidate.toLocaleLowerCase())) return candidate;
  }
}

export function isExternalFileTransfer(transfer: DataTransfer) {
  return Array.from(transfer.types).includes("Files");
}

export function hasDragType(transfer: DataTransfer, type: string) {
  return Array.from(transfer.types).includes(type);
}

export async function runSequentially<T>(
  items: readonly T[],
  operation: (item: T, index: number) => Promise<void>,
  index = 0,
): Promise<void> {
  const item = items[index];
  if (item === undefined) return;
  await operation(item, index);
  await runSequentially(items, operation, index + 1);
}

export function nextPaint() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 16));
}
