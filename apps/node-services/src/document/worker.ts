import { join } from "node:path";
import { parentPort } from "node:worker_threads";

import { getRequestListener } from "@hono/node-server";

import { createDocumentRuntimeApp } from "./app.js";
import { createDocumentBodyStore } from "./bodies.js";
import { createDocumentComputationPool } from "./computation-pool.js";
import { createDocumentRealtimeServer } from "./realtime.js";
import { drainDocumentRuntime } from "./shutdown.js";
import {
  DOCUMENT_RUNTIME_DEFAULT_ADDRESS,
  readListenAddress,
} from "../listen-address.js";
import { mirrorHome } from "../paths.js";
import { serviceCredential } from "@linger/service-kit/node";
import { documentLogger } from "./log.js";

// Half of the host's 20 s default, so the roles that stop after the Document
// Runtime still have time.
const shutdownTimeoutMs = 10_000;

// The host starts this module on its own thread through main.ts, so the jsdom
// globals and the Request/Response replacement stay out of the other roles.
const host = parentPort;
if (host === null) {
  throw new Error("Document Runtime must run in a worker thread");
}

const { host: hostname, port } = readListenAddress(
  process.env,
  "DOCUMENT_RUNTIME_HTTP_ADDRESS",
  DOCUMENT_RUNTIME_DEFAULT_ADDRESS,
);
const teamHubToken = serviceCredential("node-services-internal", process.env);
const connectionTokenKey = serviceCredential(
  "document-connection-token",
  process.env,
);
if (!teamHubToken || !connectionTokenKey) {
  throw new TypeError("LINGER_SECRET_SEED is required");
}
// The Runtime saves Document bodies in TeamHub's database.
const databaseUrl = process.env.TEAMHUB_DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new TypeError("TEAMHUB_DATABASE_URL is required");
}
const bodies = createDocumentBodyStore(databaseUrl);
const runtimeInstanceId = "document_runtime_primary";
const computationWorkers = 1;
const server = createDocumentRealtimeServer({
  failureEvidenceDirectory: join(
    mirrorHome(),
    "document-runtime",
    "failure-evidence",
  ),
  bodies,
  connectionTokenKey,
  hostname,
  port,
  runtimeInstanceId,
});
const computation = createDocumentComputationPool({
  size: computationWorkers,
  reportError: (message) =>
    documentLogger().log("error", "document.computation_pool_error", {
      message,
    }),
});
const app = createDocumentRuntimeApp({
  changes: server.changes,
  computation,
  disconnect: (documentId, actorId) => server.disconnect(documentId, actorId),
  teamHubToken,
});
server.httpServer.removeAllListeners("request");
const listener = getRequestListener(app.fetch);
server.httpServer.on("request", (request, response) => {
  void listener(request, response);
});
await server.listen();
documentLogger().log("info", "document.listening", {
  url: `http://${hostname}:${server.address.port}`,
});
void bodies.recordUnrecordedPoints().then(
  (documents) =>
    documentLogger().log("info", "document.unrecorded_points_armed", {
      documents,
    }),
  (error: unknown) =>
    documentLogger().log("warn", "document.unrecorded_points_failed", {
      error_name: error instanceof Error ? error.name : "unknown",
    }),
);

// The host asks for one drain and terminates the thread after the reply.
host.once("message", () => {
  void drainDocumentRuntime({
    runtime: server,
    timeoutMs: shutdownTimeoutMs,
    reportError: (message) =>
      documentLogger().log("error", "document.shutdown_error", { message }),
  })
    .then(async (status) => {
      await bodies.close();
      return status;
    })
    .then((status) => host.postMessage(status));
});
host.postMessage("listening");
