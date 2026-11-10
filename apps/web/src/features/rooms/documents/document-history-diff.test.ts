import { describe, expect, it } from "vitest";

import { diffDocumentLines } from "./document-history-diff";

describe("diffDocumentLines", () => {
  it("keeps only context lines for identical snapshots", () => {
    expect(diffDocumentLines("same\ncontent\n", "same\ncontent\n")).toEqual([
      { id: "equal:0:0", kind: "equal", text: "same" },
      { id: "equal:1:1", kind: "equal", text: "content" },
    ]);
  });

  it("highlights added and removed lines", () => {
    expect(
      diffDocumentLines("# v1\n\nold line\n", "# v1\n\nnew line\n"),
    ).toEqual([
      { id: "equal:0:0", kind: "equal", text: "# v1" },
      { id: "equal:1:1", kind: "equal", text: "" },
      { id: "remove:2", kind: "remove", text: "old line" },
      { id: "add:2", kind: "add", text: "new line" },
    ]);
  });

  it("handles an entirely new snapshot", () => {
    expect(diffDocumentLines("", "hello")).toEqual([
      { id: "add:0", kind: "add", text: "hello" },
    ]);
  });
});
