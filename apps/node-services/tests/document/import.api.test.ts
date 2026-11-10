import { createHash } from "node:crypto";
import { File as NodeFile } from "node:buffer";

import {
  inspectRoomDocumentState,
  materializeRoomDocument,
} from "@linger/document-model";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { createDocumentRuntimeApp } from "../../src/document/app.js";
import { installDocumentRuntimeDOM } from "../../src/document/server-dom.js";
import { addCommentMarkToFirstText } from "./realtime-test-support.js";
import { useDocumentComputation } from "./computation-test-support.js";

const computation = useDocumentComputation();

const teamHubToken = "teamhub-to-runtime-test-token";
const operationId = "9b5be123-4fd2-4a47-a98d-548879f3fc78";

describe("Document Runtime import contract", () => {
  it("requires the TeamHub-to-Runtime service identity", async () => {
    const response = await requestImport(
      {
        operation_id: operationId,
        schema_version: 1,
        source_kind: "blank",
      },
      "wrong-token",
    );

    expect(response.status).toBe(401);
  });

  it("preserves the native Node File API while installing DOM model support", async () => {
    const response = await requestImport(
      {
        operation_id: operationId,
        schema_version: 1,
        source_kind: "plain_text",
        source_bytes: Buffer.from("Native File stays intact.").toString(
          "base64",
        ),
      },
      teamHubToken,
    );

    expect(response.status).toBe(200);
    expect(globalThis.File).toBe(NodeFile);
  });

  it("returns deterministic BlockNote Yjs state for Markdown", async () => {
    const request = {
      operation_id: operationId,
      schema_version: 1,
      source_kind: "markdown",
      source_bytes: Buffer.from("# Plan\n\nStable body.").toString("base64"),
    };
    const first = await requestImport(request, teamHubToken);
    const replay = await requestImport(request, teamHubToken);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    const body = await first.json();
    expect(await replay.json()).toEqual(body);
    const stateBytes = Buffer.from(body.state_bytes as string, "base64");
    expect(body.bytes_sha256).toBe(
      createHash("sha256").update(stateBytes).digest("hex"),
    );
    expect(body.state_hash).toBe(body.bytes_sha256);
    expect(stateBytes.byteLength).toBeGreaterThan(0);
  });

  it("rejects malformed or expanded contract input", async () => {
    for (const body of [
      {
        operation_id: operationId,
        schema_version: 1,
        source_kind: "blank",
        unknown: true,
      },
      {
        operation_id: operationId,
        schema_version: 1,
        source_kind: "plain_text",
        source_bytes: "not-base64",
      },
      {
        operation_id: operationId,
        schema_version: 1,
        source_kind: "plain_text",
        source_bytes: "AB==",
      },
    ]) {
      const response = await requestImport(body, teamHubToken);
      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({
        code: "validation_failed",
        retryable: false,
      });
    }
  });

  it("reports malformed JSON as an invalid request", async () => {
    const response = await createDocumentRuntimeApp({
      computation,
      teamHubToken,
    }).request("/internal/v1/documents/import", {
      method: "POST",
      headers: {
        authorization: `Bearer ${teamHubToken}`,
        "content-type": "application/json",
      },
      body: "{",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "invalid_request",
      retryable: false,
    });
  });

  it("rejects raw embedded media instead of silently dropping it", async () => {
    const targetBytes = 8_311_152;
    const prefix =
      '<main><h1>Interior design</h1><img src="data:image/png;base64,';
    const suffix = '"><p>Template body</p></main>';
    const html =
      prefix + "A".repeat(targetBytes - prefix.length - suffix.length) + suffix;

    const response = await requestImport(
      {
        operation_id: "00000000-0000-4000-8000-000000000831",
        schema_version: 1,
        source_kind: "sanitized_html",
        source_bytes: Buffer.from(html).toString("base64"),
      },
      teamHubToken,
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      code: "validation_failed",
      retryable: false,
    });
  }, 60_000);

  it("returns complete references for allowlisted imported media", async () => {
    const response = await requestImport(
      {
        operation_id: operationId,
        schema_version: 1,
        source_kind: "sanitized_html",
        source_bytes: Buffer.from(
          '<img src="document-asset:document_asset_diagram">',
        ).toString("base64"),
        allowed_document_asset_ids: ["document_asset_diagram"],
      },
      teamHubToken,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      complete_references: {
        document_asset_ids: ["document_asset_diagram"],
        document_thread_ids: [],
      },
      warnings: [],
    });
  });
});

async function requestImport(body: unknown, token: string): Promise<Response> {
  return await createDocumentRuntimeApp({ computation, teamHubToken }).request(
    "/internal/v1/documents/import",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

describe("Document Runtime document state import", () => {
  it("returns deterministic remapped state without the source Comment threads", async () => {
    const request = {
      operation_id: "duplicate_runtime_operation",
      schema_version: 1,
      source_kind: "document_state",
      source_bytes: Buffer.from(await commentedState()).toString("base64"),
      asset_mappings: [],
    };

    const first = await requestImport(request, teamHubToken);
    const replay = await requestImport(request, teamHubToken);
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(await replay.json()).toEqual(body);
    expect(body).toMatchObject({
      state_hash_version: 1,
      complete_references: {
        document_asset_ids: [],
        document_thread_ids: [],
      },
      warnings: [],
    });
    expect(
      inspectRoomDocumentState(
        Buffer.from(body.state_bytes as string, "base64"),
      ).completeReferences,
    ).toEqual({ documentAssetIds: [], documentThreadIds: [] });
  });

  it("rejects Asset mappings on a text source", async () => {
    const response = await requestImport(
      {
        operation_id: operationId,
        schema_version: 1,
        source_kind: "plain_text",
        source_bytes: Buffer.from("text").toString("base64"),
        asset_mappings: [],
      },
      teamHubToken,
    );
    expect(response.status).toBe(422);
  });
});

async function commentedState(): Promise<Uint8Array> {
  installDocumentRuntimeDOM();
  const materialized = await materializeRoomDocument({
    materializationId: "32d9cf74-40c5-42aa-a422-e270498b6b51",
    schemaVersion: 1,
    sourceKind: "plain_text",
    sourceBytes: new TextEncoder().encode("Duplicate me"),
  });
  const document = new Y.Doc({ gc: true });
  Y.applyUpdate(document, materialized.stateBytes);
  addCommentMarkToFirstText(document, "thread_source");
  return Y.encodeStateAsUpdate(document);
}
