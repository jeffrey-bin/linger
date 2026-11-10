import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CredentialStore } from "./computer-credential.js";
import {
  ComputerDaemonModule,
  TOKEN_ENV,
  connectionState,
  daemonConfig,
  daemonEnvironment,
  restartDelay,
  spawnDaemon,
  type ComputerDaemonOptions,
  type DaemonChild,
} from "./computer-daemon.js";
import { ConfigStore } from "./config.js";
import { EventBus, type ModuleContext } from "./modules.js";
import type {
  SystemPermission,
  SystemPermissionId,
} from "./system-permissions.js";

const TOKEN = "sr1.test-credential-0123456789abcdefghij";

class FakeChild implements DaemonChild {
  readonly exits: ((code: number | null, reason?: string) => void)[] = [];
  readonly lines: ((line: string) => void)[] = [];
  // Lines written to the daemon's stdin.
  readonly written: unknown[] = [];
  failWrites = false;
  stopped = false;
  killed = false;
  constructor(
    readonly configFile: string,
    readonly env: Record<string, string>,
  ) {}
  onExit(listener: (code: number | null, reason?: string) => void): void {
    this.exits.push(listener);
  }
  onLine(listener: (line: string) => void): void {
    this.lines.push(listener);
  }
  write(line: string): void {
    if (this.failWrites) throw new Error("EPIPE");
    this.written.push(JSON.parse(line));
  }
  send(message: object): void {
    for (const listener of this.lines) listener(JSON.stringify(message));
  }
  stop(): void {
    this.stopped = true;
    this.exit(0);
  }
  kill(): void {
    this.killed = true;
  }
  status(gateway: string, active = 0): void {
    const line = JSON.stringify({
      type: "status",
      gateway_state: gateway,
      active_operations: active,
    });
    for (const listener of this.lines) listener(line);
  }
  exit(code: number | null, reason?: string): void {
    for (const listener of this.exits.splice(0)) listener(code, reason);
  }
}

