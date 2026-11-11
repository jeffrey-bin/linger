import { prepareFoundationServices } from "./foundation-services.js";
import { prepareModelGateway, stopModelGateway } from "./model-gateway.js";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, statfs } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  prepareSourceConfiguration,
  validateSourceRepository,
  type EnvironmentReport,
  type SourceInstallOptions,
} from "./source-checkout.js";
import {
  atomicPrivate,
  loadInstance,
  privateDirectory,
  withInstanceLock,
  type Instance,
} from "./instance.js";
import {
  prepareNativeDependencies,
  prepareNativeVoiceTools,
} from "./native-dependencies.js";
import { readLiveKitSettings, startNativeLiveKit } from "./native-livekit.js";
import { checkNativeRuntime } from "./native-runtime.js";
import { checkTeamhubBinaries } from "./teamhub-binaries.js";
import { npmRegistryEnvironment } from "./npm-registry.js";
import { prepareNativeDatabase } from "./native-database.js";
import {
  inspectNativeProcess,
  nativeConfigurationChanged,
  startNativeProcess,
  stopNativeProcess,
  type NativeService,
} from "./native-process.js";
import { ensureLocalAccount, validateLocalCredentials } from "./account.js";
import {
  configureManagedCodex,
  managedRuntimeEnvironment,
} from "./managed-codex.js";
import { prepareRuntime, runtimeVersionFailure } from "./managed-runtimes.js";
import {
  readSetupChoice,
  writeGpuSharing,
  validateSetupChoice,
  writeSetupChoice,
} from "./setup-selection.js";
import { prepareLocalModels } from "./local-models.js";
import { prepareSourceComputer } from "./source-computer.js";
import { connectComputer, stopComputer } from "./computer.js";
import { prepareLocalEnrollment } from "./local-enrollment.js";
import { lineRedactor, redact } from "./redaction.js";
import { runProcess } from "./process.js";
import {
  installAppleDeveloperTools,
  needsAppleDeveloperTools,
} from "./apple-developer-tools.js";
import type { InstallOutcome, InstallerEvent, InstallStage } from "./events.js";

