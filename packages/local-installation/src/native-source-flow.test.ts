import { prepareFoundationServices } from "./foundation-services.js";
vi.mock("./foundation-services.js", () => ({
  prepareFoundationServices: vi.fn(async () => {}),
}));
import { prepareModelGateway, stopModelGateway } from "./model-gateway.js";
vi.mock("./model-gateway.js", () => ({
  prepareModelGateway: vi.fn(async () => {}),
  stopModelGateway: vi.fn(async () => {}),
}));
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import {
  compileFailureExcerpt,
  installNativeSource,
  stopNativeSource,
} from "./native-source.js";
import { runProcess } from "./process.js";
import {
  installAppleDeveloperTools,
  needsAppleDeveloperTools,
} from "./apple-developer-tools.js";
import type { InstallerEvent } from "./events.js";
import {
  prepareNativeDependencies,
  prepareNativeVoiceTools,
} from "./native-dependencies.js";
import { readLiveKitSettings, startNativeLiveKit } from "./native-livekit.js";
import { updateUserKeys } from "./user-environment.js";
import {
  NATIVE_RUNTIME_DIRECTORY,
  NATIVE_RUNTIME_FILES,
} from "./native-runtime.js";
import {
  TEAMHUB_BINARY_DIRECTORY,
  TEAMHUB_COMMANDS,
} from "./teamhub-binaries.js";
import { prepareRuntime } from "./managed-runtimes.js";
import {
  inspectNativeProcess,
  nativeConfigurationChanged,
  startNativeProcess,
  stopNativeProcess,
} from "./native-process.js";
import { prepareNativeDatabase } from "./native-database.js";
import { prepareSourceComputer } from "./source-computer.js";
import { connectComputer } from "./computer.js";
vi.mock("./process.js", () => ({ runProcess: vi.fn() }));
vi.mock("./apple-developer-tools.js", () => ({
  needsAppleDeveloperTools: vi.fn(),
  installAppleDeveloperTools: vi.fn(),
}));
vi.mock("./native-dependencies.js", () => ({
  prepareNativeDependencies: vi.fn(),
  prepareNativeVoiceTools: vi.fn(),
}));
vi.mock("./native-livekit.js", async (original) => ({
  ...(await original<typeof import("./native-livekit.js")>()),
  readLiveKitSettings: vi.fn(),
  startNativeLiveKit: vi.fn(),
}));
vi.mock("./managed-runtimes.js", () => ({
  runtimeVersionFailure: vi.fn(() => undefined),
  prepareRuntime: vi.fn(),
}));
vi.mock("./managed-codex.js", () => ({
  managedRuntimeEnvironment: vi.fn(async () => ({})),
  configureManagedCodex: vi.fn(),
}));
vi.mock("./native-process.js", () => ({
  inspectNativeProcess: vi.fn(),
  nativeConfigurationChanged: vi.fn(),
  startNativeProcess: vi.fn(),
  stopNativeProcess: vi.fn(),
}));
vi.mock("./native-database.js", () => ({ prepareNativeDatabase: vi.fn() }));
vi.mock("./source-computer.js", () => ({ prepareSourceComputer: vi.fn() }));
vi.mock("./computer.js", () => ({
  connectComputer: vi.fn(async () => ({
    connected: true,
    state: "ready",
    detail: "connected",
    runtimes: [],
    activeOperations: 0,
  })),
  stopComputer: vi.fn(),
}));
const roots: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "native-flow-"));
  roots.push(home);
  const repo = path.join(home, "checkout");
  await mkdir(path.join(repo, "scripts"), { recursive: true });
  await writeFile(path.join(repo, "scripts/source-native.mjs"), "");
  await writeFile(
    path.join(repo, "package.json"),
    JSON.stringify({ name: "linger" }),
  );
  vi.mocked(prepareNativeDependencies).mockResolvedValue({
    env: {},
    postgresBin: "/private/postgres/bin",
    toolchainRoot: "/private/tools",
    registries: ["https://registry.npmjs.org/"],
  });
  let provisioned = false;
  vi.mocked(runProcess).mockImplementation(async (_command, args) => {
    if (args.includes("owner")) provisioned = true;
    return { code: 0, stdout: "", stderr: "" };
  });
  const running = new Set<string>();
  vi.mocked(inspectNativeProcess).mockImplementation(async (_root, name) => ({
    running: running.has(name),
  }));
  vi.mocked(startNativeProcess).mockImplementation(async (options) => {
    running.add(options.name);
    return { running: true, pid: 100 };
  });
  vi.mocked(nativeConfigurationChanged).mockResolvedValue(false);
  vi.mocked(stopNativeProcess).mockImplementation(async (_root, name) => {
    running.delete(name);
  });
  vi.mocked(prepareNativeDatabase).mockImplementation(async () => {
    running.add("postgres");
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url) =>
        new Response("{}", {
          status:
            String(url).endsWith("/v0/auth/login") && !provisioned ? 401 : 200,
        }),
    ),
  );
  return { home, repo, running };
}
test("native services and owner creation continue while selected Runtime authentication is pending", async () => {
  const f = await fixture();
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 4,
    state: "action_required",
    message: "sign in later",
    details: { code: "RUNTIME_AUTH_REQUIRED" },
  });
  const events: string[] = [];
  const result = await installNativeSource({
    home: f.home,
    repo: path.relative(process.cwd(), f.repo),
    name: "native-flow",
    setupChoice: "pi",
    shareGpu: true,
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event.message),
  });
  expect(result.code).toBe(4);
  expect(prepareModelGateway).toHaveBeenCalledWith(
    expect.anything(),
    "pi",
    expect.objectContaining({ home: f.home }),
  );
  expect(prepareFoundationServices).toHaveBeenCalledWith(
    expect.objectContaining({ root: expect.any(String) }),
    "pi",
    expect.objectContaining({
      shareGpu: true,
      signal: expect.any(AbortSignal),
    }),
  );
  expect(
    (result.details as { services: { ready: boolean }[] }).services.every(
      (row) => row.ready,
    ),
  ).toBe(true);
  expect(f.running).toEqual(
    new Set(["postgres", "teamhub", "node-services", "web"]),
  );
  expect(stopNativeProcess).not.toHaveBeenCalled();
  const owner = vi
    .mocked(runProcess)
    .mock.calls.find((row) => row[1].includes("owner"));
  expect(owner?.[0]).toBe(process.execPath);
  expect(owner?.[1][0]).toBe(path.join(f.repo, "scripts/source-native.mjs"));
  expect(owner?.[2]?.cwd).toBe(f.repo);
  expect(owner?.[2]?.input?.trim().length).toBeGreaterThan(8);
  expect(JSON.stringify(owner?.[1])).not.toContain(owner?.[2]?.input?.trim());
  expect(events.join("\n")).not.toContain(owner?.[2]?.input?.trim());
});
test("an external Computer skips the Go Computer release and enrollment", async () => {
  const f = await fixture();
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  const stages: string[] = [];
  const result = await installNativeSource({
    home: f.home,
    repo: f.repo,
    name: "native-desktop",
    setupChoice: "pi",
    externalComputer: true,
    signal: new AbortController().signal,
    onEvent: (event) => {
      if (event.kind === "stage" && event.state !== "running")
        stages.push(`${event.stage}:${event.state}`);
    },
  });
  expect(result).toMatchObject({ code: 0, state: "ready" });
  expect(stages).toContain("computer:skipped");
  expect(stages).toContain("runtime:succeeded");
  const operations = vi.mocked(runProcess).mock.calls.map((row) => row[1]);
  expect(operations.some((args) => args.includes("prepare"))).toBe(true);
  expect(operations.some((args) => args.includes("computer-release"))).toBe(
    false,
  );
  expect(prepareSourceComputer).not.toHaveBeenCalled();
  expect(connectComputer).not.toHaveBeenCalled();
  expect(f.running).toEqual(
    new Set(["postgres", "teamhub", "node-services", "web"]),
  );
});
test("a failed dependency install retries from the next registry and reports package progress", async () => {
  const f = await fixture();
  vi.mocked(prepareNativeDependencies).mockResolvedValue({
    env: {},
    postgresBin: "/private/postgres/bin",
    toolchainRoot: "/private/tools",
    registries: [
      "https://registry.npmjs.org/",
      "https://registry.npmmirror.com/",
    ],
  });
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  const installs: string[] = [];
  vi.mocked(runProcess).mockImplementation(async (_command, args, options) => {
    const operation = args[1]!;
    if (operation.startsWith("prepare")) {
      const registry = options?.env?.pnpm_config_registry ?? "";
      installs.push(`${operation} ${new URL(registry).host}`);
      options?.onOutput?.(
        "Progress: resolved 1, reused 0, downloaded 0, added 0\nProgress: resolved 90, reused 0, downloaded 40, added 30\nERR_PNPM_FETCH timed out\n",
      );
      return {
        code: installs.length === 1 ? 1 : 0,
        stdout: "",
        stderr: "",
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const events: InstallerEvent[] = [];
  await installNativeSource({
    ...f,
    name: "native-flow",
    setupChoice: "pi",
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
  });
  expect(installs).toEqual([
    "prepare registry.npmjs.org",
    "prepare registry.npmmirror.com",
    "prepare-computer registry.npmmirror.com",
  ]);
  const operations = vi.mocked(runProcess).mock.calls.map((row) => row[1][1]);
  expect(operations.indexOf("prepare-computer")).toBeLessThan(
    operations.indexOf("computer-release"),
  );
  const messages = events.map((event) => event.message);
  expect(messages).toContain(
    "Dependency installation from registry.npmjs.org failed; retrying with registry.npmmirror.com.\n",
  );
  expect(messages).toContain("ERR_PNPM_FETCH timed out\n");
  expect(messages.some((message) => message.startsWith("Progress:"))).toBe(
    false,
  );
  expect(events).toContainEqual({
    kind: "log",
    stage: "images",
    message: "Installing dependencies: 30 of 90 packages\n",
    progress: { completed: 30, total: 90, unit: "packages" },
  });
});
test("failed preparation never stops services that were already running", async () => {
  const f = await fixture();
  f.running.add("postgres");
  f.running.add("teamhub");
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  vi.mocked(runProcess).mockImplementation(async (_executable, args) => ({
    code: args.includes("migrate") ? 3 : 0,
    stdout: "",
    stderr: "",
  }));
  const result = await installNativeSource({
    ...f,
    name: "native-flow",
    setupChoice: "pi",
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(result.code).toBe(1);
  expect(stopNativeProcess).not.toHaveBeenCalled();
  expect(f.running.has("postgres")).toBe(true);
});

async function runFlow(f: Awaited<ReturnType<typeof fixture>>) {
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  return installNativeSource({
    ...f,
    name: "native-flow",
    setupChoice: "pi",
    signal: new AbortController().signal,
    onEvent: () => {},
  });
}

test("an unchanged TeamHub leaves a running node-services alone", async () => {
  const f = await fixture();
  for (const name of ["teamhub", "node-services", "web"]) f.running.add(name);
  await runFlow(f);
  expect(vi.mocked(stopNativeProcess)).not.toHaveBeenCalledWith(
    expect.anything(),
    "node-services",
  );
});

test("a stopped TeamHub never stops node-services up front", async () => {
  const f = await fixture();
  f.running.add("node-services");
  await runFlow(f);
  expect(vi.mocked(stopNativeProcess)).not.toHaveBeenCalledWith(
    expect.anything(),
    "node-services",
  );
});

test("a running node-services stops before TeamHub restarts", async () => {
  const f = await fixture();
  for (const name of ["teamhub", "node-services", "web"]) f.running.add(name);
  vi.mocked(nativeConfigurationChanged).mockImplementation(
    async (options) => options.name === "teamhub",
  );
  await runFlow(f);
  expect(
    vi.mocked(stopNativeProcess).mock.calls.map((call) => call[1]),
  ).toEqual(["node-services"]);
  const teamHubStart = vi
    .mocked(startNativeProcess)
    .mock.calls.findIndex(([options]) => options.name === "teamhub");
  expect(vi.mocked(stopNativeProcess).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(startNativeProcess).mock.invocationCallOrder[teamHubStart]!,
  );
  expect(f.running.has("node-services")).toBe(true);
});

test("a failure after the restart keeps the node-services that ran before", async () => {
  const f = await fixture();
  for (const name of ["postgres", "teamhub", "node-services"])
    f.running.add(name);
  vi.mocked(nativeConfigurationChanged).mockImplementation(
    async (options) => options.name === "teamhub",
  );
  vi.mocked(startNativeProcess).mockImplementation(async (options) => {
    if (options.name === "web") throw new Error("web failed");
    f.running.add(options.name);
    return { running: true, pid: 100 };
  });
  const result = await runFlow(f);
  expect(result.code).toBe(1);
  // The pre-stop hands in-flight Runs back; the rollback stops only what this
  // run started, never the node-services or TeamHub that were already running.
  expect(
    vi.mocked(stopNativeProcess).mock.calls.map((call) => call[1]),
  ).toEqual(["node-services", "web"]);
  expect(f.running.has("teamhub")).toBe(true);
  expect(f.running.has("node-services")).toBe(true);
});

test("stops native business services even if owned gateway shutdown reports a failure", async () => {
  const f = await fixture();
  const { prepareNativeConfiguration } = await import("./native-source.js");
  const { instance } = await prepareNativeConfiguration(f.repo, {
    home: f.home,
    name: "stop-native",
  });
  vi.mocked(stopModelGateway).mockRejectedValueOnce(
    new Error("Gateway unavailable"),
  );
  await expect(
    stopNativeSource(instance, new AbortController().signal),
  ).rejects.toThrow("Gateway unavailable");
  expect(
    vi.mocked(stopNativeProcess).mock.calls.map((call) => call[1]),
  ).toEqual(["web", "node-services", "teamhub", "livekit", "postgres"]);
});

test("a full disk ends startup at once instead of at the deadline", async () => {
  const f = await fixture();
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  const logs = path.join(f.home, "instances", "native-flow", "native/logs");
  await mkdir(logs, { recursive: true, mode: 0o700 });
  // An earlier run that failed is not this one.
  await writeFile(path.join(logs, "teamhub.log"), "failed to build\n", {
    mode: 0o600,
  });
  vi.mocked(startNativeProcess).mockImplementation(async (options) => {
    f.running.add(options.name);
    if (options.name === "teamhub")
      await writeFile(
        path.join(logs, "teamhub.log"),
        "compile: writing output: no space left on device\n",
        { mode: 0o600, flag: "a" },
      );
    return { running: true, pid: 100 };
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 503 })),
  );
  const result = await installNativeSource({
    ...f,
    name: "native-flow",
    setupChoice: "pi",
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(result).toMatchObject({ code: 1 });
  expect(result.message).toContain(
    "This computer's disk is full, so native teamhub could not be built.",
  );
});

// What scripts/source-native.mjs logs when go build fails, as on Windows
// before TeamHub had a Windows disk-capacity probe.
const failedBuild = [
  "building...",
  "go: downloading github.com/gin-gonic/gin v1.10.1",
  "# github.com/simplexai-labs/linger/apps/teamhub/internal/artifact",
  "internal\\artifact\\storage.go:276:17: undefined: unix.Statfs_t",
  "internal\\artifact\\storage.go:277:17: undefined: unix.Statfs",
  "failed to build, error: exit status 1",
  "",
].join("\n");

test("a compile excerpt keeps the compiler's lines from the last build", () => {
  const earlier =
    "[06:50:00] building...\nold.go:1:1: gone\n[06:50:01] failed to build, error: exit status 1\n";
  expect(compileFailureExcerpt(earlier + failedBuild)).toBe(
    [
      "go: downloading github.com/gin-gonic/gin v1.10.1",
      "# github.com/simplexai-labs/linger/apps/teamhub/internal/artifact",
      "internal\\artifact\\storage.go:276:17: undefined: unix.Statfs_t",
      "internal\\artifact\\storage.go:277:17: undefined: unix.Statfs",
      "failed to build, error: exit status 1",
    ].join("\n"),
  );
  expect(compileFailureExcerpt("[06:58:58] building...\n")).toBe("");
});

test("a compile excerpt is bounded and redacted", () => {
  const lines = Array.from({ length: 40 }, (_, index) => `line ${index}`);
  const text = [
    "building...",
    ...lines,
    `DATABASE_PASSWORD=hunter2 ${"x".repeat(400)}`,
    "\u001b[31mfailed to build, error: exit status 1\u001b[0m",
  ].join("\n");
  const excerpt = compileFailureExcerpt(text, 3);
  expect(excerpt.split("\n")).toHaveLength(3);
  expect(excerpt).toContain("line 39");
  expect(excerpt).not.toContain("hunter2");
  expect(excerpt).not.toContain("\u001b");
  expect(excerpt.split("\n")[1]!.length).toBeLessThanOrEqual(240);
});

test("a failed compile shows the compiler's lines on the setup page", async () => {
  const f = await fixture();
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  const logs = path.join(f.home, "instances", "native-flow", "native/logs");
  await mkdir(logs, { recursive: true, mode: 0o700 });
  // TeamHub exits after the failed build; the others keep running.
  vi.mocked(startNativeProcess).mockImplementation(async (options) => {
    if (options.name !== "teamhub") f.running.add(options.name);
    else
      await writeFile(path.join(logs, "teamhub.log"), failedBuild, {
        mode: 0o600,
        flag: "a",
      });
    return { running: true, pid: 100 };
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 503 })),
  );
  const result = await installNativeSource({
    ...f,
    name: "native-flow",
    setupChoice: "pi",
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(result).toMatchObject({ code: 1 });
  expect(result.message).toContain(
    "# github.com/simplexai-labs/linger/apps/teamhub/internal/artifact\ninternal\\artifact\\storage.go:276:17: undefined: unix.Statfs_t",
  );
  expect(result.message).toContain(
    `Inspect ${path.join(logs, "teamhub.log")}.`,
  );
  expect(result.message).toMatch(/^Native teamhub failed to compile\.\n/);
});

test("a native module that has to compile installs Apple's tools and retries", async () => {
  const f = await fixture();
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  let prepares = 0;
  const succeed = vi.mocked(runProcess).getMockImplementation()!;
  vi.mocked(runProcess).mockImplementation(async (command, args, options) => {
    if (args.includes("prepare") && ++prepares === 1) {
      options?.onOutput?.("gyp ERR! stack Error: not found: make\n");
      return { code: 1, stdout: "", stderr: "" };
    }
    return succeed(command, args, options);
  });
  vi.mocked(needsAppleDeveloperTools).mockImplementation(async (output) =>
    output.includes("gyp ERR!"),
  );
  vi.mocked(installAppleDeveloperTools).mockResolvedValue();
  const events: InstallerEvent[] = [];
  const result = await installNativeSource({
    ...f,
    name: "native-flow",
    setupChoice: "pi",
    externalComputer: true,
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
  });
  expect(result).toMatchObject({ code: 0 });
  expect(prepares).toBe(2);
  expect(installAppleDeveloperTools).toHaveBeenCalledTimes(1);
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: "stage",
      stage: "images",
      state: "running",
      message: "Installing Apple developer tools…",
    }),
  );
});

test("a native step that fails again after Apple's tools are installed reports the failure", async () => {
  const f = await fixture();
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  vi.mocked(runProcess).mockImplementation(async (_command, args, options) => {
    if (!args.includes("prepare")) return { code: 0, stdout: "", stderr: "" };
    options?.onOutput?.("gyp ERR! stack Error: not found: make\n");
    return { code: 1, stdout: "", stderr: "" };
  });
  vi.mocked(needsAppleDeveloperTools).mockResolvedValue(true);
  vi.mocked(installAppleDeveloperTools).mockResolvedValue();
  const result = await installNativeSource({
    ...f,
    name: "native-flow",
    setupChoice: "pi",
    externalComputer: true,
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(result).toMatchObject({ code: 1, state: "failed" });
  expect(result.message).toContain("Native source prepare failed (exit 1).");
  expect(installAppleDeveloperTools).toHaveBeenCalledTimes(1);
});

test("a failed checkout preparation reports its own cause, not the Runtime it stopped", async () => {
  const f = await fixture();
  vi.mocked(prepareNativeDependencies).mockRejectedValue(
    new Error("A verified private native tool could not execute."),
  );
  // Like prepareDependencies, the Runtime rethrows the abort that stopped it.
  vi.mocked(prepareRuntime).mockImplementation(
    (_choice, options) =>
      new Promise((_resolve, reject) =>
        options.signal.addEventListener("abort", () => {
          try {
            options.signal.throwIfAborted();
          } catch (error) {
            reject(error);
          }
        }),
      ),
  );
  const events: InstallerEvent[] = [];
  const result = await installNativeSource({
    ...f,
    name: "native-flow",
    setupChoice: "codex",
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
  });
  expect(result).toMatchObject({ code: 1, state: "failed" });
  expect(result.message).toMatch(
    /^A verified private native tool could not execute/,
  );
  expect(result.message).not.toContain("This operation was aborted");
  expect(result.details).toMatchObject({ stage: "release" });
});

test("a failed Runtime reports its own outcome while the checkout preparation stops", async () => {
  const f = await fixture();
  vi.mocked(prepareNativeDependencies).mockImplementation(
    (options) =>
      new Promise((_resolve, reject) =>
        options.signal.addEventListener("abort", () => {
          try {
            options.signal.throwIfAborted();
          } catch (error) {
            reject(error);
          }
        }),
      ),
  );
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 5,
    state: "failed",
    message: "codex could not be installed.",
  });
  const result = await installNativeSource({
    ...f,
    name: "native-flow",
    setupChoice: "codex",
    signal: new AbortController().signal,
    onEvent: () => {},
  });
  expect(result).toMatchObject({
    code: 5,
    message: "codex could not be installed.",
  });
});

test("an installation stopped from outside stays cancelled", async () => {
  const f = await fixture();
  const controller = new AbortController();
  vi.mocked(prepareNativeDependencies).mockImplementation(
    (options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          try {
            options.signal.throwIfAborted();
          } catch (error) {
            reject(error);
          }
        });
        controller.abort();
      }),
  );
  vi.mocked(prepareRuntime).mockImplementation(
    (_choice, options) =>
      new Promise((_resolve, reject) => {
        if (options.signal.aborted) reject(new Error("x"));
        options.signal.addEventListener("abort", () => reject(new Error("x")));
      }),
  );
  const result = await installNativeSource({
    ...f,
    name: "native-flow",
    setupChoice: "codex",
    signal: controller.signal,
    onEvent: () => {},
  });
  expect(result).toMatchObject({ code: 130, state: "cancelled" });
});

