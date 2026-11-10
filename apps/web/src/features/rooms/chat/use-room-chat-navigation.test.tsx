import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDocumentTestRuntime,
  seedRoomDocument,
  seedRoomUpload,
} from "@/test/document-scenarios";
import { teamHubErrorResponse } from "@/test/teamhub-test-server";
import type { TeamHubDocument } from "@/features/teamhub/teamhub-types";

import { artifactPreviewCache } from "../files/artifact-preview-cache";

import { documentCardVersionQueryKey } from "../files/use-document-card-metadata";
import { documentQueryKey, roomDocumentsQueryKey } from "../room-queries";
import { useRoomChatNavigation } from "./use-room-chat-navigation";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";

const openPanelTab = vi.fn();
vi.mock("../room-connectivity", () => ({
  useRoomOutletContext: () => ({ openPanelTab }),
}));

beforeEach(() => openPanelTab.mockReset());

function deferredDocument() {
  let resolve!: (document: TeamHubDocument) => void;
  const promise = new Promise<TeamHubDocument>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

function wrapper(queryClient: QueryClient) {
  return function TestProviders({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      </MemoryRouter>
    );
  };
}

describe("message file navigation", () => {
  it("opens a file card immediately and shares the validated detail request", async () => {
    const runtime = createDocumentTestRuntime();

    const document = await seedRoomUpload(
      runtime,
      "navigation-versioned-attachment",
      {
        file: new File(["attachment"], "report.txt", { type: "text/plain" }),
        representationFormat: "text",
      },
    );
    const pending = deferredDocument();
    const getDocument = vi.fn(() => pending.promise);
    runtime.server.on("GET", "/v0/documents/{documentId}", getDocument);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(
      () =>
        useRoomChatNavigation(runtime.client, document.tenant_id, "room-all"),
      { wrapper: wrapper(queryClient) },
    );
    act(() => {
      void result.current.openMessageFile({
        type: "file",
        document_id: document.id,
        document_version_id: document.current_version!.id,
        filename: "report.txt",
        content: "report.txt",
      });
    });

    expect(openPanelTab).toHaveBeenCalledExactlyOnceWith({
      kind: "file",
      documentId: document.id,
      title: "report.txt",
      previewCurrentVersion: true,
    });
    await waitFor(() => expect(getDocument).toHaveBeenCalledTimes(1));
    // A panel observer using the same query key must join the pending GET.
    const panelRead = queryClient.fetchQuery({
      queryKey: documentQueryKey(document.tenant_id, document.id),
      queryFn: () => readDocument(runtime.client, document.id),
      staleTime: 10_000,
    });
    pending.resolve(document);
    await expect(panelRead).resolves.toEqual(document);
    expect(getDocument).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        queryClient.getQueryData(
          roomDocumentsQueryKey(document.tenant_id, "room-all"),
        ),
      ).toMatchObject({
        items: [expect.objectContaining({ id: document.id })],
      }),
    );
  });

  it("opens a document card without a pre-panel GET and does not cache another tenant's result", async () => {
    const runtime = createDocumentTestRuntime();

    const document = seedRoomDocument(runtime, "navigation-document-card");
    const pending = deferredDocument();
    runtime.server.on(
      "GET",
      "/v0/documents/{documentId}",
      () => pending.promise,
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // A previously authorized-looking cache entry must not appear before
    // the fresh access check for this message reference finishes.
    queryClient.setQueryData(
      documentQueryKey("wrong-tenant", document.id),
      document,
    );
    const { result } = renderHook(
      () => useRoomChatNavigation(runtime.client, "wrong-tenant", "room-all"),
      { wrapper: wrapper(queryClient) },
    );
    act(() => {
      void result.current.openMessageFile({
        type: "document",
        document_id: document.id,
        content: "Draft",
        presentation: "card",
      });
    });
    expect(openPanelTab).toHaveBeenCalledExactlyOnceWith({
      kind: "file",
      documentId: document.id,
      title: "Draft",
    });
    expect(
      queryClient.getQueryData(documentQueryKey("wrong-tenant", document.id)),
    ).toBeUndefined();
    pending.resolve(document);
    expect(
      runtime.server.requestsTo("GET", "/v0/documents/{documentId}"),
    ).toHaveLength(0);
    expect(
      queryClient.getQueryData(
        roomDocumentsQueryKey("wrong-tenant", "room-all"),
      ),
    ).toBeUndefined();
  });

  it("starts the card's content transfer on click without waiting for open", async () => {
    const runtime = createDocumentTestRuntime();
    const document = await seedRoomUpload(runtime, "navigation-prefetch", {
      file: new File(["%PDF-1.7"], "brief.pdf", { type: "application/pdf" }),
      representationFormat: "binary",
    });
    const version = await readDocumentVersion(
      runtime.client,
      document.current_version!.id,
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(
      roomDocumentsQueryKey(document.tenant_id, "room-all"),
      { items: [document], page: { has_more: false } },
    );
    queryClient.setQueryData(
      documentCardVersionQueryKey(document.tenant_id, document.id, version.id),
      version,
    );
    const versionReads = runtime.server.requestsTo(
      "GET",
      "/v0/document-versions/{documentVersionId}",
    ).length;
    const download = vi.spyOn(runtime.client, "downloadDocumentVersion");
    const { result } = renderHook(
      () =>
        useRoomChatNavigation(runtime.client, document.tenant_id, "room-all"),
      { wrapper: wrapper(queryClient) },
    );

    act(() => {
      void result.current.openMessageFile({
        type: "document",
        document_id: document.id,
        content: "brief.pdf",
        presentation: "card",
      });
    });

    await waitFor(() =>
      expect(download).toHaveBeenCalledExactlyOnceWith(
        version.id,
        expect.objectContaining({ expectedSizeBytes: version.size_bytes }),
      ),
    );
    // The mounted viewer still owns the authorizing open; navigation never sends it.
    expect(
      runtime.server.requestsTo("POST", "/v0/documents/{documentId}/open"),
    ).toHaveLength(0);
    expect(runtime.server.requestsTo("GET", "/v0/session")).toHaveLength(0);
    expect(
      runtime.server.requestsTo(
        "GET",
        "/v0/document-versions/{documentVersionId}",
      ),
    ).toHaveLength(versionReads);
  });

  it("does not prefetch from another tenant's cached card metadata", async () => {
    const runtime = createDocumentTestRuntime();
    const document = await seedRoomUpload(runtime, "navigation-cross-tenant", {
      file: new File(["text"], "notes.txt", { type: "text/plain" }),
      representationFormat: "text",
    });
    const version = await readDocumentVersion(
      runtime.client,
      document.current_version!.id,
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(
      roomDocumentsQueryKey("other-tenant", "room-all"),
      {
        items: [document],
        page: { has_more: false },
      },
    );
    queryClient.setQueryData(
      documentCardVersionQueryKey("other-tenant", document.id, version.id),
      version,
    );
    const download = vi.spyOn(runtime.client, "downloadDocumentVersion");
    const { result } = renderHook(
      () => useRoomChatNavigation(runtime.client, "other-tenant", "room-all"),
      { wrapper: wrapper(queryClient) },
    );

    act(() => {
      void result.current.openMessageFile({
        type: "document",
        document_id: document.id,
        content: "notes.txt",
        presentation: "card",
      });
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(download).not.toHaveBeenCalled();
  });

  it("drops prefetched bytes when the file card's fresh read is denied", async () => {
    const runtime = createDocumentTestRuntime();
    const document = await seedRoomUpload(runtime, "navigation-denied", {
      file: new File(["secret"], "secret.txt", { type: "text/plain" }),
      representationFormat: "text",
    });
    const version = await readDocumentVersion(
      runtime.client,
      document.current_version!.id,
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(
      roomDocumentsQueryKey(document.tenant_id, "room-all"),
      { items: [document], page: { has_more: false } },
    );
    queryClient.setQueryData(
      documentCardVersionQueryKey(document.tenant_id, document.id, version.id),
      version,
    );
    runtime.server.on("GET", "/v0/documents/{documentId}", () =>
      teamHubErrorResponse(404, "NOT_FOUND", "gone"),
    );
    const clear = vi.spyOn(artifactPreviewCache, "clear");
    const { result } = renderHook(
      () =>
        useRoomChatNavigation(runtime.client, document.tenant_id, "room-all"),
      { wrapper: wrapper(queryClient) },
    );

    act(() => {
      void result.current.openMessageFile({
        type: "file",
        document_id: document.id,
        document_version_id: version.id,
        filename: "secret.txt",
        content: "secret.txt",
      });
    });

    await waitFor(() => expect(clear).toHaveBeenCalledOnce());
    clear.mockRestore();
  });

  it("starts a sent attachment's content transfer on click", async () => {
    const runtime = createDocumentTestRuntime();
    const document = await seedRoomUpload(runtime, "navigation-attachment", {
      file: new File(["%PDF-1.7"], "brief.pdf", { type: "application/pdf" }),
      representationFormat: "binary",
    });
    const version = await readDocumentVersion(
      runtime.client,
      document.current_version!.id,
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(
      roomDocumentsQueryKey(document.tenant_id, "room-all"),
      { items: [document], page: { has_more: false } },
    );
    queryClient.setQueryData(
      documentCardVersionQueryKey(document.tenant_id, document.id, version.id),
      version,
    );
    const download = vi.spyOn(runtime.client, "downloadDocumentVersion");
    const { result } = renderHook(
      () =>
        useRoomChatNavigation(runtime.client, document.tenant_id, "room-all"),
      { wrapper: wrapper(queryClient) },
    );

    // Sent attachments carry no Version and open the current Document.
    act(() =>
      result.current.previewArtifact({ id: document.id, title: "brief.pdf" }),
    );

    expect(openPanelTab).toHaveBeenCalledExactlyOnceWith({
      kind: "file",
      documentId: document.id,
      title: "brief.pdf",
      versionId: undefined,
    });
    await waitFor(() =>
      expect(download).toHaveBeenCalledExactlyOnceWith(
        version.id,
        expect.objectContaining({ expectedSizeBytes: version.size_bytes }),
      ),
    );
    expect(
      runtime.server.requestsTo("POST", "/v0/documents/{documentId}/open"),
    ).toHaveLength(0);
  });

  it("does not prefetch current card bytes for an explicitly pinned Version", async () => {
    const runtime = createDocumentTestRuntime();
    const document = await seedRoomUpload(runtime, "navigation-pinned", {
      file: new File(["%PDF-1.7"], "brief.pdf", { type: "application/pdf" }),
      representationFormat: "binary",
    });
    const version = await readDocumentVersion(
      runtime.client,
      document.current_version!.id,
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(
      roomDocumentsQueryKey(document.tenant_id, "room-all"),
      { items: [document], page: { has_more: false } },
    );
    queryClient.setQueryData(
      documentCardVersionQueryKey(document.tenant_id, document.id, version.id),
      version,
    );
    const download = vi.spyOn(runtime.client, "downloadDocumentVersion");
    const { result } = renderHook(
      () =>
        useRoomChatNavigation(runtime.client, document.tenant_id, "room-all"),
      { wrapper: wrapper(queryClient) },
    );

    act(() =>
      result.current.previewArtifact({
        current_version: { id: "version-older" },
        id: document.id,
        title: "brief.pdf",
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(download).not.toHaveBeenCalled();
  });
});

function readDocument(client: TeamHubClient, documentId: string) {
  return teamHubData(
    client.api.GET("/v0/documents/{documentId}", {
      params: { path: { documentId } },
    }),
  );
}

function readDocumentVersion(client: TeamHubClient, documentVersionId: string) {
  return teamHubData(
    client.api.GET("/v0/document-versions/{documentVersionId}", {
      params: { path: { documentVersionId } },
    }),
  );
}
