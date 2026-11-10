import { describe, expect, it } from "vitest";

import type { TeamHubDocumentPlacementNode } from "@/features/teamhub/teamhub-types";

import { compareTreeItems, documentAfterRemoval } from "./document-tree-order";

function folder(id: string, createdAt: string, parentId?: string) {
  return {
    created_at: createdAt,
    id,
    name: id,
    node_kind: "folder",
    parent_id: parentId,
    sort_key: id,
  } as unknown as TeamHubDocumentPlacementNode;
}

function file(documentId: string, createdAt: string, parentId?: string) {
  return {
    created_at: createdAt,
    document_id: documentId,
    id: `placement-${documentId}`,
    node_kind: "document",
    parent_id: parentId,
    sort_key: documentId,
  } as unknown as TeamHubDocumentPlacementNode;
}

describe("documentAfterRemoval", () => {
  it("sorts timestamps chronologically across fractional seconds and offsets", () => {
    expect(
      compareTreeItems(
        file("earlier", "2026-09-01T00:00:00Z"),
        file("later", "2026-09-01T00:00:00.1Z"),
      ),
    ).toBeLessThan(0);
    expect(
      compareTreeItems(
        folder("earlier", "2026-09-01T01:00:00+02:00"),
        folder("later", "2026-09-01T00:00:00Z"),
      ),
    ).toBeGreaterThan(0);
  });
  const items = [
    folder("folder-a", "2026-09-01"),
    file("in-folder", "2026-09-02", "folder-a"),
    file("first", "2026-09-03"),
    file("second", "2026-09-04"),
  ];

  it("opens the Document the tree lists next, across folders", () => {
    expect(documentAfterRemoval(items, "in-folder")).toBe("first");
    expect(documentAfterRemoval(items, "first")).toBe("second");
  });

  it("falls back to the one before, and to none when it was the only one", () => {
    expect(documentAfterRemoval(items, "second")).toBe("first");
    expect(documentAfterRemoval([file("only", "2026-09-01")], "only")).toBe(
      undefined,
    );
    expect(documentAfterRemoval(items, "missing")).toBe(undefined);
  });
});