test("an abort without a cause names the step instead of the bare abort", async () => {
  const f = await fixture();
  vi.mocked(prepareNativeDependencies).mockRejectedValue(
    new DOMException("This operation was aborted", "AbortError"),
  );
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  const events: InstallerEvent[] = [];
  const result = await installNativeSource({
    ...f,
    name: "native-flow",
    setupChoice: "codex",
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
  });
  expect(result).toMatchObject({ code: 1, state: "failed" });
  expect(result.message).toMatch(
    /^Setup stopped unexpectedly while preparing private native toolchains and PostgreSQL\./,
  );
  expect(result.message).not.toContain("This operation was aborted");
  // The raw error stays in the installer log for diagnosis.
  expect(
    events.some(
      (event) =>
        event.kind === "log" &&
        event.message.includes("AbortError: This operation was aborted"),
    ),
  ).toBe(true);
});

test("bundled TeamHub binaries that verify spare the Go toolchain", async () => {
  const f = await fixture();
  const directory = path.join(f.repo, TEAMHUB_BINARY_DIRECTORY);
  await mkdir(directory, { recursive: true });
  const binaries: Record<string, object> = {};
  for (const command of TEAMHUB_COMMANDS) {
    const body = `${command} binary`;
    await writeFile(path.join(directory, `${command}.exe`), body);
    binaries[command] = {
      file: `${command}.exe`,
      sha256: createHash("sha256").update(body).digest("hex"),
      bytes: body.length,
    };
  }
  const manifest = {
    target: `${process.platform}-${process.arch}`,
    sourceCommit: "a".repeat(40),
    sourceArchiveSha256: "b".repeat(64),
    goVersion: "1.26.5",
    binaries,
  };
  await writeFile(
    path.join(directory, "manifest.json"),
    JSON.stringify(manifest),
  );
  vi.mocked(prepareNativeDependencies).mockRejectedValue(new Error("stop"));
  const install = async () => {
    const logs: string[] = [];
    await installNativeSource({
      ...f,
      name: "native-flow",
      setupChoice: "pi",
      signal: new AbortController().signal,
      onEvent: (event) => logs.push(event.message),
    });
    return logs;
  };
  expect(await install()).toContain(
    "Using the bundled TeamHub binaries; Go is not needed.\n",
  );
  expect(vi.mocked(prepareNativeDependencies).mock.lastCall?.[0].go).toBe(
    false,
  );
  // A changed binary is dropped, and Native compiles TeamHub with Go.
  await writeFile(path.join(directory, "migrate.exe"), "migrate binarY");
  expect(await install()).toContain(
    "The bundled TeamHub binaries do not verify; compiling TeamHub instead.\n",
  );
  expect(vi.mocked(prepareNativeDependencies).mock.lastCall?.[0].go).toBe(true);
  expect(existsSync(directory)).toBe(false);
});

