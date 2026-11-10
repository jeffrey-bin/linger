import {
  inspectRoomDocumentState,
  ROOM_DOCUMENT_SESSION_LIMITS,
} from "@linger/document-model";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { stateBundleFits } from "../../src/document/realtime-recovery-budget.js";

import {
  addCommentMarkToFirstText,
  appendToFirstText,
  connectRealtimeClient,
  createInitialState,
  documentId,
  memoryBodies,
  MemoryDocumentBodies,
  startRealtimeServer,
  wsUrl,
} from "./realtime-test-support.js";

describe("Document Runtime mutation preflight", () => {
  it("rejects a mutation before saving when its recovery bundle would exceed the session limit", async () => {
    const bodies = new MemoryDocumentBodies();
    bodies.put(await initialStateNearBundleLimit());
    let observeSave!: () => void;
    const saveAttempted = new Promise<"save">((resolve) => {
      observeSave = () => resolve("save");
    });
    bodies.beforeSave = () => observeSave();
    const realtime = await startRealtimeServer(bodies);
    let resolveClosed!: () => void;
    const closed = new Promise<"closed">((resolve) => {
      resolveClosed = () => resolve("closed");
    });
    const editor = await connectRealtimeClient({
      token: "oversized_recovery_editor",
      url: wsUrl(realtime.address),
      onClose: () => resolveClosed(),
      syncTimeoutMs: 20_000,
    });
    const observer = await connectRealtimeClient({
      token: "oversized_recovery_observer",
      url: wsUrl(realtime.address),
      syncTimeoutMs: 20_000,
    });
    const observerBefore = Y.encodeStateAsUpdate(observer.document);

    try {
      appendToFirstText(editor.document, "x".repeat(4_096));

      await expect(
        Promise.race([closed, saveAttempted, timeoutOutcome(10_000)]),
      ).resolves.toBe("closed");
      expect(bodies.saves).toHaveLength(0);
      // Compare the 16 MiB states as bytes; a structural diff walks every index.
      expect(
        Buffer.from(Y.encodeStateAsUpdate(observer.document)).equals(
          Buffer.from(observerBefore),
        ),
      ).toBe(true);
    } finally {
      editor.provider.destroy();
      observer.provider.destroy();
      await realtime.destroy();
    }
  });

  it("persists the admitted inbound update when Yjs emits a normalized applied update", async () => {
    const { bodies, initial } = await memoryBodies();
    bodies.knownThreads.add("document_thread_normalized_1");
    const realtime = await startRealtimeServer(bodies);
    const client = await connectRealtimeClient({
      token: "human_normalized_update",
      url: wsUrl(realtime.address),
    });
    const expanded = new Y.Doc({ gc: true });
    Y.applyUpdate(expanded, initial.stateBytes);
    addCommentMarkToFirstText(expanded, "document_thread_normalized_1");
    const inboundUpdate = Y.encodeStateAsUpdate(expanded);

    try {
      client.provider.documentUpdateHandler(inboundUpdate, null);
      await waitFor(() => bodies.saves.length === 1);

      const persisted = new Y.Doc({ gc: true });
      Y.applyUpdate(persisted, bodies.saves[0]!.state);
      expect(Y.encodeStateVector(persisted)).toEqual(
        Y.encodeStateVector(expanded),
      );
      persisted.destroy();
    } finally {
      expanded.destroy();
      client.provider.destroy();
      await realtime.destroy();
    }
  });

  it("checks only a new Comment Thread ref, then broadcasts and persists it", async () => {
    const { bodies } = await memoryBodies();
    bodies.knownThreads.add("document_thread_comment_1");
    const realtime = await startRealtimeServer(bodies);
    const first = await connectRealtimeClient({
      token: "human_comment_a",
      url: wsUrl(realtime.address),
    });
    const second = await connectRealtimeClient({
      token: "human_comment_b",
      url: wsUrl(realtime.address),
    });
    const peerBefore = Y.encodeStateAsUpdate(second.document);

    try {
      addCommentMarkToFirstText(first.document, "document_thread_comment_1");
      await waitFor(() => bodies.saves.length === 1);

      const references = {
        assetIds: [],
        threadIds: ["document_thread_comment_1"],
      };
      expect(bodies.referenceChecks).toEqual([{ documentId, ...references }]);
      expect(bodies.saves[0]).toMatchObject({
        editorIds: ["actor_human_comment_a"],
        ...references,
      });
      expect(Y.encodeStateAsUpdate(second.document)).not.toEqual(peerBefore);
      expect(
        inspectRoomDocumentState(Y.encodeStateAsUpdate(second.document))
          .completeReferences.documentThreadIds,
      ).toEqual(["document_thread_comment_1"]);

      // The reference is now known: later frames that keep it do not ask.
      appendToFirstText(second.document, " typed");
      await waitFor(() => bodies.saves.length === 2);
      expect(bodies.referenceChecks).toHaveLength(1);
      expect(bodies.saves[1]).toMatchObject({
        editorIds: ["actor_human_comment_b"],
        ...references,
      });
    } finally {
      first.provider.destroy();
      second.provider.destroy();
      await realtime.destroy();
    }
  });

  it("reads nothing from the database for typing frames", async () => {
    const { bodies } = await memoryBodies();
    const realtime = await startRealtimeServer(bodies);
    const editor = await connectRealtimeClient({
      token: "typist",
      url: wsUrl(realtime.address),
    });
    const observer = await connectRealtimeClient({
      token: "observer",
      url: wsUrl(realtime.address),
    });
    try {
      for (let frame = 0; frame < 20; frame += 1) {
        appendToFirstText(editor.document, "k");
      }
      await waitFor(() =>
        observer.document
          .getXmlFragment("prosemirror")
          .toJSON()
          .includes("k".repeat(20)),
      );
      expect(bodies.loads).toHaveLength(2);
      expect(bodies.referenceChecks).toEqual([]);
    } finally {
      editor.provider.destroy();
      observer.provider.destroy();
      await realtime.destroy();
    }
  });

  it("serializes mutations from different connections through one Document queue", async () => {
    const { bodies } = await memoryBodies();
    let observeValidation!: () => void;
    const validationObserved = new Promise<void>((resolve) => {
      observeValidation = resolve;
    });
    let releaseValidation!: () => void;
    const validationRelease = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    bodies.beforeCheckReferences = async () => {
      observeValidation();
      await validationRelease;
      return "available" as const;
    };
    const realtime = await startRealtimeServer(bodies);
    const first = await connectRealtimeClient({
      token: "human_a",
      url: wsUrl(realtime.address),
    });
    const second = await connectRealtimeClient({
      token: "human_b",
      url: wsUrl(realtime.address),
    });

    try {
      addCommentMarkToFirstText(first.document, "document_thread_queued_1");
      await Promise.race([validationObserved, rejectAfter(2_000)]);
      appendToFirstText(second.document, " second");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(
        first.document.getXmlFragment("prosemirror").toJSON(),
      ).not.toContain(" second");

      releaseValidation();
      await waitFor(() =>
        first.document
          .getXmlFragment("prosemirror")
          .toJSON()
          .includes(" second"),
      );
    } finally {
      releaseValidation();
      first.provider.destroy();
      second.provider.destroy();
      await realtime.destroy();
    }
  });

  it("does not apply or broadcast a mutation whose new reference is unknown", async () => {
    const { bodies } = await memoryBodies();
    let validationObserved!: () => void;
    const validationAttempted = new Promise<"validation">((resolve) => {
      validationObserved = () => resolve("validation");
    });
    bodies.beforeCheckReferences = () => {
      validationObserved();
    };
    const realtime = await startRealtimeServer(bodies);
    const first = await connectRealtimeClient({
      token: "human_a",
      url: wsUrl(realtime.address),
    });
    const second = await connectRealtimeClient({
      token: "human_b",
      url: wsUrl(realtime.address),
    });
    const secondBefore = Y.encodeStateAsUpdate(second.document);
    const peerUpdate = new Promise<"broadcast">((resolve) => {
      second.document.once("update", () => resolve("broadcast"));
    });

    try {
      addCommentMarkToFirstText(first.document, "document_thread_foreign");

      await expect(
        Promise.race([validationAttempted, peerUpdate, timeoutOutcome(2_000)]),
      ).resolves.toBe("validation");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(bodies.referenceChecks).toHaveLength(1);
      expect(Y.encodeStateAsUpdate(second.document)).toEqual(secondBefore);
    } finally {
      first.provider.destroy();
      second.provider.destroy();
      await realtime.destroy();
    }
  });
});

