import type { TeamHubDocumentPlacementNode } from "@/features/teamhub/teamhub-types";

/** Sidebar order: folders first, newest folder on top, Documents oldest first. */
export function compareTreeItems(
  left: TeamHubDocumentPlacementNode,
  right: TeamHubDocumentPlacementNode,
) {
  if (left.node_kind !== right.node_kind) {
    return left.node_kind === "folder" ? -1 : 1;
  }
  const createdOrder =
    Date.parse(left.created_at) - Date.parse(right.created_at);
  if (createdOrder !== 0) {
    return left.node_kind === "folder" ? -createdOrder : createdOrder;
  }
  const sortKeyOrder = left.sort_key.localeCompare(right.sort_key);
  return left.node_kind === "folder" ? -sortKeyOrder : sortKeyOrder;
}

function documentOrder(
  items: readonly TeamHubDocumentPlacementNode[],
  parentId?: string,
): string[] {
  return items
    .filter((item) => item.parent_id === parentId)
    .sort(compareTreeItems)
    .flatMap((item) =>
      item.node_kind === "folder"
        ? documentOrder(items, item.id)
        : [item.document_id],
    );
}

/**
 * The Document to open once `documentId` leaves the tree: the one listed after
 * it, else the one before it, else none.
 */
export function documentAfterRemoval(
  items: readonly TeamHubDocumentPlacementNode[],
  documentId: string,
): string | undefined {
  const order = documentOrder(items);
  const index = order.indexOf(documentId);
  if (index < 0) return undefined;
  return order[index + 1] ?? order[index - 1];
}
