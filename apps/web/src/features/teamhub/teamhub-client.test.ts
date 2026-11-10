import { sentRequests } from "./teamhub-client-test-support";
import { describe, expect, it, vi } from "vitest";

import { FakeXmlHttpRequest } from "./teamhub-client-test-support";
import { teamHubData, teamHubDone } from "./teamhub-api";
import {
  createHttpTeamHubClient,
  TeamHubTransportError,
} from "./teamhub-client";
import { requestUrlText } from "@linger/service-kit";

describe("TeamHubClient", () => {
  it("changes the current Account password without treating a wrong password as logout", async () => {
    const onAuthenticationRequired = vi.fn();
    const fetchRequest = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: "INVALID_CURRENT_PASSWORD",
              message: "Current password is incorrect.",
            },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = createHttpTeamHubClient({
      baseUrl: "https://teamhub.example.test",
      fetchRequest,
      onAuthenticationRequired,
    });
    const input = {
      current_password: "old-password",
      new_password: "new-password",
    };
    const changePassword = () =>
      teamHubDone(client.api.POST("/v0/account/password", { body: input }));
    await expect(changePassword()).rejects.toMatchObject({
      code: "INVALID_CURRENT_PASSWORD",
    });
    expect(onAuthenticationRequired).not.toHaveBeenCalled();
    await expect(changePassword()).resolves.toBeUndefined();
    const [url, init] = (await sentRequests(fetchRequest))[1]!;
    expect(requestUrlText(url)).toBe(
      "https://teamhub.example.test/v0/account/password",
    );
    expect(init).toMatchObject({
      method: "POST",
      credentials: "include",
      body: JSON.stringify(input),
    });
  });

  it("looks up Runtime presentation Runs associated with loaded Messages", async () => {
    const result = { items: [] };
    const fetchRequest = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(result));
    const client = createHttpTeamHubClient({
      baseUrl: "https://teamhub.example.test/",
      fetchRequest,
    });

    await expect(
      client.listRoomRuntimePresentationRuns("room/a", [
        "message/2",
        "message/1",
      ]),
    ).resolves.toEqual(result);

    const [request, init] = (await sentRequests(fetchRequest))[0] ?? [];
    expect(requestUrlText(request)).toBe(
      "https://teamhub.example.test/v0/rooms/room%2Fa/runtime-presentation-runs?message_id=message%2F2&message_id=message%2F1",
    );
    expect(init).toMatchObject({ credentials: "include", method: "GET" });
  });

  it("classifies a fetch rejection as a retryable transport boundary", async () => {
    const fetchRequest = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("network unavailable"));
    const client = createHttpTeamHubClient({ fetchRequest });

    await expect(
      teamHubData(
        client.api.GET(
          "/v0/rooms/{roomId}/runs/{runId}/runtime-presentation-events",
          {
            params: {
              path: { roomId: "room-1", runId: "draft-1" },
              query: { after: "0", limit: 200 },
            },
          },
        ),
      ),
    ).rejects.toBeInstanceOf(TeamHubTransportError);
  });

  it("owns credentialed request construction and opaque pagination", async () => {
    const fetchRequest = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        items: [],
        page: { has_more: false },
      }),
    );
    const client = createHttpTeamHubClient({
      baseUrl: "https://teamhub.example.test/",
      fetchRequest,
    });

    await teamHubData(
      client.api.GET("/v0/tenants/{tenantId}/rooms", {
        params: {
          path: { tenantId: "tenant-a" },
          query: { cursor: "opaque cursor", limit: 50 },
        },
      }),
    );

    expect(fetchRequest).toHaveBeenCalledOnce();
    const [request, init] = (await sentRequests(fetchRequest))[0] ?? [];

    expect(requestUrlText(request)).toBe(
      "https://teamhub.example.test/v0/tenants/tenant-a/rooms?cursor=opaque%20cursor&limit=50",
    );
    expect(init).toMatchObject({
      credentials: "include",
      method: "GET",
    });
  });

  it("appends an ordinary Document Version through TeamHub", async () => {
    const request = new FakeXmlHttpRequest();
    const client = createHttpTeamHubClient({
      baseUrl: "https://teamhub.example.test",
      xhrFactory: () => request as unknown as XMLHttpRequest,
    });
    const upload = client.uploadDocumentVersion(
      "document-1",
      {
        expectedCurrentVersionId: "version-1",
        file: new File(["second revision"], "context.txt", {
          type: "text/plain",
        }),
        representationFormat: "plain_text",
      },
      "web-upload-version-12345678",
    );

    request.complete(201, {
      ...documentVersionFixture(),
      id: "version-2",
      version_number: 2,
    });

    await expect(upload).resolves.toMatchObject({
      id: "version-2",
      version_number: 2,
    });
    expect(request.method).toBe("POST");
    expect(request.url).toBe(
      "https://teamhub.example.test/v0/documents/document-1/versions",
    );
    expect(request.withCredentials).toBe(true);
    expect(request.headers.get("Idempotency-Key")).toBe(
      "web-upload-version-12345678",
    );
    expect(request.body).toBeInstanceOf(FormData);
    expect((request.body as FormData).get("filename")).toBe("context.txt");
  });

  it("lists the current Human's ready Local computers", async () => {
    const inventory = {
      items: [
        {
          available_capacity: 1,
          capacity: 2,
          display_name: "Build Mac",
          computer_id: "computer-build-mac",
          runtimes: [
            {
              models: [{ id: "openai/gpt-5.4", label: "GPT-5.4" }],
              type: "codex" as const,
            },
          ],
          status: "online" as const,
          workspace_grants: [
            {
              grant_id: "grant-workspace",
              label: "Linger Workspace",
              mode: "workspace-write" as const,
            },
          ],
        },
      ],
    };
    const fetchRequest = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        ...inventory,
        items: inventory.items.map((computer) => ({
          ...computer,
          runtimes: [{ type: "hermes", protocol: "acp" }, ...computer.runtimes],
        })),
      }),
    );
    const client = createHttpTeamHubClient({
      baseUrl: "https://teamhub.example.test",
      fetchRequest,
    });

    await expect(client.listTenantLocalComputers("tenant/a")).resolves.toEqual(
      inventory,
    );
    const [request, init] = (await sentRequests(fetchRequest))[0] ?? [];
    expect(requestUrlText(request)).toBe(
      "https://teamhub.example.test/v0/tenants/tenant%2Fa/local-computers",
    );
    expect(init).toMatchObject({ credentials: "include", method: "GET" });
  });

  it("reports expired authentication from authenticated 401 responses", async () => {
    const onAuthenticationRequired = vi.fn();
    const fetchRequest = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: "UNAUTHENTICATED",
            message: "Signed in elsewhere.",
            request_id: "request-1",
            retryable: false,
          },
        },
        401,
      ),
    );
    const client = createHttpTeamHubClient({
      fetchRequest,
      onAuthenticationRequired,
    });

    await expect(teamHubData(client.api.GET("/v0/me"))).rejects.toEqual(
      expect.objectContaining({
        code: "UNAUTHENTICATED",
        message: "Signed in elsewhere.",
        requestId: "request-1",
        status: 401,
      }),
    );
    expect(onAuthenticationRequired).toHaveBeenCalledWith("session-expired");
  });

  it("does not recursively report authentication failure from a Session probe", async () => {
    const onAuthenticationRequired = vi.fn();
    const fetchRequest = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: "UNAUTHENTICATED",
            message: "Session is missing.",
            request_id: "request-session-probe",
          },
        },
        401,
      ),
    );
    const client = createHttpTeamHubClient({
      fetchRequest,
      onAuthenticationRequired,
    });

    await expect(teamHubData(client.api.GET("/v0/session"))).rejects.toEqual(
      expect.objectContaining({
        code: "UNAUTHENTICATED",
        status: 401,
      }),
    );
    expect(onAuthenticationRequired).not.toHaveBeenCalled();
  });

  it("reports a 401 before falling back from a malformed TeamHub error body", async () => {
    const onAuthenticationRequired = vi.fn();
    const fetchRequest = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({}, 401));
    const client = createHttpTeamHubClient({
      fetchRequest,
      onAuthenticationRequired,
    });

    await expect(teamHubData(client.api.GET("/v0/me"))).rejects.toEqual(
      expect.objectContaining({
        code: "HTTP_401",
        status: 401,
      }),
    );
    expect(onAuthenticationRequired).toHaveBeenCalledWith("session-expired");
  });

  it("reports real multipart upload progress through the TeamHub boundary", async () => {
    const request = new FakeXmlHttpRequest();
    const progress = vi.fn();
    const client = createHttpTeamHubClient({
      baseUrl: "https://teamhub.example.test",
      xhrFactory: () => request as unknown as XMLHttpRequest,
    });
    const upload = client.uploadPersonalWikiDocument(
      "tenant-1",
      {
        file: new File(["room context"], "context.txt", {
          type: "text/plain",
        }),
        representationFormat: "plain_text",
      },
      "web-upload-12345678",
      { onProgress: progress },
    );

    request.reportProgress(6, 12);
    request.complete(201, unifiedDocumentFixture());

    await expect(upload).resolves.toMatchObject({ id: "document-1" });
    expect(request.method).toBe("POST");
    expect(request.url).toBe(
      "https://teamhub.example.test/v0/tenants/tenant-1/personal-wiki/documents/uploads",
    );
    expect(request.withCredentials).toBe(true);
    expect(request.headers.get("Idempotency-Key")).toBe("web-upload-12345678");
    expect(request.body).toBeInstanceOf(FormData);
    expect(progress.mock.calls.map(([value]) => value)).toEqual([0, 0.5, 1]);
  });

  it("stages a Room Message attachment through its dedicated endpoint", async () => {
    const request = new FakeXmlHttpRequest();
    const client = createHttpTeamHubClient({
      baseUrl: "https://teamhub.example.test",
      xhrFactory: () => request as unknown as XMLHttpRequest,
    });
    const upload = client.uploadMessageAttachment(
      "room-1",
      new File(["a"], "a.txt", { type: "text/plain" }),
      "message-upload-12345678",
    );
    request.complete(201, {
      created_at: "2026-08-03T10:00:00Z",
      expires_at: "2026-08-04T10:00:00Z",
      filename: "a.txt",
      id: "attachment-upload-1",
      media_type: "text/plain",
      room_id: "room-1",
      sha256: "a".repeat(64),
      size_bytes: 1,
      status: "available",
    });

    await expect(upload).resolves.toMatchObject({ id: "attachment-upload-1" });
    expect(request.url).toBe(
      "https://teamhub.example.test/v0/rooms/room-1/message-attachment-uploads",
    );
  });

  it("binds multipart upload cancellation and timeout to the request", async () => {
    const request = new FakeXmlHttpRequest();
    const controller = new AbortController();
    const client = createHttpTeamHubClient({
      baseUrl: "https://teamhub.example.test",
      xhrFactory: () => request as unknown as XMLHttpRequest,
    });
    const upload = client.uploadPersonalWikiDocument(
      "tenant-1",
      {
        file: new File(["room context"], "context.txt", {
          type: "text/plain",
        }),
        representationFormat: "plain_text",
      },
      "web-upload-cancel",
      { signal: controller.signal, timeoutMs: 1_234 },
    );

    expect(request.timeout).toBe(1_234);
    controller.abort();

    await expect(upload).rejects.toMatchObject({ name: "AbortError" });
    expect(request.aborted).toBe(true);
  });

  it("reports a bounded multipart upload timeout", async () => {
    const request = new FakeXmlHttpRequest();
    const client = createHttpTeamHubClient({
      baseUrl: "https://teamhub.example.test",
      xhrFactory: () => request as unknown as XMLHttpRequest,
    });
    const upload = client.uploadPersonalWikiDocument(
      "tenant-1",
      {
        file: new File(["room context"], "context.txt", {
          type: "text/plain",
        }),
        representationFormat: "plain_text",
      },
      "web-upload-timeout",
    );

    request.timeOut();

    await expect(upload).rejects.toThrow(/timed out/);
    expect(request.timeout).toBe(10 * 60 * 1_000);
  });

  it("removes cancellation listeners after a synchronous send failure", async () => {
    const request = new FakeXmlHttpRequest();
    const controller = new AbortController();
    request.sendError = new Error("Browser rejected the upload body.");
    const client = createHttpTeamHubClient({
      baseUrl: "https://teamhub.example.test",
      xhrFactory: () => request as unknown as XMLHttpRequest,
    });

    await expect(
      client.uploadPersonalWikiDocument(
        "tenant-1",
        {
          file: new File(["room context"], "context.txt", {
            type: "text/plain",
          }),
          representationFormat: "plain_text",
        },
        "web-upload-send-error",
        { signal: controller.signal },
      ),
    ).rejects.toThrow(/Browser rejected/);

    controller.abort();
    expect(request.aborted).toBe(false);
  });

  it("uploads an ordinary file as a unified Document with explicit representation format", async () => {
    const request = new FakeXmlHttpRequest();
    const progress = vi.fn();
    const document = {
      ...unifiedDocumentFixture(),
      current_version: {
        id: "document-version-1",
        sha256: "a".repeat(64),
        version_number: 1,
      },
      draft_capability: "none" as const,
      format: "markdown",
      title: "context.md",
    };
    const client = createHttpTeamHubClient({
      baseUrl: "https://teamhub.example.test",
      xhrFactory: () => request as unknown as XMLHttpRequest,
    });
    const upload = client.uploadPersonalWikiDocument(
      "tenant-northstar",
      {
        file: new File(["# Context"], "context.md", {
          type: "text/markdown",
        }),
        parentId: "folder/a",
        representationFormat: "markdown",
      },
      "web-upload-document-12345678",
      { onProgress: progress },
    );

    request.reportProgress(5, 10);
    request.complete(201, document);

    await expect(upload).resolves.toEqual(document);
    expect(request.method).toBe("POST");
    expect(request.url).toBe(
      "https://teamhub.example.test/v0/tenants/tenant-northstar/personal-wiki/documents/uploads",
    );
    expect(request.withCredentials).toBe(true);
    expect(request.headers.get("Idempotency-Key")).toBe(
      "web-upload-document-12345678",
    );
    expect(request.body).toBeInstanceOf(FormData);
    const form = request.body as FormData;
    expect(form.get("filename")).toBe("context.md");
    expect(form.get("representation_format")).toBe("markdown");
    expect(form.get("media_type")).toBe("text/markdown");
    expect(form.get("content")).toBeInstanceOf(File);
    expect(form.get("parent_id")).toBe("folder/a");
    expect(progress.mock.calls.map(([value]) => value)).toEqual([0, 0.5, 1]);
  });

  it("uploads an ordinary file replacement with expected current Version", async () => {
    const request = new FakeXmlHttpRequest();
    const version = {
      base_version_id: "document-version-1",
      created_at: "2026-08-21T09:00:00Z",
      created_by: unifiedDocumentFixture().creator,
      document_id: "document/a",
      filename: "context-v2.md",
      id: "document-version-2",
      media_type: "text/markdown",
      representation_format: "markdown",
      sha256: "b".repeat(64),
      size_bytes: 12,
      source: "replacement_upload" as const,
      version_number: 2,
    };
    const client = createHttpTeamHubClient({
      baseUrl: "https://teamhub.example.test",
      xhrFactory: () => request as unknown as XMLHttpRequest,
    });
    const upload = client.uploadDocumentVersion(
      "document/a",
      {
        expectedCurrentVersionId: "document-version-1",
        file: new File(["# Context v2"], "context-v2.md", {
          type: "text/markdown",
        }),
        representationFormat: "markdown",
      },
      "web-upload-document-version-12345678",
    );

    request.complete(201, version);

    await expect(upload).resolves.toEqual(version);
    expect(request.method).toBe("POST");
    expect(request.url).toBe(
      "https://teamhub.example.test/v0/documents/document%2Fa/versions",
    );
    expect(request.headers.get("Idempotency-Key")).toBe(
      "web-upload-document-version-12345678",
    );
    const form = request.body as FormData;
    expect(form.get("expected_current_version_id")).toBe("document-version-1");
    expect(form.get("representation_format")).toBe("markdown");
    expect(form.get("filename")).toBe("context-v2.md");
    expect(form.get("content")).toBeInstanceOf(File);
  });

  it("downloads the server-resolved latest Document Content Head", async () => {
    const digest =
      "5e1e2bcac305958b27077ca136f35f0abae7cf38c9af678f7d220ed0cb51d4f8";
    const fetchRequest = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response("latest", {
        headers: {
          "Content-Length": "6",
          "Content-Type": "text/markdown",
          ETag: `"${digest}"`,
        },
        status: 200,
      }),
    );
    const client = createHttpTeamHubClient({
      baseUrl: "https://teamhub.example.test/",
      fetchRequest,
    });

    await expect(
      client.downloadLatestDocument("document/a"),
    ).resolves.toMatchObject({ mediaType: "text/markdown", sha256: digest });

    const [requestURL, requestInit] =
      (await sentRequests(fetchRequest))[0] ?? [];
    expect(requestUrlText(requestURL)).toBe(
      "https://teamhub.example.test/v0/documents/document%2Fa/downloads",
    );
    expect(requestInit?.method).toBe("GET");
    expect(requestInit?.body).toBeUndefined();
    expect(new Headers(requestInit?.headers).get("Idempotency-Key")).toBeNull();
  });

  it("retries a pending native latest projection as the same resource", async () => {
    const digest =
      "5e1e2bcac305958b27077ca136f35f0abae7cf38c9af678f7d220ed0cb51d4f8";
    const fetchRequest = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, { headers: { "Retry-After": "0" }, status: 202 }),
      )
      .mockResolvedValueOnce(
        new Response("latest", {
          headers: {
            "Content-Length": "6",
            "Content-Type": "text/markdown",
            ETag: `"${digest}"`,
          },
          status: 200,
        }),
      );
    const client = createHttpTeamHubClient({
      baseUrl: "https://teamhub.example.test/",
      fetchRequest,
    });

    await expect(
      client.downloadLatestDocument("document/a"),
    ).resolves.toMatchObject({ sha256: digest });
    expect(fetchRequest).toHaveBeenCalledTimes(2);
    expect(
      (await sentRequests(fetchRequest)).map(([, init]) => init?.method),
    ).toEqual(["GET", "GET"]);
  });

  it("downloads one exact unified Document Version", async () => {
    const bytes = new TextEncoder().encode("stable bytes");
    const version = {
      created_at: "2026-08-21T09:00:00Z",
      created_by: unifiedDocumentFixture().creator,
      document_id: "document/a",
      filename: "context.md",
      id: "document/version-1",
      media_type: "text/markdown",
      representation_format: "markdown",
      sha256:
        "3821461753e58afa7abe81ccec8ea5ac178ea27ee92ede53771a95a101928e40",
      size_bytes: bytes.byteLength,
      source: "ordinary_upload" as const,
      version_number: 1,
    };
    const fetchRequest = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(bytes, {
        headers: {
          "content-length": String(bytes.byteLength),
          "content-type": "text/markdown",
        },
      }),
    );
    const client = createHttpTeamHubClient({
      baseUrl: "https://teamhub.example.test",
      fetchRequest,
    });

    const content = await client.downloadDocumentVersion(version.id, {
      expectedSizeBytes: version.size_bytes,
    });

    expect(content.mediaType).toBe("text/markdown");
    expect(content.sha256).toBe(version.sha256);
    expect(
      (await sentRequests(fetchRequest)).map(([request]) =>
        requestUrlText(request),
      ),
    ).toEqual([
      "https://teamhub.example.test/v0/document-versions/document%2Fversion-1/content",
    ]);
    expect((await sentRequests(fetchRequest))[0]?.[1]).toMatchObject({
      credentials: "include",
      method: "GET",
    });
  });
});

function documentVersionFixture() {
  return {
    created_at: "2026-08-21T09:00:00Z",
    created_by: unifiedDocumentFixture().creator,
    document_id: "document-1",
    filename: "context.txt",
    id: "version-1",
    media_type: "text/plain",
    representation_format: "plain_text",
    sha256: "a".repeat(64),
    size_bytes: 12,
    source: "ordinary_upload" as const,
    version_number: 1,
  };
}

function unifiedDocumentFixture() {
  return {
    capabilities: {
      comment: true,
      delete: true,
      duplicate: true,
      export: true,
      manage: true,
      read: true,
      use_as_context: true,
      write: true,
    },
    created_at: "2026-08-21T08:00:00Z",
    creator: {
      display_name: "Jenny",
      id: "actor-human",
      kind: "human",
      tenant_id: "tenant-a",
    },
    current_version: null,
    draft_capability: "write",
    format: "blocknote",
    from: [],
    id: "document-1",
    owner: {
      display_name: "Jenny",
      id: "actor-human",
      kind: "human",
      tenant_id: "tenant-a",
    },
    status: "active",
    tenant_id: "tenant-a",
    title: "Untitled",
    updated_at: "2026-08-21T08:00:00Z",
  };
}

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });
}
