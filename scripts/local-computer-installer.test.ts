import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";

import { afterAll, beforeAll, describe, it, type ExpectStatic } from "vitest";

const execFileAsync = promisify(execFile);

// A process generation as the Daemon records it and the uninstaller compares it.
interface ProcessIdentity {
  readonly pid: number;
  readonly processGroupId: number;
  readonly startTime: string;
}

const inspectProcessIdentity = async (
  pid: number,
): Promise<ProcessIdentity | null> => {
  try {
    if (process.platform === "linux") {
      const stat = await readFile(`/proc/${String(pid)}/stat`, "utf8");
      const fields = stat
        .slice(stat.lastIndexOf(")") + 1)
        .trim()
        .split(/\s+/u);
      if (fields[0]?.startsWith("Z")) return null;
      return { pid, processGroupId: Number(fields[2]), startTime: fields[19]! };
    }
    const { stdout } = await execFileAsync(
      "/bin/ps",
      ["-o", "pgid=,state=,lstart=", "-p", String(pid)],
      { env: { PATH: process.env.PATH, LC_ALL: "C" } },
    );
    const match = /^\s*(\d+)\s+(\S+)\s+((?:\S+\s+){4}\S+)\s*$/u.exec(stdout);
    if (!match || match[2]!.startsWith("Z")) return null;
    return { pid, processGroupId: Number(match[1]), startTime: match[3]! };
  } catch {
    return null;
  }
};

// Kills a fixture process group once it is still the recorded generation.
const terminateFixtureProcess = async (
  identity: ProcessIdentity,
): Promise<void> => {
  const current = await inspectProcessIdentity(identity.pid);
  if (current?.startTime !== identity.startTime) return;
  try {
    process.kill(-identity.processGroupId, "SIGKILL");
  } catch {
    return;
  }
  while (
    (await inspectProcessIdentity(identity.pid))?.startTime ===
    identity.startTime
  )
    await new Promise((resolve) => setTimeout(resolve, 25));
};
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const installer = path.join(
  repositoryRoot,
  "scripts/install-linger-computer.sh",
);
const uninstaller = path.join(
  repositoryRoot,
  "scripts/uninstall-linger-computer.sh",
);
const installerProfileFile =
  process.env.LINGER_INSTALLER_TEST_PROFILE_FILE?.trim();
const temporaryRoots: string[] = [];
const installerProfile = {
  artifact: { calls: 0, totalMs: 0 },
  archive: { calls: 0, totalMs: 0 },
  checksum: { calls: 0, totalMs: 0 },
  fixture: { calls: 0, totalMs: 0 },
  installer: { calls: 0, totalMs: 0 },
  cleanup: { calls: 0, totalMs: 0 },
};

const recordProfile = (
  phase: keyof typeof installerProfile,
  startedAt: number,
) => {
  installerProfile[phase].calls += 1;
  installerProfile[phase].totalMs += performance.now() - startedAt;
};

type SharedArtifactVersion = "1.2.3" | "1.2.4";

// Release names the archives an installer run receives. The app archive holds
// daemon/, cli/, and the installer template; the deps archive holds runtime/ and
// computer-tools/.
interface Release {
  readonly app: string;
  readonly appSha256: string;
  readonly deps: string;
  readonly depsSha256: string;
  readonly depsSize: number;
}

const releaseTargetName = `${process.platform}-${process.arch}`;

let sharedArtifactRoot: string | undefined;
let sharedDeps: Omit<Release, "app" | "appSha256"> | undefined;
const sharedArtifacts = new Map<SharedArtifactVersion, Release>();

beforeAll(async () => {
  sharedArtifactRoot = await mkdtemp(
    path.join(os.tmpdir(), "linger-installer-shared-"),
  );
  sharedDeps = await writeDeps(sharedArtifactRoot);
  for (const version of ["1.2.3", "1.2.4"] as const) {
    sharedArtifacts.set(
      version,
      await writeArtifact(sharedArtifactRoot, version, { deps: sharedDeps }),
    );
  }
  for (const release of sharedArtifacts.values()) {
    await chmod(release.app, 0o444);
  }
  await chmod(sharedDeps.deps, 0o444);
  await chmod(sharedArtifactRoot, 0o555);
});

afterAll(async () => {
  const errors: unknown[] = [];
  const cleanupStartedAt = performance.now();
  try {
    await Promise.all(
      temporaryRoots
        .splice(0)
        .map((root) => rm(root, { force: true, recursive: true })),
    );
  } catch (error) {
    errors.push(error);
  } finally {
    recordProfile("cleanup", cleanupStartedAt);
  }
  try {
    for (const release of sharedArtifacts.values()) {
      for (const [file, expectedDigest] of [
        [release.app, release.appSha256],
        [release.deps, release.depsSha256],
      ] as const) {
        if (sha256(await readFile(file)) !== expectedDigest) {
          throw new Error(
            `Shared installer archive ${file} changed during the suite`,
          );
        }
      }
    }
  } catch (error) {
    errors.push(error);
  }
  if (sharedArtifactRoot) {
    try {
      await chmod(sharedArtifactRoot, 0o700);
      await rm(sharedArtifactRoot, { force: true, recursive: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (installerProfileFile) {
    try {
      await writeFile(
        installerProfileFile,
        `${JSON.stringify(installerProfile, null, 2)}\n`,
      );
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "installer suite cleanup failed");
  }
}, 30_000);

// Concurrent tests must use the context expect; the global one records async assertions on whichever test started last.
// apps/web/src/features/local-computer/computer-platform.test.ts holds the
// Web client's side of these.
describe("Computer environment names", () => {
  it.for([
    ["https://ci-linger.example.org", "ci"],
    ["https://staging-linger.example.net", "staging"],
    ["https://dev-local.example.net", "dev-local"],
    ["https://linger.example.com", "linger"],
    ["http://localhost:3000", "local-3000"],
    ["http://127.0.0.1:23300", "local-23300"],
    ["http://[::1]:8080", "local-8080"],
    ["https://preview.localhost", "local"],
    ["http://10.0.0.5:31037", "ip-10-0-0-5-31037"],
    ["https://[fe80::1]", "ip-fe80--1"],
    ["http://app.example.com:8443", "app-8443"],
    ["https://app.example.com:443", "app"],
  ])(
    "names %s %s in both shell scripts",
    async ([origin, name], { expect }) => {
      for (const script of [installer, uninstaller]) {
        const { stdout } = await execFileAsync("bash", [
          "-c",
          'eval "$(sed -n "/^computer_environment_name()/,/^}/p" "$1")"; computer_environment_name "$2"',
          "bash",
          script,
          origin!,
        ]);
        expect(stdout).toBe(`${name}\n`);
      }
    },
  );
});

describe.concurrent("linger-computer installer", { timeout: 30_000 }, () => {
  it("shows progress only for interactive package downloads", async ({
    expect,
  }) => {
    const source = await readFile(installer, "utf8");

    expect(source).toContain(
      '[[ "$transfer_mode" == "progress" ]] && [[ -t 2 ]]',
    );
    expect(source).toContain("--progress-bar");
    expect(source).toContain("--connect-timeout 15");
    expect(source).toContain("--retry 5");
    expect(source).toContain("--retry-all-errors");
    expect(source).toContain("--retry-max-time 300");
    expect(source).toContain("--speed-limit 1024");
    expect(source).toContain("--speed-time 60");
    expect(source).not.toContain("--http1.1");
    expect(source).toContain(
      'fetch_file "$source" "$destination" "$max_bytes" progress',
    );
    expect(source).toContain("[install] Verifying Local Computer %s...");
  });

  it("keeps the placeholder lines the Agent Service renders", async ({
    expect,
  }) => {
    const lines = (await readFile(installer, "utf8")).split("\n");
    for (const line of [
      'web_origin="${LINGER_WEB_URL:-http://localhost:3000}"',
      'release_darwin_arm64=""',
      'release_darwin_x64=""',
      'release_linux_arm64=""',
      'release_linux_x64=""',
    ]) {
      expect(lines.filter((candidate) => candidate === line)).toHaveLength(1);
    }
  });

  it("installs one bundled tree without releases, current, or node_modules", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");

    await runInstaller(fixture);
    await runInstaller(fixture);

    await expect(
      execFileAsync(fixture.launcher, ["version"], {
        env: fixture.environment,
      }),
    ).resolves.toMatchObject({ stdout: "linger-computer 1.2.3\n" });
    await expect(
      stat(
        path.join(
          fixture.installRoot,
          await activeBundleName(fixture.installRoot),
          "cli/linger-computer",
        ),
      ),
    ).resolves.toBeDefined();
    const activeBundle = await activeBundleName(fixture.installRoot);
    const privateNode = path.join(
      fixture.installRoot,
      activeBundle,
      "runtime/bin/node",
    );
    await expect(stat(privateNode)).resolves.toBeDefined();
    await expect(
      readFile(
        fixture.environment.LINGER_INSTALL_TEST_NODE_INVOCATIONS!,
        "utf8",
      ),
    ).resolves.toContain(privateNode);
    await expect(
      stat(path.join(fixture.installRoot, "releases")),
    ).rejects.toThrow();
    await expect(
      stat(path.join(fixture.installRoot, "current")),
    ).rejects.toThrow();
    expect(await recursiveEntries(fixture.installRoot)).not.toContainEqual(
      expect.stringContaining("node_modules"),
    );
    expect(
      (await readdir(fixture.installRoot)).filter((entry) =>
        entry.startsWith("lib-"),
      ),
    ).toHaveLength(1);
    const depsName = `deps-${fixture.artifact!.depsSha256.slice(0, 16)}`;
    expect(
      (await readdir(fixture.installRoot)).filter((entry) =>
        entry.startsWith("deps-"),
      ),
    ).toEqual([depsName]);
    await expect(
      readFile(path.join(fixture.installRoot, depsName, ".sha256"), "utf8"),
    ).resolves.toBe(`${fixture.artifact!.depsSha256}\n`);
    await expect(
      readFile(
        path.join(fixture.installRoot, activeBundle, "app-sha256"),
        "utf8",
      ),
    ).resolves.toBe(`${fixture.artifact!.appSha256}\n`);
    await expect(
      readlink(path.join(fixture.installRoot, activeBundle, "runtime")),
    ).resolves.toBe(`../${depsName}/runtime`);
    await expect(
      readlink(
        path.join(fixture.installRoot, activeBundle, "cli/computer-tools"),
      ),
    ).resolves.toBe(`../../${depsName}/computer-tools`);
    expect(
      (await readdir(path.dirname(fixture.launcher))).filter((entry) =>
        entry.startsWith("linger-computer"),
      ),
    ).toEqual(["linger-computer", "linger-computer-local-3000"]);
  }, 30_000);

  it("installs when started from a directory that no longer exists", async ({
    expect,
  }) => {
    // A daemon launched from a since-deleted checkout hands that cwd to the
    // self-update installer; the bundled CLI smoke test must still pass.
    const fixture = await installerFixture("1.2.3");
    const gone = await mkdtemp(path.join(os.tmpdir(), "installer-gone-cwd-"));

    await execFileAsync(
      "bash",
      [
        "-c",
        'cd "$1" && rmdir "$1" && exec bash "$2"',
        "bash",
        gone,
        installer,
      ],
      {
        env: {
          ...fixture.environment,
          ...releaseEnvironment(fixture.artifact!),
        },
      },
    );

    await expect(
      execFileAsync(fixture.launcher, ["version"], {
        env: fixture.environment,
      }),
    ).resolves.toMatchObject({ stdout: "linger-computer 1.2.3\n" });
  }, 30_000);

  it("installs without running setup and prints the explicit next command", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");

    const result = await runInstaller(fixture);

    await expect(readFile(fixture.invocations, "utf8")).rejects.toThrow();
    expect(result.stdout).toMatch(
      /Next:\n {2}\S*linger-computer-local-3000 login\n\nHelp:\n {2}\S*linger-computer-local-3000 --help\n/u,
    );

    await execFileAsync(fixture.launcher, ["login"], {
      env: fixture.environment,
    });
    await expect(readFile(fixture.invocations, "utf8")).resolves.toBe(
      "login:http://localhost:3000\n",
    );
  });

  it("prints persistent and immediate PATH commands when ~/.local/bin is absent", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    const environment = {
      ...fixture.environment,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    };

    const result = await runInstaller({ ...fixture, environment });

    expect(result.stdout).toContain(`Next:\n  ${fixture.launcher} login\n`);
    expect(result.stdout).toContain(
      "To run linger-computer-local-3000 by name, run:",
    );
    expect(result.stdout).toContain(
      `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zprofile`,
    );
    expect(result.stdout).toContain('export PATH="$HOME/.local/bin:$PATH"');

    await execFileAsync(
      "bash",
      [
        "-c",
        `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zprofile
export PATH="$HOME/.local/bin:$PATH"
linger-computer login`,
      ],
      { env: environment },
    );
    await expect(readFile(fixture.invocations, "utf8")).resolves.toBe(
      "login:http://localhost:3000\n",
    );
  });

  it("does not repeat persistent PATH configuration already present in ~/.zprofile", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    const environment = {
      ...fixture.environment,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    };
    await mkdir(fixture.home, { recursive: true });
    await writeFile(
      path.join(fixture.home, ".zprofile"),
      'export PATH="$HOME/.local/bin:$PATH"\n',
    );

    const result = await runInstaller({ ...fixture, environment });

    expect(result.stdout).toContain(
      "To run linger-computer-local-3000 by name, open a new terminal or run:",
    );
    expect(result.stdout).not.toContain(
      `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zprofile`,
    );
    expect(result.stdout).toContain('export PATH="$HOME/.local/bin:$PATH"');
    expect(result.stdout).toMatch(
      /Next:\n {2}\S*linger-computer-local-3000 login\n\nHelp:\n {2}\S*linger-computer-local-3000 --help\n/u,
    );
  });

  it("does not print PATH setup when ~/.local/bin is already available", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    const environment = {
      ...fixture.environment,
      PATH: `${path.dirname(fixture.launcher)}:${fixture.environment.PATH ?? ""}`,
    };

    const result = await runInstaller({ ...fixture, environment });

    expect(result.stdout).not.toContain("by name");
    expect(result.stdout).toContain(
      "Next:\n  linger-computer-local-3000 login\n",
    );
    expect(result.stdout).toContain(
      "While this is the only environment on this computer, linger-computer runs it too.",
    );
    await expect(
      execFileAsync("linger-computer", ["login"], { env: environment }),
    ).resolves.toBeDefined();
  });

  it("persists a plain HTTP enrollment origin", async ({ expect }) => {
    const fixture = await installerFixture("1.2.3");
    const origin = "http://10.0.0.5:31037";
    const environment = { ...fixture.environment, LINGER_WEB_URL: origin };
    const installed = environmentOf(fixture, "ip-10-0-0-5-31037");

    await runInstaller({ ...fixture, environment });
    await execFileAsync(installed.launcher, ["login"], {
      env: fixture.environment,
    });

    await expect(
      readFile(path.join(installed.installRoot, "web-origin"), "utf8"),
    ).resolves.toBe(`${origin}\n`);
    await expect(readFile(fixture.invocations, "utf8")).resolves.toBe(
      `login:${origin}\n`,
    );
  });

  it("recycles a running daemon when the isolated root has config but no launcher", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    const dataDirectory = path.join(fixture.root, "isolated-data");
    const binDirectory = path.join(fixture.root, "isolated-bin");
    const launcher = path.join(binDirectory, "linger-computer-local-3000");
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    await mkdir(binDirectory, { recursive: true, mode: 0o700 });
    const enrolledConfig = `${JSON.stringify({
      runner_id: "computer-isolated",
      gateway: { url: "wss://agent.example.test/v1/runner-gateway" },
      state_directory: path.join(dataDirectory, "state"),
    })}\n`;
    await writeFile(path.join(dataDirectory, "config.json"), enrolledConfig, {
      mode: 0o600,
    });
    await writeFile(path.join(fixture.root, "running"), "running");

    const result = await runInstaller({
      ...fixture,
      environment: {
        ...fixture.environment,
        LINGER_COMPUTER_DATA_DIR: dataDirectory,
        LINGER_COMPUTER_BIN_DIR: binDirectory,
      },
    });

    expect(result.stdout).toContain(
      "Existing Computer configuration found; installing the managed package in place.",
    );
    expect(result.stdout).toMatch(
      /Next:\n {2}\S*linger-computer-local-3000 daemon status\n/u,
    );
    expect(result.stdout).not.toMatch(/ login\n/u);
    expect(await readFile(fixture.invocations, "utf8")).toContain("stop\n");
    expect(await readFile(fixture.invocations, "utf8")).toContain("start\n");
    await expect(
      readFile(path.join(dataDirectory, "config.json"), "utf8"),
    ).resolves.toBe(enrolledConfig);
    await expect(
      readFile(path.join(fixture.root, "running"), "utf8"),
    ).resolves.toBe("1");
    const launcherSource = await readFile(launcher, "utf8");
    expect(launcherSource).toContain(
      `data_root="\${LINGER_COMPUTER_DATA_DIR:-${dataDirectory}}"`,
    );
    expect(launcherSource).toContain(
      'LINGER_COMPUTER_CONFIG="$data_root/config.json"',
    );
  }, 30_000);

  it("installs each origin as its own environment and lists them", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    const developmentOrigin = "http://10.0.0.5:31037";
    const productionOrigin = "https://app-linger.example.test";
    const development = environmentOf(fixture, "ip-10-0-0-5-31037");
    const production = environmentOf(fixture, "app");
    const environment = {
      ...fixture.environment,
      PATH: `${path.dirname(fixture.launcher)}:${fixture.environment.PATH ?? ""}`,
    };
    await runInstaller({
      ...fixture,
      environment: { ...environment, LINGER_WEB_URL: developmentOrigin },
    });

    const result = await runInstaller({
      ...fixture,
      environment: { ...environment, LINGER_WEB_URL: productionOrigin },
    });

    expect(result.stdout).toContain("Next:\n  linger-computer-app login\n");
    expect(result.stdout).toMatch(
      /This computer has Linger Computer for 2 environments, each with its own command:\n {2}linger-computer-app +https:\/\/app-linger\.example\.test {2}\(this installation\)\n {2}linger-computer-ip-10-0-0-5-31037 +http:\/\/10\.0\.0\.5:31037\nlinger-computer alone lists them instead of choosing one\.\n/u,
    );
    for (const [installed, origin] of [
      [development, developmentOrigin],
      [production, productionOrigin],
    ] as const) {
      await expect(
        readFile(path.join(installed.installRoot, "web-origin"), "utf8"),
      ).resolves.toBe(`${origin}\n`);
      await execFileAsync(installed.launcher, ["login"], {
        env: fixture.environment,
      });
    }
    await expect(readFile(fixture.invocations, "utf8")).resolves.toBe(
      `login:${developmentOrigin}\nlogin:${productionOrigin}\n`,
    );
    await expect(
      execFileAsync(fixture.dispatcher, ["login"], { env: environment }),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining(
        "Linger Computer is installed for 2 environments on this computer. Run the command of the environment you mean:\n  linger-computer-app                https://app-linger.example.test\n  linger-computer-ip-10-0-0-5-31037  http://10.0.0.5:31037\n",
      ),
    });
  });

  it("installs and runs when the host PATH has no Node", async ({ expect }) => {
    const fixture = await installerFixture("1.2.3");
    const environment = {
      ...fixture.environment,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    };

    await runInstaller({ ...fixture, environment });

    await expect(
      execFileAsync(fixture.launcher, ["version"], { env: environment }),
    ).resolves.toMatchObject({ stdout: "linger-computer 1.2.3\n" });
  });

  it("ignores an incompatible host Node instead of upgrading or using it", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    const fakeBin = path.join(fixture.root, "fake-bin");
    const hostNodeInvocations = path.join(
      fixture.root,
      "host-node-invocations",
    );
    await mkdir(fakeBin);
    await writeFile(
      path.join(fakeBin, "node"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${hostNodeInvocations}"\nprintf '%s\\n' 'v22.22.0'\n`,
      { mode: 0o755 },
    );
    const environment = {
      ...fixture.environment,
      PATH: `${fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    };

    await runInstaller({ ...fixture, environment });

    await expect(readFile(hostNodeInvocations, "utf8")).rejects.toThrow();
    await expect(
      execFileAsync(fixture.launcher, ["version"], { env: environment }),
    ).resolves.toMatchObject({ stdout: "linger-computer 1.2.3\n" });
  });

  it("does not reinstall an already current artifact", async ({ expect }) => {
    const fixture = await installerFixture("1.2.3", {
      privateArtifact: true,
    });
    await runInstaller(fixture);
    const installedBundle = await activeBundleName(fixture.installRoot);
    await writeFile(
      fixture.environment.LINGER_INSTALL_TEST_RUNNING!,
      "running",
    );
    await rm(fixture.artifact!.app);
    await rm(fixture.artifact!.deps);

    const result = await runInstaller({
      ...fixture,
      environment: {
        ...fixture.environment,
        LINGER_INSTALL_TEST_UNCONFIGURED: "1",
      },
    });

    expect(result.stdout).toContain("already up to date");
    await expect(activeBundleName(fixture.installRoot)).resolves.toBe(
      installedBundle,
    );
    await expect(
      readFile(fixture.environment.LINGER_INSTALL_TEST_RUNNING!, "utf8"),
    ).resolves.toBe("running");
    await expect(readFile(fixture.invocations, "utf8")).rejects.toThrow();
  });

  it("repairs a current artifact when the installed public CLI surface is broken", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    await runInstaller(fixture);
    await writeFile(
      fixture.launcher,
      `#!/bin/sh
case "$1" in
  version) printf '%s\\n' 'linger-computer 1.2.3' ;;
  status) printf '%s\\n' '{"version":1,"daemon":{"state":"stopped","active_operations":0}}' ;;
  *) exit 12 ;;
