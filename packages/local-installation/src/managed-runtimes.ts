import { mkdtemp, readFile, rm, realpath } from "node:fs/promises";
import path from "node:path";
import { readSetupChoice } from "./setup-selection.js";
import { privateDirectory } from "./instance.js";
import { runLocalmodels } from "./localmodels-tool.js";
import type { runProcess } from "./process.js";
import { localmodelsFailure } from "./localmodels-failure.js";
import type { InstallOutcome, InstallerEvent } from "./events.js";
import type { PreparationOptions } from "./dependencies.js";

export type NativeRuntime = "codex" | "claude" | "pi";
export type RuntimePreparationOptions = Omit<PreparationOptions, "dependency">;
export interface RuntimeDependencies {
  run?: typeof runProcess;
  localmodels?: typeof runLocalmodels;
}
export interface RuntimeDescriptor {
  configFingerprint?: string | null;
  computer?: { authFile?: string };
  modelConfig?: { baseUrl: string; model: string; keySaved: boolean };
  environment?: Record<string, string>;
  runtime: NativeRuntime;
  executable: string | null;
  argvPrefix: string[];
  installed: boolean;
  authenticated: boolean;
  authMode: string | null;
  loginCommand: {
    executable: string;
    args: string[];
    env: Record<string, string>;
  } | null;
  deviceLoginCommand?: {
    executable: string;
    args: string[];
    env: Record<string, string>;
  } | null;
}
const root = (home: string) =>
  path.join(path.resolve(home), "runtime", "harness");
