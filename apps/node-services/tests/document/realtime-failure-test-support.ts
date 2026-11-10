import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { expect } from "vitest";
import * as Y from "yjs";

import {
  appendToFirstText,
  connectRealtimeClient,
  memoryBodies,
  startRealtimeServer,
  wsUrl,
} from "./realtime-test-support.js";

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Exercise real session recovery, mutation preflight and unload through WS/HTTP.
export async function failedSaveHarness(
  options: { holdReferenceCheck?: boolean } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "runtime-failure-test-"));
  const { bodies, initial } = await memoryBodies();
  const saveStarted = deferred();
  const rejectSave = deferred();
  const referenceCheckStarted = deferred();
  const releaseReferenceCheck = deferred();
  let acceptSaves = false;
  bodies.beforeCheckReferences = async () => {
    if (options.holdReferenceCheck) {
      referenceCheckStarted.resolve();
      await releaseReferenceCheck.promise;
    }
    return "available" as const;
  };
  bodies.beforeSave = async (save) => {
    saveStarted.resolve();
    // A stale base and an accepted save follow the table's own rules.
    if (acceptSaves || bodies.head().persisted_seq !== save.baseSeq) return;
    await rejectSave.promise;
    return { kind: "rejected" };
  };
  const realtime = await startRealtimeServer(bodies, {
    failureEvidenceDirectory: directory,
  });
  let unloaded = false;
  realtime.configuration.extensions.push({
    afterUnloadDocument: async () => {
      unloaded = true;
    },
  });
  const providers: HocuspocusProvider[] = [];
  const clients: Y.Doc[] = [];
  const open = async (token: string, document?: Y.Doc) => {
    const events: Array<{
      type: string;
      code?: string | number;
      reason?: string;
      head?: ReturnType<typeof bodies.head>;
    }> = [];
    let provider!: HocuspocusProvider;
    const client = await connectRealtimeClient({
      token,
      document,
      url: wsUrl(realtime.address),
      onProviderCreated: (value) => {
        provider = value;
        providers.push(value);
      },
      onStateless: (payload) => {
        events.push(JSON.parse(payload));
      },
      onClose: (event) => {
        events.push({ type: "close", code: event.code, reason: event.reason });
        provider.disconnect();
      },
    });
    clients.push(client.document);
    return { ...client, events };
  };
  const fail = async (client: Awaited<ReturnType<typeof open>>) => {
    appendToFirstText(client.document, " unsaved client content");
    await saveStarted.promise;
    rejectSave.resolve();
    await expect
      .poll(() =>
        client.events.some((event) => event.type === "durability_failure"),
      )
      .toBe(true);
  };
  return {
    directory,
    initial,
    bodies,
    head: () => bodies.head(),
    realtime,
    open,
    fail,
    unloaded: () => unloaded,
    saves: bodies.saves,
    saveStarted,
    rejectSave,
    referenceCheckStarted,
    releaseReferenceCheck,
    // Saves a change to the body as another writer would.
    advanceHead() {
      return bodies.commitServerChange((document) =>
        appendToFirstText(document, " canonical advance"),
      );
    },
    acceptSaves() {
      acceptSaves = true;
    },
    async close() {
      rejectSave.resolve();
      releaseReferenceCheck.resolve();
      for (const provider of providers) provider.destroy();
      await realtime.destroy();
      for (const doc of clients) doc.destroy();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