// The initial state leaves 1 KiB of the state bundle budget, so appending 4 KiB
// of text crosses it.
async function initialStateNearBundleLimit() {
  const initial = await createInitialState();
  const document = new Y.Doc({ gc: true });
  Y.applyUpdate(document, initial.stateBytes);
  const referenceBytes = Buffer.byteLength(
    JSON.stringify({ document_asset_ids: [], document_thread_ids: [] }),
  );
  const used =
    Y.encodeStateAsUpdate(document).byteLength +
    Y.encodeStateVector(document).byteLength +
    referenceBytes;
  appendToFirstText(
    document,
    "x".repeat(
      ROOM_DOCUMENT_SESSION_LIMITS.state_bundle_decoded_bytes - used - 1_024,
    ),
  );
  const stateBytes = Y.encodeStateAsUpdate(document);
  const stateVector = Y.encodeStateVector(document);
  document.destroy();
  const references = { documentAssetIds: [], documentThreadIds: [] };
  const fits = (extraBytes: number) =>
    stateBundleFits({
      stateBytes: stateBytes.byteLength + extraBytes,
      stateVectorBytes: stateVector.byteLength,
      references,
      limit: ROOM_DOCUMENT_SESSION_LIMITS.state_bundle_decoded_bytes,
    });
  expect(fits(0)).toBe(true);
  expect(fits(4_096)).toBe(false);
  return { stateBytes, stateVector };
}

function timeoutOutcome(milliseconds: number): Promise<"timeout"> {
  return new Promise((resolve) => {
    setTimeout(() => resolve("timeout"), milliseconds);
  });
}

function rejectAfter(milliseconds: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(
      () => reject(new Error("Timed out waiting for reference validation")),
      milliseconds,
    );
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for mutation queue");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
