import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";
import type {
  TeamHubDocumentVersion,
  TeamHubMessageDocumentSegment,
} from "@/features/teamhub/teamhub-types";
import { useDocumentCardMetadata } from "./use-document-card-metadata";
import {
  createDocumentTestRuntime,
  seedRoomUpload,
} from "@/test/document-scenarios";
import { createHttpTeamHubClient } from "@/features/teamhub/teamhub-client";
import type { TestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import {
  teamHubErrorResponse,
  TeamHubTestServer,
  type TestRouteHandler,
  type TestRouteRequest,
} from "@/test/teamhub-test-server";

const getDocument = vi.fn(() => {
  throw new Error("Unexpected Document lookup");
});

const document = {
  id: "doc",
  title: "Budget.md",
  format: "binary",
  representation_format: "binary",
  current_version: { id: "v1", sha256: "hash", version_number: 1 },
};
const segment: TeamHubMessageDocumentSegment = {
  type: "document",
  document_id: "doc",
  content: "wrong.pdf",
  presentation: "card",
};
function version(id: string): TeamHubDocumentVersion {
  return {
    id,
    document_id: "doc",
    version_number: 1,
    filename: "budget.xlsx",
    representation_format: "binary",
    media_type:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size_bytes: 10,
    sha256: "hash",
    source: "ordinary_upload",
    created_at: "2026-09-07T00:00:00Z",
    created_by: {
      id: "human",
      tenant_id: "tenant",
      kind: "human",
      display_name: "Human",
    },
  };
}
function wrapper({ children }: PropsWithChildren) {
  return (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {children}
    </QueryClientProvider>
  );
}
describe("Document card version metadata", () => {
  it("reuses unchanged metadata while still reflecting a renamed Document", async () => {
    const client = stubClient(getDocument, () => version("v1"));
    const { result, rerender } = renderHook(
      ({ title }) =>
        useDocumentCardMetadata(
          client,
          "tenant",
          [{ ...document, title }],
          [{ segments: [segment] }],
        ),
      { wrapper, initialProps: { title: "Before" } },
    );
    await waitFor(() =>
      expect(result.current.doc?.version?.filename).toBe("budget.xlsx"),
    );
    const before = result.current;
    rerender({ title: "Before" });
    expect(result.current).toBe(before);
    rerender({ title: "After" });
    expect(result.current.doc?.title).toBe("After");
    expect(result.current.doc?.version?.filename).toBe("budget.xlsx");
  });

  it("resolves the current Version for an attachment without a document segment", async () => {
    const runtime = createDocumentTestRuntime();

    const uploaded = await seedRoomUpload(runtime, "attachment-only", {
      file: new File(["image"], "sample.jpg", { type: "image/jpeg" }),
      representationFormat: "jpg",
    });
    const lookup = countDocumentReads(runtime);
    const result = renderHook(
      () =>
        useDocumentCardMetadata(
          runtime.client,
          uploaded.tenant_id,
          [],
          [
            {
              segments: [],
              attachments: [
                {
                  id: "attachment-only",
                  document_version_id: uploaded.current_version!.id,
                  sha256: uploaded.current_version!.sha256,
                  document_id: uploaded.id,
                  filename: "sample.jpg",
                  media_type: "image/jpeg",
                  size_bytes: 5,
                  available: true,
                },
              ],
            },
          ],
        ),
      { wrapper },
    );
    await waitFor(() =>
      expect(result.result.current[uploaded.id]?.current_version?.id).toBe(
        uploaded.current_version!.id,
      ),
    );
    expect(lookup).toHaveBeenCalledWith(
      expect.objectContaining({ params: { documentId: uploaded.id } }),
    );
  });

  it("waits for the Room catalog before treating references as missing", async () => {
    const lookup = vi.fn();
    const client = stubClient(lookup, () => version("v1"));
    const { result, rerender } = renderHook(
      ({ pending, documents }) =>
        useDocumentCardMetadata(
          client,
          "tenant",
          documents,
          [{ segments: [segment] }],
          { documentsPending: pending },
        ),
      {
        wrapper,
        initialProps: { pending: true, documents: [] as (typeof document)[] },
      },
    );
    expect(lookup).not.toHaveBeenCalled();
    rerender({ pending: false, documents: [document] });
    expect(result.current.doc?.title).toBe("Budget.md");
    expect(lookup).not.toHaveBeenCalled();
    rerender({ pending: false, documents: [] });
    await waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
  });

  it("loads authorized metadata for a reference missing from the Room list once", async () => {
    const runtime = createDocumentTestRuntime();

    const lookup = countDocumentReads(runtime);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const reference = { ...segment, document_id: "document-product-v0-brief" };
    const result = renderHook(
      () =>
        useDocumentCardMetadata(
          runtime.client,
          "tenant-northstar",
          [],
          [{ segments: [reference, reference] }],
        ),
      {
        wrapper: ({ children }: PropsWithChildren) => (
          <QueryClientProvider client={queryClient}>
            {children}
          </QueryClientProvider>
        ),
      },
    );
    await waitFor(() =>
      expect(result.result.current[reference.document_id]?.title).toBe(
        "product-v0-brief.md",
      ),
    );
    expect(lookup).toHaveBeenCalledTimes(1);
  });
  it("does not fabricate metadata when an inaccessible reference lookup fails", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const lookup = vi.fn(() =>
      teamHubErrorResponse(404, "NOT_FOUND", "not found"),
    );
    const result = renderHook(
      () =>
        useDocumentCardMetadata(
          stubClient(lookup, vi.fn()),
          "tenant",
          [],
          [{ segments: [segment] }],
        ),
      {
        wrapper: ({ children }: PropsWithChildren) => (
          <QueryClientProvider client={queryClient}>
            {children}
          </QueryClientProvider>
        ),
      },
    );
    await waitFor(() =>
      expect(
        queryClient.getQueryState(["teamhub", "tenant", "document", "doc"])
          ?.status,
      ).toBe("error"),
    );
    expect(result.result.current.doc).toBeUndefined();
  });
  it("deduplicates repeated references and follows a replacement current Version", async () => {
    const getDocumentVersion = vi.fn(({ params }: TestRouteRequest) =>
      version(params.documentVersionId!),
    );
    const client = stubClient(getDocument, getDocumentVersion);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const result = renderHook(
      ({ versionId }) =>
        useDocumentCardMetadata(
          client,
          "tenant",
          [
            {
              ...document,
              current_version: { ...document.current_version, id: versionId },
            },
          ],
          [{ segments: [segment, segment] }],
        ),
      {
        initialProps: { versionId: "v1" },
        wrapper: ({ children }: PropsWithChildren) => (
          <QueryClientProvider client={queryClient}>
            {children}
          </QueryClientProvider>
        ),
      },
    );
    await waitFor(() =>
      expect(result.result.current.doc?.version?.filename).toBe("budget.xlsx"),
    );
    expect(getDocumentVersion).toHaveBeenCalledTimes(1);
    result.rerender({ versionId: "v2" });
    await waitFor(() =>
      expect(getDocumentVersion).toHaveBeenCalledWith(
        expect.objectContaining({ params: { documentVersionId: "v2" } }),
      ),
    );
    await waitFor(() =>
      expect(result.result.current.doc?.version?.filename).toBe("budget.xlsx"),
    );
    expect(getDocumentVersion).toHaveBeenCalledTimes(2);
  });
  it("does not fetch native or unreferenced document Versions", () => {
    const getDocumentVersion = vi.fn(() => version("v1"));
    const client = stubClient(getDocument, getDocumentVersion);
    renderHook(
      () =>
        useDocumentCardMetadata(
          client,
          "tenant",
          [
            { ...document, format: "blocknote" },
            { ...document, id: "other" },
          ],
          [{ segments: [segment] }],
        ),
      { wrapper },
    );
    expect(getDocumentVersion).not.toHaveBeenCalled();
  });
  it("keeps authoritative title but does not use mismatched Version metadata", async () => {
    const client = stubClient(getDocument, () => ({
      ...version("v1"),
      document_id: "other",
    }));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const result = renderHook(
      () =>
        useDocumentCardMetadata(
          client,
          "tenant",
          [document],
          [{ segments: [segment] }],
        ),
      {
        wrapper: ({ children }: PropsWithChildren) => (
          <QueryClientProvider client={queryClient}>
            {children}
          </QueryClientProvider>
        ),
      },
    );
    await waitFor(() =>
      expect(
        queryClient.getQueryState([
          "teamhub",
          "tenant",
          "document-card-version",
          "doc",
          "v1",
        ])?.status,
      ).toBe("error"),
    );
    expect(result.result.current.doc?.title).toBe("Budget.md");
    expect(result.result.current.doc?.version).toBeUndefined();
  });
});

function stubClient(
  getDocument: TestRouteHandler,
  getDocumentVersion: TestRouteHandler,
) {
  const server = new TeamHubTestServer()
    .on("GET", "/v0/documents/{documentId}", getDocument)
    .on("GET", "/v0/document-versions/{documentVersionId}", getDocumentVersion);
  return createHttpTeamHubClient({
    fetchRequest: server.fetch,
    onAuthenticationRequired: () => undefined,
  });
}

// Serves the seeded Document and records each metadata read.
function countDocumentReads(runtime: TestTeamHubRuntime) {
  const read = vi.fn(({ params }: TestRouteRequest) =>
    runtime.seed.documents.get(params.documentId!),
  );
  runtime.server.on("GET", "/v0/documents/{documentId}", read);
  return read;
}
