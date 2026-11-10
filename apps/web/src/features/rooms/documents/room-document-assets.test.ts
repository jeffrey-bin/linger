import { describe, expect, it, vi } from "vitest";

import { createHttpTeamHubClient } from "@/features/teamhub/teamhub-client";
import {
  teamHubErrorResponse,
  TeamHubTestServer,
  type TestRouteRequest,
} from "@/test/teamhub-test-server";

import {
  createRoomDocumentAssetUrlResolver,
  uploadRoomDocumentAsset,
} from "./room-document-assets";

describe("Room Document Assets", () => {
  it("plans verified bytes before upload and returns only the stable Asset reference", async () => {
    const planned = asset("planned");
    const available = asset("available");
    const planRoomDocumentAsset = vi.fn((_: TestRouteRequest) => planned);
    const uploadRoomDocumentAssetContent = vi.fn(
      (_: TestRouteRequest) => available,
    );
    const { client } = assetServer((server) =>
      server
        .on("POST", "/v0/documents/{documentId}/assets", planRoomDocumentAsset)
        .on(
          "PUT",
          "/v0/document-assets/{documentAssetId}/content",
          uploadRoomDocumentAssetContent,
        ),
    );
    const file = new File(["asset bytes"], "diagram.png", {
      type: "image/png",
    });

    await expect(
      uploadRoomDocumentAsset(client, "document_1", file, "block_1"),
    ).resolves.toBe("document-asset:asset_1");
    expect(planRoomDocumentAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { documentId: "document_1" },
        body: {
          filename: "diagram.png",
          media_type: "image/png",
          sha256:
            "84293ed06cb3210e7d549afec3140d0c48494416ad25b7f25196afffaa5eb796",
          size_bytes: 11,
        },
      }),
    );
    expect(
      planRoomDocumentAsset.mock.calls[0]?.[0].request.headers.get(
        "Idempotency-Key",
      ),
    ).toBe(
      "web:document-asset:7c4cb57a1dec7acfb86f11e9741cd332f61d47539d012a6df85fb60f78ef4ca8",
    );
    expect(uploadRoomDocumentAssetContent).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { documentAssetId: "asset_1" },
        body: "asset bytes",
      }),
    );
    expect(
      uploadRoomDocumentAssetContent.mock.calls[0]?.[0].request.headers.get(
        "Content-Type",
      ),
    ).toBe("application/octet-stream");
  });

  it("uses the complete Asset plan when deriving upload idempotency", async () => {
    const { client, server } = assetServer((server) =>
      server
        .on("POST", "/v0/documents/{documentId}/assets", () => asset("planned"))
        .on("PUT", "/v0/document-assets/{documentAssetId}/content", () =>
          asset("available"),
        ),
    );

    await uploadRoomDocumentAsset(
      client,
      "document_1",
      new File(["asset bytes"], "diagram.png", { type: "image/png" }),
      "block_1",
    );
    await uploadRoomDocumentAsset(
      client,
      "document_1",
      new File(["asset bytes"], "diagram.svg", { type: "image/svg+xml" }),
      "block_1",
    );

    const keys = server
      .requestsTo("POST", "/v0/documents/{documentId}/assets")
      .map((request) => request.headers.get("Idempotency-Key"));
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("rejects an oversized upload before reading bytes", async () => {
    const arrayBuffer = vi.fn();
    const file = {
      arrayBuffer,
      name: "oversized.bin",
      size: (50 << 20) + 1,
      type: "application/octet-stream",
    } as unknown as File;
    const { client, server } = assetServer();

    await expect(
      uploadRoomDocumentAsset(client, "document_1", file),
    ).rejects.toThrow("outside the supported range");
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(server.requests).toHaveLength(0);
  });

  it("identifies the failed upload stage without hiding the server reason", async () => {
    const { client } = assetServer((server) =>
      server.on("POST", "/v0/documents/{documentId}/assets", () =>
        teamHubErrorResponse(
          409,
          "DOCUMENT_ASSET_QUOTA_EXHAUSTED",
          "Tenant Document Asset quota is exhausted.",
        ),
      ),
    );

    await expect(
      uploadRoomDocumentAsset(
        client,
        "document_1",
        new File(["asset bytes"], "diagram.png", { type: "image/png" }),
      ),
    ).rejects.toThrow(
      "Document Asset planning failed: Tenant Document Asset quota is exhausted.",
    );
  });

  it("resolves an internal Asset reference through the authenticated client", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:asset_1");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const { client, server } = assetServer((server) =>
      availableAssetRoutes(
        server,
        () => new Blob(["asset bytes"], { type: "image/png" }),
      ),
    );
    const resolver = createRoomDocumentAssetUrlResolver(client);
    const release = resolver.retain();

    await expect(resolver.resolve("document-asset:asset_1")).resolves.toBe(
      "blob:asset_1",
    );
    await expect(resolver.resolve("document-asset:asset_1")).resolves.toBe(
      "blob:asset_1",
    );
    const downloads = server.requestsTo(
      "GET",
      "/v0/document-assets/{documentAssetId}/content",
    );
    expect(downloads).toHaveLength(1);
    expect(new URL(downloads[0]!.url).pathname).toBe(
      "/v0/document-assets/asset_1/content",
    );
    const content = vi.mocked(URL.createObjectURL).mock.calls[0]?.[0] as Blob;
    expect(content.type).toBe("image/png");
    await expect(content.text()).resolves.toBe("asset bytes");
    release();
    await Promise.resolve();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:asset_1");
  });

  it("primes a verified Asset from the uploaded File without downloading it", async () => {
    const file = new File(["asset bytes"], "diagram.png", {
      type: "image/png",
    });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:stable-asset");
    const revokeObjectURL = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);
    const { client, server } = assetServer();
    const resolver = createRoomDocumentAssetUrlResolver(client);
    const release = resolver.retain();

    expect(resolver.prime("document-asset:asset_1", file)).toBe(true);
    await expect(resolver.resolve("document-asset:asset_1")).resolves.toBe(
      "blob:stable-asset",
    );
    expect(server.requests).toHaveLength(0);

    release();
    await Promise.resolve();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:stable-asset");
  });

  it("survives a same-task release and retain cycle", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:asset_1");
    const revokeObjectURL = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);
    revokeObjectURL.mockClear();
    const { client } = assetServer((server) =>
      availableAssetRoutes(
        server,
        () => new Blob(["asset bytes"], { type: "image/png" }),
      ),
    );
    const resolver = createRoomDocumentAssetUrlResolver(client);
    const releaseInitialMount = resolver.retain();

    releaseInitialMount();
    const releaseRemount = resolver.retain();
    await Promise.resolve();

    await expect(resolver.resolve("document-asset:asset_1")).resolves.toBe(
      "blob:asset_1",
    );
    expect(revokeObjectURL).not.toHaveBeenCalled();

    releaseRemount();
    await Promise.resolve();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:asset_1");
  });

  it("repackages executable document media as an inert object URL", async () => {
    const executable =
      "<script>globalThis.opener.document.body.remove()</script>";
    let objectUrlContent: Blob | undefined;
    vi.spyOn(URL, "createObjectURL").mockImplementation((content) => {
      if (!(content instanceof Blob)) {
        throw new Error("Expected Asset content to be a Blob.");
      }
      objectUrlContent = content;
      return "blob:asset_1";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const { client } = assetServer((server) =>
      server
        .on("GET", "/v0/document-assets/{documentAssetId}", () =>
          asset("available", executable.length),
        )
        .on(
          "GET",
          "/v0/document-assets/{documentAssetId}/content",
          () => new Response(new Blob([executable], { type: "text/html" })),
        ),
    );
    const resolver = createRoomDocumentAssetUrlResolver(client);
    const release = resolver.retain();

    await expect(resolver.resolve("document-asset:asset_1")).resolves.toBe(
      "blob:asset_1",
    );
    expect(objectUrlContent?.type).toBe("application/octet-stream");
    await expect(objectUrlContent?.text()).resolves.toBe(executable);

    release();
    await Promise.resolve();
  });

  it("leaves an empty media placeholder unresolved before upload", async () => {
    const { client, server } = assetServer();
    const resolver = createRoomDocumentAssetUrlResolver(client);

    await expect(resolver.resolve("")).resolves.toBe("");
    expect(server.requests).toHaveLength(0);
  });

  it("rejects before download when the resident byte budget is exhausted", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:asset");
    const { client, server } = assetServer((server) =>
      server
        .on("GET", "/v0/document-assets/{documentAssetId}", ({ params }) => ({
          ...asset("available", 6),
          id: params.documentAssetId,
        }))
        .on(
          "GET",
          "/v0/document-assets/{documentAssetId}/content",
          () => new Response(new Blob(["123456"], { type: "image/png" })),
        ),
    );
    const resolver = createRoomDocumentAssetUrlResolver(client, {
      maxResidentBytes: 10,
    });
    const release = resolver.retain();

    await expect(resolver.resolve("document-asset:asset_1")).resolves.toBe(
      "blob:asset",
    );
    await expect(resolver.resolve("document-asset:asset_2")).rejects.toThrow(
      "resident budget",
    );
    expect(
      server.requestsTo("GET", "/v0/document-assets/{documentAssetId}/content"),
    ).toHaveLength(1);
    release();
    await Promise.resolve();
  });

  it("limits concurrent authenticated Asset downloads", async () => {
    const completions = Array.from({ length: 3 }, deferredResponse);
    const download = vi.fn(
      () => completions[download.mock.calls.length - 1]?.promise,
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:asset");
    const { client, server } = assetServer((server) =>
      server
        .on("GET", "/v0/document-assets/{documentAssetId}", ({ params }) => ({
          ...asset("available", 1),
          id: params.documentAssetId,
        }))
        .on("GET", "/v0/document-assets/{documentAssetId}/content", download),
    );
    const resolver = createRoomDocumentAssetUrlResolver(client, {
      maxConcurrentDownloads: 2,
      maxResidentBytes: 10,
    });
    const release = resolver.retain();
    const resolutions = [1, 2, 3].map((index) =>
      resolver.resolve(`document-asset:asset_${index}`),
    );
    await vi.waitFor(() => {
      expect(
        server.requestsTo("GET", "/v0/document-assets/{documentAssetId}"),
      ).toHaveLength(3);
      expect(download).toHaveBeenCalledTimes(2);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(download).toHaveBeenCalledTimes(2);

    completions[0]!.resolve(
      new Response(new Blob(["1"], { type: "image/png" })),
    );
    await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(3));
    completions[1]!.resolve(
      new Response(new Blob(["2"], { type: "image/png" })),
    );
    completions[2]!.resolve(
      new Response(new Blob(["3"], { type: "image/png" })),
    );
    await Promise.all(resolutions);
    release();
    await Promise.resolve();
  });
});

function assetServer(
  routes: (server: TeamHubTestServer) => TeamHubTestServer = (server) => server,
) {
  const server = routes(new TeamHubTestServer());
  const client = createHttpTeamHubClient({
    fetchRequest: server.fetch,
    onAuthenticationRequired: () => undefined,
  });
  return { client, server };
}

function availableAssetRoutes(server: TeamHubTestServer, content: () => Blob) {
  return server
    .on("GET", "/v0/document-assets/{documentAssetId}", () =>
      asset("available"),
    )
    .on(
      "GET",
      "/v0/document-assets/{documentAssetId}/content",
      () => new Response(content()),
    );
}

function asset(status: "available" | "planned", sizeBytes = 11) {
  return {
    created_at: "2026-07-31T00:00:00Z",
    document_id: "document_1",
    filename: "diagram.png",
    id: "asset_1",
    media_type: "image/png",
    sha256: "84293ed06cb3210e7d549afec3140d0c48494416ad25b7f25196afffaa5eb796",
    size_bytes: sizeBytes,
    status,
    updated_at: "2026-07-31T00:00:00Z",
  };
}

function deferredResponse() {
  let resolve!: (value: Response) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Response>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