// The services a desktop build unpacks into the checkout
// (build-native-runtime.mjs), with their manifest.
async function bundledRuntime(repo: string) {
  const directory = path.join(repo, NATIVE_RUNTIME_DIRECTORY);
  const files: Record<string, object> = {};
  for (const file of [
    "web/static-host.mjs",
    "web/dist/index.html",
    "node-services/dist/main.js",
    "node-services/dist/supervisor.js",
  ]) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), file);
    files[file] = {
      bytes: file.length,
      sha256: createHash("sha256").update(file).digest("hex"),
    };
  }
  await writeFile(
    path.join(directory, NATIVE_RUNTIME_FILES),
    JSON.stringify({
      schema: 1,
      target: `${process.platform}-${process.arch}`,
      sourceCommit: "a".repeat(40),
      sourceArchiveSha256: "b".repeat(64),
      files,
    }),
  );
  return directory;
}

test("bundled services that verify install no packages and record stage times", async () => {
  const f = await fixture();
  await bundledRuntime(f.repo);
  vi.mocked(prepareNativeDependencies).mockResolvedValue({
    env: {},
    postgresBin: "/private/postgres/bin",
    toolchainRoot: "/private/tools",
    registries: [],
  });
  vi.mocked(prepareRuntime).mockResolvedValue({
    code: 0,
    state: "ready",
    message: "ready",
  });
  const stages: string[] = [];
  const logs: string[] = [];
  let clock = 0;
  const result = await installNativeSource(
    {
      home: f.home,
      repo: f.repo,
      name: "native-desktop",
      setupChoice: "pi",
      externalComputer: true,
      signal: new AbortController().signal,
      onEvent: (event) => {
        logs.push(event.message);
        if (event.kind === "stage" && event.state !== "running")
          stages.push(`${event.stage}:${event.state}`);
      },
    },
    () => (clock += 1000),
  );
  expect(result).toMatchObject({ code: 0, state: "ready" });
  expect(logs).toContain(
    "Using the bundled Native services; no packages are installed.\n",
  );
  expect(vi.mocked(prepareNativeDependencies).mock.lastCall?.[0].packages).toBe(
    false,
  );
  expect(stages).toContain("images:skipped");
  const operations = vi.mocked(runProcess).mock.calls.map((row) => row[1]);
  expect(operations.some((args) => args.includes("prepare"))).toBe(false);
  expect(operations.some((args) => args.includes("migrate"))).toBe(true);
  const timings = (result.details as { timings: Record<string, number> })
    .timings;
  expect(Object.keys(timings)).toEqual(
    expect.arrayContaining(["preflight", "release", "images", "services"]),
  );
  expect(Object.values(timings).every((seconds) => seconds > 0)).toBe(true);
  expect(
    logs.some((line) => line.startsWith("Native install timings (s): ")),
  ).toBe(true);
});

