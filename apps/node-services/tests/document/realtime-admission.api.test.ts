import { describe, expect, it } from "vitest";

import {
  connectRealtimeClient,
  memoryBodies,
  startRealtimeServer,
  wsUrl,
} from "./realtime-test-support.js";

describe("Document realtime admission", () => {
  it("rejects excess session connections and restores capacity on disconnect", async () => {
    const { bodies } = await memoryBodies();
    const realtime = await startRealtimeServer(bodies, {
      realtimeAdmission: { maxConnectionsPerSession: 1 },
    });
    let firstClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      firstClosed = resolve;
    });
    const first = await connectRealtimeClient({
      onClose: firstClosed,
      sessionId: "document_session_admission",
      token: "admission",
      expiresInMs: 250,
      url: wsUrl(realtime.address),
    });
    let rejectedProvider: { destroy(): void } | undefined;

    try {
      await expect(
        connectRealtimeClient({
          onProviderCreated: (provider) => {
            rejectedProvider = provider;
          },
          sessionId: "document_session_admission",
          token: "admission",
          url: wsUrl(realtime.address),
        }),
      ).rejects.toThrow("Authentication failed");
      rejectedProvider?.destroy();
      await closed;
      await new Promise((resolve) => setTimeout(resolve, 25));
      const replacement = await connectRealtimeClient({
        sessionId: "document_session_admission",
        token: "admission",
        url: wsUrl(realtime.address),
      });
      replacement.provider.destroy();
    } finally {
      rejectedProvider?.destroy();
      first.provider.destroy();
      await realtime.destroy();
    }
  }, 10_000);

  it("admits 21 Document sessions of one account", async () => {
    const { bodies } = await memoryBodies();
    const realtime = await startRealtimeServer(bodies);
    const clients: Awaited<ReturnType<typeof connectRealtimeClient>>[] = [];
    try {
      for (let index = 0; index < 21; index += 1) {
        clients.push(
          await connectRealtimeClient({
            sessionId: `document_session_account_${index}`,
            token: "one_account",
            url: wsUrl(realtime.address),
          }),
        );
      }
      expect(clients).toHaveLength(21);
    } finally {
      for (const client of clients) client.provider.destroy();
      await realtime.destroy();
    }
  }, 20_000);
});
