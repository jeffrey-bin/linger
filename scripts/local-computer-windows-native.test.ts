import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { once } from "node:events";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  publishWindowsInstallers,
  renderWindowsInstaller,
} from "./publish-windows-installers.mjs";
import {
  nativePlatform,
  WINDOWS_BUNDLE_ENTRIES,
} from "./local-computer-windows-installer.mjs";

const execute = promisify(execFile);
// Scale only harness watchdogs when running Windows through instruction
// emulation; installer behavior and assertions are identical.
const timeoutScale = Number(process.env.LINGER_TEST_WINDOWS_TIMEOUT_SCALE ?? 1);
if (!Number.isInteger(timeoutScale) || timeoutScale < 1 || timeoutScale > 20)
  throw new Error(
    "LINGER_TEST_WINDOWS_TIMEOUT_SCALE must be an integer from 1 to 20",
  );
const watchdog = (milliseconds: number) => milliseconds * timeoutScale;
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const requireComputer = createRequire(
  new URL("../apps/computer/package.json", import.meta.url),
);
const tar = requireComputer("tar-stream");
const nativeWindows = process.platform === "win32";

// The installer drives `daemon status|stop|start`; state lives in the data root.
const fixtureCliSource = `package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
)

var version string

type daemonState struct {
	State            string \`json:"state"\`
	ActiveOperations int    \`json:"active_operations"\`
	GatewayState     string \`json:"gateway_state,omitempty"\`
	Reconciled       bool   \`json:"reconciled,omitempty"\`
}

func main() {
	args := os.Args[1:]
	file := filepath.Join(os.Getenv("LINGER_COMPUTER_DATA_DIR"), "fixture-state.json")
	state := daemonState{State: "stopped"}
	if content, err := os.ReadFile(file); err == nil {
		_ = json.Unmarshal(content, &state)
	}
	write := func(value daemonState) {
		content, _ := json.Marshal(value)
		_ = os.WriteFile(file, content, 0o600)
	}
	switch {
	case len(args) == 1 && args[0] == "version":
		fmt.Println("linger-computer " + version)
	case len(args) == 1 && args[0] == "--help":
		fmt.Println("usage")
	case len(args) > 0 && args[0] == "echo-argv":
		content, _ := json.Marshal(args[1:])
		fmt.Println(string(content))
	case len(args) > 1 && args[0] == "daemon" && args[1] == "status":
		_, err := os.Stat(os.Getenv("LINGER_COMPUTER_CONFIG"))
		content, _ := json.Marshal(map[string]any{"version": 1, "config": map[string]any{"configured": err == nil}, "daemon": state})
		fmt.Println(string(content))
	case len(args) > 1 && args[0] == "daemon" && args[1] == "stop":
		if slices.Contains(args, "--if-idle") && state.ActiveOperations > 0 {
			os.Exit(1)
		}
		write(daemonState{State: "stopped"})
	case len(args) > 1 && args[0] == "daemon" && args[1] == "start":
		write(daemonState{State: "running", GatewayState: "connected", Reconciled: true})
	default:
		os.Exit(1)
	}
}
`;

