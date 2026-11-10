import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import {
  constants as fsConstants,
  cp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createZstdDecompress } from "node:zlib";

import { downloadVerified } from "@linger/local-installation/download";
import {
  removeRetrying,
  renameRetrying,
} from "@linger/local-installation/fs-retry";
import {
  markNativeRuntimeVerified,
  nativeRuntimeVerified,
  NATIVE_RUNTIME_DIRECTORY,
  readNativeRuntime,
} from "@linger/local-installation/native-runtime";
import {
  installTeamhubBinaries,
  TEAMHUB_BINARY_DIRECTORY,
} from "@linger/local-installation/teamhub-binaries";
import { adoptUserEnvironment } from "@linger/local-installation/user-environment";

import {
  NODE_RUNTIME_RELEASES,
  NODE_RUNTIME_VERSION,
  nodeRuntimeDownloadUrls,
} from "../../../../scripts/local-computer-node-distributions.mjs";
import type { Module, ModuleContext } from "./modules.js";
import { humanTenant, type EnrollmentModule } from "./enrollment.js";
import type { WindowManagerModule } from "./window-manager.js";
import {
  installerKeyChanges,
  savedProviderKeys,
  type ProviderKeyChanges,
} from "./provider-keys.js";

// The pinned linger source this build installs, written by the release build:
// downloaded from `url` (or a mirror of it), or bundled in the app at `file`.
export type SourceArchive =
  | {
      readonly url: string;
      readonly mirrors?: readonly string[];
      readonly sha256: string;
    }
  | { readonly file: string; readonly sha256: string };

// The source package's dependency store for this platform, published beside
// it; the native install then needs no package registry.
export interface SourceDependencies {
  readonly url: string;
  readonly mirrors?: readonly string[];
  readonly sha256: string;
}
// A file every complete source tree has.
const SOURCE_MARKER = "scripts/source-native.mjs";
// Where scripts/source-native.mjs looks for that store in the checkout.
const DEPENDENCY_STORE = ".linger-runtime/pnpm-store";

// The inference model the installer would deploy here, with what it needs.
export interface LocalModel {
  readonly name: string;
  readonly downloadBytes: number | null;
  readonly diskBytes: number | null;
  readonly memoryBytes: number | null;
}

// What the installer found on this computer, for the optional local model.
export type LocalModelsCheck =
  | { readonly state: "unchecked" | "checking" | "unavailable" }
  | {
      readonly state: "checked";
      // Whether this computer can serve a local model at all.
      readonly eligible: boolean;
      readonly memoryBytes: number;
      readonly diskFreeBytes: number | null;
      readonly gpu?: string;
      // Present only when eligible.
      readonly model?: LocalModel;
      // Why not, in the localmodels tool's words; present only when not
      // eligible.
      readonly reasons?: readonly string[];
    };

// What to install, chosen on the setup page; the installer applies it at once.
export interface LocalServerPlan {
  // "local" runs tasks on an inference model deployed on this computer.
  readonly runtime: "recommended" | "codex" | "claude" | "pi" | "local";
  // Provider keys edited on the page, saved before the installer runs.
  readonly keys?: ProviderKeyChanges;
}

export const QUICK_INSTALL: LocalServerPlan = {
  runtime: "recommended",
};

// Whether the installer can set up PostgreSQL for a native install on
// `target`: it takes the source for it from LINGER_NATIVE_DEPENDENCIES_JSON
// or else the distribution.json beside it.
export function hasNativePostgres(
  installerDirectory: string,
  target: string,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  // A bundled archive (Windows) must also be there; it is named relative to
  // the installer, or absolute in the environment.
  const covers = (sources: unknown) =>
    Array.isArray(sources) &&
    sources.some((source) => {
      const value = source as { target?: unknown; file?: unknown } | null;
      return (
        value?.target === target &&
        (value.file === undefined ||
          (typeof value.file === "string" &&
            existsSync(path.resolve(installerDirectory, value.file))))
      );
    });
  try {
    const raw = environment.LINGER_NATIVE_DEPENDENCIES_JSON;
    if (raw) return covers(JSON.parse(raw));
    const value = JSON.parse(
      readFileSync(path.join(installerDirectory, "distribution.json"), "utf8"),
    ) as { platform?: unknown; arch?: unknown; nativeSources?: unknown };
    return (
      `${String(value.platform)}-${String(value.arch)}` === target &&
      covers(value.nativeSources)
    );
  } catch {
    return false;
  }
}

// The steps the setup page shows, in order. "download" shows only when
// something big is downloaded: the source package.
// "signin" shows only when the AI runtime has no sign-in on this computer.
export const LOCAL_STEPS = [
  "prepare",
  "download",
  "services",
  "workspace",
  "signin",
  "connect",
  "agents",
] as const;
export type LocalServerStep = (typeof LOCAL_STEPS)[number];

export type LocalServerPhase =
  | "idle"
  | "preparing"
  | "installing"
  | "ready"
  | "failed";

// Where the installation goes: the installer home, holding the source, the
// build and the data.
export interface LocalServerLocation {
  readonly path: string;
  // Chosen on the setup page instead of the default.
  readonly custom: boolean;
  // Why the folder last chosen cannot be used.
  readonly error?: string;
}

export type LocalRuntime = "codex" | "claude" | "pi";

// The AI runtime's own sign-in, which the installer runs; while the setup
// page waits for it. No secret passes through here: the person signs in on
// the vendor's page, and Claude Code's authorization code goes straight to
// its login process.
export interface RuntimeSignIn {
  readonly runtime: LocalRuntime;
  // required: not started; starting/waiting_user: the login runs, url is
  // the vendor's page and deviceCode what to enter there; failed: it ended
  // without a sign-in (message says why); signed_in: done, the step stays
  // on the list.
  readonly state:
    | "required"
    | "starting"
    | "waiting_user"
    | "failed"
    | "signed_in";
  readonly url?: string;
  readonly deviceCode?: string;
  // The vendor's page shows a code to paste back (Claude Code).
  readonly acceptsCode?: boolean;
  readonly message?: string;
}

export interface LocalServerStatus {
  // Source installs ship for macOS arm64, Linux x64 and Windows x64 only, and need the
  // pinned source package or a developer checkout.
  readonly available: boolean;
  readonly phase: LocalServerPhase;
  readonly message: string;
  // While installing: the steps shown, the current one and the overall share
  // done (0-1).
  readonly steps: readonly LocalServerStep[];
  readonly step: LocalServerStep;
  readonly progress: number;
  // Which installation this is; each Install or Try Again starts a new one.
  readonly attempt: number;
  readonly localModels: LocalModelsCheck;
  readonly location: LocalServerLocation;
  // Which provider keys the installation location holds; never the
  // keys themselves.
  readonly keys: {
    readonly composio: boolean;
    readonly soniox: boolean;
    readonly xai: boolean;
  };
  readonly origin?: string;
  // While the "signin" step waits for the person.
  readonly signIn?: RuntimeSignIn;
}

export interface LocalServerOptions {
  // The default LINGER_HOME of the installer.
  // The desktop keeps its Node runtime and its record here wherever the
  // installation goes.
  readonly home: string;
  // The bundled installer (installer.js, web/, native-process-worker.mjs).
  readonly installerDirectory: string;
  readonly sourceArchive?: SourceArchive;
  readonly sourceDependencies?: SourceDependencies;
  // A linger checkout installed instead of the source package, for developers
  // (LINGER_CHECKOUT).
  readonly checkout?: string;
  // Signs the app's web session in to the local server with its owner.
  readonly signIn: (
    origin: string,
    email: string,
    password: string,
  ) => Promise<void>;
  // The cookie header of that web session, to follow the agents it sets up.
  readonly sessionCookie?: (origin: string) => Promise<string | undefined>;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly fetch?: typeof fetch;
  readonly pollMs?: number;
  // The free space a picked folder needs; LOCATION_FREE_BYTES by default.
  readonly freeBytes?: number;
  // How long setup waits for the Another Me; AGENTS_TIMEOUT_MS by default.
  readonly agentsTimeoutMs?: number;
  // Opens the runtime's sign-in page in the browser.
  readonly openExternal?: (url: string) => Promise<void>;
  // How often the sign-in step checks for a sign-in; SIGN_IN_POLL_MS by
  // default.
  readonly signInPollMs?: number;
  // Moves an unpacked folder into place; fs.rename by default.
  readonly rename?: (from: string, to: string) => Promise<void>;
  // The glibc of this Linux computer; the running one's by default.
  readonly glibcVersion?: string;
}

// The starter Room the server makes for a new owner, with their Agents.
const STARTER_ROOM = "Getting Started";
const AGENTS_TIMEOUT_MS = 5 * 60_000;
// Each check runs the installer's runtime status, a short process.
const SIGN_IN_POLL_MS = 3_000;

// The instance the desktop installs.
export const LOCAL_INSTANCE = "desktop";
const NATIVE_TARGETS = new Set(["darwin-arm64", "linux-x64", "win32-x64"]);
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
// The free space a first installation asks for, as the installer advises;
// a local model needs its own on top.
export const LOCATION_FREE_BYTES = 20 * GiB;

