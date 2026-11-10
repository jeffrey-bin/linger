import { createHash } from "node:crypto";
import { access, lstat, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { atomicPrivate, readPrivate, type Instance } from "./instance.js";
import { runProcess } from "./process.js";
import path from "node:path";
import { localModelsEnvironment } from "./local-models.js";
import {
  inspectSelectedRuntimeDescriptors,
  runtimeEnvironmentFromDescriptors,
} from "./managed-runtimes.js";
import { managedRuntimeEnvironment } from "./managed-codex.js";

export interface ComputerInspection {
  connected: boolean;
  state: "ready" | "action_required" | "offline";
  detail: string;
  runtimes: unknown[];
  activeOperations: number;
}
const empty = (
  state: ComputerInspection["state"],
  detail: string,
): ComputerInspection => ({
  state,
  detail,
  runtimes: [],
  activeOperations: -1,
  connected: false,
});
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
async function configured(instance: Instance): Promise<boolean> {
  try {
    const info = await lstat(instance.computerConfig);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Unsafe Computer config");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function runtimePath(instance: Instance): Promise<string> {
  const directories = [path.dirname(process.execPath)];
  const bundled = path.join(
    path.dirname(instance.computerExecutable),
    "runtime",
    "bin",
  );
  const node = path.join(
    bundled,
    process.platform === "win32" ? "node.exe" : "node",
  );
  try {
    const info = await lstat(node);
    if (info.isFile() && !info.isSymbolicLink()) {
      await access(node, constants.X_OK);
      directories.unshift(bundled);
    }
  } catch (error) {
    if (
      !["ENOENT", "EACCES"].includes(
        String((error as NodeJS.ErrnoException).code),
      )
    )
      throw error;
  }
  return [
    ...new Set([
      ...directories,
      ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean),
    ]),
  ].join(path.delimiter);
}
async function environment(instance: Instance): Promise<NodeJS.ProcessEnv> {
  // Preserve ordinary discovery while explicit bindings belong only to the selected Harness.
  const inherited = { ...process.env };
  const explicit = new Set([
    "LINGER_CODEX_PATH",
    "LINGER_CLAUDE_PATH",
    "LINGER_PI_PATH",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "PI_CODING_AGENT_DIR",
  ]);
  for (const key of Object.keys(inherited))
    if (explicit.has(key.toUpperCase())) delete inherited[key];
  return {
    ...inherited,
    ...(await managedRuntimeEnvironment(
      path.resolve(instance.root, "../.."),
      instance.root,
    )),
    ...(await localModelsEnvironment(instance)),
    PATH: await runtimePath(instance),
    LINGER_COMPUTER_INSECURE_DEVELOPMENT_ORIGIN: instance.origin,
  };
}
async function invoke(
  instance: Instance,
  args: string[],
  signal?: AbortSignal,
  timeoutMs = 60_000,
  onOutput?: (value: string) => void,
) {
  return await runProcess(
    instance.computerExecutable,
    [...args, "--config", instance.computerConfig],
    { env: await environment(instance), signal, timeoutMs, onOutput },
  );
}
/** Start only this instance's daemon with its selected runtime and private profiles. */
export async function startComputer(
  instance: Instance,
  options: { signal?: AbortSignal } = {},
): Promise<boolean> {
  const result = await invoke(
    instance,
    ["daemon", "start"],
    options.signal,
    100_000,
  );
  return result.code === 0;
}
async function inspectInstanceComputer(
  instance: Instance,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ComputerInspection> {
  options.signal?.throwIfAborted();
  if (!(await configured(instance)))
    return {
      ...empty(
        "action_required",
        `Reopen Linger to complete browser account and Computer authorization. Product address: ${instance.origin}`,
      ),
      activeOperations: 0,
    };
  let status: Record<string, unknown>;
  try {
    const result = await invoke(
      instance,
      ["daemon", "status", "--json"],
      options.signal,
      options.timeoutMs ?? 15_000,
    );
    status = record(JSON.parse(result.stdout));
    if (result.code !== 0)
      return empty(
        "action_required",
        "This computer's configuration is unavailable. Run linger-computer doctor to check authorization; the device identity is not reset automatically.",
      );
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return empty(
      "action_required",
      "Computer status could not be inspected. Run linger-computer doctor; existing services and device identity are preserved.",
    );
  }
  const daemon = record(status.daemon);
  const runtimes = Array.isArray(status.runtimes) ? status.runtimes : [];
  const operations = daemon.active_operations;
  const activeOperations =
    daemon.state === "stopped"
      ? 0
      : typeof operations === "number" &&
          Number.isSafeInteger(operations) &&
          operations >= 0
        ? operations
        : -1;
  const result = {
    runtimes,
    activeOperations,
    connected:
      daemon.state === "running" &&
      daemon.gateway_state === "connected" &&
      daemon.reconciled === true,
  };
  if (
    ["authentication-failed", "upgrade-required"].includes(
      String(daemon.gateway_state),
    )
  )
    return {
      ...result,
      state: "action_required",
      detail:
        "This computer's authorization expired or its version needs an update. Run linger-computer doctor; the existing device identity is preserved.",
    };
  if (!result.connected)
    return {
      ...result,
      state: "offline",
      detail:
        "This computer is not connected to the Gateway. Reopen Linger, then retry.",
    };
  const ready = runtimes.some((runtime) => record(runtime).status === "ready");
  if (!ready)
    return {
      ...result,
      state: "action_required",
      detail:
        "No signed-in runtime is available. Install or sign in to Codex, Claude or Pi, then reopen Linger.",
    };
  return {
    ...result,
    state: "ready",
    detail: "This computer is connected and its runtime is ready.",
  };
}
export async function inspectComputer(
  instance: Instance,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ComputerInspection> {
  return inspectInstanceComputer(instance, options);
}
async function managedRuntimeState(instance: Instance) {
  const descriptors = await inspectSelectedRuntimeDescriptors(
    path.resolve(instance.root, "../.."),
    instance.root,
  );
  const managed = runtimeEnvironmentFromDescriptors(descriptors);
  Object.assign(managed, await localModelsEnvironment(instance));
  managed.PATH = await runtimePath(instance);
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        managed,
        revisions: descriptors.map((row) => ({
          runtime: row.runtime,
          revision: row.configFingerprint,
          computer: row.computer,
        })),
      }),
    )
    .digest("hex");
  return {
    managed,
    fingerprint,
    authFile: descriptors.find((row) => row.runtime === "codex")?.computer
      ?.authFile,
    receipt: path.join(
      path.dirname(instance.computerConfig),
      "managed-runtime.sha256",
    ),
  };
}
async function bindManagedRuntime(
  instance: Instance,
  managed: NodeJS.ProcessEnv,
  authFile?: string,
) {
  if (
    !managed.CODEX_HOME &&
    !managed.LINGER_CODEX_PATH &&
    !managed.LINGER_CLAUDE_PATH &&
    !managed.LINGER_PI_PATH
  )
    return;
  const contents = await readPrivate(instance.computerConfig);
  if (!contents) throw new Error("Instance Computer configuration is missing");
  const parsed: unknown = JSON.parse(contents);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Invalid instance Computer configuration");
  const config = parsed as Record<string, unknown>;
  for (const key of ["codex", "runtime_paths"])
    if (
      config[key] !== undefined &&
      (!config[key] ||
        typeof config[key] !== "object" ||
        Array.isArray(config[key]))
    )
      throw new Error("Invalid instance Computer runtime configuration");
  if (authFile) {
    if (!path.isAbsolute(authFile))
      throw new Error("Invalid upstream Computer credential binding");
    config.codex = { ...record(config.codex), auth_file: authFile };
  }
  config.runtime_paths = Object.fromEntries(
    (["codex", "claude", "pi"] as const).flatMap((runtime) => {
      const executable = managed[`LINGER_${runtime.toUpperCase()}_PATH`];
      return executable ? [[runtime, executable]] : [];
    }),
  );
  await atomicPrivate(
    instance.computerConfig,
    JSON.stringify(config, null, 2) + "\n",
  );
}
async function connectInstanceComputer(
  instance: Instance,
  options: {
    interactive: boolean;
    authorize?: () => Promise<string>;
    signal?: AbortSignal;
    onProgress?: (detail: string) => void;
  },
): Promise<ComputerInspection> {
  const exists = await configured(instance);
  const desired = await managedRuntimeState(instance);
  const stamp = () => atomicPrivate(desired.receipt, desired.fingerprint);
  let startedByLogin = false;
  if (!exists) {
    if (!options.interactive && !options.authorize)
      return empty(
        "action_required",
        `Browser authorization is required. Reopen Linger and sign in with its local account. Product address: ${instance.origin}`,
      );
    const tokenFile = await options.authorize?.();
    const login = await invoke(
      instance,
      [
        "login",
        "--web-url",
        instance.origin,
        ...(tokenFile ? ["--token-file", tokenFile] : []),
        ...(desired.authFile ? ["--codex-auth", desired.authFile] : []),
        ...(["codex", "claude", "pi"] as const).flatMap((runtime) => {
          const executable =
            desired.managed[`LINGER_${runtime.toUpperCase()}_PATH`];
          return executable ? [`--${runtime}-path`, executable] : [];
        }),
      ],
      options.signal,
      10 * 60_000,
      options.onProgress,
    );
    if (login.code !== 0 && tokenFile)
      return empty(
        "action_required",
        "Automatic connection has not finished. Connection credentials are preserved; reopen Linger to retry. No second device identity is created.",
      );
    if (login.code !== 0)
      return empty(
        "action_required",
        `Browser authorization is incomplete. Visit ${instance.origin}, then reopen Linger to retry.`,
      );
    if (!(await configured(instance)))
      return empty(
        "action_required",
        "Browser authorization did not create Computer configuration. Reopen Linger to retry.",
      );
    startedByLogin = true;
    await stamp();
    if (tokenFile) await rm(tokenFile, { force: true });
  }
  let observed = await inspectComputer(instance, { signal: options.signal });
  const receipt = await readPrivate(desired.receipt);
  const refresh =
    !startedByLogin &&
    receipt !== desired.fingerprint &&
    (Boolean(receipt) || Object.keys(desired.managed).length > 0);
  if (refresh) {
    if (observed.activeOperations !== 0)
      return {
        ...observed,
        state: "action_required",
        detail:
          "The instance Computer has active operations or its idle state is unknown. Finish its work, then retry to activate the managed runtime.",
      };
    const stopped = await invoke(
      instance,
      ["daemon", "stop", "--if-idle"],
      options.signal,
      45_000,
    );
    if (stopped.code !== 0)
      return {
        ...observed,
        state: "action_required",
        detail:
          "The instance Computer could not stop safely. Check its active operations and retry.",
      };
    await bindManagedRuntime(instance, desired.managed, desired.authFile);
    // The existing identity and credential references stay in the same instance configuration.
    observed = { ...observed, state: "offline", connected: false };
  }
  if (observed.state !== "offline") return observed;
  // Login starts the daemon; its initial handshake may still be in progress.
  // Observe that process instead of issuing a competing second start.
  let failedStart = false;
  if (!startedByLogin) {
    failedStart = !(await startComputer(instance, { signal: options.signal }));
    if (!failedStart) await stamp();
  }
  options.onProgress?.(
    "Waiting for the Gateway connection and runtime status…\n",
  );
  const deadline = Date.now() + 30_000;
  let current = observed;
  while (Date.now() < deadline) {
    options.signal?.throwIfAborted();
    current = await inspectComputer(instance, {
      signal: options.signal,
      timeoutMs: Math.max(1, Math.min(15_000, deadline - Date.now())),
    });
    options.signal?.throwIfAborted();
    if (current.state !== "offline") {
      // A competing initialization can make start fail after the owned daemon began.
      if (failedStart && current.connected) await stamp();
      return current;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await delay(Math.min(500, remaining), undefined, {
      signal: options.signal,
    });
  }
  options.signal?.throwIfAborted();
  return failedStart
    ? {
        ...current,
        state: "action_required",
        detail:
          "Could not start the Computer process. Run linger-computer doctor to check configuration and authorization; device identity will not be reset automatically.",
      }
    : current;
}
export async function connectComputer(
  instance: Instance,
  options: Parameters<typeof connectInstanceComputer>[1],
): Promise<ComputerInspection> {
  return connectInstanceComputer(instance, options);
}
export async function stopComputer(
  instance: Instance,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  if (!(await configured(instance))) return;
  const observed = await inspectComputer(instance, { signal: options.signal });
  if (observed.activeOperations !== 0)
    throw new Error(
      "Instance busy: active operations are running or operation state is unavailable",
    );
  const stopped = await invoke(
    instance,
    ["daemon", "stop", "--if-idle"],
    options.signal,
    45_000,
  );
  if (stopped.code !== 0)
    throw new Error(
      "Could not stop instance Computer; run linger-computer doctor",
    );
}
