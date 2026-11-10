#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { replaceProcess } from "./replace-process.mjs";
import { localEnvironment } from "./with-local-env.mjs";

// Workspace projects whose code the native services run; pnpm adds their
// workspace dependencies and the root project. Nothing else is installed.
export const NATIVE_SERVICE_PROJECTS = Object.freeze([
  "@linger/node-services",
  "@linger/web",
]);
// Only a checkout that builds its own Computer release needs these.
export const NATIVE_COMPUTER_PROJECTS = Object.freeze([
  "@linger/computer",
  "@linger/teamhub-cli",
]);
// A dependency bundle published with the source package unpacks here.
export const NATIVE_DEPENDENCY_STORE = ".linger-runtime/pnpm-store";

/**
 * Locked installs tolerate slow registries: long timeouts and retries per
 * tarball, and no per-package attestation requests (the lockfile integrity
 * still verifies every tarball). A bundled store makes the install offline.
 */
export function pnpmInstallArguments(projects, store) {
  return [
    "install",
    ...projects.flatMap((project) => ["--filter", `${project}...`]),
    "--frozen-lockfile",
    "--trust-lockfile",
    "--prefer-offline",
    "--reporter",
    "append-only",
    "--fetch-timeout",
    "1800000",
    "--fetch-retries",
    "5",
    "--fetch-retry-mintimeout",
    "10000",
    "--fetch-retry-maxtimeout",
    "120000",
    ...(store ? ["--store-dir", store] : []),
  ];
}

// Native TeamHub's build output, beside the checkout's other build products.
export function teamhubBinary(repo, platform = process.platform) {
  return path.join(
    repo,
    ".simplexai-runtime/teamhub",
    platform === "win32" ? "teamhub.exe" : "teamhub",
  );
}

