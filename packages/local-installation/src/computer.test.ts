import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as processes from "./process.js";
import { writeSetupChoice } from "./setup-selection.js";
import { initializeInstance } from "./instance.js";
import {
  connectComputer,
  inspectComputer,
  startComputer,
  stopComputer,
} from "./computer.js";
const roots: string[] = [];
function managedNativeRuntimePath(
  home: string,
  runtime: string,
  platform = process.platform,
) {
  return path.join(
    home,
    "upstream-fixture",
    platform === "win32" ? `${runtime}.exe` : runtime,
  );
}
function managedCodexPath(home: string) {
  return managedNativeRuntimePath(home, "codex");
}
vi.mock("./localmodels-tool.js", () => ({
  runLocalmodels: async (
    home: string,
    args: string[],
    options?: { input?: string },
  ) => {
    if (args[1] === "auth") {
      const runtime = args[args.indexOf("--runtime") + 1]!;
      const profile = path.join(home, "runtime", "harness", "runtime", runtime);
      await mkdir(profile, { recursive: true });
      await writeFile(path.join(profile, "auth.json"), options?.input ?? "", {
        mode: 0o600,
      });
      return { code: 0, stdout: '{"saved":true}', stderr: "" };
    }
    const { stat } = await import("node:fs/promises");
    const runtimes = await Promise.all(
      ["codex", "claude", "pi"].map(async (runtime) => {
        const executable =
          process.env[`LINGER_${runtime.toUpperCase()}_PATH`] ??
          managedNativeRuntimePath(home, runtime);
        let installed = false;
        try {
          installed = (await stat(executable)).isFile();
        } catch {
          /* Fixture file absent. */
        }
        const profile = path.join(
          home,
          "runtime",
          "harness",
          "runtime",
          runtime,
        );
        let profileExists = false;
        try {
          profileExists = (await stat(profile)).isDirectory();
        } catch {
          /* Fixture file absent. */
        }
        const { createHash } = await import("node:crypto");
        const { readdir } = await import("node:fs/promises");
        const digest = createHash("sha256");
        for (const dir of [profile]) {
          try {
            for (const file of (await readdir(dir)).sort())
              digest.update(await readFile(path.join(dir, file)));
          } catch {
            /* Fixture file absent. */
          }
        }
        let authFile: string | undefined;
        try {
          if ((await stat(path.join(profile, "auth.json"))).isFile())
            authFile = path.join(profile, "auth.json");
        } catch {
          /* Fixture file absent. */
        }
        return {
          configFingerprint: digest.digest("hex"),
          computer: authFile && runtime === "codex" ? { authFile } : {},
          environment: profileExists
            ? {
                [runtime === "codex"
                  ? "CODEX_HOME"
                  : runtime === "claude"
                    ? "CLAUDE_CONFIG_DIR"
                    : "PI_CODING_AGENT_DIR"]: profile,
              }
            : {},
          runtime,
          executable: installed ? executable : null,
          argvPrefix: [],
          installed,
          authenticated: false,
          authMode: null,
          loginCommand: null,
        };
      }),
    );
    return {
      code: 0,
      stdout: JSON.stringify({
        schema: "localmodels.harness-status/v1",
        runtimes,
      }),
      stderr: "",
    };
  },
}));
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(
  options: {
    connected?: boolean;
    ready?: boolean;
    active?: number;
    expired?: boolean;
    stopped?: boolean;
  } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "linger-computer-"));
  roots.push(root);
  const executable = path.join(root, "computer");
  const calls = path.join(root, "calls.jsonl");
  await writeFile(
    executable,
    `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n'); const config=args[args.indexOf('--config')+1]; const command=args[0]==='daemon'?args[1]:args[0]; if(command==='login'){console.log('Open authorization browser at http://localhost:3000/settings/computers');if(process.env.LINGER_COMPUTER_INSECURE_DEVELOPMENT_ORIGIN!==args[args.indexOf('--web-url')+1])process.exit(8);fs.writeFileSync(config,'{}');} if(command==='status')console.log(JSON.stringify({version:1,config:{configured:true},daemon:{state:${JSON.stringify(options.stopped ? "stopped" : "running")},reconciled: true, gateway_state:${JSON.stringify(options.expired ? "authentication-failed" : options.connected === false ? "connecting" : "connected")},...( ${options.stopped ? "{}" : JSON.stringify({ active_operations: options.active ?? 0 })} )},runtimes:[{type:'codex',status:${JSON.stringify(options.ready === false ? "authentication_required" : "ready")},protocol:'app-server'}]}));if(command==='doctor')console.log(JSON.stringify({version:1,checks:[{name:'runtime:codex',status:${JSON.stringify(options.ready === false ? "fail" : "pass")},detail:'Runtime diagnostic'}]}));`,
    { mode: 0o700 },
  );
  const instance = await initializeInstance({
    name: "default",
    home: root,
    computerExecutable: executable,
  });
  await writeSetupChoice(instance, "codex");
  return {
    instance,
    readCalls: async () =>
      (await readFile(calls, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]),
  };
}
it.each([0, 9])(
  "starts the instance daemon with its selected private profile and reports exit code %s",
  async (code) => {
    const f = await fixture();
    await writeSetupChoice(f.instance, "pi");
    const home = path.resolve(f.instance.root, "../..");
    const executable = managedNativeRuntimePath(home, "pi");
    const profile = path.join(home, "runtime", "harness", "runtime", "pi");
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, "native-fixture", { mode: 0o700 });
    await mkdir(profile, { recursive: true });
    const signal = new AbortController().signal;
    const run = vi
      .spyOn(processes, "runProcess")
      .mockResolvedValue({ code, stdout: "", stderr: "" });
    expect(await startComputer(f.instance, { signal })).toBe(code === 0);
    expect(run).toHaveBeenCalledWith(
      f.instance.computerExecutable,
      ["daemon", "start", "--config", f.instance.computerConfig],
      expect.objectContaining({
        signal,
        timeoutMs: 100_000,
        env: expect.objectContaining({
          PI_CODING_AGENT_DIR: profile,
          LINGER_PI_PATH: executable,
        }),
      }),
    );
  },
);
it("does not launch login or browser in noninteractive mode without config", async () => {
  const f = await fixture();
  expect((await inspectComputer(f.instance)).activeOperations).toBe(0);
  expect(
    (await connectComputer(f.instance, { interactive: false })).state,
  ).toBe("action_required");
  await expect(
    readFile(path.join(f.instance.root, "computer", "config.json")),
  ).rejects.toThrow();
});
it("does not report an inspection failure as proof that Computer is offline", async () => {
  const f = await fixture();
  await writeFile(f.instance.computerConfig, "{}", { mode: 0o600 });
  vi.spyOn(processes, "runProcess").mockRejectedValueOnce(
    new Error("private inspection failure"),
  );
  const observed = await inspectComputer(f.instance);
  expect(observed.state).toBe("action_required");
  expect(observed.detail).not.toContain("private inspection failure");
});
it("delegates one-browser login once then reuses instance-owned config", async () => {
  const f = await fixture();
  const progress: string[] = [];
  expect(
    (
      await connectComputer(f.instance, {
        interactive: true,
        onProgress: (value) => progress.push(value),
      })
    ).state,
  ).toBe("ready");
  expect(progress.join("")).toContain("Open authorization browser");
  expect((await connectComputer(f.instance, { interactive: true })).state).toBe(
    "ready",
  );
  const calls = await f.readCalls();
  expect(calls.filter((args) => args[0] === "login")).toHaveLength(1);
  expect(calls.every((args) => args.includes(f.instance.computerConfig))).toBe(
    true,
  );
  expect(calls.some((args) => args[0] === "doctor")).toBe(false);
  expect(calls.find((args) => args[0] === "login")).toContain(
    f.instance.origin,
  );
});
it("does not infer authenticated Runtime readiness from availability", async () => {
  const f = await fixture({ ready: false });
  await writeFile(f.instance.computerConfig, "{}");
  const status = await inspectComputer(f.instance);
  expect(status.state).toBe("action_required");
  expect(status.connected).toBe(true);
});
it("reports expired gateway credentials as actionable without resetting identity", async () => {
  const f = await fixture({ expired: true });
  await writeFile(f.instance.computerConfig, "{}");
  expect((await connectComputer(f.instance, { interactive: true })).state).toBe(
    "action_required",
  );
  expect((await f.readCalls()).some((args) => args[0] === "login")).toBe(false);
});
it("refuses to stop busy Computer and only stops this config when idle", async () => {
  const busy = await fixture({ active: 1 });
  await writeFile(busy.instance.computerConfig, "{}");
  await expect(stopComputer(busy.instance)).rejects.toThrow(/busy/i);
  expect(
    (await busy.readCalls()).some(
      (args) => args.slice(0, 2).join(" ") === "daemon stop",
    ),
  ).toBe(false);
  const idle = await fixture();
  await writeFile(idle.instance.computerConfig, "{}");
  await stopComputer(idle.instance);
  expect(
    (await idle.readCalls()).find(
      (args) => args.slice(0, 2).join(" ") === "daemon stop",
    ),
  ).toContain(idle.instance.computerConfig);
  expect(
    (await idle.readCalls()).find(
      (args) => args.slice(0, 2).join(" ") === "daemon stop",
    ),
  ).toContain("--if-idle");
});

