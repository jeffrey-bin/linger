import type { HocuspocusProvider } from "@hocuspocus/provider";
import { readRoomDocumentBlocks } from "@linger/document-model";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  connectRealtimeClient,
  documentId,
  memoryBodies,
  startRealtimeServer,
  wsUrl,
} from "./realtime-test-support.js";

describe("Document authentication recovery", () => {
  it("retries one failed body load with the same connection before syncing", async () => {
    const { bodies } = await memoryBodies();
    bodies.beforeLoad = () => {
      if (bodies.loads.length === 1) throw new Error("connection reset");
    };
    const realtime = await startRealtimeServer(bodies);
    let provider: HocuspocusProvider | undefined;
    try {
      const client = await connectRealtimeClient({
        token: "credential",
        sessionId: "session_retry",
        url: wsUrl(realtime.address),
        onProviderCreated: (created) => {
          provider = created;
        },
      });
      expect(bodies.loads).toEqual([documentId, documentId]);
      expect(
        readRoomDocumentBlocks(Y.encodeStateAsUpdate(client.document)),
      ).toMatchObject([
        { type: "paragraph", content: [{ text: "Durable initial state" }] },
      ]);
    } finally {
      provider?.destroy();
      await realtime.destroy();
    }
  });

  it("fails closed when the retry fails too", async () => {
    const { bodies } = await memoryBodies();
    bodies.beforeLoad = () => {
      throw new Error("database unavailable");
    };
    const realtime = await startRealtimeServer(bodies);
    const document = new Y.Doc();
    let provider: HocuspocusProvider | undefined;
    try {
      await expect(
        connectRealtimeClient({
          document,
          token: "credential",
          url: wsUrl(realtime.address),
          onProviderCreated: (created) => {
            provider = created;
          },
        }),
      ).rejects.toThrow("Authentication failed");
      expect(bodies.loads).toHaveLength(2);
      expect(document.getXmlFragment("prosemirror").length).toBe(0);
    } finally {
      provider?.destroy();
      document.destroy();
      await realtime.destroy();
    }
  });

  it("stops waiting for a body load at admission expiry without syncing or retrying", async () => {
    const { bodies } = await memoryBodies();
    bodies.beforeLoad = () => new Promise<void>(() => undefined);
    const realtime = await startRealtimeServer(bodies, {
      realtimeAdmission: { authenticationTimeoutMs: 100 },
    });
    const document = new Y.Doc();
    let provider: HocuspocusProvider | undefined;
    try {
      await expect(
        connectRealtimeClient({
          document,
          token: "credential",
          url: wsUrl(realtime.address),
          onProviderCreated: (created) => {
            provider = created;
          },
        }),
      ).rejects.toThrow("Authentication failed");
      expect(bodies.loads).toHaveLength(1);
      expect(document.getXmlFragment("prosemirror").length).toBe(0);
    } finally {
      provider?.destroy();
      document.destroy();
      await realtime.destroy();
    }
  });
});
