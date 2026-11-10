import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  createWriteStream,
  mkdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

import type { RuntimeState } from "../shared/api.js";
import type {
  ComputerCredential,
  CredentialStore,
} from "./computer-credential.js";
import type { DesktopConfig } from "./config.js";
import type { Module, ModuleContext } from "./modules.js";
import {
  SYSTEM_PERMISSION_IDS,
  type SystemPermissions,
} from "./system-permissions.js";

// The child process seam; tests use a fake child.
export interface DaemonChild {
  // reason is the last line the daemon wrote to stderr, which names why a
  // daemon that failed to start exited.
  onExit(listener: (code: number | null, reason?: string) => void): void;
  // One line the daemon wrote to stdout.
  onLine(listener: (line: string) => void): void;
  // Writes one line to the daemon's stdin; a daemon that already exited
  // drops it.
  write(line: string): void;
  // Closes stdin, which the daemon takes as the request to shut down.
  stop(): void;
  kill(): void;
}
export type SpawnDaemon = (
  configFile: string,
  env: Record<string, string>,
) => DaemonChild;

export interface ComputerDaemonOptions {
  readonly spawn: SpawnDaemon;
  readonly credentials: CredentialStore;
  // Holds the daemon config and, under state/, its own state.
  readonly directory: string;
  // The bundled teamhub CLI, so runtimes reply with a matching version.
  readonly teamhubCliDirectory?: string;
  // The approval card names the computer; setup may leave the name unset.
  readonly defaultDisplayName?: string;
  // The daemon's environment. Resolving the login shell takes a moment, so
  // the first launch waits for it instead of the app start.
  readonly env?:
    | Readonly<Record<string, string>>
    | Promise<Readonly<Record<string, string>>>;
  // The app's own macOS permissions, which the daemon asks about over stdio.
  // Only set on macOS; without it the daemon gets no hello and reports the
  // permissions as unknown.
  readonly permissions?: Pick<
    SystemPermissions,
    "status" | "prompt" | "openSettings"
  >;
  // Quits and starts the app again, for a Screen Recording grant to apply.
  readonly relaunch?: () => void;
  // Gives the given directories and the files directly in them an owner-only
  // ACL before the first launch. Only set on Windows, where Node's file modes
  // do nothing and the daemon refuses a config other users could read.
  readonly protect?: (directories: readonly string[]) => Promise<void>;
}

// The stdio features this Desktop offers the daemon in its hello line.
export const DAEMON_FEATURES = ["permissions.v1"];

interface PermissionRequest {
  readonly id: string;
  readonly op: unknown;
  readonly permission: unknown;
}

// The daemon reads the Gateway credential from this variable (gateway.token_env).
export const TOKEN_ENV = "LINGER_COMPUTER_TOKEN";

const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
// A daemon that stayed up this long resets the backoff.
const HEALTHY_AFTER_MS = 60_000;
// This many exits in a row before a status line make the daemon failed: setup
// stops waiting for it and shows the reason.
export const FAILED_AFTER_EXITS = 3;
// After stdin closes the daemon cancels its tasks and exits; this bounds it
// below the module stop timeout.
const STOP_GRACE_MS = 4_000;

export const restartDelay = (failures: number): number =>
  Math.min(BACKOFF_START_MS * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS);

// The connection value of the status the SPA reads (ComputerStatus.bridge).
export const connectionState = (gatewayState: string): string => {
  switch (gatewayState) {
    case "connected":
      return "online";
    case "authentication-failed":
      return "auth_failed";
    case "upgrade-required":
      return "upgrade_required";
    default:
      return "connecting";
  }
};

const RUNTIME_PATHS = {
  codex: "LINGER_CODEX_PATH",
  claude: "LINGER_CLAUDE_PATH",
  pi: "LINGER_PI_PATH",
} as const;

// The daemon's environment: the app's, with the runtime the local server's
// installer set up (its executables and profiles: CODEX_HOME,
// CLAUDE_CONFIG_DIR, PI_CODING_AGENT_DIR) in place of what was inherited.
// Windows names are case-insensitive, so an inherited "Codex_Home" goes too.
export const daemonEnvironment = (
  env: Readonly<Record<string, string>>,
  runtime: Readonly<Record<string, string>> | undefined,
  platformPath: typeof path = path,
): Record<string, string> => {
  const own = Object.entries(runtime ?? {}).filter(([, value]) =>
    platformPath.isAbsolute(value),
  );
  const names = new Set(own.map(([name]) => name.toUpperCase()));
  return {
    ...Object.fromEntries(
      Object.entries(env).filter(([name]) => !names.has(name.toUpperCase())),
    ),
    ...Object.fromEntries(own),
  };
};