// These are native Windows proofs: ordinary host transaction tests intentionally
// do not stand in for PowerShell, ACL, PE execution, or Windows file sharing.
describe.skipIf(!nativeWindows)(
  "Windows PowerShell native installer lifecycle",
  () => {
    let root: string;
    let daemon: string;
    let launcher: string;
    let fixtureCli: string;
    let powershell: string;
    let originalUserPath: string;
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    beforeAll(async () => {
      expect(process.versions.node).toBe("26.5.0");
      root = await mkdtemp(path.join(os.tmpdir(), "linger-windows-native-"));
      daemon = path.join(root, "linger-computer-daemon.exe");
      launcher = path.join(root, "linger-computer-launcher.exe");
      powershell = path.join(
        process.env.SystemRoot!,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      originalUserPath = (
        await execute(
          powershell,
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Environment]::GetEnvironmentVariable('Path','User')",
          ],
          { encoding: "utf8" },
        )
      ).stdout.trimEnd();
      fixtureCli = path.join(root, "fixture-cli.go");
      await writeFile(fixtureCli, fixtureCliSource);
      const fixtureDaemon = process.env.LINGER_TEST_WINDOWS_DAEMON;
      if (fixtureDaemon) {
        await copyFile(fixtureDaemon, daemon);
      } else
        await execute(
          "go",
          [
            "build",
            "-mod=readonly",
            "-o",
            daemon,
            "./cmd/linger-computer-daemon",
          ],
          {
            cwd: path.join(repositoryRoot, "apps/computer/local-daemon"),
            env: { ...process.env, CGO_ENABLED: "0" },
            timeout: watchdog(180_000),
          },
        );
      const fixtureLauncher = process.env.LINGER_TEST_WINDOWS_LAUNCHER;
      if (fixtureLauncher) await copyFile(fixtureLauncher, launcher);
      else
        await execute(
          "go",
          [
            "build",
            "-mod=readonly",
            "-o",
            launcher,
            "./cmd/linger-computer-launcher",
          ],
          {
            cwd: path.join(repositoryRoot, "apps/computer/local-daemon"),
            env: { ...process.env, CGO_ENABLED: "0" },
            timeout: watchdog(180_000),
          },
        );
    }, watchdog(240_000));
    afterAll(async () => {
      if (powershell && originalUserPath !== undefined)
        await execute(powershell, [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `[Environment]::SetEnvironmentVariable('Path',${quote(originalUserPath)},'User')`,
        ]);
      if (root) await rm(root, { recursive: true, force: true });
    }, watchdog(10_000));

    /**
     * Publishes the deps and app archives into output/files and renders the
     * installers to name them, as node-services does; returns the archives.
     */
    async function release(output: string, version: string) {
      const target = `win32-${process.arch}`;
      await mkdir(path.join(output, "files"), { recursive: true });
      // The installer runs the bundle's native Go CLI, so the fixture CLI is a
      // tiny Go program that keeps a fake Daemon state beside the data root.
      const cli = path.join(output, `linger-computer-${version}.exe`);
      await execute(
        "go",
        [
          "build",
          "-ldflags",
          `-X main.version=${version}`,
          "-o",
          cli,
          fixtureCli,
        ],
        {
          env: { ...process.env, CGO_ENABLED: "0" },
          timeout: watchdog(180_000),
        },
      );
      const contents = [
        await readFile(cli),
        await readFile(daemon),
        await readFile(process.execPath),
        Buffer.from("Native fixture Node license\n"),
      ];
      const cliAssets = [
        {
          path: "teamhub.js",
          content: "import './teamhub-chunks/fixture-ABCD.js';\n",
        },
        {
          path: "teamhub-chunks/fixture-ABCD.js",
          content:
            "if(process.argv[2]==='echo-argv')console.log(JSON.stringify(process.argv.slice(3)));else console.log('WINDOWS_TEAMHUB_CLI_OK');\n",
        },
      ];
      const assets = cliAssets.map((asset) => ({
        path: asset.path,
        size_bytes: Buffer.byteLength(asset.content),
        sha256: createHash("sha256").update(asset.content).digest("hex"),
      }));
      const entries = [
        ...WINDOWS_BUNDLE_ENTRIES.map((name: string, index: number) => ({
          name,
          content: contents[index],
        })),
        {
          name: "cli/teamhub",
          content: Buffer.from("#!/usr/bin/env node\nimport './teamhub.js';\n"),
        },
        {
          name: "cli/teamhub.exe",
          content: Buffer.concat([
            await readFile(launcher),
            Buffer.from(`\nfixture-release-${version}\n`),
          ]),
        },
        {
          name: "cli/teamhub-assets.json",
          content: Buffer.from(
            JSON.stringify({
              schema_version: 1,
              entrypoint: "teamhub.js",
              assets,
              artifact_sha256: createHash("sha256")
                .update(JSON.stringify(assets))
                .digest("hex"),
            }) + "\n",
          ),
        },
        ...cliAssets.map((asset) => ({
          name: `cli/${asset.path}`,
          content: Buffer.from(asset.content),
        })),
      ];
      const archives = {} as Record<
        "deps" | "app",
        { file: string; sha256: string; size: number }
      >;
      for (const kind of ["deps", "app"] as const) {
        const pack = tar.pack();
        const chunks: Buffer[] = [];
        const done = new Promise<Buffer>((resolve, reject) => {
          pack.on("data", (chunk: Buffer) => chunks.push(chunk));
          pack.once("end", () => resolve(gzipSync(Buffer.concat(chunks))));
          pack.once("error", reject);
        });
        for (const entry of entries.filter(
          ({ name }) => name.startsWith("runtime/") === (kind === "deps"),
        )) {
          await new Promise<void>((resolve, reject) =>
            pack.entry(
              {
                name: entry.name,
                size: entry.content.length,
                type: "file",
              },
              entry.content,
              (error: unknown) => (error ? reject(error) : resolve()),
            ),
          );
        }
        pack.finalize();
        const archive = await done;
        const sha256 = createHash("sha256").update(archive).digest("hex");
        const file = `${kind}-${target}-${sha256}.tar.gz`;
        await writeFile(path.join(output, "files", file), archive);
        archives[kind] = { file, sha256, size: archive.length };
      }
      await publishWindowsInstallers(output);
      const metadata = {
        downloadBaseUrl: output,
        webOrigin: "http://localhost:3000",
        targets: { [target]: archives },
      };
      for (const name of [
        "linger-computer.ps1",
        "uninstall-linger-computer.ps1",
      ]) {
        const file = path.join(output, name);
        await writeFile(
          file,
          renderWindowsInstaller(await readFile(file, "utf8"), metadata),
        );
      }
      return archives;
    }

    it.each(["Windows PowerShell 5.1", "PowerShell 7"])(
      "installs, upgrades, preserves and purges with %s",
      async (shellName) => {
        let shell = powershell;
        if (shellName === "PowerShell 7") {
          shell =
            process.env.LINGER_TEST_PWSH ||
            path.join(process.env.ProgramFiles!, "PowerShell", "7", "pwsh.exe");
          // CI must supply both shells; missing PowerShell 7 is a failed requirement.
          await execute(shell, [
            "-NoProfile",
            "-Command",
            "$PSVersionTable.PSVersion.Major",
          ]);
        }
        const scenario = path.join(root, shellName.replaceAll(" ", "-"));
        const distribution = path.join(scenario, "distribution");
        const dataRoot = path.join(scenario, "Usuário with spaces");
        const bin = path.join(dataRoot, "bin");
        const environment = {
          ...process.env,
          LINGER_COMPUTER_DATA_DIR: dataRoot,
          LINGER_COMPUTER_BIN_DIR: bin,
          LINGER_COMPUTER_CONFIG: "",
          LINGER_WEB_URL: "http://localhost:3000",
          PATH: `${path.join(process.env.SystemRoot!, "System32")};${path.dirname(shell)}`,
        };
        const run = (script: string, args: string[] = []) =>
          execute(
            shell,
            [
              "-NoProfile",
              "-NonInteractive",
              "-ExecutionPolicy",
              "Bypass",
              "-File",
              path.join(distribution, script),
              ...args,
            ],
            { env: environment, encoding: "utf8", timeout: watchdog(120_000) },
          );
        await release(distribution, "1.0.0");
        await run("linger-computer.ps1");
        const initial = (
          await readFile(path.join(dataRoot, "active-bundle"), "utf8")
        ).trim();
        await run("linger-computer.ps1");
        expect(
          (await readFile(path.join(dataRoot, "active-bundle"), "utf8")).trim(),
        ).toBe(initial);
        const cmd = path.join(bin, "linger-computer-local-3000.exe");
        const launched = await execute(cmd, ["version"], {
          env: environment,
          encoding: "utf8",
        });
        expect(launched.stdout).toContain("linger-computer 1.0.0");
        await expect(
          execute(cmd, ["stop"], {
            env: {
              ...environment,
              LINGER_COMPUTER_DATA_DIR: path.join(scenario, "another computer"),
            },
            encoding: "utf8",
          }),
        ).rejects.toThrow("differs from this launcher installation");
        const teamhub = path.join(dataRoot, initial, "cli/teamhub.exe");
        const cliResult = await execute(teamhub, ["--help"], {
          env: environment,
          encoding: "utf8",
        });
        expect(cliResult.stdout).toContain("WINDOWS_TEAMHUB_CLI_OK");
        // Native executables bypass cmd.exe, including when PowerShell binds
        // untrusted text. PowerShell 5.1 needs its documented native quote escape.
        const values = [
          "x&y",
          'a b" & echo LINGER_ARG_INJECTED & "c d',
          "%LINGER_ARG_EXPAND%",
          "Usuário !literal!",
          "https://example.test/?a=1&b=2",
        ];
        for (const entry of [cmd, teamhub]) {
          const encoded = Buffer.from(JSON.stringify(values)).toString(
            "base64",
          );
          const script = `$values=@([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))|ConvertFrom-Json);if($PSVersionTable.PSVersion.Major -lt 7){$values=@($values|ForEach-Object {$_.Replace('"','\\"')})};& ${quote(entry)} echo-argv @values`;
          const forwarded = await execute(
            shell,
            [
              "-NoProfile",
              "-NonInteractive",
              "-EncodedCommand",
              Buffer.from(script, "utf16le").toString("base64"),
            ],
            {
              env: { ...environment, LINGER_ARG_EXPAND: "should-not-expand" },
              encoding: "utf8",
            },
          );
          expect(JSON.parse(forwarded.stdout.trim())).toEqual(values);
        }
        await expect(
          readFile(path.join(bin, "linger-computer.cmd")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        // Real platform helper creates config with Windows ACL semantics.
        const writeConfig = JSON.stringify({
          action: "write-private-file",
          path: path.join(dataRoot, "config.json"),
          data: JSON.stringify({
            state_directory: path.join(dataRoot, "state"),
          }),
        });
        await new Promise<void>((resolve, reject) => {
          const child = spawn(daemon, ["platform"], {
            env: environment,
            stdio: ["pipe", "pipe", "pipe"],
          });
          child.once("error", reject);
          child.once("exit", (code) =>
            code === 0
              ? resolve()
              : reject(
                  new Error(`Native private-file helper failed (${code})`),
                ),
          );
          child.stdin.end(writeConfig);
        });
        await release(distribution, "1.1.0");
        await run("linger-computer.ps1");
        expect(
          (await readFile(path.join(dataRoot, "active-bundle"), "utf8")).trim(),
        ).not.toBe(initial);
        await run("uninstall-linger-computer.ps1");
        expect(await readdir(dataRoot)).toContain("config.json");
        await run("linger-computer.ps1");
        await run("uninstall-linger-computer.ps1", ["--purge"]);
        expect(await readdir(dataRoot)).not.toContain("config.json");
      },
      watchdog(240_000),
    );

    it.each([3, 2])(
      "recovers a terminated native upgrade with schema %i journal",
      async (schemaVersion) => {
        const scenario = path.join(root, `interrupted-${schemaVersion}`);
        const distribution = path.join(scenario, "distribution");
        const dataRoot = path.join(scenario, "Usuário computer");
        const bin = path.join(dataRoot, "bin");
        const environment = {
          ...process.env,
          LINGER_COMPUTER_DATA_DIR: dataRoot,
          LINGER_COMPUTER_BIN_DIR: bin,
          LINGER_COMPUTER_CONFIG: "",
          LINGER_WEB_URL: "http://localhost:3000",
        };
        const run = () =>
          execute(
            powershell,
            [
              "-NoProfile",
              "-NonInteractive",
              "-ExecutionPolicy",
              "Bypass",
              "-File",
              path.join(distribution, "linger-computer.ps1"),
            ],
            { env: environment, encoding: "utf8", timeout: watchdog(120_000) },
          );
        await release(distribution, "1.0.0");
        await run();
        const originalBundle = (
          await readFile(path.join(dataRoot, "active-bundle"), "utf8")
        ).trim();
        const originalLauncher = await readFile(
          path.join(bin, "linger-computer-local-3000.exe"),
        );
        expect(originalLauncher.length).toBeGreaterThan(3 * 1024 * 1024);
        const platform = nativePlatform(daemon);
        await platform.write(
          path.join(dataRoot, "config.json"),
          JSON.stringify({ state_directory: path.join(dataRoot, "state") }),
        );
        const second = await release(distribution, "1.1.0");
        const harness = path.join(scenario, "interrupt-upgrade.mjs");
        await writeFile(
          harness,
          `import path from 'node:path';
import { runWindowsInstaller, nativePlatform } from ${JSON.stringify(pathToFileURL(path.join(repositoryRoot, "scripts/local-computer-windows-installer.mjs")).href)};
const settings=JSON.parse(process.argv[2]);
const platform=nativePlatform(${JSON.stringify(daemon)}), write=platform.write;
platform.write=async(file,data)=>{await write(file,data);if(file===path.join(settings.binDirectory,'linger-computer-local-3000.launcher.json')){process.stdout.write('NATIVE_UPGRADE_COMMIT_PAUSED\\n');await new Promise(()=>setInterval(()=>{},1000));}};
await runWindowsInstaller(settings,{platform});
`,
        );
        const child = spawn(
          process.execPath,
          [
            harness,
            JSON.stringify({
              operation: "install",
              dataRoot,
              binDirectory: bin,
              commandName: "linger-computer-local-3000",
              target: `win32-${process.arch}`,
              release: second,
              downloadBaseUrl: distribution,
              webOrigin: "http://localhost:3000",
            }),
          ],
          {
            env: environment,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          },
        );
        const exited = once(child, "exit");
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        try {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () =>
                reject(
                  new Error(`Native upgrade did not reach commit: ${stderr}`),
                ),
              watchdog(90_000),
            );
            let output = "";
            child.stdout.on("data", (chunk) => {
              output += chunk;
              if (output.includes("NATIVE_UPGRADE_COMMIT_PAUSED")) {
                clearTimeout(timer);
                resolve();
              }
            });
            child.once("error", (error) => {
              clearTimeout(timer);
              reject(error);
            });
            child.once("exit", (code) => {
              clearTimeout(timer);
              reject(
                new Error(
                  `Upgrade exited before interruption (${code}): ${stderr}`,
                ),
              );
            });
          });
        } finally {
          child.kill();
          await exited;
        }
        expect(
          await readFile(path.join(bin, "linger-computer-local-3000.exe")),
        ).not.toEqual(originalLauncher);
        const journalFile = path.join(dataRoot, ".install-transaction.json");
        const raw = await readFile(journalFile, "utf8");
        expect(Buffer.byteLength(raw)).toBeLessThan(16 * 1024);
        const journal = JSON.parse(raw);
        expect(journal.schemaVersion).toBe(3);
        expect(journal.launcherChecksum).toBe(
          createHash("sha256").update(originalLauncher).digest("hex"),
        );
        if (schemaVersion === 2) {
          journal.schemaVersion = 2;
          journal.launcher = originalLauncher.toString("base64");
          delete journal.launcherChecksum;
          await platform.write(journalFile, JSON.stringify(journal));
          await expect(platform.read(journalFile)).rejects.toThrow(
            "size limit",
          );
        }
        // Recovery runs before reading the next archive. A deliberately missing
        // archive leaves the recovered previous installation available to inspect.
        const missing = await release(distribution, "1.2.0");
        await rm(path.join(distribution, "files", missing.app.file));
        await expect(run()).rejects.toThrow();
        expect(
          (await readFile(path.join(dataRoot, "active-bundle"), "utf8")).trim(),
        ).toBe(originalBundle);
        expect(
          await readFile(path.join(bin, "linger-computer-local-3000.exe")),
        ).toEqual(originalLauncher);
        expect(await readdir(dataRoot)).not.toContain(
          ".install-transaction.json",
        );
        const recovered = await execute(
          path.join(bin, "linger-computer-local-3000.exe"),
          ["version"],
          { env: environment, encoding: "utf8" },
        );
        expect(recovered.stdout).toContain("linger-computer 1.0.0");
        await release(distribution, "1.1.0");
        await run();
        const upgraded = await execute(
          path.join(bin, "linger-computer-local-3000.exe"),
          ["version"],
          { env: environment, encoding: "utf8" },
        );
        expect(upgraded.stdout).toContain("linger-computer 1.1.0");
      },
      watchdog(240_000),
    );

    it(
      "rejects a corrupted bootstrap before executing or installing it",
      async () => {
        const output = path.join(root, "corrupt-distribution");
        const { deps } = await release(output, "1.0.0");
        await writeFile(
          path.join(output, "files", deps.file),
          "not the checksum-pinned archive",
        );
        const dataRoot = path.join(root, "corrupt-user");
        await expect(
          execute(
            powershell,
            [
              "-NoProfile",
              "-NonInteractive",
              "-ExecutionPolicy",
              "Bypass",
              "-File",
              path.join(output, "linger-computer.ps1"),
            ],
            {
              env: { ...process.env, LINGER_COMPUTER_DATA_DIR: dataRoot },
              timeout: watchdog(30_000),
            },
          ),
        ).rejects.toThrow("bootstrap checksum verification failed");
        expect(await readdir(dataRoot)).not.toContain("active-bundle");
      },
      watchdog(60_000),
    );
  },
);
