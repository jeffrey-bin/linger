import { fileURLToPath } from "node:url";

import { cli, ServerOptions, WorkerPermissions } from "@livekit/agents";

import {
  calculateWorkerLoad,
  healthPort,
  loadConfig,
  maxSessions,
} from "./config.js";

const config = loadConfig();
// Node Services supervises separate ASR, recorder and Live worker processes.
const recorder = process.argv.includes("--recorder");
const live = process.argv.includes("--live");
if (live && recorder) throw new Error("Worker roles are exclusive");
const production = process.env.NODE_ENV === "production";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // A supervisor crash closes IPC; flush recording before the replacement starts.
  if (process.connected)
    process.once("disconnect", () => process.kill(process.pid, "SIGTERM"));
  // The LiveKit CLI rejects options it does not define.
  process.argv = process.argv.filter(
    (argument) => argument !== "--recorder" && argument !== "--live",
  );
  const agentFile = recorder ? "recorder-agent" : live ? "live-agent" : "agent";
  const agentModule = import.meta.url.endsWith(".ts")
    ? `./${agentFile}.ts`
    : `./${agentFile}.js`;
  cli.runApp(
    new ServerOptions({
      agent: fileURLToPath(new URL(agentModule, import.meta.url)),
      wsURL: config.livekitUrl,
      apiKey: config.livekitApiKey,
      apiSecret: config.livekitApiSecret,
      agentName: recorder
        ? "linger-voice-recorder"
        : live
          ? "linger-live-runtime"
          : "linger-voice-runtime",
      loadFunc: async (worker) =>
        calculateWorkerLoad(worker.activeJobs.length, maxSessions),
      loadThreshold: 1,
      numIdleProcesses: 1,
      initializeProcessTimeout: config.initializeProcessTimeoutMs,
      // The image listens on every interface so its published port and
      // orchestrator probes reach the health endpoint.
      host: production ? "0.0.0.0" : "127.0.0.1",
      port: healthPort,
      // Only Live publishes audio/data. ASR and recorder remain subscription-only.
      permissions: new WorkerPermissions(live, true, live, true, [], false),
      production,
      // Room jobs are session-long, so rolling restarts must stop them instead
      // of waiting for natural completion. Keep enough time for ASR callback
      // flushing while remaining inside the container's 75 second stop grace.
      drainTimeout: 2_000,
      shutdownProcessTimeout: 68_000,
      // No logLevel: the CLI sets it from `--log-level` (info for `start`).
    }),
  );
}
