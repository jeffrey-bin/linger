// @vitest-environment jsdom
import { materializeRoomDocument } from "@linger/document-model";
import { describe, expect, it } from "vitest";

import { historyRevisionMarkdown } from "./document-history-revision";

describe("historyRevisionMarkdown", () => {
  it("renders verified Yjs Revision state as user-readable Markdown", async () => {
    const state = await materializeRoomDocument({
      materializationId: "history-revision-readable",
      schemaVersion: 1,
      sourceBytes: new TextEncoder().encode("# Release notes\n\nStable text."),
      sourceKind: "markdown",
    });

    expect(
      historyRevisionMarkdown(
        bytesToBase64(state.stateBytes),
        state.bytesSha256,
      ),
    ).toContain("Stable text.");
  });

  it("rejects Revision bytes that do not match immutable evidence", async () => {
    const state = await materializeRoomDocument({
      materializationId: "history-revision-corrupt",
      schemaVersion: 1,
      sourceBytes: new TextEncoder().encode("Verified"),
      sourceKind: "markdown",
    });

    expect(() =>
      historyRevisionMarkdown(bytesToBase64(state.stateBytes), "0".repeat(64)),
    ).toThrow("History Revision bytes failed integrity verification.");
  });
});

function bytesToBase64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}