// The Go daemon config (computerconfig.Load). Owners come from the
// credential's claims.
export const daemonConfig = (
  config: DesktopConfig,
  credential: ComputerCredential,
  options: {
    readonly directory: string;
    readonly teamhubCliDirectory?: string;
    readonly defaultDisplayName?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly platformPath?: typeof path;
  },
) => {
  const platformPath = options.platformPath ?? path;
  const runtimePaths: Record<string, string> = {};
  for (const [runtime, name] of Object.entries(RUNTIME_PATHS)) {
    const value = options.env?.[name];
    if (value && platformPath.isAbsolute(value)) runtimePaths[runtime] = value;
  }
  return {
    runner_id: credential.computerId,
    display_name:
      config.displayName || options.defaultDisplayName || "Linger Desktop",
    gateway: { url: credential.gatewayUrl, token_env: TOKEN_ENV },
    state_directory: platformPath.join(options.directory, "state"),
    ...(Object.keys(runtimePaths).length > 0
      ? { runtime_paths: runtimePaths }
      : {}),
    workspace_grants: config.workspaceGrants.map((g) => ({
      grant_id: g.grantId,
      label: g.label,
      tenant_id: config.tenantId!,
      root_path: g.path,
      mode: g.access === "read_only" ? "read-only" : "workspace-write",
      scope: "owner",
    })),
    desktop: options.teamhubCliDirectory
      ? { teamhub_cli_directory: options.teamhubCliDirectory }
      : {},
  };
};

// Runs the Go daemon as a child while this computer is enrolled, restarts it
// with exponential backoff after a crash, and restarts it when the Computer,
// its name or its workspace grants change. It exits with the app.
export class ComputerDaemonModule implements Module {
  readonly name = "ComputerDaemon";
  readonly dependsOn = ["Config", "WorkspaceGrants"];
  readonly #options: ComputerDaemonOptions;
  #ctx: ModuleContext | undefined;
  #child: DaemonChild | undefined;
  #state: RuntimeState = "stopped";
  #connection = "disconnected";
  #running = 0;
  #failures = 0;
  #startedAt = 0;
  #retry: NodeJS.Timeout | undefined;
  #stopping = false;
  #restartPending = false;
  #restarting: Promise<void> = Promise.resolve();
  #env: Readonly<Record<string, string>> | undefined;
  #failure: string | undefined;
  // Exits in a row of daemons that never reported a status.
  #startFailures = 0;
  readonly #unsubscribe: (() => void)[] = [];

  constructor(options: ComputerDaemonOptions) {
    this.#options = options;
  }

  state(): RuntimeState {
    return this.#state;
  }

  // Operations the daemon is executing right now.
  running(): number {
    return this.#running;
  }

  // online, connecting, auth_failed, upgrade_required, or disconnected
  // while no daemon runs.
  connection(): string {
    return this.#connection;
  }

