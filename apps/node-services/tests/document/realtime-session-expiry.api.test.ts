import { describe, expect, it, vi } from "vitest";

import {
  connectRealtimeClient,
  memoryBodies,
  startRealtimeServer,
  wsUrl,
} from "./realtime-test-support.js";

describe("Document realtime session expiry", () => {
  it.each([5_000, 30 * 24 * 60 * 60_000])(
    "honors the connection token expiry without overflowing a %i ms lifetime",
    async (expiresInMs) => {
      const { bodies } = await memoryBodies();
      const realtime = await startRealtimeServer(bodies);
      let closeConnection!: (event: { code: number; reason: string }) => void;
      const closed = new Promise<{ code: number; reason: string }>(
        (resolve) => {
          closeConnection = resolve;
        },
      );
      const onClose = vi.fn(closeConnection);
      const client = await connectRealtimeClient({
        token: "expiring",
        expiresInMs,
        url: wsUrl(realtime.address),
        onClose,
      });

      try {
        if (expiresInMs > 5_000) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          expect(onClose).not.toHaveBeenCalled();
          return;
        }
        await expect(closed).resolves.toMatchObject({
          code: 1000,
          reason: "Document session expired",
        });
      } finally {
        client.provider.destroy();
        await realtime.destroy();
      }
    },
    15_000,
  );
});
