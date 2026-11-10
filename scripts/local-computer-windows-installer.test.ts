import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bundleChecksum,
  createProgress,
  download,
  downloadDetail,
  extractWindowsBundle,
  invoke,
  nativePlatform,
  renameWithRetry,
  runWindowsInstaller,
  validateDownloadSource,
  verifyWindowsExecutable,
  windowsLauncherConfig,
  windowsReleaseDigest,
  MANAGED_TOOLS_BUNDLE_ENTRIES,
  WINDOWS_BUNDLE_ENTRIES,
} from "./local-computer-windows-installer.mjs";

const requireComputer = createRequire(
  new URL("../apps/computer/package.json", import.meta.url),
);
const tar = requireComputer("tar-stream");
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  privatePlatform.request.mockClear();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const hash = (content: Buffer | string) =>
  createHash("sha256").update(content).digest("hex");
const privatePlatform = {
  ensure: async (directory: string) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await privatePlatform.check(directory, "directory");
  },
  check: async (file: string, kind: string) => {
    const info = await lstat(file);
    if (
      info.isSymbolicLink() ||
      (kind === "directory"
        ? !info.isDirectory()
        : !info.isFile() || info.nlink !== 1)
    )
      throw new Error("Unsafe fixture path");
  },
  read: async (file: string, maxBytes = 4 * 1024 * 1024) => {
    // The native private read checks the file itself.
    await privatePlatform.check(file, "file");
    const content = await readFile(file);
    if (content.length > maxBytes)
      throw new Error("Private file exceeds the size limit.");
    return content.toString("utf8");
  },
  write: async (file: string, data: string) => {
    const temporary = `${file}.pending`;
    await writeFile(temporary, data, { mode: 0o600 });
    await rename(temporary, file);
  },
  request: vi.fn(async (action: string) =>
    ["owned-processes-stopped", "stop-managed-services"].includes(action)
      ? { stopped: true }
      : {},
  ),
};

async function archive(
  entries: Array<{ name: string; content: string; type?: string }>,
) {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  const finished = new Promise<Buffer>((resolve, reject) => {
    pack.on("data", (chunk: Buffer) => chunks.push(chunk));
    pack.on("end", () => resolve(gzipSync(Buffer.concat(chunks))));
    pack.on("error", reject);
  });
  for (const entry of entries) {
    await new Promise<void>((resolve, reject) =>
      pack.entry(
        {
          name: entry.name,
          type: entry.type ?? "file",
          size: Buffer.byteLength(entry.content),
          mode: 0o755,
        },
        entry.content,
        (error: unknown) => (error ? reject(error) : resolve()),
      ),
    );
  }
  pack.finalize();
  return await finished;
}

function teamhubEntries(
  version = "fixture",
  legacyCommand = false,
  launcherBytes = 0,
) {
  const files = [
    {
      path: "teamhub.js",
      content: "import './teamhub-chunks/help-ABCD.js';\n",
    },
    {
      path: "teamhub-chunks/help-ABCD.js",
      content: "console.log('TeamHub fixture');\n",
    },
  ];
  const assets = files.map(({ path: assetPath, content }) => ({
    path: assetPath,
    size_bytes: Buffer.byteLength(content),
    sha256: hash(content),
  }));
  return [
    {
      name: "cli/teamhub",
      content: "#!/usr/bin/env node\nimport './teamhub.js';\n",
    },
    {
      name: legacyCommand ? "cli/teamhub.cmd" : "cli/teamhub.exe",
      content: legacyCommand
        ? "@echo off\r\nrem old launcher\r\n"
        : `MZ linger-native-cli-launcher-v1 native fixture ${version}`.padEnd(
            launcherBytes,
            "x",
          ),
    },
    {
      name: "cli/teamhub-assets.json",
      content:
        JSON.stringify({
          schema_version: 1,
          entrypoint: "teamhub.js",
          assets,
          artifact_sha256: hash(JSON.stringify(assets)),
        }) + "\n",
    },
    ...files.map(({ path: assetPath, content }) => ({
      name: `cli/${assetPath}`,
      content,
    })),
  ];
}

