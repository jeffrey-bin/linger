import { createHash } from "node:crypto";

import { readRoomDocumentBlocks } from "@linger/document-model";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import type { DocumentBodySave } from "../../src/document/bodies.js";
import {
  appendToFirstText,
  connectRealtimeClient,
  documentId,
  memoryBodies,
  startRealtimeServer,
  wsUrl,
} from "./realtime-test-support.js";

describe("Document Runtime durable save", () => {
  it("broadcasts an admitted mutation before saving the body in one step", async () => {
    const { bodies } = await memoryBodies();
    let saveObserved!: (save: DocumentBodySave) => void;
    const saveAttempted = new Promise<DocumentBodySave>((resolve) => {
      saveObserved = resolve;
    });
    let releaseSave!: () => void;
    const saveRelease = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    bodies.beforeSave = async (save) => {
      saveObserved(save);
      await saveRelease;
    };
    const realtime = await startRealtimeServer(bodies);
    const acks: Array<{ type: string; head?: { persisted_seq: number } }> = [];
    const first = await connectRealtimeClient({
      token: "human_a",
      url: wsUrl(realtime.address),
      onStateless: (payload) => acks.push(JSON.parse(payload)),
    });
    const second = await connectRealtimeClient({
      token: "human_b",
      url: wsUrl(realtime.address),
    });
    const peerUpdate = new Promise<void>((resolve) => {
      second.document.once("update", () => resolve());
    });

    try {
      appendToFirstText(first.document, " saved");

      await peerUpdate;
      expect(
        readRoomDocumentBlocks(Y.encodeStateAsUpdate(second.document)),
      ).toMatchObject([
        {
          type: "paragraph",
          content: [{ text: "Durable initial state saved" }],
        },
      ]);
      const save = await Promise.race([saveAttempted, rejectAfter(2_000)]);
      expect(save).toMatchObject({
        documentId,
        baseSeq: 0,
        editorIds: ["actor_human_a"],
        assetIds: [],
        threadIds: [],
      });
      expect(readRoomDocumentBlocks(save.state)).toMatchObject([
        {
          type: "paragraph",
          content: [{ text: "Durable initial state saved" }],
        },
      ]);
      // Saved is acknowledged only after the save returns.
      expect(acks.some((ack) => ack.head?.persisted_seq === 1)).toBe(false);

      releaseSave();
      await expect
        .poll(() => acks.find((ack) => ack.head?.persisted_seq === 1))
        .toMatchObject({
          type: "durability_ack",
          head: {
            persisted_seq: 1,
            state_hash: createHash("sha256").update(save.state).digest("hex"),
          },
        });
      expect(bodies.rows.get(documentId)!.seq).toBe(1);
    } finally {
      releaseSave();
      first.provider.destroy();
      second.provider.destroy();
      await realtime.destroy();
    }
  });
});

function rejectAfter(milliseconds: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(
      () => reject(new Error("Timed out waiting for the body save")),
      milliseconds,
    );
  });
}