const setup = (
  options: {
    enrolled?: boolean;
    credential?: boolean;
    env?: Promise<Record<string, string>>;
    permissions?: ComputerDaemonOptions["permissions"];
    relaunch?: () => void;
    protect?: ComputerDaemonOptions["protect"];
  } = {},
) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "computer-daemon-"));
  const config = new ConfigStore(path.join(directory, "config.json"));
  if (options.enrolled !== false)
    config.update({
      computerId: "computer-1",
      tenantId: "tenant-1",
      displayName: "Studio Mac",
      workspaceGrants: [
        {
          grantId: "grant-1",
          path: "/Users/me/Linger",
          label: "Linger",
          access: "read_write",
          createdAt: "2026-11-01T00:00:00Z",
        },
      ],
    });
  const credentials = new CredentialStore(
    path.join(directory, "credential.json"),
  );
  if (options.credential !== false)
    credentials.write({
      computerId: "computer-1",
      gatewayUrl: "wss://linger.example/v1/runner-gateway",
      token: TOKEN,
    });
  const children: FakeChild[] = [];
  const bus = new EventBus();
  const ctx: ModuleContext = {
    config,
    bus,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    get: () => {
      throw new Error("unused");
    },
  };
  const daemon = new ComputerDaemonModule({
    spawn: (configFile, env) => {
      const child = new FakeChild(configFile, env);
      children.push(child);
      return child;
    },
    credentials,
    directory: path.join(directory, "computer"),
    teamhubCliDirectory: "/Applications/Linger.app/teamhub-cli",
    env: options.env ?? { HOME: "/Users/me", LINGER_CODEX_PATH: "/opt/codex" },
    ...(options.permissions ? { permissions: options.permissions } : {}),
    ...(options.relaunch ? { relaunch: options.relaunch } : {}),
    ...(options.protect ? { protect: options.protect } : {}),
  });
  return { daemon, ctx, bus, config, children, directory };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("ComputerDaemonModule", () => {
  it("starts the daemon with its config and the credential in the environment", async () => {
    const { daemon, ctx, children } = setup();
    await daemon.start(ctx);
    expect(children).toHaveLength(1);
    const [child] = children;
    expect(child!.env).toEqual({
      HOME: "/Users/me",
      LINGER_CODEX_PATH: "/opt/codex",
      [TOKEN_ENV]: TOKEN,
    });
    expect(statSync(child!.configFile).mode & 0o777).toBe(0o600);
    const written = readFileSync(child!.configFile, "utf8");
    // The credential stays out of the config file.
    expect(written).not.toContain(TOKEN);
    expect(JSON.parse(written)).toEqual({
      runner_id: "computer-1",
      display_name: "Studio Mac",
      gateway: {
        url: "wss://linger.example/v1/runner-gateway",
        token_env: TOKEN_ENV,
      },
      state_directory: path.join(path.dirname(child!.configFile), "state"),
      runtime_paths: { codex: "/opt/codex" },
      workspace_grants: [
        {
          grant_id: "grant-1",
          label: "Linger",
          tenant_id: "tenant-1",
          root_path: "/Users/me/Linger",
          mode: "workspace-write",
          scope: "owner",
        },
      ],
      desktop: {
        teamhub_cli_directory: "/Applications/Linger.app/teamhub-cli",
      },
    });
    expect(daemon.state()).toBe("starting");
    expect(daemon.connection()).toBe("connecting");
  });

  it("runs the runtime the local server's installer set up", async () => {
    const { daemon, ctx, bus, config, children } = setup();
    await daemon.start(ctx);
    // Saved before enrolling, whose computer change restarts the daemon.
    config.update({
      runtimeEnvironment: {
        LINGER_PI_PATH: "/home/me/.linger/runtime/pi/pi",
        PI_CODING_AGENT_DIR: "/home/me/.linger/runtime/pi-agent",
        CODEX_HOME: "relative/is/ignored",
      },
    });
    bus.emit("computer.changed", "computer-1");
    await vi.waitFor(() => expect(children).toHaveLength(2));
    const child = children[1]!;
    expect(child.env).toEqual({
      HOME: "/Users/me",
      LINGER_CODEX_PATH: "/opt/codex",
      LINGER_PI_PATH: "/home/me/.linger/runtime/pi/pi",
      PI_CODING_AGENT_DIR: "/home/me/.linger/runtime/pi-agent",
      [TOKEN_ENV]: TOKEN,
    });
    expect(
      JSON.parse(readFileSync(child.configFile, "utf8")).runtime_paths,
    ).toEqual({ codex: "/opt/codex", pi: "/home/me/.linger/runtime/pi/pi" });
  });

  it("takes Windows runtime paths and replaces inherited names in any case", () => {
    const env = daemonEnvironment(
      {
        Path: "C:\\Windows",
        Codex_Home: "C:\\Users\\me\\.codex",
        LINGER_CODEX_PATH: "C:\\old\\codex.exe",
      },
      {
        LINGER_CODEX_PATH: "C:\\Users\\me\\.linger\\runtime\\codex\\codex.exe",
        CODEX_HOME: "C:\\Users\\me\\.linger\\codex-home",
        LINGER_PI_PATH: "\\\\server\\share\\pi.exe",
        CLAUDE_CONFIG_DIR: "relative\\claude",
      },
      path.win32,
    );
    expect(env).toEqual({
      Path: "C:\\Windows",
      LINGER_CODEX_PATH: "C:\\Users\\me\\.linger\\runtime\\codex\\codex.exe",
      CODEX_HOME: "C:\\Users\\me\\.linger\\codex-home",
      LINGER_PI_PATH: "\\\\server\\share\\pi.exe",
    });
    const config = daemonConfig(
      new ConfigStore(
        path.join(mkdtempSync(path.join(os.tmpdir(), "cfg-")), "c.json"),
      ).get(),
      { computerId: "c", gatewayUrl: "wss://x", token: TOKEN },
      {
        directory: "C:\\Users\\me\\AppData\\Linger\\computer",
        env: { ...env, LINGER_CLAUDE_PATH: "claude.exe" },
        platformPath: path.win32,
      },
    );
    expect(config.runtime_paths).toEqual({
      codex: "C:\\Users\\me\\.linger\\runtime\\codex\\codex.exe",
      pi: "\\\\server\\share\\pi.exe",
    });
    expect(config.state_directory).toBe(
      "C:\\Users\\me\\AppData\\Linger\\computer\\state",
    );
  });

  it("launches once the login shell environment is resolved", async () => {
    let resolve: (env: Record<string, string>) => void = () => {};
    const env = new Promise<Record<string, string>>((done) => (resolve = done));
    const { daemon, ctx, children } = setup({ env });
    await daemon.start(ctx);
    expect(children).toHaveLength(0);
    resolve({ HOME: "/Users/me", PATH: "/opt/homebrew/bin:/usr/bin" });
    await env;
    expect(children).toHaveLength(1);
    expect(children[0]!.env).toEqual({
      HOME: "/Users/me",
      PATH: "/opt/homebrew/bin:/usr/bin",
      [TOKEN_ENV]: TOKEN,
    });
  });

  it("follows the status the daemon reports", async () => {
    const { daemon, ctx, bus, children } = setup();
    const activity: number[] = [];
    bus.on("runtime.activity", (running) => activity.push(running));
    await daemon.start(ctx);
    children[0]!.status("connected", 2);
    expect(daemon.state()).toBe("ready");
    expect(daemon.connection()).toBe("online");
    expect(daemon.running()).toBe(2);
    children[0]!.status("upgrade-required");
    expect(daemon.connection()).toBe("upgrade_required");
    expect(activity).toEqual([2, 0]);
  });

  it("stays stopped until this computer is connected", async () => {
    const { daemon, ctx, children } = setup({ enrolled: false });
    await daemon.start(ctx);
    expect(children).toHaveLength(0);
    expect(daemon.connection()).toBe("disconnected");
  });

  it("asks to reconnect without a credential for this computer", async () => {
    const { daemon, ctx, children } = setup({ credential: false });
    await daemon.start(ctx);
    expect(children).toHaveLength(0);
    expect(daemon.connection()).toBe("auth_failed");
    expect(daemon.state()).toBe("stopped");
  });

  it("protects its directory before the first launch writes the config", async () => {
    let finish: () => void = () => {};
    const protect = vi.fn(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const { daemon, ctx, children, directory } = setup({ protect });
    await daemon.start(ctx);
    const computer = path.join(directory, "computer");
    expect(protect).toHaveBeenCalledWith([
      computer,
      path.join(computer, "state"),
    ]);
    expect(children).toHaveLength(0);
    expect(() => statSync(path.join(computer, "config.json"))).toThrow();
    finish();
    await vi.waitFor(() => expect(children).toHaveLength(1));
    expect(ctx.log.info).toHaveBeenCalledWith(
      "computer_daemon.protected",
      expect.anything(),
    );
  });

  it("still launches when protecting fails, so the daemon names the path", async () => {
    const protect = vi.fn(() => Promise.reject(new Error("access denied")));
    const { daemon, ctx, children } = setup({ protect });
    await daemon.start(ctx);
    await vi.waitFor(() => expect(children).toHaveLength(1));
    expect(ctx.log.warn).toHaveBeenCalledWith(
      "computer_daemon.protect_failed",
      {
        error: "Error: access denied",
      },
    );
  });

  it("reports why a daemon that cannot start keeps exiting", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { daemon, ctx, bus, children } = setup();
    const failures: (string | undefined)[] = [];
    bus.on("computer.failed", (reason) => failures.push(reason));
    await daemon.start(ctx);
    const reason =
      "read Computer config: private path grants access to another user (S-1-5-11)";
    for (let attempt = 1; attempt < 3; attempt++) {
      children.at(-1)!.exit(1, reason);
      expect(daemon.failure()).toBeUndefined();
      vi.advanceTimersByTime(restartDelay(attempt));
    }
    children.at(-1)!.exit(1, reason);
    expect(daemon.failure()).toBe(reason);
    expect(ctx.log.warn).toHaveBeenCalledWith("computer_daemon.exited", {
      code: 1,
      restart_in_ms: restartDelay(3),
      reason,
    });
    vi.advanceTimersByTime(restartDelay(3));
    children.at(-1)!.status("connected");
    expect(daemon.failure()).toBeUndefined();
    expect(failures).toEqual([reason, undefined]);
  });

  it("does not count exits of a daemon that ran", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { daemon, ctx, children } = setup();
    await daemon.start(ctx);
    for (let attempt = 1; attempt <= 3; attempt++) {
      children.at(-1)!.status("connected");
      children.at(-1)!.exit(1, "panic");
      vi.advanceTimersByTime(restartDelay(attempt));
    }
    expect(daemon.failure()).toBeUndefined();
  });

  it("restarts a crashed daemon with backoff", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { daemon, ctx, children } = setup();
    await daemon.start(ctx);
    children[0]!.exit(1);
    expect(daemon.state()).toBe("crashed");
    vi.advanceTimersByTime(restartDelay(1));
    expect(children).toHaveLength(2);
    children[1]!.exit(1);
    vi.advanceTimersByTime(restartDelay(2) - 1);
    expect(children).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(children).toHaveLength(3);
  });

  it("applies new folders once running tasks finish", async () => {
    const { daemon, ctx, bus, children } = setup();
    await daemon.start(ctx);
    children[0]!.status("connected", 1);
    bus.emit("grants.changed");
    await new Promise((resolve) => setImmediate(resolve));
    expect(children[0]!.stopped).toBe(false);
    children[0]!.status("connected", 0);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    expect(children[0]!.stopped).toBe(true);
  });

  it("stops the daemon by closing its stdin", async () => {
    const { daemon, ctx, children } = setup();
    await daemon.start(ctx);
    await daemon.stop();
    expect(children[0]!.stopped).toBe(true);
    expect(children[0]!.killed).toBe(false);
    expect(daemon.state()).toBe("stopped");
    expect(daemon.connection()).toBe("disconnected");
  });
});