// Runs Linger on this computer: fetches a pinned Node 26 and the linger
// source, drives the bundled installer through its local API and signs the
// window in to the result. The desktop itself is the Computer, so the
// installer skips its own and the desktop enrolls once signed in.
export class LocalServerModule implements Module {
  readonly name = "LocalServer";
  readonly dependsOn = ["WindowManager", "Enrollment"];
  readonly #options: LocalServerOptions;
  #ctx: ModuleContext | undefined;
  #phase: LocalServerPhase = "idle";
  #message = "";
  #step: LocalServerStep = "prepare";
  #progress = 0;
  // Counts installations started, so the setup page restarts its timers.
  #attempt = 0;
  #origin: string | undefined;
  #running: Promise<void> | undefined;
  #check: LocalModelsCheck = { state: "unchecked" };
  // Read once from the bundled installer's distribution.
  #nativePostgres: boolean | undefined;
  // Where an installation goes unless the setup page chose another folder:
  // the one already installed, else the default home.
  #home: string;
  #location: string | undefined;
  #locationError: string | undefined;
  #node: Promise<string> | undefined;
  #abort = new AbortController();
  // The running installation when this app brings a newer source package;
  // the services move to it once the person chooses to update.
  #outdated: LocalRecord | undefined;
  #updating: Promise<void> | undefined;
  #offRetry: (() => void) | undefined;
  #offDaemon: (() => void) | undefined;
  #daemonFailure: string | undefined;
  #signIn: RuntimeSignIn | undefined;
  // The installer that runs the sign-in, and what the person asked for
  // while the step waits.
  #signInInstaller: InstallerApi | undefined;
  #signInWake: (() => void) | undefined;
  #switchTo: LocalRuntime | undefined;
  #opened: string | undefined;

