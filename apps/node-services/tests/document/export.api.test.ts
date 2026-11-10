import { materializeRoomDocument } from "@linger/document-model";
import { beforeAll, describe, expect, it } from "vitest";

import { createDocumentRuntimeApp } from "../../src/document/app.js";
import { installDocumentRuntimeDOM } from "../../src/document/server-dom.js";
import { useDocumentComputation } from "./computation-test-support.js";

const computation = useDocumentComputation();

const teamHubToken = "teamhub-to-runtime-export-token";

describe("Document Runtime Revision export contract", () => {
  beforeAll(() => installDocumentRuntimeDOM());

  it("returns deterministic Markdown bytes and evidence for one immutable Revision", async () => {
    const state = await materializeRoomDocument({
      materializationId: "00000000-0000-4000-8000-000000000042",
      schemaVersion: 1,
      sourceKind: "plain_text",
      sourceBytes: Buffer.from("Alpha\nBeta"),
    });
    const request = {
      revision_id: "document_revision_runtime_export",
      schema_version: 1,
      state: {
        state_bytes: Buffer.from(state.stateBytes).toString("base64"),
        bytes_sha256: state.bytesSha256,
        state_vector: Buffer.from(state.stateVector).toString("base64"),
        state_hash: state.stateHash,
        state_hash_version: state.stateHashVersion,
        complete_references: {
          document_asset_ids: [],
          document_thread_ids: [],
        },
        warnings: [],
      },
      asset_manifest: [],
      format: "markdown",
    };

    const blocksResponse = await requestExport({
      ...request,
      format: "blocks",
    });
    expect(blocksResponse.status).toBe(200);
    const blocksExport = await blocksResponse.json();
    expect(blocksExport.media_type).toBe("application/json");
    const copy = JSON.parse(
      Buffer.from(blocksExport.bytes, "base64").toString(),
    );
    expect(copy).toMatchObject({
      schema_version: 1,
      blocks: [
        { id: expect.any(String), content: [{ text: "Alpha" }] },
        { id: expect.any(String), content: [{ text: "Beta" }] },
      ],
    });
    const first = await requestExport(request);
    const replay = await requestExport(request);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    const body = await first.json();
    expect(await replay.json()).toEqual(body);
    expect(body).toEqual({
      media_type: "text/markdown",
      bytes: Buffer.from("Alpha\n\nBeta").toString("base64"),
      size_bytes: 11,
      sha256:
        "611a167854cd6d1c92d7fbcc4ca9b3887ab9cec955ef0e11d4a8dfa3f0596cc4",
      complete_references: {
        document_asset_ids: [],
        document_thread_ids: [],
      },
      warnings: [],
    });
  });
});

async function requestExport(body: unknown): Promise<Response> {
  return await createDocumentRuntimeApp({ computation, teamHubToken }).request(
    "/internal/v1/documents/export",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${teamHubToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}