const PERMISSIONS: SystemPermission[] = [
  { id: "screen_recording", state: "denied", relaunch_required: false },
  { id: "accessibility", state: "granted", relaunch_required: false },
];

const fakePermissions = () => {
  const calls: string[] = [];
  return {
    calls,
    permissions: {
      status: () => PERMISSIONS,
      prompt: async (id: SystemPermissionId) => {
        calls.push(`prompt ${id}`);
        return PERMISSIONS;
      },
      openSettings: async (id: SystemPermissionId) => {
        calls.push(`settings ${id}`);
        if (id === "accessibility") throw new Error("no handler");
        return PERMISSIONS;
      },
    },
  };
};

describe("ComputerDaemonModule permission requests", () => {
  const started = async (
    options: { relaunch?: () => void; permissions?: boolean } = {},
  ) => {
    const fake = fakePermissions();
    const context = setup({
      ...(options.permissions === false
        ? {}
        : { permissions: fake.permissions }),
      ...(options.relaunch ? { relaunch: options.relaunch } : {}),
    });
    await context.daemon.start(context.ctx);
    return { ...context, child: context.children[0]!, calls: fake.calls };
  };
  const answered = async (child: FakeChild, count: number) => {
    await vi.waitFor(() => expect(child.written).toHaveLength(count));
    return child.written;
  };

  it("offers the permissions feature once after spawn", async () => {
    const { child } = await started();
    expect(child.written).toEqual([
      { type: "hello", features: ["permissions.v1"] },
    ]);
  });

  it("sends no hello without the app's permissions", async () => {
    const { child } = await started({ permissions: false });
    expect(child.written).toEqual([]);
    child.send({ type: "permission.request", id: "r1", op: "status" });
    expect((await answered(child, 1))[0]).toEqual({
      type: "permission.response",
      id: "r1",
      ok: false,
      error: "unsupported",
    });
  });

  it("answers each request with the current permissions", async () => {
    const { child, calls } = await started();
    child.send({ type: "permission.request", id: "r1", op: "status" });
    child.send({
      type: "permission.request",
      id: "r2",
      op: "prompt",
      permission: "screen_recording",
    });
    const written = await answered(child, 3);
    expect(written.slice(1)).toEqual([
      {
        type: "permission.response",
        id: "r1",
        ok: true,
        permissions: PERMISSIONS,
      },
      {
        type: "permission.response",
        id: "r2",
        ok: true,
        permissions: PERMISSIONS,
      },
    ]);
    expect(calls).toEqual(["prompt screen_recording"]);
  });

  it("reports failures and unknown requests with a short code", async () => {
    const { child } = await started();
    child.send({
      type: "permission.request",
      id: "r1",
      op: "open_settings",
      permission: "accessibility",
    });
    child.send({ type: "permission.request", id: "r2", op: "erase" });
    child.send({
      type: "permission.request",
      id: "r3",
      op: "prompt",
      permission: "camera",
    });
    child.send({ type: "permission.request", id: "r4", op: "relaunch" });
    const written = await answered(child, 5);
    expect(
      Object.fromEntries(
        written
          .slice(1)
          .map((m) => [
            (m as { id: string }).id,
            (m as { error: string }).error,
          ]),
      ),
    ).toEqual({
      r1: "failed",
      r2: "unsupported",
      r3: "invalid_permission",
      r4: "unsupported",
    });
  });

  it("relaunches only after answering", async () => {
    const order: string[] = [];
    const { child } = await started({
      relaunch: () => order.push(`relaunch after ${child.written.length}`),
    });
    child.send({ type: "permission.request", id: "r1", op: "relaunch" });
    await vi.waitFor(() => expect(order).toHaveLength(1));
    expect(child.written[1]).toEqual({
      type: "permission.response",
      id: "r1",
      ok: true,
      permissions: PERMISSIONS,
    });
    expect(order).toEqual(["relaunch after 2"]);
  });

  it("survives a daemon that no longer reads its stdin", async () => {
    const { child, daemon } = await started();
    child.failWrites = true;
    child.send({ type: "permission.request", id: "r1", op: "status" });
    await new Promise((resolve) => setImmediate(resolve));
    child.status("connected", 1);
    expect(daemon.connection()).toBe("online");
    expect(daemon.running()).toBe(1);
  });
});