it("treats an already stopped instance as idle for repeated down", async () => {
  const f = await fixture({ stopped: true });
  await writeFile(f.instance.computerConfig, "{}");
  await expect(stopComputer(f.instance)).resolves.toBeUndefined();
});

async function connectingFixture(
  gateway: (statusCall: number) => string,
  runtimeReady = true,
  startExitCode = 0,
) {
  const f = await fixture();
  await writeFile(f.instance.computerConfig, "{}");
  let statuses = 0;
  const process = vi
    .spyOn(processes, "runProcess")
    .mockImplementation(async (_executable, args) => ({
      code: args.slice(0, 2).join(" ") === "daemon start" ? startExitCode : 0,
      stderr: "",
      stdout:
        args.slice(0, 2).join(" ") === "daemon status"
          ? JSON.stringify({
              daemon: {
                state: "running",
                reconciled: true,
                gateway_state: gateway(++statuses),
                active_operations: 0,
              },
              runtimes: [
                {
                  type: "codex",
                  status: runtimeReady ? "ready" : "authentication_required",
                },
              ],
            })
          : "",
    }));
  return { ...f, process, statuses: () => statuses };
}

it("waits through two connecting observations after one start without repeating login", async () => {
  const f = await connectingFixture((call) =>
    call < 4 ? "connecting" : "connected",
  );
  const progress: string[] = [];
  const result = await connectComputer(f.instance, {
    interactive: false,
    onProgress: (value) => progress.push(value),
  });
  expect(result.state).toBe("ready");
  expect(f.statuses()).toBe(4);
  expect(
    f.process.mock.calls.filter(
      ([, args]) => args.slice(0, 2).join(" ") === "daemon start",
    ).length,
  ).toBe(1);
  expect(f.process.mock.calls.some(([, args]) => args[0] === "login")).toBe(
    false,
  );
  expect(progress.join("")).toMatch(/Waiting.*Gateway/i);
});