async function fixture(launcherBytes = 0) {
  const root = await mkdtemp(path.join(os.tmpdir(), "windows-installer-"));
  roots.push(root);
  const dataRoot = path.join(root, "Usuário computer");
  const distribution = path.join(root, "distribution");
  await mkdir(path.join(distribution, "files"), { recursive: true });
  const settings = {
    operation: "install",
    dataRoot,
    binDirectory: path.join(root, "bin with spaces"),
    commandName: "linger-computer-web",
    target: "win32-x64",
    downloadBaseUrl: "https://downloads.example.test/install",
    webOrigin: "https://web.example.test",
  };
  type Release = Record<
    "deps" | "app",
    { file: string; sha256: string; size: number }
  >;
  let release: Release | undefined;
  const transfers: string[] = [];
  const transfer = async (source: string, destination: string) => {
    transfers.push(source);
    await writeFile(
      destination,
      await readFile(
        path.join(
          distribution,
          new URL(source).pathname.replace(/^\/install\//u, ""),
        ),
      ),
      { flag: "wx" },
    );
  };
  /** Publishes the deps and app archives the next run installs. */
  const publish = async (
    version: string,
    options: {
      brokenStart?: boolean;
      busyAfterStart?: boolean;
      legacy?: boolean;
    } = {},
  ) => {
    const script = `import fs from 'node:fs'; import path from 'node:path';
const root=process.env.LINGER_COMPUTER_DATA_DIR;
const stateFile=path.join(root,'fixture-status.json');
const grouped=process.argv[2]==='daemon';
if(!grouped&&['status','stop','start'].includes(process.argv[2])){console.error('Unknown command: '+process.argv.slice(2).join(' '));process.exit(2);}
const command=process.argv[grouped?3:2];
const state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):{state:'stopped',active_operations:0};
fs.appendFileSync(path.join(root,'invocations'), ${JSON.stringify(version)}+' '+process.argv.slice(2).join(' ')+'\\n');
if(command==='version')console.log('linger-computer ${version}');
else if(command==='--help')console.log('usage');
else if(command==='status')console.log(JSON.stringify({version:1,config:{configured:fs.existsSync(process.env.LINGER_COMPUTER_CONFIG)},daemon:state,runtimes:[{type:'codex',status:'ready'}],runners:[{agent_id:'agent',state:'ready'}]}));
else if(command==='stop'){if(process.argv.includes('--if-idle')&&state.active_operations>0){console.error('Agent Operations are active');process.exit(1);}fs.writeFileSync(stateFile,JSON.stringify({...state,state:'stopped',active_operations:0}));}
else if(command==='start'){fs.writeFileSync(stateFile,JSON.stringify({...state,state:'running',gateway_state:'connected',reconciled:${!options.brokenStart},active_operations:${options.busyAfterStart ? 1 : 0}}));}
else process.exit(1);`;
    // The installer runs the CLI executable directly, as it runs the Go CLI.
    const cli = `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' --input-type=module -e '${script.replaceAll("'", "'\\''")}' linger-computer "$@"\n`;
    const contents = [
      cli,
      "fixture daemon\n",
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo v26.5.0; else exec '${process.execPath.replaceAll("'", "'\\''")}' "$@"; fi\n`,
      "Node fixture license\n",
    ];
    const entries = [
      ...WINDOWS_BUNDLE_ENTRIES.map((name: string, index: number) => ({
        name,
        content: contents[index],
      })),
      ...MANAGED_TOOLS_BUNDLE_ENTRIES.map((name: string) => ({
        name,
        content: `export const fixture = ${JSON.stringify(name)};\n`,
      })),
      ...teamhubEntries(version, options.legacy, launcherBytes),
    ];
    const next = {} as Release;
    const paths: string[] = [];
    for (const kind of ["deps", "app"] as const) {
      const bytes = await archive(
        entries.filter(
          (entry) => entry.name.startsWith("runtime/") === (kind === "deps"),
        ),
      );
      const file = `${kind}-win32-x64-${hash(bytes)}.tar.gz`;
      await writeFile(path.join(distribution, "files", file), bytes);
      next[kind] = { file, sha256: hash(bytes), size: bytes.length };
      paths.push(path.join(distribution, "files", file));
    }
    release = next;
    return { release: next, paths };
  };
  const run = (extra = {}) =>
    runWindowsInstaller(
      { ...settings, release, ...extra },
      {
        platform: privatePlatform,
        download: transfer,
        log: () => {},
        readinessTimeoutMs: 1,
        // These portable lifecycle fixtures are shell scripts, not PE files.
        // Architecture parsing is covered separately; native tests use PE files.
        checkExecutable: async () => {},
      },
    );
  const configure = async (active = 0) => {
    await mkdir(dataRoot, { recursive: true });
    await writeFile(
      path.join(dataRoot, "config.json"),
      JSON.stringify({ state_directory: path.join(dataRoot, "state") }),
    );
    await writeFile(
      path.join(dataRoot, "fixture-status.json"),
      JSON.stringify({
        state: "running",
        gateway_state: "connected",
        reconciled: true,
        active_operations: active,
      }),
    );
  };
  const current = async () =>
    (await readFile(path.join(dataRoot, "active-bundle"), "utf8")).trim();
  return {
    root,
    dataRoot,
    distribution,
    settings,
    transfers,
    publish,
    run,
    configure,
    current,
  };
}

describe("Windows bootstrap extraction allowlist", () => {
  // The PowerShell bootstrap only runs on native Windows in tests, so check
  // here that it accepts every entry the helper requires of a bundle.
  it("accepts every required bundle entry", async () => {
    const source = await readFile(
      new URL("./local-computer-windows-bootstrap.ps1", import.meta.url),
      "utf8",
    );
    const cliAsset = new RegExp(
      /\$cliAsset = \$name -cmatch '([^']+)'/u.exec(source)?.[1] ?? "^$",
      "u",
    );
    const required = [
      ...source.matchAll(/^\s*Expand-LingerBootstrap .* @\(([^)]*)\)$/gmu),
    ].flatMap((match) =>
      [...match[1].matchAll(/'([^']+)'/gu)].map((entry) => entry[1]),
    );
    expect(required.length).toBeGreaterThan(0);
    expect(
      WINDOWS_BUNDLE_ENTRIES.filter(
        (name: string) => !required.includes(name) && !cliAsset.test(name),
      ),
    ).toEqual([]);
  });
});

describe("renameWithRetry", () => {
  const busy = (code: string) => Object.assign(new Error(code), { code });

  it("waits out a file antivirus still holds, then moves the bundle", async () => {
    const move = vi
      .fn()
      .mockRejectedValueOnce(busy("EPERM"))
      .mockRejectedValueOnce(busy("EBUSY"))
      .mockResolvedValueOnce(undefined);
    const wait = vi.fn().mockResolvedValue(undefined);
    await renameWithRetry("staged", "lib-x", { move, wait });
    expect(move).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[250], [500]]);
  });

  it("fails at once on other errors and after the last attempt", async () => {
    const wait = vi.fn().mockResolvedValue(undefined);
    await expect(
      renameWithRetry("a", "b", {
        move: vi.fn().mockRejectedValue(busy("ENOENT")),
        wait,
      }),
    ).rejects.toThrow("ENOENT");
    expect(wait).not.toHaveBeenCalled();
    const move = vi.fn().mockRejectedValue(busy("EPERM"));
    await expect(
      renameWithRetry("a", "b", { move, wait, attempts: 3 }),
    ).rejects.toThrow("EPERM");
    expect(move).toHaveBeenCalledTimes(3);
  });
});

describe("Windows installer trust boundary", () => {
  it("drains real child stdout after process exit and rejects oversized output", async () => {
    const size = 1024 * 1024;
    const result = await invoke(
      process.execPath,
      [
        "-e",
        `process.stdout.write(JSON.stringify({payload:'x'.repeat(${size})}));`,
      ],
      process.env,
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).payload).toHaveLength(size);
    await expect(
      invoke(
        process.execPath,
        ["-e", "process.stdout.write('x'.repeat(5*1024*1024));"],
        process.env,
      ),
    ).rejects.toThrow("output exceeds the size limit");
  });
  it("checks native PE machine identity before executing a release", async () => {
    const f = await fixture();
    const file = path.join(f.root, "node.exe");
    const bytes = Buffer.alloc(128);
    bytes.write("MZ");
    bytes.writeUInt32LE(64, 60);
    bytes.write("PE\0\0", 64, "ascii");
    bytes.writeUInt16LE(0xaa64, 68);
    await writeFile(file, bytes);
    await expect(
      verifyWindowsExecutable(file, "win32-arm64"),
    ).resolves.toBeUndefined();
    await expect(verifyWindowsExecutable(file, "win32-x64")).rejects.toThrow(
      "architecture",
    );
    bytes.writeUInt32LE(999, 60);
    await writeFile(file, bytes);
    await expect(verifyWindowsExecutable(file, "win32-arm64")).rejects.toThrow(
      "architecture",
    );
  });
  it("keeps a slow download alive while bytes arrive and aborts only on a stall", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-length", "4");
      let sent = 0;
      const send = () => {
        if (request.url === "/stall" && sent === 1) return;
        response.write("x");
        if (++sent === 4) response.end();
        else setTimeout(send, 150);
      };
      send();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const root = await mkdtemp(path.join(os.tmpdir(), "windows-download-"));
    roots.push(root);
    try {
      const progress: number[] = [];
      // 450 ms in total, longer than the 300 ms stall bound.
      await download(
        `${base}/slow`,
        path.join(root, "slow"),
        (received: number) => progress.push(received),
        300,
      );
      expect(await readFile(path.join(root, "slow"), "utf8")).toBe("xxxx");
      expect(progress).toEqual([1, 2, 3, 4]);
      await expect(
        download(`${base}/stall`, path.join(root, "stall"), () => {}, 300),
      ).rejects.toThrow("Download stalled");
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("renders an ASCII download bar", () => {
    const megabyte = 1024 * 1024;
    expect(downloadDetail(5 * megabyte, 20 * megabyte)).toBe(
      "[#####---------------] 25% 5.0/20.0 MB",
    );
    expect(downloadDetail(3 * megabyte, 0)).toBe("3.0 MB");
  });

  it("numbers steps and reports elapsed time without a console", () => {
    vi.useFakeTimers();
    try {
      const output: string[] = [];
      let clock = 0;
      const progress = createProgress({
        total: 4,
        write: (text: string) => output.push(text),
        now: () => clock,
        startedAt: 0,
        step: 1,
        label: "Checking the installed version",
        stepStartedAt: 0,
      });
      clock = 2_000;
      progress.begin(2, "Downloading the package");
      progress.update(downloadDetail(1024 * 1024, 4 * 1024 * 1024));
      clock = 12_000;
      vi.advanceTimersByTime(10_000);
      clock = 14_000;
      progress.end();
      progress.note(`Done in ${progress.total()}.`);
      expect(output.join("")).toBe(
        [
          "[1/4] Checking the installed version... OK (2s)",
          "[2/4] Downloading the package...",
          "      [#####---------------] 25% 1.0/4.0 MB (10s)",
          "[2/4] Downloading the package... OK (12s)",
          "Done in 14s.",
          "",
        ].join("\n"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("redraws one console line and keeps notes on their own lines", () => {
    vi.useFakeTimers();
    try {
      let screen = "";
      let clock = 0;
      const progress = createProgress({
        total: 3,
        interactive: true,
        write: (text: string) => {
          screen += text;
        },
        now: () => clock,
      });
      progress.begin(1, "Checking the installed version");
      clock = 1_000;
      vi.advanceTimersByTime(250);
      progress.note("Recovered the interrupted installation.");
      clock = 65_000;
      progress.fail();
      const lines = screen
        .split("\n")
        .map((line) => line.split("\r").at(-1)!.trimEnd());
      expect(lines).toEqual([
        "Recovered the interrupted installation.",
        "[1/3] Checking the installed version... FAILED (1m 5s)",
        "",
      ]);
      expect(screen).toContain("[1/3] Checking the installed version... / 1s");
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to per-file checks for daemons without the batch request", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "windows-platform-"));
    roots.push(root);
    const daemon = path.join(root, "daemon");
    const requests = path.join(root, "requests");
    await writeFile(
      daemon,
      `#!/bin/sh\nread -r line\nprintf '%s\\n' "$line" >> '${requests}'\ncase "$line" in *check-private-paths*) exit 1 ;; esac\nprintf '{}'\n`,
      { mode: 0o755 },
    );
    await nativePlatform(daemon).checkFiles(["/a", "/b"]);
    const actions = (await readFile(requests, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).action);
    expect(actions).toEqual([
      "check-private-paths",
      "check-private-path",
      "check-private-path",
    ]);
  });

  it("rejects unsafe sources and permits plain HTTP origins", () => {
    expect(() =>
      validateDownloadSource("ftp://example.test/install"),
    ).toThrow();
    expect(() =>
      validateDownloadSource("https://user:secret@example.test/install"),
    ).toThrow();
    expect(() =>
      validateDownloadSource("file://server/share/package"),
    ).toThrow();
    expect(() =>
      validateDownloadSource("http://dev.example.test/install"),
    ).not.toThrow();
  });
  it("checks all manifest chunks and rejects unlisted or modified CLI assets", async () => {
    const f = await fixture();
    const { paths: good } = await f.publish("1.0.0");
    const staged = path.join(f.root, "staged");
    const extracted = await extractWindowsBundle(good, staged, privatePlatform);
    const checkFiles = vi.fn(async (files: string[]) => {
      for (const file of files) await privatePlatform.check(file, "file");
    });
    const check = vi.fn(privatePlatform.check);
    const before = await bundleChecksum(staged, {
      ...privatePlatform,
      check,
      checkFiles,
    });
    // The extracted checksum skips re-reading the files it just wrote.
    expect(before).toBe(extracted);
    // Fixed entries and manifest assets: two batches, not one call per file.
    expect(checkFiles).toHaveBeenCalledTimes(2);
    expect(check.mock.calls.every(([, kind]) => kind === "directory")).toBe(
      true,
    );
    await writeFile(
      path.join(staged, "cli/teamhub-chunks/help-ABCD.js"),
      "tampered",
    );
    await expect(bundleChecksum(staged, privatePlatform)).rejects.toThrow(
      "does not match its manifest",
    );
    expect(before).toMatch(/^[0-9a-f]{64}$/u);
    const bad = path.join(f.root, "extra.tar.gz");
    await writeFile(
      bad,
      await archive([
        ...WINDOWS_BUNDLE_ENTRIES.map((name: string) => ({
          name,
          content: "base",
        })),
        ...teamhubEntries(),
        { name: "cli/teamhub-chunks/unlisted.js", content: "extra" },
      ]),
    );
    await expect(
      extractWindowsBundle([bad], path.join(f.root, "extra"), privatePlatform),
    ).rejects.toThrow("outside its CLI manifest");
  });
  it.each(["valid", "corrupt", "unlisted"])(
    "checks Computer tools including USTAR prefixes and empty assets: %s",
    async (variant) => {
      const f = await fixture();
      const files = [
        { path: "extensions/pi-mcp.mjs", content: "fixture extension" },
        {
          path: "node_modules/@playwright/mcp/cli.js",
          content: "fixture entry",
        },
        {
          path: "node_modules/@scope/very-long-package-name/deep-dependency/node_modules/sibling/dist/resources/empty-resource.js",
          content: "",
        },
        { path: "cua/cua-driver.exe", content: "fixture driver" },
      ];
      const assets = files.map((file) => ({
        path: file.path,
        size_bytes: Buffer.byteLength(file.content),
        sha256: hash(file.content),
      }));
      const toolEntries = [
        {
          name: "cli/computer-tools/manifest.json",
          content: JSON.stringify({
            schema_version: 1,
            playwright_entry: files[1]!.path,
            pi_extension: files[0]!.path,
            cua_entry: files[3]!.path,
            assets,
            artifact_sha256: hash(JSON.stringify(assets)),
          }),
        },
        ...files.map((file) => ({
          name: `cli/computer-tools/${file.path}`,
          content: file.content,
        })),
      ];
      if (variant === "corrupt") toolEntries[1]!.content = "changed";
      if (variant === "unlisted")
        toolEntries.push({
          name: "cli/computer-tools/node_modules/unlisted.js",
          content: "unexpected",
        });
      const target = path.join(f.root, `tools-${variant}.tar.gz`);
      await writeFile(
        target,
        await archive([
          ...WINDOWS_BUNDLE_ENTRIES.map((name: string) => ({
            name,
            content: "base",
          })),
          ...teamhubEntries(),
          ...toolEntries,
        ]),
      );
      const staged = path.join(f.root, `tools-${variant}`);
      if (variant !== "valid")
        await expect(
          extractWindowsBundle([target], staged, privatePlatform),
        ).rejects.toThrow();
      else {
        await extractWindowsBundle([target], staged, privatePlatform);
        expect(
          await readFile(
            path.join(staged, "cli/computer-tools", files[2]!.path),
            "utf8",
          ),
        ).toBe("");
        await expect(bundleChecksum(staged, privatePlatform)).resolves.toMatch(
          /^[0-9a-f]{64}$/u,
        );
        await writeFile(
          path.join(staged, "cli/computer-tools", files[0]!.path),
          "changed",
        );
        await expect(bundleChecksum(staged, privatePlatform)).rejects.toThrow(
          "checksum mismatch",
        );
      }
    },
  );
  it.each([
    "../outside",
    "runtime/bin/node.exe",
    "cli/node_modules/untrusted.js",
    "cli/computer-tools/../outside.js",
    "cli/computer-tools/..\\..\\outside.js",
  ])("rejects unexpected or duplicate archive entry %s", async (entry) => {
    const f = await fixture();
    const { paths: good } = await f.publish("1.0.0");
    const staged = path.join(f.root, "staged");
    await extractWindowsBundle(good, staged, privatePlatform);
    expect(
      await readFile(path.join(staged, "runtime/LICENSE"), "utf8"),
    ).toContain("license");
    const bad = path.join(f.root, "bad.tar.gz");
    await writeFile(
      bad,
      await archive([
        ...WINDOWS_BUNDLE_ENTRIES.map((name: string) => ({
          name,
          content: "content",
        })),
        { name: entry, content: "unsafe" },
      ]),
    );
    await expect(
      extractWindowsBundle([bad], path.join(f.root, "bad"), privatePlatform),
    ).rejects.toThrow("invalid or unexpected");
  });
});

