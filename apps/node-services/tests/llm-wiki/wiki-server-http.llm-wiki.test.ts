import { request as httpRequest } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  DocumentNormalizationError,
  MAX_DOCUMENT_SOURCE_BYTES,
} from "../../src/document-normalizer/document-normalizer.js";
import {
  WikiRefreshCandidateError,
  type WikiRefreshCandidateService,
} from "../../src/llm-wiki/wiki-refresh-candidates.js";
import { closeWikiServers, startWikiServer } from "./wiki-server-host.js";

const serviceToken = "wiki-http-token";
const candidatePath = "/internal/v1/wiki-refreshes/refresh-a/candidates";
const unauthorizedBody =
  '{"error":{"code":"SERVICE_TOKEN_INVALID","message":"Service token is invalid"}}';
const methodNotAllowedBody =
  '{"error":{"code":"METHOD_NOT_ALLOWED","message":"Method not allowed"}}';

afterEach(async () => {
  await closeWikiServers();
});

async function start(
  candidateService?: WikiRefreshCandidateService,
): Promise<string> {
  return startWikiServer({
    ...(candidateService ? { candidateService } : {}),
    normalizer: {
      async normalizeDocument() {
        throw new DocumentNormalizationError("DOCUMENT_SOURCE_UNSUPPORTED");
      },
    },
    serviceToken,
  });
}

function candidateService(
  generate: WikiRefreshCandidateService["generate"],
): WikiRefreshCandidateService {
  return { generate } as unknown as WikiRefreshCandidateService;
}

const jsonHeaders = {
  authorization: `Bearer ${serviceToken}`,
  "content-type": "application/json",
};