  // Why the daemon keeps exiting before it reports a status, once it failed
  // FAILED_AFTER_EXITS times in a row.
  failure(): string | undefined {
    return this.#failure;
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.#ctx = ctx;
    this.#unsubscribe.push(
      // A different (or no) computer identity applies at once.
      ctx.bus.on("computer.changed", () => this.#requestRestart(false)),
      // New folders or a new name wait for running tasks instead of
      // cancelling them.
      ctx.bus.on("grants.changed", () => this.#requestRestart(true)),
      ctx.bus.on("computer.renamed", () => this.#requestRestart(true)),
    );
    const env = this.#options.env ?? {};
    const protect = this.#protect();
    if (!(env instanceof Promise) && !protect) {
      this.#env = env;
      this.#launch();
      return;
    }
    const ready = protect
      ? Promise.all([env, protect]).then(([resolved]) => resolved)
      : Promise.resolve(env);
    void ready.then((resolved) => {
      this.#env = resolved;
      this.#launch();
    });
  }

  // A failed repair still launches the daemon: it then names the path it
  // refuses, which setup shows.
  #protect(): Promise<void> | undefined {
    const protect = this.#options.protect;
    if (!protect) return undefined;
    const started = Date.now();
    const directory = this.#options.directory;
    return protect([directory, path.join(directory, "state")]).then(
      () =>
        this.#ctx?.log.info("computer_daemon.protected", {
          ms: Date.now() - started,
        }),
      (error: unknown) =>
        this.#ctx?.log.warn("computer_daemon.protect_failed", {
          error: String(error),
        }),
    );
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    for (const off of this.#unsubscribe.splice(0)) off();
    clearTimeout(this.#retry);
    await this.#terminate();
    this.#setState("stopped");
  }

  // Events that arrive together (enrollment emits computer and grants
  // changes back to back) cause a single restart.
  #requestRestart(whenIdle: boolean): void {
    if (this.#restartPending) return;
    this.#restartPending = true;
    const restart = (): void => {
      this.#restartPending = false;
      this.#failures = 0;
      this.#startFailures = 0;
      this.#setFailure(undefined);
      this.#restart();
    };
    if (!whenIdle || this.#running === 0) {
      setImmediate(restart);
      return;
    }
    const off = this.#ctx!.bus.on("runtime.activity", (running) => {
      if (running !== 0) return;
      off();
      restart();
    });
    this.#unsubscribe.push(off);
  }

  // Restarts never overlap: the next daemon starts after the previous exited.
  #restart(): void {
    clearTimeout(this.#retry);
    this.#restarting = this.#restarting.then(async () => {
      await this.#terminate();
      this.#launch();
    });
  }

  #launch(): void {
    const ctx = this.#ctx!;
    if (this.#stopping || this.#child || !this.#env) return;
    const config = ctx.config.get();
    if (!config.computerId || !config.tenantId) {
      this.#setConnection("disconnected");
      this.#setState("stopped");
      return;
    }
    const credential = this.#options.credentials.read();
    if (credential?.computerId !== config.computerId) {
      // Reconnecting this computer stores a new credential.
      ctx.log.warn("computer_daemon.no_credential");
      this.#setConnection("auth_failed");
      this.#setState("stopped");
      return;
    }
    const env = daemonEnvironment(this.#env, config.runtimeEnvironment);
    const configFile = this.#writeConfig(config, credential, env);
    this.#setState("starting");
    this.#setConnection("connecting");
    this.#startedAt = Date.now();
    const child = this.#options.spawn(configFile, {
      ...env,
      [TOKEN_ENV]: credential.token,
    });
    this.#child = child;
    if (this.#options.permissions)
      this.#send(child, { type: "hello", features: DAEMON_FEATURES });
    child.onLine((line) => {
      if (this.#child !== child) return;
      let status: {
        type?: unknown;
        id?: unknown;
        op?: unknown;
        permission?: unknown;
        gateway_state?: unknown;
        active_operations?: unknown;
      };
      try {
        status = JSON.parse(line) as typeof status;
      } catch {
        return;
      }
      if (status.type === "permission.request") {
        if (typeof status.id === "string")
          void this.#answer(child, {
            id: status.id,
            op: status.op,
            permission: status.permission,
          });
        return;
      }
      if (status.type !== "status") return;
      this.#startFailures = 0;
      this.#setFailure(undefined);
      this.#setState("ready");
      if (typeof status.gateway_state === "string")
        this.#setConnection(connectionState(status.gateway_state));
      if (typeof status.active_operations === "number")
        this.#setRunning(status.active_operations);
    });
    child.onExit((code, reason) => {
      if (this.#child !== child) return;
      this.#child = undefined;
      this.#setRunning(0);
      this.#setConnection("disconnected");
      if (this.#stopping) return;
      if (Date.now() - this.#startedAt >= HEALTHY_AFTER_MS) this.#failures = 0;
      this.#failures += 1;
      const delay = restartDelay(this.#failures);
      const started = this.#state === "ready";
      this.#setState("crashed");
      ctx.log.warn("computer_daemon.exited", {
        code,
        restart_in_ms: delay,
        ...(reason ? { reason } : {}),
      });
      if (!started) this.#startFailures += 1;
      if (this.#startFailures >= FAILED_AFTER_EXITS)
        this.#setFailure(reason ?? `exit code ${String(code)}`);
      this.#retry = setTimeout(() => this.#launch(), delay);
    });
  }

  // Requests run independently; each writes its own complete response line.
  async #answer(child: DaemonChild, request: PermissionRequest): Promise<void> {
    const respond = (body: object): void =>
      this.#send(child, {
        type: "permission.response",
        id: request.id,
        ...body,
      });
    const permissions = this.#options.permissions;
    if (!permissions) return respond({ ok: false, error: "unsupported" });
    const id = SYSTEM_PERMISSION_IDS.find((p) => p === request.permission);
    let step: () => Promise<unknown>;
    switch (request.op) {
      case "status":
        step = async () => {};
        break;
      case "prompt":
      case "open_settings":
        if (!id) return respond({ ok: false, error: "invalid_permission" });
        step =
          request.op === "prompt"
            ? () => permissions.prompt(id)
            : () => permissions.openSettings(id);
        break;
      case "relaunch":
        if (!this.#options.relaunch)
          return respond({ ok: false, error: "unsupported" });
        step = async () => {};
        break;
      default:
        return respond({ ok: false, error: "unsupported" });
    }
    try {
      await step();
      respond({ ok: true, permissions: permissions.status() });
    } catch (error) {
      this.#ctx?.log.warn("computer_daemon.permission_failed", {
        op: request.op,
        error: String(error),
      });
      return respond({ ok: false, error: "failed" });
    }
    // The daemon has its answer before the app quits and closes its stdin.
    if (request.op === "relaunch") this.#options.relaunch!();
  }

  #send(child: DaemonChild, message: object): void {
    try {
      child.write(JSON.stringify(message));
    } catch (error) {
      this.#ctx?.log.warn("computer_daemon.write_failed", {
        error: String(error),
      });
    }
  }

  async #terminate(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    this.#child = undefined;
    this.#setRunning(0);
    this.#setConnection("disconnected");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#ctx?.log.warn("computer_daemon.kill");
        child.kill();
      }, STOP_GRACE_MS);
      child.onExit(() => {
        clearTimeout(timer);
        resolve();
      });
      child.stop();
    });
  }

  #writeConfig(
    config: DesktopConfig,
    credential: ComputerCredential,
    env: Readonly<Record<string, string>>,
  ): string {
    const directory = this.#options.directory;
    mkdirSync(path.join(directory, "state"), { recursive: true, mode: 0o700 });
    const file = path.join(directory, "config.json");
    const staged = `${file}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(
      staged,
      JSON.stringify(
        daemonConfig(config, credential, {
          directory,
          ...(this.#options.teamhubCliDirectory
            ? { teamhubCliDirectory: this.#options.teamhubCliDirectory }
            : {}),
          ...(this.#options.defaultDisplayName
            ? { defaultDisplayName: this.#options.defaultDisplayName }
            : {}),
          env,
        }),
        null,
        2,
      ),
      { mode: 0o600 },
    );
    renameSync(staged, file);
    return file;
  }

  #setFailure(failure: string | undefined): void {
    if (this.#failure === failure) return;
    this.#failure = failure;
    this.#ctx?.bus.emit("computer.failed", failure);
  }

  #setRunning(running: number): void {
    if (this.#running === running) return;
    this.#running = running;
    this.#ctx?.bus.emit("runtime.activity", running);
  }

  #setConnection(connection: string): void {
    if (this.#connection === connection) return;
    this.#connection = connection;
    this.#ctx?.bus.emit("computer.connection", connection);
  }

  #setState(state: RuntimeState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#ctx?.bus.emit("runtime.state", state);
  }
}

// Starts the daemon executable with only the given environment. Its stderr
// (the daemon log) and any stdout that is not a status line go to logFile.
export const spawnDaemon =
  (executable: string, logFile: string): SpawnDaemon =>
  (configFile, env) => {
    mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
    const log = createWriteStream(logFile, { flags: "a", mode: 0o600 });
    const child = spawn(executable, ["--config", configFile], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      // The daemon must lead its own process group, which it stops with its
      // runtimes. It still exits with the app: its stdin closes then.
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const lines: ((line: string) => void)[] = [];
    const exits: ((code: number | null, reason?: string) => void)[] = [];
    let exited: { code: number | null; reason?: string } | undefined;
    let reason: string | undefined;
    const exit = (code: number | null): void => {
      if (exited) return;
      exited = { code, ...(reason ? { reason } : {}) };
      log.end();
      for (const listener of exits) listener(code, reason);
    };
    child.stderr.pipe(log, { end: false });
    createInterface({ input: child.stderr }).on("line", (line) => {
      const text = line.trim();
      if (text) reason = text.slice(0, 500);
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (line.startsWith("{")) for (const listener of lines) listener(line);
      else log.write(`${line}\n`);
    });
    // stdin errors when the daemon already exited; exit reports that.
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      reason = `spawn failed: ${String(error)}`;
      log.write(`${reason}\n`);
      exit(null);
    });
    // close follows exit once stdout and stderr are drained into the log.
    child.on("close", (code) => exit(code));
    return {
      onExit: (listener) => {
        if (exited) listener(exited.code, exited.reason);
        else exits.push(listener);
      },
      onLine: (listener) => lines.push(listener),
      write: (line) => {
        if (child.stdin.writable) child.stdin.write(`${line}\n`);
      },
      stop: () => child.stdin.end(),
      // Its whole process group, for a daemon that hangs.
      kill: () => {
        try {
          if (process.platform !== "win32" && child.pid)
            process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          // Already exited.
        }
      },
    };
  };

// Runs the daemon's Windows platform helper, which applies an owner-only ACL
// to each directory and the files directly in it.
export const protectWithDaemon =
  (executable: string, timeoutMs = 60_000) =>
  (directories: readonly string[]): Promise<void> =>
    new Promise((resolve, reject) => {
      const child = spawn(executable, ["platform"], {
        stdio: ["pipe", "ignore", "pipe"],
        windowsHide: true,
        timeout: timeoutMs,
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-2_000);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(
              stderr.trim() || `platform helper exited ${String(code)}`,
            ),
          );
      });
      child.stdin.on("error", () => {});
      child.stdin.end(
        JSON.stringify({
          action: "protect-private-directories",
          paths: directories,
        }),
      );
    });