// TeamHub commands a desktop build compiled from this source package for
// this computer (packages/local-installation/src/teamhub-binaries.ts), by
// name; undefined when there are none and the commands compile here.
export const PREBUILT_DIRECTORY = ".simplexai-runtime/prebuilt";
export function readPrebuilt(
  repo,
  target = `${process.platform}-${process.arch}`,
) {
  const directory = path.join(repo, PREBUILT_DIRECTORY);
  let manifest;
  try {
    manifest = JSON.parse(
      readFileSync(path.join(directory, "manifest.json"), "utf8"),
    );
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (manifest.target !== target) return;
  return Object.fromEntries(
    Object.entries(manifest.binaries).map(([name, binary]) => {
      if (!/^[\w-]+(?:\.exe)?$/.test(binary.file))
        throw new Error(`Invalid prebuilt TeamHub file ${binary.file}`);
      return [
        name,
        { file: path.join(directory, binary.file), sha256: binary.sha256 },
      ];
    }),
  );
}

// Refuses a prebuilt binary that changed since the installer checked it.
export function verifyPrebuilt(file, sha256) {
  const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (actual !== sha256)
    throw new Error(`${path.basename(file)} does not match its manifest`);
}

// The services a desktop build compiled from this source package
// (packages/local-installation/src/native-runtime.ts), which the installer
// verified; undefined when there are none and they run from source.
export const OFFLINE_DIRECTORY = ".simplexai-runtime/offline";
export function readOffline(
  repo,
  target = `${process.platform}-${process.arch}`,
) {
  const directory = path.join(repo, OFFLINE_DIRECTORY);
  let manifest;
  try {
    manifest = JSON.parse(
      readFileSync(path.join(directory, "files.json"), "utf8"),
    );
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  // A runtime of another layout came with another desktop.
  return manifest.schema === 1 && manifest.target === target
    ? directory
    : undefined;
}

export function planNativeCommand(
  operation,
  repo,
  tools = {},
  environment = {},
) {
  const node = tools.node ?? process.execPath;
  const pnpm = tools.pnpm ?? "pnpm";
  const go = tools.go ?? "go";
  const prebuilt = tools.prebuilt;
  const offline = tools.offline;
  // VCS stamping would run git, which on a Mac without Xcode Command Line
  // Tools opens Apple's installer instead.
  const env = { GOMAXPROCS: "2", GOFLAGS: "-p=2 -buildvcs=false" };
  const teamhub = path.join(repo, "apps/teamhub");
  const store = path.join(repo, NATIVE_DEPENDENCY_STORE);
  const install = (projects) => ({
    command: pnpm,
    args: pnpmInstallArguments(projects, existsSync(store) ? store : undefined),
    cwd: repo,
    env,
  });
  switch (operation) {
    case "prepare":
      return install(NATIVE_SERVICE_PROJECTS);
    case "prepare-computer":
      return install(NATIVE_COMPUTER_PROJECTS);
    case "migrate":
      return prebuilt?.migrate
        ? {
            command: prebuilt.migrate.file,
            args: [],
            cwd: teamhub,
            env,
            verify: prebuilt.migrate.sha256,
          }
        : { command: go, args: ["run", "./cmd/migrate"], cwd: teamhub, env };
    case "owner": {
      const args = [
        "create-owner",
        "--email",
        environment.OWNER_EMAIL?.trim() || "owner@linger.local",
        "--password-stdin",
      ];
      return prebuilt?.account
        ? {
            command: prebuilt.account.file,
            args,
            cwd: teamhub,
            env,
            verify: prebuilt.account.sha256,
          }
        : {
            command: go,
            args: ["run", "./cmd/account", ...args],
            cwd: teamhub,
            env,
          };
    }
    case "computer-release":
      return {
        command: node,
        args: [
          path.join(repo, "scripts/prepare-local-computer-release.mjs"),
          "--targets",
          `${process.platform}-${process.arch}`,
          "--output",
          environment.COMPUTER_RELEASE_DIR ||
            path.join(repo, ".linger-runtime/computer-release"),
        ],
        cwd: repo,
        env,
      };
    case "teamhub":
      if (prebuilt?.teamhub)
        return {
          command: prebuilt.teamhub.file,
          args: [],
          cwd: teamhub,
          env: { ...env, GIN_MODE: "release" },
          verify: prebuilt.teamhub.sha256,
        };
      // A user install never edits the source, so it builds once and runs the
      // binary instead of a watcher: no air download, no rebuild shell (on
      // Windows, PowerShell), and Windows gets the .exe it can run.
      return {
        command: go,
        args: ["build", "-o", teamhubBinary(repo), "./cmd/teamhub"],
        cwd: teamhub,
        env: { ...env, GIN_MODE: "release" },
        run: teamhubBinary(repo),
      };
    case "node-services":
      // The supervisor waits for TeamHub and restarts the service after a
      // crash, as in development, but runs it compiled. It runs in the
      // checkout, against which the bundle resolves relative settings such as
      // AGENT_HOME: the runtime folder is replaced with each release.
      if (offline)
        return {
          command: node,
          args: [
            "--conditions=linger-production",
            path.join(offline, "node-services/dist/supervisor.js"),
            "--compiled",
          ],
          cwd: repo,
          env,
        };
      return {
        command: pnpm,
        args: [
          "exec",
          "tsx",
          "watch",
          "--include",
          "apps/node-services/src/**/*",
          "--include",
          "packages/**/*.ts",
          "--include",
          "contracts/generated/typescript/src/**/*.ts",
          "apps/node-services/scripts/dev-supervisor.ts",
        ],
        cwd: repo,
        env,
      };
    case "web":
      // Web's production files behind its static host, which proxies the API
      // like the development server; it listens on HOST:PORT.
      if (offline)
        return {
          command: node,
          args: [path.join(offline, "web/static-host.mjs")],
          cwd: path.join(offline, "web"),
          env,
        };
      return {
        command: pnpm,
        args: ["--filter", "@linger/web", "dev"],
        cwd: repo,
        env,
      };
    default:
      throw new Error(`Unknown native source operation: ${operation}`);
  }
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  const repo = path.resolve(import.meta.dirname, "..");
  const [operation, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error("Expected source-native.mjs OPERATION");
  // The checkout's environment merges in this process, so the service is the
  // only process this one starts (Windows cannot replace a process; there a
  // launcher in between would stay resident beside each service).
  const base = localEnvironment(repo);
  const plan = planNativeCommand(
    operation,
    repo,
    { prebuilt: readPrebuilt(repo), offline: readOffline(repo) },
    base,
  );
  const env = { ...base, ...plan.env };
  if (plan.verify) verifyPrebuilt(plan.command, plan.verify);
  if (plan.run) {
    // The installer reads "failed to build" from this log to end startup
    // with the compiler's lines; it shows those after "building...".
    console.log("building...");
    mkdirSync(path.dirname(plan.run), { recursive: true });
    const build = spawnSync(plan.command, plan.args, {
      cwd: plan.cwd,
      env,
      stdio: "inherit",
      windowsHide: true,
    });
    if (build.status !== 0) {
      console.error(
        `failed to build, error: ${build.error?.message ?? `exit status ${build.status ?? build.signal}`}`,
      );
      process.exit(1);
    }
    replaceProcess(plan.run, [], env, plan.cwd);
  } else replaceProcess(plan.command, plan.args, env, plan.cwd);
}