describe("connectionState", () => {
  it("maps Gateway states to the status the web app reads", () => {
    expect(connectionState("connected")).toBe("online");
    expect(connectionState("connecting")).toBe("connecting");
    expect(connectionState("authentication-failed")).toBe("auth_failed");
    expect(connectionState("upgrade-required")).toBe("upgrade_required");
  });
});

describe("restartDelay", () => {
  it("doubles up to a minute", () => {
    expect([1, 2, 3, 8].map(restartDelay)).toEqual([
      1_000, 2_000, 4_000, 60_000,
    ]);
  });
});

describe.skipIf(process.platform === "win32")("spawnDaemon", () => {
  it("reports the last stderr line as the exit reason", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "spawn-daemon-"));
    const executable = path.join(directory, "daemon");
    writeFileSync(
      executable,
      '#!/bin/sh\necho "starting" >&2\necho "read Computer config: denied" >&2\necho >&2\nexit 1\n',
    );
    chmodSync(executable, 0o755);
    const log = path.join(directory, "logs", "computer-daemon.log");
    const child = spawnDaemon(executable, log)("config.json", {});
    const [code, reason] = await new Promise<[number | null, string?]>(
      (resolve) => child.onExit((...exit) => resolve(exit)),
    );
    expect(code).toBe(1);
    expect(reason).toBe("read Computer config: denied");
    expect(readFileSync(log, "utf8")).toContain("starting\n");
  });
});