const versionFailures: Record<string, string> = {
  RUNTIME_VERSION_TIMEOUT:
    "Runtime version verification timed out after two bounded attempts.",
  RUNTIME_VERSION_EXECUTION_FAILED: "Runtime version executable failed.",
  RUNTIME_VERSION_MISMATCH: "Runtime did not report the approved version.",
};
export function runtimeVersionFailure(
  value: unknown,
): { code: string; message: string } | undefined {
  const code = (value as { code?: unknown } | null)?.code;
  return typeof code === "string" && Object.hasOwn(versionFailures, code)
    ? { code, message: versionFailures[code]! }
    : undefined;
}
type LocalmodelsResult = Awaited<ReturnType<typeof runLocalmodels>>;
function unavailable(failed?: {
  args: string[];
  result: LocalmodelsResult;
  onEvent?: (event: InstallerEvent) => void;
}): Error {
  if (failed) {
    try {
      const value = JSON.parse(
        failed.result.stdout.trim().split("\n").at(-1) ?? "",
      );
      const failure =
        value?.schema === "localmodels.harness-error/v1"
          ? runtimeVersionFailure(value)
          : undefined;
      if (failure)
        return Object.assign(new Error(failure.message), {
          code: failure.code,
        });
    } catch {
      /* Non-JSON output is read below as redacted diagnostics. */
    }
    const { cause, log } = localmodelsFailure(failed.args, failed.result);
    for (const message of log)
      failed.onEvent?.({ kind: "log", stage: "runtime", message });
    if (cause)
      return Object.assign(
        new Error(`The localmodels Runtime operation failed: ${cause}`),
        { code: "LOCALMODELS_RUNTIME_UNAVAILABLE" },
      );
  }

  return Object.assign(
    new Error(
      "The localmodels Runtime operation is unavailable. Check the verified tool installation and retry.",
    ),
    { code: "LOCALMODELS_RUNTIME_UNAVAILABLE" },
  );
}
export async function inspectRuntimeDescriptors(
  home: string,
  options: {
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
    runtime?: NativeRuntime;
  } = {},
  dependencies: RuntimeDependencies = {},
): Promise<RuntimeDescriptor[]> {
  options.signal?.throwIfAborted();
  try {
    const result = await (dependencies.localmodels ?? runLocalmodels)(
      home,
      [
        "harness",
        "status",
        "--root",
        root(home),
        ...(options.runtime ? ["--runtime", options.runtime] : []),
        "--json",
      ],
      { signal: options.signal, env: options.env, timeoutMs: 120000 },
    );
    options.signal?.throwIfAborted();
    if (result.code !== 0)
      throw unavailable({ args: ["harness", "status"], result });
    const value = JSON.parse(result.stdout) as {
      schema: string;
      runtimes: RuntimeDescriptor[];
    };
    if (
      value.schema !== "localmodels.harness-status/v1" ||
      !Array.isArray(value.runtimes) ||
      value.runtimes.some(
        (row) =>
          !["codex", "claude", "pi"].includes(row.runtime) ||
          typeof row.installed !== "boolean" ||
          typeof row.authenticated !== "boolean" ||
          !Array.isArray(row.argvPrefix),
      )
    )
      throw unavailable();
    return value.runtimes;
  } catch (error) {
    options.signal?.throwIfAborted();
    if ((error as { code?: string })?.code === "COMMAND_TIMEOUT") throw error;
    const failure = runtimeVersionFailure(error);
    if (failure)
      throw Object.assign(new Error(failure.message), { code: failure.code });
    if (
      error instanceof Error &&
      (error as { code?: string }).code === "LOCALMODELS_RUNTIME_UNAVAILABLE"
    )
      throw error;
    throw unavailable();
  }
}
/** Only the instance's chosen Harness is an explicit Computer binding. */
export async function inspectSelectedRuntimeDescriptors(
  home: string,
  instanceRoot: string,
  dependencies: RuntimeDependencies = {},
): Promise<RuntimeDescriptor[]> {
  const choice = await readSetupChoice({ root: instanceRoot });
  if (!choice || choice === "local-models") return [];
  const rows = await inspectRuntimeDescriptors(
    home,
    { runtime: choice },
    dependencies,
  );
  return rows.filter((row) => row.runtime === choice);
}
export function runtimeEnvironmentFromDescriptors(
  descriptors: RuntimeDescriptor[],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const row of descriptors) {
    for (const key of [
      "CODEX_HOME",
      "CLAUDE_CONFIG_DIR",
      "PI_CODING_AGENT_DIR",
    ]) {
      if (row.environment?.[key] !== undefined) env[key] = row.environment[key];
    }
    const key = `LINGER_${row.runtime.toUpperCase()}_PATH`;
    if (row.installed && row.executable) {
      if (row.argvPrefix.length)
        throw new Error(
          "The upstream Runtime descriptor requires arguments unsupported by Computer.",
        );
      env[key] = row.executable;
    }
  }
  return env;
}
/** Upstream owns artifact locks, discovery, install strategy, verification and publication. */
export async function installNativeRuntime(
  runtime: NativeRuntime,
  options: RuntimePreparationOptions,
  dependencies: RuntimeDependencies = {},
): Promise<InstallOutcome> {
  options.signal.throwIfAborted();
  const tool = dependencies.localmodels ?? runLocalmodels;
  const plans = path.join(path.resolve(options.home), "setup", "harness-plans");
  await privateDirectory(plans);
  options.signal.throwIfAborted();
  const temporary = await realpath(await mkdtemp(path.join(plans, "plan-")));
  try {
    await privateDirectory(temporary);
    const file = path.join(temporary, "plan.json");
    const planned = await tool(
      options.home,
      [
        "harness",
        "plan",
        "--runtime",
        runtime,
        "--root",
        root(options.home),
        "--node",
        process.execPath,
        "--out",
        file,
        "--json",
      ],
      {
        signal: options.signal,
        env: options.env,
        timeoutMs: 120000,
        onEvent: options.onEvent,
      },
    );
    if (planned.code !== 0)
      throw unavailable({
        args: ["harness", "plan"],
        result: planned,
        onEvent: options.onEvent,
      });
    const plan = JSON.parse(await readFile(file, "utf8")) as {
      schema: string;
      id: string;
      runtime: string;
    };
    if (
      plan.schema !== "localmodels.harness-plan/v1" ||
      plan.runtime !== runtime ||
      !/^[a-f0-9]{64}$/.test(plan.id)
    )
      throw unavailable();
    options.signal.throwIfAborted();
    const applied = await tool(
      options.home,
      ["harness", "apply", file, "--approve", plan.id, "--jsonl"],
      {
        signal: options.signal,
        env: options.env,
        timeoutMs: 20 * 60000,
        onEvent: options.onEvent,
      },
    );
    if (applied.code !== 0)
      throw unavailable({
        args: ["harness", "apply"],
        result: applied,
        onEvent: options.onEvent,
      });
    const state = await inspectRuntime(runtime, options, dependencies);
    if (!state.installed) throw unavailable();
    return {
      code: 0,
      state: "ready",
      message: `${runtime} is installed. Authentication will be checked separately.`,
      details: { executable: state.executable },
    };
  } catch (error) {
    options.signal.throwIfAborted();
    if ((error as { code?: string })?.code === "COMMAND_TIMEOUT") throw error;
    const failure = runtimeVersionFailure(error);
    if (failure)
      throw Object.assign(new Error(failure.message), { code: failure.code });
    if (
      error instanceof Error &&
      (error as { code?: string }).code === "LOCALMODELS_RUNTIME_UNAVAILABLE"
    )
      throw error;
    throw unavailable();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
export interface RuntimeInspection {
  runtime: NativeRuntime;
  executable: string;
  installed: boolean;
  ready: boolean;
  loginCommand: string;
  loginInstructions?: string;
  descriptor: RuntimeDescriptor;
}
export async function inspectRuntime(
  runtime: NativeRuntime,
  options: Omit<RuntimePreparationOptions, "onEvent">,
  dependencies: RuntimeDependencies = {},
): Promise<RuntimeInspection> {
  const rows = await inspectRuntimeDescriptors(
    options.home,
    { signal: options.signal, env: options.env, runtime },
    dependencies,
  );
  const row = rows.find((item) => item.runtime === runtime);
  if (!row) throw unavailable();
  const quote = (value: string) =>
    (options.platform ?? process.platform) === "win32"
      ? `'${value.replaceAll("'", "''")}'`
      : `'${value.replaceAll("'", "'\\''")}'`;
  const login = row.loginCommand;
  return {
    runtime,
    executable: row.executable ?? runtime,
    installed: row.installed,
    ready: row.authenticated,
    loginCommand: login
      ? `${(options.platform ?? process.platform) === "win32" ? "& " : ""}${[login.executable, ...login.args].map(quote).join(" ")}`
      : "",
    ...(login
      ? {}
      : {
          loginInstructions:
            "Choose an API provider and enter its key in Linger.",
        }),
    descriptor: row,
  };
}
export async function prepareRuntime(
  runtime: NativeRuntime,
  options: RuntimePreparationOptions,
  dependencies: RuntimeDependencies = {},
): Promise<InstallOutcome> {
  const { prepareDependencies } = await import("./dependencies.js");
  const installed = await prepareDependencies(
    { ...options, dependency: runtime },
    dependencies,
  );
  if (installed.code !== 0) return installed;
  const state = await inspectRuntime(runtime, options, dependencies);
  if (state.ready)
    return {
      code: 0,
      state: "ready",
      message: `${runtime} is installed and authenticated.`,
      details: state,
    };
  const message = `${runtime} requires authentication. Continue in Linger or choose to sign in later; business services remain available.`;
  options.onEvent({
    kind: "stage",
    stage: "runtime",
    state: "waiting_user",
    message,
  });
  return {
    code: 4,
    state: "action_required",
    message,
    details: {
      code: "RUNTIME_AUTH_REQUIRED",
      runtime,
      executable: state.executable,
      loginCommand: state.loginCommand,
      ...(state.loginInstructions
        ? { loginInstructions: state.loginInstructions }
        : {}),
    },
  };
}
