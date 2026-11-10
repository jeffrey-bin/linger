import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonLogger } from "@linger/service-kit/node";
import type { HttpHost } from "../http-host.js";
import {
  installModelPackages,
  modelPackageNames,
  modelPackagesInstalled,
  modelPackagesRoot,
} from "../model-packages.js";

export type VoiceWorker = "asr" | "recorder" | "live";
export const voiceWorkerPorts = {
  asr: 4324,
  recorder: 4325,
  live: 4326,
} as const;
// LiveKit drains for 2 s, then allows jobs 68 s to save their final media.
export const VOICE_DRAIN_MS = 72_000;

/** Soniox runs transcription and recording; xAI runs Live on its own. */
export function selectedVoiceWorkers(env: NodeJS.ProcessEnv): VoiceWorker[] {
  return [
    ...(env.SONIOX_API_KEY?.trim() ? (["asr", "recorder"] as const) : []),
    ...(env.XAI_API_KEY?.trim() ? (["live"] as const) : []),
  ];
}

/** Separate processes keep inference, recording and Agent work off each other's
 * event loops. Only the failed worker restarts; accepted Tasks belong to TeamHub. */
export async function startVoiceService(options: {
  logger: JsonLogger;
  http: HttpHost;
  environment?: NodeJS.ProcessEnv;
  spawnWorker?: (worker: VoiceWorker) => ChildProcess;
  installModels?: () => Promise<void>;
}) {
  const env = options.environment ?? process.env;
  const workers = selectedVoiceWorkers(env);
  // The VAD model's native package, when the runtime ships it separately: the
  // workers wait for its first download and find it on NODE_PATH.
  const models = modelPackageNames("voice");
  const install =
    options.installModels ?? (() => installModelPackages(models, env));
  const modelPath = models.length
    ? {
        NODE_PATH: [modelPackagesRoot(env), env.NODE_PATH]
          .filter(Boolean)
          .join(path.delimiter),
      }
    : {};
  let stopping = false;
  const entries = new Map<
    VoiceWorker,
    {
      child?: ChildProcess;
      exited?: Promise<void>;
      retry?: NodeJS.Timeout;
      failures: number;
    }
  >();
  const launch =
    options.spawnWorker ??
    ((worker: VoiceWorker) => {
      const entry = fileURLToPath(
        import.meta.resolve("@linger/voice-runtime/worker"),
      );
      return spawn(
        process.execPath,
        [
          ...(entry.endsWith(".ts")
            ? ["--import", "tsx"]
            : ["--conditions=linger-production"]),
          entry,
          "start",
          ...(worker === "asr" ? [] : [`--${worker}`]),
        ],
        {
          env: {
            ...env,
            ...modelPath,
            VOICE_WORKER_PORT: String(voiceWorkerPorts[worker]),
          },
          stdio: ["ignore", "inherit", "inherit", "ipc"],
          detached: process.platform !== "win32",
        },
      );
    });
  const killGroup = (child: ChildProcess) => {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH")
        options.logger.log("error", "voice.worker_cleanup_failed", { error });
    }
  };
  const start = (worker: VoiceWorker) => {
    if (stopping) return;
    const entry = entries.get(worker) ?? { failures: 0 };
    entries.set(worker, entry);
    const startedAt = Date.now();
    if (!modelPackagesInstalled(models, env)) {
      install().then(() => start(worker), restart);
      return;
    }
    let child: ChildProcess;
    try {
      child = launch(worker);
    } catch (error) {
      restart(error);
      return;
    }
    entry.child = child;
    entry.exited = new Promise<void>((resolve) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        entry.child = undefined;
        killGroup(child);
        resolve();
        if (!stopping) restart(error);
      };
      child.once("error", finish);
      child.once("exit", (code, signal) => finish({ code, signal }));
    });
    function restart(error: unknown) {
      options.logger.log("warn", "voice.worker_restarting", { worker, error });
      entry.failures = Date.now() - startedAt > 60_000 ? 0 : entry.failures + 1;
      entry.retry = setTimeout(
        () => start(worker),
        Math.min(30_000, 1_000 * 2 ** Math.min(entry.failures - 1, 5)),
      );
    }
  };
  for (const worker of workers) start(worker);
  // Readiness may fail while media reconnects; liveness continues to keep the
  // Agent and other media workers running. No provider credentials are returned.
  const unmount = options.http.mount({
    prefixes: ["/voice/health"],
    fetch: () => Response.json({ workers }),
    readiness: async () => {
      const results = await Promise.all(
        workers.map(async (worker) => {
          if (!entries.get(worker)?.child) return false;
          try {
            return (
              await fetch(`http://127.0.0.1:${voiceWorkerPorts[worker]}/`, {
                signal: AbortSignal.timeout(1_000),
              })
            ).ok;
          } catch {
            return false;
          }
        }),
      );
      return results.every(Boolean)
        ? { ready: true }
        : { ready: false, reason: "voice_worker_reconnecting" };
    },
  });
  return {
    async stop() {
      stopping = true;
      unmount();
      // Signal all workers together, so recorder flushing never waits for ASR.
      await Promise.all(
        [...entries.values()].map(async (entry) => {
          clearTimeout(entry.retry);
          const child = entry.child;
          if (!child) return;
          const timer = setTimeout(() => killGroup(child), VOICE_DRAIN_MS);
          child.kill("SIGTERM");
          try {
            await entry.exited;
          } finally {
            clearTimeout(timer);
          }
        }),
      );
    },
  };
}
