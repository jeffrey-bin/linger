import { describe, expect, it } from "vitest";

import {
  connectRealtimeClient,
  documentId,
  insertDocumentAssetBlock,
  memoryBodies,
  startRealtimeServer,
  wsUrl,
} from "./realtime-test-support.js";

describe("Document Runtime Asset references", () => {
  it("checks a new Asset ref once and saves the complete refs in the body", async () => {
    const { bodies } = await memoryBodies();
    bodies.availableAssets.add("asset_image_1");
    const realtime = await startRealtimeServer(bodies);
    const client = await connectRealtimeClient({
      token: "human_asset_ref",
      url: wsUrl(realtime.address),
    });

    try {
      insertDocumentAssetBlock(client.document, "asset_image_1");
      await waitFor(() => bodies.saves.length === 1);

      expect(bodies.referenceChecks).toEqual([
        { documentId, assetIds: ["asset_image_1"], threadIds: [] },
      ]);
      expect(bodies.saves[0]).toMatchObject({
        assetIds: ["asset_image_1"],
        threadIds: [],
      });
      expect(bodies.rows.get(documentId)!.assetIds).toEqual(["asset_image_1"]);
    } finally {
      client.provider.destroy();
      await realtime.destroy();
    }
  });

  it("refuses a frame that references an unavailable Asset", async () => {
    const { bodies } = await memoryBodies();
    const realtime = await startRealtimeServer(bodies);
    let closed!: () => void;
    const connectionClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const client = await connectRealtimeClient({
      token: "human_missing_asset",
      url: wsUrl(realtime.address),
      onClose: () => closed(),
    });

    try {
      insertDocumentAssetBlock(client.document, "asset_missing");
      await connectionClosed;
      expect(bodies.saves).toEqual([]);
    } finally {
      client.provider.destroy();
      await realtime.destroy();
    }
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the Document body save");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