it("preserves cancellation while waiting for the started Computer Gateway", async () => {
  const f = await connectingFixture(() => "connecting");
  const controller = new AbortController();
  const connecting = connectComputer(f.instance, {
    interactive: false,
    signal: controller.signal,
  });
  const assertion = expect(connecting).rejects.toMatchObject({
    name: "AbortError",
  });
  await vi.waitFor(() => expect(f.statuses()).toBeGreaterThanOrEqual(2));
  controller.abort();
  await assertion;
  expect(
    f.process.mock.calls.filter(
      ([, args]) => args.slice(0, 2).join(" ") === "daemon start",
    ).length,
  ).toBe(1);
});

it("returns the actual offline observation at the 30 second deadline and clips inspection timeout", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const f = await connectingFixture((call) => {
    if (call === 2) vi.setSystemTime(29_750);
    if (call === 3) vi.setSystemTime(30_000);
    return "connecting";
  });
  const result = await connectComputer(f.instance, { interactive: false });
  expect(result.state).toBe("offline");
  expect(result.detail).toContain("Gateway");
  expect(f.statuses()).toBe(3);
  const lastStatus = f.process.mock.calls
    .filter(([, args]) => args.slice(0, 2).join(" ") === "daemon status")
    .at(-1)!;
  expect(lastStatus[2]?.timeoutMs).toBe(250);
  expect(Date.now()).toBe(30_000);
});

it("returns an actionable Runtime state immediately after the Gateway connects", async () => {
  const f = await connectingFixture(
    (call) => (call === 1 ? "connecting" : "connected"),
    false,
  );
  const result = await connectComputer(f.instance, { interactive: false });
  expect(result.state).toBe("action_required");
  expect(result.detail).toContain("runtime");
  expect(f.statuses()).toBe(2);
});
it("uses a private enrollment file without browser interaction and never reauthorizes configured Computer", async () => {
  const f = await fixture();
  const tokenFile = path.join(f.instance.root, "computer-enrollment.token");
  const authorize = vi.fn(async () => {
    await writeFile(tokenFile, "private-enrollment-token", { mode: 0o600 });
    return tokenFile;
  });
  expect(
    (await connectComputer(f.instance, { interactive: false, authorize }))
      .state,
  ).toBe("ready");
  const setup = (await f.readCalls()).find((args) => args[0] === "login")!;
  expect(setup).toContain("--token-file");
  expect(setup).toContain(tokenFile);
  expect(setup.join(" ")).not.toContain("private-enrollment-token");
  await expect(readFile(tokenFile)).rejects.toThrow();
  await connectComputer(f.instance, { interactive: false, authorize });
  expect(authorize).toHaveBeenCalledOnce();
});
it("observes the daemon started by login without issuing a competing second start", async () => {
  const f = await fixture();
  let observations = 0;
  const process = vi
    .spyOn(processes, "runProcess")
    .mockImplementation(async (_executable, args) => {
      if (args[0] === "login") await writeFile(f.instance.computerConfig, "{}");
      return {
        code: args.slice(0, 2).join(" ") === "daemon start" ? 1 : 0,
        stderr: "",
        stdout:
          args.slice(0, 2).join(" ") === "daemon status"
            ? JSON.stringify({
                daemon: {
                  state: "running",
                  reconciled: true,
                  gateway_state:
                    ++observations === 1 ? "connecting" : "connected",
                  active_operations: 0,
                },
                runtimes: [{ type: "codex", status: "ready" }],
              })
            : "",
      };
    });
  expect((await connectComputer(f.instance, { interactive: true })).state).toBe(
    "ready",
  );
  expect(
    process.mock.calls.some(
      ([, args]) => args.slice(0, 2).join(" ") === "daemon start",
    ),
  ).toBe(false);
});

it.each([false, undefined])(
  "does not report connected before daemon reconciliation (reconciled=%s)",
  async (reconciled) => {
    const f = await fixture();
    await writeFile(f.instance.computerConfig, "{}", { mode: 0o600 });
    vi.spyOn(processes, "runProcess").mockResolvedValue({
      code: 0,
      stderr: "",
      stdout: JSON.stringify({
        daemon: {
          state: "running",
          gateway_state: "connected",
          reconciled,
          active_operations: 0,
        },
        runtimes: [{ type: "codex", status: "ready" }],
      }),
    });
    expect(await inspectComputer(f.instance)).toMatchObject({
      connected: false,
      state: "offline",
    });
  },
);

it("reports the actual Gateway connection separately when disconnected", async () => {
  const f = await fixture({ connected: false });
  await writeFile(f.instance.computerConfig, "{}");
  expect((await inspectComputer(f.instance)).connected).toBe(false);
});