test("bundled services that do not verify fall back to installing packages", async () => {
  const f = await fixture();
  const directory = await bundledRuntime(f.repo);
  await writeFile(path.join(directory, "web/dist/index.html"), "changed");
  vi.mocked(prepareNativeDependencies).mockRejectedValue(new Error("stop"));
  const logs: string[] = [];
  await installNativeSource({
    ...f,
    name: "native-flow",
    setupChoice: "pi",
    externalComputer: true,
    signal: new AbortController().signal,
    onEvent: (event) => logs.push(event.message),
  });
  expect(logs).toContain(
    "The bundled Native services do not verify; installing the checkout's packages instead.\n",
  );
  expect(vi.mocked(prepareNativeDependencies).mock.lastCall?.[0].packages).toBe(
    true,
  );
  expect(existsSync(directory)).toBe(false);
});
for (const bundled of [true, false])
  test(`saved voice keys ${bundled ? "start LiveKit and put ffmpeg on PATH" : "stay off without voice tools"}`, async () => {
    const f = await fixture();
    vi.mocked(prepareRuntime).mockResolvedValue({
      code: 0,
      state: "ready",
      message: "ready",
    });
    await updateUserKeys(path.join(f.home, "instances", "native-voice"), {
      SONIOX_API_KEY: "soniox-1",
    });
    const bin = path.join(f.home, "voice", "bin");
    vi.mocked(prepareNativeVoiceTools).mockResolvedValue(
      bundled ? { bin, livekit: path.join(bin, "livekit-server") } : undefined,
    );
    const settings = {
      httpPort: 30000,
      rtcPort: 30001,
      apiKey: "APIabcdef123456",
      apiSecret: "s".repeat(64),
    };
    vi.mocked(readLiveKitSettings).mockResolvedValue(settings);
    const events: string[] = [];
    await installNativeSource({
      home: f.home,
      repo: f.repo,
      name: "native-voice",
      setupChoice: "pi",
      externalComputer: true,
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event.message),
    });
    const services = vi
      .mocked(startNativeProcess)
      .mock.calls.map(([options]) => options)
      .filter((options) => options.name !== "postgres");
    const env = services.find(
      (options) => options.name === "node-services",
    )!.env;
    // A key or tools change restarts the services that read them.
    for (const options of services)
      expect(JSON.parse(options.settings!).voice).toBe(bundled ? bin : "off");
    if (bundled) {
      expect(startNativeLiveKit).toHaveBeenCalledWith(
        expect.objectContaining({
          executable: path.join(bin, "livekit-server"),
          settings,
        }),
      );
      expect(env.SONIOX_API_KEY).toBe("soniox-1");
      expect(env.PATH!.split(path.delimiter)[0]).toBe(bin);
    } else {
      expect(startNativeLiveKit).not.toHaveBeenCalled();
      expect(env.SONIOX_API_KEY).toBe("");
      expect(events.join("")).toContain("Voice stays off");
    }
    expect(events.join("")).not.toContain("soniox-1");
  });