  constructor(options: LocalServerOptions) {
    this.#options = options;
    this.#home = options.home;
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.#ctx = ctx;
    // After a reboot the local services are gone; start them again while the
    // window still points at them.
    const record = await this.#readRecord();
    if (record) this.#home = record.home;
    if (record && ctx.config.get().serverUrl === record.origin)
      void this.#resume(record, this.#abort.signal);
    this.#offDaemon = ctx.bus.on("computer.failed", (reason) => {
      this.#daemonFailure = reason;
    });
    this.#offRetry = ctx.bus.on("local-server.retry", () => {
      if (this.#phase === "failed" && record) {
        void this.#resume(record, this.#abort.signal);
      }
    });
  }

  async stop(): Promise<void> {
    this.#offRetry?.();
    this.#offDaemon?.();
    // The installer manager keeps running a started installation; it exits
    // by itself once idle.
    this.#abort.abort();
  }

  status(): LocalServerStatus {
    // The services run natively, so the build must carry PostgreSQL for
    // this computer.
    this.#nativePostgres ??= hasNativePostgres(
      this.#options.installerDirectory,
      this.#target(),
    );
    const available =
      NATIVE_TARGETS.has(this.#target()) &&
      existsSync(this.#installerScript()) &&
      !!(this.#options.sourceArchive || this.#options.checkout) &&
      this.#nativePostgres;
    const keys = savedProviderKeys(
      this.#location ?? this.#home,
      LOCAL_INSTANCE,
    );
    return {
      available,
      phase: this.#phase,
      message: this.#message,
      steps: this.#steps(),
      step: this.#step,
      progress: this.#progress,
      attempt: this.#attempt,
      localModels: this.#check,
      location: {
        path: this.#location ?? this.#home,
        custom: this.#location !== undefined,
        ...(this.#locationError ? { error: this.#locationError } : {}),
      },
      keys: {
        composio: !!keys.composio,
        soniox: !!keys.soniox,
        xai: !!keys.xai,
      },
      ...(this.#origin ? { origin: this.#origin } : {}),
      ...(this.#signIn ? { signIn: this.#signIn } : {}),
    };
  }

  // Installs, signs in and connects this computer; resolves once the window
  // shows the local server. A second call joins the running installation.
  begin(plan: LocalServerPlan = QUICK_INSTALL): Promise<void> {
    this.#running ??= this.#install(plan).finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  // Installs into a folder the person picked, once it can hold Linger; null
  // goes back to the default.
  async chooseLocation(picked: string | null): Promise<void> {
    if (this.#running) return;
    if (picked === null) {
      this.#location = undefined;
      this.#locationError = undefined;
    } else {
      const home = await installLocation(picked);
      this.#locationError = await checkLocation(home, this.#freeBytes());
      if (!this.#locationError)
        this.#location = home === this.#home ? undefined : home;
    }
    this.#ctx?.bus.emit("local-server.changed");
  }

  // Asks the installer, once per run, whether this computer can serve a
  // local model; the setup window asks as it opens, before anything is
  // installed. Then fetches the Node runtime an installation starts with.
  inspect(): void {
    if (
      this.#check.state !== "unchecked" ||
      this.#phase !== "idle" ||
      !this.status().available
    )
      return;
    this.#check = { state: "checking" };
    this.#ctx?.bus.emit("local-server.changed");
    const started = Date.now();
    const signal = this.#abort.signal;
    void this.#inspect(signal)
      .then(
        (check) => {
          this.#ctx?.log.info("local_server.inspected", {
            ms: Date.now() - started,
            eligible: check.state === "checked" && check.eligible,
            ...(check.state === "checked" && check.reasons
              ? { reasons: check.reasons }
              : {}),
          });
          this.#check = check;
        },
        (error: unknown) => {
          this.#ctx?.log.warn("local_server.inspect_failed", {
            ms: Date.now() - started,
            error: error instanceof Error ? error.message : String(error),
          });
          this.#check = { state: "unavailable" };
        },
      )
      .then(() => {
        this.#ctx?.bus.emit("local-server.changed");
        if (!signal.aborted)
          void this.#ensureNode(signal).catch(() => undefined);
      });
  }

  async #inspect(signal: AbortSignal): Promise<LocalModelsCheck> {
    // The app's own Node runs the check, so it needs no download of its own;
    // installing still uses the pinned Node runtime.
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [this.#installerScript(), "--home", this.#home, "--inspect"],
        {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "1",
            LINGER_HOME: this.#home,
          },
          signal,
        },
      );
      // The check logs how long its parts took on stderr.
      let logged = 0;
      createInterface({ input: child.stderr }).on("line", (line) => {
        if (!line.trim() || logged++ >= 20) return;
        this.#ctx?.log.info("local_server.inspect_log", {
          line: line.slice(0, 300),
        });
      });
      let text = "";
      child.stdout.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
      });
      child.once("error", reject);
      child.once("close", () => resolve(text));
    });
    const report = JSON.parse(output.trim().split("\n").at(-1) ?? "") as {
      localModels?: {
        eligible?: unknown;
        reasons?: unknown;
        reasonMessages?: unknown;
        estimate?: {
          model?: unknown;
          downloadBytes?: unknown;
          diskBytes?: unknown;
          memoryBytes?: unknown;
        };
      };
      hardware?: {
        totalMemoryBytes?: unknown;
        diskFreeBytes?: unknown;
        gpus?: { name?: unknown }[];
      };
    };
    const hardware = report.hardware;
    if (
      typeof report.localModels?.eligible !== "boolean" ||
      typeof hardware?.totalMemoryBytes !== "number"
    )
      throw new Error("The installer could not check this computer");
    const gpu = hardware.gpus?.[0]?.name;
    const estimate = report.localModels.estimate;
    const bytes = (value: unknown) =>
      typeof value === "number" && value >= 0 ? value : null;
    const name =
      typeof estimate?.model === "string" && estimate.model
        ? estimate.model
        : undefined;
    // Offered only with a model to show; the plan names it.
    const eligible = report.localModels.eligible && !!name;
    const strings = (value: unknown) =>
      Array.isArray(value) ? value.map(String) : [];
    const messages = strings(report.localModels.reasonMessages);
    const reasons = strings(report.localModels.reasons).map((code, index) =>
      messages[index] ? `${code}: ${messages[index]}` : code,
    );
    return {
      state: "checked",
      eligible,
      memoryBytes: hardware.totalMemoryBytes,
      diskFreeBytes:
        typeof hardware.diskFreeBytes === "number"
          ? hardware.diskFreeBytes
          : null,
      ...(typeof gpu === "string" ? { gpu } : {}),
      ...(eligible && name
        ? {
            model: {
              name,
              downloadBytes: bytes(estimate?.downloadBytes),
              diskBytes: bytes(estimate?.diskBytes),
              memoryBytes: bytes(estimate?.memoryBytes),
            },
          }
        : {}),
      ...(!eligible && reasons.length ? { reasons } : {}),
    };
  }

  // Logs how long one part of setup took, so a slow setup says which part.
  async #timed<T>(step: string, run: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      return await run();
    } finally {
      this.#ctx?.log.info("local_server.timing", {
        step,
        ms: Date.now() - started,
      });
    }
  }

  async #install(plan: LocalServerPlan): Promise<void> {
    const status = this.status();
    if (!status.available)
      throw new Error("Running Linger on this computer is not supported here");
    const signal = this.#abort.signal;
    const home = this.#location ?? this.#home;
    this.#attempt += 1;
    try {
      // A retry starts over from the first step.
      this.#step = "prepare";
      this.#progress = 0;
      this.#endSignIn();
      this.#advance("prepare", 0, "Checking this computer…");
      await this.#adoptSourceKeys(home);
      // Keep what runs now until this version replaces it.
      const record = await this.#readRecord();
      await this.#timed("prune_sources", () =>
        this.#pruneSources(home, [
          record?.repo,
          this.#options.sourceArchive?.sha256.slice(0, 16),
        ]),
      );
      // A chosen folder may have filled up or gone since it was picked.
      if (this.#location) {
        const model =
          this.#check.state === "checked" ? this.#check.model : undefined;
        const error = await checkLocation(
          home,
          this.#freeBytes() +
            (plan.runtime === "local" ? (model?.diskBytes ?? 0) : 0),
        );
        if (error) throw new Error(error);
      }
      const node = await this.#timed("node", () => this.#ensureNode(signal));
      const keysChanged = Object.keys(plan.keys ?? {}).length > 0;
      if (keysChanged)
        await this.#timed("keys", () =>
          this.#saveKeys(node, home, plan.keys!, signal),
        );
      this.#advance(
        "download",
        0,
        this.#downloadsSource() ? "Downloading Linger…" : "Unpacking Linger…",
      );
      const repo = await this.#timed("source", () =>
        this.#ensureSource(home, signal),
      );
      await this.#timed("dependencies", () =>
        this.#ensureDependencies(repo, signal),
      );
      this.#advance("download", 0.1, "Starting the installer…");
      const installer = await this.#timed("installer_launch", () =>
        this.#launchInstaller(node, home, repo, signal),
      );
      const runInstaller = (next: LocalServerPlan, fresh = false) =>
        installer.run(
          next,
          signal,
          (stage, share, text) => this.#advance(stage, share, text),
          fresh,
        );
      // Changed keys reach the services only when the installation runs
      // again, even after one that finished.
      let job = await runInstaller(plan, keysChanged);
      // The runtime is installed but has no sign-in here: the server would
      // never create the Another Me, so ask for it now. Another runtime
      // reruns the installation for it.
      for (;;) {
        const switchTo = job.signInRequired
          ? await this.#awaitSignIn(installer, signal)
          : undefined;
        if (!switchTo) break;
        this.#endSignIn();
        this.#step = "services";
        job = await runInstaller({ ...plan, runtime: switchTo }, true);
      }
      // The desktop's Computer runs the runtime this installer set up, with
      // its profile, rather than whatever its PATH finds.
      const runtime = await installer.runtime();
      this.#ctx?.config.update({ runtimeEnvironment: runtime.environment });
      this.#ctx?.log.info("local_server.runtime", {
        runtime: runtime.setupChoice,
        keys: Object.keys(runtime.environment),
      });
      this.#advance("connect", 0, "Connecting this computer…");
      const login = await installer.login();
      await this.#options.signIn(job.origin, login.email, login.password);
      await this.#writeRecord({
        home,
        repo,
        origin: job.origin,
      });
      await this.#pruneSources(home, [repo]);
      this.#home = home;
      this.#location = undefined;
      this.#ready(job.origin);
      await this.#ctx!.get<EnrollmentModule>("Enrollment").enroll();
      this.#advance("agents", 0, "Preparing your agents…");
      await this.#awaitAgents(job.origin, signal);
      this.#set("ready", "Linger is running on this computer.");
    } catch (error) {
      this.#endSignIn();
      if (signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      this.#ctx?.log.warn("local_server.install_failed", {
        step: this.#step,
        error: message,
      });
      this.#set("failed", message);
      throw error;
    }
  }

  #advance(step: LocalServerStep, share: number, message: string): void {
    const steps = this.#steps();
    share = Math.min(1, Math.max(0, share));
    // Without a download, its stages finish preparing instead.
    if (!steps.includes(step)) {
      step = "prepare";
      share = 0.5 + share / 2;
    }
    // The runtime prepares beside the checkout and both report; neither the
    // step nor the bar moves backwards.
    if (steps.indexOf(step) > steps.indexOf(this.#step)) this.#step = step;
    this.#progress = Math.max(
      this.#progress,
      (steps.indexOf(step) + share) / steps.length,
    );
    this.#set("installing", message);
  }

  // Waits on the "signin" step until the installer finds the runtime signed
  // in, which the person does here or in a terminal; resolves with another
  // runtime when they choose one instead. Nothing shows when it already is.
  async #awaitSignIn(
    installer: InstallerApi,
    signal: AbortSignal,
  ): Promise<LocalRuntime | undefined> {
    const choice = (await installer.runtime()).setupChoice;
    const runtime: LocalRuntime =
      choice === "codex" || choice === "claude" ? choice : "pi";
    this.#signInInstaller = installer;
    this.#switchTo = undefined;
    try {
      for (;;) {
        signal.throwIfAborted();
        if (this.#switchTo) return this.#switchTo;
        const login = await installer.runtimeLogin();
        if (login.state === "ready") {
          if (this.#signIn) {
            this.#ctx?.log.info("local_server.runtime_signed_in", { runtime });
            this.#signIn = { runtime, state: "signed_in" };
            this.#advance("signin", 1, "Signed in");
          }
          return undefined;
        }
        if (!this.#signIn)
          this.#ctx?.log.info("local_server.runtime_sign_in_required", {
            runtime,
          });
        this.#showSignIn(runtime, login);
        const woken = new Promise<void>((resolve) => {
          this.#signInWake = resolve;
        });
        await Promise.race([
          woken,
          delay(this.#options.signInPollMs ?? SIGN_IN_POLL_MS, undefined, {
            signal,
          }),
        ]);
      }
    } finally {
      this.#signInInstaller = undefined;
      this.#signInWake = undefined;
    }
  }

  // Shows the installer's login state on the step.
  #showSignIn(runtime: LocalRuntime, login: RuntimeLogin): void {
    const previous = this.#signIn;
    const state =
      login.state === "idle" || login.state === "ready"
        ? // A failure stays until the person tries again.
          previous?.state === "failed"
          ? "failed"
          : "required"
        : login.state;
    this.#signIn = {
      runtime,
      state,
      ...(state === "waiting_user" && login.url ? { url: login.url } : {}),
      ...(state === "waiting_user" && login.deviceCode
        ? { deviceCode: login.deviceCode }
        : {}),
      ...(state === "waiting_user" && login.acceptsCode
        ? { acceptsCode: true }
        : {}),
      ...(state === "failed"
        ? { message: login.message ?? previous?.message ?? "" }
        : {}),
    };
    // Claude Code and Codex open the browser themselves, on the page that
    // calls back to them; the link they print is the fallback that needs a
    // pasted code. A device login opens nothing, so its page opens here.
    if (
      this.#signIn.deviceCode &&
      this.#signIn.url &&
      this.#signIn.url !== this.#opened
    ) {
      this.#opened = this.#signIn.url;
      void this.openSignInPage();
    }
    this.#advance("signin", 0, `Sign in to ${RUNTIME_NAMES[runtime]}`);
  }

  #endSignIn(): void {
    this.#signIn = undefined;
    this.#signInInstaller = undefined;
    this.#signInWake = undefined;
    this.#opened = undefined;
  }

  // Starts the runtime's own login (the installer runs it), or hands it the
  // code the vendor's page showed.
  async startSignIn(code?: string): Promise<void> {
    const installer = this.#signInInstaller;
    const runtime = this.#signIn?.runtime;
    if (!installer || !runtime) return;
    this.#signIn = { runtime, state: "starting" };
    this.#ctx?.bus.emit("local-server.changed");
    const login = await installer
      .runtimeLogin(true, code)
      .catch((error: unknown) => ({
        state: "failed" as const,
        message: error instanceof Error ? error.message : String(error),
      }));
    if (this.#signInInstaller !== installer) return;
    if (login.state === "ready") this.#signInWake?.();
    else this.#showSignIn(runtime, login);
  }

  // Stops the runtime's login the person started; they can start it again.
  async cancelSignIn(): Promise<void> {
    const installer = this.#signInInstaller;
    const runtime = this.#signIn?.runtime;
    if (!installer || !runtime) return;
    await installer.cancelRuntimeLogin();
    if (this.#signInInstaller !== installer) return;
    this.#signIn = { runtime, state: "required" };
    this.#opened = undefined;
    this.#ctx?.bus.emit("local-server.changed");
  }

  // Leaves the sign-in for another AI runtime; the installation reruns for
  // it.
  switchRuntime(runtime: LocalRuntime): void {
    if (!this.#signInInstaller || runtime === this.#signIn?.runtime) return;
    this.#switchTo = runtime;
    this.#signInWake?.();
  }

  async openSignInPage(): Promise<void> {
    const url = this.#signIn?.url;
    if (url && new URL(url).protocol === "https:")
      await this.#options.openExternal?.(url);
  }

  // Whether the source package comes over the network; a bundled one and a
  // developer's checkout are already here.
  #downloadsSource(): boolean {
    const archive = this.#options.sourceArchive;
    return !this.#options.checkout && !!archive && "url" in archive;
  }

  // The steps the setup page shows: downloading only when the source comes
  // over the network.
  #steps(): readonly LocalServerStep[] {
    return LOCAL_STEPS.filter(
      (step) =>
        (step !== "download" || this.#downloadsSource()) &&
        (step !== "signin" || this.#signIn !== undefined),
    );
  }

  #set(phase: LocalServerPhase, message: string): void {
    // A failure stays on the step it happened in.
    if (phase !== "installing" && phase !== "ready" && phase !== "failed") {
      this.#progress = 0;
      this.#step = "prepare";
    }
    if (phase === "ready") this.#progress = 1;
    this.#phase = phase;
    this.#message = message;
    this.#ctx?.bus.emit("local-server.changed");
  }

  #freeBytes(): number {
    return this.#options.freeBytes ?? LOCATION_FREE_BYTES;
  }

  #target(): string {
    return `${this.#options.platform ?? process.platform}-${this.#options.arch ?? process.arch}`;
  }

  #installerScript(): string {
    return path.join(this.#options.installerDirectory, "installer.js");
  }

  // The desktop's own files in the default home.
  #desktopDirectory(...parts: string[]): string {
    return path.join(this.#options.home, "desktop", ...parts);
  }

  // Checking this computer and installing may both need Node at once.
  #ensureNode(signal: AbortSignal): Promise<string> {
    this.#node ??= this.#fetchNode(signal).catch((error: unknown) => {
      this.#node = undefined;
      throw error;
    });
    return this.#node;
  }

  async #fetchNode(signal: AbortSignal): Promise<string> {
    const release = NODE_RUNTIME_RELEASES[this.#target()];
    if (!release) throw new Error("No Node.js build for this computer");
    const directory = this.#desktopDirectory(
      "node",
      `v${NODE_RUNTIME_VERSION}`,
    );
    // Windows builds are zips with node.exe at the top.
    const binary =
      (this.#options.platform ?? process.platform) === "win32"
        ? path.join(directory, "node.exe")
        : path.join(directory, "bin", "node");
    if (existsSync(binary)) return binary;
    // A build that bundles the services also bundles this same Node.js: the
    // release archive, or on macOS its signed binary.
    const bundle = await this.#bundledRuntime();
    const bundled = bundle?.node;
    if (
      bundle?.layout === "directory" &&
      bundled?.version === NODE_RUNTIME_VERSION
    ) {
      await this.#copyBundled(
        this.#bundledRuntimeFile(path.dirname(path.dirname(bundled.file))),
        directory,
        { file: path.relative(directory, binary), sha256: bundled.sha256 },
        signal,
      );
      return binary;
    }
    if (
      bundled?.file === release.archive &&
      bundled.sha256 === release.sha256
    ) {
      await this.#extract(
        {
          file: this.#bundledRuntimeFile(bundled.file),
          sha256: bundled.sha256,
        },
        directory,
        path.relative(directory, binary),
        signal,
      );
      return binary;
    }
    const [url, ...mirrors] = nodeRuntimeDownloadUrls(release.archive);
    await this.#unpack(
      {
        url: url!,
        mirrors,
        sha256: release.sha256,
        maxBytes: 256 * MiB,
      },
      directory,
      path.relative(directory, binary),
      this.#desktopDirectory("downloads"),
      signal,
    );
    return binary;
  }

  // The source package, unpacked once into the installation folder; or the
  // developer's checkout.
  async #ensureSource(home: string, signal: AbortSignal): Promise<string> {
    if (this.#options.checkout) {
      const repo = await realpath(this.#options.checkout);
      if (!(await isFile(path.join(repo, "scripts/source-native.mjs"))))
        throw new Error(
          "LINGER_CHECKOUT is not a Linger checkout (scripts/source-native.mjs is missing)",
        );
      return repo;
    }
    const archive = this.#options.sourceArchive;
    if (!archive) throw new Error("This build has no source package");
    const directory = path.join(
      home,
      "desktop",
      "source",
      archive.sha256.slice(0, 16),
    );
    if (await isFile(path.join(directory, SOURCE_MARKER))) {
      await this.#timed("teamhub_binaries", () =>
        this.#ensureTeamhubBinaries(directory, archive.sha256, signal),
      );
      await this.#timed("native_runtime", () =>
        this.#ensureNativeRuntime(directory, archive.sha256, signal),
      );
      return directory;
    }
    if ("file" in archive)
      await this.#extract(archive, directory, SOURCE_MARKER, signal);
    else
      await this.#unpack(
        { ...archive, maxBytes: 1024 * MiB },
        directory,
        SOURCE_MARKER,
        path.join(home, "desktop", "downloads"),
        signal,
        (share) =>
          this.#advance("download", share * 0.05, "Downloading Linger…"),
      );
    if (!(await isFile(path.join(directory, SOURCE_MARKER))))
      throw new Error("The source package is not a Linger source tree");
    await this.#timed("teamhub_binaries", () =>
      this.#ensureTeamhubBinaries(directory, archive.sha256, signal),
    );
    await this.#timed("native_runtime", () =>
      this.#ensureNativeRuntime(directory, archive.sha256, signal),
    );
    return directory;
  }

  // The manifest of the services and Node.js this build bundles for this
  // computer (scripts/build-native-runtime.mjs), or undefined without them.
  async #bundledRuntime(): Promise<BundledRuntime | undefined> {
    try {
      return JSON.parse(
        await readFile(this.#bundledRuntimeFile("manifest.json"), "utf8"),
      ) as BundledRuntime;
    } catch {
      return undefined;
    }
  }

  #bundledRuntimeFile(file: string): string {
    return path.join(
      this.#options.installerDirectory,
      "native",
      `runtime-${this.#target()}`,
      file,
    );
  }

  // Unpacks the services this build compiled from its source package into
  // the source, so Native installs no packages and needs no network. Without
  // them Native installs the source's packages and runs it in development.
  async #ensureNativeRuntime(
    repo: string,
    sha256: string,
    signal: AbortSignal,
  ): Promise<void> {
    const bundle = await this.#bundledRuntime();
    if (!bundle) return;
    const target = this.#target();
    const directory = path.join(repo, NATIVE_RUNTIME_DIRECTORY);
    const glibc = this.#glibcVersion();
    if (glibc && !atLeast(glibc, MIN_GLIBC)) {
      // Its native packages, like the PostgreSQL build, need a newer glibc;
      // Native installs the source's packages instead.
      this.#ctx?.log.warn("local_server.native_runtime_skipped", {
        glibc,
        required: MIN_GLIBC,
      });
      return;
    }
    try {
      if (bundle.target !== target || bundle.sourceArchiveSha256 !== sha256)
        throw new Error("The bundled services are for another source package");
      const current = await readNativeRuntime(directory).catch(() => undefined);
      if (
        current?.target === target &&
        current.sourceArchiveSha256 === sha256 &&
        (await nativeRuntimeVerified(directory))
      )
        return;
      this.#advance("download", 0.05, "Unpacking Linger services…");
      await removeRetrying(directory);
      if (bundle.layout === "directory")
        await this.#copyBundled(
          this.#bundledRuntimeFile(path.dirname(bundle.directory!.file)),
          directory,
          {
            file: path.basename(bundle.directory!.file),
            sha256: bundle.directory!.sha256,
          },
          signal,
        );
      else {
        const file = this.#bundledRuntimeFile(bundle.archive!.file);
        await this.#checkArchive(file, bundle.archive!.sha256, signal);
        // Unpacked in place: renaming a folder of fresh files waited up to
        // 30 s for Windows' scanners.
        await this.#unpackInto(file, directory, signal);
      }
      // The record written last marks it complete, and the installer then
      // need not hash every file.
      await markNativeRuntimeVerified(directory);
      this.#ctx?.log.info("local_server.native_runtime", { target });
    } catch (error) {
      if (signal.aborted) throw error;
      await removeRetrying(directory).catch(() => undefined);
      this.#ctx?.log.warn("local_server.native_runtime_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // The glibc this Linux computer runs, or undefined elsewhere.
  #glibcVersion(): string | undefined {
    if ((this.#options.platform ?? process.platform) !== "linux") return;
    if (this.#options.glibcVersion) return this.#options.glibcVersion;
    const report = process.report.getReport() as
      | { header?: { glibcVersionRuntime?: string } }
      | undefined;
    return report?.header?.glibcVersionRuntime;
  }

  // Copies a folder the app bundles unpacked (macOS) to `directory`, which
  // appears only once complete; `check` is a file in it with its sha256.
  // Files copied out of a downloaded app keep its quarantine, and macOS would
  // refuse to run the binaries among them.
  async #copyBundled(
    from: string,
    directory: string,
    check: { file: string; sha256: string },
    signal: AbortSignal,
  ): Promise<void> {
    if (existsSync(path.join(directory, check.file))) return;
    const copied = `${directory}.partial`;
    try {
      await removeRetrying(copied);
      await mkdir(path.dirname(copied), { recursive: true });
      // A clone on APFS: no extra space and no time.
      await cp(from, copied, {
        recursive: true,
        mode: fsConstants.COPYFILE_FICLONE,
      });
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(
        path.join(copied, check.file),
        { signal },
      ))
        hash.update(chunk as Buffer);
      if (hash.digest("hex") !== check.sha256)
        throw new Error(`The bundled ${check.file} is damaged`);
      await this.#unquarantine(copied, signal);
      await this.#publish(copied, directory, check.file, signal);
    } finally {
      await removeRetrying(copied);
    }
  }

  async #unquarantine(directory: string, signal: AbortSignal): Promise<void> {
    if ((this.#options.platform ?? process.platform) !== "darwin") return;
    await run(
      "/usr/bin/xattr",
      ["-dr", "com.apple.quarantine", directory],
      directory,
      signal,
    ).catch((error: unknown) => {
      if (signal.aborted) throw error;
      this.#ctx?.log.warn("local_server.unquarantine_failed", {
        directory,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  // Copies the TeamHub binaries this build compiled from its source package
  // into the source, so Native runs them instead of compiling. Without them
  // Native downloads Go and compiles TeamHub itself.
  async #ensureTeamhubBinaries(
    repo: string,
    sha256: string,
    signal: AbortSignal,
  ): Promise<void> {
    const target = this.#target();
    try {
      const state = await installTeamhubBinaries(
        path.join(
          this.#options.installerDirectory,
          "native",
          `teamhub-${target}`,
        ),
        repo,
        { target, sourceArchiveSha256: sha256 },
      );
      if (state === "installed") {
        await this.#unquarantine(
          path.join(repo, TEAMHUB_BINARY_DIRECTORY),
          signal,
        );
        this.#ctx?.log.info("local_server.teamhub_binaries", { target });
      }
    } catch (error) {
      this.#ctx?.log.warn("local_server.teamhub_binaries_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Unpacks the published dependency store into the checkout, so installing
  // its packages needs no registry. Without it, the installer downloads them.
  async #ensureDependencies(repo: string, signal: AbortSignal): Promise<void> {
    const bundle = this.#options.sourceDependencies;
    if (this.#options.checkout || !bundle) return;
    const store = path.join(repo, DEPENDENCY_STORE);
    if (existsSync(store)) return;
    const message = "Downloading Linger dependencies…";
    this.#advance("download", 0.05, message);
    try {
      await this.#unpack(
        { ...bundle, maxBytes: 4 * GiB },
        store,
        ".",
        path.join(path.dirname(path.dirname(repo)), "downloads"),
        signal,
        (share) => this.#advance("download", 0.05 + share * 0.05, message),
      );
    } catch (error) {
      if (signal.aborted) throw error;
      this.#ctx?.log.warn("local_server.dependencies_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Keys used to go in the unpacked source package's .env, which the next
  // update deleted. They move once into the instance's user.env, which the
  // installer reads and every update keeps; a developer's checkout is left
  // alone.
  async #adoptSourceKeys(home: string): Promise<void> {
    if (this.#options.checkout) return;
    const parent = path.join(home, "desktop", "source");
    const root = path.join(home, "instances", LOCAL_INSTANCE);
    for (const entry of await readdir(parent).catch(() => [] as string[])) {
      const moved = await adoptUserEnvironment(
        root,
        path.join(parent, entry, ".env"),
        (keys) => this.#ctx?.log.warn("local_server.keys_not_moved", { keys }),
      );
      if (moved.length)
        this.#ctx?.log.info("local_server.keys_moved", { keys: moved });
    }
  }

  // Each version unpacks beside the last and builds its own dependencies, so
  // once services run from this one the older ones only fill the disk.
  async #pruneSources(
    home: string,
    keep: readonly (string | undefined)[],
  ): Promise<void> {
    if (this.#options.checkout) return;
    const parent = path.join(home, "desktop", "source");
    const kept = keep.flatMap((item) => (item ? [path.basename(item)] : []));
    for (const entry of await readdir(parent).catch(() => [] as string[]))
      if (!kept.includes(entry))
        await rm(path.join(parent, entry), {
          recursive: true,
          force: true,
        }).catch(() => undefined);
  }

  // Downloads a verified archive and unpacks its single top-level folder
  // into `directory`, which appears only once complete; `marker` is a file
  // every complete one has.
  async #unpack(
    archive: {
      url: string;
      mirrors?: readonly string[];
      sha256: string;
      maxBytes: number;
    },
    directory: string,
    marker: string,
    downloads: string,
    signal: AbortSignal,
    onShare?: (share: number) => void,
  ): Promise<void> {
    await mkdir(downloads, { recursive: true, mode: 0o700 });
    const file = path.join(
      downloads,
      path.basename(new URL(archive.url).pathname),
    );
    const unpacked = `${directory}.partial`;
    try {
      await downloadVerified(
        {
          url: archive.url,
          ...(archive.mirrors && { mirrors: archive.mirrors }),
          output: file,
          algorithm: "sha256",
          digest: archive.sha256,
          maxBytes: archive.maxBytes,
          signal,
          // A retry continues a large download where it stopped.
          resumable: true,
          onProgress: (completed, total) =>
            total && onShare?.(completed / total),
        },
        followHttps(this.#options.fetch ?? fetch),
      );
      await this.#unpackInto(file, unpacked, signal);
      await this.#publish(unpacked, directory, marker, signal);
    } finally {
      await rm(file, { force: true });
      await removeRetrying(unpacked);
    }
  }

  // Unpacks an archive bundled in the app after checking its digest.
  async #extract(
    archive: { file: string; sha256: string },
    directory: string,
    marker: string,
    signal: AbortSignal,
  ): Promise<void> {
    const file = path.resolve(this.#options.installerDirectory, archive.file);
    await this.#checkArchive(file, archive.sha256, signal);
    const unpacked = `${directory}.partial`;
    try {
      await this.#unpackInto(file, unpacked, signal);
      await this.#publish(unpacked, directory, marker, signal);
    } finally {
      await removeRetrying(unpacked);
    }
  }

  async #checkArchive(
    file: string,
    sha256: string,
    signal: AbortSignal,
  ): Promise<void> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file, { signal }))
      hash.update(chunk as Buffer);
    if (hash.digest("hex") !== sha256)
      throw new Error(`The bundled ${path.basename(file)} is damaged`);
  }

  // Unpacks the archive's single top-level folder into an empty `unpacked`.
  // tar runs inside it and names the archive relative to it: those paths
  // stay ASCII under any user or chosen folder name, which Windows' tar.exe
  // may otherwise read in the ANSI code page.
  async #unpackInto(
    file: string,
    unpacked: string,
    signal: AbortSignal,
  ): Promise<void> {
    await removeRetrying(unpacked);
    await mkdir(unpacked, { recursive: true, mode: 0o700 });
    // Windows' tar may not read zstd; Node's zlib does, and tar reads stdin.
    if (file.endsWith(".zst")) {
      await run(
        tarCommand(),
        ["-xf", "-", "--strip-components=1"],
        unpacked,
        signal,
        createReadStream(file, { signal }).pipe(createZstdDecompress()),
      );
      return;
    }
    await run(
      tarCommand(),
      ["-xf", path.relative(unpacked, file), "--strip-components=1"],
      unpacked,
      signal,
    );
  }

  // Moves a finished `unpacked` folder to `directory`. One that is already
  // complete there stays; a half-done one is replaced. Windows can hold the
  // fresh files for a moment (antivirus, indexing), so the move waits that
  // out and the log keeps each locked attempt.
  async #publish(
    unpacked: string,
    directory: string,
    marker: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (existsSync(path.join(directory, marker))) return;
    await removeRetrying(directory);
    await renameRetrying(unpacked, directory, {
      ...(this.#options.platform ? { platform: this.#options.platform } : {}),
      ...(this.#options.rename ? { rename: this.#options.rename } : {}),
      signal,
      onRetry: (error, attempt) =>
        this.#ctx?.log.warn("local_server.rename_locked", {
          directory,
          attempt,
          code: error.code,
          error: error.message,
        }),
    });
  }

  // Saves the provider keys with the installer, before it installs; the keys go
  // over stdin, never in arguments or logs.
  async #saveKeys(
    node: string,
    home: string,
    changes: ProviderKeyChanges,
    signal: AbortSignal,
  ): Promise<void> {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        node,
        [
          this.#installerScript(),
          "--home",
          home,
          "--instance",
          LOCAL_INSTANCE,
          "--user-keys",
        ],
        {
          stdio: ["pipe", "pipe", "ignore"],
          windowsHide: true,
          env: { ...process.env, LINGER_HOME: home },
          signal,
        },
      );
      let text = "";
      child.stdout.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
      });
      child.once("error", reject);
      child.once("close", () => resolve(text));
      child.stdin.end(JSON.stringify(installerKeyChanges(changes)));
    });
    let outcome: { saved?: unknown; error?: unknown } = {};
    try {
      outcome = JSON.parse(output.trim().split("\n").at(-1) ?? "") as never;
    } catch {
      // Reported below.
    }
    if (!Array.isArray(outcome.saved))
      throw new Error(
        typeof outcome.error === "string"
          ? `Keys could not be saved: ${outcome.error}`
          : "Keys could not be saved",
      );
    this.#ctx?.log.info("local_server.keys_saved", { saved: outcome.saved });
    this.#ctx?.bus.emit("local-server.changed");
  }

  // Starts the installer manager (or reaches the one already running) and
  // opens an API session with the one-time token from its private launcher.
  async #launchInstaller(
    node: string,
    home: string,
    repo: string,
    signal: AbortSignal,
  ): Promise<InstallerApi> {
    const child = spawn(
      node,
      [
        this.#installerScript(),
        "--home",
        home,
        "--source-repo",
        repo,
        "--external-computer",
        "--instance",
        LOCAL_INSTANCE,
        "--no-open",
      ],
      {
        detached: true,
        // A detached Windows process otherwise opens its own console window.
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, LINGER_HOME: home },
      },
    );
    const log = this.#ctx?.log;
    // The installer explains a failed start on stderr; keep its last line.
    let reason = "";
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      reason = text.trim().split("\n").at(-1)?.slice(0, 500) || reason;
      log?.warn("local_server.installer_stderr", { line: text.slice(0, 500) });
    });
    const origin = await new Promise<string>((resolve, reject) => {
      let output = "";
      const fail = (message: string) => {
        child.stdout.removeAllListeners("data");
        reject(new Error(message));
      };
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        const match =
          /Installer is running at (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
        if (match) resolve(match[1]!);
      });
      child.once("error", () => fail("The installer could not start"));
      // "close" follows exit once stderr, which explains it, is drained.
      child.once("close", () =>
        fail(
          reason
            ? `The installer stopped while starting. ${reason}`
            : "The installer stopped while starting",
        ),
      );
      signal.addEventListener("abort", () => fail("Cancelled"), { once: true });
    });
    child.stdout.resume();
    child.unref();
    const launcher = await readFile(
      path.join(home, "installer", "launch.html"),
      "utf8",
    );
    const target = /url=([^"]+)"/.exec(launcher)?.[1]?.replaceAll("&amp;", "&");
    if (!target || new URL(target).origin !== origin)
      throw new Error("The installer did not provide a sign-in link");
    return InstallerApi.open(
      target,
      this.#options.fetch ?? fetch,
      this.#options.pollMs ?? 1000,
    );
  }

  #ready(origin: string): void {
    this.#origin = origin;
    this.#ctx?.get<WindowManagerModule>("WindowManager").setServer(origin);
  }

  // The server sets up the Another Me once this computer offers a signed-in
  // Runtime, then the starter Agents and their Room. Setup ends when they are
  // there, so the app opens with them rather than filling in afterwards.
  async #awaitAgents(origin: string, signal: AbortSignal): Promise<void> {
    const cookie = await this.#options.sessionCookie?.(origin);
    if (!cookie) return;
    const get = async (pathname: string): Promise<unknown> => {
      const response = await (this.#options.fetch ?? fetch)(
        new URL(pathname, origin),
        {
          headers: { accept: "application/json", cookie },
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        },
      );
      if (response.status === 404) return undefined;
      if (!response.ok)
        throw new Error(`${pathname} failed (${String(response.status)})`);
      return response.json();
    };
    const tenant = humanTenant(await get("/v0/me"));
    if (!tenant) return;
    const base = `/v0/tenants/${encodeURIComponent(tenant)}`;
    const timeout = this.#options.agentsTimeoutMs ?? AGENTS_TIMEOUT_MS;
    const deadline = Date.now() + timeout;
    for (;;) {
      signal.throwIfAborted();
      // A Computer service that cannot start never connects; waiting out the
      // deadline would only hide why.
      if (this.#daemonFailure) {
        this.#ctx?.log.warn("local_server.computer_failed", {
          reason: this.#daemonFailure,
        });
        throw new Error(computerServiceFailed(this.#daemonFailure));
      }
      // The Another Me has an Agent once the server created it; there is no
      // status to wait for.
      const anotherMe = (await get(`${base}/another-me`)) as
        | { agent_actor_id?: string }
        | undefined;
      if (!anotherMe) return;
      if (anotherMe.agent_actor_id) {
        const rooms = (await get(`${base}/rooms`)) as
          | { items?: { name?: string }[] }
          | undefined;
        if (rooms?.items?.some((room) => room.name === STARTER_ROOM)) return;
        // An owner who removed the starter Room is not kept waiting.
        if (Date.now() >= deadline) return;
        this.#advance("agents", 0.6, "Adding your starter agents…");
      } else {
        if (Date.now() >= deadline) {
          // Say what the server is missing, as this computer last reported it.
          const computers = (await get(`${base}/local-computers`).catch(
            () => undefined,
          )) as { items?: ReportedComputer[] } | undefined;
          const computerId = this.#ctx?.config.get().computerId;
          const computer = computers?.items?.find(
            (item) => item.computer_id === computerId,
          );
          this.#ctx?.log.warn("local_server.another_me_missing", {
            computer_id: computerId,
            computer_status: computer?.status,
            runtimes: computer?.runtimes?.map(
              (runtime) =>
                `${runtime.type}:${runtime.status}:${runtime.models?.length ?? 0}`,
            ),
          });
          throw new Error(
            anotherMeMissing(computers ? computer : null, timeout),
          );
        }
        this.#advance("agents", 0.2, "Preparing your Another Me…");
      }
      await delay(this.#options.pollMs ?? 1_000, undefined, { signal });
    }
  }

  // Runs the installer headless against the saved instance; it starts only
  // the services that are not running and asks for nothing. A newer source
  // package in an updated app waits for the person (updateSource) while the
  // installed one is still there.
  async #resume(record: LocalRecord, signal: AbortSignal): Promise<void> {
    this.#origin = record.origin;
    const windows = this.#ctx?.get<WindowManagerModule>("WindowManager");
    try {
      this.#set("preparing", "Starting Linger on this computer…");
      // The window would show the server as unreachable until it is back.
      if (!(await this.#reachable(record.origin))) windows?.showStarting();
      const newer = this.#newerSource(record);
      const repo =
        newer && !existsSync(record.repo)
          ? await this.#ensureSource(record.home, signal)
          : record.repo;
      await this.#runResume(record, repo, signal);
      if (repo !== record.repo) await this.#moved(record, repo);
      this.#outdated = newer && repo === record.repo ? record : undefined;
      this.#ready(record.origin);
      this.#set("ready", "Linger is running on this computer.");
    } catch (error) {
      if (signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      this.#ctx?.log.warn("local_server.resume_failed", { error: message });
      this.#set("failed", message);
      windows?.showStartFailed(message);
    }
  }

  // Whether the services already answer, such as after only the app quit.
  async #reachable(origin: string): Promise<boolean> {
    try {
      await (this.#options.fetch ?? fetch)(origin, {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(1_000),
      });
      return true;
    } catch {
      return false;
    }
  }

  // Whether the window's server is the one this app runs.
  serving(serverUrl: string): boolean {
    return this.#origin === serverUrl;
  }

  // Whether this app brings a source package the running services do not
  // use yet.
  sourceUpdateAvailable(): boolean {
    return this.#outdated !== undefined;
  }

  // Moves the services to this app's source package. The window shows that
  // Linger is updating while they restart, then the server again.
  updateSource(): Promise<void> {
    const record = this.#outdated;
    if (!record) return Promise.resolve();
    this.#updating ??= this.#updateSource(record).finally(() => {
      this.#updating = undefined;
    });
    return this.#updating;
  }

  async #updateSource(record: LocalRecord): Promise<void> {
    const signal = this.#abort.signal;
    const windows = this.#ctx?.get<WindowManagerModule>("WindowManager");
    windows?.showUpdating();
    try {
      this.#set("preparing", "Updating Linger on this computer…");
      const repo = await this.#ensureSource(record.home, signal);
      await this.#runResume(record, repo, signal);
      await this.#moved(record, repo);
      this.#outdated = undefined;
      this.#set("ready", "Linger is running on this computer.");
      this.#ctx?.log.info("local_server.source_updated", {
        source: path.basename(repo),
      });
    } catch (error) {
      if (signal.aborted) return;
      this.#ctx?.log.warn("local_server.update_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.#set(
        "failed",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      if (!signal.aborted) windows?.loadServer();
    }
  }

  #newerSource(record: LocalRecord): boolean {
    const archive = this.#options.sourceArchive;
    return (
      !this.#options.checkout &&
      !!archive &&
      path.basename(record.repo) !== archive.sha256.slice(0, 16)
    );
  }

  async #moved(record: LocalRecord, repo: string): Promise<void> {
    await this.#writeRecord({ ...record, repo });
    await this.#pruneSources(record.home, [repo]);
  }

  async #runResume(
    record: LocalRecord,
    repo: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.#adoptSourceKeys(record.home);
    const node = await this.#ensureNode(signal);
    const outcome = await new Promise<{ code: number; message: string }>(
      (resolve, reject) => {
        const child = spawn(
          node,
          [
            this.#installerScript(),
            "--home",
            record.home,
            "--source-repo",
            repo,
            "--external-computer",
            "--instance",
            LOCAL_INSTANCE,
            "--resume",
          ],
          {
            stdio: ["ignore", "pipe", "ignore"],
            // The pinned Node is a console program; without this Windows
            // opens a console window for it.
            windowsHide: true,
            env: { ...process.env, LINGER_HOME: record.home },
            signal,
          },
        );
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString("utf8");
        });
        child.once("error", reject);
        child.once("close", (code) => {
          try {
            const last = output.trim().split("\n").at(-1) ?? "";
            resolve(JSON.parse(last) as { code: number; message: string });
          } catch {
            reject(new Error(`The installer exited with code ${code}`));
          }
        });
      },
    );
    if (outcome.code !== 0)
      throw new Error(outcome.message || "The installation stopped");
  }

  // Kept in the default home, wherever the installation went.
  #recordFile(): string {
    return this.#desktopDirectory("local-server.json");
  }

  async #readRecord(): Promise<LocalRecord | undefined> {
    try {
      const value = JSON.parse(
        await readFile(this.#recordFile(), "utf8"),
      ) as Partial<LocalRecord>;
      return typeof value.repo === "string" && typeof value.origin === "string"
        ? {
            // Records from before the install location are in the default
            // home.
            home:
              typeof value.home === "string" && path.isAbsolute(value.home)
                ? value.home
                : this.#options.home,
            repo: value.repo,
            origin: value.origin,
          }
        : undefined;
    } catch {
      return undefined;
    }
  }

  async #writeRecord(record: LocalRecord): Promise<void> {
    await mkdir(this.#desktopDirectory(), { recursive: true, mode: 0o700 });
    await writeFile(this.#recordFile(), JSON.stringify(record), {
      mode: 0o600,
    });
  }
}

