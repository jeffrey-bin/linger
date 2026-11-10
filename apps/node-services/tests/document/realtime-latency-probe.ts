// Manual latency probe, not part of CI. From apps/node-services:
//   node --import tsx tests/document/realtime-latency-probe.ts [MiB ...]
// For each Document size (default 1 and 8 MiB) one client types a character at
// a time through the real Runtime against an in-memory body store. It prints
// how long each frame takes to reach a second client and how long /readyz takes
// to answer meanwhile.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { getRequestListener } from "@hono/node-server";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { materializeRoomDocument } from "@linger/document-model";
import * as Y from "yjs";

import { createDocumentRuntimeApp } from "../../src/document/app.js";
import { createDocumentRealtimeServer } from "../../src/document/realtime.js";
import { installDocumentRuntimeDOM } from "../../src/document/server-dom.js";
import {
  connectionTokenKey,
  MemoryDocumentBodies,
  signConnectionToken,
} from "./realtime-test-support.js";

const documentId = "document_latency_probe";
const token = "latency-probe-token";
const frames = 200;
const sizes = process.argv.slice(2).map(Number);

installDocumentRuntimeDOM();
for (const mebibytes of sizes.length > 0 ? sizes : [1, 8]) {
  assert.ok(mebibytes > 0 && mebibytes <= 12, "sizes are 1 to 12 MiB");
  console.log(JSON.stringify(await probe(mebibytes)));
}

async function probe(mebibytes: number) {
  // Paragraphs of 2 KiB keep the block count under its limit.
  const paragraph = "x".repeat(2047);
  const source = Array.from(
    { length: Math.ceil((mebibytes << 20) / 2048) },
    () => paragraph,
  ).join("\n");
  const initial = await materializeRoomDocument({
    materializationId: "realtime-latency-probe",
    schemaVersion: 1,
    sourceKind: "plain_text",
    sourceBytes: Buffer.from(source),
  });
  const bodies = new MemoryDocumentBodies();
  bodies.put(initial, { documentId });
  const realtime = createDocumentRealtimeServer({
    runtimeInstanceId: "document_runtime_probe",
    bodies,
    connectionTokenKey,
  });
  const app = createDocumentRuntimeApp({
    teamHubToken: token,
    computation: {
      run: () => Promise.reject(new Error("The probe computes nothing")),
      close: () => Promise.resolve(),
    },
  });
  const listener = getRequestListener(app.fetch);
  realtime.httpServer.removeAllListeners("request");
  realtime.httpServer.on("request", (request, response) => {
    void listener(request, response);
  });
  await realtime.listen();
  const port = realtime.address.port;
  const editor = await connect(port, "editor");
  const reader = await connect(port, "reader");

  const readyz: number[] = [];
  let typing = true;
  const readinessProbe = (async () => {
    while (typing) {
      const started = performance.now();
      const response = await fetch(`http://127.0.0.1:${port}/readyz`);
      await response.arrayBuffer();
      readyz.push(performance.now() - started);
      await delay(20);
    }
  })();
  const frameLatencies: number[] = [];
  const typed = firstText(editor.document);
  const seen = firstText(reader.document);
  for (let frame = 0; frame < frames; frame += 1) {
    const length = seen.length;
    const started = performance.now();
    typed.insert(typed.length, "y");
    while (seen.length === length) await delay(1);
    frameLatencies.push(performance.now() - started);
  }
  typing = false;
  await readinessProbe;

  editor.provider.destroy();
  reader.provider.destroy();
  await realtime.destroy();
  return {
    state_mib: +(initial.stateBytes.byteLength / (1 << 20)).toFixed(2),
    frames,
    frame_ms: percentiles(frameLatencies),
    readyz_ms: percentiles(readyz),
  };
}

async function connect(port: number, actor: string) {
  const document = new Y.Doc({ gc: true });
  let provider!: HocuspocusProvider;
  await new Promise<void>((resolve, reject) => {
    provider = new HocuspocusProvider({
      document,
      name: documentId,
      token: signConnectionToken({ actorKey: actor, expiresInMs: 3_600_000 }),
      url: `ws://127.0.0.1:${port}`,
      onAuthenticationFailed: ({ reason }) => reject(new Error(reason)),
      onSynced: () => resolve(),
    });
  });
  return { document, provider };
}

function firstText(document: Y.Doc): Y.XmlText {
  const pending: Array<Y.XmlElement | Y.XmlFragment> = [
    document.getXmlFragment("prosemirror"),
  ];
  while (pending.length > 0) {
    for (const child of pending.shift()!.toArray()) {
      if (child instanceof Y.XmlText) return child;
      if (child instanceof Y.XmlElement) pending.push(child);
    }
  }
  throw new Error("The probe Document has no text");
}

function percentiles(samples: number[]) {
  const sorted = [...samples].sort((left, right) => left - right);
  const at = (quantile: number) =>
    +sorted[
      Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))
    ]!.toFixed(1);
  return {
    count: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: +sorted.at(-1)!.toFixed(1),
  };
}
