import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { useComposerDocumentOptions } from "./use-composer-document-options";

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

describe("Composer Document catalog", () => {
  it("loads the catalog when the picker opens, without blocking an ordinary draft", async () => {
    const runtime = createTestTeamHubRuntime();
    const listLibraryDocuments = vi.fn(() => ({
      items: [],
      page: { has_more: false },
    }));
    runtime.server.on("GET", "/v0/library/documents", listLibraryDocuments);
    const { result } = renderHook(
      () =>
        useComposerDocumentOptions({
          client: runtime.client,
          draftDocumentIds: [],
          roomDocuments: [],
          tenantId: "tenant",
        }),
      { wrapper },
    );
    expect(listLibraryDocuments).not.toHaveBeenCalled();
    expect(result.current.documentsPending).toBe(false);
    act(() => result.current.onDocumentQueryChange(""));
    await waitFor(() => expect(listLibraryDocuments).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(result.current.shareableDocuments.isSuccess).toBe(true),
    );
    act(() => result.current.onDocumentQueryChange(null));
    act(() => result.current.onDocumentQueryChange(""));
    expect(listLibraryDocuments).toHaveBeenCalledTimes(1);
  });

  it("resolves references from a restored draft even before the picker opens", async () => {
    let resolve!: (value: unknown) => void;
    const getDocument = vi.fn(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const runtime = createTestTeamHubRuntime();
    runtime.server.on("GET", "/v0/documents/{documentId}", getDocument);
    const { result } = renderHook(
      () =>
        useComposerDocumentOptions({
          client: runtime.client,
          draftDocumentIds: ["doc"],
          roomDocuments: [],
          tenantId: "tenant",
        }),
      { wrapper },
    );
    expect(result.current.documentsPending).toBe(true);
    await waitFor(() => expect(getDocument).toHaveBeenCalledOnce());
    await act(async () =>
      resolve({ id: "doc", tenant_id: "tenant", title: "Restored" }),
    );
    await waitFor(() => expect(result.current.documentsPending).toBe(false));
    expect(result.current.documents).toEqual([
      expect.objectContaining({ id: "doc" }),
    ]);
    expect(
      runtime.server.requestsTo("GET", "/v0/library/documents"),
    ).toHaveLength(0);
  });
});