// What the desktop installed, so it can start the services again.
// dist/installer/native/runtime-<target>/manifest.json: an archive of the
// services beside the Node.js release, or on macOS both as folders.
interface BundledRuntime {
  target: string;
  sourceArchiveSha256: string;
  layout?: "archive" | "directory";
  archive?: { file: string; sha256: string };
  // runtime/files.json, when the services are a folder.
  directory?: { file: string; sha256: string };
  // The release archive, or node/bin/node in the folder layout.
  node?: { version?: string; file: string; sha256: string };
}

// The bundled services' native packages need this glibc or newer, like the
// PostgreSQL build: Ubuntu 22.04, Debian 12.
const MIN_GLIBC = "2.35";

const atLeast = (version: string, minimum: string): boolean => {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  const [wantMajor = 0, wantMinor = 0] = minimum.split(".").map(Number);
  return major !== wantMajor ? major > wantMajor : minor >= wantMinor;
};

interface LocalRecord {
  // The installer home.
  readonly home: string;
  readonly repo: string;
  readonly origin: string;
}

// This computer as the server's Local Computers list reports it.
export interface ReportedComputer {
  readonly computer_id?: string;
  readonly status?: string;
  readonly upgrade_required?: boolean;
  readonly runtimes?: readonly {
    readonly type?: string;
    readonly status?: string;
    readonly message?: string;
    readonly models?: readonly unknown[];
  }[];
  readonly workspace_grants?: readonly { readonly mode?: string }[];
}

