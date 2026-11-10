import { request as httpRequest } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  DocumentNormalizationError,
  DOCUMENT_NORMALIZER_NAME,
  DOCUMENT_NORMALIZER_VERSION,
  MAX_DOCUMENT_SOURCE_BYTES,
  type DocumentNormalizer,
  WorkerDocumentNormalizer,
} from "../../src/document-normalizer/document-normalizer.js";
import { closeWikiServers, startWikiServer } from "./wiki-server-host.js";

const serviceToken = "normalization-service-token-for-test";

afterEach(async () => {
  await closeWikiServers();
});

describe("document normalization HTTP API", () => {
  it("streams raw source bytes to the normalizer and returns versioned Markdown", async () => {
    const requests: Array<{ mediaType: string; source: Uint8Array }> = [];
    const normalizer: DocumentNormalizer = {
      async normalizeDocument(input) {
        requests.push(input);
        return new TextEncoder().encode("# Normalized\n");
      },
    };
    const httpUrl = await startServer(normalizer);

    const response = await fetch(`${httpUrl}/v0/document-normalizations`, {
      body: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      headers: serviceHeaders("application/pdf"),
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(response.headers.get("x-normalizer-name")).toBe(
      DOCUMENT_NORMALIZER_NAME,
    );
    expect(response.headers.get("x-normalizer-version")).toBe(
      DOCUMENT_NORMALIZER_VERSION,
    );
    await expect(response.text()).resolves.toBe("# Normalized\n");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.mediaType).toBe("application/pdf");
    expect([...new Uint8Array(requests[0]?.source ?? [])]).toEqual([
      0x25, 0x50, 0x44, 0x46,
    ]);
  });

  it("passes the decoded filename and representation format to the normalizer", async () => {
    const requests: Array<{
      filename: string;
      mediaType: string;
      representationFormat?: string;
    }> = [];
    const httpUrl = await startServer({
      async normalizeDocument(input) {
        requests.push(input);
        return new TextEncoder().encode("code\n");
      },
    });
    const url = `${httpUrl}/v0/document-normalizations`;

    const named = await fetch(url, {
      body: new Uint8Array([1]),
      headers: {
        ...serviceHeaders("application/octet-stream"),
        "x-source-filename": encodeURIComponent("Größe plan#1.ts"),
        "x-source-representation-format": "code",
      },
      method: "POST",
    });
    expect(named.status).toBe(200);
    expect(requests).toEqual([
      {
        filename: "Größe plan#1.ts",
        mediaType: "application/octet-stream",
        representationFormat: "code",
        source: expect.any(Uint8Array),
      },
    ]);

    for (const headers of [
      { "x-source-filename": "" } as Record<string, string>,
      { "x-source-filename": "%E5%AD" },
      { "x-source-filename": encodeURIComponent("line\nbreak.ts") },
      { "x-source-filename": encodeURIComponent("a".repeat(256)) },
      { "x-source-representation-format": "f".repeat(121) },
    ]) {
      const invalid = await fetch(url, {
        body: new Uint8Array([1]),
        headers: { ...serviceHeaders("application/octet-stream"), ...headers },
        method: "POST",
      });
      expect(invalid.status).toBe(400);
      await expect(invalid.json()).resolves.toMatchObject({
        error: { code: "DOCUMENT_NORMALIZATION_INVALID" },
      });
    }
    expect(requests).toHaveLength(1);
  });

  it("extracts a generic .ts upload by its filename", async () => {
    const httpUrl = await startServer(new WorkerDocumentNormalizer());
    const request = (headers: Record<string, string>) =>
      fetch(`${httpUrl}/v0/document-normalizations`, {
        body: new TextEncoder().encode("export const rollout = 'kraken';\n"),
        headers: { ...serviceHeaders("application/octet-stream"), ...headers },
        method: "POST",
      });

    const named = await request({
      "x-source-filename": encodeURIComponent("rollout.ts"),
    });
    expect(named.status).toBe(200);
    await expect(named.text()).resolves.toContain(
      "export const rollout = 'kraken';",
    );
    // A name without an extension leaves the generic media type unresolved.
    const bare = await request({
      "x-source-filename": encodeURIComponent("rollout"),
    });
    expect(bare.status).toBe(415);
  });

  it("requires the service token and transport metadata", async () => {
    const httpUrl = await startServer(successNormalizer());
    const url = `${httpUrl}/v0/document-normalizations`;

    const unauthorized = await fetch(url, {
      body: new Uint8Array([1]),
      headers: {
        "content-type": "application/octet-stream",
        "x-source-filename": "a.pdf",
        "x-source-media-type": "application/pdf",
      },
      method: "POST",
    });
    expect(unauthorized.status).toBe(401);

    for (const headers of [
      {
        authorization: `Bearer ${serviceToken}`,
        "content-type": "application/octet-stream",
        "x-source-filename": "a.pdf",
      } as Record<string, string>,
      {
        authorization: `Bearer ${serviceToken}`,
        "content-type": "application/octet-stream",
        "x-source-media-type": "application/pdf",
      },
      {
        authorization: `Bearer ${serviceToken}`,
        "content-type": "application/json",
        "x-source-filename": "a.pdf",
        "x-source-media-type": "application/pdf",
      },
    ]) {
      const invalid = await fetch(url, {
        body: new Uint8Array([1]),
        headers,
        method: "POST",
      });
      expect(invalid.status).toBe(400);
      await expect(invalid.json()).resolves.toMatchObject({
        error: {
          code: "DOCUMENT_NORMALIZATION_INVALID",
          disposition: "terminal",
        },
      });
    }
  });

  it("preserves terminal and retryable normalization dispositions", async () => {
    const errors = [
      new DocumentNormalizationError("DOCUMENT_SOURCE_UNSUPPORTED"),
      new DocumentNormalizationError("DOCUMENT_NORMALIZATION_TIMEOUT"),
      new Error("internal parser detail"),
    ];
    const httpUrl = await startServer({
      async normalizeDocument() {
        throw errors.shift() as Error;
      },
    });
    const url = `${httpUrl}/v0/document-normalizations`;

    const unsupported = await fetch(url, normalizationRequest());
    expect(unsupported.status).toBe(415);
    await expect(unsupported.json()).resolves.toMatchObject({
      error: {
        code: "DOCUMENT_SOURCE_UNSUPPORTED",
        disposition: "terminal",
      },
    });

    const timedOut = await fetch(url, normalizationRequest());
    expect(timedOut.status).toBe(422);
    await expect(timedOut.json()).resolves.toMatchObject({
      error: {
        code: "DOCUMENT_NORMALIZATION_TIMEOUT",
        disposition: "terminal",
      },
    });

    const unavailable = await fetch(url, normalizationRequest());
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({
      error: {
        code: "DOCUMENT_NORMALIZATION_UNAVAILABLE",
        disposition: "retryable",
        message: "Document normalizer is temporarily unavailable",
      },
    });
  });

  it("stops normalizing when the caller goes away", async () => {
    let callerLeft!: () => void;
    const left = new Promise<void>((resolve) => {
      callerLeft = resolve;
    });
    const httpUrl = await startServer({
      async normalizeDocument(_input, signal) {
        signal?.addEventListener("abort", () => callerLeft(), { once: true });
        return await new Promise<Uint8Array>(() => undefined);
      },
    });
    const caller = new AbortController();
    const response = fetch(`${httpUrl}/v0/document-normalizations`, {
      ...normalizationRequest(),
      signal: caller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    caller.abort();

    await expect(response).rejects.toThrow();
    await left;
  });

  it("rejects an announced source larger than 50 MiB before normalization", async () => {
    let calls = 0;
    const httpUrl = await startServer({
      async normalizeDocument() {
        calls += 1;
        return new Uint8Array();
      },
    });

    const response = await requestWithDeclaredLength(
      `${httpUrl}/v0/document-normalizations`,
      MAX_DOCUMENT_SOURCE_BYTES + 1,
    );

    expect(response.status).toBe(413);
    expect(response.body).toContain("DOCUMENT_SOURCE_TOO_LARGE");
    expect(calls).toBe(0);
  });
});

async function startServer(normalizer: DocumentNormalizer): Promise<string> {
  return startWikiServer({ normalizer, serviceToken });
}

function serviceHeaders(mediaType: string): Record<string, string> {
  return {
    authorization: `Bearer ${serviceToken}`,
    "content-type": "application/octet-stream",
    "x-source-filename": "source.pdf",
    "x-source-media-type": mediaType,
  };
}

function normalizationRequest(): RequestInit {
  return {
    body: new Uint8Array([1]),
    headers: serviceHeaders("application/pdf"),
    method: "POST",
  };
}

function successNormalizer(): DocumentNormalizer {
  return {
    async normalizeDocument() {
      return new TextEncoder().encode("normalized\n");
    },
  };
}

async function requestWithDeclaredLength(
  url: string,
  contentLength: number,
): Promise<{ body: string; status: number }> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        headers: {
          ...serviceHeaders("application/pdf"),
          "content-length": String(contentLength),
        },
        method: "POST",
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => {
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            status: response.statusCode ?? 0,
          });
        });
      },
    );
    request.once("error", reject);
    request.end();
  });
}
