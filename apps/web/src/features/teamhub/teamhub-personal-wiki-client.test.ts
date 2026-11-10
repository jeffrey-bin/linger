import { sentRequests } from "./teamhub-client-test-support";
import { describe, expect, it, vi } from "vitest";

import { createHttpTeamHubClient } from "./teamhub-client";
import { FakeXmlHttpRequest } from "./teamhub-client-test-support";
import { requestUrlText } from "@linger/service-kit";

describe("TeamHub unified Wiki Document client", () => {
  it("does not expose retired Wiki input, output, or Artifact import methods", () => {
    const client = createHttpTeamHubClient({
      baseUrl: "https://teamhub.example.test",
    });
    expect(
      [
        "getPersonalWikiInputTree",
        "getPersonalWikiOutputTree",
        "importPersonalWikiArtifactVersion",
        "uploadPersonalWikiInputFile",
      ].filter((method) => method in client),
    ).toEqual([]);
  });

  it("reads the current Human's graph visualization as HTML", async () => {
    const html = "<!doctype html><title>Knowledge Graph</title>";
    const fetchRequest = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    const client = createHttpTeamHubClient({
      baseUrl: "https://teamhub.example.test",
      fetchRequest,
    });

    await expect(
      client.getPersonalKnowledgeGraphVisualization("tenant/a"),
    ).resolves.toBe(html);
    const [request] = (await sentRequests(fetchRequest))[0] ?? [];
    expect(requestUrlText(request)).toBe(
      "https://teamhub.example.test/v0/tenants/tenant%2Fa/personal-wiki/graph",
    );
  });

  it("uploads a Wiki source through the unified multipart boundary", async () => {
    const request = new FakeXmlHttpRequest();
    const progress = vi.fn();
    const client = createHttpTeamHubClient({
      baseUrl: "https://teamhub.example.test",
      xhrFactory: () => request as unknown as XMLHttpRequest,
    });
    const upload = client.uploadPersonalWikiDocument(
      "tenant/a",
      {
        file: new File(["# Source\n"], "source.md", { type: "text/markdown" }),
        parentId: "folder/a",
        representationFormat: "markdown",
      },
      "wiki-document-upload-12345678",
      { onProgress: progress },
    );
    request.reportProgress(5, 10);
    request.complete(201, documentFixture());
    await expect(upload).resolves.toEqual(documentFixture());
    expect(request.url).toBe(
      "https://teamhub.example.test/v0/tenants/tenant%2Fa/personal-wiki/documents/uploads",
    );
    expect(request.headers.get("Idempotency-Key")).toBe(
      "wiki-document-upload-12345678",
    );
    expect((request.body as FormData).get("parent_id")).toBe("folder/a");
    expect((request.body as FormData).get("representation_format")).toBe(
      "markdown",
    );
    expect(progress.mock.calls.map(([value]) => value)).toEqual([0, 0.5, 1]);
  });

  it("binds unified Wiki source upload cancellation to the request", async () => {
    const request = new FakeXmlHttpRequest();
    const controller = new AbortController();
    const client = createHttpTeamHubClient({
      baseUrl: "https://teamhub.example.test",
      xhrFactory: () => request as unknown as XMLHttpRequest,
    });
    const upload = client.uploadPersonalWikiDocument(
      "tenant-a",
      {
        file: new File(["cancel"], "cancel.md"),
        representationFormat: "markdown",
      },
      "wiki-document-upload-cancel",
      { signal: controller.signal },
    );
    controller.abort();
    await expect(upload).rejects.toMatchObject({ name: "AbortError" });
    expect(request.aborted).toBe(true);
  });

  it("maps unified Wiki upload authentication failures", async () => {
    const request = new FakeXmlHttpRequest();
    const onAuthenticationRequired = vi.fn();
    const client = createHttpTeamHubClient({
      baseUrl: "https://teamhub.example.test",
      onAuthenticationRequired,
      xhrFactory: () => request as unknown as XMLHttpRequest,
    });
    const upload = client.uploadPersonalWikiDocument(
      "tenant-a",
      {
        file: new File(["source"], "source.md"),
        representationFormat: "markdown",
      },
      "wiki-document-upload-expired",
    );
    request.complete(401, {
      error: {
        code: "SESSION_EXPIRED",
        message: "Sign in again.",
        retryable: false,
      },
    });
    await expect(upload).rejects.toMatchObject({
      code: "SESSION_EXPIRED",
      status: 401,
    });
    expect(onAuthenticationRequired).toHaveBeenCalledWith("session-expired");
  });

  it("reports expired authentication when downloading Document Version bytes", async () => {
    const onAuthenticationRequired = vi.fn();
    const fetchRequest = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: "UNAUTHENTICATED",
            message: "Signed in elsewhere.",
            retryable: false,
          },
        },
        401,
      ),
    );
    const client = createHttpTeamHubClient({
      baseUrl: "https://teamhub.example.test",
      fetchRequest,
      onAuthenticationRequired,
    });
    await expect(
      client.downloadDocumentVersion("document-version/1", {
        expectedSizeBytes: 12,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
    expect(onAuthenticationRequired).toHaveBeenCalledWith("session-expired");
  });

  it("uploads a replacement as a Document Version", async () => {
    const request = new FakeXmlHttpRequest();
    const client = createHttpTeamHubClient({
      baseUrl: "https://teamhub.example.test",
      xhrFactory: () => request as unknown as XMLHttpRequest,
    });
    const upload = client.uploadDocumentVersion(
      "document/1",
      {
        expectedCurrentVersionId: "document-version/1",
        file: new File(["replacement"], "source.md"),
        representationFormat: "markdown",
      },
      "document-version-replace-12345678",
    );
    request.complete(201, versionFixture());
    await expect(upload).resolves.toEqual(versionFixture());
    expect(request.url).toBe(
      "https://teamhub.example.test/v0/documents/document%2F1/versions",
    );
    expect((request.body as FormData).get("expected_current_version_id")).toBe(
      "document-version/1",
    );
  });
});

function documentFixture() {
  const actor = {
    display_name: "Jenny",
    id: "actor-human",
    kind: "human" as const,
    tenant_id: "tenant-a",
  };
  return {
    capabilities: {
      comment: false,
      delete: true,
      duplicate: true,
      export: false,
      manage: true,
      read: true,
      use_as_context: true,
      write: true,
    },
    created_at: "2026-08-23T00:00:00Z",
    creator: actor,
    current_version: null,
    draft_capability: "none" as const,
    format: "markdown",
    from: [
      {
        binding_kind: "wiki_source" as const,
        context_id: "wiki-1",
      },
    ],
    id: "document/1",
    owner: actor,
    status: "active" as const,
    tenant_id: "tenant-a",
    title: "source.md",
    updated_at: "2026-08-23T00:00:00Z",
  };
}

function versionFixture() {
  return {
    base_version_id: "document-version/1",
    created_at: "2026-08-23T00:00:00Z",
    created_by: documentFixture().creator,
    document_id: "document/1",
    filename: "source.md",
    id: "document-version/2",
    media_type: "text/markdown",
    representation_format: "markdown",
    sha256: "a".repeat(64),
    size_bytes: 11,
    source: "replacement_upload" as const,
    version_number: 2,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}