export const nativeServices = [
  "web",
  "node-services",
  "teamhub",
  "livekit",
  "postgres",
] as const;
function requireNative(instance: Instance) {
  if (instance.mode !== "source-native" || !instance.source)
    throw new Error("This operation requires a native source instance.");
  return instance.source;
}
export async function nativeSourceInstanceName(
  repository: string,
): Promise<string> {
  const canonical = await realpath(repository);
  return `native-${createHash("sha256").update(canonical).digest("hex").slice(0, 12)}`;
}
export async function prepareNativeConfiguration(
  repository: string,
  options: {
    name?: string;
    home?: string;
    port?: number;
    computerName?: string;
    rebindSource?: boolean;
  } = {},
) {
  const repo = await validateSourceRepository(repository);
  const name = options.name ?? (await nativeSourceInstanceName(repo));
  const bound = (instance?: Instance) =>
    instance?.mode === "source-native" &&
    instance.source &&
    instance.releaseDir !== repo;
  const existing = options.rebindSource
    ? await loadInstance({ name, home: options.home })
    : undefined;
  if (existing && bound(existing))
    // Instance data lives under its root; services restart on the new
    // checkout because their recorded configuration no longer matches.
    await withInstanceLock(existing, async () => {
      const instance = await loadInstance({ name, home: options.home });
      if (!instance || !bound(instance)) return;
      const previous = instance.releaseDir;
      instance.releaseDir = repo;
      instance.source!.repo = repo;
      if (instance.computerExecutable.startsWith(previous + path.sep))
        instance.computerExecutable = path.join(
          repo,
          path.relative(previous, instance.computerExecutable),
        );
      await atomicPrivate(
        path.join(instance.root, "instance.json"),
        JSON.stringify(instance, null, 2) + "\n",
      );
    });
  return prepareSourceConfiguration(repo, { ...options, name });
}
export async function checkNativeSourceEnvironment(options: {
  repo: string;
  home?: string;
  signal: AbortSignal;
}): Promise<EnvironmentReport> {
  options.signal.throwIfAborted();
  const supported =
    (process.platform === "darwin" && process.arch === "arm64") ||
    (process.platform === "linux" && process.arch === "x64") ||
    (process.platform === "win32" && process.arch === "x64");
  const checks: EnvironmentReport["checks"] = [
    {
      id: "platform",
      title: "Operating system",
      state: supported ? "ready" : "action_required",
      detail: supported
        ? `${process.platform}/${process.arch}`
        : "Native source currently provides macOS arm64, Linux x64 and Windows x64 components.",
    },
  ];
  let ready = false;
  try {
    await validateSourceRepository(options.repo);
    ready = true;
  } catch {
    /* A preflight report never exposes parser or private file contents. */
  }
  checks.push({
    id: "source-native",
    title: "Native source checkout",
    state: ready ? "ready" : "action_required",
    detail: ready
      ? "Native source runs directly on this computer."
      : "Select a checkout containing scripts/source-native.mjs.",
  });
  let directory = path.resolve(options.home ?? options.repo);
  for (;;) {
    try {
      const disk = await statfs(directory);
      const availableBytes = Number(disk.bavail) * Number(disk.bsize);
      checks.push({
        id: "disk",
        title: "Available storage",
        state: availableBytes > 0 ? "ready" : "action_required",
        detail:
          "Native component sizes are verified before download; source dependency and compilation space is additional.",
      });
      return {
        platform: process.platform,
        arch: process.arch,
        releaseAvailable: ready && supported,
        checks,
        availableBytes,
      };
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        path.dirname(directory) === directory
      )
        throw error;
      directory = path.dirname(directory);
    }
  }
}
export async function probeNativeSourceServices(
  instance: Instance,
  signal?: AbortSignal,
) {
  const source = requireNative(instance);
  const endpoints = [
    ["web", "web", source.ports.web, "/healthz"],
    ["teamhub", "teamhub", source.ports.teamhub, "/healthz"],
    ["node-services", "node-services", source.ports.nodeServices, "/readyz"],
    ["document-runtime", "node-services", source.ports.document, "/readyz"],
  ] as const;
  return Promise.all(
    endpoints.map(async ([service, processName, port, endpoint]) => {
      try {
        if (!(await inspectNativeProcess(instance.root, processName)).running)
          return { service, ready: false };
        const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
          redirect: "error",
          signal: AbortSignal.any([
            ...(signal ? [signal] : []),
            AbortSignal.timeout(2_000),
          ]),
        });
        await response.body?.cancel();
        return { service, ready: response.ok };
      } catch {
        return { service, ready: false };
      }
    }),
  );
}
const watchedServices = ["teamhub", "node-services", "web"] as const;
// Where each service log ends, so startup reads only what this run wrote.
async function logEnds(instance: Instance) {
  const ends = new Map<string, number>();
  for (const name of watchedServices)
    ends.set(
      name,
      await lstat(path.join(instance.root, "native/logs", `${name}.log`)).then(
        (info) => info.size,
        () => 0,
      ),
    );
  return ends;
}
// The last part of what a service logged since `from`.
async function logSince(instance: Instance, name: string, from: number) {
  let handle;
  try {
    handle = await open(
      path.join(instance.root, "native/logs", `${name}.log`),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch {
    return "";
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(size < from ? 0 : from, size - 64 * 1024);
    const bytes = Buffer.alloc(size - start);
    await handle.read(bytes, 0, bytes.length, start);
    return bytes.toString("utf8");
  } finally {
    await handle.close();
  }
}
// The compiler's own lines from the last failed build, redacted and
// bounded, so the setup page can show why without the log file.
export function compileFailureExcerpt(text: string, limit = 12) {
  const lines = redact(text).split(/\r?\n/u);
  const last = (pattern: RegExp, end: number) => {
    for (let index = end - 1; index >= 0; index--)
      if (pattern.test(lines[index]!)) return index;
    return -1;
  };
  const failed = last(/failed to build/, lines.length);
  if (failed < 0) return "";
  const building = last(/\bbuilding\.\.\./, failed);
  return lines
    .slice(building + 1, failed + 1)
    .map((line) => line.trim())
    .filter((line) => line && !/^(?:\S+\s+)?(?:watching|!exclude)\b/.test(line))
    .slice(-limit)
    .map((line) => (line.length > 240 ? `${line.slice(0, 239)}…` : line))
    .join("\n");
}
// A compile that fails stops TeamHub or leaves the dev server waiting for an
// edit that never comes; read the logs so the failure ends startup at once.
async function startupFailure(instance: Instance, ends: Map<string, number>) {
  const logs = path.join(instance.root, "native/logs");
  for (const name of watchedServices) {
    const text = await logSince(instance, name, ends.get(name) ?? 0);
    if (/no space left on device|ENOSPC/.test(text))
      return `This computer's disk is full, so native ${name} could not be built. Free up some space and try again.`;
    if (name === "teamhub" && /failed to build/.test(text)) {
      const excerpt = compileFailureExcerpt(text);
      return `Native teamhub failed to compile.${excerpt ? `\n${excerpt}\n` : " "}Inspect ${path.join(logs, "teamhub.log")}.`;
    }
  }
  return undefined;
}
async function waitHealthy(
  instance: Instance,
  signal: AbortSignal,
  onEvent: (event: InstallerEvent) => void,
  ends: Map<string, number>,
) {
  const deadline = Date.now() + 20 * 60_000;
  let last = 0;
  for (;;) {
    signal.throwIfAborted();
    const checks = await probeNativeSourceServices(instance, signal);
    if (checks.every((check) => check.ready)) return checks;
    // A failed build exits the service, so its log explains the stop.
    const failure = await startupFailure(instance, ends);
    if (failure) throw new Error(failure);
    for (const name of watchedServices)
      if (!(await inspectNativeProcess(instance.root, name)).running)
        throw new Error(
          `Native ${name} stopped during startup. Inspect ${path.join(instance.root, "native/logs", `${name}.log`)}.`,
        );
    if (Date.now() >= deadline) {
      const waiting = checks
        .filter((row) => !row.ready)
        .map((row) => row.service);
      throw new Error(
        `Native source services did not become ready before the startup deadline: ${waiting.join(", ")}. Inspect ${path.join(instance.root, "native/logs")}.`,
      );
    }
    if (Date.now() - last >= 10_000) {
      last = Date.now();
      onEvent({
        kind: "log",
        stage: "services",
        message: `Waiting for native compilation and readiness (${checks.filter((row) => row.ready).length}/4 ready).\n`,
      });
    }
    await delay(500, undefined, { signal });
  }
}
// What each stage is doing, for a failure that brings no message of its own.
const STAGE_ACTIVITY: Record<InstallStage, string> = {
  preflight: "checking this computer",
  release: "preparing private native toolchains and PostgreSQL",
  images: "installing checkout dependencies",
  services: "starting native services",
  account: "preparing the local account",
  computer: "connecting this Computer",
  runtime: "preparing the AI runtime",
};
// Seconds each stage took, in the order they ran, for the install job's
// outcome and log; a stage that runs again adds to its time.
function stageTimer(now = () => Date.now()) {
  const timings: Partial<Record<InstallStage, number>> = {};
  let current: InstallStage = "preflight";
  let since = now();
  const close = () => {
    const at = now();
    timings[current] = (timings[current] ?? 0) + (at - since) / 1000;
    since = at;
  };
  return {
    enter(stage: InstallStage) {
      if (stage === current) return;
      close();
      current = stage;
    },
    finish() {
      close();
      return Object.fromEntries(
        Object.entries(timings).map(([stage, seconds]) => [
          stage,
          Math.round(seconds * 10) / 10,
        ]),
      ) as Partial<Record<InstallStage, number>>;
    },
  };
}

export async function installNativeSource(
  options: SourceInstallOptions,
  now?: () => number,
): Promise<InstallOutcome> {
  const timer = stageTimer(now);
  const outcome = await runNativeSource(options, timer);
  const timings = timer.finish();
  options.onEvent({
    kind: "log",
    stage:
      (outcome.details as { stage?: InstallStage } | undefined)?.stage ??
      "preflight",
    message: `Native install timings (s): ${Object.entries(timings)
      .map(([stage, seconds]) => `${stage} ${seconds}`)
      .join(", ")}\n`,
  });
  return {
    ...outcome,
    details: {
      ...(typeof outcome.details === "object" ? outcome.details : {}),
      timings,
    },
  };
}

async function runNativeSource(
  options: SourceInstallOptions,
  timer: ReturnType<typeof stageTimer>,
): Promise<InstallOutcome> {
  let stage: InstallStage = "preflight";
  const secrets: string[] = [
    options.password,
    options.model?.apiKey,
    options.runtimeModel?.apiKey,
  ].filter((item): item is string => Boolean(item));
  const safe = (text: string) => {
    let value = redact(text);
    for (const secret of secrets)
      value = value.split(secret).join("[REDACTED]");
    return value;
  };
  const emit = (event: InstallerEvent) =>
    options.onEvent({ ...event, message: safe(event.message) });
  const step = (next: InstallStage, message: string) => {
    stage = next;
    timer.enter(next);
    emit({ kind: "stage", stage, state: "running", message });
  };
  const output = lineRedactor((message) =>
    emit({ kind: "log", stage, message }),
  );
  let instance: Instance | undefined;
  try {
    options.signal.throwIfAborted();
    validateLocalCredentials(options);
    if (options.setupChoice) validateSetupChoice(options.setupChoice);
    const choice = options.setupChoice ?? (await readSetupChoice(options));
    if (!choice)
      return {
        code: 4,
        state: "action_required",
        message: "Choose a Harness before starting native source.",
        details: { code: "SETUP_SELECTION_REQUIRED" },
      };
    // The desktop owns its instance and ships a new source package with
    // each update, so its instance follows the bundled checkout.
    const configured = await prepareNativeConfiguration(options.repo, {
      ...options,
      rebindSource: options.externalComputer,
    });
    instance = configured.instance;
    for (const [key, value] of Object.entries(configured.env))
      if (
        value &&
        /secret|password|token|key|credential|database_url/i.test(key)
      )
        secrets.push(value);
    for (const message of configured.warnings)
      emit({ kind: "log", stage, message });
    const current = instance;
    return await withInstanceLock(current, async () => {
      const home = path.resolve(current.root, "../..");
      await writeSetupChoice(current, choice);
      if (options.shareGpu !== undefined)
        await writeGpuSharing(current, options.shareGpu);
      if (options.runtimeModel)
        await configureManagedCodex(
          current.root,
          options.runtimeModel,
          options.signal,
        );
      const controller = new AbortController();
      const signal = AbortSignal.any([options.signal, controller.signal]);
      const started: NativeService[] = [];
      let runtimeOutcome: InstallOutcome | undefined;
      let runtimeError: unknown;
      const runtime = (async () => {
        try {
          runtimeOutcome =
            choice === "local-models"
              ? await prepareLocalModels(current, {
                  shareGpu: options.shareGpu,
                  signal,
                  onEvent: emit,
                  localModelsApproval: options.localModelsApproval,
                  localModelsReplan: options.localModelsReplan,
                })
              : await prepareRuntime(choice, {
                  home,
                  signal,
                  onEvent: emit,
                  env: await managedRuntimeEnvironment(home, current.root),
                });
          if (
            runtimeOutcome &&
            runtimeOutcome.code !== 0 &&
            (runtimeOutcome.details as { code?: string } | undefined)?.code !==
              "RUNTIME_AUTH_REQUIRED"
          )
            controller.abort();
        } catch (error) {
          runtimeError = error;
          controller.abort();
        }
      })();
      try {
        step("release", "Preparing private native toolchains and PostgreSQL…");
        // Each part of the release stage logs its time, so a slow install
        // says which part was slow.
        const timed = async <T>(
          what: string,
          run: () => Promise<T>,
          detail: (value: T) => string = () => "",
        ): Promise<T> => {
          const startedAt = Date.now();
          const value = await run();
          emit({
            kind: "log",
            stage,
            message: `${what} took ${((Date.now() - startedAt) / 1000).toFixed(1)}s${detail(value)}.\n`,
          });
          return value;
        };
        // The desktop puts the TeamHub binaries it ships into the checkout;
        // with them TeamHub needs no Go.
        const binaries = await timed(
          "Checking the bundled TeamHub binaries",
          () => checkTeamhubBinaries(current.source!.repo),
          (state) => ` (${state})`,
        );
        signal.throwIfAborted();
        if (binaries !== "absent")
          emit({
            kind: "log",
            stage,
            message:
              binaries === "verified"
                ? "Using the bundled TeamHub binaries; Go is not needed.\n"
                : "The bundled TeamHub binaries do not verify; compiling TeamHub instead.\n",
          });
        // The desktop also unpacks the services it built into the checkout;
        // with them (and the Computer it ships) nothing installs packages.
        let checked = "";
        const bundled =
          options.externalComputer &&
          (await timed(
            "Checking the bundled Native services",
            () =>
              checkNativeRuntime(current.source!.repo, {
                signal,
                checked: (how, files) => {
                  checked = `, ${files} files by ${how === "sizes" ? "size" : "sha256"}`;
                },
              }),
            (state) => ` (${state}${checked})`,
          ));
        if (bundled && bundled !== "absent")
          emit({
            kind: "log",
            stage,
            message:
              bundled === "verified"
                ? "Using the bundled Native services; no packages are installed.\n"
                : "The bundled Native services do not verify; installing the checkout's packages instead.\n",
          });
        const offline = bundled === "verified";
        const tools = await timed(
          "Preparing the private toolchains and PostgreSQL",
          () =>
            prepareNativeDependencies({
              repo: current.source!.repo,
              home,
              signal,
              onEvent: emit,
              go: binaries !== "verified",
              packages: !offline,
            }),
        );
        // Voice needs LiveKit and ffmpeg; the desktop ships them for each
        // computer. Without them (or without keys) voice stays off.
        const voiceKeys = Boolean(
          configured.env.SONIOX_API_KEY?.trim() ||
          configured.env.XAI_API_KEY?.trim(),
        );
        const voice = voiceKeys
          ? await timed("Preparing the voice tools", () =>
              prepareNativeVoiceTools({ home, signal, onEvent: emit }),
            )
          : undefined;
        if (voiceKeys && !voice)
          emit({
            kind: "log",
            stage,
            message:
              "Voice stays off: this installation has no voice tools for this computer.\n",
          });
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          ...tools.env,
          ...configured.env,
          ...(voice
            ? {
                // TeamHub and the voice workers run ffmpeg and ffprobe from PATH.
                PATH: [voice.bin, tools.env.PATH]
                  .filter(Boolean)
                  .join(path.delimiter),
              }
            : voiceKeys
              ? { SONIOX_API_KEY: "", XAI_API_KEY: "" }
              : {}),
        };
        // The services read user.env, the credentials and the voice tools from
        // their environment, which their command line does not cover: a
        // change restarts them.
        const settings = JSON.stringify({
          env: configured.env,
          voice: voice ? voice.bin : voiceKeys ? "off" : undefined,
        });
        await timed("Protecting the instance data directories", () =>
          Promise.all(
            ["data/agent", "data/artifacts", "native"].map((directory) =>
              privateDirectory(path.join(current.root, directory)),
            ),
          ),
        );
        const command = async (
          operation: string,
          extraEnv: NodeJS.ProcessEnv = {},
          input?: string,
          sink: { write(chunk: string): void } = output,
          retried = false,
        ): Promise<void> => {
          const startedAt = Date.now();
          const heartbeat = setInterval(
            () =>
              emit({
                kind: "log",
                stage,
                message: `Native ${operation} is running (${Math.floor((Date.now() - startedAt) / 1000)}s elapsed).\n`,
              }),
            10_000,
          );
          // The end of the output, to tell a missing compiler from other failures.
          let tail = "";
          let code: number;
          try {
            ({ code } = await runProcess(
              process.execPath,
              [
                path.join(current.source!.repo, "scripts/source-native.mjs"),
                operation,
              ],
              {
                cwd: current.source!.repo,
                env: { ...env, ...extraEnv },
                signal,
                timeoutMs: 30 * 60_000,
                input,
                capture: false,
                onOutput: (chunk) => {
                  sink.write(chunk);
                  tail = (tail + chunk).slice(-64_000);
                },
              },
            ));
          } finally {
            clearInterval(heartbeat);
          }
          if (code === 0) return;
          // Prebuilt binaries cover every native module, but when one has to
          // compile after all a Mac needs Apple's tools; install them and retry.
          if (!retried && (await needsAppleDeveloperTools(tail, { signal }))) {
            const installing = "Installing Apple developer tools…";
            emit({
              kind: "stage",
              stage,
              state: "running",
              message: installing,
            });
            await installAppleDeveloperTools({
              signal,
              onWaiting: (seconds) =>
                emit({
                  kind: "log",
                  stage,
                  message: `${installing} Choose Install in the window macOS opened (${seconds}s elapsed).\n`,
                }),
            });
            emit({
              kind: "log",
              stage,
              message: `Apple developer tools are installed. Running native ${operation} again.\n`,
            });
            return command(operation, extraEnv, input, sink, true);
          }
          throw new Error(`Native source ${operation} failed (exit ${code}).`);
        };
        // pnpm reports "Progress: resolved N, reused R, downloaded D, added A";
        // those lines become the stage counter instead of log noise.
        const packages = lineRedactor((line) => {
          const counts =
            /^Progress: resolved (\d+), reused \d+, downloaded \d+, added (\d+)/.exec(
              line,
            );
          if (!counts) return emit({ kind: "log", stage, message: line });
          const [total, completed] = [Number(counts[1]), Number(counts[2])];
          if (completed > 0)
            emit({
              kind: "log",
              stage,
              message: `Installing dependencies: ${completed} of ${total} packages\n`,
              progress: { completed, total, unit: "packages" },
            });
        });
        // A failed install retries from the next registry; the packages it
        // already fetched stay in the store. Later installs start from the
        // registry that worked.
        let registries = tools.registries;
        const install = async (operation: string) => {
          for (const [index, registry] of registries.entries()) {
            try {
              await command(
                operation,
                npmRegistryEnvironment(registry),
                undefined,
                packages,
              );
              registries = registries.slice(index);
              return;
            } catch (error) {
              signal.throwIfAborted();
              const next = registries[index + 1];
              if (!next) throw error;
              emit({
                kind: "log",
                stage,
                message: `Dependency installation from ${new URL(registry).host} failed; retrying with ${new URL(next).host}.\n`,
              });
            } finally {
              packages.flush();
            }
          }
        };
        step(
          "images",
          "Installing checkout dependencies and building its native Computer release…",
        );
        if (!offline) await install("prepare");
        if (!options.externalComputer) {
          await install("prepare-computer");
          await command("computer-release");
        }
        emit({
          kind: "stage",
          stage,
          state: offline ? "skipped" : "succeeded",
          message: offline
            ? "The bundled Native services need no dependencies."
            : options.externalComputer
              ? "Source dependencies are ready."
              : "Source dependencies and native Computer release are ready.",
        });
        step(
          "services",
          "Starting private PostgreSQL and applying migrations…",
        );
        const postgresWasRunning = (
          await inspectNativeProcess(current.root, "postgres")
        ).running;
        // Mark before startup so a failed init/readiness step can stop a process
        // it managed to create without touching a previously running cluster.
        if (!postgresWasRunning) started.push("postgres");
        await prepareNativeDatabase({
          instance: current,
          postgresBin: tools.postgresBin,
          env,
          signal,
          onOutput: (chunk) => output.write(chunk),
        });
        await command("migrate");
        await runtime;
        signal.throwIfAborted();
        await prepareFoundationServices(current, choice, {
          home,
          signal,
          onEvent: emit,
          shareGpu: options.shareGpu,
        });
        // Binds the local stack's gateway for local models; with a runtime's own
        // sign-in, retires one an earlier release started.
        await prepareModelGateway(current, choice, {
          home,
          signal,
          onEvent: emit,
        });
        step("services", "Starting native collaboration services…");
        const ends = await logEnds(current);
        const liveKit = voice && (await readLiveKitSettings(current.root));
        if (voice && liveKit) {
          if (!(await inspectNativeProcess(current.root, "livekit")).running)
            started.push("livekit");
          await startNativeLiveKit({
            root: current.root,
            executable: voice.livekit,
            settings: liveKit,
            signal,
          });
        } else if (
          (await inspectNativeProcess(current.root, "livekit")).running
        )
          await stopNativeProcess(current.root, "livekit");
        const serviceOptions = (name: "teamhub" | "node-services" | "web") => ({
          root: current.root,
          name,
          executable: process.execPath,
          args: [
            path.join(current.source!.repo, "scripts/source-native.mjs"),
            name,
          ],
          cwd: current.source!.repo,
          env,
          signal,
          redactions: secrets,
          // A changed user.env, port, credential or voice tool restarts it.
          settings,
          restartOnConfigurationChange: true,
        });
        // Stop the Agent Service only when TeamHub is about to restart for a
        // changed configuration, so its graceful shutdown can requeue
        // in-flight Runs while TeamHub is still up. When TeamHub is not
        // running or not changing, node-services is left alone so it can
        // reconnect. It was running before this run, so it is never recorded
        // as started: if a later step fails, its replacement stays up beside
        // the new TeamHub; if TeamHub's own restart fails, node-services
        // stays stopped until the next resume.
        const preStopped =
          (await nativeConfigurationChanged(serviceOptions("teamhub"))) &&
          (await inspectNativeProcess(current.root, "node-services")).running;
        if (preStopped) await stopNativeProcess(current.root, "node-services");
        for (const name of ["teamhub", "node-services", "web"] as const) {
          const running = (await inspectNativeProcess(current.root, name))
            .running;
          if (!running && !(preStopped && name === "node-services"))
            started.push(name);
          await startNativeProcess(serviceOptions(name));
        }
        const checks = await waitHealthy(current, signal, emit, ends);
        emit({
          kind: "stage",
          stage: "services",
          state: "succeeded",
          message: "Native source services are ready.",
        });
        step("account", "Preparing local account and workspace…");
        await ensureLocalAccount(current, signal, {
          email: options.email,
          password: options.password,
          provisionOwner: async (email, password) => {
            secrets.push(password);
            await command("owner", { OWNER_EMAIL: email }, `${password}\n`);
          },
        });
        emit({
          kind: "stage",
          stage,
          state: "succeeded",
          message: "Local account is ready.",
        });

        await runtime;
        signal.throwIfAborted();
        if (options.externalComputer) {
          const authPending =
            (runtimeOutcome?.details as { code?: string } | undefined)?.code ===
            "RUNTIME_AUTH_REQUIRED";
          emit({
            kind: "stage",
            stage: "computer",
            state: "skipped",
            message: "The desktop client connects this Computer after sign-in.",
          });
          emit({
            kind: "stage",
            stage: "runtime",
            state: authPending ? "waiting_user" : "succeeded",
            message: authPending
              ? "Runtime sign-in can be completed later."
              : "Runtime is ready.",
          });
          return {
            code: 0,
            state: "ready",
            message: `Native source services are running: ${current.origin}`,
            details: {
              origin: current.origin,
              services: checks,
              computer: {
                state: "action_required",
                connected: false,
                detail:
                  "The desktop client connects this Computer after sign-in.",
                runtimes: [],
                activeOperations: 0,
              },
              businessVerification: "not_run",
            },
          };
        }
        step("computer", "Connecting this Computer to the native workspace…");
        try {
          await prepareSourceComputer(current, signal, (value) =>
            output.write(value),
          );
          const computer = await connectComputer(current, {
            signal,
            interactive: false,
            authorize: () => prepareLocalEnrollment(current, signal),
            onProgress: (value) => output.write(value),
          });
          const authPending =
            (runtimeOutcome?.details as { code?: string } | undefined)?.code ===
            "RUNTIME_AUTH_REQUIRED";
          const ready = computer.state === "ready" && !authPending;
          emit({
            kind: "stage",
            stage: "computer",
            state: computer.connected ? "succeeded" : "waiting_user",
            message: computer.detail,
          });
          emit({
            kind: "stage",
            stage: "runtime",
            state: ready ? "succeeded" : "waiting_user",
            message: ready
              ? "Runtime is ready."
              : "Runtime sign-in can be completed later.",
          });
          return {
            code: ready ? 0 : 4,
            state: ready ? "ready" : "action_required",
            message: `Native source services are running: ${current.origin}\n${computer.detail}`,
            details: {
              origin: current.origin,
              services: checks,
              computer,
              businessVerification: "not_run",
              ...(authPending && typeof runtimeOutcome?.details === "object"
                ? runtimeOutcome.details
                : {}),
            },
          };
        } catch (error) {
          options.signal.throwIfAborted();
          const detail = safe(
            error instanceof Error
              ? error.message
              : "Computer connection requires attention.",
          );
          return {
            code: 4,
            state: "action_required",
            message: `Native source services are running: ${current.origin}\n${detail}`,
            details: {
              code: "COMPUTER_SETUP_REQUIRED",
              origin: current.origin,
              services: await probeNativeSourceServices(
                current,
                options.signal,
              ),
              computer: {
                state: "action_required",
                connected: false,
                detail,
                runtimes: [],
                activeOperations: -1,
              },
              businessVerification: "not_run",
            },
          };
        }
      } catch (error) {
        // The side that failed first is the cause; the other one only
        // stopped because of it. Only the Runtime aborts the controller
        // before this point.
        const runtimeFailedFirst = controller.signal.aborted;
        controller.abort();
        await runtime;
        for (const name of started.reverse()) {
          try {
            await stopNativeProcess(current.root, name);
          } catch {
            emit({
              kind: "log",
              stage,
              message: `Native ${name} cleanup needs attention; its identity record was retained.`,
            });
          }
        }
        options.signal.throwIfAborted();
        if (runtimeFailedFirst) {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- rethrows the first failure unchanged
          if (runtimeError) throw runtimeError;
          if (
            runtimeOutcome &&
            runtimeOutcome.code !== 0 &&
            (runtimeOutcome.details as { code?: string } | undefined)?.code !==
              "RUNTIME_AUTH_REQUIRED"
          )
            return runtimeOutcome;
        }
        throw error;
      } finally {
        controller.abort();
        await runtime;
      }
    });
  } catch (error) {
    const interrupted = options.signal.aborted;
    const versionFailure = runtimeVersionFailure(error);
    // An abort nobody asked for has no cause of its own to show; name the
    // step instead of the bare "This operation was aborted".
    const unexplained =
      !interrupted && error instanceof Error && error.name === "AbortError";
    const detail =
      versionFailure?.message ??
      (unexplained
        ? `Setup stopped unexpectedly while ${STAGE_ACTIVITY[stage]}. Retry; if it stops again, send the installer log to support.`
        : safe(
            error instanceof Error
              ? error.message
              : "Native source installation failed.",
          ));
    if (error instanceof Error)
      emit({
        kind: "log",
        stage,
        message: `Native source installation ended in ${stage}: ${error.name}: ${error.message}\n`,
      });
    emit({ kind: "stage", stage, state: "failed", message: detail });
    return {
      code: interrupted ? 130 : 1,
      state: interrupted ? "cancelled" : "failed",
      message: `${detail}\nData is retained. Retry the installation.`,
      details: {
        code: versionFailure?.code ?? "NATIVE_SOURCE_INSTALLATION_FAILED",
        stage,
        ...(instance ? { origin: instance.origin } : {}),
      },
    };
  } finally {
    output.flush();
  }
}
export async function stopNativeSource(
  instance: Instance,
  signal?: AbortSignal,
) {
  requireNative(instance);
  await withInstanceLock(instance, async () => {
    signal?.throwIfAborted();
    await stopComputer(instance, { signal });
    for (const name of nativeServices) {
      signal?.throwIfAborted();
      await stopNativeProcess(instance.root, name);
    }
    await stopModelGateway(instance, signal);
  });
}
export async function nativeSourceLogs(
  instance: Instance,
  options: {
    service?: string;
    follow?: boolean;
    signal?: AbortSignal;
    onOutput?: (chunk: string) => void;
  } = {},
) {
  requireNative(instance);
  const names = options.service ? [options.service] : [...nativeServices];
  if (names.some((name) => !nativeServices.includes(name as NativeService)))
    throw new Error("Unknown native source service");
  const positions = new Map<string, number>();
  const streams = new Map<string, ReturnType<typeof lineRedactor>>();
  let stdout = "";
  const write = (name: string, chunk: string) => {
    const labelled = `[${name}] ${chunk}`;
    options.onOutput?.(labelled);
    stdout = (stdout + labelled).slice(-256 * 1024);
  };
  try {
    do {
      options.signal?.throwIfAborted();
      for (const name of names) {
        const file = path.join(instance.root, "native/logs", `${name}.log`);
        let handle;
        try {
          handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        try {
          const info = await handle.stat();
          // Windows reports no owner or mode; the native directory ACL applies.
          if (
            !info.isFile() ||
            (process.platform !== "win32" &&
              (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))
          )
            throw new Error("Native logs must be private owned regular files.");
          let offset = positions.get(name);
          const initial = offset === undefined;
          if (offset === undefined) offset = Math.max(0, info.size - 64 * 1024);
          if (offset > info.size) {
            streams.get(name)?.flush();
            streams.delete(name);
            offset = 0;
          }
          let stream = streams.get(name);
          if (!stream) {
            stream = lineRedactor((value) => write(name, value));
            streams.set(name, stream);
          }
          // Read a bounded window from each service per poll, rather than loading
          // an ever-growing log into the installation manager's memory.
          const bytes = Buffer.alloc(
            Math.min(64 * 1024, Math.max(0, info.size - offset)),
          );
          const { bytesRead } = await handle.read(
            bytes,
            0,
            bytes.length,
            offset,
          );
          positions.set(name, offset + bytesRead);
          let text = bytes.subarray(0, bytesRead).toString("utf8");
          if (initial && offset > 0) {
            const boundary = text.indexOf("\n");
            text = boundary < 0 ? "" : text.slice(boundary + 1);
          }
          stream.write(text);
        } finally {
          await handle.close();
        }
      }
      if (!options.follow) break;
      await delay(500, undefined, { signal: options.signal });
    } while (!options.signal?.aborted);
  } finally {
    for (const stream of streams.values()) stream.flush();
  }
  return { stdout, stderr: "", code: 0 };
}
