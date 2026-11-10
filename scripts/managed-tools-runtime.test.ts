import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createManagedToolsInstaller } from "./managed-tools-install.mjs";
import { prepareManagedToolsRuntime } from "./managed-tools-runtime.mjs";
import { stageManagedToolsRuntime } from "./managed-tools-runtime-files.mjs";
import {
  managedToolsFixture,
  writeManagedToolsReadOnlyGuard,
} from "./test-fixtures/managed-tools-fixture.mjs";

const execute = promisify(execFile);
const roots: string[] = [];
beforeEach(async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "managed-runtime-home-"));
  roots.push(home);
  vi.stubEnv("HOME", home);
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("executes managed absolute paths, installs on first call and repairs deletion without touching user CLIs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "runtime tools ' "));
  roots.push(root);
  const source = path.join(root, "releases");
  const toolsRoot = path.join(root, "tools");
  await managedToolsFixture(source, "first");
  const userBin = path.join(root, "user bin");
  await mkdir(userBin);
  const userCLI = path.join(userBin, "lev8");
  await writeFile(userCLI, "user-owned");
  const runtime = await prepareManagedToolsRuntime({
    HOME: root,
    LINGER_TOOLS_ROOT: toolsRoot,
    LINGER_CLI_RELEASES_BASE_URL: source,
    LINGER_CLI_RELEASE_ID: "first",
    LINGER_LEV8_VERSION: "0.6.0",
    PATH: userBin + path.delimiter + process.env.PATH,
  });
  expect(runtime!.binDirectory).toBe(path.join(toolsRoot, "current/bin"));
  const env = { HOME: path.join(root, "isolated home"), PATH: runtime!.path };
  const invoke = (tool: string) =>
    execute("/bin/sh", ["-c", `${tool} probe`], { env });
  for (const tool of ["teamhub", "lev8"]) {
    const installed = await invoke(tool);
    const current = (
      await createManagedToolsInstaller({ root: toolsRoot }).status()
    ).current!;
    expect(installed.stdout.trim().split("\n")).toEqual([
      path.join(current.directory, tool, tool),
      "0.6.0",
    ]);
    await rm(path.join(current.directory, tool, tool));
    const repaired = await invoke(tool);
    const next = (
      await createManagedToolsInstaller({ root: toolsRoot }).status()
    ).current!;
    expect(repaired.stdout.trim().split("\n")).toEqual([
      path.join(next.directory, tool, tool),
      "0.6.0",
    ]);
    await rm(path.join(toolsRoot, "current/bin", tool));
    const restoredLauncher = await invoke(tool);
    const restored = (
      await createManagedToolsInstaller({ root: toolsRoot }).status()
    ).current!;
    expect(restoredLauncher.stdout.trim().split("\n")).toEqual([
      path.join(restored.directory, tool, tool),
      "0.6.0",
    ]);
  }
  expect(await readFile(userCLI, "utf8")).toBe("user-owned");
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it("runs the shipped adapter without node_modules and rejects a version mismatch before activation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shipped tools "));
  roots.push(root);
  const cli = path.join(root, "cli");
  const source = path.join(root, "releases");
  const toolsRoot = path.join(root, "tools");
  await stageManagedToolsRuntime(cli);
  await managedToolsFixture(source, "first");
  const env = {
    ...process.env,
    HOME: root,
    LINGER_TOOLS_ROOT: toolsRoot,
    LINGER_CLI_RELEASES_BASE_URL: source,
    LINGER_CLI_RELEASE_ID: "first",
    LINGER_LEV8_VERSION: "0.6.0",
  };
  const prepared = await execute(
    process.execPath,
    [path.join(cli, "managed-tools-runtime.mjs"), "prepare"],
    { env },
  );
  const runtime = JSON.parse(prepared.stdout) as { path: string };
  expect(
    (
      await execute("/bin/sh", ["-c", "lev8 probe"], {
        env: { HOME: root, PATH: runtime.path },
      })
    ).stdout,
  ).toContain("\n0.6.0\n");
  await managedToolsFixture(source, "old", "0.5.0");
  await expect(
    execute(
      process.execPath,
      [path.join(cli, "managed-tools-runtime.mjs"), "update", "old"],
      { env },
    ),
  ).rejects.toMatchObject({ code: 1 });
  expect(
    (await createManagedToolsInstaller({ root: toolsRoot }).status()).current!
      .releaseId,
  ).toBe("first");
});