it("refreshes an idle instance after a private runtime is installed and preserves its identity", async () => {
  const f = await fixture();
  const personalAuth = path.join(f.instance.root, "personal-auth.json");
  await writeFile(personalAuth, "unchanged-personal-credentials", {
    mode: 0o600,
  });
  let refreshed = false;
  const run = vi
    .spyOn(processes, "runProcess")
    .mockImplementation(async (_exe, args, options) => {
      if (args[0] === "login")
        await writeFile(
          f.instance.computerConfig,
          JSON.stringify({
            runner_id: "same-identity",
            gateway: { token_file: "/existing/private/token" },
            codex: { auth_file: personalAuth },
            runtime_paths: {
              codex: "/existing/codex",
              claude: "/existing/claude",
            },
          }),
          { mode: 0o600 },
        );
      if (args.slice(0, 2).join(" ") === "daemon start") {
        expect(options?.env?.LINGER_CODEX_PATH).toBeTruthy();
        expect(options?.env?.CODEX_HOME).toBe(
          path.join(
            path.resolve(f.instance.root, "../.."),
            "runtime",
            "harness",
            "runtime",
            "codex",
          ),
        );
        refreshed = true;
      }
      return {
        code: 0,
        stderr: "",
        stdout:
          args.slice(0, 2).join(" ") === "daemon status"
            ? JSON.stringify({
                daemon: {
                  state: "running",
                  reconciled: true,
                  gateway_state: "connected",
                  active_operations: 0,
                },
                runtimes: [
                  {
                    type: "codex",
                    status: refreshed ? "ready" : "authentication_required",
                  },
                ],
              })
            : "",
      };
    });
  expect((await connectComputer(f.instance, { interactive: true })).state).toBe(
    "action_required",
  );
  const { atomicPrivate, privateDirectory } = await import("./instance.js");
  const executable = managedCodexPath(path.resolve(f.instance.root, "../.."));
  await privateDirectory(path.dirname(executable));
  await atomicPrivate(executable, "native-placeholder");
  const profile = path.join(
    path.resolve(f.instance.root, "../.."),
    "runtime",
    "harness",
    "runtime",
    "codex",
  );
  await privateDirectory(profile);
  await atomicPrivate(
    path.join(profile, "config.toml"),
    'experimental_bearer_token = "never-copy-api-key"',
  );
  await atomicPrivate(
    path.join(profile, "auth.json"),
    JSON.stringify({ OPENAI_API_KEY: "never-copy-api-key" }),
  );
  expect(
    (await connectComputer(f.instance, { interactive: false })).state,
  ).toBe("ready");
  expect(
    (await connectComputer(f.instance, { interactive: false })).state,
  ).toBe("ready");
  expect(run.mock.calls.filter(([, args]) => args[0] === "login")).toHaveLength(
    1,
  );
  expect(
    run.mock.calls.filter(
      ([, args]) => args.slice(0, 2).join(" ") === "daemon stop",
    ),
  ).toHaveLength(1);
  expect(
    run.mock.calls.find(
      ([, args]) => args.slice(0, 2).join(" ") === "daemon stop",
    )?.[1],
  ).toContain("--if-idle");
  expect(
    run.mock.calls.filter(
      ([, args]) => args.slice(0, 2).join(" ") === "daemon start",
    ),
  ).toHaveLength(1);
  expect(
    JSON.parse(await readFile(f.instance.computerConfig, "utf8")),
  ).toMatchObject({
    runner_id: "same-identity",
    codex: { auth_file: path.join(profile, "auth.json") },
    gateway: { token_file: "/existing/private/token" },
    runtime_paths: { codex: executable },
  });
  expect(
    JSON.parse(await readFile(f.instance.computerConfig, "utf8")).runtime_paths,
  ).toEqual({ codex: executable });
  expect(await readFile(personalAuth, "utf8")).toBe(
    "unchanged-personal-credentials",
  );
  const receipt = await readFile(
    path.join(
      path.dirname(f.instance.computerConfig),
      "managed-runtime.sha256",
    ),
    "utf8",
  );
  expect(receipt).toMatch(/^[a-f0-9]{64}$/);
  expect(receipt).not.toContain("never-copy-api-key");
  await atomicPrivate(
    path.join(profile, "config.toml"),
    'experimental_bearer_token = "changed-key"',
  );
  expect(
    (await connectComputer(f.instance, { interactive: false })).state,
  ).toBe("ready");
  expect(
    run.mock.calls.filter(
      ([, args]) => args.slice(0, 2).join(" ") === "daemon stop",
    ),
  ).toHaveLength(2);
  await atomicPrivate(
    path.join(profile, "auth.json"),
    JSON.stringify({ OPENAI_API_KEY: "rotated-auth-only" }),
  );
  expect(
    (await connectComputer(f.instance, { interactive: false })).state,
  ).toBe("ready");
  expect(
    run.mock.calls.filter(
      ([, args]) => args.slice(0, 2).join(" ") === "daemon stop",
    ),
  ).toHaveLength(3);
});