describe("WikiServer HTTP surface", () => {
  it("serves unauthenticated health and readiness", async () => {
    const url = await start();
    for (const route of ["/healthz", "/readyz"]) {
      const response = await fetch(`${url}${route}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");
      await expect(response.text()).resolves.toBe('{"status":"ok"}');
    }
  });

  it("answers unknown paths and bad ids with an empty 404", async () => {
    const url = await start();
    for (const [method, route] of [
      ["GET", "/nope"],
      ["POST", "/internal/v1/wiki-refreshes/-bad/candidates"],
      ["POST", `/internal/v1/wiki-refreshes/${"a".repeat(65)}/candidates`],
      ["POST", "/internal/v1/wiki-refreshes/refresh-a/other"],
      ["POST", "/v0/document-normalizations/extra"],
    ] as const) {
      const response = await fetch(`${url}${route}`, {
        headers: jsonHeaders,
        method,
      });
      expect(`${method} ${route} ${response.status}`).toBe(
        `${method} ${route} 404`,
      );
      await expect(response.text()).resolves.toBe("");
    }
  });

  it("authenticates before checking the method on both operations", async () => {
    const url = await start();
    for (const route of ["/v0/document-normalizations", candidatePath]) {
      for (const headers of [
        undefined,
        { authorization: "Bearer wrong" },
        { authorization: `Bearer ${serviceToken}x` },
      ]) {
        for (const method of ["GET", "POST", "PUT"]) {
          const response = await fetch(`${url}${route}`, {
            body: method === "GET" ? undefined : "{}",
            headers,
            method,
          });
          expect(response.status).toBe(401);
          expect(response.headers.get("content-type")).toBe("application/json");
          await expect(response.text()).resolves.toBe(unauthorizedBody);
        }
      }
      for (const method of ["GET", "PUT", "DELETE"]) {
        const response = await fetch(`${url}${route}`, {
          headers: jsonHeaders,
          method,
        });
        expect(response.status).toBe(405);
        expect(response.headers.get("content-type")).toBe("application/json");
        await expect(response.text()).resolves.toBe(methodNotAllowedBody);
      }
    }
  });

  it("returns the candidate result and passes the parsed body to the service", async () => {
    const calls: Array<{ body: unknown; id: string }> = [];
    const url = await start(
      candidateService(async (id, body) => {
        calls.push({ body, id });
        return { pages: [{ path: "a.md" }] } as never;
      }),
    );
    const response = await fetch(`${url}${candidatePath}`, {
      body: '{"x":1}',
      headers: {
        authorization: `Bearer ${serviceToken}`,
        "content-type": "Application/JSON; charset=utf-8",
      },
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    await expect(response.text()).resolves.toBe('{"pages":[{"path":"a.md"}]}');
    expect(calls).toEqual([{ body: { x: 1 }, id: "refresh-a" }]);
  });

  it("reads the whole candidate body before a preview stream answers", async () => {
    // TeamHub stops uploading once response headers arrive, so a preview
    // stream that answered early would cut off a large request.
    const calls: unknown[] = [];
    const url = await start(
      candidateService(async (_id, body) => {
        calls.push(body);
        return { pages: [] } as never;
      }),
    );
    const body = JSON.stringify({ sources: "x".repeat(256 * 1024) });
    const half = Math.floor(body.length / 2);
    let lastPartSent = false;
    const answer = await new Promise<{
      answeredEarly: boolean;
      contentType: string;
      text: string;
    }>((resolve, reject) => {
      const request = httpRequest(
        `${url}${candidatePath}`,
        {
          headers: {
            ...jsonHeaders,
            accept: "application/x-ndjson",
            "content-length": String(Buffer.byteLength(body)),
          },
          method: "POST",
        },
        (response) => {
          const answeredEarly = !lastPartSent;
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => (text += chunk));
          response.once("end", () =>
            resolve({
              answeredEarly,
              contentType: response.headers["content-type"] ?? "",
              text,
            }),
          );
        },
      );
      request.once("error", reject);
      request.write(body.slice(0, half));
      setTimeout(() => {
        lastPartSent = true;
        request.end(body.slice(half));
      }, 200);
    });
    expect(answer.answeredEarly).toBe(false);
    expect(answer.contentType).toBe("application/x-ndjson");
    expect(JSON.parse(answer.text.trim())).toEqual({
      kind: "final",
      status: 200,
      body: { pages: [] },
    });
    expect(calls).toEqual([JSON.parse(body)]);
  });

  it("answers an unreadable preview request as a plain JSON error", async () => {
    const url = await start(
      candidateService(async () => {
        throw new Error("must not generate");
      }),
    );
    const response = await fetch(`${url}${candidatePath}`, {
      body: "{",
      headers: { ...jsonHeaders, accept: "application/x-ndjson" },
      method: "POST",
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("application/json");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "WIKI_REFRESH_CANDIDATE_REQUEST_INVALID" },
    });
  });

  it("rejects invalid candidate transport and JSON as terminal request errors", async () => {
    let calls = 0;
    const url = await start(
      candidateService(async () => {
        calls += 1;
        return { pages: [] } as never;
      }),
    );
    const invalid =
      '{"error":{"code":"WIKI_REFRESH_CANDIDATE_REQUEST_INVALID","disposition":"terminal","message":"Wiki refresh candidate request is invalid"}}';
    for (const [headers, body] of [
      [{ ...jsonHeaders, "content-type": "text/plain" }, "{}"],
      [{ authorization: `Bearer ${serviceToken}` }, "{}"],
      [jsonHeaders, "{"],
      [jsonHeaders, ""],
    ] as const) {
      const response = await fetch(`${url}${candidatePath}`, {
        body,
        headers,
        method: "POST",
      });
      expect(response.status).toBe(400);
      await expect(response.text()).resolves.toBe(invalid);
    }
    expect(calls).toBe(0);
  });

  it("rejects an announced candidate body above 256 MiB with 413", async () => {
    const url = await start(
      candidateService(async () => ({ pages: [] }) as never),
    );
    const response = await requestWithDeclaredLength(
      `${url}${candidatePath}`,
      { ...jsonHeaders },
      256 * 1024 * 1024 + 1,
    );
    expect(response.status).toBe(413);
    expect(response.body).toContain("WIKI_REFRESH_CANDIDATE_REQUEST_INVALID");
  });

  it("maps candidate service failures to their declared status and body", async () => {
    const errors: Error[] = [
      new WikiRefreshCandidateError(
        "WIKI_REFRESH_GENERATION_INVALID",
        "terminal",
        400,
        "bad generation",
      ),
      new Error("boom"),
    ];
    const url = await start(
      candidateService(async () => {
        throw errors.shift()!;
      }),
    );
    const first = await fetch(`${url}${candidatePath}`, {
      body: "{}",
      headers: jsonHeaders,
      method: "POST",
    });
    expect(first.status).toBe(400);
    await expect(first.text()).resolves.toBe(
      '{"error":{"code":"WIKI_REFRESH_GENERATION_INVALID","disposition":"terminal","message":"bad generation"}}',
    );
    const second = await fetch(`${url}${candidatePath}`, {
      body: "{}",
      headers: jsonHeaders,
      method: "POST",
    });
    expect(second.status).toBe(503);
    await expect(second.text()).resolves.toBe(
      '{"error":{"code":"WIKI_REFRESH_GENERATION_UNAVAILABLE","disposition":"retryable","message":"Wiki refresh candidate generation is temporarily unavailable"}}',
    );
  });

  it("rejects missing media type and an oversized streamed source", async () => {
    const url = await start();
    const missing = await fetch(`${url}/v0/document-normalizations`, {
      body: new Uint8Array([1]),
      headers: {
        authorization: `Bearer ${serviceToken}`,
        "content-type": "application/octet-stream",
      },
      method: "POST",
    });
    expect(missing.status).toBe(400);

    const streamed = await new Promise<{ body: string; status: number }>(
      (resolve, reject) => {
        const request = httpRequest(
          `${url}/v0/document-normalizations`,
          {
            headers: {
              authorization: `Bearer ${serviceToken}`,
              "content-type": "application/octet-stream",
              "x-source-filename": "large.pdf",
              "x-source-media-type": "application/pdf",
            },
            method: "POST",
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.once("end", () =>
              resolve({
                body: Buffer.concat(chunks).toString("utf8"),
                status: response.statusCode ?? 0,
              }),
            );
          },
        );
        // A socket reset after the early 413 is expected.
        request.once("error", () => undefined);
        const chunk = Buffer.alloc(1024 * 1024);
        let sent = 0;
        const write = (): void => {
          while (sent <= MAX_DOCUMENT_SOURCE_BYTES) {
            sent += chunk.byteLength;
            if (!request.write(chunk)) {
              request.once("drain", write);
              return;
            }
          }
          request.end();
        };
        write();
        request.once("close", () => reject(new Error("closed")));
      },
    ).catch(() => ({ body: "", status: 0 }));
    expect(streamed.status === 413 || streamed.status === 0).toBe(true);
    if (streamed.status === 413) {
      expect(streamed.body).toContain("DOCUMENT_SOURCE_TOO_LARGE");
    }
  });
});

async function requestWithDeclaredLength(
  url: string,
  headers: Record<string, string>,
  contentLength: number,
): Promise<{ body: string; status: number }> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        headers: { ...headers, "content-length": String(contentLength) },
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
