import { readRoomDocumentBlocks } from "@linger/document-model";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { documentLogger } from "../../src/document/log.js";
import {
  connectRealtimeClient,
  documentId,
  memoryBodies,
  signConnectionToken,
  startRealtimeServer,
  wsUrl,
} from "./realtime-test-support.js";

const collaborationCredential = "collaboration-credential-test";
const sessionId = "document_session_from_teamhub";

describe("Document Runtime realtime interface", () => {
  it("verifies the connection token and loads the body before the first Yjs sync", async () => {
    const { bodies } = await memoryBodies({ permissionCount: 3 });
    const realtime = await startRealtimeServer(bodies);
    const log = vi.spyOn(documentLogger(), "log");

    let provider;
    try {
      const client = await connectRealtimeClient({
        sessionId,
        token: collaborationCredential,
        permissionCount: 3,
        url: wsUrl(realtime.address),
      });
      provider = client.provider;

      expect(bodies.loads).toEqual([documentId]);
      expect(
        readRoomDocumentBlocks(Y.encodeStateAsUpdate(client.document)),
      ).toMatchObject([
        { type: "paragraph", content: [{ text: "Durable initial state" }] },
      ]);
      expect(log).toHaveBeenCalledWith(
        "info",
        "document.connection_authenticated",
        expect.objectContaining({
          document_id: documentId,
          actor_id: `actor_${collaborationCredential}`,
          session_id: sessionId,
          mode: "write",
        }),
      );
    } finally {
      log.mockRestore();
      provider?.destroy();
      await realtime.destroy();
    }
  });

  it("refuses a token signed before the Document's permissions changed", async () => {
    const { bodies } = await memoryBodies({ permissionCount: 4 });
    const realtime = await startRealtimeServer(bodies);
    const log = vi.spyOn(documentLogger(), "log");
    const document = new Y.Doc({ gc: true });
    try {
      await expect(
        connectRealtimeClient({
          document,
          token: "stale_holder",
          permissionCount: 3,
          url: wsUrl(realtime.address),
        }),
      ).rejects.toThrow("Authentication failed");
      expect(document.getXmlFragment("prosemirror").length).toBe(0);
      expect(log).toHaveBeenCalledWith(
        "warn",
        "document.connection_token_stale",
        expect.objectContaining({
          token_permission_count: 3,
          permission_count: 4,
        }),
      );
    } finally {
      log.mockRestore();
      document.destroy();
      await realtime.destroy();
    }
  });

  it("refuses a Document that is not an active native Document", async () => {
    const { bodies } = await memoryBodies();
    bodies.rows.get(documentId)!.active = false;
    const realtime = await startRealtimeServer(bodies);
    try {
      await expect(
        connectRealtimeClient({
          token: "trashed_reader",
          url: wsUrl(realtime.address),
        }),
      ).rejects.toThrow("Authentication failed");
    } finally {
      await realtime.destroy();
    }
  });

  it.each([
    [
      "another key",
      () => signConnectionToken({ actorKey: "forger", key: "another-key" }),
    ],
    [
      "an expired token",
      () => signConnectionToken({ actorKey: "late", expiresInMs: -1 }),
    ],
    [
      "another Document",
      () =>
        signConnectionToken({
          actorKey: "elsewhere",
          documentName: "document_other",
        }),
    ],
    ["a malformed token", () => "not-a-token"],
  ])("refuses %s without loading the body", async (_, token: () => string) => {
    const { bodies } = await memoryBodies();
    const realtime = await startRealtimeServer(bodies);
    try {
      await expect(
        connectRealtimeClient({
          token: "unused",
          rawToken: token(),
          url: wsUrl(realtime.address),
        }),
      ).rejects.toThrow("Authentication failed");
      expect(bodies.loads).toEqual([]);
    } finally {
      await realtime.destroy();
    }
  });

  it("opens a read token read-only", async () => {
    const { bodies } = await memoryBodies();
    const realtime = await startRealtimeServer(bodies);
    const reader = await connectRealtimeClient({
      token: "reader",
      mode: "read",
      url: wsUrl(realtime.address),
    });
    const observer = await connectRealtimeClient({
      token: "observer",
      url: wsUrl(realtime.address),
    });
    try {
      const text = observer.document.getXmlFragment("prosemirror").toJSON();
      const readerText = reader.document.getXmlFragment("prosemirror");
      const firstReaderText = firstText(readerText);
      firstReaderText.insert(firstReaderText.length, " unsaved");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(observer.document.getXmlFragment("prosemirror").toJSON()).toBe(
        text,
      );
      expect(bodies.loads).toEqual([documentId, documentId]);
      expect(bodies.saves).toEqual([]);
    } finally {
      reader.provider.destroy();
      observer.provider.destroy();
      await realtime.destroy();
    }
  });

  it("fails closed before sync when the state does not match its state vector", async () => {
    const { bodies } = await memoryBodies();
    bodies.rows.get(documentId)!.state = Buffer.from("corrupt state");
    const realtime = await startRealtimeServer(bodies);
    const document = new Y.Doc({ gc: true });

    try {
      await expect(
        connectRealtimeClient({
          document,
          sessionId,
          token: collaborationCredential,
          url: wsUrl(realtime.address),
        }),
      ).rejects.toThrow();
      expect(document.getXmlFragment("prosemirror").length).toBe(0);
      expect(bodies.loads).toEqual([documentId]);
    } finally {
      await realtime.destroy();
    }
  });

  it("fails closed when the body's references omit refs in the recovered Y.Doc", async () => {
    const { bodies, initial } = await memoryBodies();
    const referenced = new Y.Doc({ gc: true });
    Y.applyUpdate(referenced, initial.stateBytes);
    const text = firstText(referenced.getXmlFragment("prosemirror"));
    text.format(0, text.length, {
      comment: { orphan: false, threadId: "document_thread_hidden" },
    });
    const row = bodies.rows.get(documentId)!;
    row.state = Y.encodeStateAsUpdate(referenced);
    row.stateVector = Y.encodeStateVector(referenced);
    const realtime = await startRealtimeServer(bodies);

    try {
      await expect(
        connectRealtimeClient({
          sessionId,
          token: collaborationCredential,
          url: wsUrl(realtime.address),
        }),
      ).rejects.toThrow();
    } finally {
      await realtime.destroy();
    }
  });
});

function firstText(parent: Y.XmlFragment | Y.XmlElement): Y.XmlText {
  for (const child of parent.toArray()) {
    if (child instanceof Y.XmlText) {
      return child;
    }
    if (child instanceof Y.XmlElement) {
      try {
        return firstText(child);
      } catch {
        // Continue through sibling blocks.
      }
    }
  }
  throw new Error("Expected BlockNote text content");
}