it.each([1, undefined])(
  "does not refresh a managed runtime when active operations are %s",
  async (active) => {
    const f = await fixture();
    await writeFile(f.instance.computerConfig, "{}", { mode: 0o600 });
    const { atomicPrivate, privateDirectory } = await import("./instance.js");
    const profile = path.join(
      path.resolve(f.instance.root, "../.."),
      "runtime",
      "harness",
      "runtime",
      "codex",
    );
    await privateDirectory(profile);
    await atomicPrivate(path.join(profile, "config.toml"), 'model = "changed"');
    const run = vi
      .spyOn(processes, "runProcess")
      .mockImplementation(async (_exe, args) => ({
        code: 0,
        stderr: "",
        stdout:
          args.slice(0, 2).join(" ") === "daemon status"
            ? JSON.stringify({
                daemon: {
                  state: "running",
                  reconciled: true,
                  gateway_state: "connected",
                  ...(active === undefined
                    ? {}
                    : { active_operations: active }),
                },
                runtimes: [],
              })
            : "",
      }));
    expect(
      (await connectComputer(f.instance, { interactive: false })).state,
    ).toBe("action_required");
    expect(
      run.mock.calls.some(([, args]) =>
        ["daemon stop", "daemon start", "login"].includes(
          args.slice(0, args[0] === "daemon" ? 2 : 1).join(" "),
        ),
      ),
    ).toBe(false);
  },
);

it("leaves identity and runtime binding untouched when the idle stop loses a race", async () => {
  const f = await fixture();
  const original =
    '{"runner_id":"saved-identity","codex":{"auth_file":"/personal/auth.json"}}';
  await writeFile(f.instance.computerConfig, original, { mode: 0o600 });
  const { atomicPrivate, privateDirectory } = await import("./instance.js");
  const profile = path.join(
    path.resolve(f.instance.root, "../.."),
    "runtime",
    "harness",
    "runtime",
    "codex",
  );
  await privateDirectory(profile);
  await atomicPrivate(path.join(profile, "config.toml"), 'model = "managed"');
  const run = vi
    .spyOn(processes, "runProcess")
    .mockImplementation(async (_exe, args) => ({
      code: args.slice(0, 2).join(" ") === "daemon stop" ? 1 : 0,
      stderr: "",
      stdout:
        args.slice(0, 2).join(" ") === "daemon status"
          ? JSON.stringify({
              daemon: {
                state: "running",
                reconciled: true,
                gateway_state: "connected",
                active_operations: 0,
              },
              runtimes: [],
            })
          : "",
    }));
  expect(
    (await connectComputer(f.instance, { interactive: false })).state,
  ).toBe("action_required");
  expect(await readFile(f.instance.computerConfig, "utf8")).toBe(original);
  expect(
    run.mock.calls.some(
      ([, args]) => args.slice(0, 2).join(" ") === "daemon start",
    ),
  ).toBe(false);
});

it("provides private Node to every Computer child without relying on the host PATH", async () => {
  const f = await fixture();
  const bundleBin = path.join(
    path.dirname(f.instance.computerExecutable),
    "runtime",
    "bin",
  );
  await mkdir(bundleBin, { recursive: true });
  await writeFile(
    path.join(bundleBin, "node"),
    `#!${process.execPath}\nprocess.stdout.write(process.version)`,
    { mode: 0o700 },
  );
  const previousPath = process.env.PATH;
  process.env.PATH = "/missing-host-node";
  try {
    const run = vi
      .spyOn(processes, "runProcess")
      .mockImplementation(async (_exe, args, options) => {
        expect(options?.env?.PATH?.split(path.delimiter)).toContain(
          path.dirname(process.execPath),
        );
        expect(options?.env?.PATH?.split(path.delimiter)[0]).toBe(bundleBin);
        expect(
          execFileSync("node", ["--version"], {
            env: options?.env,
            encoding: "utf8",
          }).trim(),
        ).toBe(process.version);
        if (args[0] === "login")
          await writeFile(f.instance.computerConfig, "{}", { mode: 0o600 });
        return {
          code: 0,
          stderr: "",
          stdout:
            args.slice(0, 2).join(" ") === "daemon status"
              ? JSON.stringify({
                  daemon: {
                    state: "running",
                    reconciled: true,
                    gateway_state: "connected",
                    active_operations: 0,
                  },
                  runtimes: [{ type: "codex", status: "ready" }],
                })
              : "",
        };
      });
    await connectComputer(f.instance, { interactive: true });
    await connectComputer(f.instance, { interactive: false });
    expect(
      run.mock.calls.filter(([, args]) => args[0] === "login"),
    ).toHaveLength(1);
    expect(
      run.mock.calls.some(([, args]) =>
        ["daemon stop", "daemon start"].includes(args.slice(0, 2).join(" ")),
      ),
    ).toBe(false);
    await writeFile(
      path.join(
        path.dirname(f.instance.computerConfig),
        "managed-runtime.sha256",
      ),
      "previous-runtime-path",
    );
    await connectComputer(f.instance, { interactive: false });
    await connectComputer(f.instance, { interactive: false });
    expect(
      run.mock.calls.filter(
        ([, args]) => args.slice(0, 2).join(" ") === "daemon start",
      ),
    ).toHaveLength(1);
    expect(
      run.mock.calls.filter(
        ([, args]) => args.slice(0, 2).join(" ") === "daemon stop",
      ),
    ).toHaveLength(1);
    expect(process.env.PATH).toBe("/missing-host-node");
  } finally {
    process.env.PATH = previousPath;
  }
});

