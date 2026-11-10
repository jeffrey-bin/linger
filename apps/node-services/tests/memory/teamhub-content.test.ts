import { describe, expect, it, vi } from "vitest";

import {
  fetchTeamHubDocumentVersionContent,
  teamHubContentAccess,
} from "../../src/memory/teamhub-content.js";
import { serviceCredential } from "@linger/service-kit/node";

const seed = "test-seed-0123456789abcdef0123456789";

describe("TeamHub content access", () => {
  it("bounds streamed bytes even when Content-Length is absent or incorrect", async () => {
    const canceled = vi.fn();
    const access = {
      baseUrl: "http://teamhub",
      token: "test",
      fetch: vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(6));
              },
              cancel: canceled,
            }),
            { headers: { "Content-Length": "1" } },
          ),
      ),
    };
    await expect(
      fetchTeamHubDocumentVersionContent(access, "tenant", "version", 5),
    ).rejects.toThrow("byte limit");
    expect(canceled).toHaveBeenCalled();
  });
  it("requires the Memory token and defaults TeamHub to the single-host address", () => {
    expect(() => teamHubContentAccess({})).toThrow(
      "LINGER_SECRET_SEED is required",
    );
    expect(teamHubContentAccess({ LINGER_SECRET_SEED: seed }).baseUrl).toBe(
      "http://127.0.0.1:8080",
    );
  });

  it("reads tenant-scoped content through the generated callback client", async () => {
    let request: Request | undefined;
    const content = new TextEncoder().encode("# from TeamHub");
    const access = teamHubContentAccess({
      TEAMHUB_BASE_URL: "https://teamhub.example/base?ignored=1",
      LINGER_SECRET_SEED: seed,
    });
    access.fetch = vi.fn(async (input, init) => {
      request = new Request(input, init);
      return new Response(content, { status: 200 });
    });

    await expect(
      fetchTeamHubDocumentVersionContent(access, "tenant/one", "version/two"),
    ).resolves.toEqual(content);
    expect(request?.url).toBe(
      "https://teamhub.example/base/v0/memory/fetch_session/tenants/tenant%2Fone/document-versions/version%2Ftwo",
    );
    expect(request?.headers.get("authorization")).toBe(
      `Bearer ${serviceCredential("teamhub-internal", { LINGER_SECRET_SEED: seed })}`,
    );
  });

  it("surfaces non-success responses without falling back to local paths", async () => {
    const access = teamHubContentAccess({
      TEAMHUB_BASE_URL: "http://teamhub",
      LINGER_SECRET_SEED: seed,
    });
    access.fetch = vi.fn(async () => new Response(null, { status: 404 }));

    await expect(
      fetchTeamHubDocumentVersionContent(access, "tenant", "version"),
    ).rejects.toThrow("TeamHub content read failed with HTTP 404");
  });
});