const RUNTIME_NAMES: Record<string, string> = {
  codex: "Codex",
  claude: "Claude Code",
  pi: "Pi",
};

const RUNTIME_STATES: Record<string, string> = {
  not_installed: "not found on this computer",
  authentication_required: "not signed in",
  incompatible: "version not supported",
  error: "check failed",
  unknown: "not checked yet",
};

// Why setup gave up on the Another Me. The server creates it once this
// computer is online, shares a writable folder and reports a signed-in
// runtime with a model; `computer` is what the server last heard from this
// computer, undefined when it does not list it, null when the list could not
// be read.
export const computerServiceFailed = (reason: string): string =>
  `The Computer service on this computer cannot start: ${reason.replace(/[.\s]+$/, "")}. computer-daemon.log in the logs has details.`;

export const anotherMeMissing = (
  computer: ReportedComputer | undefined | null,
  timeoutMs: number,
): string => {
  const minutes = Math.max(1, Math.round(timeoutMs / 60_000));
  const waited = `Your Another Me was not created after ${minutes} minute${minutes === 1 ? "" : "s"}. The server creates it once this computer is connected with a signed-in AI runtime (Codex, Claude Code or Pi).`;
  const reason = ((): string => {
    if (computer === null)
      return "Linger could not read this computer's status from the server.";
    if (!computer)
      return "The server does not list this computer: it never connected, or it shares no folder with agents. Choose Reconnect This Computer in the Linger tray menu, then try again.";
    if (computer.status !== "online")
      return "The server sees this computer as offline: its Computer service is not connected. computer-daemon.log in the logs says why.";
    if (computer.upgrade_required)
      return "This computer's Computer service is too old for the server. Update Linger, then try again.";
    if (
      !computer.workspace_grants?.some(
        (grant) => grant.mode === "workspace-write",
      )
    )
      return "This computer shares no folder that agents can write to.";
    const runtimes = computer.runtimes ?? [];
    if (
      runtimes.some(
        (runtime) => runtime.status === "ready" && runtime.models?.length,
      )
    )
      return "This computer reports a signed-in runtime, but the server did not create the Another Me; the server log says why (another_me.create_failed).";
    const found = runtimes.map((runtime) => {
      const name = RUNTIME_NAMES[runtime.type ?? ""] ?? runtime.type;
      const state =
        runtime.status === "ready"
          ? "signed in but reports no models"
          : (RUNTIME_STATES[runtime.status ?? ""] ?? runtime.status);
      return `${name}: ${state}${runtime.message ? ` (${runtime.message})` : ""}`;
    });
    return [
      "No signed-in AI runtime is reported by this computer.",
      ...(found.length ? [`It found ${found.join("; ")}.`] : []),
      "Install Codex or Claude Code and sign in to it in a terminal (codex login, or claude), then restart Linger and try again.",
    ].join(" ");
  })();
  return `${waited}\n${reason}`;
};

