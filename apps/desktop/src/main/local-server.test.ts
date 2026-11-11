import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { zstdCompressSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";

import { NODE_RUNTIME_VERSION } from "../../../../scripts/local-computer-node-distributions.mjs";
import { rename } from "node:fs/promises";

import {
  LOCAL_INSTANCE,
  LOCAL_STEPS,
  LocalServerModule,
  anotherMeMissing,
  checkLocation,
  followHttps,
  hasNativePostgres,
  installLocation,
  parseSetCookie,
  signInWithPassword,
  type LocalServerOptions,
} from "./local-server.js";
import type { DesktopConfig } from "./config.js";
import { EventBus } from "./modules.js";
import {
  silentLog,
  stubModule,
  tempDirectory,
  testHost,
} from "./test-support.js";

// Prints what the real installer prints and writes its private launcher.
const FAKE_INSTALLER = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const home = args[args.indexOf("--home") + 1];
if (args.includes("--user-keys")) {
  const changes = JSON.parse(fs.readFileSync(0, "utf8"));
  fs.writeFileSync(path.join(home, "keys-args.json"), JSON.stringify(args));
  if (Object.values(changes).includes("bad")) {
    process.stdout.write(JSON.stringify({ error: "XAI_API_KEY is not a valid key" }) + "\n");
    process.exit(1);
  }
  const directory = path.join(home, "instances", "desktop");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "user.env");
  const saved = { ...(fs.existsSync(file) ? require("node:util").parseEnv(fs.readFileSync(file, "utf8")) : {}), ...changes };
  const names = Object.keys(saved).filter((name) => saved[name]);
  fs.writeFileSync(file, names.map((name) => name + "=" + saved[name] + "\n").join(""));
  process.stdout.write(JSON.stringify({ saved: names }) + "\n");
  process.exit(0);
}
fs.mkdirSync(path.join(home, "installer"), { recursive: true });
fs.writeFileSync(path.join(home, "installer", "args.json"), JSON.stringify(args));
if (args.includes("--inspect")) {
  const hardware = { totalMemoryBytes: 64 * 1024 ** 3, diskFreeBytes: 200 * 1024 ** 3, gpus: [{ name: "RTX 4090" }] };
  const eligible = !fs.existsSync(path.join(home, "small-computer"));
  const estimate = eligible
    ? { model: "qwen3-8b", downloadBytes: 6 * 1024 ** 3, diskBytes: 8 * 1024 ** 3, memoryBytes: 12 * 1024 ** 3 }
    : { model: "", downloadBytes: null, diskBytes: null, memoryBytes: null };
  process.stderr.write("Checked this computer in 1.5s.\n");
  const reasons = eligible ? [] : ["facts-unavailable"];
  const reasonMessages = eligible ? [] : ["nvidia-smi was not found"];
  process.stdout.write(JSON.stringify({ hardware, localModels: { eligible, reasons, reasonMessages, estimate } }) + "\n");
  process.exit(0);
}
if (args.includes("--resume")) {
  const code = fs.existsSync(path.join(home, "resume-fails")) ? 1 : 0;
  process.stdout.write("noise\n" + JSON.stringify({ code, message: code ? "Native teamhub stopped" : "ok" }) + "\n");
  process.exit(code);
}
const origin = "http://127.0.0.1:4321";
fs.writeFileSync(
  path.join(home, "installer", "launch.html"),
  '<meta http-equiv="refresh" content="0;url=' + origin + '/#token=abc&amp;x">',
);
process.stdout.write("Installer is running at " + origin + "\n");
`;

const sourceArchive = (root: string) => {
  const tree = path.join(root, "tree", "linger-1.0.0", "scripts");
  mkdirSync(tree, { recursive: true });
  writeFileSync(path.join(tree, "source-native.mjs"), "");
  const file = path.join(root, "linger.tar.gz");
  execFileSync("tar", [
    "-czf",
    file,
    "-C",
    path.join(root, "tree"),
    "linger-1.0.0",
  ]);
  const bytes = readFileSync(file);
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
};

const DONE = {
  state: "waiting_user",
  errorCode: "RUNTIME_AUTH_REQUIRED",
  origin: "http://localhost:3000",
};

// The installer's local API: a session, then one job that runs to the end;
// a retried job runs to DONE.
const installerApi = (
  jobs: Record<string, unknown>[] = [],
  finish: Record<string, unknown> = DONE,
  setup: Response = Response.json({ recommendation: "local-models" }),
  running: Record<string, unknown> | Record<string, unknown>[] = {
    state: "running",
    stage: "images",
  },
  // Whether the instance's login exists before a job is created.
  installed = true,
) => {
  const updates = [running].flat();
  const created: unknown[] = [];
  const retried: unknown[] = [];
  // The runtime the installation set up and its sign-in; tests change them.
  const runtime: {
    setupChoice: string;
    environment: Record<string, string>;
    login: Record<string, unknown>;
    logins: unknown[];
  } = {
    setupChoice: "claude",
    environment: {
      LINGER_CLAUDE_PATH: "/home/me/.linger/runtime/claude/claude",
      CLAUDE_CONFIG_DIR: "/home/me/.claude",
    },
    login: { state: "ready" },
    logins: [],
  };
  let polls = 0;
  const job = (fields: Record<string, unknown>) => ({
    id: "job",
    instance: LOCAL_INSTANCE,
    createdAt: "2026-11-03T00:00:00Z",
    stages: [
      { id: "images", state: "running", progress: { completed: 1, total: 2 } },
    ],
    ...fields,
  });
  const handle = async (url: URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (headers.get("origin") !== url.origin)
      return Response.json({ message: "origin" }, { status: 403 });
    if (url.pathname === "/api/session") {
      expect(JSON.parse(String(init.body))).toEqual({ token: "abc" });
      return new Response("{}", {
        headers: {
          "set-cookie": "linger_installer_session=s1; Path=/api; HttpOnly",
        },
      });
    }
    if (headers.get("cookie") !== "linger_installer_session=s1")
      return Response.json({ message: "session" }, { status: 401 });
    if (url.pathname === "/api/setup") return setup.clone();
    if (url.pathname === "/api/jobs" && init.method === "POST") {
      created.push(JSON.parse(String(init.body)));
      return Response.json(job({ state: "queued" }), { status: 202 });
    }
    if (url.pathname === "/api/jobs") return Response.json({ items: jobs });
    if (url.pathname === "/api/jobs/job/retry" && init.method === "POST") {
      retried.push(JSON.parse(String(init.body)));
      polls = 0;
      return Response.json(job({ state: "queued" }), { status: 202 });
    }
    if (url.pathname === "/api/jobs/job")
      return Response.json(
        job(
          ++polls <= updates.length
            ? updates[polls - 1]!
            : retried.length
              ? DONE
              : finish,
        ),
      );
    if (url.pathname === `/api/instances/${LOCAL_INSTANCE}/login`)
      return !installed && created.length === 0
        ? Response.json(
            {
              code: "INSTANCE_NOT_FOUND",
              message: "Instance or login information not found.",
            },
            { status: 404 },
          )
        : Response.json({
            email: "owner@linger.local",
            password: "pw",
            origin: "http://localhost:3000",
          });
    if (url.pathname === `/api/instances/${LOCAL_INSTANCE}/runtime`)
      return Response.json({
        setupChoice: runtime.setupChoice,
        environment: runtime.environment,
      });
    if (url.pathname === "/api/runtime-login" && init.method === "DELETE") {
      runtime.logins.push("cancel");
      runtime.login = { state: "idle" };
      return Response.json(runtime.login);
    }
    if (url.pathname === "/api/runtime-login" && init.method === "POST") {
      runtime.logins.push(JSON.parse(String(init.body)));
      return Response.json(runtime.login);
    }
    if (url.pathname === "/api/runtime-login") {
      expect(url.searchParams.get("instance")).toBe(LOCAL_INSTANCE);
      return Response.json(runtime.login);
    }
    return new Response(null, { status: 404 });
  };
  return { handle, created, retried, runtime };
};

const fixture = (
  overrides:
    | Partial<LocalServerOptions>
    | ((home: string) => Partial<LocalServerOptions>) = {},
  config: Partial<DesktopConfig> = {},
  prepare: (home: string) => void = () => {},
  api = installerApi(),
) => {
  const root = tempDirectory();
  const home = path.join(root, "home");
  const installerDirectory = path.join(root, "installer");
  mkdirSync(installerDirectory);
  // The module runs installer.js as CommonJS-compatible script.
  writeFileSync(path.join(installerDirectory, "installer.js"), FAKE_INSTALLER);
  writeFileSync(
    path.join(installerDirectory, "package.json"),
    '{"type":"commonjs"}',
  );
  // The publisher's PostgreSQL for this computer, which Native needs.
  const target = typeof overrides === "function" ? {} : overrides;
  const platform = target.platform ?? "linux";
  const arch = target.arch ?? "x64";
  writeFileSync(
    path.join(installerDirectory, "distribution.json"),
    JSON.stringify({
      platform,
      arch,
      nativeSources: [{ target: `${platform}-${arch}` }],
    }),
  );
  const node = path.join(home, "desktop", "node", `v${NODE_RUNTIME_VERSION}`);
  mkdirSync(path.join(node, "bin"), { recursive: true });
  symlinkSync(process.execPath, path.join(node, "bin", "node"));
  prepare(home);
  const setServer = vi.fn(() => true);
  const showUpdating = vi.fn();
  const bus = new EventBus();
  const showStarting = vi.fn();
  const showStartFailed = vi.fn();
  const loadServer = vi.fn();
  const enroll = vi.fn(async () => {});
  const signIn = vi.fn(async () => {});
  const options = typeof overrides === "function" ? overrides(home) : overrides;
  const download = options.fetch;
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return url.origin === "http://127.0.0.1:4321"
      ? api.handle(url, init)
      : download!(input, init);
  }) as typeof fetch;
  const module = new LocalServerModule({
    home,
    installerDirectory,
    platform: "linux",
    arch: "x64",
    pollMs: 10,
    freeBytes: 1,
    signIn,
    ...options,
    fetch: fetcher,
  });
  const host = testHost(
    [
      {
        ...stubModule("WindowManager"),
        setServer,
        showUpdating,
        showStarting,
        showStartFailed,
        loadServer,
      } as never,
      { ...stubModule("Enrollment"), enroll } as never,
      module,
    ],
    config,
    bus,
  );
  return {
    root,
    home,
    module,
    host,
    setServer,
    showUpdating,
    showStarting,
    showStartFailed,
    loadServer,
    bus,
    enroll,
    signIn,
    api,
  };
};

const installerArgs = (home: string) =>
  JSON.parse(
    readFileSync(path.join(home, "installer", "args.json"), "utf8"),
  ) as string[];

// A developer's linger checkout (LINGER_CHECKOUT) in the home folder.
const withCheckout = (home: string) => ({ checkout: path.join(home, "src") });
const checkout = (home: string) => {
  mkdirSync(path.join(home, "src", "scripts"), { recursive: true });
  writeFileSync(path.join(home, "src", "scripts/source-native.mjs"), "");
};

describe("LocalServerModule", () => {
  it("is offered only where native source mode runs", () => {
    const { module } = fixture({
      platform: "win32",
      arch: "arm64",
      checkout: "/src",
    });
    expect(module.status()).toMatchObject({
      available: false,
      phase: "idle",
    });
    expect(fixture({ checkout: "/src" }).module.status().available).toBe(true);
    expect(
      fixture({
        platform: "win32",
        arch: "x64",
        checkout: "/src",
      }).module.status().available,
    ).toBe(true);
    // Without the source package or a checkout there is nothing to install.
    expect(fixture().module.status().available).toBe(false);
  });

  it("offers Native only with PostgreSQL for this computer", async () => {
    const directory = tempDirectory();
    const write = (value: unknown) =>
      writeFileSync(
        path.join(directory, "distribution.json"),
        JSON.stringify(value),
      );
    expect(hasNativePostgres(directory, "linux-x64", {})).toBe(false);
    write({ platform: "linux", arch: "x64", nativeSources: [] });
    expect(hasNativePostgres(directory, "linux-x64", {})).toBe(false);
    write({
      platform: "linux",
      arch: "x64",
      nativeSources: [{ target: "linux-x64" }],
    });
    expect(hasNativePostgres(directory, "linux-x64", {})).toBe(true);
    // A distribution for another computer does not count.
    expect(hasNativePostgres(directory, "win32-x64", {})).toBe(false);
    // A developer's own sources replace the distribution's.
    expect(
      hasNativePostgres(directory, "linux-x64", {
        LINGER_NATIVE_DEPENDENCIES_JSON: "[]",
      }),
    ).toBe(false);
    expect(
      hasNativePostgres(directory, "win32-x64", {
        LINGER_NATIVE_DEPENDENCIES_JSON: '[{"target":"win32-x64"}]',
      }),
    ).toBe(true);
    // Windows gets Native as soon as its distribution pins PostgreSQL.
    write({
      platform: "win32",
      arch: "x64",
      nativeSources: [{ target: "win32-x64" }],
    });
    expect(hasNativePostgres(directory, "win32-x64", {})).toBe(true);
    // The Windows build bundles it beside the installer; it must be there.
    const bundled = { target: "win32-x64", file: "native/postgres.tar.gz" };
    write({ platform: "win32", arch: "x64", nativeSources: [bundled] });
    expect(hasNativePostgres(directory, "win32-x64", {})).toBe(false);
    mkdirSync(path.join(directory, "native"));
    writeFileSync(path.join(directory, bundled.file), "archive");
    expect(hasNativePostgres(directory, "win32-x64", {})).toBe(true);
    expect(fixture(withCheckout, {}, checkout).module.status().available).toBe(
      true,
    );
  });

  it("is not offered where the build has no PostgreSQL for this computer", async () => {
    const f = fixture(withCheckout, {}, (home) => {
      checkout(home);
      writeFileSync(
        path.join(path.dirname(home), "installer", "distribution.json"),
        JSON.stringify({ platform: "linux", arch: "x64", nativeSources: [] }),
      );
    });
    await f.host.start();
    expect(f.module.status().available).toBe(false);
    await expect(f.module.begin()).rejects.toThrow(/not supported/);
    expect(existsSync(path.join(f.home, "installer", "args.json"))).toBe(false);
    await f.host.stop("quit");
  });

  it("installs from the pinned source, signs in and connects this computer", async () => {
    const root = tempDirectory();
    const archive = sourceArchive(root);
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://github.com/linger.tar.gz")
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example/linger.tar.gz" },
        });
      return new Response(archive.bytes);
    });
    const f = fixture({
      sourceArchive: {
        url: "https://github.com/linger.tar.gz",
        sha256: archive.sha256,
      },
      fetch: fetcher as typeof fetch,
    });
    await f.host.start();
    const progress: number[] = [];
    f.host.ctx.bus.on("local-server.changed", () =>
      progress.push(f.module.status().progress),
    );
    await f.module.begin();
    // The source comes over the network, so downloading shows as a step;
    // the runtime is signed in already, so signing in does not.
    expect(f.module.status().steps).toEqual(
      LOCAL_STEPS.filter((step) => step !== "signin"),
    );
    expect(f.module.status().signIn).toBeUndefined();
    expect(f.api.runtime.logins).toEqual([]);
    // The Computer daemon runs the runtime the installer set up.
    expect(f.host.ctx.config.get().runtimeEnvironment).toEqual(
      f.api.runtime.environment,
    );

    const args = installerArgs(f.home);
    const repo = args[args.indexOf("--source-repo") + 1]!;
    expect(repo.startsWith(path.join(f.home, "desktop", "source"))).toBe(true);
    expect(readFileSync(path.join(repo, "scripts/source-native.mjs"))).toEqual(
      Buffer.alloc(0),
    );
    expect(args).toEqual(
      expect.arrayContaining(["--external-computer", "--no-open"]),
    );
    expect(args[args.indexOf("--instance") + 1]).toBe(LOCAL_INSTANCE);
    expect(f.api.created).toEqual([
      {
        instance: LOCAL_INSTANCE,
        setupChoice: "pi",
      },
    ]);
    expect(f.signIn).toHaveBeenCalledWith(
      "http://localhost:3000",
      "owner@linger.local",
      "pw",
    );
    expect(f.setServer).toHaveBeenCalledWith("http://localhost:3000");
    expect(f.enroll).toHaveBeenCalled();
    expect(f.module.status()).toMatchObject({
      phase: "ready",
      progress: 1,
      origin: "http://localhost:3000",
    });
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(
      JSON.parse(
        readFileSync(path.join(f.home, "desktop", "local-server.json"), "utf8"),
      ),
    ).toEqual({
      home: f.home,
      repo,
      origin: "http://localhost:3000",
    });
    await f.host.stop("quit");
  });

  it("asks for the runtime sign-in when there is none and goes on once signed in", async () => {
    // The desktop connects the Computer itself, so the job succeeds and
    // only its runtime stage waits for the sign-in.
    const api = installerApi([], {
      state: "succeeded",
      origin: "http://localhost:3000",
      stages: [
        { id: "runtime", state: "waiting_user" },
        { id: "computer", state: "skipped" },
      ],
    });
    api.runtime.setupChoice = "codex";
    api.runtime.login = { state: "idle" };
    const openExternal = vi.fn(async () => {});
    const f = fixture(
      (home) => ({ ...withCheckout(home), openExternal, signInPollMs: 5 }),
      {},
      checkout,
      api,
    );
    await f.host.start();
    const done = f.module.begin();
    await vi.waitFor(() => expect(f.module.status().step).toBe("signin"));
    expect(f.module.status()).toMatchObject({
      phase: "installing",
      message: "Sign in to Codex",
      signIn: { runtime: "codex", state: "required" },
    });
    expect(f.module.status().steps).toContain("signin");
    expect(f.enroll).not.toHaveBeenCalled();

    // The runtime's own login runs in the installer; its page opens once.
    api.runtime.login = {
      state: "waiting_user",
      url: "https://auth.openai.com/codex/device",
      deviceCode: "ABCD-1234",
    };
    await f.module.startSignIn();
    expect(api.runtime.logins).toEqual([{ instance: LOCAL_INSTANCE }]);
    expect(f.module.status().signIn).toEqual({
      runtime: "codex",
      state: "waiting_user",
      url: "https://auth.openai.com/codex/device",
      deviceCode: "ABCD-1234",
    });
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1));
    expect(openExternal).toHaveBeenCalledWith(
      "https://auth.openai.com/codex/device",
    );

    // Claude Code's page shows a code to paste back.
    await f.module.startSignIn("pasted-code");
    expect(api.runtime.logins).toEqual([
      { instance: LOCAL_INSTANCE },
      { instance: LOCAL_INSTANCE, code: "pasted-code" },
    ]);

    // Signing in finishes in the browser; the next check sees it.
    api.runtime.login = { state: "ready" };
    await done;
    expect(f.module.status()).toMatchObject({
      phase: "ready",
      signIn: { runtime: "codex", state: "signed_in" },
    });
    expect(f.module.status().steps).toContain("signin");
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(f.enroll).toHaveBeenCalled();
    expect(f.host.ctx.config.get().runtimeEnvironment).toEqual(
      api.runtime.environment,
    );
    await f.host.stop("quit");
  });

  it("leaves the browser to the runtime, and cancels and retries its login", async () => {
    const api = installerApi([], {
      state: "succeeded",
      origin: "http://localhost:3000",
      stages: [{ id: "runtime", state: "waiting_user" }],
    });
    api.runtime.setupChoice = "claude";
    api.runtime.login = { state: "idle" };
    const openExternal = vi.fn(async () => {});
    const f = fixture(
      (home) => ({ ...withCheckout(home), openExternal, signInPollMs: 5 }),
      {},
      checkout,
      api,
    );
    await f.host.start();
    const done = f.module.begin();
    await vi.waitFor(() =>
      expect(f.module.status().signIn).toEqual({
        runtime: "claude",
        state: "required",
      }),
    );

    // Claude Code opens the browser on its own callback page; the link it
    // prints is the paste-code fallback, so nothing opens it here.
    const fallback = {
      state: "waiting_user" as const,
      url: "https://claude.com/cai/oauth/authorize?state=x",
      acceptsCode: true,
    };
    api.runtime.login = fallback;
    await f.module.startSignIn();
    expect(f.module.status().signIn).toEqual({
      runtime: "claude",
      ...fallback,
    });
    expect(openExternal).not.toHaveBeenCalled();
    // "Open browser again" opens it on request.
    await f.module.openSignInPage();
    expect(openExternal).toHaveBeenCalledWith(fallback.url);

    await f.module.cancelSignIn();
    expect(api.runtime.logins).toEqual([
      { instance: LOCAL_INSTANCE },
      "cancel",
    ]);
    expect(f.module.status().signIn).toEqual({
      runtime: "claude",
      state: "required",
    });

    // The login ends without a sign-in: the failure stays until a retry.
    api.runtime.login = {
      state: "failed",
      message: "Sign-in was not completed.",
    };
    await f.module.startSignIn();
    api.runtime.login = { state: "idle" };
    await delay(30);
    expect(f.module.status().signIn).toEqual({
      runtime: "claude",
      state: "failed",
      message: "Sign-in was not completed.",
    });

    api.runtime.login = fallback;
    await f.module.startSignIn();
    expect(f.module.status().signIn?.state).toBe("waiting_user");
    api.runtime.login = { state: "ready" };
    await done;
    expect(f.module.status()).toMatchObject({
      phase: "ready",
      signIn: { runtime: "claude", state: "signed_in" },
    });
    expect(openExternal).toHaveBeenCalledTimes(1);
    await f.host.stop("quit");
  });

  it("names the runtime Auto chose, and installs another one instead", async () => {
    // Auto resolves to the local model, which runs on Pi.
    const api = installerApi();
    api.runtime.setupChoice = "local-models";
    api.runtime.login = {
      state: "failed",
      message: "Native browser sign-in is unavailable for this runtime.",
    };
    const f = fixture(
      (home) => ({ ...withCheckout(home), signInPollMs: 5 }),
      {},
      checkout,
      api,
    );
    await f.host.start();
    const done = f.module.begin();
    await vi.waitFor(() =>
      expect(f.module.status().signIn).toEqual({
        runtime: "pi",
        state: "failed",
        message: "Native browser sign-in is unavailable for this runtime.",
      }),
    );
    expect(f.module.status().message).toBe("Sign in to Pi");

    api.runtime.setupChoice = "codex";
    api.runtime.environment = { LINGER_CODEX_PATH: "/opt/codex/codex" };
    api.runtime.login = { state: "ready" };
    f.module.switchRuntime("codex");
    await done;
    expect(f.api.created).toEqual([
      { instance: LOCAL_INSTANCE, setupChoice: "pi" },
      { instance: LOCAL_INSTANCE, setupChoice: "codex" },
    ]);
    expect(f.module.status().phase).toBe("ready");
    // Signed in already, so the step went away with the old runtime.
    expect(f.module.status().signIn).toBeUndefined();
    expect(f.module.status().steps).not.toContain("signin");
    expect(f.host.ctx.config.get().runtimeEnvironment).toEqual({
      LINGER_CODEX_PATH: "/opt/codex/codex",
    });
    await f.host.stop("quit");
  });

  it("unpacks the published dependency store into the source, or goes on without it", async () => {
    const root = tempDirectory();
    const archive = sourceArchive(root);
    const store = path.join(root, "deps", "pnpm-store", "v11");
    mkdirSync(store, { recursive: true });
    writeFileSync(path.join(store, "index"), "packages");
    const bundleFile = path.join(root, "deps.tar.gz");
    execFileSync("tar", [
      "-czf",
      bundleFile,
      "-C",
      path.join(root, "deps"),
      "pnpm-store",
    ]);
    const bundle = readFileSync(bundleFile);
    for (const available of [true, false]) {
      const fetcher = vi.fn(async (input: string | URL | Request) =>
        String(input).endsWith("/deps.tar.gz")
          ? available
            ? new Response(bundle)
            : new Response("missing", { status: 404 })
          : new Response(archive.bytes),
      );
      const f = fixture({
        sourceArchive: {
          url: "https://cdn.example/linger.tar.gz",
          sha256: archive.sha256,
        },
        sourceDependencies: {
          url: "https://cdn.example/deps.tar.gz",
          sha256: createHash("sha256").update(bundle).digest("hex"),
        },
        fetch: fetcher as typeof fetch,
      });
      await f.host.start();
      await f.module.begin();
      const args = installerArgs(f.home);
      const repo = args[args.indexOf("--source-repo") + 1]!;
      const index = path.join(repo, ".linger-runtime/pnpm-store/v11/index");
      expect(existsSync(index)).toBe(available);
      if (available) expect(readFileSync(index, "utf8")).toBe("packages");
      expect(f.module.status().phase).toBe("ready");
      await f.host.stop("quit");
    }
  });

  it("downloads the source package from a mirror when its host fails", async () => {
    const root = tempDirectory();
    const archive = sourceArchive(root);
    const hosts: string[] = [];
    const f = fixture({
      sourceArchive: {
        url: "https://github.com/linger.tar.gz",
        mirrors: ["https://mirror.example/linger.tar.gz"],
        sha256: archive.sha256,
      },
      fetch: (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        hosts.push(url.host);
        return url.host === "github.com"
          ? new Response("unavailable", { status: 503 })
          : new Response(archive.bytes);
      }) as typeof fetch,
    });
    await f.host.start();
    await f.module.begin();
    expect(hosts[0]).toBe("github.com");
    expect(hosts.at(-1)).toBe("mirror.example");
    expect(f.module.status().phase).toBe("ready");
    await f.host.stop("quit");
  });

  it("keeps only the running version's source and then the new one's", async () => {
    const root = tempDirectory();
    const archive = sourceArchive(root);
    let during: string[] = [];
    const f = fixture({
      sourceArchive: {
        url: "https://cdn.example/linger.tar.gz",
        sha256: archive.sha256,
      },
      fetch: (async () => {
        during = readdirSync(sources);
        return new Response(archive.bytes);
      }) as typeof fetch,
    });
    const sources = path.join(f.home, "desktop", "source");
    for (const old of ["older", "running"])
      mkdirSync(path.join(sources, old, "node_modules"), { recursive: true });
    writeFileSync(
      path.join(f.home, "desktop", "local-server.json"),
      JSON.stringify({
        home: f.home,
        repo: path.join(sources, "running"),
        origin: "http://localhost:3000",
      }),
    );
    await f.host.start();
    await f.module.begin();
    const current = archive.sha256.slice(0, 16);
    // The download comes after the older version is gone.
    expect(during).toEqual(["running"]);
    expect(readdirSync(sources)).toEqual([current]);
    await f.host.stop("quit");
  });

  it("opens the app once the Another Me and the starter agents are there", async () => {
    const polls = { anotherMe: 0, rooms: 0 };
    const server = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/v0/me")
        return Response.json({ actors: [{ kind: "human", tenant_id: "t1" }] });
      if (url.pathname === "/v0/tenants/t1/another-me")
        // The server answers {} until it has created the Another Me.
        return Response.json(
          ++polls.anotherMe < 3 ? {} : { agent_actor_id: "actor_anotherme_1" },
        );
      if (url.pathname === "/v0/tenants/t1/rooms")
        return Response.json({
          items: ++polls.rooms < 2 ? [] : [{ name: "Getting Started" }],
        });
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const f = fixture(
      (home) => ({
        ...withCheckout(home),
        fetch: server,
        sessionCookie: async () => "session=s",
      }),
      {},
      checkout,
    );
    await f.host.start();
    const seen: { step: string; message: string }[] = [];
    f.host.ctx.bus.on("local-server.changed", () => {
      const { step, message } = f.module.status();
      seen.push({ step, message });
    });
    await f.module.begin();
    expect(seen).toContainEqual({
      step: "agents",
      message: "Preparing your Another Me…",
    });
    expect(polls).toEqual({ anotherMe: 4, rooms: 2 });
    expect(f.module.status().phase).toBe("ready");
    await f.host.stop("quit");
  });

  it("says what the server is missing when the Another Me never comes", async () => {
    const server = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/v0/me")
        return Response.json({ actors: [{ kind: "human", tenant_id: "t1" }] });
      if (url.pathname === "/v0/tenants/t1/another-me")
        return Response.json({});
      if (url.pathname === "/v0/tenants/t1/local-computers")
        return Response.json({
          items: [
            {
              computer_id: "cmp_1",
              status: "online",
              workspace_grants: [{ mode: "workspace-write" }],
              runtimes: [
                { type: "claude", status: "not_installed", models: [] },
                { type: "codex", status: "authentication_required" },
              ],
            },
          ],
        });
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const f = fixture(
      (home) => ({
        ...withCheckout(home),
        fetch: server,
        sessionCookie: async () => "session=s",
        agentsTimeoutMs: 0,
      }),
      { computerId: "cmp_1" },
      checkout,
    );
    await f.host.start();
    await expect(f.module.begin()).rejects.toThrow(
      "No signed-in AI runtime is reported by this computer. It found Claude Code: not found on this computer; Codex: not signed in.",
    );
    expect(f.module.status().phase).toBe("failed");
    await f.host.stop("quit");
  });

  it("stops waiting once the Computer service cannot start", async () => {
    const polls = { anotherMe: 0 };
    const server = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/v0/me")
        return Response.json({ actors: [{ kind: "human", tenant_id: "t1" }] });
      if (url.pathname === "/v0/tenants/t1/another-me") {
        polls.anotherMe += 1;
        return Response.json({});
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const f = fixture(
      (home) => ({
        ...withCheckout(home),
        fetch: server,
        sessionCookie: async () => "session=s",
        pollMs: 1,
      }),
      { computerId: "cmp_1" },
      checkout,
    );
    await f.host.start();
    const setup = f.module.begin();
    await vi.waitFor(() => expect(polls.anotherMe).toBeGreaterThan(0));
    f.host.ctx.bus.emit(
      "computer.failed",
      "read Computer config: private path grants access to another user (S-1-5-11)",
    );
    await expect(setup).rejects.toThrow(
      "The Computer service on this computer cannot start: read Computer config: private path grants access to another user (S-1-5-11). computer-daemon.log in the logs has details.",
    );
    expect(f.module.status().phase).toBe("failed");
    await f.host.stop("quit");
  });

  it("rejects a source package with the wrong digest", async () => {
    const root = tempDirectory();
    const archive = sourceArchive(root);
    const f = fixture({
      sourceArchive: {
        url: "https://example.com/linger.tar.gz",
        sha256: "0".repeat(64),
      },
      fetch: (async () => new Response(archive.bytes)) as typeof fetch,
    });
    await f.host.start();
    await expect(f.module.begin()).rejects.toThrow();
    // The failure stays on the step it happened in.
    expect(f.module.status()).toMatchObject({
      phase: "failed",
      step: "download",
    });
    expect(f.signIn).not.toHaveBeenCalled();
  });

  it("installs from the source package bundled in the app", async () => {
    const f = fixture();
    const archive = sourceArchive(f.root);
    mkdirSync(path.join(f.root, "installer", "source"));
    writeFileSync(
      path.join(f.root, "installer", "source", "linger.tar.gz"),
      archive.bytes,
    );
    const bundled = (sha256: string) =>
      new LocalServerModule({
        home: f.home,
        installerDirectory: path.join(f.root, "installer"),
        platform: "linux",
        arch: "x64",
        sourceArchive: { file: "source/linger.tar.gz", sha256 },
        signIn: f.signIn,
      });
    const damaged = bundled("0".repeat(64));
    await expect(damaged.begin()).rejects.toThrow(
      "The bundled linger.tar.gz is damaged",
    );
    // The installer stops after the source is in place; only the source matters.
    await bundled(archive.sha256)
      .begin()
      .catch(() => undefined);
    const args = installerArgs(f.home);
    const repo = args[args.indexOf("--source-repo") + 1]!;
    expect(existsSync(path.join(repo, "scripts/source-native.mjs"))).toBe(true);
  });

  it("hands Native the TeamHub binaries built from its source package", async () => {
    const f = fixture();
    const archive = sourceArchive(f.root);
    mkdirSync(path.join(f.root, "installer", "source"));
    writeFileSync(
      path.join(f.root, "installer", "source", "linger.tar.gz"),
      archive.bytes,
    );
    const binaries = path.join(
      f.root,
      "installer",
      "native",
      "teamhub-linux-x64",
    );
    mkdirSync(binaries, { recursive: true });
    const manifest = (sourceArchiveSha256: string) =>
      writeFileSync(
        path.join(binaries, "manifest.json"),
        JSON.stringify({
          target: "linux-x64",
          sourceCommit: "a".repeat(40),
          sourceArchiveSha256,
          goVersion: "1.26.5",
          binaries: Object.fromEntries(
            ["teamhub", "migrate", "account"].map((command) => {
              writeFileSync(path.join(binaries, command), command);
              return [
                command,
                {
                  file: command,
                  sha256: createHash("sha256").update(command).digest("hex"),
                  bytes: command.length,
                },
              ];
            }),
          ),
        }),
      );
    const install = async () => {
      await new LocalServerModule({
        home: f.home,
        installerDirectory: path.join(f.root, "installer"),
        platform: "linux",
        arch: "x64",
        sourceArchive: { file: "source/linger.tar.gz", sha256: archive.sha256 },
        signIn: f.signIn,
      })
        .begin()
        .catch(() => undefined);
      const args = installerArgs(f.home);
      return path.join(
        args[args.indexOf("--source-repo") + 1]!,
        ".simplexai-runtime/prebuilt",
      );
    };
    // Binaries of another source package stay out; Native compiles.
    manifest("0".repeat(64));
    const prebuilt = await install();
    expect(existsSync(prebuilt)).toBe(false);
    manifest(archive.sha256);
    await install();
    expect(readFileSync(path.join(prebuilt, "migrate"), "utf8")).toBe(
      "migrate",
    );
    expect(existsSync(path.join(prebuilt, "manifest.json"))).toBe(true);
  });

  it("unpacks the services built from its source package into the source", async () => {
    const f = fixture();
    const archive = sourceArchive(f.root);
    mkdirSync(path.join(f.root, "installer", "source"));
    writeFileSync(
      path.join(f.root, "installer", "source", "linger.tar.gz"),
      archive.bytes,
    );
    const bundle = path.join(
      f.root,
      "installer",
      "native",
      "runtime-linux-x64",
    );
    const tree = path.join(f.root, "runtime-tree", "runtime");
    mkdirSync(tree, { recursive: true });
    writeFileSync(
      path.join(tree, "files.json"),
      JSON.stringify({
        target: "linux-x64",
        sourceCommit: "a".repeat(40),
        sourceArchiveSha256: archive.sha256,
        files: {},
      }),
    );
    mkdirSync(bundle, { recursive: true });
    writeFileSync(
      path.join(bundle, "runtime.tar.zst"),
      zstdCompressSync(
        execFileSync("tar", ["-cf", "-", "-C", path.dirname(tree), "runtime"]),
      ),
    );
    const runtimeSha256 = createHash("sha256")
      .update(readFileSync(path.join(bundle, "runtime.tar.zst")))
      .digest("hex");
    const manifest = (sourceArchiveSha256: string, sha256 = runtimeSha256) =>
      writeFileSync(
        path.join(bundle, "manifest.json"),
        JSON.stringify({
          target: "linux-x64",
          sourceCommit: "a".repeat(40),
          sourceArchiveSha256,
          archive: { file: "runtime.tar.zst", sha256, bytes: 1 },
        }),
      );
    const install = async (glibcVersion = "2.35") => {
      await new LocalServerModule({
        home: f.home,
        installerDirectory: path.join(f.root, "installer"),
        platform: "linux",
        arch: "x64",
        glibcVersion,
        sourceArchive: { file: "source/linger.tar.gz", sha256: archive.sha256 },
        signIn: f.signIn,
      })
        .begin()
        .catch(() => undefined);
      const args = installerArgs(f.home);
      return path.join(
        args[args.indexOf("--source-repo") + 1]!,
        ".simplexai-runtime/offline",
      );
    };
    // Services of another source package, or a damaged archive, stay out;
    // Native installs the source's packages instead.
    manifest("0".repeat(64));
    const offline = await install();
    expect(existsSync(offline)).toBe(false);
    manifest(archive.sha256, "0".repeat(64));
    await install();
    expect(existsSync(offline)).toBe(false);
    manifest(archive.sha256);
    // Their native packages need glibc 2.35, like the PostgreSQL build.
    await install("2.31");
    expect(existsSync(offline)).toBe(false);
    await install();
    expect(
      JSON.parse(readFileSync(path.join(offline, "files.json"), "utf8")),
    ).toMatchObject({
      target: "linux-x64",
      sourceArchiveSha256: archive.sha256,
    });
    // The installer checks an unpacked runtime by size, not by hashing it.
    expect(existsSync(path.join(offline, "verified.json"))).toBe(true);
    // It unpacks in place, with no folder to rename after.
    expect(existsSync(`${offline}.partial`)).toBe(false);
    // An unpacking that stopped partway has no record and is done again.
    rmSync(path.join(offline, "verified.json"));
    writeFileSync(path.join(offline, "leftover"), "");
    await install();
    expect(existsSync(path.join(offline, "leftover"))).toBe(false);
    expect(existsSync(path.join(offline, "verified.json"))).toBe(true);
  });

  it("copies the services and Node.js a Mac build bundles as folders", async () => {
    const node = (home: string) =>
      path.join(home, "desktop", "node", `v${NODE_RUNTIME_VERSION}`);
    const f = fixture({}, {}, (home) =>
      rmSync(node(home), { recursive: true, force: true }),
    );
    const installer = path.join(f.root, "installer");
    const archive = sourceArchive(f.root);
    mkdirSync(path.join(installer, "source"));
    writeFileSync(
      path.join(installer, "source", "linger.tar.gz"),
      archive.bytes,
    );
    writeFileSync(
      path.join(installer, "distribution.json"),
      JSON.stringify({
        platform: "darwin",
        arch: "arm64",
        nativeSources: [{ target: "darwin-arm64" }],
      }),
    );
    const bundle = path.join(installer, "native", "runtime-darwin-arm64");
    mkdirSync(path.join(bundle, "runtime", "web"), { recursive: true });
    mkdirSync(path.join(bundle, "node", "bin"), { recursive: true });
    const files = JSON.stringify({
      target: "darwin-arm64",
      sourceCommit: "a".repeat(40),
      sourceArchiveSha256: archive.sha256,
      files: {},
    });
    writeFileSync(path.join(bundle, "runtime", "files.json"), files);
    writeFileSync(path.join(bundle, "runtime", "web", "static-host.mjs"), "");
    // The signed binary; here the Node.js running the tests.
    symlinkSync(process.execPath, path.join(bundle, "node", "bin", "node"));
    const sha256 = (data: string | Buffer) =>
      createHash("sha256").update(data).digest("hex");
    writeFileSync(
      path.join(bundle, "manifest.json"),
      JSON.stringify({
        target: "darwin-arm64",
        sourceCommit: "a".repeat(40),
        sourceArchiveSha256: archive.sha256,
        layout: "directory",
        directory: { file: "runtime/files.json", sha256: sha256(files) },
        node: {
          version: NODE_RUNTIME_VERSION,
          file: "node/bin/node",
          sha256: sha256(readFileSync(process.execPath)),
        },
      }),
    );
    await new LocalServerModule({
      home: f.home,
      installerDirectory: installer,
      platform: "darwin",
      arch: "arm64",
      sourceArchive: { file: "source/linger.tar.gz", sha256: archive.sha256 },
      signIn: f.signIn,
    })
      .begin()
      .catch(() => undefined);
    expect(realpathSync(path.join(node(f.home), "bin", "node"))).toBe(
      realpathSync(process.execPath),
    );
    const args = installerArgs(f.home);
    const offline = path.join(
      args[args.indexOf("--source-repo") + 1]!,
      ".simplexai-runtime/offline",
    );
    expect(readFileSync(path.join(offline, "files.json"), "utf8")).toBe(files);
    expect(existsSync(path.join(offline, "web", "static-host.mjs"))).toBe(true);
    expect(existsSync(`${offline}.partial`)).toBe(false);
  });

  it("checks once whether this computer can serve a local model", async () => {
    const info = vi.spyOn(silentLog, "info");
    const f = fixture({ checkout: "/src" });
    // The app's own Node runs the check; the Node runtime is not needed.
    rmSync(path.join(f.home, "desktop", "node"), {
      recursive: true,
      force: true,
    });
    await f.host.start();
    expect(f.module.status().localModels).toEqual({ state: "unchecked" });
    f.module.inspect();
    expect(f.module.status().localModels).toEqual({ state: "checking" });
    f.module.inspect();
    await vi.waitFor(() =>
      expect(f.module.status().localModels).toEqual({
        state: "checked",
        eligible: true,
        memoryBytes: 64 * 1024 ** 3,
        diskFreeBytes: 200 * 1024 ** 3,
        gpu: "RTX 4090",
        model: {
          name: "qwen3-8b",
          downloadBytes: 6 * 1024 ** 3,
          diskBytes: 8 * 1024 ** 3,
          memoryBytes: 12 * 1024 ** 3,
        },
      }),
    );
    expect(installerArgs(f.home)).toEqual(["--home", f.home, "--inspect"]);
    // How long the check took, as the installer reported it.
    expect(info).toHaveBeenCalledWith("local_server.inspect_log", {
      line: "Checked this computer in 1.5s.",
    });
    info.mockRestore();
  });

  it("reports a computer too small for a local model", async () => {
    const info = vi.spyOn(silentLog, "info");
    const f = fixture({ checkout: "/src" }, {}, (home) => {
      mkdirSync(home, { recursive: true });
      writeFileSync(path.join(home, "small-computer"), "");
    });
    await f.host.start();
    f.module.inspect();
    await vi.waitFor(() =>
      expect(f.module.status().localModels).toMatchObject({
        state: "checked",
        eligible: false,
        reasons: ["facts-unavailable: nvidia-smi was not found"],
      }),
    );
    expect(f.module.status().localModels).not.toHaveProperty("model");
    // The log says why, as the localmodels tool did.
    expect(info).toHaveBeenCalledWith(
      "local_server.inspected",
      expect.objectContaining({
        eligible: false,
        reasons: ["facts-unavailable: nvidia-smi was not found"],
      }),
    );
    info.mockRestore();
  });

  it("approves the deployment of the chosen local model", async () => {
    const f = fixture(
      withCheckout,
      {},
      checkout,
      installerApi([], {
        state: "waiting_user",
        errorCode: "LOCAL_MODELS_APPROVAL_REQUIRED",
        localModelsPlan: { planId: "a".repeat(64) },
      }),
    );
    await f.host.start();
    await f.module.begin({ runtime: "local" });
    expect(f.api.created).toEqual([
      expect.objectContaining({
        setupChoice: "local-models",
      }),
    ]);
    expect(f.api.retried).toEqual([{ localModelsApproval: "a".repeat(64) }]);
    expect(f.module.status().phase).toBe("ready");
    await f.host.stop("quit");
  });

  it("asks for a new local model plan after a stopped deployment", async () => {
    const f = fixture(
      withCheckout,
      {},
      checkout,
      installerApi([], {
        state: "waiting_user",
        errorCode: "LOCAL_MODELS_RECOVERY_REQUIRED",
      }),
    );
    await f.host.start();
    await f.module.begin({ runtime: "local" });
    expect(f.api.retried).toEqual([{ localModelsReplan: true }]);
    expect(f.module.status().phase).toBe("ready");
    await f.host.stop("quit");
  });

  it("approves no local model the person did not choose", async () => {
    const f = fixture(
      withCheckout,
      {},
      checkout,
      installerApi([], {
        state: "waiting_user",
        errorCode: "LOCAL_MODELS_APPROVAL_REQUIRED",
        localModelsPlan: { planId: "a".repeat(64) },
      }),
    );
    await f.host.start();
    await expect(f.module.begin({ runtime: "pi" })).rejects.toThrow(
      "can't run the local model",
    );
    expect(f.api.retried).toEqual([]);
    expect(f.module.status().phase).toBe("failed");
    await f.host.stop("quit");
  });

  it("installs LINGER_CHECKOUT only when it is a Linger source", async () => {
    const f = fixture(withCheckout, {}, (home) =>
      mkdirSync(path.join(home, "src"), { recursive: true }),
    );
    await f.host.start();
    await expect(f.module.begin()).rejects.toThrow(/not a Linger checkout/);
    checkout(f.home);
    await f.module.begin({ runtime: "claude" });
    const args = installerArgs(f.home);
    expect(args[args.indexOf("--source-repo") + 1]).toBe(
      realpathSync(path.join(f.home, "src")),
    );
    expect(f.api.created).toEqual([
      expect.objectContaining({
        setupChoice: "claude",
      }),
    ]);
    expect(f.module.status()).toMatchObject({
      phase: "ready",
    });
    // A checkout downloads nothing.
    expect(f.module.status().steps).not.toContain("download");
    await f.host.stop("quit");
  });

  it("shows no download step when nothing is downloaded", async () => {
    const f = fixture(withCheckout, {}, checkout);
    await f.host.start();
    const seen: { step: string; progress: number }[] = [];
    f.host.ctx.bus.on("local-server.changed", () => {
      const { step, progress } = f.module.status();
      seen.push({ step, progress });
    });
    await f.module.begin();
    expect(f.module.status().steps).toEqual([
      "prepare",
      "services",
      "workspace",
      "connect",
      "agents",
    ]);
    expect(seen.map(({ step }) => step)).not.toContain("download");
    // The installer's download stages finish preparing, within its share.
    expect(
      seen.filter(({ step }) => step === "prepare").at(-1)!.progress,
    ).toBeLessThanOrEqual(1 / 5);
    const progress = seen.map(({ progress }) => progress);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    await f.host.stop("quit");
  });

  it("falls back to Codex when the installer cannot inspect this computer", async () => {
    const f = fixture(
      withCheckout,
      {},
      checkout,
      installerApi(
        [],
        undefined,
        Response.json({ message: "invalid" }, { status: 400 }),
      ),
    );
    await f.host.start();
    await f.module.begin();
    expect(f.api.created).toEqual([
      expect.objectContaining({ setupChoice: "codex" }),
    ]);
    expect(f.module.status().phase).toBe("ready");
    await f.host.stop("quit");
  });

  it("moves the bar while native services come up", async () => {
    const f = fixture(
      withCheckout,
      {},
      checkout,
      installerApi([], undefined, undefined, {
        state: "running",
        stage: "services",
        message: "Waiting for native compilation and readiness (2/4 ready).",
        stages: [{ id: "services", state: "running" }],
      }),
    );
    await f.host.start();
    const seen: number[] = [];
    f.host.ctx.bus.on("local-server.changed", () =>
      seen.push(f.module.status().progress),
    );
    await f.module.begin();
    // Services are the second of five steps without a download; half ready
    // is 1/5 + 0.625/5.
    expect(seen).toContain(0.325);
    await f.host.stop("quit");
  });

  it("never steps back while the runtime prepares beside the checkout", async () => {
    const f = fixture(
      withCheckout,
      {},
      checkout,
      installerApi([], undefined, undefined, [
        {
          state: "running",
          stage: "runtime",
          stages: [{ id: "runtime", state: "running" }],
        },
        { state: "running", stage: "images" },
      ]),
    );
    await f.host.start();
    const steps: string[] = [];
    f.host.ctx.bus.on("local-server.changed", () =>
      steps.push(f.module.status().step),
    );
    await f.module.begin();
    // The runtime reports from its own task while dependencies install.
    expect(steps).toContain("services");
    expect(steps.slice(steps.indexOf("services"))).not.toContain("prepare");
    await f.host.stop("quit");
  });

  it("follows the installation already running", async () => {
    const f = fixture(
      withCheckout,
      {},
      checkout,
      installerApi([
        {
          id: "other",
          instance: "default",
          state: "running",
          createdAt: "2026-11-04T00:00:00Z",
          stages: [],
        },
        {
          id: "job",
          instance: LOCAL_INSTANCE,
          state: "running",
          createdAt: "2026-11-03T00:00:00Z",
          stages: [],
        },
      ]),
    );
    await f.host.start();
    await f.module.begin();
    expect(f.api.created).toEqual([]);
    expect(f.module.status().phase).toBe("ready");
    await f.host.stop("quit");
  });

  it("installs again when a finished installation's data is gone", async () => {
    const f = fixture(
      withCheckout,
      {},
      checkout,
      installerApi(
        [
          {
            id: "old",
            instance: LOCAL_INSTANCE,
            state: "succeeded",
            origin: "http://localhost:3000",
            createdAt: "2026-11-03T00:00:00Z",
            stages: [],
          },
        ],
        DONE,
        undefined,
        undefined,
        false,
      ),
    );
    await f.host.start();
    await f.module.begin();
    expect(f.api.created).toHaveLength(1);
    expect(f.module.status().phase).toBe("ready");
    await f.host.stop("quit");
  });

  it("saves provider keys in user.env before the installation runs again with them", async () => {
    const finishedJob = {
      id: "old",
      instance: LOCAL_INSTANCE,
      state: "succeeded",
      origin: "http://localhost:3000",
      createdAt: "2026-11-03T00:00:00Z",
      stages: [],
    };
    const f = fixture(withCheckout, {}, checkout, installerApi([finishedJob]));
    await f.host.start();
    expect(f.module.status().keys).toEqual({
      composio: false,
      soniox: false,
      xai: false,
    });
    const info = vi.spyOn(silentLog, "info");
    const warn = vi.spyOn(silentLog, "warn");
    await f.module.begin({
      runtime: "claude",
      keys: { composio: "composio-1", soniox: "soniox-1", xai: "xai-1" },
    });
    // The keys go over stdin, never in the arguments.
    const keysArgs = readFileSync(path.join(f.home, "keys-args.json"), "utf8");
    expect(JSON.parse(keysArgs)).toEqual([
      "--home",
      f.home,
      "--instance",
      LOCAL_INSTANCE,
      "--user-keys",
    ]);
    expect(
      readFileSync(
        path.join(f.home, "instances", LOCAL_INSTANCE, "user.env"),
        "utf8",
      ),
    ).toBe(
      "COMPOSIO_API_KEY=composio-1\nSONIOX_API_KEY=soniox-1\nXAI_API_KEY=xai-1\n",
    );
    expect(f.module.status().keys).toEqual({
      composio: true,
      soniox: true,
      xai: true,
    });
    // The finished installation does not carry them, so a new one runs.
    expect(f.api.created).toHaveLength(1);
    expect(f.module.status().phase).toBe("ready");
    expect(info).toHaveBeenCalledWith("local_server.keys_saved", {
      saved: ["COMPOSIO_API_KEY", "SONIOX_API_KEY", "XAI_API_KEY"],
    });
    const logged = JSON.stringify([info.mock.calls, warn.mock.calls]);
    expect(logged).not.toContain("composio-1");
    expect(logged).not.toContain("soniox-1");
    expect(logged).not.toContain("xai-1");
    info.mockRestore();
    warn.mockRestore();
    await f.host.stop("quit");

    // Removing one key keeps the other; without changes the finished
    // installation is followed as before.
    const again = fixture(
      withCheckout,
      {},
      (home) => {
        checkout(home);
        mkdirSync(path.join(home, "instances", LOCAL_INSTANCE), {
          recursive: true,
        });
        writeFileSync(
          path.join(home, "instances", LOCAL_INSTANCE, "user.env"),
          "SONIOX_API_KEY=soniox-1\nXAI_API_KEY=xai-1\n",
        );
      },
      installerApi([finishedJob]),
    );
    await again.host.start();
    await again.module.begin({
      runtime: "claude",
      keys: { xai: "" },
    });
    expect(again.module.status().keys).toEqual({
      composio: false,
      soniox: true,
      xai: false,
    });
    await again.host.stop("quit");
    const plain = fixture(
      withCheckout,
      {},
      checkout,
      installerApi([finishedJob]),
    );
    await plain.host.start();
    await plain.module.begin({ runtime: "claude" });
    expect(existsSync(path.join(plain.home, "keys-args.json"))).toBe(false);
    expect(plain.api.created).toEqual([]);
    await plain.host.stop("quit");
  });

  it("stops before installing when the keys cannot be saved", async () => {
    const f = fixture(withCheckout, {}, checkout);
    await f.host.start();
    await expect(
      f.module.begin({
        runtime: "claude",
        keys: { xai: "bad" },
      }),
    ).rejects.toThrow(
      "Keys could not be saved: XAI_API_KEY is not a valid key",
    );
    expect(existsSync(path.join(f.home, "installer", "args.json"))).toBe(false);
    expect(f.module.status().phase).toBe("failed");
    await f.host.stop("quit");
  });

  it("reports a failed installation", async () => {
    const f = fixture(
      withCheckout,
      {},
      checkout,
      installerApi([], { state: "failed", message: "Port 3000 is in use" }),
    );
    await f.host.start();
    await expect(f.module.begin()).rejects.toThrow("Port 3000 is in use");
    expect(f.module.status()).toMatchObject({
      phase: "failed",
      message: "Port 3000 is in use",
    });
    expect(f.signIn).not.toHaveBeenCalled();
    await f.host.stop("quit");
  });
});

describe("LocalServerModule install location", () => {
  it("installs into the folder picked on the setup page", async () => {
    const archive = sourceArchive(tempDirectory());
    const file = path.join(tempDirectory(), "linger.tar.gz");
    writeFileSync(file, archive.bytes);
    const f = fixture({ sourceArchive: { file, sha256: archive.sha256 } });
    await f.host.start();
    expect(f.module.status().location).toEqual({
      path: f.home,
      custom: false,
    });
    const picked = path.join(f.root, "Data");
    mkdirSync(picked);
    writeFileSync(path.join(picked, "notes.txt"), "");
    await f.module.chooseLocation(picked);
    const home = path.join(picked, "Simplex");
    expect(f.module.status().location).toEqual({ path: home, custom: true });

    await f.module.begin();
    const args = installerArgs(home);
    expect(args[args.indexOf("--home") + 1]).toBe(home);
    expect(
      args[args.indexOf("--source-repo") + 1]!.startsWith(
        path.join(home, "desktop", "source"),
      ),
    ).toBe(true);
    // The desktop's record stays in the default home and points there.
    expect(
      JSON.parse(
        readFileSync(path.join(f.home, "desktop", "local-server.json"), "utf8"),
      ),
    ).toMatchObject({ home });
    expect(existsSync(path.join(f.home, "installer"))).toBe(false);
    expect(f.module.status().location).toEqual({ path: home, custom: false });
    await f.host.stop("quit");
  });

  it("keeps the default when the picked folder cannot be used", async () => {
    const f = fixture({ checkout: "/src" });
    await f.host.start();
    await f.module.chooseLocation(path.join(f.root, "missing", "deeper"));
    // A folder that does not exist yet is made in the nearest one that does.
    expect(f.module.status().location).toEqual({
      path: path.join(f.root, "missing", "deeper"),
      custom: true,
    });
    await f.module.chooseLocation(null);
    expect(f.module.status().location).toEqual({
      path: f.home,
      custom: false,
    });
    if (process.getuid?.() === 0) return;
    const locked = path.join(f.root, "locked");
    mkdirSync(locked, { mode: 0o500 });
    await f.module.chooseLocation(locked);
    expect(f.module.status().location).toEqual({
      path: f.home,
      custom: false,
      error: "Linger can't write to this folder. Choose another one.",
    });
    chmodSync(locked, 0o700);
    await f.host.stop("quit");
  });

  it("installs into an empty folder or one that holds Simplex", async () => {
    const root = tempDirectory();
    expect(await installLocation(root)).toBe(root);
    writeFileSync(path.join(root, ".DS_Store"), "");
    expect(await installLocation(root)).toBe(root);
    mkdirSync(path.join(root, "instances"));
    writeFileSync(path.join(root, "notes.txt"), "");
    expect(await installLocation(root)).toBe(root);
    const other = tempDirectory();
    writeFileSync(path.join(other, "notes.txt"), "");
    expect(await installLocation(other)).toBe(path.join(other, "Simplex"));
  });

  it("asks for free space on the folder's disk", async () => {
    const root = tempDirectory();
    expect(await checkLocation(root, 1)).toBeUndefined();
    expect(await checkLocation(root, Number.MAX_SAFE_INTEGER)).toMatch(
      /^Needs \d+ GB free; this disk has \d+ GB\.$/,
    );
    expect(await checkLocation("relative", 1)).toBe(
      "Choose a folder on this computer.",
    );
  });
});

describe("LocalServerModule after a restart", () => {
  const record = (home: string) => {
    mkdirSync(path.join(home, "desktop"), { recursive: true });
    writeFileSync(
      path.join(home, "desktop", "local-server.json"),
      JSON.stringify({ repo: "/source", origin: "http://localhost:3000" }),
    );
  };

  it("starts the installed services again for the local server", async () => {
    const f = fixture({}, { serverUrl: "http://localhost:3000" }, record);
    await f.host.start();
    await vi.waitFor(() => expect(f.module.status().phase).toBe("ready"));
    expect(f.setServer).toHaveBeenCalledWith("http://localhost:3000");
    // The services were down, so the window waited on the starting page.
    expect(f.showStarting).toHaveBeenCalledOnce();
    expect(f.showStartFailed).not.toHaveBeenCalled();
    const args = JSON.parse(
      readFileSync(path.join(f.home, "installer", "args.json"), "utf8"),
    ) as string[];
    expect(args).toEqual(
      expect.arrayContaining(["--resume", "--source-repo", "/source"]),
    );
    expect(args[args.indexOf("--instance") + 1]).toBe(LOCAL_INSTANCE);
    expect(f.signIn).not.toHaveBeenCalled();
    await f.host.stop("quit");
  });

  it("moves the keys of the unpacked source's .env into the instance's user.env once", async () => {
    const f = fixture({}, { serverUrl: "http://localhost:3000" }, (home) => {
      const source = path.join(home, "desktop", "source", "previous");
      mkdirSync(source, { recursive: true });
      writeFileSync(
        path.join(source, ".env"),
        "SONIOX_API_KEY=soniox\nTEAMHUB_SECRET_ENCRYPTION_KEY=other\n",
      );
      writeFileSync(
        path.join(home, "desktop", "local-server.json"),
        JSON.stringify({ home, repo: source, origin: "http://localhost:3000" }),
      );
    });
    await f.host.start();
    await vi.waitFor(() => expect(f.module.status().phase).toBe("ready"));
    const source = path.join(f.home, "desktop", "source", "previous");
    expect(existsSync(path.join(source, ".env"))).toBe(false);
    const user = readFileSync(
      path.join(f.home, "instances", LOCAL_INSTANCE, "user.env"),
      "utf8",
    );
    expect(user).toContain("SONIOX_API_KEY='soniox'");
    expect(user).not.toContain("TEAMHUB_SECRET_ENCRYPTION_KEY");
    await f.host.stop("quit");
  });

  it("leaves a developer checkout's .env alone", async () => {
    const f = fixture(
      withCheckout,
      { serverUrl: "http://localhost:3000" },
      (home) => {
        checkout(home);
        writeFileSync(path.join(home, "src", ".env"), "XAI_API_KEY=xai\n");
        mkdirSync(path.join(home, "desktop", "source", "src"), {
          recursive: true,
        });
        writeFileSync(
          path.join(home, "desktop", "source", "src", ".env"),
          "XAI_API_KEY=xai\n",
        );
        writeFileSync(
          path.join(home, "desktop", "local-server.json"),
          JSON.stringify({
            home,
            repo: path.join(home, "src"),
            origin: "http://localhost:3000",
          }),
        );
      },
    );
    await f.host.start();
    await vi.waitFor(() => expect(f.module.status().phase).toBe("ready"));
    expect(existsSync(path.join(f.home, "src", ".env"))).toBe(true);
    expect(
      existsSync(path.join(f.home, "instances", LOCAL_INSTANCE, "user.env")),
    ).toBe(false);
    await f.host.stop("quit");
  });

  it("starts the services again in the folder they were installed in", async () => {
    const elsewhere = path.join(tempDirectory(), "Simplex");
    const f = fixture({}, { serverUrl: "http://localhost:3000" }, (home) => {
      mkdirSync(path.join(home, "desktop"), { recursive: true });
      writeFileSync(
        path.join(home, "desktop", "local-server.json"),
        JSON.stringify({
          home: elsewhere,
          repo: "/source",
          origin: "http://localhost:3000",
        }),
      );
    });
    await f.host.start();
    await vi.waitFor(() => expect(f.module.status().phase).toBe("ready"));
    const args = installerArgs(elsewhere);
    expect(args[args.indexOf("--home") + 1]).toBe(elsewhere);
    expect(args).toContain("--resume");
    expect(f.module.status().location).toEqual({
      path: elsewhere,
      custom: false,
    });
    await f.host.stop("quit");
  });

  it("moves the services to the source package of an updated app when asked", async () => {
    const root = tempDirectory();
    const archive = sourceArchive(root);
    const f = fixture(
      {
        sourceArchive: {
          url: "https://cdn.example/linger.tar.gz",
          sha256: archive.sha256,
        },
        fetch: (async () => new Response(archive.bytes)) as typeof fetch,
      },
      { serverUrl: "http://localhost:3000" },
      (home) => {
        const sources = path.join(home, "desktop", "source");
        mkdirSync(path.join(sources, "previous"), { recursive: true });
        writeFileSync(
          path.join(home, "desktop", "local-server.json"),
          JSON.stringify({
            home,
            repo: path.join(sources, "previous"),
            origin: "http://localhost:3000",
          }),
        );
      },
    );
    await f.host.start();
    await vi.waitFor(() => expect(f.module.status().phase).toBe("ready"));
    const sources = path.join(f.home, "desktop", "source");
    const previous = path.join(sources, "previous");
    const current = path.join(sources, archive.sha256.slice(0, 16));
    const before = installerArgs(f.home);
    expect(before[before.indexOf("--source-repo") + 1]).toBe(previous);
    expect(f.module.sourceUpdateAvailable()).toBe(true);
    await f.module.updateSource();
    expect(f.showUpdating).toHaveBeenCalledOnce();
    expect(f.loadServer).toHaveBeenCalledOnce();
    expect(f.module.sourceUpdateAvailable()).toBe(false);
    expect(f.module.status().phase).toBe("ready");
    const args = installerArgs(f.home);
    expect(args[args.indexOf("--source-repo") + 1]).toBe(current);
    expect(
      JSON.parse(
        readFileSync(path.join(f.home, "desktop", "local-server.json"), "utf8"),
      ),
    ).toMatchObject({ repo: current });
    expect(readdirSync(sources)).toEqual([path.basename(current)]);
    await f.host.stop("quit");
  });

  it("reports a failed restart", async () => {
    const f = fixture({}, { serverUrl: "http://localhost:3000" }, (home) => {
      record(home);
      writeFileSync(path.join(home, "resume-fails"), "");
    });
    await f.host.start();
    await vi.waitFor(() => expect(f.module.status().phase).toBe("failed"));
    expect(f.module.status().message).toBe("Native teamhub stopped");
    expect(f.setServer).not.toHaveBeenCalled();
    expect(f.showStartFailed).toHaveBeenCalledWith("Native teamhub stopped");
    await f.host.stop("quit");
  });

  it("starts the services again when the person tries again", async () => {
    const f = fixture({}, { serverUrl: "http://localhost:3000" }, (home) => {
      record(home);
      writeFileSync(path.join(home, "resume-fails"), "");
    });
    await f.host.start();
    await vi.waitFor(() => expect(f.module.status().phase).toBe("failed"));
    rmSync(path.join(f.home, "resume-fails"));
    f.bus.emit("local-server.retry");
    await vi.waitFor(() => expect(f.module.status().phase).toBe("ready"));
    expect(f.setServer).toHaveBeenCalledWith("http://localhost:3000");
    await f.host.stop("quit");
  });

  it("keeps the window on the server when the services still run", async () => {
    const f = fixture(
      {
        fetch: (async () =>
          new Response(null, { status: 200 })) as typeof fetch,
      },
      { serverUrl: "http://localhost:3000" },
      record,
    );
    await f.host.start();
    await vi.waitFor(() => expect(f.module.status().phase).toBe("ready"));
    expect(f.showStarting).not.toHaveBeenCalled();
    await f.host.stop("quit");
  });

  it("leaves the services alone when the window uses another server", async () => {
    const f = fixture({}, { serverUrl: "https://linger.example" }, record);
    await f.host.start();
    expect(f.module.status().phase).toBe("idle");
    expect(existsSync(path.join(f.home, "installer", "args.json"))).toBe(false);
    await f.host.stop("quit");
  });
});

describe("followHttps", () => {
  it("refuses a redirect away from HTTPS", async () => {
    const fetcher = followHttps(
      (async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://example.com/x" },
        })) as typeof fetch,
    );
    await expect(fetcher("https://example.com/a")).rejects.toThrow(/HTTPS/);
  });
});

describe("signInWithPassword", () => {
  it("hands the session cookies of the local server to the app", async () => {
    const set = vi.fn(async () => {});
    const fetcher = vi.fn(
      async () =>
        new Response("{}", {
          headers: {
            "set-cookie":
              "linger_session=v; Path=/; HttpOnly; SameSite=Lax; Max-Age=60",
          },
        }),
    );
    await signInWithPassword(
      "http://localhost:3000",
      "owner@linger.local",
      "pw",
      set,
      fetcher as typeof fetch,
    );
    expect(String((fetcher.mock.calls[0] as unknown[])[0])).toBe(
      "http://localhost:3000/v0/auth/login",
    );
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "linger_session",
        value: "v",
        path: "/",
        httpOnly: true,
        sameSite: "lax",
      }),
    );
  });

  it("fails without a session", async () => {
    await expect(
      signInWithPassword(
        "http://localhost:3000",
        "a",
        "b",
        async () => {},
        (async () => new Response("{}", { status: 401 })) as typeof fetch,
      ),
    ).rejects.toThrow(/401/);
  });
});

describe("parseSetCookie", () => {
  it("ignores a header without a name", () => {
    expect(parseSetCookie("=x")).toBeUndefined();
    expect(parseSetCookie("a=b=c; Secure")).toMatchObject({
      name: "a",
      value: "b=c",
      secure: true,
    });
  });
});

describe("anotherMeMissing", () => {
  const online = {
    computer_id: "cmp_1",
    status: "online",
    workspace_grants: [{ mode: "workspace-write" }],
  };

  it("says how long it waited and what the server needs", () => {
    const [waited] = anotherMeMissing(undefined, 300_000).split("\n");
    expect(waited).toBe(
      "Your Another Me was not created after 5 minutes. The server creates it once this computer is connected with a signed-in AI runtime (Codex, Claude Code or Pi).",
    );
  });

  it.each([
    [null, "could not read this computer's status"],
    [undefined, "does not list this computer"],
    [{ ...online, status: "offline" }, "computer-daemon.log"],
    [{ ...online, upgrade_required: true }, "Update Linger"],
    [{ ...online, workspace_grants: [{ mode: "read-only" }] }, "no folder"],
    [
      {
        ...online,
        runtimes: [{ type: "codex", status: "ready", models: [{}] }],
      },
      "another_me.create_failed",
    ],
    [
      { ...online, runtimes: [{ type: "pi", status: "ready", models: [] }] },
      "Pi: signed in but reports no models",
    ],
    [
      {
        ...online,
        runtimes: [
          { type: "codex", status: "error", message: "node.exe not found" },
        ],
      },
      "Codex: check failed (node.exe not found)",
    ],
    [{ ...online, runtimes: [] }, "codex login"],
  ])("names the reason for %j", (computer, reason) => {
    expect(anotherMeMissing(computer, 60_000).split("\n")[1]).toContain(reason);
  });
});

describe("LocalServerModule on Windows", () => {
  const locked = () =>
    Object.assign(new Error("EPERM: operation not permitted, rename"), {
      code: "EPERM",
    });
  // Windows' Node runtime is node.exe at the top of its folder.
  const windowsNode = (home: string) =>
    symlinkSync(
      process.execPath,
      path.join(
        home,
        "desktop",
        "node",
        `v${NODE_RUNTIME_VERSION}`,
        "node.exe",
      ),
    );

  it("waits out files held right after unpacking the source", async () => {
    const archive = sourceArchive(tempDirectory());
    const file = path.join(tempDirectory(), "linger.tar.gz");
    writeFileSync(file, archive.bytes);
    const moves: string[] = [];
    const f = fixture(
      {
        platform: "win32",
        sourceArchive: { file, sha256: archive.sha256 },
        rename: async (from, to) => {
          moves.push(path.basename(to));
          if (moves.length <= 2) throw locked();
          await rename(from, to);
        },
      },
      {},
      windowsNode,
    );
    await f.host.start();
    await f.module.begin();
    const hash = archive.sha256.slice(0, 16);
    expect(moves).toEqual([hash, hash, hash]);
    expect(readdirSync(path.join(f.home, "desktop", "source"))).toEqual([hash]);
    expect(f.module.status().phase).toBe("ready");
    await f.host.stop("quit");
  });

  it("replaces a half-done source folder and unpacks under a non-ASCII folder", async () => {
    const archive = sourceArchive(tempDirectory());
    const file = path.join(tempDirectory(), "linger.tar.gz");
    writeFileSync(file, archive.bytes);
    const f = fixture({ sourceArchive: { file, sha256: archive.sha256 } });
    await f.host.start();
    const picked = path.join(f.root, "\u65b0\u5efa\u6587\u4ef6\u5939");
    mkdirSync(picked);
    await f.module.chooseLocation(picked);
    expect(f.module.status().location).toEqual({ path: picked, custom: true });
    const hash = archive.sha256.slice(0, 16);
    const source = path.join(picked, "desktop", "source");
    // A run that stopped half-way left the folder without its marker.
    mkdirSync(path.join(source, hash), { recursive: true });
    writeFileSync(path.join(source, hash, "half"), "");
    await f.module.begin();
    expect(readdirSync(path.join(source, hash)).sort()).toEqual(["scripts"]);
    expect(f.module.status().phase).toBe("ready");
    await f.host.stop("quit");
  });

  it("reports a move that fails for good and leaves nothing half-done", async () => {
    const archive = sourceArchive(tempDirectory());
    const file = path.join(tempDirectory(), "linger.tar.gz");
    writeFileSync(file, archive.bytes);
    let moves = 0;
    const f = fixture(
      {
        platform: "win32",
        sourceArchive: { file, sha256: archive.sha256 },
        rename: async () => {
          moves++;
          throw Object.assign(new Error("EXDEV: cross-device link"), {
            code: "EXDEV",
          });
        },
      },
      {},
      windowsNode,
    );
    await f.host.start();
    await expect(f.module.begin()).rejects.toThrow("EXDEV: cross-device link");
    expect(moves).toBe(1);
    expect(f.module.status()).toMatchObject({ phase: "failed" });
    expect(readdirSync(path.join(f.home, "desktop", "source"))).toEqual([]);
    await f.host.stop("quit");
  });
});

describe("LocalServerModule owner account", () => {
  const ORIGIN = "http://localhost:3000";
  const installed =
    (account?: Record<string, unknown>, mode = 0o600) =>
    (home: string) => {
      mkdirSync(path.join(home, "desktop"), { recursive: true });
      writeFileSync(
        path.join(home, "desktop", "local-server.json"),
        JSON.stringify({ home, repo: "/source", origin: ORIGIN }),
      );
      if (!account) return;
      const directory = path.join(home, "instances", LOCAL_INSTANCE);
      mkdirSync(directory, { recursive: true });
      const file = path.join(directory, "local-account.json");
      writeFileSync(file, JSON.stringify(account));
      chmodSync(file, mode);
    };
  const OWNER = {
    email: "owner@linger.local",
    password: "a-private-password",
    provisioned: true,
  };

  it("signs the window in to the installed server with the account file", async () => {
    const f = fixture({}, { serverUrl: ORIGIN }, installed(OWNER));
    await f.host.start();
    await vi.waitFor(() => expect(f.module.status().phase).toBe("ready"));
    expect(await f.module.servesWindow()).toBe(true);
    expect(await f.module.account()).toEqual({
      email: OWNER.email,
      password: OWNER.password,
      file: path.join(
        f.home,
        "instances",
        LOCAL_INSTANCE,
        "local-account.json",
      ),
    });
    await f.module.signInWithAccount();
    expect(f.signIn).toHaveBeenCalledWith(ORIGIN, OWNER.email, OWNER.password);
    await f.host.stop("quit");
  });

  it("does not offer the account to another server", async () => {
    const f = fixture(
      {},
      { serverUrl: "https://team.example.com" },
      installed(OWNER),
    );
    await f.host.start();
    expect(await f.module.servesWindow()).toBe(false);
    await expect(f.module.signInWithAccount()).rejects.toThrow(
      "This window is not showing the Linger on this computer.",
    );
    expect(f.signIn).not.toHaveBeenCalled();
    await f.host.stop("quit");
  });

  it("does not offer it before Linger is installed here", async () => {
    const f = fixture({}, { serverUrl: ORIGIN });
    await f.host.start();
    expect(await f.module.servesWindow()).toBe(false);
    await expect(f.module.account()).rejects.toThrow(
      "Linger is not installed on this computer.",
    );
    await f.host.stop("quit");
  });

  it.each([
    [
      "missing",
      installed(),
      /^The account file of Linger on this computer is missing \(.*local-account\.json\)\.$/,
    ],
    [
      "readable by others",
      installed(OWNER, 0o644),
      "The local account file must be private and owned by the current user (chmod 600).",
    ],
    [
      "not provisioned",
      installed({ ...OWNER, provisioned: false }),
      "The local account file is invalid or the account has not been created.",
    ],
  ])(
    "says why a %s account file cannot sign in",
    async (_case, prepare, message) => {
      const f = fixture({}, { serverUrl: ORIGIN }, prepare);
      await f.host.start();
      await vi.waitFor(() => expect(f.module.status().phase).toBe("ready"));
      const failure = f.module.signInWithAccount();
      await expect(failure).rejects.toThrow(message);
      await expect(failure).rejects.not.toThrow(OWNER.password);
      expect(f.signIn).not.toHaveBeenCalled();
      await f.host.stop("quit");
    },
  );
});
