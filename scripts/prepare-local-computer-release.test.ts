import { execFile } from "node:child_process";
import { createServer } from "node:http";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseReleaseArguments,
  prepareLocalComputerRelease,
} from "./prepare-local-computer-release.mjs";
import {
  NODE_RUNTIME_RELEASES,
  NODE_RUNTIME_VERSION,
} from "./local-computer-node-distributions.mjs";
import { stageFixtureComputerTools } from "./test-support/computer-tool-assets";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sourceInstallerPath = path.join(
  repositoryRoot,
  "scripts/install-linger-computer.sh",
);
const sourceUninstallerPath = path.join(
  repositoryRoot,
  "scripts/uninstall-linger-computer.sh",
);
const webPackagePath = path.join(repositoryRoot, "apps/web/package.json");
const computerPackagePath = path.join(
  repositoryRoot,
  "apps/computer/package.json",
);
const localComputerManagementPath = path.join(
  repositoryRoot,
  "apps/node-services/src/agent/runner-gateway/local-computer-management.ts",
);
const dockerfilePath = path.join(repositoryRoot, "apps/web/Dockerfile");
const temporaryRoots: string[] = [];
const fixtures = {
  stageNodeRuntime: async (bundle: string, target: string) => {
    const executable = path.join(
      bundle,
      target.startsWith("win32-") ? "runtime/bin/node.exe" : "runtime/bin/node",
    );
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(
      executable,
      `#!/bin/sh\n# ${target}\nexec "${"$"}{LINGER_RELEASE_TEST_HOST_NODE:-node}" "$@"\n`,
    );
    await chmod(executable, 0o755);
    await writeFile(
      path.join(bundle, "runtime/LICENSE"),
      "Fixture Node runtime license\n",
    );
  },
  stageGoBinaries: async (bundle: string, target: string, version: string) => {
    const windows = target.startsWith("win32-");
    const executable = path.join(
      bundle,
      `daemon/linger-computer-daemon${windows ? ".exe" : ""}`,
    );
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, `#!/bin/sh\n# Go daemon ${target}\n`);
    await chmod(executable, 0o755);
    // The installer smoke-tests version, help, and daemon status.
    const cli = path.join(
      bundle,
      `cli/linger-computer${windows ? ".exe" : ""}`,
    );
    await writeFile(
      cli,
      `#!/bin/sh\n# Go CLI ${target}\ncase "$1" in\n  version) echo "linger-computer ${version}" ;;\n  daemon) echo '{"version":1,"config":{"configured":false},"daemon":{"state":"stopped"}}' ;;\nesac\n`,
    );
    await chmod(cli, 0o755);
    if (windows) {
      await writeFile(path.join(bundle, "cli/teamhub.exe"), "MZ launcher\n");
      await chmod(path.join(bundle, "cli/teamhub.exe"), 0o755);
    }
  },
  stageToolRuntime: stageFixtureComputerTools,
};

const temporaryDirectory = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "linger-release-test-"));
  temporaryRoots.push(root);
  return root;
};

