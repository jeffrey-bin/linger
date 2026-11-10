import { expect, it } from "vitest";
import * as Y from "yjs";
import {
  appendToFirstText,
  connectRealtimeClient,
  documentId,
  memoryBodies,
  startRealtimeServer,
  wsUrl,
} from "./realtime-test-support.js";

it("persists individually valid offline edits accumulated beyond the former frame and batch limits", async () => {
  const { bodies, initial } = await memoryBodies();
  const document = new Y.Doc();
  Y.applyUpdate(document, initial.stateBytes);
  const changes: number[] = [];
  document.on("update", (u: Uint8Array) => changes.push(u.length));
  for (let i = 0; i < 16; i++)
    appendToFirstText(document, "a".repeat(320 * 1024));
  expect(Math.max(...changes)).toBeLessThan(1 << 20);
  expect(
    Y.encodeStateAsUpdate(document, initial.stateVector).length,
  ).toBeGreaterThan(4 << 20);
  const realtime = await startRealtimeServer(bodies);
  let provider:
    | Awaited<ReturnType<typeof connectRealtimeClient>>["provider"]
    | undefined;
  const closes: number[] = [];
  let saved = false;
  try {
    await connectRealtimeClient({
      document,
      token: "offline",
      url: wsUrl(realtime.address),
      onProviderCreated: (p) => (provider = p),
      onClose: (e) => closes.push(e.code),
      onStateless: (payload) => {
        const ack = JSON.parse(payload);
        if (ack.type === "durability_ack" && ack.head.persisted_seq === 1)
          saved = true;
      },
    });
    await expect.poll(() => saved).toBe(true);
    expect(closes).not.toContain(1009);
    const recovered = new Y.Doc();
    Y.applyUpdate(recovered, bodies.rows.get(documentId)!.state);
    expect(recovered.getXmlFragment("prosemirror").toJSON()).toBe(
      document.getXmlFragment("prosemirror").toJSON(),
    );
    recovered.destroy();
  } finally {
    provider?.destroy();
    await realtime.destroy();
    document.destroy();
  }
}, 10000);
