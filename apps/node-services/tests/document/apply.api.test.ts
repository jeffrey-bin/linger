import {
  materializeRoomDocument,
  readRoomDocumentBlocks,
} from "@linger/document-model";
import { sha256Hex } from "@linger/service-kit/node";
import { beforeAll, describe, expect, it } from "vitest";

import { createDocumentRuntimeApp } from "../../src/document/app.js";
import { DocumentChangeCoordinator } from "../../src/document/document-changes.js";
import { DocumentOrderingQueue } from "../../src/document/realtime-ordering.js";
import { installDocumentRuntimeDOM } from "../../src/document/server-dom.js";
import { useDocumentComputation } from "./computation-test-support.js";
import { documentDurability } from "./document-state-test-support.js";
import { MemoryDocumentBodies } from "./realtime-test-support.js";

const computation = useDocumentComputation();
const teamHubToken = "teamhub-to-runtime-apply-token";
const documentId = "document_apply_01";

describe("Document Runtime apply contract", () => {
  beforeAll(() => installDocumentRuntimeDOM());

  it("saves a semantic change on the stored body and returns its sequence", async () => {
    const { bodies, post } = await applyFixture("Body");
    const response = await post(
      semantic([
        {
          kind: "append_blocks",
          blocks: [
            { id: "agent_append_01", type: "paragraph", content: "Appended" },
          ],
        },
        { kind: "set_title", title: "After" },
      ]),
    );

    expect(response.status).toBe(200);
    const result = await response.json();
    const row = bodies.rows.get(documentId)!;
    expect(result).toEqual({
      status: "applied",
      seq: 1,
      state_hash: sha256Hex(row.state),
      title: "After",
      complete_references: { document_asset_ids: [], document_thread_ids: [] },
    });
    expect(row.editorIds).toEqual(["actor_agent_01"]);
    expect(
      readRoomDocumentBlocks(row.state).map((block) => block.content),
    ).toMatchObject([[{ text: "Body" }], [{ text: "Appended" }]]);
  });

  it("returns a typed conflict and saves nothing", async () => {
    const { bodies, post } = await applyFixture("Body");
    const missing = await post(
      semantic([{ kind: "delete_blocks", stable_block_ids: ["missing"] }]),
    );
    expect(missing.status).toBe(200);
    await expect(missing.json()).resolves.toEqual({
      status: "conflicted",
      reason: "missing_block",
    });
    const stale = await post({
      ...semantic([{ kind: "set_title", title: "After" }]),
      expected_seq: 4,
    });
    await expect(stale.json()).resolves.toEqual({
      status: "conflicted",
      reason: "stale_head",
    });
    expect(bodies.saves).toHaveLength(0);
  });

  it("restores a target state over the current body", async () => {
    const { bodies, post } = await applyFixture("Current\nLater");
    const target = await materializeRoomDocument({
      materializationId: "00000000-0000-4000-8000-000000000072",
      schemaVersion: 1,
      sourceKind: "plain_text",
      sourceBytes: Buffer.from("Target"),
    });
    const change = {
      kind: "restore",
      target_state_bytes: Buffer.from(target.stateBytes).toString("base64"),
      target_state_bytes_sha256: target.bytesSha256,
    };

    const response = await post({ ...request(), change });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "applied",
      seq: 1,
    });
    expect(
      readRoomDocumentBlocks(bodies.rows.get(documentId)!.state).map(
        (block) => block.content,
      ),
    ).toMatchObject([[{ text: "Target" }]]);
    const corrupt = await post({
      ...request(),
      change: { ...change, target_state_bytes_sha256: "0".repeat(64) },
    });
    expect(corrupt.status).toBe(422);
  });

  it("marks a Comment thread on the quoted selection", async () => {
    const { bodies, post, blockId } = await applyFixture(
      "Before selected words after",
    );
    const response = await post({
      ...request(),
      change: {
        kind: "comment_anchor",
        thread_id: "thread_apply_01",
        quoted_text: "selected words",
        block_id: blockId,
        context_before: "Before ",
        context_after: " after",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "applied",
      complete_references: { document_thread_ids: ["thread_apply_01"] },
    });
    expect(bodies.rows.get(documentId)!.threadIds).toEqual(["thread_apply_01"]);
  });

  it("fails closed for bad authority, input and Documents", async () => {
    const { bodies, post } = await applyFixture("Body");
    const valid = semantic([{ kind: "set_title", title: "After" }]);
    expect((await post(valid, "wrong-token")).status).toBe(401);
    for (const body of [
      { ...valid, unknown: true },
      {
        ...valid,
        change: { ...valid.change, allowed_document_asset_ids: ["a", "a"] },
      },
      { ...valid, change: { ...valid.change, kind: "unknown" } },
    ]) {
      const response = await post(body);
      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({
        retryable: false,
      });
    }
    bodies.rows.get(documentId)!.active = false;
    expect((await post(valid)).status).toBe(404);
    expect(bodies.saves).toHaveLength(0);
  });
});

function request() {
  return { operation_id: "document_change_01", actor_id: "actor_agent_01" };
}

function semantic(operations: unknown[]) {
  return {
    ...request(),
    change: {
      kind: "semantic",
      schema_version: "blocknote-semantic-v1",
      current_title: "Before",
      allowed_document_asset_ids: [] as string[],
      operations,
    },
  };
}

async function applyFixture(source: string) {
  const state = await materializeRoomDocument({
    materializationId: "00000000-0000-4000-8000-000000000081",
    schemaVersion: 1,
    sourceKind: "plain_text",
    sourceBytes: Buffer.from(source),
  });
  const bodies = new MemoryDocumentBodies();
  bodies.put(state, { documentId });
  const app = createDocumentRuntimeApp({
    computation,
    teamHubToken,
    changes: new DocumentChangeCoordinator({
      durability: documentDurability(bodies),
      ordering: new DocumentOrderingQueue(),
      bodies,
      getResidentDocument: () => undefined,
    }),
  });
  const post = (body: unknown, token = teamHubToken) =>
    app.request(`/internal/v1/documents/${documentId}/apply`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const blockId = readRoomDocumentBlocks(state.stateBytes)[0]!.id;
  return { bodies, post, blockId };
}
