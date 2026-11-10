import { createHash } from "node:crypto";

import type { HocuspocusProvider } from "@hocuspocus/provider";
import {
  fingerprintRoomDocumentDeletes,
  readRoomDocumentBlocks,
} from "@linger/document-model";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  appendToFirstText,
  connectRealtimeClient,
  documentId,
  memoryBodies,
  startRealtimeServer,
  wsUrl,
} from "./realtime-test-support.js";

// Browser-free acceptance for Runtime protocol behavior that the Room Document
// E2E suite used to drive through Chromium. The body store applies saves with
// the table's sequence check, so sequences, state vectors and hashes follow
// real save semantics.
// Load-tolerant windows: these run beside heavy suites on shared CI runners.
const eventually = <T>(read: () => T) => expect.poll(read, { timeout: 5_000 });

describe(
  "Document Runtime acceptance against a stateful body store",
  { timeout: 20_000 },
  () => {
    const cleanups: Array<() => Promise<void> | void> = [];

    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup();
      }
    });

    it("closes a sender that adds an unexpected Yjs root before broadcast or append", async () => {
      const store = await startStatefulBodies();
      const runtime = await startRuntime(store);
      const peer = await runtime.connect("human_b");
      const sender = await runtime.connect("human_a");
      const peerBefore = Y.encodeStateAsUpdate(peer.document);

      sender.document.getMap("unexpected").set("value", true);

      await eventually(() => sender.closes).toEqual([
        { code: 1000, reason: "Room Document schema is invalid" },
      ]);
      expect(store.bodies.saves).toHaveLength(0);
      expect(Y.encodeStateAsUpdate(peer.document)).toEqual(peerBefore);

      // The peer stays connected and its next valid edit is the first durable batch.
      appendToFirstText(peer.document, " valid");
      await eventually(() => peer.ackedSequences()).toEqual([1]);
      expect(store.bodies.saves).toHaveLength(1);
      expect(peer.document.share.has("unexpected")).toBe(false);
      expect(store.canonical().share.has("unexpected")).toBe(false);
      expect(firstParagraph(store.canonical())).toBe(
        "Durable initial state valid",
      );
    });

    it("persists a pure deletion whose state vector does not change", async () => {
      const store = await startStatefulBodies();
      const runtime = await startRuntime(store);
      const editor = await runtime.connect("human_a");
      const peer = await runtime.connect("human_b");

      appendToFirstText(editor.document, " removable");
      await eventually(() => editor.ackedSequences()).toEqual([1]);
      await eventually(() => firstParagraph(peer.document)).toBe(
        "Durable initial state removable",
      );

      deleteFromFirstTextEnd(editor.document, " removable");
      await eventually(() => editor.ackedSequences()).toEqual([1, 2]);
      await eventually(() => firstParagraph(peer.document)).toBe(
        "Durable initial state",
      );

      const [inserted, deleted] = store.bodies.saves;
      expect(deleted!.baseSeq).toBe(1);
      expect(Buffer.from(deleted!.stateVector)).toEqual(
        Buffer.from(inserted!.stateVector),
      );
      expect(sha256(deleted!.state)).not.toBe(sha256(inserted!.state));
      const insertedAck = editor.acks.find(
        (ack) => ack.head.persisted_seq === 1,
      );
      const deletedAck = editor.acks.find(
        (ack) => ack.head.persisted_seq === 2,
      );
      expect(deletedAck!.head.state_vector).toBe(
        insertedAck!.head.state_vector,
      );
      expect(deletedAck!.delete_set_hash).not.toBe(
        insertedAck!.delete_set_hash,
      );
      // Every recipient gets the fingerprint a browser computes on its Y.Doc.
      await eventually(
        () =>
          peer.acks.find((ack) => ack.head.persisted_seq === 2)
            ?.delete_set_hash,
      ).toBe(deletedAck!.delete_set_hash);
      expect(fingerprintRoomDocumentDeletes(editor.document)).toBe(
        deletedAck!.delete_set_hash,
      );
      expect(store.bodies.head().persisted_seq).toBe(2);
      expect(firstParagraph(store.canonical())).toBe("Durable initial state");
    });

    it("retries a failed body load and then persists edits", async () => {
      const store = await startStatefulBodies({
        async onLoad(attempt) {
          if (attempt === 1) throw new Error("connection reset");
        },
      });
      const runtime = await startRuntime(store);

      const editor = await runtime.connect("human_a");

      expect(store.bodies.loads).toHaveLength(2);
      appendToFirstText(editor.document, " after authentication recovery");
      await eventually(() => editor.ackedSequences()).toEqual([1]);
      editor.provider.destroy();
      const reopened = await runtime.connect("human_a");
      expect(firstParagraph(reopened.document)).toBe(
        "Durable initial state after authentication recovery",
      );
      expect(firstParagraph(store.canonical())).toBe(
        "Durable initial state after authentication recovery",
      );
    });

    it("closes every connection TeamHub disconnects and refuses the stale tokens", async () => {
      const store = await startStatefulBodies();
      const runtime = await startRuntime(store);
      const owner = await runtime.connect("human_a");
      const member = await runtime.connect("human_b");
      appendToFirstText(owner.document, " before trash");
      await eventually(() => owner.ackedSequences()).toEqual([1]);

      // TeamHub committed the change, then asked the Runtime to disconnect.
      store.setPermissionCount(1);
      runtime.disconnect(documentId);

      await eventually(() => owner.closes).toEqual([
        { code: 1000, reason: "Document access changed" },
      ]);
      await eventually(() => member.closes).toEqual([
        { code: 1000, reason: "Document access changed" },
      ]);
      await expect(runtime.connect("human_a")).rejects.toThrow(
        "Authentication failed",
      );
      const reconnected = await runtime.connect("human_a", {
        permissionCount: 1,
      });
      expect(firstParagraph(reconnected.document)).toBe(
        "Durable initial state before trash",
      );
      expect(store.bodies.saves).toHaveLength(1);
    });

    it("closes only the named Actor's connections", async () => {
      const store = await startStatefulBodies();
      const runtime = await startRuntime(store);
      const revoked = await runtime.connect("human_a");
      const kept = await runtime.connect("human_b");

      runtime.disconnect(documentId, "actor_human_a");

      await eventually(() => revoked.closes).toEqual([
        { code: 1000, reason: "Document access changed" },
      ]);
      appendToFirstText(kept.document, " still editing");
      await eventually(() => kept.ackedSequences()).toEqual([1]);
      expect(kept.closes).toEqual([]);
    });

    it("refuses a connection whose body load was in flight when TeamHub disconnected", async () => {
      let commitPermissionChange = () => {};
      const store = await startStatefulBodies({
        async onLoad() {
          // The permission change commits while the body loads.
          commitPermissionChange();
        },
      });
      const runtime = await startRuntime(store);
      commitPermissionChange = () => runtime.disconnect(documentId);

      await expect(runtime.connect("human_a")).rejects.toThrow(
        "Authentication failed",
      );
    });

    type StatefulBodies = Awaited<ReturnType<typeof startStatefulBodies>>;

    async function startStatefulBodies(
      options: {
        onLoad?: (attempt: number) => Promise<void>;
      } = {},
    ) {
      const { bodies } = await memoryBodies();
      bodies.beforeLoad = async () => {
        await options.onLoad?.(bodies.loads.length);
      };
      const documents: Y.Doc[] = [];
      cleanups.push(() => {
        for (const document of documents) document.destroy();
      });
      return {
        bodies,
        // The saved body as a Y.Doc.
        canonical() {
          const document = bodies.document();
          documents.push(document);
          return document;
        },
        setPermissionCount(count: number) {
          bodies.rows.get(documentId)!.permissionCount = count;
        },
      };
    }

    async function startRuntime(store: StatefulBodies) {
      const realtime = await startRealtimeServer(store.bodies);
      const providers: HocuspocusProvider[] = [];
      cleanups.push(async () => {
        for (const provider of providers) provider.destroy();
        await realtime.destroy();
      });
      return {
        async connect(
          token: string,
          options: { syncTimeoutMs?: number; permissionCount?: number } = {},
        ) {
          const acks: DurableAck[] = [];
          const closes: Array<{ code: number; reason: string }> = [];
          let provider: HocuspocusProvider | undefined;
          const client = await connectRealtimeClient({
            token,
            url: wsUrl(realtime.address),
            permissionCount: options.permissionCount,
            ...(options.syncTimeoutMs === undefined
              ? {}
              : { syncTimeoutMs: options.syncTimeoutMs }),
            onProviderCreated: (created) => {
              provider = created;
              providers.push(created);
            },
            onClose: (event) => {
              // The provider reports its own disconnect afterwards; keep the server close.
              if (closes.length === 0)
                closes.push({ code: event.code, reason: event.reason });
              provider?.disconnect();
            },
            onStateless: (payload) => {
              const message = JSON.parse(payload) as DurableAck;
              if (message.type === "durability_ack") acks.push(message);
            },
          });
          return {
            ...client,
            acks,
            closes,
            ackedSequences: () => [
              ...new Set(
                acks
                  .map((ack) => ack.head.persisted_seq)
                  .filter((sequence) => sequence > 0),
              ),
            ],
          };
        },
        disconnect(id: string, actorId?: string) {
          realtime.disconnect(id, actorId);
        },
      };
    }
  },
);

interface DurableAck {
  type: string;
  delete_set_hash: string;
  head: { persisted_seq: number; state_vector: string };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function firstParagraph(document: Y.Doc): string {
  const [block] = readRoomDocumentBlocks(Y.encodeStateAsUpdate(document));
  const content = (block?.content ?? []) as Array<{ text?: string }>;
  return content.map((part) => part.text ?? "").join("");
}

function deleteFromFirstTextEnd(document: Y.Doc, value: string): void {
  const pending: Array<Y.XmlElement | Y.XmlFragment> = [
    document.getXmlFragment("prosemirror"),
  ];
  while (pending.length > 0) {
    for (const child of pending.pop()!.toArray()) {
      if (child instanceof Y.XmlText) {
        if (!child.toString().endsWith(value)) {
          throw new Error(`First text does not end with ${value}`);
        }
        child.delete(child.length - value.length, value.length);
        return;
      }
      if (child instanceof Y.XmlElement) pending.push(child);
    }
  }
  throw new Error("Expected a BlockNote text node");
}