interface Job {
  readonly id: string;
  readonly instance: string;
  readonly state: string;
  readonly createdAt: string;
  readonly preparation?: string;
  readonly stage?: string;
  readonly message?: string;
  readonly origin?: string;
  readonly errorCode?: string;
  // The deployment the installer asks to approve before a local model.
  readonly localModelsPlan?: { readonly planId: string };
  readonly stages: readonly {
    readonly id: string;
    readonly state: string;
    readonly progress?: { readonly completed: number; readonly total?: number };
  }[];
}

// Where each installer stage sits among the steps the setup page shows, as
// the share of that step it starts and ends at.
const STAGES: Record<string, readonly [LocalServerStep, number, number]> = {
  preflight: ["download", 0.1, 0.2],
  release: ["download", 0.2, 0.3],
  images: ["download", 0.3, 1],
  runtime: ["services", 0, 0.25],
  services: ["services", 0.25, 1],
  account: ["workspace", 0, 1],
  computer: ["workspace", 1, 1],
};

// Done: services run and the owner exists. A runtime sign-in still missing
// is the setup page's own step.
const finished = (job: Job): boolean =>
  !!job.origin &&
  (job.state === "succeeded" ||
    (job.state === "waiting_user" &&
      job.errorCode === "RUNTIME_AUTH_REQUIRED"));