esac
`,
      { mode: 0o755 },
    );

    const result = await runInstaller(fixture);

    expect(result.stdout).not.toContain("already up to date");
    await expect(
      execFileAsync(fixture.launcher, ["--help"], {
        env: fixture.environment,
      }),
    ).resolves.toMatchObject({ stdout: "linger-computer usage\n" });
  });

  it("upgrades when the artifact checksum changes without a version change", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    await runInstaller(fixture);
    const installedBundle = await activeBundleName(fixture.installRoot);
    const repacked = await writeArtifact(fixture.root, "1.2.3", {
      extraFileContent: "repacked artifact",
    });

    const result = await runInstaller({ ...fixture, artifact: repacked });

    expect(result.stdout).toContain("Upgrade available: 1.2.3 -> 1.2.3");
    expect(result.stdout).toContain(
      "Linger Computer upgraded from 1.2.3 to 1.2.3 in ",
    );
    expect(await activeBundleName(fixture.installRoot)).not.toBe(
      installedBundle,
    );
    await expect(
      execFileAsync(fixture.launcher, ["version"], {
        env: fixture.environment,
      }),
    ).resolves.toMatchObject({ stdout: "linger-computer 1.2.3\n" });
  }, 30_000);

  it("points Next at daemon start when a logged-in daemon is stopped", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    await runInstaller(fixture);
    await writeFile(path.join(fixture.installRoot, "config.json"), "{}\n", {
      mode: 0o600,
    });

    const result = await runInstaller({
      ...fixture,
      artifact: sharedArtifact("1.2.4"),
    });

    expect(result.stdout).toMatch(/Next:\n {2}\S+ daemon start\n/u);
    expect(result.stderr).toMatch(
      /^\[1\/4\] Checking the installed version\.\.\.$/mu,
    );
    expect(result.stderr).toMatch(/^\[4\/4\] Installing\.\.\. OK \(\d+s\)$/mu);
  });

  it("upgrades an installation that never logged in", async ({ expect }) => {
    const fixture = await installerFixture("1.2.3");
    await runInstaller(fixture);
    const installedBundle = await activeBundleName(fixture.installRoot);

    const result = await runInstaller({
      ...fixture,
      artifact: sharedArtifact("1.2.4"),
      environment: {
        ...fixture.environment,
        LINGER_INSTALL_TEST_UNCONFIGURED: "1",
      },
    });

    expect(result.stdout).toContain(
      "Linger Computer upgraded from 1.2.3 to 1.2.4 in ",
    );
    expect(result.stdout).toMatch(/Next:\n {2}\S+ login\n/);
    expect(await activeBundleName(fixture.installRoot)).not.toBe(
      installedBundle,
    );
    expect(await readFile(fixture.invocations, "utf8").catch(() => "")).toBe(
      "",
    );
  });

  it("preserves a trusted installation with malformed configuration", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    await runInstaller(fixture);
    const installedBundle = await activeBundleName(fixture.installRoot);
    await writeFile(path.join(fixture.installRoot, "config.json"), "{", {
      mode: 0o600,
    });

    await expect(
      runInstaller({
        ...fixture,
        artifact: sharedArtifact("1.2.4"),
        environment: {
          ...fixture.environment,
          LINGER_INSTALL_TEST_MALFORMED_CONFIG: "1",
        },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Unable to verify the Computer daemon state: Local Computer configuration is unavailable.",
      ),
    });
    expect(await activeBundleName(fixture.installRoot)).toBe(installedBundle);
    await expect(
      stat(path.join(fixture.installRoot, installedBundle)),
    ).resolves.toBeDefined();
    expect(await readFile(fixture.invocations, "utf8").catch(() => "")).toBe(
      "",
    );
  });

  it("reports the Linux libatomic prerequisite without replacing the active bundle", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    await runInstaller(fixture);
    const activeBundle = await activeBundleName(fixture.installRoot);
    const invalidUpgrade = await writeArtifact(fixture.root, "1.2.4", {
      deps: await writeDeps(fixture.root, {
        name: "deps-libatomic",
        runtimeLoaderError:
          "error while loading shared libraries: libatomic.so.1: cannot open shared object file",
      }),
    });

    await expect(
      runInstaller({ ...fixture, artifact: invalidUpgrade }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Ubuntu/Debian: sudo apt-get install libatomic1",
      ),
    });
    await expect(activeBundleName(fixture.installRoot)).resolves.toBe(
      activeBundle,
    );
    await expect(
      execFileAsync(fixture.launcher, ["version"], {
        env: fixture.environment,
      }),
    ).resolves.toMatchObject({ stdout: "linger-computer 1.2.3\n" });
  });

  it("repairs a missing launcher through the active bundle lifecycle CLI", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    await runInstaller(fixture);
    const installedBundle = await activeBundleName(fixture.installRoot);
    await writeFile(
      fixture.environment.LINGER_INSTALL_TEST_RUNNING!,
      "running",
    );
    await rm(fixture.launcher);

    await runInstaller(fixture);

    expect(await activeBundleName(fixture.installRoot)).not.toBe(
      installedBundle,
    );
    expect(await readFile(fixture.invocations, "utf8")).toContain("stop\n");
    expect(await readFile(fixture.invocations, "utf8")).toContain("start\n");
    await expect(
      readFile(fixture.environment.LINGER_INSTALL_TEST_RUNNING!, "utf8"),
    ).resolves.toBe("1");
    await expect(stat(fixture.launcher)).resolves.toBeDefined();
  });

  it("preserves a running installation when its lifecycle CLI is corrupted", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    await runInstaller(fixture);
    const installedBundle = await activeBundleName(fixture.installRoot);
    const cliEntry = path.join(
      fixture.installRoot,
      installedBundle,
      "cli/linger-computer",
    );
    await writeFile(
      fixture.environment.LINGER_INSTALL_TEST_RUNNING!,
      "running",
    );
    await writeFile(cliEntry, "corrupted\n");

    await expect(runInstaller(fixture)).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Unable to verify the Computer daemon state",
      ),
    });

    await expect(activeBundleName(fixture.installRoot)).resolves.toBe(
      installedBundle,
    );
    await expect(readFile(cliEntry, "utf8")).resolves.toBe("corrupted\n");
    await expect(
      readFile(fixture.environment.LINGER_INSTALL_TEST_RUNNING!, "utf8"),
    ).resolves.toBe("running");
  });

  it.for(["active-bundle", "launcher"])(
    "rejects a symlinked %s without mutating the installation",
    async (entry, { expect }) => {
      const fixture = await installerFixture("1.2.3");
      await runInstaller(fixture);
      const source =
        entry === "launcher"
          ? fixture.launcher
          : path.join(fixture.installRoot, "active-bundle");
      const target = path.join(fixture.root, `${entry}-target`);
      await rename(source, target);
      await symlink(target, source);

      await expect(runInstaller(fixture)).rejects.toMatchObject({
        stderr: expect.stringContaining("unsafe symbolic link"),
      });
      expect((await lstat(source)).isSymbolicLink()).toBe(true);
    },
  );

  it.for([
    "cli/linger-computer",
    "daemon/linger-computer-daemon",
    "runtime/bin/node",
  ])(
    "rejects a symlinked installed bundle entry %s",
    async (entry, { expect }) => {
      const fixture = await installerFixture("1.2.3");
      await runInstaller(fixture);
      const installedBundle = await activeBundleName(fixture.installRoot);
      const source = path.join(fixture.installRoot, installedBundle, entry);
      const target = path.join(fixture.root, path.basename(entry));
      await rename(source, target);
      await symlink(target, source);

      await expect(runInstaller(fixture)).rejects.toMatchObject({
        stderr: expect.stringContaining("bundle entry is unsafe"),
      });
      expect((await lstat(source)).isSymbolicLink()).toBe(true);
    },
  );

  it.for([
    ["an origin with a path", "https://app.example.test/install"],
    ["a non-HTTP origin", "ftp://packages.example.test"],
  ] as const)(
    "rejects %s before downloading",
    async ([, origin], { expect }) => {
      const fixture = await installerFixture("1.2.3");

      await expect(
        runInstaller({
          ...fixture,
          environment: {
            ...fixture.environment,
            LINGER_WEB_URL: origin,
          },
        }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(
          "Linger Web origin must be an HTTPS or HTTP origin without a path.",
        ),
      });
      await expect(stat(fixture.installRoot)).rejects.toThrow();
    },
  );

  it("fails closed while another installer owns the installation lock", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    const lock = path.join(fixture.installRoot, ".install.lock");
    await mkdir(lock, { recursive: true, mode: 0o700 });
    await writeFile(path.join(lock, "pid"), `${process.pid}\n`);

    await expect(runInstaller(fixture)).rejects.toMatchObject({
      stderr: expect.stringContaining("installation is active"),
    });
    await expect(stat(fixture.launcher)).rejects.toThrow();
  });

  it("recovers a stale installer lock whose pid belongs to another process instance", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    const lock = path.join(fixture.installRoot, ".install.lock");
    await mkdir(lock, { recursive: true, mode: 0o700 });
    await writeFile(path.join(lock, "pid"), `${process.pid}\n`);
    await writeFile(path.join(lock, "process-identity"), "stale-process\n");

    await runInstaller(fixture);

    await expect(
      execFileAsync(fixture.launcher, ["version"], {
        env: fixture.environment,
      }),
    ).resolves.toMatchObject({ stdout: "linger-computer 1.2.3\n" });
  });

  it("returns the signal exit code when installation is terminated", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3", {
      privateArtifact: true,
    });
    const blockingMarker = path.join(fixture.root, "blocking-version");
    const cleanupInvocations = path.join(fixture.root, "cleanup-invocations");
    const child = spawn("bash", [installer], {
      detached: true,
      env: {
        ...fixture.environment,
        ...releaseEnvironment(fixture.artifact!),
        LINGER_INSTALL_TEST_BLOCKING_VERSION: blockingMarker,
        LINGER_INSTALL_TEST_CLEANUP_INVOCATIONS: cleanupInvocations,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    try {
      await waitForFile(blockingMarker);
      if (!child.pid) throw new Error("installer process has no pid");
      process.kill(-child.pid, "SIGTERM");
      const [exitCode, signal] = (await once(child, "exit")) as [
        number | null,
        NodeJS.Signals | null,
      ];

      expect(signal).toBeNull();
      expect(exitCode, stderr).toBe(143);
      await expect(readFile(cleanupInvocations, "utf8")).resolves.toBe(
        "cleanup\n",
      );
      await expect(
        stat(path.join(fixture.installRoot, ".install.lock")),
      ).rejects.toThrow();
    } finally {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // The installer process group already exited.
        }
      }
    }
  });

  it("does not overwrite an unrelated executable with the launcher name", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    const unrelated = "#!/bin/sh\nprintf '%s\\n' unrelated\n";
    await mkdir(path.dirname(fixture.launcher), { recursive: true });
    await writeFile(fixture.launcher, unrelated, { mode: 0o755 });

    await expect(runInstaller(fixture)).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Existing linger-computer-local-3000 launcher is not owned by this installation",
      ),
    });
    await expect(readFile(fixture.launcher, "utf8")).resolves.toBe(unrelated);
  });

  it("refuses a managed launcher whose installation was deleted", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    await runInstaller(fixture);
    const launcher = await readFile(fixture.launcher, "utf8");
    await rm(path.join(fixture.installRoot, "active-bundle"));
    for (const name of await readdir(fixture.installRoot))
      if (name.startsWith("lib-"))
        await rm(path.join(fixture.installRoot, name), { recursive: true });

    await expect(
      runInstaller({ ...fixture, artifact: sharedArtifact("1.2.4") }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        `The previous Local Computer installation is incomplete, so the installer cannot stop its daemon. Stop any running linger-computer-daemon process, remove the orphan launcher at ${fixture.launcher}, and run the installer again.`,
      ),
    });
    await expect(readFile(fixture.launcher, "utf8")).resolves.toBe(launcher);
    await expect(readdir(fixture.installRoot)).resolves.not.toContain(
      "active-bundle",
    );
  });

  // A CLI without configuration cannot locate a custom state directory, so
  // only a daemon holding the default-state lock fails closed.
  it.for(["default"])(
    "preserves an installation when its live daemon has lost configuration (%s state)",
    { timeout: 30_000 },
    async (stateLocation, { expect }) => {
      const fixture = await installerFixture("1.2.3");
      await runInstaller(fixture);
      const installedBundle = await activeBundleName(fixture.installRoot);
      const configPath = path.join(fixture.installRoot, "config.json");
      const stateDirectory =
        stateLocation === "custom"
          ? path.join(fixture.root, "custom-state")
          : path.join(fixture.installRoot, "state");
      const lockDirectory = path.join(stateDirectory, "daemon.lock");
      await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
      await writeFile(
        configPath,
        JSON.stringify({ state_directory: stateDirectory }),
        { mode: 0o600 },
      );
      const daemon = await spawnOwnedFixtureProcess();
      try {
        await writeFile(
          path.join(lockDirectory, "owner.json"),
          JSON.stringify({ ...daemon.identity, nonce: "missing-config" }),
          { mode: 0o600 },
        );
        await rm(configPath);

        const outcome = await runInstaller({
          ...fixture,
          artifact: sharedArtifact("1.2.4"),
          environment: {
            ...fixture.environment,
            LINGER_INSTALL_TEST_UNCONFIGURED: "1",
          },
        }).then(
          (result) => ({ code: 0, ...result }),
          (error: { code: number; stdout: string; stderr: string }) => error,
        );

        expect
          .soft(await activeBundleName(fixture.installRoot))
          .toBe(installedBundle);
        expect.soft(outcome.code, JSON.stringify(outcome)).not.toBe(0);
        await expect
          .soft(stat(path.join(fixture.installRoot, installedBundle)))
          .resolves.toBeDefined();
        await expect(
          inspectProcessIdentity(daemon.identity.pid),
        ).resolves.toMatchObject({
          pid: daemon.identity.pid,
          processGroupId: daemon.identity.processGroupId,
          startTime: daemon.identity.startTime,
        });
      } finally {
        await terminateFixtureProcess(daemon.identity);
      }
    },
  );

  it("preserves an unconfigured installation whose active bundle is missing", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    await runInstaller(fixture);
    const missingBundle = await activeBundleName(fixture.installRoot);
    await rm(path.join(fixture.installRoot, missingBundle), {
      recursive: true,
    });

    await expect(runInstaller(fixture)).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Installed bundle path is unsafe or missing",
      ),
    });
    expect(await activeBundleName(fixture.installRoot)).toBe(missingBundle);
  });

  it("preserves a configured installation whose active bundle is missing", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    await runInstaller(fixture);
    const missingBundle = await activeBundleName(fixture.installRoot);
    await writeFile(path.join(fixture.installRoot, "config.json"), "{}\n", {
      mode: 0o600,
    });
    await rm(path.join(fixture.installRoot, missingBundle), {
      recursive: true,
    });

    await expect(runInstaller(fixture)).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Installed bundle path is unsafe or missing",
      ),
    });
    await expect(activeBundleName(fixture.installRoot)).resolves.toBe(
      missingBundle,
    );
  });

  it("keeps the old CLI usable when an upgrade fails validation", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    await runInstaller(fixture);
    const invalid = await writeArtifact(fixture.root, "1.2.4", {
      cliSource: "this is not valid JavaScript }",
    });

    await expect(
      runInstaller({ ...fixture, artifact: invalid }),
    ).rejects.toThrow();

    await expect(
      execFileAsync(fixture.launcher, ["version"], {
        env: fixture.environment,
      }),
    ).resolves.toMatchObject({ stdout: "linger-computer 1.2.3\n" });
  });

  it.for(["running", "stopped"])(
    "upgrades a %s pre-dependency-package install in place and keeps its configuration",
    async (daemonState, { expect }) => {
      const fixture = await installerFixture("1.2.3");
      await runInstaller(fixture);
      // Rewrite the install into the old layout: a real runtime/ inside the
      // bundle, the tools under cli/, no app-sha256, no deps-* directory, and
      // old root receipts nothing reads any more.
      const previous = await activeBundleName(fixture.installRoot);
      const previousRoot = path.join(fixture.installRoot, previous);
      const depsName = path.basename(
        path.dirname(await readlink(path.join(previousRoot, "runtime"))),
      );
      await rm(path.join(previousRoot, "runtime"));
      await rm(path.join(previousRoot, "cli/computer-tools"));
      await rm(path.join(previousRoot, "app-sha256"));
      await rename(
        path.join(fixture.installRoot, depsName, "runtime"),
        path.join(previousRoot, "runtime"),
      );
      await rename(
        path.join(fixture.installRoot, depsName, "computer-tools"),
        path.join(previousRoot, "cli/computer-tools"),
      );
      await rm(path.join(fixture.installRoot, depsName), { recursive: true });
      await writeFile(
        path.join(fixture.installRoot, "installed-bundle-checksum"),
        `${"a".repeat(64)}\n`,
      );
      const configPath = path.join(fixture.installRoot, "config.json");
      const configSource = JSON.stringify({
        version: 1,
        state_directory: path.join(fixture.installRoot, "state"),
      });
      await writeFile(configPath, configSource, { mode: 0o600 });
      if (daemonState === "running") {
        await writeFile(
          fixture.environment.LINGER_INSTALL_TEST_RUNNING!,
          "running",
        );
      }

      const result = await runInstaller({
        ...fixture,
        artifact: sharedArtifact("1.2.4"),
      });

      expect(result.stdout).toContain("Upgrade available: 1.2.3 -> 1.2.4");
      const active = await activeBundleName(fixture.installRoot);
      expect(active).not.toBe(previous);
      await expect(
        readFile(path.join(fixture.installRoot, active, "app-sha256"), "utf8"),
      ).resolves.toBe(`${sharedArtifact("1.2.4").appSha256}\n`);
      await expect(stat(previousRoot)).resolves.toBeDefined();
      await expect(readFile(configPath, "utf8")).resolves.toBe(configSource);
      if (daemonState === "running") {
        expect(await readFile(fixture.invocations, "utf8")).toContain(
          "stop\nstop-args:--if-idle\n",
        );
        await expect(
          readFile(fixture.environment.LINGER_INSTALL_TEST_RUNNING!, "utf8"),
        ).resolves.toBe("1");
      } else {
        await expect(readFile(fixture.invocations, "utf8")).rejects.toThrow();
      }
    },
  );

  it.for([
    {
      environment: { LINGER_INSTALL_TEST_GATEWAY_STATE: "upgrade-required" },
      missing: "gateway=upgrade-required",
    },
    {
      environment: { LINGER_INSTALL_TEST_RECONCILED: "0" },
      missing: "reconciliation=not-confirmed",
    },
  ])(
    "rolls back a running upgrade without verified Gateway readiness: %j",
    { timeout: 45_000 },
    async (failure, { expect }) => {
      const fixture = await installerFixture("1.2.3");
      await runInstaller(fixture);
      const previous = await activeBundleName(fixture.installRoot);
      await writeFile(
        fixture.environment.LINGER_INSTALL_TEST_RUNNING!,
        "running",
      );
      await expect(
        runInstaller({
          ...fixture,
          artifact: sharedArtifact("1.2.4"),
          environment: {
            ...fixture.environment,
            ...failure.environment,
          },
        }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(failure.missing),
      });
      expect(await activeBundleName(fixture.installRoot)).toBe(previous);
      await expect(
        readFile(fixture.environment.LINGER_INSTALL_TEST_RUNNING!, "utf8"),
      ).resolves.toBe("1");
      await expect(
        execFileAsync(fixture.launcher, ["version"], {
          env: fixture.environment,
        }),
      ).resolves.toMatchObject({ stdout: "linger-computer 1.2.3\n" });
    },
  );

  it("rejects an upgrade whose version works but public CLI commands are broken", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    await runInstaller(fixture);
    const broken = await writeArtifact(fixture.root, "1.2.4", {
      brokenCommand: "help",
    });

    await expect(
      runInstaller({ ...fixture, artifact: broken }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Artifact failed its CLI smoke test"),
    });
    await expect(
      execFileAsync(fixture.launcher, ["version"], {
        env: fixture.environment,
      }),
    ).resolves.toMatchObject({ stdout: "linger-computer 1.2.3\n" });
  });

  it("rolls back the bundle and daemon state when post-install smoke fails", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    await runInstaller(fixture);
    const runningMarker = path.join(fixture.root, "running");
    await writeFile(runningMarker, "1");
    const brokenUpgrade = await writeArtifact(fixture.root, "1.2.4", {
      failAfterInstall: true,
    });

    await expect(
      runInstaller({ ...fixture, artifact: brokenUpgrade }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Installed CLI failed its smoke test"),
    });

    await expect(
      execFileAsync(fixture.launcher, ["version"], {
        env: fixture.environment,
      }),
    ).resolves.toMatchObject({ stdout: "linger-computer 1.2.3\n" });
    await expect(readFile(runningMarker, "utf8")).resolves.toBe("1");
  }, 30_000);

  it("restores install metadata when an upgrade fails between metadata writes", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    await runInstaller(fixture);
    const metadataFiles = ["web-origin", "active-bundle"];
    const previousMetadata = await Promise.all(
      metadataFiles.map((file) =>
        readFile(path.join(fixture.installRoot, file), "utf8"),
      ),
    );
    const upgrade = sharedArtifact("1.2.4");

    await expect(
      runInstaller({
        ...fixture,
        artifact: upgrade,
        environment: {
          ...fixture.environment,
          LINGER_INSTALL_TEST_FAIL_AFTER_METADATA_WRITE: "web-origin",
          LINGER_WEB_URL: "http://127.0.0.1:3000",
        },
      }),
    ).rejects.toBeDefined();

    await expect(
      execFileAsync(fixture.launcher, ["version"], {
        env: fixture.environment,
      }),
    ).resolves.toMatchObject({ stdout: "linger-computer 1.2.3\n" });
    await expect(
      Promise.all(
        metadataFiles.map((file) =>
          readFile(path.join(fixture.installRoot, file), "utf8"),
        ),
      ),
    ).resolves.toEqual(previousMetadata);
  }, 30_000);

  it("keeps the switched bundle when restoring the old active pointer fails", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    await runInstaller(fixture);
    const oldActiveBundle = await activeBundleName(fixture.installRoot);
    const brokenUpgrade = await writeArtifact(fixture.root, "1.2.4", {
      failAfterInstall: true,
    });

    await expect(
      runInstaller({
        ...fixture,
        artifact: brokenUpgrade,
        environment: {
          ...fixture.environment,
          LINGER_INSTALL_TEST_FAIL_ACTIVE_RESTORE: "1",
        },
      }),
    ).rejects.toBeDefined();

    const activeBundle = await activeBundleName(fixture.installRoot);
    expect(activeBundle).not.toBe(oldActiveBundle);
    await expect(
      stat(path.join(fixture.installRoot, activeBundle)),
    ).resolves.toBeDefined();
  }, 30_000);

  it("stops and restores a running daemon around a successful upgrade", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    await runInstaller(fixture);
    const configPath = path.join(fixture.installRoot, "config.json");
    const enrolledConfig = `${JSON.stringify({
      runner_id: "computer-enrolled",
      gateway: { url: "wss://agent.example.test/v1/runner-gateway" },
      state_directory: path.join(fixture.installRoot, "state"),
    })}\n`;
    await writeFile(configPath, enrolledConfig, { mode: 0o600 });
    const runningMarker = path.join(fixture.root, "running");
    await writeFile(runningMarker, "running");
    const upgraded = sharedArtifact("1.2.4");

    const result = await runInstaller({ ...fixture, artifact: upgraded });

    expect(result.stdout).toContain("Upgrade available: 1.2.3 -> 1.2.4");
    expect(result.stdout).toContain(
      "Linger Computer upgraded from 1.2.3 to 1.2.4 in ",
    );
    expect(result.stdout).toMatch(
      /Next:\n {2}\S*linger-computer-local-3000 daemon status\n/u,
    );
    expect(result.stdout).not.toMatch(/ login\n/u);
    expect(await readFile(fixture.invocations, "utf8")).toContain("stop\n");
    expect(await readFile(fixture.invocations, "utf8")).toContain("start\n");
    expect(await readFile(fixture.invocations, "utf8")).not.toContain("login:");
    await expect(readFile(configPath, "utf8")).resolves.toBe(enrolledConfig);
    await expect(readFile(runningMarker, "utf8")).resolves.toBe("1");
  }, 30_000);

  it("stops the Daemon of a verified bundle without a Go CLI through the staged CLI", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    await runInstaller(fixture);
    const installedBundle = await activeBundleName(fixture.installRoot);
    await writeFile(
      path.join(fixture.installRoot, "config.json"),
      `${JSON.stringify({
        runner_id: "computer-enrolled",
        gateway: { url: "wss://agent.example.test/v1/runner-gateway" },
        state_directory: path.join(fixture.installRoot, "state"),
      })}\n`,
      { mode: 0o600 },
    );
    const runningMarker = path.join(fixture.root, "running");
    await writeFile(runningMarker, "running");
    // Bundles from before the Go CLI ship no cli/linger-computer.
    await rm(
      path.join(fixture.installRoot, installedBundle, "cli/linger-computer"),
    );

    const result = await runInstaller({
      ...fixture,
      artifact: sharedArtifact("1.2.4"),
    });

    expect(result.stdout).toMatch(
      /Linger Computer upgraded from .* to 1\.2\.4 in /u,
    );
    expect(await readFile(fixture.invocations, "utf8")).toContain("stop\n");
    await expect(readFile(runningMarker, "utf8")).resolves.toBe("1");
  }, 30_000);

  it("refuses an upgrade while an Operation is active and preserves the running daemon", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    await runInstaller(fixture);
    const runningMarker = fixture.environment.LINGER_INSTALL_TEST_RUNNING!;
    await writeFile(runningMarker, "running");
    const upgraded = sharedArtifact("1.2.4");

    await expect(
      runInstaller({
        ...fixture,
        artifact: upgraded,
        environment: {
          ...fixture.environment,
          LINGER_INSTALL_TEST_ACTIVE_OPERATIONS: "1",
        },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Cannot upgrade while 1 Agent Operation is active",
      ),
    });
    expect(await readFile(runningMarker, "utf8")).toBe("running");
    await expect(readFile(fixture.invocations, "utf8")).rejects.toThrow();
  });

  it("preserves the installation when an Operation starts after the status check", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    await runInstaller(fixture);
    const runningMarker = fixture.environment.LINGER_INSTALL_TEST_RUNNING!;
    await writeFile(runningMarker, "running");
    const upgraded = sharedArtifact("1.2.4");

    await expect(
      runInstaller({
        ...fixture,
        artifact: upgraded,
        environment: {
          ...fixture.environment,
          LINGER_INSTALL_TEST_ACTIVE_OPERATIONS_ON_STOP: "1",
        },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Cannot stop while 1 Agent Operation is active",
      ),
    });
    await expect(
      execFileAsync(fixture.launcher, ["version"], {
        env: fixture.environment,
      }),
    ).resolves.toMatchObject({ stdout: "linger-computer 1.2.3\n" });
    expect(await readFile(runningMarker, "utf8")).toBe("running");
  });

  it("commits install metadata before starting the new Daemon", async () => {
    const fixture = await installerFixture("1.2.3");
    await runInstaller(fixture);
    await writeFile(
      fixture.environment.LINGER_INSTALL_TEST_RUNNING!,
      "running",
    );
    await runInstaller({
      ...fixture,
      artifact: sharedArtifact("1.2.4"),
      environment: {
        ...fixture.environment,
        LINGER_WEB_URL: "http://127.0.0.1:3001",
        LINGER_INSTALL_TEST_EXPECT_START_WEB_ORIGIN: "http://127.0.0.1:3001",
      },
    });
  });

  it("does not admit a new Daemon before a metadata-write failure rolls back", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    await runInstaller(fixture);
    await writeFile(
      fixture.environment.LINGER_INSTALL_TEST_RUNNING!,
      "running",
    );
    await expect(
      runInstaller({
        ...fixture,
        artifact: sharedArtifact("1.2.4"),
        environment: {
          ...fixture.environment,
          LINGER_INSTALL_TEST_OBSERVE_START_VERSION: "1",
          LINGER_INSTALL_TEST_FAIL_AFTER_METADATA_WRITE: "web-origin",
        },
      }),
    ).rejects.toBeDefined();
    expect(await readFile(fixture.invocations, "utf8")).not.toContain(
      "start-version:1.2.4",
    );
  });

  it.for(["busy", "unknown"] as const)(
    "preserves a started upgrade when rollback cannot safely idle-stop it: %s",
    async (mode, { expect }) => {
      const fixture = await installerFixture("1.2.3");
      await runInstaller(fixture);
      const previousBundle = await activeBundleName(fixture.installRoot);
      await writeFile(
        fixture.environment.LINGER_INSTALL_TEST_RUNNING!,
        "running",
      );
      const artifact = sharedArtifact("1.2.4");
      await expect(
        runInstaller({
          ...fixture,
          artifact,
          environment: {
            ...fixture.environment,
            LINGER_INSTALL_TEST_GATEWAY_STATE: "authentication-failed",
            ...(mode === "busy"
              ? {
                  LINGER_INSTALL_TEST_ACTIVE_FILE: path.join(
                    fixture.root,
                    "active-operation",
                  ),
                }
              : { LINGER_INSTALL_TEST_NEW_IDLE_UNKNOWN: "1" }),
          },
        }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("Automatic rollback was deferred"),
      });
      const activeBundle = await activeBundleName(fixture.installRoot);
      expect(activeBundle).not.toBe(previousBundle);
      await expect(
        stat(path.join(fixture.installRoot, activeBundle)),
      ).resolves.toBeDefined();
      await expect(
        stat(path.join(fixture.installRoot, previousBundle)),
      ).resolves.toBeDefined();
      expect(
        await readFile(
          fixture.environment.LINGER_INSTALL_TEST_RUNNING!,
          "utf8",
        ),
      ).toBe("1");
      expect(await readFile(fixture.invocations, "utf8")).not.toContain(
        "unsafe-active-stop",
      );
      await expect(
        readFile(
          path.join(fixture.installRoot, activeBundle, "app-sha256"),
          "utf8",
        ),
      ).resolves.toBe(`${artifact.appSha256}\n`);
      await expect(
        execFileAsync(fixture.launcher, ["version"], {
          env: fixture.environment,
        }),
      ).resolves.toMatchObject({ stdout: "linger-computer 1.2.4\n" });
    },
  );

  it("does not hide a real --if-idle stop failure behind a plain stop", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    await runInstaller(fixture);
    const runningMarker = fixture.environment.LINGER_INSTALL_TEST_RUNNING!;
    await writeFile(runningMarker, "running");
    const upgraded = sharedArtifact("1.2.4");

    await expect(
      runInstaller({
        ...fixture,
        artifact: upgraded,
        environment: {
          ...fixture.environment,
          LINGER_INSTALL_TEST_STOP_MODE: "fail",
        },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("simulated daemon stop failure"),
    });

    expect(await readFile(fixture.invocations, "utf8")).toBe(
      "stop\nstop-args:--if-idle\n",
    );
    await expect(
      execFileAsync(fixture.launcher, ["version"], {
        env: fixture.environment,
      }),
    ).resolves.toMatchObject({ stdout: "linger-computer 1.2.3\n" });
    await expect(readFile(runningMarker, "utf8")).resolves.toBe("running");
  });

  it("downloads and verifies this platform's release when invoked through curl without arguments", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    const server = await releaseServer(fixture.artifact!);
    try {
      const rendered = await renderInstaller(fixture.root, fixture.artifact!);

      await runInstaller({
        ...fixture,
        artifact: undefined,
        installerPath: rendered,
        environment: {
          ...fixture.environment,
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          LINGER_WEB_URL: server.origin,
        },
      });

      expect(server.requests).toEqual({ app: 1, deps: 1 });
      await expect(
        execFileAsync(
          serverEnvironment(fixture, server).launcher,
          ["version"],
          {
            env: fixture.environment,
          },
        ),
      ).resolves.toMatchObject({ stdout: "linger-computer 1.2.3\n" });
    } finally {
      await server.close();
    }
  });

  it("refuses an installer without a release for this platform", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");

    await expect(
      runInstaller({ ...fixture, artifact: undefined }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        `carries no Local Computer release for ${releaseTargetName}`,
      ),
    });
    await expect(stat(fixture.launcher)).rejects.toThrow();
  });

  it("reuses a verified dependency directory and downloads only the app archive", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    const upgrade = sharedArtifact("1.2.4");
    const server = await releaseServer(upgrade);
    try {
      await runInstaller({
        ...fixture,
        environment: { ...fixture.environment, LINGER_WEB_URL: server.origin },
      });
      await runInstaller({
        ...fixture,
        artifact: undefined,
        environment: {
          ...fixture.environment,
          LINGER_WEB_URL: server.origin,
          LINGER_COMPUTER_APP_SHA256: upgrade.appSha256,
          LINGER_COMPUTER_DEPS_SHA256: upgrade.depsSha256,
          LINGER_COMPUTER_DEPS_SIZE: String(upgrade.depsSize),
        },
      });

      expect(server.requests).toEqual({ app: 1, deps: 0 });
      await expect(
        execFileAsync(
          serverEnvironment(fixture, server).launcher,
          ["version"],
          {
            env: fixture.environment,
          },
        ),
      ).resolves.toMatchObject({ stdout: "linger-computer 1.2.4\n" });
    } finally {
      await server.close();
    }
  });

  it.for(["app", "deps"] as const)(
    "refuses a %s archive whose sha256 does not match and leaves no dependency directory",
    async (kind, { expect }) => {
      const fixture = await installerFixture("1.2.3");
      const release = fixture.artifact!;
      const wrong = "0".repeat(64);

      await expect(
        runInstaller({
          ...fixture,
          artifact: {
            ...release,
            ...(kind === "app" ? { appSha256: wrong } : { depsSha256: wrong }),
          },
        }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(
          kind === "app"
            ? "Local Computer package checksum verification failed"
            : "Local Computer dependency package checksum verification failed",
        ),
      });
      const entries = await readdir(fixture.installRoot);
      if (kind === "deps") {
        expect(entries.filter((entry) => entry.startsWith("deps-"))).toEqual(
          [],
        );
      }
      expect(entries.filter((entry) => entry.startsWith("lib-"))).toEqual([]);
      expect(entries.filter((entry) => entry.startsWith("."))).toEqual([]);
      await expect(stat(fixture.launcher)).rejects.toThrow();
    },
  );

  it("exits with curl's code when the dependency download keeps failing", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    const release = fixture.artifact!;
    // Every response is cut short, so curl gives up with 18 (partial file);
    // the Daemon retries such exits soon instead of after an hour.
    const server = await releaseServer(release, { depsFailures: 1_000 });
    try {
      const failure = await runInstaller({
        ...fixture,
        artifact: undefined,
        environment: {
          ...fixture.environment,
          LINGER_WEB_URL: server.origin,
          LINGER_COMPUTER_APP_ARCHIVE: release.app,
          LINGER_COMPUTER_APP_SHA256: release.appSha256,
          LINGER_COMPUTER_DEPS_SHA256: release.depsSha256,
          LINGER_COMPUTER_DEPS_SIZE: String(release.depsSize),
        },
      }).then(
        () => undefined,
        (error: { code: number; stderr: string }) => error,
      );

      expect(failure?.code).toBe(18);
      expect(failure?.stderr).not.toContain("checksum verification failed");
      expect(
        (await readdir(serverEnvironment(fixture, server).installRoot)).filter(
          (entry) => entry.startsWith("deps-"),
        ),
      ).toEqual([]);
    } finally {
      await server.close();
    }
  }, 120_000);

  it("refuses a dependency archive larger than its declared size", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");

    await expect(
      runInstaller({
        ...fixture,
        artifact: {
          ...fixture.artifact!,
          depsSize: fixture.artifact!.depsSize - 1,
        },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("dependency package exceeds"),
    });
    expect(
      (await readdir(fixture.installRoot)).filter((entry) =>
        entry.startsWith("deps-"),
      ),
    ).toEqual([]);
  });

  it("clears an interrupted dependency extraction on the next run", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    await mkdir(path.join(fixture.installRoot, ".deps.interrupted/runtime"), {
      recursive: true,
      mode: 0o700,
    });
    await mkdir(path.join(fixture.installRoot, ".bundle.12345"), {
      mode: 0o700,
    });

    await runInstaller(fixture);

    expect(
      (await readdir(fixture.installRoot)).filter(
        (entry) => entry.startsWith(".deps.") || entry.startsWith(".bundle."),
      ),
    ).toEqual([]);
    await expect(
      execFileAsync(fixture.launcher, ["version"], {
        env: fixture.environment,
      }),
    ).resolves.toMatchObject({ stdout: "linger-computer 1.2.3\n" });
  });

  it("keeps only the new and previous bundles and the dependencies they link", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    await runInstaller(fixture);
    const first = await activeBundleName(fixture.installRoot);
    const otherDeps = await writeDeps(fixture.root, {
      name: "deps-other",
      mutate: (staged) =>
        writeFile(path.join(staged, "computer-tools/other"), "other"),
    });
    await runInstaller({
      ...fixture,
      artifact: await writeArtifact(fixture.root, "1.2.4", { deps: otherDeps }),
    });
    const second = await activeBundleName(fixture.installRoot);
    await runInstaller({ ...fixture, artifact: sharedArtifact("1.2.4") });
    const third = await activeBundleName(fixture.installRoot);

    const entries = await readdir(fixture.installRoot);
    expect(entries.filter((entry) => entry.startsWith("lib-")).sort()).toEqual(
      [second, third].sort(),
    );
    expect(entries.filter((entry) => entry.startsWith("deps-")).sort()).toEqual(
      [
        `deps-${otherDeps.depsSha256.slice(0, 16)}`,
        `deps-${sharedArtifact("1.2.4").depsSha256.slice(0, 16)}`,
      ].sort(),
    );
    expect(entries).not.toContain(first);
  }, 30_000);

  it("retries an interrupted HTTP archive download", async ({ expect }) => {
    const fixture = await installerFixture("1.2.3");
    const server = await releaseServer(fixture.artifact!, {
      appFailures: 1,
      depsFailures: 1,
    });

    try {
      await runInstaller({
        ...fixture,
        artifact: undefined,
        installerPath: await renderInstaller(fixture.root, fixture.artifact!),
        environment: { ...fixture.environment, LINGER_WEB_URL: server.origin },
      });

      expect(server.requests).toEqual({ app: 2, deps: 2 });
      await expect(
        execFileAsync(
          serverEnvironment(fixture, server).launcher,
          ["version"],
          {
            env: fixture.environment,
          },
        ),
      ).resolves.toMatchObject({ stdout: "linger-computer 1.2.3\n" });
    } finally {
      await server.close();
    }
  });

  it("bounds interrupted HTTP retries and preserves the installed release", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    const upgrade = await writeArtifact(fixture.root, "1.2.4", {
      deps: fixture.artifact,
    });
    const server = await releaseServer(upgrade, {
      appFailures: Number.POSITIVE_INFINITY,
    });

    try {
      await runInstaller({
        ...fixture,
        environment: { ...fixture.environment, LINGER_WEB_URL: server.origin },
      });
      await expect(
        runInstaller({
          ...fixture,
          artifact: undefined,
          installerPath: await renderInstaller(fixture.root, upgrade),
          environment: {
            ...fixture.environment,
            LINGER_WEB_URL: server.origin,
          },
        }),
      ).rejects.toMatchObject({
        stderr: expect.stringMatching(
          /transfer closed|end of response with \d+ bytes missing/,
        ),
      });

      // One attempt plus five curl retries with exponential backoff (~31s).
      expect(server.requests.app).toBe(6);
      await expect(
        execFileAsync(
          serverEnvironment(fixture, server).launcher,
          ["version"],
          {
            env: fixture.environment,
          },
        ),
      ).resolves.toMatchObject({ stdout: "linger-computer 1.2.3\n" });
    } finally {
      await server.close();
    }
  }, 120_000);

  it("uninstalls one environment and keeps the others reachable", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    const otherOrigin = "https://other-linger.example.test";
    const other = environmentOf(fixture, "other");
    await runInstaller(fixture);
    await runInstaller({
      ...fixture,
      environment: { ...fixture.environment, LINGER_WEB_URL: otherOrigin },
    });

    const result = await execFileAsync("bash", [uninstaller], {
      env: { ...fixture.environment, LINGER_WEB_URL: otherOrigin },
    });

    expect(result.stdout).toContain(
      `Uninstalled linger-computer-other (${otherOrigin}).`,
    );
    await expect(stat(other.launcher)).rejects.toThrow();
    await expect(
      readFile(path.join(other.installRoot, "web-origin"), "utf8"),
    ).resolves.toBe(`${otherOrigin}\n`);
    for (const command of [fixture.launcher, fixture.dispatcher]) {
      await expect(
        execFileAsync(command, ["version"], { env: fixture.environment }),
      ).resolves.toMatchObject({ stdout: "linger-computer 1.2.3\n" });
    }
  });

  it("uninstalls the executable while preserving data unless purge is explicit", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    await runInstaller(fixture);
    const preservedFiles = new Map([
      ["config.json", "{}"],
      ["runner-token", "credential"],
      ["state/operation-ledger.json", "state"],
      ["logs/computer.log", "logs"],
    ]);
    for (const [relativePath, content] of preservedFiles) {
      const filePath = path.join(fixture.installRoot, relativePath);
      await mkdir(path.dirname(filePath), { recursive: true, mode: 0o755 });
      await writeFile(filePath, content, { mode: 0o600 });
    }

    await execFileAsync("bash", [uninstaller], { env: fixture.environment });

    await expect(stat(fixture.launcher)).rejects.toThrow();
    await expect(stat(fixture.dispatcher)).rejects.toThrow();
    expect(
      (await readdir(fixture.installRoot)).filter(
        (entry) =>
          entry.startsWith("lib-") ||
          entry.startsWith("deps-") ||
          entry === "active-bundle",
      ),
    ).toEqual([]);
    for (const [relativePath, content] of preservedFiles) {
      await expect(
        readFile(path.join(fixture.installRoot, relativePath), "utf8"),
      ).resolves.toBe(content);
    }

    await execFileAsync("bash", [uninstaller, "--purge"], {
      env: fixture.environment,
    });
    await expect(stat(fixture.installRoot)).rejects.toThrow();
  });

  it("rejects a group-readable config without changing the installation", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    await runInstaller(fixture);
    const configPath = path.join(fixture.installRoot, "config.json");
    await writeFile(configPath, "{}", { mode: 0o644 });
    await chmod(configPath, 0o644);

    await expect(
      execFileAsync("bash", [uninstaller], { env: fixture.environment }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("not a safe owner-only regular file"),
    });

    await expect(stat(fixture.launcher)).resolves.toBeDefined();
    expect((await lstat(configPath)).mode & 0o777).toBe(0o644);
  });

  it("rejects a symlink config without changing the installation", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    await runInstaller(fixture);
    const target = path.join(fixture.root, "config-target.json");
    await writeFile(target, "{}", { mode: 0o600 });
    await symlink(target, path.join(fixture.installRoot, "config.json"));

    await expect(
      execFileAsync("bash", [uninstaller], { env: fixture.environment }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("not a safe owner-only regular file"),
    });

    await expect(stat(fixture.launcher)).resolves.toBeDefined();
    expect((await lstat(target)).mode & 0o777).toBe(0o600);
  });

  it("rejects a hardlinked config without changing the installation", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    await runInstaller(fixture);
    const configPath = path.join(fixture.installRoot, "config.json");
    await writeFile(configPath, "{}", { mode: 0o644 });
    await chmod(configPath, 0o644);
    await link(configPath, path.join(fixture.root, "config-hardlink.json"));

    await expect(
      execFileAsync("bash", [uninstaller], { env: fixture.environment }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("not a safe owner-only regular file"),
    });

    await expect(stat(fixture.launcher)).resolves.toBeDefined();
    expect((await lstat(configPath)).mode & 0o777).toBe(0o644);
  });

  it("rejects a config owned by another uid without changing the installation", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    await runInstaller(fixture);
    const configPath = path.join(fixture.installRoot, "config.json");
    const preload = path.join(fixture.root, "different-uid.cjs");
    await writeFile(configPath, "{}", { mode: 0o644 });
    await chmod(configPath, 0o644);
    await writeFile(
      preload,
      `process.getuid = () => ${String(process.getuid!() + 1)};\n`,
    );

    await expect(
      execFileAsync("bash", [uninstaller], {
        env: {
          ...fixture.environment,
          LINGER_INSTALL_TEST_NODE_PRELOAD: preload,
        },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("not a safe owner-only regular file"),
    });

    await expect(stat(fixture.launcher)).resolves.toBeDefined();
    expect((await lstat(configPath)).mode & 0o777).toBe(0o644);
  });

  it("rejects a non-regular config without changing the installation", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    await runInstaller(fixture);
    await mkdir(path.join(fixture.installRoot, "config.json"));

    await expect(
      execFileAsync("bash", [uninstaller], { env: fixture.environment }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("not a safe owner-only regular file"),
    });

    await expect(stat(fixture.launcher)).resolves.toBeDefined();
  });

  it("uninstalls without a host Node", async ({ expect }) => {
    const fixture = await installerFixture("1.2.3");
    await runInstaller(fixture);

    await execFileAsync("bash", [uninstaller], {
      env: {
        ...fixture.environment,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      },
    });

    await expect(stat(fixture.launcher)).rejects.toThrow();
  });

  it("purges a newly installed but unconfigured Computer", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    await runInstaller(fixture);

    await execFileAsync("bash", [uninstaller, "--purge"], {
      env: {
        ...fixture.environment,
        LINGER_INSTALL_TEST_UNCONFIGURED: "1",
      },
    });

    await expect(stat(fixture.launcher)).rejects.toThrow();
    await expect(stat(fixture.installRoot)).rejects.toThrow();
    await expect(stat(fixture.invocations)).rejects.toThrow();
  });

  it("stops and confirms a running daemon before deleting installed files", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    await runInstaller(fixture);
    await writeFile(
      fixture.environment.LINGER_INSTALL_TEST_RUNNING!,
      "running",
    );

    await execFileAsync("bash", [uninstaller], {
      env: fixture.environment,
    });

    expect(await readFile(fixture.invocations, "utf8")).toContain("stop\n");
    await expect(stat(fixture.launcher)).rejects.toThrow();
  }, 30_000);

  it("recovers identity-owned processes even when an old CLI falsely reports stopped", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    await runInstaller(fixture);
    const stateDirectory = path.join(fixture.installRoot, "state");
    const runnerDirectory = path.join(stateDirectory, "runner-processes");
    await mkdir(path.join(stateDirectory, "daemon.lock"), {
      recursive: true,
      mode: 0o700,
    });
    await mkdir(runnerDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(fixture.installRoot, "config.json"),
      JSON.stringify({ state_directory: stateDirectory }),
      { mode: 0o600 },
    );
    const daemon = await spawnOwnedFixtureProcess();
    const ownerToken = createHash("sha256")
      .update(await realpath(stateDirectory))
      .digest("hex");
    const ownerArgument = `--linger-computer-owner=${ownerToken}`;
    const runner = await spawnOwnedFixtureProcess(ownerArgument);
    try {
      await writeFile(
        path.join(stateDirectory, "daemon.lock", "owner.json"),
        JSON.stringify({ ...daemon.identity, nonce: "legacy-cli" }),
        { mode: 0o600 },
      );
      await writeFile(
        path.join(runnerDirectory, "runner.json"),
        JSON.stringify({
          version: 1,
          ownerToken,
          identity: runner.identity,
        }),
        { mode: 0o600 },
      );

      await execFileAsync("bash", [uninstaller, "--purge"], {
        env: fixture.environment,
      });

      await expectProcessMissing(expect, daemon.identity);
      await expectProcessMissing(expect, runner.identity);
      await expect(stat(fixture.installRoot)).rejects.toThrow();
    } finally {
      await Promise.all(
        [daemon.identity, runner.identity].map((identity) =>
          terminateFixtureProcess(identity).catch(() => undefined),
        ),
      );
    }
  }, 30_000);

  it("enumerates Linux proc entries without racy Dirent lstat calls", async ({
    expect,
  }) => {
    const source = await readFile(uninstaller, "utf8");

    expect(source).toContain(
      'for (const entryName of fs.readdirSync("/proc"))',
    );
    expect(source).not.toContain(
      'fs.readdirSync("/proc", { withFileTypes: true })',
    );
  });

  it("recovers owned processes before purging an unconfigured Computer", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    await runInstaller(fixture);
    const stateDirectory = path.join(fixture.installRoot, "state");
    const runnerDirectory = path.join(stateDirectory, "runner-processes");
    await mkdir(path.join(stateDirectory, "daemon.lock"), {
      recursive: true,
      mode: 0o700,
    });
    await mkdir(runnerDirectory, { recursive: true, mode: 0o700 });
    const daemon = await spawnOwnedFixtureProcess();
    const ownerToken = createHash("sha256")
      .update(await realpath(stateDirectory))
      .digest("hex");
    const runner = await spawnOwnedFixtureProcess(
      `--linger-computer-owner=${ownerToken}`,
    );
    try {
      await writeFile(
        path.join(stateDirectory, "daemon.lock", "owner.json"),
        JSON.stringify({ ...daemon.identity, nonce: "unconfigured" }),
        { mode: 0o600 },
      );
      await writeFile(
        path.join(runnerDirectory, "runner.json"),
        JSON.stringify({
          version: 1,
          ownerToken,
          identity: runner.identity,
        }),
        { mode: 0o600 },
      );

      await execFileAsync("bash", [uninstaller, "--purge"], {
        env: {
          ...fixture.environment,
          LINGER_INSTALL_TEST_UNCONFIGURED: "1",
        },
      });

      await expectProcessMissing(expect, daemon.identity);
      await expectProcessMissing(expect, runner.identity);
      await expect(stat(fixture.installRoot)).rejects.toThrow();
    } finally {
      await Promise.all(
        [daemon.identity, runner.identity].map((identity) =>
          terminateFixtureProcess(identity).catch(() => undefined),
        ),
      );
    }
  }, 30_000);

  it.for(["symlink", "hardlink", "mode", "schema", "runner-schema"])(
    "rejects an unsafe %s ownership record without terminating its process",
    { timeout: 30_000 },
    async (variant, { expect }) => {
      const fixture = await installerFixture("1.2.3");
      await runInstaller(fixture);
      const stateDirectory = path.join(fixture.installRoot, "state");
      const lockDirectory = path.join(stateDirectory, "daemon.lock");
      const runnerDirectory = path.join(stateDirectory, "runner-processes");
      await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
      await mkdir(runnerDirectory, { recursive: true, mode: 0o700 });
      await writeFile(
        path.join(fixture.installRoot, "config.json"),
        JSON.stringify({ state_directory: stateDirectory }),
        { mode: 0o600 },
      );
      const owned = await spawnOwnedFixtureProcess();
      const ownerPath = path.join(lockDirectory, "owner.json");
      const owner = { ...owned.identity, nonce: "unsafe-record" };
      try {
        if (variant === "symlink") {
          const target = path.join(fixture.root, "owner-target.json");
          await writeFile(target, JSON.stringify(owner), { mode: 0o600 });
          await symlink(target, ownerPath);
        } else {
          await writeFile(
            ownerPath,
            JSON.stringify(
              variant === "schema" ? { ...owner, unexpected: true } : owner,
            ),
            { mode: variant === "mode" ? 0o644 : 0o600 },
          );
          if (variant === "mode") await chmod(ownerPath, 0o644);
          if (variant === "hardlink") {
            await link(
              ownerPath,
              path.join(fixture.root, "owner-hardlink.json"),
            );
          }
        }
        if (variant === "runner-schema") {
          const ownerToken = createHash("sha256")
            .update(await realpath(stateDirectory))
            .digest("hex");
          await writeFile(
            path.join(runnerDirectory, "runner.json"),
            JSON.stringify({
              version: 1,
              ownerToken,
              identity: { ...owned.identity, unexpected: true },
            }),
            { mode: 0o600 },
          );
        }

        await expect(
          execFileAsync("bash", [uninstaller, "--purge"], {
            env: fixture.environment,
          }),
        ).rejects.toMatchObject({
          stderr: expect.stringContaining(
            "Unable to verify and stop all owned Computer processes",
          ),
        });

        await expectProcessPresent(expect, owned.identity);
        await expect(stat(fixture.launcher)).resolves.toBeDefined();
      } finally {
        await terminateFixtureProcess(owned.identity).catch(() => undefined);
      }
    },
  );

  it("preserves an installation when a stopped report hides a daemon that cannot stop", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    await runInstaller(fixture);
    const stateFile = path.join(fixture.installRoot, "state.json");
    await writeFile(stateFile, "state", { mode: 0o600 });

    await expect(
      execFileAsync("bash", [uninstaller, "--purge"], {
        env: {
          ...fixture.environment,
          LINGER_INSTALL_TEST_STOP_MODE: "fail",
        },
      }),
    ).rejects.toThrow();

    await expect(stat(fixture.launcher)).resolves.toBeDefined();
    await expect(
      stat(path.join(fixture.installRoot, "active-bundle")),
    ).resolves.toBeDefined();
    await expect(readFile(stateFile, "utf8")).resolves.toBe("state");
  });

  it("keeps the bundle and state when daemon stop fails", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    await runInstaller(fixture);
    await writeFile(
      fixture.environment.LINGER_INSTALL_TEST_RUNNING!,
      "running",
    );
    const stateFile = path.join(fixture.installRoot, "state.json");
    await writeFile(stateFile, "state", { mode: 0o600 });

    await expect(
      execFileAsync("bash", [uninstaller, "--purge"], {
        env: {
          ...fixture.environment,
          LINGER_INSTALL_TEST_STOP_MODE: "fail",
        },
      }),
    ).rejects.toThrow();

    await expect(stat(fixture.launcher)).resolves.toBeDefined();
    await expect(
      stat(path.join(fixture.installRoot, "active-bundle")),
    ).resolves.toBeDefined();
    await expect(readFile(stateFile, "utf8")).resolves.toBe("state");
  });

  it("preserves a running installation when its launcher is not executable", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    await runInstaller(fixture);
    await writeFile(
      fixture.environment.LINGER_INSTALL_TEST_RUNNING!,
      "running",
    );
    await chmod(fixture.launcher, 0o600);

    await expect(
      execFileAsync("bash", [uninstaller], { env: fixture.environment }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("launcher is not a safe executable"),
    });

    await expect(stat(fixture.launcher)).resolves.toBeDefined();
    await expect(
      stat(path.join(fixture.installRoot, "active-bundle")),
    ).resolves.toBeDefined();
    await expect(
      readFile(fixture.environment.LINGER_INSTALL_TEST_RUNNING!, "utf8"),
    ).resolves.toBe("running");
    await expect(readFile(fixture.invocations, "utf8")).rejects.toThrow();
  });

  it("keeps the bundle and state when stop does not reach stopped", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    await runInstaller(fixture);
    await writeFile(
      fixture.environment.LINGER_INSTALL_TEST_RUNNING!,
      "draining",
    );
    const stateFile = path.join(fixture.installRoot, "state.json");
    await writeFile(stateFile, "state", { mode: 0o600 });

    await expect(
      execFileAsync("bash", [uninstaller, "--purge"], {
        env: {
          ...fixture.environment,
          LINGER_INSTALL_TEST_STOP_MODE: "noop",
        },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("did not stop completely"),
    });

    await expect(stat(fixture.launcher)).resolves.toBeDefined();
    await expect(
      stat(path.join(fixture.installRoot, "active-bundle")),
    ).resolves.toBeDefined();
    await expect(readFile(stateFile, "utf8")).resolves.toBe("state");
  });

  it.for([
    {
      name: "an absolute path",
      archive: "deps",
      entries: [{ name: "/tmp/escape", type: "0", content: "x" }],
      error: "contains an unsafe path",
    },
    {
      name: "a parent path",
      archive: "app",
      entries: [{ name: "cli/../../escape", type: "0", content: "x" }],
      error: "contains an unsafe path",
    },
    {
      name: "a symbolic link",
      archive: "deps",
      entries: [{ name: "runtime", type: "2", linkname: "/usr" }],
      error: "only regular files and directories",
    },
    {
      name: "a character device",
      archive: "app",
      entries: [{ name: "daemon/device", type: "3" }],
      error: "only regular files and directories",
    },
  ] as const)(
    "rejects an archive containing $name",
    async ({ archive, entries, error }, { expect }) => {
      const fixture = await installerFixture("1.2.3");
      const hostile = path.join(fixture.root, `hostile-${archive}.tar.gz`);
      await writeRawTar(hostile, entries);
      const digest = sha256(await readFile(hostile));
      const release: Release =
        archive === "app"
          ? { ...fixture.artifact!, app: hostile, appSha256: digest }
          : {
              ...fixture.artifact!,
              deps: hostile,
              depsSha256: digest,
              depsSize: (await stat(hostile)).size,
            };

      await expect(
        runInstaller({ ...fixture, artifact: release }),
      ).rejects.toMatchObject({ stderr: expect.stringContaining(error) });
      const leftovers = await readdir(fixture.installRoot);
      expect(
        leftovers.filter(
          (entry) =>
            (archive === "deps" && entry.startsWith("deps-")) ||
            entry.startsWith("lib-") ||
            entry.startsWith("."),
        ),
      ).toEqual([]);
      await expect(stat(path.join(fixture.root, "escape"))).rejects.toThrow();
    },
  );

  it.for([
    "runtime/bin/node",
    "cli/computer-tools/manifest.json",
    "app-sha256",
  ])(
    "rejects an app archive that carries %s itself",
    async (entry, { expect }) => {
      const fixture = await installerFixture("1.2.3");
      const artifact = await writeArtifact(fixture.root, "1.2.4", {
        deps: fixture.artifact,
        mutate: async (staged) => {
          await mkdir(path.dirname(path.join(staged, entry)), {
            recursive: true,
          });
          await writeFile(path.join(staged, entry), "bundled");
        },
      });

      await expect(
        runInstaller({ ...fixture, artifact }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(
          "must not contain runtime, cli/computer-tools, or app-sha256",
        ),
      });
    },
  );

  it.for([
    ["runtime", "../deps-0000000000000000/runtime"],
    ["runtime", "/usr"],
    ["cli/computer-tools", "../../elsewhere/computer-tools"],
  ])(
    "refuses to run a bundle whose %s link points to %s",
    async ([entry, target], { expect }) => {
      const fixture = await installerFixture("1.2.3");
      await runInstaller(fixture);
      const installedBundle = await activeBundleName(fixture.installRoot);
      await rm(path.join(fixture.installRoot, installedBundle, entry));
      await symlink(
        target,
        path.join(fixture.installRoot, installedBundle, entry),
      );

      await expect(runInstaller(fixture)).rejects.toMatchObject({
        stderr: expect.stringContaining(
          "Installed bundle dependency links are unsafe",
        ),
      });
      expect(await activeBundleName(fixture.installRoot)).toBe(installedBundle);
    },
  );

  it("rejects artifacts containing vendored node_modules", async ({
    expect,
  }) => {
    const fixture = await installerFixture("1.2.3");
    const forbidden = await writeArtifact(fixture.root, "1.2.4", {
      mutate: async (staged) => {
        await mkdir(path.join(staged, "cli/node_modules/@openai/codex"), {
          recursive: true,
        });
      },
    });

    await expect(
      runInstaller({ ...fixture, artifact: forbidden }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("forbidden bundled content"),
    });
  });
});

// The Daemon runs the template from the verified app archive with these
// variables; it never passes the dependency archive itself.
const stageEnvironment = (
  release: Release,
  mode: string,
  options: { readonly archive?: boolean } = {},
) => ({
  LINGER_COMPUTER_INSTALL_STAGE_ONLY: mode,
  LINGER_COMPUTER_APP_SHA256: release.appSha256,
  ...(mode === "activate"
    ? {}
    : {
        ...(options.archive === false
          ? {}
          : { LINGER_COMPUTER_APP_ARCHIVE: release.app }),
        LINGER_COMPUTER_DEPS_SHA256: release.depsSha256,
        LINGER_COMPUTER_DEPS_SIZE: String(release.depsSize),
      }),
});

describe.concurrent(
  "linger-computer installer stage-only self-update",
  { timeout: 30_000 },
  () => {
    const installed = async () => {
      const fixture = await installerFixture("1.2.3");
      await runInstaller(fixture);
      const previousBundle = await activeBundleName(fixture.installRoot);
      // A busy Computer refuses an ordinary upgrade; staging never stops it.
      await writeFile(fixture.environment.LINGER_INSTALL_TEST_RUNNING!, "1");
      const environment = {
        ...fixture.environment,
        LINGER_INSTALL_TEST_ACTIVE_OPERATIONS: "1",
      };
      const stage = (
        release: Release,
        mode: string,
        extra: NodeJS.ProcessEnv = {},
      ) =>
        execFileAsync("bash", [installer], {
          env: { ...environment, ...stageEnvironment(release, mode), ...extra },
        });
      return { ...fixture, environment, previousBundle, stage };
    };
    const readMarker = async (installRoot: string) =>
      JSON.parse(
        await readFile(path.join(installRoot, "upgrade-pending"), "utf8"),
      ) as Record<string, unknown>;
    const expectNoLifecycleCommands = async (
      expect: ExpectStatic,
      invocations: string,
    ) => {
      const commands = (await readFile(invocations, "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean);
      expect(commands).not.toContain("stop");
      expect(commands).not.toContain("start");
    };

    it("upgrades a custom installation without redirecting the default launcher", async ({
      expect,
    }) => {
      const fixture = await installed();
      const root = path.join(fixture.root, "isolated data");
      const bin = path.join(fixture.root, "isolated bin");
      const launcher = path.join(bin, path.basename(fixture.launcher));
      await rm(fixture.environment.LINGER_INSTALL_TEST_RUNNING!);
      await runInstaller({
        ...fixture,
        environment: {
          ...fixture.environment,
          LINGER_COMPUTER_DATA_DIR: root,
          LINGER_COMPUTER_BIN_DIR: bin,
        },
      });
      const upgrade = sharedArtifact("1.2.4");
      for (const mode of ["prepare", "activate"]) {
        await fixture.stage(upgrade, mode, { LINGER_COMPUTER_DATA_DIR: root });
      }
      for (const [command, version] of [
        [fixture.launcher, "1.2.3"],
        [launcher, "1.2.4"],
      ] as const) {
        await expect(
          execFileAsync(command, ["version"], { env: fixture.environment }),
        ).resolves.toMatchObject({ stdout: `linger-computer ${version}\n` });
      }
    });

    it("switches in one run without stopping or starting the running Computer", async ({
      expect,
    }) => {
      const fixture = await installed();
      const upgrade = sharedArtifact("1.2.4");

      await fixture.stage(upgrade, "1");

      const activeBundle = await activeBundleName(fixture.installRoot);
      expect(activeBundle).toMatch(
        new RegExp(`^lib-${upgrade.appSha256.slice(0, 16)}-`, "u"),
      );
      await expect(readMarker(fixture.installRoot)).resolves.toEqual({
        previous_bundle: fixture.previousBundle,
        target_app_sha256: upgrade.appSha256,
        created_at: expect.stringMatching(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u,
        ),
      });
      expect(
        (await stat(path.join(fixture.installRoot, "upgrade-pending"))).mode &
          0o777,
      ).toBe(0o600);
      await expectNoLifecycleCommands(expect, fixture.invocations);
      await expect(
        stat(path.join(fixture.installRoot, fixture.previousBundle)),
      ).resolves.toBeDefined();
      await expect(
        execFileAsync(fixture.launcher, ["version"], {
          env: fixture.environment,
        }),
      ).resolves.toMatchObject({ stdout: "linger-computer 1.2.4\n" });
    });

    it("prepares a staged bundle without changing the installation and reuses it", async ({
      expect,
    }) => {
      const fixture = await installed();
      const upgrade = await writeArtifact(fixture.root, "1.2.4", {
        deps: fixture.artifact,
      });
      const before = await readdir(fixture.installRoot);

      await fixture.stage(upgrade, "prepare");

      await expect(activeBundleName(fixture.installRoot)).resolves.toBe(
        fixture.previousBundle,
      );
      await expect(
        readFile(
          path.join(fixture.installRoot, "staged-upgrade/app-sha256"),
          "utf8",
        ),
      ).resolves.toBe(`${upgrade.appSha256}\n`);
      expect(
        (await readdir(fixture.installRoot)).filter(
          (entry) => !before.includes(entry),
        ),
      ).toEqual(["staged-upgrade"]);
      await expect(
        stat(path.join(fixture.installRoot, "upgrade-pending")),
      ).rejects.toThrow();
      await expectNoLifecycleCommands(expect, fixture.invocations);
      await expect(
        execFileAsync(fixture.launcher, ["version"], {
          env: fixture.environment,
        }),
      ).resolves.toMatchObject({ stdout: "linger-computer 1.2.3\n" });

      // A prepared build is reused without reading the archive again.
      await rm(upgrade.app);
      await fixture.stage(upgrade, "prepare");
      await expect(
        readFile(
          path.join(fixture.installRoot, "staged-upgrade/app-sha256"),
          "utf8",
        ),
      ).resolves.toBe(`${upgrade.appSha256}\n`);
    });

    it("activates the prepared bundle offline and records the rollback marker", async ({
      expect,
    }) => {
      const fixture = await installed();
      const upgrade = sharedArtifact("1.2.4");
      await fixture.stage(upgrade, "prepare");

      await fixture.stage(upgrade, "activate", {
        // Nothing may be fetched: an unreachable origin would fail a download.
        // The Daemon names its install root, as it does for every self-update.
        LINGER_WEB_URL: "https://unreachable.invalid",
        LINGER_COMPUTER_DATA_DIR: fixture.installRoot,
      });

      expect(await activeBundleName(fixture.installRoot)).not.toBe(
        fixture.previousBundle,
      );
      await expect(readMarker(fixture.installRoot)).resolves.toMatchObject({
        previous_bundle: fixture.previousBundle,
        target_app_sha256: upgrade.appSha256,
      });
      await expect(
        stat(path.join(fixture.installRoot, "staged-upgrade")),
      ).rejects.toThrow();
      await expectNoLifecycleCommands(expect, fixture.invocations);
      await expect(
        execFileAsync(fixture.launcher, ["version"], {
          env: fixture.environment,
        }),
      ).resolves.toMatchObject({ stdout: "linger-computer 1.2.4\n" });
    });

    it.for(["missing", "another build", "broken links"] as const)(
      "refuses to activate when the staged bundle is %s",
      async (state, { expect }) => {
        const fixture = await installed();
        const upgrade = sharedArtifact("1.2.4");
        if (state !== "missing") {
          await fixture.stage(upgrade, "prepare");
        }
        if (state === "broken links") {
          await rm(path.join(fixture.installRoot, "staged-upgrade/runtime"));
          await symlink(
            "/usr",
            path.join(fixture.installRoot, "staged-upgrade/runtime"),
          );
        }
        const requested =
          state === "another build" ? sharedArtifact("1.2.3") : upgrade;

        await expect(
          fixture.stage(requested, "activate"),
        ).rejects.toMatchObject({
          stderr: expect.stringContaining("nothing was switched"),
        });
        await expect(activeBundleName(fixture.installRoot)).resolves.toBe(
          fixture.previousBundle,
        );
        await expect(
          stat(path.join(fixture.installRoot, "upgrade-pending")),
        ).rejects.toThrow();
      },
    );

    it("restores the previous bundle and removes the marker when activation fails after the switch", async ({
      expect,
    }) => {
      const fixture = await installed();
      const upgrade = sharedArtifact("1.2.4");
      await fixture.stage(upgrade, "prepare");

      await expect(
        fixture.stage(upgrade, "activate", {
          LINGER_INSTALL_TEST_FAIL_AFTER_METADATA_WRITE: "web-origin",
        }),
      ).rejects.toBeDefined();

      await expect(activeBundleName(fixture.installRoot)).resolves.toBe(
        fixture.previousBundle,
      );
      await expect(
        stat(path.join(fixture.installRoot, "upgrade-pending")),
      ).rejects.toThrow();
    });

    it("stages again after the Daemon rolled back to the marker's previous bundle", async ({
      expect,
    }) => {
      const fixture = await installed();
      const previousDeps = await readlink(
        path.join(fixture.installRoot, fixture.previousBundle, "runtime"),
      );
      const otherDeps = await writeDeps(fixture.root, {
        name: "deps-next",
        mutate: (staged) =>
          writeFile(path.join(staged, "computer-tools/next"), "next"),
      });
      const upgrade = await writeArtifact(fixture.root, "1.2.4", {
        deps: otherDeps,
      });
      await fixture.stage(upgrade, "1", {
        LINGER_COMPUTER_DEPS_ARCHIVE: otherDeps.deps,
      });
      // The Daemon's rollback: active-bundle back to previous_bundle, marker gone.
      const marker = await readMarker(fixture.installRoot);
      await writeFile(
        path.join(fixture.installRoot, "active-bundle"),
        `${String(marker.previous_bundle)}\n`,
        { mode: 0o600 },
      );
      await rm(path.join(fixture.installRoot, "upgrade-pending"));
      await expect(
        stat(
          path.join(
            fixture.installRoot,
            fixture.previousBundle,
            path.dirname(previousDeps),
            ".sha256",
          ),
        ),
      ).resolves.toBeDefined();

      await fixture.stage(sharedArtifact("1.2.4"), "1");

      await expect(readMarker(fixture.installRoot)).resolves.toMatchObject({
        previous_bundle: fixture.previousBundle,
        target_app_sha256: sharedArtifact("1.2.4").appSha256,
      });
      await expect(
        execFileAsync(fixture.launcher, ["version"], {
          env: fixture.environment,
        }),
      ).resolves.toMatchObject({ stdout: "linger-computer 1.2.4\n" });
    });

    it("refuses to stage over an installation it cannot roll back to", async ({
      expect,
    }) => {
      const fixture = await installed();
      await rm(
        path.join(fixture.installRoot, fixture.previousBundle, "app-sha256"),
      );

      await expect(
        fixture.stage(sharedArtifact("1.2.4"), "1"),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(
          "The installed Computer bundle could not be verified",
        ),
      });
      await expect(activeBundleName(fixture.installRoot)).resolves.toBe(
        fixture.previousBundle,
      );
    });

    it.for([
      [
        { LINGER_COMPUTER_INSTALL_STAGE_ONLY: "prepare" },
        "requires LINGER_COMPUTER_APP_SHA256",
      ],
      [
        { LINGER_COMPUTER_INSTALL_STAGE_ONLY: "activate" },
        "requires LINGER_COMPUTER_APP_SHA256",
      ],
      [
        { LINGER_COMPUTER_INSTALL_STAGE_ONLY: "2" },
        "must be 0, 1, prepare, or activate",
      ],
      [
        {
          LINGER_COMPUTER_APP_ARCHIVE: "relative/app.tar.gz",
          LINGER_COMPUTER_APP_SHA256: "a".repeat(64),
        },
        "must be absolute paths given with their SHA256",
      ],
    ])(
      "rejects the invalid request %j",
      async ([variables, message], { expect }) => {
        const fixture = await installerFixture("1.2.3");
        await expect(
          execFileAsync("bash", [installer], {
            env: { ...fixture.environment, ...variables },
          }),
        ).rejects.toMatchObject({ stderr: expect.stringContaining(message) });
      },
    );
  },
);

const sha256 = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");

const sharedArtifact = (version: SharedArtifactVersion): Release => {
  const artifact = sharedArtifacts.get(version);
  if (!artifact) {
    throw new Error(`Shared installer artifact ${version} is not initialized`);
  }
  return artifact;
};

/** The install root and command the installer gives an environment. */
const environmentOf = (fixture: { readonly home: string }, name: string) => ({
  installRoot: path.join(fixture.home, ".local/share/linger/computers", name),
  launcher: path.join(fixture.home, ".local/bin", `linger-computer-${name}`),
});

/** The environment of a test release server's loopback origin. */
const serverEnvironment = (
  fixture: { readonly home: string },
  server: { readonly origin: string },
) => environmentOf(fixture, `local-${new URL(server.origin).port}`);

const installerFixture = async (
  version: SharedArtifactVersion,
  options: { readonly privateArtifact?: boolean } = {},
) => {
  const startedAt = performance.now();
  try {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "linger-installer-test-"),
    );
    temporaryRoots.push(root);
    const home = path.join(root, "home");
    const invocations = path.join(root, "invocations.log");
    const artifact: Release | undefined = options.privateArtifact
      ? await writeArtifact(root, version, { deps: await writeDeps(root) })
      : sharedArtifact(version);
    return {
      root,
      home,
      artifact,
      invocations,
      // The default origin, http://localhost:3000, is the local-3000 environment.
      installRoot: path.join(home, ".local/share/linger/computers/local-3000"),
      launcher: path.join(home, ".local/bin/linger-computer-local-3000"),
      dispatcher: path.join(home, ".local/bin/linger-computer"),
      environment: {
        ...process.env,
        HOME: home,
        LINGER_INSTALL_TEST_HOST_NODE: process.execPath,
        LINGER_INSTALL_TEST_INVOCATIONS: invocations,
        LINGER_INSTALL_TEST_NODE_INVOCATIONS: path.join(
          root,
          "node-invocations",
        ),
        LINGER_INSTALL_TEST_RUNNING: path.join(root, "running"),
      } as NodeJS.ProcessEnv,
    };
  } finally {
    recordProfile("fixture", startedAt);
  }
};

const packDirectory = async (directory: string, archive: string) => {
  const archiveStartedAt = performance.now();
  try {
    await execFileAsync("tar", ["-czf", archive, "-C", directory, "."]);
  } finally {
    recordProfile("archive", archiveStartedAt);
  }
  const checksumStartedAt = performance.now();
  try {
    const bytes = await readFile(archive);
    return { sha256: sha256(bytes), size: bytes.length };
  } finally {
    recordProfile("checksum", checksumStartedAt);
  }
};

// writeDeps builds a dependency archive: the fixture Node shim and the tool
// directory the bundle links to.
const writeDeps = async (
  root: string,
  options: {
    readonly name?: string;
    readonly runtimeLoaderError?: string;
    readonly mutate?: (staged: string) => Promise<void>;
  } = {},
): Promise<Omit<Release, "app" | "appSha256">> => {
  const name = options.name ?? "deps";
  const staged = path.join(root, `staged-${name}`);
  await mkdir(path.join(staged, "runtime", "bin"), { recursive: true });
  await mkdir(path.join(staged, "computer-tools"), { recursive: true });
  await writeFile(
    path.join(staged, "runtime/bin/node"),
    `#!/bin/sh