it("executes the installed current release with a read-only tool root after a live update", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "readonly tools "));
  roots.push(root);
  const source = path.join(root, "source");
  const toolsRoot = path.join(root, "tools");
  await managedToolsFixture(source, "first");
  await managedToolsFixture(source, "second", "0.6.0", "0.6.1");
  const runtime = (await prepareManagedToolsRuntime({
    LINGER_TOOLS_ROOT: toolsRoot,
    LINGER_CLI_RELEASES_BASE_URL: source,
    LINGER_CLI_RELEASE_ID: "first",
    PATH: process.env.PATH,
  }))!;
  const installer = createManagedToolsInstaller({
    root: toolsRoot,
    baseUrl: source,
  });
  await installer.ensure("first");
  const updated = (await installer.update("second")).current!;
  const guard = path.join(root, "readonly.mjs");
  await writeManagedToolsReadOnlyGuard(guard, toolsRoot);
  const env = {
    HOME: root,
    PATH: runtime.path,
    NODE_OPTIONS: `--import=${JSON.stringify(pathToFileURL(guard).href)}`,
  };
  for (const tool of ["teamhub", "lev8"] as const) {
    const result = await execute("/bin/sh", ["-c", `${tool} probe`], { env });
    expect(result.stdout.trim().split("\n")).toEqual([
      path.join(updated.directory, tool, tool),
      updated.versions[tool],
    ]);
  }
  // A broken installed tool must not bypass integrity checks in read-only mode.
  await writeFile(
    path.join(updated.directory, "teamhub/teamhub"),
    "#!/bin/sh\necho unchecked\n",
  );
  await expect(
    execute("/bin/sh", ["-c", "teamhub probe"], { env }),
  ).rejects.toMatchObject({
    code: 1,
    stdout: "",
  });
});

it("leaves legacy installations opt-in and rejects stable or incomplete configuration", async () => {
  expect(await prepareManagedToolsRuntime({ PATH: "/bin" })).toBeUndefined();
  await expect(
    prepareManagedToolsRuntime({ LINGER_CLI_RELEASE_ID: "stable" }),
  ).rejects.toThrow("fixed release-id");
  await expect(
    prepareManagedToolsRuntime({ LINGER_CLI_RELEASE_ID: "first" }),
  ).rejects.toThrow("BASE_URL");
});

it("ensures the current release under the transaction lock instead of reverting a live update", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "current tools "));
  roots.push(root);
  const source = path.join(root, "releases");
  await managedToolsFixture(source, "first");
  await managedToolsFixture(source, "second", "0.6.0", "0.6.1");
  const installer = createManagedToolsInstaller({
    root: path.join(root, "tools"),
    baseUrl: source,
    requiredLev8Version: "0.6.0",
  });
  await installer.ensure("first");
  const updated = await installer.update("second");
  const ensured = await installer.ensureCurrent("first");
  expect(ensured.current).toEqual(updated.current);
  await rm(path.join(updated.current!.directory, "lev8", "lev8"));
  const repaired = await installer.ensureCurrent("first");
  expect(repaired.current!.releaseId).toBe("second");
  expect(repaired.current!.versions).toEqual({
    teamhub: "0.6.1",
    lev8: "0.6.0",
  });
  expect(repaired.current!.directory).not.toBe(updated.current!.directory);
  expect(repaired.previous!.releaseId).toBe("first");
  expect((await installer.rollback()).current!.releaseId).toBe("first");
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it.each(["missing", "invalid"])(
  "repairs current with %s metadata using the configured release and retains a verified rollback",
  async (fault) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "corrupt current tools "),
    );
    roots.push(root);
    const source = path.join(root, "releases");
    await managedToolsFixture(source, "first");
    await managedToolsFixture(source, "second", "0.6.0", "0.6.1");
    const installer = createManagedToolsInstaller({
      root: path.join(root, "tools"),
      baseUrl: source,
      requiredLev8Version: "0.6.0",
    });
    const first = await installer.ensure("first");
    const updated = await installer.update("second");
    const metadata = path.join(updated.current!.directory, ".release.json");
    if (fault === "missing") await rm(metadata);
    else await writeFile(metadata, "invalid JSON");

    const repaired = await installer.ensureCurrent("first");
    expect(repaired.current!.releaseId).toBe("first");
    expect(repaired.current!.versions.lev8).toBe("0.6.0");
    expect(repaired.previous).toEqual(first.current);
    expect((await installer.rollback()).current).toEqual(first.current);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  },
);

it("refuses a bootstrap symlink without modifying user tools", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "unmanaged tools "));
  roots.push(root);
  const toolsRoot = path.join(root, "tools");
  const userRoot = path.join(root, "user");
  await mkdir(toolsRoot);
  await mkdir(path.join(userRoot, "bin"), { recursive: true });
  await writeFile(path.join(userRoot, "bin/lev8"), "user-owned");
  await symlink(userRoot, path.join(toolsRoot, "bootstrap"));
  await expect(
    prepareManagedToolsRuntime({
      LINGER_TOOLS_ROOT: toolsRoot,
      LINGER_CLI_RELEASE_ID: "first",
      LINGER_CLI_RELEASES_BASE_URL: root,
    }),
  ).rejects.toThrow("symlinks");
  expect(await readFile(path.join(userRoot, "bin/lev8"), "utf8")).toBe(
    "user-owned",
  );
  await rm(path.join(toolsRoot, "bootstrap"));
  await mkdir(path.join(toolsRoot, "bootstrap/bin"), { recursive: true });
  await writeFile(path.join(toolsRoot, "bootstrap/bin/lev8"), "user-owned");
  await expect(
    prepareManagedToolsRuntime({
      LINGER_TOOLS_ROOT: toolsRoot,
      LINGER_CLI_RELEASE_ID: "first",
      LINGER_CLI_RELEASES_BASE_URL: root,
    }),
  ).rejects.toThrow("unmanaged");
  expect(
    await readFile(path.join(toolsRoot, "bootstrap/bin/lev8"), "utf8"),
  ).toBe("user-owned");
});