// The runtime has no sign-in on this computer. The desktop connects the
// Computer itself (--external-computer), so the job succeeds and only its
// runtime stage waits; an installation that connects one ends waiting with
// RUNTIME_AUTH_REQUIRED instead.
const signInRequired = (job: Job): boolean =>
  job.errorCode === "RUNTIME_AUTH_REQUIRED" ||
  job.stages.some(
    (stage) => stage.id === "runtime" && stage.state === "waiting_user",
  );

// Why a local model could not be deployed after all.
const LOCAL_MODEL_FAILURES = new Set([
  "LOCAL_MODELS_APPROVAL_REQUIRED",
  "LOCAL_MODELS_UNAVAILABLE",
  "LOCAL_MODELS_RECOVERY_REQUIRED",
  "GPU_SHARING_REVOCATION_FAILED",
]);

// The desktop is the installer's only client here: it starts the job and
// follows it, and nothing of the installer UI is shown.
export class InstallerApi {
  readonly #origin: string;
  readonly #fetch: typeof fetch;
  readonly #pollMs: number;
  #cookie = "";

  private constructor(origin: string, fetcher: typeof fetch, pollMs: number) {
    this.#origin = origin;
    this.#fetch = fetcher;
    this.#pollMs = pollMs;
  }

  // Exchanges the one-time token in the launcher URL for a session.
  static async open(
    url: string,
    fetcher: typeof fetch,
    pollMs: number,
  ): Promise<InstallerApi> {
    const target = new URL(url);
    const token = new URLSearchParams(target.hash.slice(1)).get("token");
    if (!token) throw new Error("The installer did not provide a sign-in link");
    const api = new InstallerApi(target.origin, fetcher, pollMs);
    const response = await api.#call("/api/session", { token });
    if (!response.ok)
      throw new Error(`The installer refused the session (${response.status})`);
    const session = response.headers
      .getSetCookie()
      .map(parseSetCookie)
      .find((cookie) => cookie?.name === "linger_installer_session");
    if (!session) throw new Error("The installer did not open a session");
    api.#cookie = `${session.name}=${session.value}`;
    return api;
  }

