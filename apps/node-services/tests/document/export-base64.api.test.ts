import { createHash } from "node:crypto";

import { materializeRoomDocument } from "@linger/document-model";
import { beforeAll, describe, expect, it } from "vitest";

import { createDocumentRuntimeApp } from "../../src/document/app.js";
import { installDocumentRuntimeDOM } from "../../src/document/server-dom.js";
import { useDocumentComputation } from "./computation-test-support.js";

const computation = useDocumentComputation();

const teamHubToken = "export-base64-test-token";

describe("export Base64 boundary", () => {
  beforeAll(() => installDocumentRuntimeDOM());

  async function request(state: Record<string, unknown>) {
    const revision = {
      revision_id: "revision_large",
      state,
      asset_manifest: [],
    };
    const input = { ...revision, schema_version: 1, format: "markdown" };
    return createDocumentRuntimeApp({ computation, teamHubToken }).request(
      "/internal/v1/documents/export",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${teamHubToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      },
    );
  }

  const evidence = {
    state_bytes: "AAAA",
    bytes_sha256: "a".repeat(64),
    state_vector: "AA==",
    state_hash: "a".repeat(64),
    state_hash_version: 1,
    complete_references: { document_asset_ids: [], document_thread_ids: [] },
    warnings: [],
  };

  it("exports a multi-megabyte revision without losing content", async () => {
    const content = "A".repeat(6 * 1024 * 1024);
    const state = await materializeRoomDocument({
      materializationId: "00000000-0000-4000-8000-000000000091",
      schemaVersion: 1,
      sourceKind: "plain_text",
      sourceBytes: Buffer.from(content),
    });
    const response = await request({
      ...evidence,
      state_bytes: Buffer.from(state.stateBytes).toString("base64"),
      bytes_sha256: state.bytesSha256,
      state_vector: Buffer.from(state.stateVector).toString("base64"),
      state_hash: state.stateHash,
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(Buffer.from(result.bytes, "base64").toString()).toBe(content);
    expect(result.size_bytes).toBe(Buffer.byteLength(content));
    expect(result.sha256).toBe(
      createHash("sha256").update(content).digest("hex"),
    );
  });

  it.each(["AAA", "AA-_", "AA\nA", "=AAA", "A===", "AA=A", "AB==", "AAB="])(
    "rejects noncanonical Base64 %j",
    async (value) => {
      const response = await request({ ...evidence, state_bytes: value });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        code: "validation_failed",
        message: "Revision export bytes must use canonical base64",
        retryable: false,
      });
    },
  );

  it.each([
    ["state_bytes", 32 << 20],
    ["state_vector", 1 << 20],
  ] as const)(
    "rejects oversized %s before document conversion",
    async (field, limit) => {
      const response = await request({
        ...evidence,
        [field]: Buffer.alloc(limit + 1).toString("base64"),
      });
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({
        code: "payload_too_large",
        retryable: false,
      });
    },
  );
});