it("binds approved Pi and follows upstream revisions while preserving Codex credentials", async () => {
  const f = await fixture();
  const { writeSetupChoice } = await import("./setup-selection.js");
  await writeSetupChoice(f.instance, "local-models");
  const { atomicPrivate, privateDirectory } = await import("./instance.js");
  const home = path.resolve(f.instance.root, "../..");
  const modelRoot = path.join(home, "runtime", "localmodels");
  const piDir = path.join(home, "pi-profile");
  await privateDirectory(modelRoot);
  await privateDirectory(piDir);
  await atomicPrivate(
    path.join(modelRoot, "binding.json"),
    JSON.stringify({
      schema: "localmodels.stack-binding/v1",
      ready: true,
      planId: "a".repeat(64),
      pi: {
        executable: "/owned/pi",
        environment: { PI_CODING_AGENT_DIR: piDir },
        configFingerprint: "b".repeat(64),
      },
    }),
  );
  await atomicPrivate(
    f.instance.computerConfig,
    JSON.stringify({
      runner_id: "same",
      codex: { auth_file: "/personal/codex" },
      runtime_paths: { codex: "/personal/codex-bin" },
    }),
  );
  const run = vi
    .spyOn(processes, "runProcess")
    .mockImplementation(async (_exe, args, options) => {
      expect(options?.env?.LINGER_PI_PATH).toBe("/owned/pi");
      expect(options?.env?.PI_CODING_AGENT_DIR).toBe(piDir);
      return {
        code: 0,
        stderr: "",
        stdout:
          args.slice(0, 2).join(" ") === "daemon status"
            ? JSON.stringify({
                daemon: {
                  state: "running",
                  reconciled: true,
                  gateway_state: "connected",
                  active_operations: 0,
                },
                runtimes: [{ type: "pi", status: "ready" }],
              })
            : "",
      };
    });
  await connectComputer(f.instance, { interactive: false });
  expect(
    JSON.parse(await readFile(f.instance.computerConfig, "utf8")),
  ).toMatchObject({
    runner_id: "same",
    codex: { auth_file: "/personal/codex" },
    runtime_paths: { pi: "/owned/pi" },
  });
  await connectComputer(f.instance, { interactive: false });
  expect(
    run.mock.calls.filter(
      ([, args]) => args.slice(0, 2).join(" ") === "daemon stop",
    ),
  ).toHaveLength(1);
  await atomicPrivate(
    path.join(modelRoot, "binding.json"),
    JSON.stringify({
      schema: "localmodels.stack-binding/v1",
      ready: true,
      planId: "a".repeat(64),
      pi: {
        executable: "/owned/pi",
        environment: { PI_CODING_AGENT_DIR: piDir },
        configFingerprint: "c".repeat(64),
      },
    }),
  );
  await connectComputer(f.instance, { interactive: false });
  expect(
    run.mock.calls.filter(
      ([, args]) => args.slice(0, 2).join(" ") === "daemon stop",
    ),
  ).toHaveLength(2);
  expect(
    run.mock.calls
      .filter(([, args]) => args.slice(0, 2).join(" ") === "daemon stop")
      .every(([, args]) => args.includes("--if-idle")),
  ).toBe(true);
});