  // Runs the installation for the plan, or follows the one already running,
  // and resolves once the local server is up.
  // `fresh` installs again for a runtime chosen since.
  async run(
    plan: LocalServerPlan,
    signal: AbortSignal,
    onStep: (step: LocalServerStep, share: number, message: string) => void,
    fresh = false,
  ): Promise<{ readonly origin: string; readonly signInRequired: boolean }> {
    const { items } = await this.#json<{ items: Job[] }>("/api/jobs");
    const latest = items
      .filter((item) => item.instance === LOCAL_INSTANCE && !item.preparation)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    let job: Job;
    if (
      !fresh &&
      latest &&
      (["queued", "running"].includes(latest.state) ||
        // A finished one only while its instance is still there; its data
        // may have been removed since.
        (finished(latest) &&
          (await this.#call(`/api/instances/${LOCAL_INSTANCE}/login`)).ok))
    )
      job = latest;
    else {
      const setupChoice =
        plan.runtime === "local"
          ? "local-models"
          : plan.runtime === "recommended"
            ? await this.#json<{ recommendation?: string }>("/api/setup").then(
                recommended,
                // Inspection probes GPUs and model tools; when it cannot run,
                // Codex is the runtime that needs nothing on this computer.
                () => "codex",
              )
            : plan.runtime;
      job = await this.#json<Job>("/api/jobs", {
        instance: LOCAL_INSTANCE,
        ...(setupChoice ? { setupChoice } : {}),
      });
    }
    // The person chose the local model after seeing what it needs, so its
    // deployment plan is approved here; once, against a plan that keeps
    // changing. A deployment that stopped part way asks for a new plan
    // first; that is asked for once too.
    let approved: string | undefined;
    let replanned = false;
    for (;;) {
      const at = job.stage ? STAGES[job.stage] : undefined;
      if (at) {
        const current = job.stage;
        const stage = job.stages.find((item) => item.id === current);
        const counter = stage?.progress;
        // Native services report readiness only in the message ("2/4 ready").
        const ready = /\((\d+)\/(\d+) ready\)/.exec(job.message ?? "");
        const part =
          stage?.state === "succeeded" || stage?.state === "skipped"
            ? 1
            : counter?.total
              ? counter.completed / counter.total
              : ready
                ? Number(ready[1]) / Math.max(1, Number(ready[2]))
                : 0;
        onStep(at[0], at[1] + (at[2] - at[1]) * part, job.message ?? "");
      }
      if (finished(job))
        return { origin: job.origin!, signInRequired: signInRequired(job) };
      const planId = job.localModelsPlan?.planId;
      if (
        job.state === "waiting_user" &&
        job.errorCode === "LOCAL_MODELS_APPROVAL_REQUIRED" &&
        plan.runtime === "local" &&
        planId &&
        planId !== approved
      ) {
        approved = planId;
        onStep("services", 0, "Deploying the local model");
        job = await this.#json<Job>(
          `/api/jobs/${encodeURIComponent(job.id)}/retry`,
          { localModelsApproval: planId },
        );
        continue;
      }
      if (
        job.state === "waiting_user" &&
        job.errorCode === "LOCAL_MODELS_RECOVERY_REQUIRED" &&
        plan.runtime === "local" &&
        !replanned
      ) {
        replanned = true;
        onStep("services", 0, "Deploying the local model");
        job = await this.#json<Job>(
          `/api/jobs/${encodeURIComponent(job.id)}/retry`,
          { localModelsReplan: true },
        );
        continue;
      }
      if (!["queued", "running"].includes(job.state))
        throw new Error(
          LOCAL_MODEL_FAILURES.has(job.errorCode ?? "")
            ? "This computer can't run the local model right now. Choose another AI runtime and try again."
            : job.message || "The installation stopped",
        );
      await delay(this.#pollMs, undefined, { signal });
      job = await this.#json<Job>(`/api/jobs/${encodeURIComponent(job.id)}`);
    }
  }

  // The owner account the installer created for this instance.
  login(): Promise<{ readonly email: string; readonly password: string }> {
    return this.#json(`/api/instances/${LOCAL_INSTANCE}/login`);
  }

  // The runtime the installation set up, with the paths of its executable
  // and profile.
  runtime(): Promise<InstanceRuntime> {
    return this.#json(`/api/instances/${LOCAL_INSTANCE}/runtime`);
  }

  // The runtime's sign-in: checks it, or with `start` begins the runtime's
  // own login (or gives it the code the vendor's page showed).
  cancelRuntimeLogin(): Promise<RuntimeLogin> {
    return this.#json(
      `/api/runtime-login?instance=${LOCAL_INSTANCE}`,
      undefined,
      "DELETE",
    );
  }

  runtimeLogin(start = false, code?: string): Promise<RuntimeLogin> {
    return start
      ? this.#json("/api/runtime-login", {
          instance: LOCAL_INSTANCE,
          ...(code ? { code } : {}),
        })
      : this.#json(`/api/runtime-login?instance=${LOCAL_INSTANCE}`);
  }

  #call(
    pathname: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ): Promise<Response> {
    return this.#fetch(new URL(pathname, this.#origin), {
      method,
      headers: {
        accept: "application/json",
        // The installer only takes writes from its own origin.
        origin: this.#origin,
        ...(this.#cookie ? { cookie: this.#cookie } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async #json<T>(
    pathname: string,
    body?: unknown,
    method?: string,
  ): Promise<T> {
    const response = await this.#call(pathname, body, method);
    if (!response.ok) {
      const error = (await response.json().catch(() => null)) as {
        message?: string;
      } | null;
      throw new Error(
        error?.message || `The installer request failed (${response.status})`,
      );
    }
    return (await response.json()) as T;
  }
}

interface InstanceRuntime {
  readonly setupChoice?: string;
  readonly environment: Record<string, string>;
}

interface RuntimeLogin {
  readonly state: "idle" | "starting" | "waiting_user" | "ready" | "failed";
  readonly url?: string;
  readonly deviceCode?: string;
  readonly acceptsCode?: boolean;
  readonly message?: string;
}

// The installer's own pick; local models stand for the pi runtime.
const recommended = (report: { recommendation?: string }) =>
  report.recommendation === "local-models"
    ? "pi"
    : (report.recommendation ?? "codex");

export interface SetCookie {
  readonly name: string;
  readonly value: string;
  readonly path?: string;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite?: "lax" | "strict" | "no_restriction";
  // Seconds since the epoch; absent for a session cookie.
  readonly expirationDate?: number;
}

export const parseSetCookie = (header: string): SetCookie | undefined => {
  const [pair = "", ...attributes] = header.split(";");
  const split = pair.indexOf("=");
  if (split <= 0) return undefined;
  const cookie: {
    -readonly [K in keyof SetCookie]: SetCookie[K];
  } = {
    name: pair.slice(0, split).trim(),
    value: pair.slice(split + 1).trim(),
    httpOnly: false,
    secure: false,
  };
  for (const attribute of attributes) {
    const [key = "", ...rest] = attribute.split("=");
    const value = rest.join("=").trim();
    switch (key.trim().toLowerCase()) {
      case "path":
        cookie.path = value;
        break;
      case "httponly":
        cookie.httpOnly = true;
        break;
      case "secure":
        cookie.secure = true;
        break;
      case "samesite":
        cookie.sameSite =
          value.toLowerCase() === "none"
            ? "no_restriction"
            : value.toLowerCase() === "strict"
              ? "strict"
              : "lax";
        break;
      case "max-age":
        cookie.expirationDate = Date.now() / 1000 + Number(value);
        break;
      case "expires":
        cookie.expirationDate ??= Date.parse(value) / 1000;
        break;
    }
  }
  return cookie;
};

// Signs in to the local server with its owner and hands the session cookies
// to the app's web session; the password is never stored.
export const signInWithPassword = async (
  origin: string,
  email: string,
  password: string,
  setCookie: (cookie: SetCookie) => Promise<void>,
  fetcher: typeof fetch = fetch,
): Promise<void> => {
  const response = await fetcher(new URL("/v0/auth/login", origin), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      origin,
    },
    body: JSON.stringify({ identifier: email, password }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  await response.body?.cancel();
  if (!response.ok)
    throw new Error(`Signing in to Linger failed (${response.status})`);
  const cookies = response.headers
    .getSetCookie()
    .map(parseSetCookie)
    .filter((cookie) => cookie !== undefined);
  if (!cookies.length) throw new Error("Signing in to Linger failed");
  for (const cookie of cookies) await setCookie(cookie);
};

// Release assets redirect to a CDN; the digest, not the host, is what is
// trusted, but every hop stays on HTTPS.
export const followHttps =
  (fetcher: typeof fetch): typeof fetch =>
  async (input, init) => {
    let url = new URL(input instanceof Request ? input.url : String(input));
    for (let hop = 0; hop < 5; hop++) {
      const response = await fetcher(url, { ...init, redirect: "manual" });
      const location = response.headers.get("location");
      if (response.status < 300 || response.status >= 400 || !location)
        return response;
      await response.body?.cancel();
      url = new URL(location, url);
      if (url.protocol !== "https:")
        throw new Error("Download redirected away from HTTPS");
    }
    throw new Error("Too many download redirects");
  };

// The folder a picked one installs into: the folder itself when it is empty
// or already holds Linger, else a Linger folder inside it.
export const installLocation = async (picked: string): Promise<string> => {
  const entries = await readdir(picked).catch(() => [] as string[]);
  return entries.every((entry) => entry.startsWith(".")) ||
    entries.includes("instances") ||
    entries.includes("installer")
    ? picked
    : path.join(picked, "Simplex");
};

// Why Linger cannot install into `directory`, or undefined when it can: the
// folder (or the one it will be made in) must take files and its disk must
// have `neededBytes` free.
export const checkLocation = async (
  directory: string,
  neededBytes: number,
): Promise<string | undefined> => {
  if (!path.isAbsolute(directory)) return "Choose a folder on this computer.";
  let existing = directory;
  while (!(await isDirectory(existing))) {
    if (path.dirname(existing) === existing)
      return "This folder can't be found.";
    existing = path.dirname(existing);
  }
  const probe = path.join(existing, `.linger-${randomUUID()}`);
  try {
    await writeFile(probe, "", { flag: "wx" });
  } catch {
    return "Linger can't write to this folder. Choose another one.";
  } finally {
    await rm(probe, { force: true });
  }
  const disk = await statfs(existing);
  const free = Number(disk.bavail) * Number(disk.bsize);
  if (free < neededBytes)
    return `Needs ${Math.ceil(neededBytes / GiB)} GB free; this disk has ${Math.floor(free / GiB)} GB.`;
  return undefined;
};

const isDirectory = async (file: string): Promise<boolean> => {
  try {
    return (await stat(file)).isDirectory();
  } catch {
    return false;
  }
};

const isFile = async (file: string): Promise<boolean> => {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
};

// Windows' own bsdtar reads both the tar.gz source package and the Node zip;
// a GNU tar earlier on PATH (Git for Windows) reads neither "C:" paths nor zips.
const tarCommand = (): string =>
  process.platform === "win32"
    ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";

// Resolves once the child exited and closed its stdio, so nothing of it
// still holds the files it wrote.
// `input`, when given, is the child's stdin.
const run = (
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  input?: Readable,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: [input ? "pipe" : "ignore", "ignore", "ignore"],
      signal,
      windowsHide: true,
    });
    child.once("error", reject);
    if (input)
      pipeline(input, child.stdin!).catch((error: unknown) => {
        child.kill();
        reject(error);
      });
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} exited with code ${code}`)),
    );
  });