const tarList = async (archive: string) =>
  (await execFileAsync("tar", ["-tzf", archive])).stdout
    .split("\n")
    .filter(Boolean);

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("Local Computer release", () => {
  it("builds macOS, Linux and Windows x64 by default and rejects others", () => {
    expect(parseReleaseArguments([], {}).targets).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "win32-x64",
    ]);
    expect(
      parseReleaseArguments(["--targets", "win32-arm64"], {}).targets,
    ).toEqual(["win32-arm64"]);
    expect(
      parseReleaseArguments([], {
        COMPUTER_RELEASE_TARGETS: "linux-x64, darwin-arm64",
      }).targets,
    ).toEqual(["darwin-arm64", "linux-x64"]);
    expect(
      parseReleaseArguments(["--targets", "linux-arm64"], {
        COMPUTER_RELEASE_TARGETS: "linux-x64",
      }).targets,
    ).toEqual(["linux-arm64"]);
    for (const target of ["win32-ia32", "linux-ia32", ""]) {
      expect(() => parseReleaseArguments(["--targets", target], {})).toThrow(
        /Unsupported Local Computer release target|requires a value/,
      );
    }
    expect(() => parseReleaseArguments(["--part", "signed"], {})).toThrow(
      "--part must be all, app or deps",
    );
    for (const removed of ["--if-missing", "--signing-key", "--version"]) {
      expect(() => parseReleaseArguments([removed, "x"], {})).toThrow(
        "Unknown release argument",
      );
    }
  });

  it("pins one official Node runtime archive per supported target", () => {
    expect(NODE_RUNTIME_VERSION).toBe("26.5.0");
    for (const target of [
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
    ]) {
      expect(NODE_RUNTIME_RELEASES[target]?.archive).toBe(
        `node-v26.5.0-${target}.tar.gz`,
      );
      expect(NODE_RUNTIME_RELEASES[target]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("builds byte-identical, reproducible dependency archives from the same inputs", async () => {
    const root = await temporaryDirectory();
    const outputs = [path.join(root, "first"), path.join(root, "second")];
    for (const output of outputs) {
      await prepareLocalComputerRelease(
        [
          "--part",
          "deps",
          "--output",
          output,
          "--targets",
          "darwin-arm64,linux-x64",
        ],
        { ...fixtures, environment: {} },
      );
    }
    const [first, second] = await Promise.all(
      outputs.map(async (output) =>
        (await readdir(path.join(output, "files"))).sort(),
      ),
    );
    expect(first).toHaveLength(2);
    expect(second).toEqual(first);
    for (const name of first!) {
      expect(name).toMatch(
        /^deps-(darwin-arm64|linux-x64)-[0-9a-f]{64}\.tar\.gz$/,
      );
      const bytes = await readFile(path.join(outputs[0]!, "files", name));
      expect(
        bytes.equals(await readFile(path.join(outputs[1]!, "files", name))),
      ).toBe(true);
      // gzip: no name flag, zero mtime, Unix OS byte.
      expect(bytes[3]).toBe(0);
      expect(bytes.readUInt32LE(4)).toBe(0);
      expect(bytes[9]).toBe(3);
      const verbose = (
        await execFileAsync(
          "tar",
          ["-tvzf", path.join(outputs[0]!, "files", name)],
          {
            env: { ...process.env, TZ: "UTC" },
          },
        )
      ).stdout;
      expect(verbose).not.toMatch(/root/);
      const entries = await tarList(path.join(outputs[0]!, "files", name));
      expect(entries).toEqual([...entries].sort());
      expect(entries).toContain("runtime/bin/node");
      expect(entries).toContain("runtime/LICENSE");
      expect(entries).toContain("computer-tools/manifest.json");
      expect(entries).toContain(
        "computer-tools/node_modules/@playwright/mcp/cli.js",
      );
      expect(
        entries.some((entry) => entry.startsWith("computer-tools/cua/")),
      ).toBe(name.startsWith("deps-darwin-"));
      expect(entries.some((entry) => entry.startsWith("cli/"))).toBe(false);
    }
  }, 30_000);

  it("settles every target before failing and publishes no partial archives", async () => {
    const output = path.join(await temporaryDirectory(), "release");
    const finished: string[] = [];
    await expect(
      prepareLocalComputerRelease(["--output", output], {
        ...fixtures,
        environment: {},
        stageGoBinaries: async (
          bundle: string,
          target: string,
          version: string,
        ) => {
          if (target === "linux-x64") throw new Error("injected build failure");
          await new Promise((resolve) => setTimeout(resolve, 50));
          await fixtures.stageGoBinaries(bundle, target, version);
          finished.push(target);
        },
      }),
    ).rejects.toThrow("injected build failure");
    expect(finished.sort()).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "win32-x64",
    ]);
    const files = await readdir(path.join(output, "files"));
    expect(
      files.filter((name) => name.startsWith("app-") || name.startsWith(".")),
    ).toEqual([]);
    await expect(readFile(path.join(output, "release.json"))).rejects.toThrow();
  }, 30_000);

  it("builds the app part against separately built dependency archives", async () => {
    const root = await temporaryDirectory();
    const deps = path.join(root, "deps");
    const output = path.join(root, "app");
    await prepareLocalComputerRelease(
      ["--part", "deps", "--output", deps, "--targets", "linux-x64"],
      { ...fixtures, environment: {} },
    );
    const { release } = await prepareLocalComputerRelease(
      [
        "--part",
        "app",
        "--deps",
        deps,
        "--output",
        output,
        "--targets",
        "linux-x64",
      ],
      { ...fixtures, environment: {} },
    );
    const [depsFile] = await readdir(path.join(deps, "files"));
    expect(release.targets["linux-x64"].deps.file).toBe(depsFile);
    expect(
      (await readdir(path.join(output, "files"))).every((name) =>
        name.startsWith("app-"),
      ),
    ).toBe(true);
    await expect(
      prepareLocalComputerRelease(
        [
          "--part",
          "app",
          "--deps",
          deps,
          "--output",
          output,
          "--targets",
          "darwin-x64",
        ],
        { ...fixtures, environment: {} },
      ),
    ).rejects.toThrow("Expected one dependency archive for darwin-x64");
  }, 30_000);

  it("builds an installable release whose archives and index match the interface", async () => {
    const root = await temporaryDirectory();
    const output = path.join(root, "release");
    const home = path.join(root, "home");
    const { release } = await prepareLocalComputerRelease(
      ["--output", output],
      {
        ...fixtures,
        environment: {},
      },
    );
    const computerPackage = JSON.parse(
      await readFile(computerPackagePath, "utf8"),
    ) as {
      version: string;
    };
    expect(Object.keys(release)).toEqual(["version", "targets"]);
    expect(release.version).toBe(computerPackage.version);
    expect(
      JSON.parse(await readFile(path.join(output, "release.json"), "utf8")),
    ).toEqual(release);
    await expect(
      readFile(path.join(output, "linger-computer.sh"), "utf8"),
    ).resolves.toBe(await readFile(sourceInstallerPath, "utf8"));
    await expect(
      readFile(path.join(output, "uninstall-linger-computer.sh"), "utf8"),
    ).resolves.toBe(await readFile(sourceUninstallerPath, "utf8"));
    expect(Object.keys(release.targets)).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "win32-x64",
    ]);
    // node-services fills the release metadata line of these at startup.
    for (const name of [
      "linger-computer.ps1",
      "uninstall-linger-computer.ps1",
    ]) {
      await expect(
        readFile(path.join(output, name), "utf8"),
      ).resolves.toContain("__LINGER_RELEASE_METADATA_BASE64__");
      // The image runs node-services as an unprivileged user.
      expect((await stat(path.join(output, name))).mode & 0o004).toBe(0o004);
    }
    for (const [target, { app, deps }] of Object.entries(release.targets) as [
      string,
      Record<"app" | "deps", { file: string; sha256: string; size: number }>,
    ][]) {
      for (const [kind, archive] of [
        ["app", app],
        ["deps", deps],
      ] as const) {
        expect(archive.file).toBe(`${kind}-${target}-${archive.sha256}.tar.gz`);
        const bytes = await readFile(path.join(output, "files", archive.file));
        expect(bytes.length).toBe(archive.size);
      }
      const appEntries = await tarList(path.join(output, "files", app.file));
      expect(appEntries).toEqual([...appEntries].sort());
      if (target.startsWith("win32-")) {
        // Windows unpacks both archives into one bundle and has no bash
        // installer to update itself with.
        expect(appEntries).toContain("daemon/linger-computer-daemon.exe");
        expect(appEntries).toContain("cli/linger-computer.exe");
        expect(appEntries).toContain("cli/teamhub.exe");
        expect(appEntries).not.toContain("installer/linger-computer.sh");
        const depsEntries = await tarList(
          path.join(output, "files", deps.file),
        );
        expect(depsEntries).toContain("runtime/bin/node.exe");
        expect(depsEntries).toContain("cli/computer-tools/manifest.json");
        expect(depsEntries).toContain("cli/computer-tools/cua/cua-driver.exe");
        continue;
      }
      expect(appEntries).toContain("daemon/linger-computer-daemon");
      expect(appEntries).toContain("installer/linger-computer.sh");
      expect(appEntries).toContain("cli/linger-computer");
      expect(appEntries).not.toContain("cli/linger-computer.js");
      expect(appEntries).toContain("cli/teamhub");
      expect(appEntries).toContain("cli/teamhub.js");
      expect(appEntries).toContain("cli/teamhub-assets.json");
      expect(
        appEntries.some((entry) => entry.startsWith("cli/teamhub-chunks/")),
      ).toBe(true);
      expect(
        appEntries.filter(
          (entry) =>
            entry.startsWith("runtime/") ||
            entry.startsWith("cli/computer-tools/"),
        ),
      ).toEqual([]);
      const installer = await execFileAsync("tar", [
        "-xOzf",
        path.join(output, "files", app.file),
        "installer/linger-computer.sh",
      ]);
      expect(installer.stdout).toBe(
        await readFile(sourceInstallerPath, "utf8"),
      );
      // The Daemon derives its TeamHub allow rules from it.
      const commands = JSON.parse(
        (
          await execFileAsync("tar", [
            "-xOzf",
            path.join(output, "files", app.file),
            "cli/teamhub-commands.json",
          ])
        ).stdout,
      ) as { schema_version: number; commands: unknown[] };
      expect(commands.schema_version).toBe(2);
      expect(commands.commands.length).toBeGreaterThan(0);
      const daemon = await execFileAsync("tar", [
        "-xOzf",
        path.join(output, "files", app.file),
        "daemon/linger-computer-daemon",
      ]);
      expect(daemon.stdout).toContain(`# Go daemon ${target}`);
    }

    const host = `${process.platform}-${process.arch}`;
    const hostRelease = release.targets[host];
    if (!hostRelease) return;
    await execFileAsync("bash", [path.join(output, "linger-computer.sh")], {
      env: {
        ...process.env,
        HOME: home,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        LINGER_RELEASE_TEST_HOST_NODE: process.execPath,
        LINGER_COMPUTER_APP_ARCHIVE: path.join(
          output,
          "files",
          hostRelease.app.file,
        ),
        LINGER_COMPUTER_APP_SHA256: hostRelease.app.sha256,
        LINGER_COMPUTER_DEPS_ARCHIVE: path.join(
          output,
          "files",
          hostRelease.deps.file,
        ),
        LINGER_COMPUTER_DEPS_SHA256: hostRelease.deps.sha256,
        LINGER_COMPUTER_DEPS_SIZE: String(hostRelease.deps.size),
      },
    });
    // The unrendered installer's origin, http://localhost:3000, is local-3000.
    const launcher = path.join(home, ".local/bin/linger-computer-local-3000");
    await expect(
      execFileAsync(launcher, ["version"], {
        env: { ...process.env, HOME: home },
      }),
    ).resolves.toMatchObject({
      stdout: `linger-computer ${computerPackage.version}\n`,
    });
    const computerData = path.join(
      home,
      ".local/share/linger/computers/local-3000",
    );
    expect(await readdir(computerData)).not.toContain("node_modules");
    const activeBundle = (
      await readFile(path.join(computerData, "active-bundle"), "utf8")
    ).trim();
    const teamhub = path.join(computerData, activeBundle, "cli/teamhub");
    const isolatedEnvironment = {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LINGER_RELEASE_TEST_HOST_NODE: process.execPath,
      TEAMHUB_CONFIG: path.join(root, "missing-configuration.json"),
    };
    const help = await execFileAsync(teamhub, ["docs", "--help"], {
      cwd: root,
      env: isolatedEnvironment,
    });
    expect(help.stdout).toContain("teamhub docs list");
    expect(help.stderr).toBe("");
    const schema = await execFileAsync(
      teamhub,
      ["message", "send", "--schema", "--json"],
      { cwd: root, env: isolatedEnvironment },
    );
    expect(JSON.parse(schema.stdout).command).toEqual(["message", "send"]);
    expect(schema.stderr).toBe("");
    const requests: {
      endpoint: string;
      operation: string | undefined;
      metadata: unknown;
    }[] = [];
    const server = createServer(async (request, response) => {
      if (request.headers.authorization !== "Bearer th_agent_release_fixture") {
        response.writeHead(401);
        response.end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const metadata =
        request.method === "POST"
          ? JSON.parse(
              String(
                (
                  await new Response(Buffer.concat(chunks), {
                    headers: {
                      "content-type": request.headers["content-type"]!,
                    },
                  }).formData()
                ).get("metadata"),
              ),
            )
          : undefined;
      requests.push({
        endpoint: request.url!,
        operation: request.headers["x-teamhub-operation-id"] as
          | string
          | undefined,
        metadata,
      });
      if (request.method === "POST" && requests.length === 2) {
        // The accepted operation loses its response. A retry with the printed
        // operation ID must send the same identity and body.
        response.writeHead(502);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          request.method === "GET"
            ? { files: [] }
            : {
                accepted: true,
                target: { type: "room", id: "room_fixture" },
                inbox_id: "room:room_fixture",
                message_id: "message_release_fixture",
                resources: [],
                duplicate_request: requests.length === 3,
                ...(requests.length === 3
                  ? { reason: "Already accepted." }
                  : {}),
              },
        ),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Fixture has no port.");
      // The caller Room comes only from the configured profile scope.
      const configuration = path.join(root, "teamhub-config");
      await mkdir(configuration);
      await writeFile(
        path.join(configuration, "token"),
        "th_agent_release_fixture\n",
        { mode: 0o600 },
      );
      await writeFile(
        path.join(configuration, "config.json"),
        JSON.stringify({
          version: 1,
          default_profile: "release",
          profiles: {
            release: {
              url: `http://127.0.0.1:${address.port}`,
              token_file: "token",
              scope: { kind: "room", id: "room_fixture" },
            },
          },
        }),
      );
      const businessEnvironment = {
        PATH: isolatedEnvironment.PATH,
        LINGER_RELEASE_TEST_HOST_NODE: process.execPath,
        TEAMHUB_CONFIG: path.join(configuration, "config.json"),
      };
      const files = await execFileAsync(teamhub, ["docs", "list", "--json"], {
        cwd: root,
        env: businessEnvironment,
      });
      expect(JSON.parse(files.stdout)).toEqual({ documents: [] });
      expect(files.stderr).toBe("");
      const input = path.join(root, "message.txt");
      await writeFile(input, "Installed CLI fixture.");
      const command = ["message", "send", "--file", input, "--json"];
      const lost = await execFileAsync(teamhub, command, {
        cwd: root,
        env: businessEnvironment,
      }).then(
        () => {
          throw new Error("The lost response must fail the send.");
        },
        (error: { stderr: string }) => error,
      );
      expect(lost.stderr).toContain('"http_status":502');
      // The CLI keeps no receipt: a deliberate retry passes the printed ID.
      const operationId = (
        JSON.parse(lost.stderr) as {
          error: { details: { operation_id: string } };
        }
      ).error.details.operation_id;
      const replay = await execFileAsync(
        teamhub,
        [...command, "--operation-id", operationId],
        { cwd: root, env: businessEnvironment },
      );
      expect(JSON.parse(replay.stdout)).toEqual({
        accepted: true,
        target: { type: "room", id: "room_fixture" },
        inbox_id: "room:room_fixture",
        message_id: "message_release_fixture",
        resources: [],
        duplicate_request: true,
        reason: "Already accepted.",
      });
      expect(replay.stderr).toBe("");
      const fresh = await execFileAsync(teamhub, command, {
        cwd: root,
        env: businessEnvironment,
      });
      expect(JSON.parse(fresh.stdout).duplicate_request).toBe(false);
      expect(
        requests.map(({ endpoint, operation }) => ({ endpoint, operation })),
      ).toEqual([
        {
          endpoint: "/api/agent/v1/files?after_id=&limit=100",
          operation: undefined,
        },
        {
          endpoint: "/api/agent/v1/messages/commit",
          operation: expect.any(String),
        },
        {
          endpoint: "/api/agent/v1/messages/commit",
          operation: operationId,
        },
        {
          endpoint: "/api/agent/v1/messages/commit",
          operation: expect.any(String),
        },
      ]);
      expect(requests[1]!.metadata).toEqual({
        inbox_id: "room:room_fixture",
        invocation_id: expect.stringMatching(
          /^agent-invocation-sha256:[a-f0-9]{64}$/u,
        ),
        segments: [{ type: "text", content: "Installed CLI fixture." }],
        uploads: [],
      });
      expect(requests[2]!.metadata).toEqual(requests[1]!.metadata);
      expect(requests[3]!.operation).not.toBe(requests[1]!.operation);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 30_000);

  it("keeps both Computer version floors at or below the release version", async () => {
    // Below MINIMUM_COMPUTER_VERSION the Gateway refuses a Computer and the user
    // reinstalls; below MINIMUM_CURRENT_COMPUTER_VERSION it only receives
    // target_release. A floor above the release would lock every Computer out.
    const management = await readFile(localComputerManagementPath, "utf8");
    const parse = (value: string): number[] => value.split(".").map(Number);
    const version = (name: string): number[] => {
      const match = new RegExp(`${name} = "(\\d+\\.\\d+\\.\\d+)";`).exec(
        management,
      );
      expect(match, name).not.toBeNull();
      return parse(match![1]!);
    };
    const compare = (left: number[], right: number[]): number =>
      left.map((part, index) => part - right[index]!).find(Boolean) ?? 0;
    const computerPackage = JSON.parse(
      await readFile(computerPackagePath, "utf8"),
    ) as {
      version: string;
    };
    const minimum = version("MINIMUM_COMPUTER_VERSION");
    const current = version("MINIMUM_CURRENT_COMPUTER_VERSION");
    expect(compare(minimum, current)).toBeLessThanOrEqual(0);
    expect(
      compare(current, parse(computerPackage.version)),
    ).toBeLessThanOrEqual(0);
  });

  it("keeps Web builds independent of CLI packaging", async () => {
    const webPackage = JSON.parse(await readFile(webPackagePath, "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(webPackage.scripts.prebuild).toBeUndefined();
    const dockerfile = await readFile(dockerfilePath, "utf8");
    expect(dockerfile).not.toMatch(
      /computer-archives|computer-release|prepare-local-computer-release|node-distributions|signing_key|apps\/computer|apps\/teamhub-cli/,
    );
    expect(dockerfile).toContain("pnpm --filter @linger/web build:assets");
  });
});