describe.skipIf(process.platform === "win32")(
  "Windows installer portable lifecycle with real fixture CLI",
  // Repeated real CLI launches share the existing installer harness budget.
  { timeout: 30_000 },
  () => {
    it("installs in a Unicode root without host Node lookup and repeats without artifact downloads or restarts", async () => {
      const f = await fixture();
      await f.publish("1.0.0");
      await f.run();
      const pointer = await f.current();
      expect(f.transfers).toHaveLength(2);
      f.transfers.length = 0;
      await f.run();
      expect(await f.current()).toBe(pointer);
      expect(f.transfers).toHaveLength(0);
      expect(
        await readFile(path.join(f.dataRoot, "invocations"), "utf8"),
      ).not.toMatch(/ (?:start|stop)/u);
      expect(
        await readFile(
          path.join(
            f.settings.binDirectory,
            "linger-computer-web.launcher.json",
          ),
          "utf8",
        ),
      ).toBe(windowsLauncherConfig(f.dataRoot));
    });
    it("keeps linger-computer.exe as the dispatcher while any environment remains", async () => {
      const f = await fixture();
      const bin = f.settings.binDirectory;
      const dispatcher = path.join(bin, "linger-computer.exe");
      await f.publish("1.0.0");
      await f.run();
      expect(await readFile(dispatcher)).toEqual(
        await readFile(path.join(bin, "linger-computer-web.exe")),
      );
      const other = {
        commandName: "linger-computer-other",
        dataRoot: path.join(f.root, "other computer"),
        webOrigin: "https://other.example.test",
      };
      await f.run(other);
      expect(await readdir(bin)).toEqual(
        expect.arrayContaining([
          "linger-computer-other.exe",
          "linger-computer-other.launcher.json",
          "linger-computer-web.exe",
          "linger-computer-web.launcher.json",
          "linger-computer.exe",
        ]),
      );

      await f.run({ operation: "uninstall" });
      expect(await readdir(bin)).toContain("linger-computer.exe");
      await f.run({ ...other, operation: "uninstall" });
      expect(await readdir(bin)).not.toContain("linger-computer.exe");

      await writeFile(dispatcher, "unrelated");
      await f.run();
      await expect(readFile(dispatcher, "utf8")).resolves.toBe("unrelated");
    });
    it("installs whatever release the deployment names and rejects bad metadata or archives", async () => {
      const f = await fixture();
      await f.publish("1.0.0");
      await f.run();
      const pointer = await f.current();
      // The deployment decides the version, so an older one installs too.
      const older = await f.publish("0.9.0");
      await f.run();
      expect(await f.current()).not.toBe(pointer);
      expect(
        await readFile(path.join(f.dataRoot, "installed-checksum"), "utf8"),
      ).toBe(`${windowsReleaseDigest(older.release)}\n`);
      const downgraded = await f.current();
      const { release } = await f.publish("1.1.0");
      await expect(
        f.run({
          release: {
            ...release,
            app: { ...release.app, file: "other.tar.gz" },
          },
        }),
      ).rejects.toThrow("metadata is invalid");
      await writeFile(
        path.join(f.distribution, "files", release.app.file),
        "broken archive",
      );
      await expect(f.run()).rejects.toThrow("checksum");
      expect(await f.current()).toBe(downgraded);
    });
    it("refuses active work and missing configuration before switching", async () => {
      const f = await fixture();
      await f.publish("1.0.0");
      await f.run();
      const pointer = await f.current();
      await f.configure(1);
      await f.publish("1.1.0");
      await expect(f.run()).rejects.toThrow("Operations are active");
      expect(await f.current()).toBe(pointer);
      await rm(path.join(f.dataRoot, "config.json"));
      privatePlatform.request.mockImplementationOnce(async () => ({
        stopped: false,
      }));
      await expect(f.run()).rejects.toThrow(
        "configuration is missing but the daemon is still running",
      );
      expect(await f.current()).toBe(pointer);
    });
    it("upgrades an installation that never logged in without stopping a daemon", async () => {
      const f = await fixture();
      await f.publish("1.0.0");
      await f.run();
      const pointer = await f.current();
      await f.publish("1.1.0");
      await f.run();
      expect(await f.current()).not.toBe(pointer);
      expect(
        await readFile(path.join(f.dataRoot, "invocations"), "utf8"),
      ).not.toMatch(/ (stop|start)\b/);
    });
    it("upgrades a verified bundle with a teamhub.cmd to the native CLI layout", async () => {
      const f = await fixture();
      const legacy = await f.publish("0.9.0", { legacy: true });
      const digest = windowsReleaseDigest(legacy.release);
      const name = `lib-${digest.slice(0, 16)}-abcd`;
      const bundle = path.join(f.dataRoot, name);
      await extractWindowsBundle(legacy.paths, bundle, privatePlatform);
      await privatePlatform.ensure(f.settings.binDirectory);
      await privatePlatform.write(
        path.join(f.settings.binDirectory, "linger-computer.cmd"),
        "@echo off\r\nrem linger-computer-launcher-v1\r\n",
      );
      for (const [file, value] of Object.entries({
        "active-bundle": name,
        "installed-bundle-checksum": await bundleChecksum(
          bundle,
          privatePlatform,
        ),
        "installed-checksum": digest,
      }))
        await privatePlatform.write(path.join(f.dataRoot, file), value);
      await f.configure();
      const old = await f.current();
      await f.publish("0.10.0");
      await f.run();
      const upgraded = path.join(f.dataRoot, await f.current());
      expect(await f.current()).not.toBe(old);
      expect(
        await readFile(path.join(upgraded, "cli/teamhub-assets.json"), "utf8"),
      ).toContain("help-ABCD.js");
      await f.run({ operation: "uninstall" });
      expect(await readdir(f.dataRoot)).not.toContain("active-bundle");
    });
    it("upgrades idle daemons and retains bundles used by managed previews", async () => {
      const f = await fixture();
      await f.publish("1.0.0");
      await f.run();
      await f.configure();
      const old = await f.current();
      await f.publish("1.1.0");
      await f.run();
      expect(await f.current()).not.toBe(old);
      expect(await readdir(f.dataRoot)).toContain(old);
      const invocations = await readFile(
        path.join(f.dataRoot, "invocations"),
        "utf8",
      );
      expect(invocations).toContain("1.0.0 daemon stop --if-idle");
      expect(invocations).toContain("1.1.0 daemon start");
      expect(privatePlatform.request).not.toHaveBeenCalledWith(
        "stop-managed-services",
        expect.anything(),
      );
    });
    it("restores pointer, checksum, and old daemon when metadata or readiness fails", async () => {
      const f = await fixture();
      const installed = await f.publish("1.0.0");
      await f.run();
      await f.configure();
      const old = await f.current();
      const launcher = path.join(
        f.settings.binDirectory,
        "linger-computer-web.exe",
      );
      const originalLauncher = await readFile(launcher);
      await f.publish("1.1.0");
      vi.stubEnv(
        "LINGER_INSTALL_TEST_FAIL_AFTER_METADATA_WRITE",
        "installed-checksum",
      );
      await expect(f.run()).rejects.toThrow("metadata failure");
      vi.unstubAllEnvs();
      expect(await f.current()).toBe(old);
      expect(await readFile(launcher)).toEqual(originalLauncher);
      expect(
        await readFile(path.join(f.dataRoot, "installed-checksum"), "utf8"),
      ).toBe(`${windowsReleaseDigest(installed.release)}\n`);
      const broken = await f.publish("1.1.0", { brokenStart: true });
      await expect(f.run()).rejects.toThrow("did not reconnect");
      // The daemon reads this to wait before trying the release again.
      expect(
        JSON.parse(
          await readFile(path.join(f.dataRoot, "upgrade-failed"), "utf8"),
        ),
      ).toEqual({
        app_sha256: windowsReleaseDigest(broken.release),
        failed_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/u),
      });
      expect(await f.current()).toBe(old);
      expect(await readFile(launcher)).toEqual(originalLauncher);
      expect(
        await readFile(path.join(f.dataRoot, "fixture-status.json"), "utf8"),
      ).toContain('"state":"running"');
    });
    it("defers rollback while new work runs and recovers from its persistent journal", async () => {
      const f = await fixture();
      await f.publish("1.0.0");
      await f.run();
      await f.configure();
      const old = await f.current();
      await f.publish("1.1.0", { brokenStart: true, busyAfterStart: true });
      await expect(f.run()).rejects.toThrow("rollback was deferred");
      expect(await f.current()).not.toBe(old);
      expect(await readdir(f.dataRoot)).toContain(".install-transaction.json");
      await f.configure(0);
      const latest = await f.publish("1.2.0");
      await f.run();
      expect(await readdir(f.dataRoot)).not.toContain(
        ".install-transaction.json",
      );
      expect(
        await readFile(path.join(f.dataRoot, "installed-checksum"), "utf8"),
      ).toBe(`${windowsReleaseDigest(latest.release)}\n`);
    });
    it.each([4_241_920, 4_546_048])(
      "recovers an interrupted upgrade with a %i-byte native launcher",
      async (size) => {
        const f = await fixture(size);
        await f.publish("1.0.0");
        await f.run();
        await f.configure();
        const old = await f.current();
        await f.publish("1.1.0", {
          brokenStart: true,
          busyAfterStart: true,
        });
        await expect(f.run()).rejects.toThrow("rollback was deferred");
        const journal = await readFile(
          path.join(f.dataRoot, ".install-transaction.json"),
        );
        expect(journal.length).toBeLessThan(16 * 1024);
        await f.configure(0);
        await f.publish("1.2.0");
        await f.run();
        expect(await f.current()).not.toBe(old);
        expect(await readdir(f.dataRoot)).not.toContain(
          ".install-transaction.json",
        );
      },
    );
    it.each([1, 2])(
      "recovers legacy schema %i journals without changing their rollback behavior",
      async (schemaVersion) => {
        const f = await fixture(4_546_048);
        await f.publish("1.0.0");
        await f.run();
        await f.configure();
        const original = await readFile(
          path.join(f.settings.binDirectory, "linger-computer-web.exe"),
        );
        await f.publish("1.1.0", {
          brokenStart: true,
          busyAfterStart: true,
        });
        await expect(f.run()).rejects.toThrow("rollback was deferred");
        const journalFile = path.join(f.dataRoot, ".install-transaction.json");
        const journal = JSON.parse(await readFile(journalFile, "utf8"));
        journal.schemaVersion = schemaVersion;
        journal.launcher =
          schemaVersion === 1
            ? "@echo off\r\nrem linger-computer-launcher-v1\r\n"
            : original.toString("base64");
        delete journal.launcherChecksum;
        if (schemaVersion === 1) {
          delete journal.launcherConfig;
          delete journal.legacyLauncher;
        }
        await privatePlatform.write(journalFile, JSON.stringify(journal));
        if (schemaVersion === 2)
          expect((await lstat(journalFile)).size).toBeGreaterThan(
            4 * 1024 * 1024,
          );
        await f.configure(0);
        const latest = await f.publish("1.2.0");
        await f.run();
        expect(await readdir(f.dataRoot)).not.toContain(
          ".install-transaction.json",
        );
        expect(
          await readFile(path.join(f.dataRoot, "installed-checksum"), "utf8"),
        ).toBe(`${windowsReleaseDigest(latest.release)}\n`);
      },
    );
    it.each(["installed-checksum", "active-bundle"])(
      "preserves repair recovery when %s writing fails",
      async (metadata) => {
        const f = await fixture();
        await f.publish("1.0.0");
        await f.run();
        await f.configure();
        const old = await f.current();
        const launcher = path.join(
          f.settings.binDirectory,
          "linger-computer-web.exe",
        );
        const original = await readFile(launcher);
        await writeFile(
          path.join(f.dataRoot, old, "cli/linger-computer.exe"),
          "corrupt old entry",
        );
        await f.publish("1.1.0");
        vi.stubEnv("LINGER_INSTALL_TEST_FAIL_AFTER_METADATA_WRITE", metadata);
        await expect(f.run()).rejects.toThrow("metadata failure");
        vi.unstubAllEnvs();
        expect(await readdir(f.dataRoot)).not.toContain(
          ".install-transaction.json",
        );
        if (metadata === "active-bundle") {
          expect(await f.current()).not.toBe(old);
          expect(await readFile(launcher)).not.toEqual(original);
        } else {
          expect(await f.current()).toBe(old);
          expect(await readFile(launcher)).toEqual(original);
        }
        await f.run();
        expect(await f.current()).not.toBe(old);
      },
    );
    it("never executes a modified installed program", async () => {
      const f = await fixture();
      await f.publish("1.0.0");
      await f.run();
      await f.configure();
      const old = path.join(f.dataRoot, await f.current());
      const marker = path.join(f.root, "untrusted-executed");
      await writeFile(
        path.join(old, "cli/linger-computer.exe"),
        `#!/bin/sh\ntouch '${marker}'\nexit 1\n`,
      );
      await chmod(path.join(old, "cli/linger-computer.exe"), 0o700);
      await f.publish("1.1.0");
      await f.run();
      await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    });
    it("stops managed services and owned processes before removing a bundle; preserves data by default", async () => {
      privatePlatform.request.mockClear();
      const f = await fixture();
      await f.publish("1.0.0");
      await f.run();
      await f.configure();
      await writeFile(path.join(f.dataRoot, "user-project"), "preserve");
      await f.run({ operation: "uninstall" });
      expect(
        privatePlatform.request.mock.calls.map(([action]) => action),
      ).toEqual([
        "stop-managed-services",
        "cleanup-owned-processes",
        "owned-processes-stopped",
      ]);
      expect(
        await readFile(path.join(f.dataRoot, "config.json"), "utf8"),
      ).toContain("state_directory");
      expect(await readdir(f.dataRoot)).not.toContain("active-bundle");
      await f.publish("1.0.0");
      await f.run();
      await f.run({ operation: "uninstall", purge: true });
      expect(await readdir(f.dataRoot)).not.toContain("config.json");
      expect(
        await readFile(path.join(f.dataRoot, "user-project"), "utf8"),
      ).toBe("preserve");
    });
    it("restores a complete installation when a Windows sharing violation interrupts uninstall", async () => {
      const f = await fixture();
      await f.publish("1.0.0");
      await f.run();
      await f.configure();
      const current = await f.current();
      const checksum = await bundleChecksum(
        path.join(f.dataRoot, current),
        privatePlatform,
      );
      const moveBundle = async (bundle: string, snapshot: string) => {
        await rename(bundle, snapshot);
        throw new Error("EPERM: Windows sharing violation");
      };
      await expect(
        runWindowsInstaller(
          { ...f.settings, operation: "uninstall" },
          { platform: privatePlatform, moveBundle, log: () => {} },
        ),
      ).rejects.toThrow("sharing violation");
      expect(await f.current()).toBe(current);
      expect(
        await bundleChecksum(path.join(f.dataRoot, current), privatePlatform),
      ).toBe(checksum);
      expect(await readdir(f.dataRoot)).not.toContain(
        ".uninstall-transaction.json",
      );
    });
    it("reports each operation's progress steps and outcome in order", async () => {
      const f = await fixture();
      const lines: string[] = [];
      const run = (extra = {}) =>
        runWindowsInstaller(
          { ...f.settings, ...extra },
          {
            platform: privatePlatform,
            download: async (source: string, destination: string) => {
              await writeFile(
                destination,
                await readFile(
                  path.join(
                    f.distribution,
                    new URL(source).pathname.replace(/^\/install\//u, ""),
                  ),
                ),
                { flag: "wx" },
              );
            },
            log: (line: string) =>
              lines.push(line.replace(/\d+m \d+s|\d+s/gu, "T")),
            readinessTimeoutMs: 1,
            checkExecutable: async () => {},
          },
        );
      const transcript = () => lines.splice(0);
      const { release: first } = await f.publish("1.0.0");
      await run({ release: first });
      expect(transcript()).toEqual([
        "[1/4] Checking the installed version...",
        "[1/4] Checking the installed version... OK (T)",
        "[2/4] Downloading the package...",
        "[2/4] Downloading the package... OK (T)",
        "[3/4] Verifying the package...",
        "[3/4] Verifying the package... OK (T)",
        "[4/4] Installing...",
        "[4/4] Installing... OK (T)",
        "Linger Computer 1.0.0 installed in T.",
      ]);
      await run({ release: first });
      expect(transcript()).toEqual([
        "[1/4] Checking the installed version...",
        "[1/4] Checking the installed version... up to date (T)",
        "Linger Computer is already up to date.",
      ]);
      await f.configure();
      const { release: second } = await f.publish("1.1.0");
      await run({ release: second });
      expect(transcript()).toEqual([
        "[1/4] Checking the installed version...",
        "[1/4] Checking the installed version... OK (T)",
        "[2/4] Downloading the package...",
        "[2/4] Downloading the package... OK (T)",
        "[3/4] Verifying the package...",
        "[3/4] Verifying the package... OK (T)",
        "[4/4] Installing...",
        "[4/4] Installing... OK (T)",
        "Linger Computer upgraded to 1.1.0 in T.",
      ]);

      // An uninstall interrupted after it moved the bundle aside is undone
      // before the next operation.
      const current = await f.current();
      const snapshot = ".uninstall-0123abcd";
      const checksum = await bundleChecksum(
        path.join(f.dataRoot, current),
        privatePlatform,
      );
      await mkdir(path.join(f.dataRoot, snapshot));
      await rename(
        path.join(f.dataRoot, current),
        path.join(f.dataRoot, snapshot, current),
      );
      await writeFile(
        path.join(f.dataRoot, ".uninstall-transaction.json"),
        JSON.stringify({
          schemaVersion: 1,
          snapshot,
          committed: false,
          bundles: [{ name: current, checksum }],
        }),
      );
      await run({ release: second });
      expect(transcript()).toEqual([
        "[1/4] Checking the installed version...",
        "Recovered the interrupted uninstallation.",
        "[1/4] Checking the installed version... up to date (T)",
        "Linger Computer is already up to date.",
      ]);
      expect(await readdir(f.dataRoot)).not.toContain(snapshot);

      await run({ operation: "uninstall" });
      expect(transcript()).toEqual([
        "[1/3] Checking the installed version...",
        "[1/3] Checking the installed version... OK (T)",
        "[2/3] Stopping the Computer daemon...",
        "[2/3] Stopping the Computer daemon... OK (T)",
        "[3/3] Removing installed files...",
        "[3/3] Removing installed files... OK (T)",
        `Uninstalled linger-computer-web (https://web.example.test) in T. Config, credentials, state, and logs were preserved in ${f.dataRoot}.`,
      ]);
      await run({ operation: "uninstall" });
      expect(transcript()).toEqual([
        "[1/3] Checking the installed version...",
        "[1/3] Checking the installed version... not installed (T)",
        "Local Computer is not installed.",
      ]);
    });
    it("preserves the installation when an ownership file cannot be trusted", async () => {
      const f = await fixture();
      await f.publish("1.0.0");
      await f.run();
      const outside = path.join(f.root, "outside");
      await writeFile(outside, "{}\n");
      await symlink(outside, path.join(f.dataRoot, "config.json"));
      await expect(f.run({ operation: "uninstall" })).rejects.toThrow(
        "Unsafe fixture path",
      );
      expect(await f.current()).toMatch(/^lib-/u);
      expect(await readFile(outside, "utf8")).toBe("{}\n");
    });
  },
);
