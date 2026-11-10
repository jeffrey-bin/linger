import { fetchDouble, sentRequests } from "./teamhub-client-test-support";
import { expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { createHttpTeamHubClient } from "./teamhub-client";
import { requestBodyText, requestUrlText } from "@linger/service-kit";

it("starts content and access reads together and cancels content when access fails", async () => {
  let denyAccess!: (response: Response) => void;
  let contentSignal: AbortSignal | undefined;
  const fetchRequest = vi.fn<typeof fetch>().mockImplementation(
    fetchDouble((url, init) => {
      if (url.endsWith("/resolve"))
        return new Promise((resolve) => {
          denyAccess = resolve;
        });
      contentSignal = init.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        contentSignal?.addEventListener(
          "abort",
          () => reject(contentSignal?.reason),
          { once: true },
        );
      });
    }),
  );
  const client = createHttpTeamHubClient({
    baseUrl: "https://web.test/",
    fetchRequest,
  });
  const pending = client.documentLinks.download(`doc_link_${"a".repeat(43)}`);
  const rejected = expect(pending).rejects.toMatchObject({ status: 404 });
  const startedTogether = (await sentRequests(fetchRequest)).length === 2;
  denyAccess(
    Response.json(
      { error: { code: "NOT_FOUND", message: "Link unavailable" } },
      { status: 404 },
    ),
  );
  await rejected;
  expect(startedTogether).toBe(true);
  expect(contentSignal?.aborted).toBe(true);
});

it("reads a link through POST bodies, verifies content, and rejects revoked access", async () => {
  const token = `doc_link_${"a".repeat(43)}`;
  const content = new TextEncoder().encode("shared content");
  const fetchRequest = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({
        link_id: "link-1",
        document_id: "doc-1",
        tenant_id: "tenant-1",
        role: "editor",
        version: 1,
      }),
    )
    .mockResolvedValueOnce(
      new Response(content, {
        headers: {
          "Content-Type": "text/plain",
          "X-Document-Id": "doc-1",
          "X-Document-Version-Id": "version-1",
          "X-Document-Filename": btoa("shared.txt"),
          "X-Document-Representation-Format": "plain_text",
          "X-Document-Read-Only": "false",
          "X-Content-Sha256": bytesToHex(sha256(content)),
        },
      }),
    )
    .mockResolvedValue(
      Response.json(
        { error: { code: "NOT_FOUND", message: "Link unavailable" } },
        { status: 404 },
      ),
    );
  const client = createHttpTeamHubClient({
    baseUrl: "https://web.test/",
    fetchRequest,
  });
  const result = await client.documentLinks.download(token);
  expect(fetchRequest.mock.contexts).toEqual([undefined, undefined]);
  expect(result).toMatchObject({
    documentId: "doc-1",
    versionId: "version-1",
    filename: "shared.txt",
    readOnly: false,
    access: { role: "editor" },
  });
  for (const [url, init] of await sentRequests(fetchRequest)) {
    expect(requestUrlText(url)).not.toContain(token);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(requestBodyText(init?.body))).toEqual({ token });
  }
  expect(requestUrlText((await sentRequests(fetchRequest))[1]?.[0])).toBe(
    "https://web.test/v0/shared-documents/content",
  );
  await expect(client.documentLinks.download(token)).rejects.toMatchObject({
    status: 404,
  });
});

it("manages link policies with explicit versions and treats missing policy as disabled", async () => {
  const fetchRequest = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json(
        { error: { code: "NOT_FOUND", message: "Not found" } },
        { status: 404 },
      ),
    )
    .mockResolvedValueOnce(
      Response.json({
        id: "link-1",
        document_id: "doc-1",
        role: "viewer",
        status: "active",
        version: 1,
      }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  const client = createHttpTeamHubClient({
    baseUrl: "https://web.test/",
    fetchRequest,
  });
  expect(await client.documentLinks.get("doc-1")).toBeNull();
  await client.documentLinks.set("doc-1", {
    role: "viewer",
    expected_version: 0,
    reset: false,
  });
  await client.documentLinks.revoke("doc-1", { expected_version: 1 });
  expect(
    (await sentRequests(fetchRequest)).map(([, init]) => init?.method),
  ).toEqual(["GET", "PUT", "DELETE"]);
});
