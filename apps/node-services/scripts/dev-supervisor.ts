import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const hostEntryPoint = path.join(packageRoot, "src/main.ts");
const featureCatalogGenerator = path.join(
  packageRoot,
  "scripts/generate-feature-catalog.ts",
);

type NodeServicesChild = Pick<ChildProcess, "kill" | "off" | "once">;

/**
 * `pnpm dev` runs Node Services through this supervisor: it waits for TeamHub,
 * which the Agent Service needs at startup, and restarts the process after a
 * crash instead of letting `concurrently` stop the whole stack. It does not
 * watch files, so an edit never interrupts a running Wiki generation.
 */
export interface NodeServicesDevSupervisorOptions {
  signal: AbortSignal;
  spawnNodeServices?: () => NodeServicesChild;
  waitForTeamHub?: (signal: AbortSignal) => Promise<void>;
  waitBeforeRestart?: (signal: AbortSignal) => Promise<void>;
  /**
   * Regenerates the static agent-features manifest before each (re)start so
   * restarts after adding or removing a feature directory always spawn the
   * Agent Service against the current catalog.
   */
  refreshFeatureCatalog?: (signal: AbortSignal) => Promise<void>;
}

export async function superviseNodeServicesDevelopment(
  options: NodeServicesDevSupervisorOptions,
): Promise<void> {
  const spawnNodeServices =
    options.spawnNodeServices ?? defaultSpawnNodeServices;
  const waitForTeamHub =
    options.waitForTeamHub ??
    ((signal) => waitForTeamHubHealth(readTeamHubHealthUrl(), signal));
  const waitBeforeRestart =
    options.waitBeforeRestart ?? ((signal) => delay(500, signal));
  const refreshFeatureCatalog =
    options.refreshFeatureCatalog ?? generateFeatureCatalog;

  while (!options.signal.aborted) {
    await waitForTeamHub(options.signal);
    if (options.signal.aborted) return;

    await refreshFeatureCatalog(options.signal);
    if (options.signal.aborted) return;

    const result = await waitForChildExit(spawnNodeServices(), options.signal);
    if (options.signal.aborted) return;

    const reason = result.error
      ? result.error.message
      : `exit code ${String(result.code)}${result.signal ? ` (${result.signal})` : ""}`;
    console.error(
      `[node-services] Node Services stopped with ${reason}; restarting.`,
    );
    await waitBeforeRestart(options.signal);
  }
}

export async function waitForTeamHubHealth(
  healthUrl: string,
  signal: AbortSignal,
  options: {
    fetcher?: typeof fetch;
    retryDelayMs?: number;
    requestTimeoutMs?: number;
    sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  } = {},
): Promise<void> {
  const fetcher = options.fetcher ?? fetch;
  const retryDelayMs = options.retryDelayMs ?? 500;
  const requestTimeoutMs = options.requestTimeoutMs ?? 1_000;
  const sleep = options.sleep ?? delay;

  while (!signal.aborted) {
    try {
      const response = await fetcher(healthUrl, {
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(requestTimeoutMs),
        ]),
      });
      if (response.ok) return;
    } catch {
      // TeamHub is still starting or reloading.
    }

    await sleep(retryDelayMs, signal);
  }
}

function defaultSpawnNodeServices(): NodeServicesChild {
  return spawn(process.execPath, ["--import", "tsx", hostEntryPoint], {
    cwd: packageRoot,
    stdio: "inherit",
  });
}

// Runs as its own process, like Node Services, so this supervisor keeps only
// built-in imports. Its notes go to stderr; stdout belongs to Node Services.
// The desktop's offline runtime ships main.ts compiled beside this file, with
// its feature catalog built in (apps/desktop/scripts/build-native-runtime.mjs).
// It stays in this process's directory, the checkout, against which the
// bundle resolves relative settings.
function spawnCompiledNodeServices(): NodeServicesChild {
  return spawn(
    process.execPath,
    ["--conditions=linger-production", path.join(packageRoot, "dist/main.js")],
    { stdio: "inherit", windowsHide: true },
  );
}

async function generateFeatureCatalog(signal: AbortSignal): Promise<void> {
  const result = await waitForChildExit(
    spawn(process.execPath, ["--import", "tsx", featureCatalogGenerator], {
      cwd: packageRoot,
      stdio: ["ignore", 2, 2],
    }),
    signal,
  );
  if (signal.aborted) return;
  if (result.error) throw result.error;
  if (result.code !== 0) {
    throw new Error(
      `agent-features catalog generation exited with code ${String(result.code)}`,
    );
  }
}

function readTeamHubHealthUrl(): string {
  // Same single-host default as the Agent Service itself; tests run this
  // script without the service sources beside it.
  const baseUrl =
    process.env.TEAMHUB_BASE_URL?.trim() || "http://127.0.0.1:8080";
  return new URL("healthz", `${baseUrl.replace(/\/$/, "")}/`).toString();
}

function waitForChildExit(
  child: NodeServicesChild,
  signal: AbortSignal,
): Promise<{
  code: number | null;
  error?: Error;
  signal: NodeJS.Signals | null;
}> {
  return new Promise((resolve) => {
    const finish = (result: {
      code: number | null;
      error?: Error;
      signal: NodeJS.Signals | null;
    }): void => {
      child.off("error", onError);
      child.off("exit", onExit);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onError = (error: Error): void => {
      finish({ code: null, error, signal: null });
    };
    const onExit = (
      code: number | null,
      exitSignal: NodeJS.Signals | null,
    ): void => {
      finish({ code, signal: exitSignal });
    };
    const onAbort = (): void => {
      child.kill("SIGTERM");
    };

    child.once("error", onError);
    child.once("exit", onExit);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    const onAbort = (): void => finish();

    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function main(): Promise<void> {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  await superviseNodeServicesDevelopment({
    signal: controller.signal,
    ...(process.argv.includes("--compiled") && {
      spawnNodeServices: spawnCompiledNodeServices,
      refreshFeatureCatalog: async () => {},
    }),
  });
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
