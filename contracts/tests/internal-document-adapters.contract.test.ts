import { describe, expect, it } from "vitest";

import {
  INTERNAL_HTTP_BODY_LIMIT_BYTES,
  type DocumentRuntimeHandlers,
  createDocumentRuntimeContractApp,
} from "../generated/typescript/src/node-services-internal/server.js";

const id = "00000000-0000-4000-8000-000000000001";
const sha256 = "0".repeat(64);
const computedState = {
  state_bytes: "",
  bytes_sha256: sha256,
  state_vector: "",
  state_hash: sha256,
  state_hash_version: 1,
  complete_references: {
    document_asset_ids: [],
    document_thread_ids: [],
  },
  warnings: [],
};

describe("generated internal Document adapters", () => {
  it("authenticates the fixed Runtime audience before every generated handler", async () => {
    const calls: string[] = [];
    const routeParameters: Array<Record<string, string>> = [];
    const handler =
      (operation: string) =>
      async (
        context: Parameters<DocumentRuntimeHandlers["importDocument"]>[0],
      ) => {
        await context.req.json();
        calls.push(operation);
        routeParameters.push(context.req.param());
        return context.json({ operation });
      };
    const handlers: DocumentRuntimeHandlers = {
      importDocument: handler("import"),
      exportDocument: handler("export"),
      applyDocumentChange: handler("apply"),
      disconnectDocumentConnections: handler("disconnect"),
    };
    const authInputs: Array<{ audience: string; token: string }> = [];
    const app = createDocumentRuntimeContractApp(handlers, {
      authenticate: (input) => {
        authInputs.push(input);
        return input.token === "rotated-token" ? { subject: "teamhub" } : null;
      },
    });

    const unauthorized = await app.request("/internal/v1/documents/import", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(unauthorized.status).toBe(401);
    expect(calls).toEqual([]);

    const routes: Array<[string, unknown]> = [
      [
        "/internal/v1/documents/import",
        { operation_id: id, schema_version: 1, source_kind: "blank" },
      ],
      [
        "/internal/v1/documents/export",
        {
          revision_id: id,
          schema_version: 1,
          state: computedState,
          asset_manifest: [],
          format: "markdown",
        },
      ],
      [`/internal/v1/documents/${id}/apply`, { operation_id: id }],
      [`/internal/v1/documents/${id}/disconnect`, {}],
    ];
    for (const [path, body] of routes) {
      const response = await app.request(path, {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          authorization: "Bearer rotated-token",
          "content-type": "application/json",
        },
      });
      expect(response.status, path).toBe(200);
    }

    expect(calls).toEqual(["import", "export", "apply", "disconnect"]);
    expect(authInputs).toEqual(
      Array.from({ length: 4 }, () => ({
        audience: "document-runtime",
        token: "rotated-token",
      })),
    );
    expect(routeParameters).toEqual([
      {},
      {},
      { documentId: id },
      { documentId: id },
    ]);
  });

  it("rejects an oversized streamed body without relying on Content-Length", async () => {
    let handlerCalls = 0;
    const handler: DocumentRuntimeHandlers["importDocument"] = (context) => {
      handlerCalls += 1;
      return context.json({ status: "unexpected" });
    };
    const app = createDocumentRuntimeContractApp(
      {
        importDocument: handler,
        exportDocument: handler,
        applyDocumentChange: handler,
        disconnectDocumentConnections: handler,
      },
      { authenticate: () => ({ subject: "teamhub" }) },
    );
    const request = new Request(
      "http://document-runtime.internal/internal/v1/documents/import",
      {
        method: "POST",
        body: "x".repeat(INTERNAL_HTTP_BODY_LIMIT_BYTES + 1),
        headers: { authorization: "Bearer token" },
      },
    );
    expect(request.headers.get("content-length")).toBeNull();

    const response = await app.fetch(request);

    expect(response.status).toBe(413);
    expect(handlerCalls).toBe(0);
    await expect(response.json()).resolves.toMatchObject({
      code: "payload_too_large",
      retryable: false,
    });
  }, 15_000);
});