printf '%s\\n' "$0" >> "$LINGER_INSTALL_TEST_NODE_INVOCATIONS"
${
  options.runtimeLoaderError
    ? `printf '%s\\n' ${JSON.stringify(options.runtimeLoaderError)} >&2
exit 127`
    : ""
}
if [ -n "\${LINGER_INSTALL_TEST_NODE_PRELOAD:-}" ]; then
  exec "$LINGER_INSTALL_TEST_HOST_NODE" --require "$LINGER_INSTALL_TEST_NODE_PRELOAD" "$@"
fi
exec "$LINGER_INSTALL_TEST_HOST_NODE" "$@"
`,
    { mode: 0o755 },
  );
  await writeFile(
    path.join(staged, "runtime/LICENSE"),
    "Fixture Node runtime license\n",
  );
  await writeFile(
    path.join(staged, "computer-tools/manifest.json"),
    '{"schema_version":1}\n',
  );
  await options.mutate?.(staged);
  const deps = path.join(root, `${name}.tar.gz`);
  const { sha256: depsSha256, size } = await packDirectory(staged, deps);
  return { deps, depsSha256, depsSize: size };
};

const writeArtifact = async (
  root: string,
  version: string,
  options: {
    readonly deps?: Omit<Release, "app" | "appSha256">;
    readonly cliSource?: string;
    readonly extraFileContent?: string;
    readonly failAfterInstall?: boolean;
    readonly brokenCommand?: "help" | "status";
    readonly mutate?: (staged: string) => Promise<void>;
  } = {},
): Promise<Release> => {
  const startedAt = performance.now();
  try {
    const staged = await mkdtemp(path.join(root, `staged-${version}-`));
    await mkdir(path.join(staged, "cli"), { recursive: true });
    await mkdir(path.join(staged, "daemon"), { recursive: true });
    await mkdir(path.join(staged, "installer"), { recursive: true });
    await mkdir(path.join(staged, "licenses", "linger"), {
      recursive: true,
    });
    const source =
      options.cliSource ??
      `#!/usr/bin/env node
import { existsSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
// Like the bundled CLI, fail when started without a working directory.
process.cwd();
if (process.argv[2] === "daemon") {
  if (process.argv[3] === "--help") { process.stdout.write("daemon usage\\n"); process.exit(0); }
  process.argv.splice(2, 1);
} else if (["status", "stop", "start"].includes(process.argv[2])) { process.stderr.write("Unknown command: " + process.argv.slice(2).join(" ") + "\\n"); process.exit(2); }
const command = process.argv[2] ?? "help";
const log = process.env.LINGER_INSTALL_TEST_INVOCATIONS;
const marker = process.env.LINGER_INSTALL_TEST_RUNNING;
if (command === "version") {
  const blockingVersion = process.env.LINGER_INSTALL_TEST_BLOCKING_VERSION;
  if (blockingVersion && import.meta.url.includes("/.bundle.")) {
    writeFileSync(blockingVersion, "ready");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
  }
  ${options.failAfterInstall ? 'if (import.meta.url.includes("/lib-")) process.exit(1);' : ""}
  process.stdout.write("linger-computer ${version}\\n");
}
else if (command === "status" && process.argv.includes("--json")) { ${options.brokenCommand === "status" ? "process.exit(13);" : 'if (process.env.LINGER_INSTALL_TEST_UNCONFIGURED === "1" || process.env.LINGER_INSTALL_TEST_MALFORMED_CONFIG === "1") { process.stdout.write(JSON.stringify({ version: 1, config: { configured: process.env.LINGER_INSTALL_TEST_UNCONFIGURED !== "1", path: "/unused/config.json" }, daemon: { state: "error" }, runtimes: [], runners: [], error: { category: "configuration", message: "Local Computer configuration is unavailable" } }) + "\\n"); process.exitCode = 10; } else { const recordedState = marker && existsSync(marker) ? readFileSync(marker, "utf8").trim() : "stopped"; process.stdout.write(JSON.stringify({ version: 1, daemon: { state: recordedState === "1" ? "running" : recordedState || "running", gateway_state: process.env.LINGER_INSTALL_TEST_GATEWAY_STATE || "connected", reconciled: process.env.LINGER_INSTALL_TEST_RECONCILED !== "0", active_operations: Number(process.env.LINGER_INSTALL_TEST_ACTIVE_OPERATIONS || 0) } }) + "\\n"); }'} }
else if (command === "help" || command === "--help") { ${options.brokenCommand === "help" ? "process.exit(12);" : 'process.stdout.write("linger-computer usage\\n");'} }
else if (command === "stop") {
  const stopArgs = process.argv.slice(3);
  if (log) appendFileSync(log, "stop\\nstop-args:" + stopArgs.join(" ") + "\\n");
  const activeFile = process.env.LINGER_INSTALL_TEST_ACTIVE_FILE;
  const activeOnStop = Number(process.env.LINGER_INSTALL_TEST_ACTIVE_OPERATIONS_ON_STOP || (activeFile && existsSync(activeFile) ? "1" : "0"));
  if (stopArgs.includes("--if-idle") && process.env.LINGER_INSTALL_TEST_NEW_IDLE_UNKNOWN === "1" && "${version}" === "1.2.4") { process.stderr.write("Idle state is unknown\\n"); process.exit(15); }
  if (stopArgs.includes("--if-idle") && activeOnStop > 0) { process.stderr.write("Cannot stop while " + activeOnStop + " Agent Operation is active\\n"); process.exit(5); }
  if (!stopArgs.includes("--if-idle") && activeOnStop > 0 && log) appendFileSync(log, "unsafe-active-stop\\n");
  if (process.env.LINGER_INSTALL_TEST_STOP_MODE === "fail") { process.stderr.write("simulated daemon stop failure\\n"); process.exit(1); }
  if (marker && process.env.LINGER_INSTALL_TEST_STOP_MODE !== "noop") rmSync(marker, { force: true });
}
else if (command === "start") {
  if (log) appendFileSync(log, "start\\n" + (process.env.LINGER_INSTALL_TEST_OBSERVE_START_VERSION === "1" ? "start-version:${version}\\n" : ""));
  if ("${version}" === "1.2.4" && process.env.LINGER_INSTALL_TEST_EXPECT_START_WEB_ORIGIN && readFileSync(new URL("../../web-origin", import.meta.url), "utf8").trim() !== process.env.LINGER_INSTALL_TEST_EXPECT_START_WEB_ORIGIN) { process.stderr.write("New Daemon saw incomplete install metadata\\n"); process.exit(18); }
  if (marker) writeFileSync(marker, "1");
  if ("${version}" === "1.2.4" && process.env.LINGER_INSTALL_TEST_ACTIVE_FILE) writeFileSync(process.env.LINGER_INSTALL_TEST_ACTIVE_FILE, "1");
}
else if (command === "login") { if (log) appendFileSync(log, "login:" + (process.env.LINGER_WEB_URL ?? "") + "\\n"); }
else process.exitCode = 1;
`;
    // The fixture CLI is a Node script behind the executable the installer
    // runs directly, as it runs the Go CLI.
    await writeFile(path.join(staged, "cli/linger-computer.mjs"), source);
    await writeFile(
      path.join(staged, "cli/linger-computer"),
      '#!/bin/sh\nexec "$LINGER_INSTALL_TEST_HOST_NODE" "$(dirname "$0")/linger-computer.mjs" "$@"\n',
      { mode: 0o755 },
    );
    await writeFile(
      path.join(staged, "daemon/linger-computer-daemon"),
      "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    );
    await copyFile(
      installer,
      path.join(staged, "installer/linger-computer.sh"),
    );
    if (options.extraFileContent) {
      await writeFile(
        path.join(staged, "artifact-marker.txt"),
        options.extraFileContent,
      );
    }
    await options.mutate?.(staged);
    const app = path.join(staged, "..", `${path.basename(staged)}.tar.gz`);
    const { sha256: appSha256 } = await packDirectory(staged, app);
    const { deps, depsSha256, depsSize } =
      options.deps ?? (await writeDeps(root));
    return { app, appSha256, deps, depsSha256, depsSize };
  } finally {
    recordProfile("artifact", startedAt);
  }
};

// releaseEnvironment hands the installer local archives and their digests.
const releaseEnvironment = (release: Release) => ({
  LINGER_COMPUTER_APP_ARCHIVE: release.app,
  LINGER_COMPUTER_APP_SHA256: release.appSha256,
  LINGER_COMPUTER_DEPS_ARCHIVE: release.deps,
  LINGER_COMPUTER_DEPS_SHA256: release.depsSha256,
  LINGER_COMPUTER_DEPS_SIZE: String(release.depsSize),
});

const runInstaller = async (fixture: {
  readonly artifact: Release | undefined;
  readonly environment: NodeJS.ProcessEnv;
  readonly installerPath?: string;
}) => {
  const startedAt = performance.now();
  try {
    return await execFileAsync("bash", [fixture.installerPath ?? installer], {
      env: {
        ...fixture.environment,
        ...(fixture.artifact ? releaseEnvironment(fixture.artifact) : {}),
      },
    });
  } finally {
    recordProfile("installer", startedAt);
  }
};

// renderInstaller writes the installer the way the Agent Service serves it:
// this platform's release row filled in.
const renderInstaller = async (root: string, release: Release) => {
  const variable = `release_${releaseTargetName.replace("-", "_")}`;
  const rendered = path.join(root, "rendered-installer.sh");
  const source = await readFile(installer, "utf8");
  if (!source.includes(`\n${variable}=""\n`)) {
    throw new Error(`installer has no ${variable} placeholder`);
  }
  await writeFile(
    rendered,
    source.replace(
      `\n${variable}=""\n`,
      `\n${variable}="${release.appSha256} ${(await stat(release.app)).size} ${release.depsSha256} ${release.depsSize}"\n`,
    ),
    { mode: 0o755 },
  );
  return rendered;
};

// releaseServer serves a release under /install/files/ the way the Agent
// Service does. The first appFailures app downloads and depsFailures deps
// downloads are cut off halfway.
const releaseServer = async (
  release: Release,
  options: {
    readonly appFailures?: number;
    readonly depsFailures?: number;
  } = {},
) => {
  const files = new Map([
    [
      `/install/files/app-${releaseTargetName}-${release.appSha256}.tar.gz`,
      { kind: "app" as const, bytes: await readFile(release.app) },
    ],
    [
      `/install/files/deps-${releaseTargetName}-${release.depsSha256}.tar.gz`,
      { kind: "deps" as const, bytes: await readFile(release.deps) },
    ],
  ]);
  const requests = { app: 0, deps: 0 };
  const server = createServer((request, response) => {
    const file = files.get(request.url ?? "");
    if (!file) {
      response.writeHead(404).end();
      return;
    }
    requests[file.kind] += 1;
    const failures =
      (file.kind === "app" ? options.appFailures : options.depsFailures) ?? 0;
    response.writeHead(200, {
      "content-length": String(file.bytes.length),
      "content-type": "application/gzip",
    });
    if (requests[file.kind] <= failures) {
      response.write(
        file.bytes.subarray(0, Math.ceil(file.bytes.length / 2)),
        () => response.destroy(),
      );
      return;
    }
    response.end(file.bytes);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Installer release server did not bind to a TCP port");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
};

// tarEntry is one raw ustar entry for archives tar itself will not create.
interface TarEntry {
  readonly name: string;
  readonly type: "0" | "2" | "3" | "5";
  readonly content?: string;
  readonly linkname?: string;
}

const writeRawTar = async (file: string, entries: readonly TarEntry[]) => {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? "");
    const header = Buffer.alloc(512);
    const field = (value: string, offset: number, length: number) =>
      header.write(value, offset, length, "utf8");
    const octal = (value: number, offset: number, length: number) =>
      field(value.toString(8).padStart(length - 1, "0") + "\0", offset, length);
    field(entry.name, 0, 100);
    octal(entry.type === "5" ? 0o755 : 0o644, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(entry.type === "0" ? content.length : 0, 124, 12);
    octal(946684800, 136, 12);
    header.fill(" ", 148, 156);
    field(entry.type, 156, 1);
    field(entry.linkname ?? "", 157, 100);
    field("ustar\0", 257, 6);
    field("00", 263, 2);
    if (entry.type === "3") {
      octal(1, 329, 8);
      octal(3, 337, 8);
    }
    let checksum = 0;
    for (const byte of header) checksum += byte;
    field(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    blocks.push(header);
    if (entry.type === "0") {
      blocks.push(content, Buffer.alloc((512 - (content.length % 512)) % 512));
    }
  }
  blocks.push(Buffer.alloc(1024));
  await writeFile(file, gzipSync(Buffer.concat(blocks)));
};

const waitForFile = async (filePath: string): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await stat(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
};

const spawnOwnedFixtureProcess = async (
  ownerArgument?: string,
): Promise<{ child: ChildProcess; identity: ProcessIdentity }> => {
  const args = ["-e", "setInterval(() => undefined, 1000)"];
  if (ownerArgument) args.push("--", ownerArgument);
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
  });
  await Promise.race([
    once(child, "spawn"),
    once(child, "error").then(([error]) => Promise.reject(error)),
  ]);
  if (!child.pid) throw new Error("Fixture process did not expose a PID");
  child.unref();
  const inspected = await inspectProcessIdentity(child.pid);
  if (!inspected) throw new Error("Fixture process identity is unavailable");
  // Ownership records hold exactly these keys, like the ones the Daemon writes.
  const { pid, processGroupId, startTime } = inspected;
  return { child, identity: { pid, processGroupId, startTime } };
};

const expectProcessMissing = async (
  expect: ExpectStatic,
  expected: ProcessIdentity,
): Promise<void> => {
  const current = await inspectProcessIdentity(expected.pid);
  expect(
    current?.pid === expected.pid &&
      current.processGroupId === expected.processGroupId &&
      current.startTime === expected.startTime,
  ).toBe(false);
};

const expectProcessPresent = async (
  expect: ExpectStatic,
  expected: ProcessIdentity,
): Promise<void> => {
  const current = await inspectProcessIdentity(expected.pid);
  expect(current).toMatchObject({
    pid: expected.pid,
    processGroupId: expected.processGroupId,
    startTime: expected.startTime,
  });
};

const activeBundleName = async (installRoot: string): Promise<string> =>
  (await readFile(path.join(installRoot, "active-bundle"), "utf8")).trim();

const recursiveEntries = async (
  root: string,
  prefix = "",
): Promise<string[]> => {
  const entries = await readdir(path.join(root, prefix), {
    withFileTypes: true,
  });
  const values: string[] = [];
  for (const entry of entries) {
    const relative = path.join(prefix, entry.name);
    values.push(relative);
    if (entry.isDirectory()) {
      values.push(...(await recursiveEntries(root, relative)));
    }
  }
  return values;
};
