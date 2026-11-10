import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { materializeRoomDocument } from "@linger/document-model";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import {
  teamHubErrorResponse,
  type TestRouteRequest,
} from "@/test/teamhub-test-server";
import type {
  TeamHubDocumentHistoryContent,
  TeamHubDocumentHistoryEntry,
} from "@/features/teamhub/teamhub-types";

import { UnifiedDocumentTimelineDialog } from "./unified-document-timeline-dialog";

describe("UnifiedDocumentTimelineDialog", () => {
  it("waits for the previous Revision before showing a highlighted diff", async () => {
    const runtime = createTestTeamHubRuntime();

    const [previousState, selectedState] = await Promise.all([
      materializeRoomDocument({
        materializationId: "history-dialog-previous",
        schemaVersion: 1,
        sourceBytes: new TextEncoder().encode("# Release notes\n\nOld line."),
        sourceKind: "markdown",
      }),
      materializeRoomDocument({
        materializationId: "history-dialog-selected",
        schemaVersion: 1,
        sourceBytes: new TextEncoder().encode("# Release notes\n\nNew line."),
        sourceKind: "markdown",
      }),
    ]);
    const actor = {
      display_name: "Jenny Bin",
      id: "actor-jenny",
      kind: "human" as const,
      tenant_id: "tenant-northstar",
    };
    const selectedEntry: TeamHubDocumentHistoryEntry = {
      contributors: [actor],
      created_at: "2026-08-27T12:01:00.000Z",
      created_by: actor,
      document_id: "document-history-dialog",
      id: "history-selected",
      persisted_seq: 2,
      revision_id: "revision-selected",
      trigger: "manual",
    };
    const previousEntry: TeamHubDocumentHistoryEntry = {
      ...selectedEntry,
      created_at: "2026-08-27T12:00:00.000Z",
      id: "history-previous",
      persisted_seq: 1,
      revision_id: "revision-previous",
    };
    const previousGate = deferred<void>();
    const selectedReturned = deferred<void>();
    const contentByEntry = new Map<string, TeamHubDocumentHistoryContent>([
      [
        selectedEntry.id,
        historyContent(
          selectedEntry,
          selectedState.stateBytes,
          selectedState.bytesSha256,
        ),
      ],
      [
        previousEntry.id,
        historyContent(
          previousEntry,
          previousState.stateBytes,
          previousState.bytesSha256,
        ),
      ],
    ]);
    runtime.server.on("GET", "/v0/documents/{documentId}/history", () => ({
      items: [selectedEntry, previousEntry],
      page: { has_more: false },
    }));
    const getContent = vi.fn(async ({ params }: TestRouteRequest) => {
      const entryId = params.historyEntryId!;
      const content = contentByEntry.get(entryId);
      if (!content) throw new Error(`Unexpected History entry ${entryId}`);
      if (entryId === previousEntry.id) await previousGate.promise;
      if (entryId === selectedEntry.id) selectedReturned.resolve();
      return content;
    });
    runtime.server.on(
      "GET",
      "/v0/document-history/{historyEntryId}/content",
      getContent,
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <UnifiedDocumentTimelineDialog
          client={runtime.client}
          documentId={selectedEntry.document_id}
          onClose={() => undefined}
          tenantId="tenant-northstar"
        />
      </QueryClientProvider>,
    );

    await act(async () => {
      await selectedReturned.promise;
    });
    await waitFor(() =>
      expect(
        queryClient.getQueryState([
          "teamhub",
          "document-history",
          selectedEntry.id,
          "markdown",
        ])?.status,
      ).toBe("success"),
    );
    expect(
      queryClient.getQueryState([
        "teamhub",
        "document-history",
        previousEntry.id,
        "markdown",
      ])?.fetchStatus,
    ).toBe("fetching");
    expect(getContent).toHaveBeenCalledWith(
      expect.objectContaining({ params: { historyEntryId: selectedEntry.id } }),
    );
    expect(getContent).toHaveBeenCalledWith(
      expect.objectContaining({ params: { historyEntryId: previousEntry.id } }),
    );
    expect(
      screen.getByRole("checkbox", { name: "Highlight changes" }),
    ).toBeChecked();
    expect(screen.getByText("Loading checkpoint...")).toBeVisible();
    expect(
      screen.queryByLabelText("Historical Document content"),
    ).not.toBeInTheDocument();

    await act(async () => {
      previousGate.resolve();
      await previousGate.promise;
    });
    const diff = await screen.findByRole("note");
    expect(within(diff).getByText("Old line.")).toBeVisible();
    expect(within(diff).getByText("New line.")).toBeVisible();
    expect(within(diff).getByText("-", { selector: "span" })).toBeVisible();
    expect(within(diff).getByText("+", { selector: "span" })).toBeVisible();
  });

  it("shows a previous Revision error instead of the selected ordinary preview", async () => {
    const runtime = createTestTeamHubRuntime();

    const selectedState = await materializeRoomDocument({
      materializationId: "history-dialog-selected-before-error",
      schemaVersion: 1,
      sourceBytes: new TextEncoder().encode(
        "# Release notes\n\nSelected content.",
      ),
      sourceKind: "markdown",
    });
    const actor = {
      display_name: "Jenny Bin",
      id: "actor-jenny",
      kind: "human" as const,
      tenant_id: "tenant-northstar",
    };
    const selectedEntry: TeamHubDocumentHistoryEntry = {
      contributors: [actor],
      created_at: "2026-08-27T12:01:00.000Z",
      created_by: actor,
      document_id: "document-history-error",
      id: "history-selected-before-error",
      persisted_seq: 2,
      revision_id: "revision-selected-before-error",
      trigger: "manual",
    };
    const previousEntry: TeamHubDocumentHistoryEntry = {
      ...selectedEntry,
      created_at: "2026-08-27T12:00:00.000Z",
      id: "history-previous-error",
      persisted_seq: 1,
      revision_id: "revision-previous-error",
    };
    runtime.server.on("GET", "/v0/documents/{documentId}/history", () => ({
      items: [selectedEntry, previousEntry],
      page: { has_more: false },
    }));
    runtime.server.on(
      "GET",
      "/v0/document-history/{historyEntryId}/content",
      ({ params }) => {
        const entryId = params.historyEntryId;
        if (entryId === previousEntry.id) {
          return teamHubErrorResponse(
            404,
            "NOT_FOUND",
            "Previous Revision is unavailable.",
          );
        }
        if (entryId !== selectedEntry.id) {
          throw new Error(`Unexpected History entry ${entryId}`);
        }
        return historyContent(
          selectedEntry,
          selectedState.stateBytes,
          selectedState.bytesSha256,
        );
      },
    );

    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <UnifiedDocumentTimelineDialog
          client={runtime.client}
          documentId={selectedEntry.document_id}
          onClose={() => undefined}
          tenantId="tenant-northstar"
        />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByText("Previous Revision is unavailable."),
    ).toHaveAttribute("role", "alert");
    expect(
      screen.getByRole("checkbox", { name: "Highlight changes" }),
    ).toBeChecked();
    expect(
      screen.queryByLabelText("Historical Document content"),
    ).not.toBeInTheDocument();
  });
});

function historyContent(
  entry: TeamHubDocumentHistoryEntry,
  stateBytes: Uint8Array,
  stateBytesSHA256: string,
): TeamHubDocumentHistoryContent {
  return {
    asset_manifest: [],
    full_state_fingerprint: stateBytesSHA256,
    history_entry: entry,
    state_bytes: bytesToBase64(stateBytes),
    state_bytes_sha256: stateBytesSHA256,
    state_vector: "",
  };
}

function bytesToBase64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