it("uses the selected instance Pi profile instead of a previous home-wide model suite binding", async () => {
  const f = await fixture();
  const { atomicPrivate, privateDirectory } = await import("./instance.js");
  const { writeSetupChoice } = await import("./setup-selection.js");
  await writeSetupChoice(f.instance, "pi");
  const suite = path.join(
    path.resolve(f.instance.root, "../.."),
    "runtime",
    "localmodels",
  );
  await privateDirectory(suite);
  await atomicPrivate(
    path.join(suite, "binding.json"),
    JSON.stringify({
      schema: "localmodels.stack-binding/v1",
      ready: true,
      planId: "a".repeat(64),
      pi: {
        executable: "/previous/pi",
        environment: { PI_CODING_AGENT_DIR: "/previous/profile" },
        configFingerprint: "b".repeat(64),
      },
    }),
  );
  await privateDirectory(
    path.join(
      path.resolve(f.instance.root, "../.."),
      "runtime",
      "harness",
      "runtime",
      "pi",
    ),
  );
  await atomicPrivate(f.instance.computerConfig, "{}");
  vi.spyOn(processes, "runProcess").mockImplementation(
    async (_exe, _args, options) => {
      expect(options?.env?.PI_CODING_AGENT_DIR).toBe(
        path.join(
          path.resolve(f.instance.root, "../.."),
          "runtime",
          "harness",
          "runtime",
          "pi",
        ),
      );
      expect(options?.env?.LINGER_PI_PATH).not.toBe("/previous/pi");
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          daemon: {
            state: "running",
            reconciled: true,
            gateway_state: "connected",
            active_operations: 0,
          },
          runtimes: [{ type: "pi", status: "ready" }],
        }),
      };
    },
  );
  expect((await inspectComputer(f.instance)).state).toBe("ready");
});
it("binds only selected Pi while another managed Claude is available", async () => {
  const f = await fixture();
  await writeSetupChoice(f.instance, "pi");
  const home = path.resolve(f.instance.root, "../..");
  for (const runtime of ["claude", "pi"] as const) {
    const file = managedNativeRuntimePath(home, runtime);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "fixture", { mode: 0o700 });
  }
  await writeFile(
    f.instance.computerConfig,
    JSON.stringify({ runner_id: "existing" }),
    { mode: 0o600 },
  );
  vi.spyOn(processes, "runProcess").mockImplementation(
    async (_file, args, options) => {
      expect(options?.env?.LINGER_CLAUDE_PATH).toBeUndefined();
      expect(options?.env?.LINGER_PI_PATH).toBe(
        managedNativeRuntimePath(home, "pi"),
      );
      expect(options?.env?.PI_CODING_AGENT_DIR).toBe(
        process.env.PI_CODING_AGENT_DIR,
      );
      return {
        code: 0,
        stderr: "",
        stdout:
          args.slice(0, 2).join(" ") === "daemon status"
            ? JSON.stringify({
                daemon: {
                  state: "running",
                  reconciled: true,
                  gateway_state: "connected",
                  active_operations: 0,
                },
                runtimes: [{ type: "pi", status: "ready" }],
              })
            : "",
      };
    },
  );
  await connectComputer(f.instance, { interactive: false });
  expect(
    JSON.parse(await readFile(f.instance.computerConfig, "utf8")),
  ).toMatchObject({
    runner_id: "existing",
    runtime_paths: {
      pi: managedNativeRuntimePath(home, "pi"),
    },
  });
});
it("persists a managed Claude path when it is the only managed Runtime", async () => {
  const f = await fixture();
  await writeSetupChoice(f.instance, "claude");
  const executable = managedNativeRuntimePath(
    path.resolve(f.instance.root, "../.."),
    "claude",
  );
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, "fixture", { mode: 0o700 });
  await writeFile(f.instance.computerConfig, "{}", { mode: 0o600 });
  vi.spyOn(processes, "runProcess").mockImplementation(async (_file, args) => ({
    code: 0,
    stderr: "",
    stdout:
      args.slice(0, 2).join(" ") === "daemon status"
        ? JSON.stringify({
            daemon: {
              state: "running",
              reconciled: true,
              gateway_state: "connected",
              active_operations: 0,
            },
            runtimes: [{ type: "claude", status: "ready" }],
          })
        : "",
  }));
  await connectComputer(f.instance, { interactive: false });
  expect(
    JSON.parse(await readFile(f.instance.computerConfig, "utf8")),
  ).toMatchObject({ runtime_paths: { claude: executable } });
});
it("tracks only selected Claude explicit path and fingerprint", async () => {
  const f = await fixture();
  await writeSetupChoice(f.instance, "claude");
  const home = path.resolve(f.instance.root, "../..");
  for (const runtime of ["claude", "pi"] as const) {
    const executable = managedNativeRuntimePath(home, runtime);
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, "managed", { mode: 0o700 });
  }
  await writeFile(f.instance.computerConfig, "{}", { mode: 0o600 });
  const selectedClaude = path.join(home, "selected", "claude");
  const selectedPi = path.join(home, "selected", "pi");
  await mkdir(path.dirname(selectedClaude), { recursive: true });
  await writeFile(selectedClaude, "selected fixture", { mode: 0o700 });
  await writeFile(selectedPi, "selected fixture", { mode: 0o700 });
  vi.stubEnv("LINGER_CLAUDE_PATH", selectedClaude);
  vi.stubEnv("LINGER_PI_PATH", selectedPi);
  const run = vi
    .spyOn(processes, "runProcess")
    .mockImplementation(async (_file, args, options) => {
      expect(options?.env?.LINGER_CLAUDE_PATH).toBe(
        process.env.LINGER_CLAUDE_PATH,
      );
      expect(options?.env?.LINGER_PI_PATH).toBeUndefined();
      return {
        code: 0,
        stderr: "",
        stdout:
          args.slice(0, 2).join(" ") === "daemon status"
            ? JSON.stringify({
                daemon: {
                  state: "running",
                  reconciled: true,
                  gateway_state: "connected",
                  active_operations: 0,
                },
                runtimes: [{ type: "claude", status: "ready" }],
              })
            : "",
      };
    });
  try {
    await connectComputer(f.instance, { interactive: false });
    expect(
      JSON.parse(await readFile(f.instance.computerConfig, "utf8")),
    ).toMatchObject({
      runtime_paths: { claude: selectedClaude },
    });
    const stopped = run.mock.calls.filter(
      ([, args]) => args.slice(0, 2).join(" ") === "daemon stop",
    ).length;
    await connectComputer(f.instance, { interactive: false });
    expect(
      run.mock.calls.filter(
        ([, args]) => args.slice(0, 2).join(" ") === "daemon stop",
      ),
    ).toHaveLength(stopped);
    const changedClaude = path.join(home, "selected", "claude-next");
    await writeFile(changedClaude, "changed fixture", { mode: 0o700 });
    vi.stubEnv("LINGER_CLAUDE_PATH", changedClaude);
    await connectComputer(f.instance, { interactive: false });
    expect(
      run.mock.calls.filter(
        ([, args]) => args.slice(0, 2).join(" ") === "daemon stop",
      ),
    ).toHaveLength(stopped + 1);
    expect(
      JSON.parse(await readFile(f.instance.computerConfig, "utf8")),
    ).toMatchObject({
      runtime_paths: { claude: changedClaude },
    });
  } finally {
    vi.unstubAllEnvs();
  }
});
it.each(["claude", "pi"] as const)(
  "activates a saved %s API key in an existing idle Computer exactly once",
  async (runtime) => {
    const f = await fixture();
    await writeSetupChoice(f.instance, runtime);
    const { saveRuntimeApiKey } = await import("./runtime-credentials.js");
    const home = path.resolve(f.instance.root, "../..");
    const executable = managedNativeRuntimePath(home, runtime);
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, "native-runtime", { mode: 0o700 });
    await writeFile(f.instance.computerConfig, "{}", { mode: 0o600 });
    const run = vi
      .spyOn(processes, "runProcess")
      .mockImplementation(async (_file, args, options) => ({
        code: 0,
        stderr: "",
        stdout:
          args.slice(0, 2).join(" ") === "daemon status"
            ? JSON.stringify({
                daemon: {
                  state: "running",
                  reconciled: true,
                  gateway_state: "connected",
                  active_operations: 0,
                },
                runtimes: [
                  {
                    type: runtime,
                    status:
                      options?.env?.CLAUDE_CONFIG_DIR ||
                      options?.env?.PI_CODING_AGENT_DIR
                        ? "ready"
                        : "authentication_required",
                  },
                ],
              })
            : "",
      }));
    await connectComputer(f.instance, { interactive: false });
    run.mockClear();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await saveRuntimeApiKey(
      f.instance.root,
      runtime,
      "anthropic",
      "test-instance-key",
    );
    expect(
      (await connectComputer(f.instance, { interactive: false })).state,
    ).toBe("ready");
    expect(
      (await connectComputer(f.instance, { interactive: false })).state,
    ).toBe("ready");
    expect(
      run.mock.calls.filter(
        ([, args]) => args.slice(0, 2).join(" ") === "daemon stop",
      ),
    ).toHaveLength(1);
    expect(
      run.mock.calls.filter(
        ([, args]) => args.slice(0, 2).join(" ") === "daemon start",
      ),
    ).toHaveLength(1);
    expect(
      run.mock.calls.find(
        ([, args]) => args.slice(0, 2).join(" ") === "daemon start",
      )?.[2]?.env?.[
        runtime === "claude" ? "CLAUDE_CONFIG_DIR" : "PI_CODING_AGENT_DIR"
      ],
    ).toBe(path.join(home, "runtime", "harness", "runtime", runtime));
    expect(
      JSON.stringify(run.mock.calls.map(([, args]) => args)),
    ).not.toContain("test-instance-key");
    expect(
      JSON.parse(await readFile(f.instance.computerConfig, "utf8")),
    ).toMatchObject({ runtime_paths: { [runtime]: executable } });
  },
);
it.each(["codex", "claude", "pi"] as const)(
  "passes the managed %s executable to the very first login before daemon discovery",
  async (runtime) => {
    const f = await fixture();
    await writeSetupChoice(f.instance, runtime);
    const home = path.resolve(f.instance.root, "../..");
    const executable =
      runtime === "codex"
        ? managedCodexPath(home)
        : managedNativeRuntimePath(home, runtime);
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, "native-placeholder", { mode: 0o700 });
    const codexAuth = path.join(
      home,
      "runtime",
      "harness",
      "runtime",
      "codex",
      "auth.json",
    );
    if (runtime === "codex") {
      await mkdir(path.dirname(codexAuth), { recursive: true });
      await writeFile(codexAuth, "{}", { mode: 0o600 });
    }
    let loginArgs: string[] = [];
    let configuredBeforeStatus = false;
    const run = vi
      .spyOn(processes, "runProcess")
      .mockImplementation(async (_file, args) => {
        if (args[0] === "login") {
          loginArgs = args;
          const runtimeFlag = args.indexOf(`--${runtime}-path`);
          configuredBeforeStatus =
            runtimeFlag >= 0 && args[runtimeFlag + 1] === executable;
          await writeFile(
            f.instance.computerConfig,
            JSON.stringify({
              runner_id: "initial-identity",
              runtime_paths: configuredBeforeStatus
                ? { [runtime]: executable }
                : {},
            }),
            { mode: 0o600 },
          );
        }
        return {
          code: 0,
          stderr: "",
          stdout:
            args.slice(0, 2).join(" ") === "daemon status"
              ? JSON.stringify({
                  daemon: {
                    state: "running",
                    reconciled: true,
                    gateway_state: "connected",
                    active_operations: 0,
                  },
                  runtimes: [
                    {
                      type: runtime,
                      status: configuredBeforeStatus
                        ? "ready"
                        : "not_installed",
                    },
                  ],
                })
              : "",
        };
      });
    expect(
      (await connectComputer(f.instance, { interactive: true })).state,
    ).toBe("ready");
    expect(configuredBeforeStatus).toBe(true);
    expect(loginArgs[loginArgs.indexOf(`--${runtime}-path`) + 1]).toBe(
      executable,
    );
    expect(path.isAbsolute(executable)).toBe(true);
    if (runtime === "codex")
      expect(loginArgs[loginArgs.indexOf("--codex-auth") + 1]).toBe(codexAuth);
    const saved = JSON.parse(await readFile(f.instance.computerConfig, "utf8"));
    expect(saved.runner_id).toBe("initial-identity");
    expect(saved.runtime_paths[runtime]).toBe(executable);
    await connectComputer(f.instance, { interactive: false });
    expect(
      run.mock.calls.filter(([, args]) => args[0] === "login").length,
    ).toBe(1);
  },
);

it("keeps a genuine failed start actionable only after bounded offline observation", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const f = await connectingFixture(
    (call) => {
      if (call === 2) vi.setSystemTime(29_750);
      if (call === 3) vi.setSystemTime(30_000);
      return "connecting";
    },
    true,
    9,
  );
  const result = await connectComputer(f.instance, { interactive: false });
  expect(result.state).toBe("action_required");
  expect(result.connected).toBe(false);
  expect(result.detail).toContain("Could not start");
  expect(f.statuses()).toBe(3);
  expect(Date.now()).toBe(30_000);
  expect(
    f.process.mock.calls.filter(
      ([, args]) => args.slice(0, 2).join(" ") === "daemon start",
    ),
  ).toHaveLength(1);
});
