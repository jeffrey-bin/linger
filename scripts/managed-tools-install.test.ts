import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createManagedToolsInstaller,
  detectManagedToolsPlatform,
} from "./managed-tools-install.mjs";

const roots: string[] = [];
const execute = promisify(execFile);
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("Tests must not access the network"),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const digest = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
interface Entry {
  name: string;
  content?: string;
  type?: string;
  link?: string;
}
function tar(entries: Entry[]) {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? "");
    const header = Buffer.alloc(512);
    const field = (start: number, width: number, value: string) =>
      header.write(value, start, width, "utf8");
    field(0, 100, entry.name);
    field(100, 8, "0000755\0");
    field(124, 12, content.length.toString(8).padStart(11, "0") + "\0");
    field(148, 8, "        ");
    field(156, 1, entry.type ?? "0");
    field(157, 100, entry.link ?? "");
    field(257, 6, "ustar\0");
    field(
      148,
      8,
      header
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, "0") + "\0 ",
    );
    blocks.push(
      header,
      content,
      Buffer.alloc((512 - (content.length % 512)) % 512),
    );
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
function hashedEntries(name: string, content: string): Entry[] {
  return [
    { name, content },
    { name: "files.sha256", content: `${digest(content)}  ${name}\n` },
  ];
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "managed tools "));
  roots.push(root);
  const home = path.join(root, "home");
  await mkdir(home);
  vi.stubEnv("HOME", home);
  const source = path.join(root, "local releases");
  const installRoot = path.join(root, "managed tools");
  await mkdir(path.join(source, "cli/manifests"), { recursive: true });
  const options = {
    root: installRoot,
    baseUrl: source,
    detectPlatform: async () => "linux-amd64",
  };
  return {
    root,
    source,
    installRoot,
    options,
    installer: createManagedToolsInstaller(options),
  };
}
async function release(
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  version = "1.0.0",
  overrides: Partial<Record<string, Entry[]>> = {},
) {
  const tools: Record<
    string,
    {
      version: string;
      artifacts: Record<string, { path: string; size: number; sha256: string }>;
    }
  > = {};
  for (const tool of ["teamhub", "lev8"]) {
    const script = `#!/bin/sh\nprintf '${tool} ${version}\\n'\n`;
    const entries = overrides[tool] ?? hashedEntries(tool, script);
    const archive = tar(entries);
    const artifactPath = `cli/${id}-${tool}.tar.gz`;
    await writeFile(path.join(f.source, artifactPath), archive);
    tools[tool] = {
      version,
      artifacts: {
        "linux-amd64": {
          path: artifactPath,
          size: archive.length,
          sha256: digest(archive),
        },
      },
    };
  }
  const manifest = {
    schema: 1,
    release_id: id,
    node: { version: "26.5.0" },
    tools,
  };
  const manifestPath = path.join(f.source, `cli/manifests/${id}.json`);
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { manifest, manifestPath };
}

describe("managed tools transaction", () => {
  it("requires checksums for a native TeamHub entry even alongside JavaScript assets", async () => {
    const f = await fixture();
    const js = "export {};";
    await release(f, "mixed", "1.0.0", {
      teamhub: [
        { name: "teamhub", content: "#!/bin/sh\necho teamhub 1.0.0\n" },
        { name: "teamhub.js", content: js },
        {
          name: "teamhub-assets.json",
          content: JSON.stringify({
            schema_version: 1,
            entrypoint: "teamhub.js",
            assets: [
              {
                path: "teamhub.js",
                size_bytes: Buffer.byteLength(js),
                sha256: digest(js),
              },
            ],
          }),
        },
      ],
    });
    await expect(f.installer.ensure("mixed")).rejects.toThrow(/files.sha256/);
    expect((await f.installer.status()).current).toBeNull();
  });

  it.each(["teamhub", "lev8", "teamhub.js"])(
    "requires the integrity manifest for %s on install, ensure and rollback",
    async (entrypoint) => {
      const f = await fixture();
      const tool = entrypoint === "lev8" ? "lev8" : "teamhub";
      const script = entrypoint.endsWith(".js")
        ? "import { writeSync } from 'node:fs'; writeSync(1, 'teamhub 1.0.0\\n');"
        : `#!/bin/sh\necho ${tool} 1.0.0\n`;
      const manifestName = entrypoint.endsWith(".js")
        ? "teamhub-assets.json"
        : "files.sha256";
      const entries = entrypoint.endsWith(".js")
        ? [
            { name: entrypoint, content: script },
            {
              name: manifestName,
              content: JSON.stringify({
                schema_version: 1,
                entrypoint,
                assets: [
                  {
                    path: entrypoint,
                    size_bytes: Buffer.byteLength(script),
                    sha256: digest(script),
                  },
                ],
              }),
            },
          ]
        : hashedEntries(entrypoint, script);
      await release(f, "first", "1.0.0", { [tool]: entries });
      await release(f, "missing-manifest", "1.0.0", {
        [tool]: entries.filter((entry) => entry.name !== manifestName),
      });
      await expect(f.installer.ensure("missing-manifest")).rejects.toThrow(
        /ENOENT|manifest/i,
      );
      expect((await f.installer.status()).current).toBeNull();
      const first = await f.installer.ensure("first");
      await rm(path.join(first.current!.directory, tool, manifestName));
      await rm(path.join(f.source, "cli/manifests/first.json"));
      await expect(f.installer.ensure("first")).rejects.toThrow(/ENOENT/);
      await release(f, "first", "1.0.0", { [tool]: entries });
      const repaired = await f.installer.ensure("first");
      expect(repaired.current!.directory).not.toBe(first.current!.directory);
      expect(repaired.previous).toBeNull();
      await release(f, "second", "2.0.0");
      const second = await f.installer.update("second");
      await rm(path.join(repaired.current!.directory, tool, manifestName));
      await expect(f.installer.rollback()).rejects.toThrow(/ENOENT|manifest/i);
      expect((await f.installer.status()).current!.directory).toBe(
        second.current!.directory,
      );
    },
  );

  it.each(["directory", "metadata missing", "metadata invalid"])(
    "reports and repairs corrupt current %s without retaining stale previous",
    async (fault) => {
      const f = await fixture();
      await release(f, "first");
      await release(f, "second", "2.0.0");
      const first = await f.installer.ensure("first");
      const second = await f.installer.update("second");
      await rm(first.current!.directory, { recursive: true });
      if (fault === "directory")
        await rm(second.current!.directory, { recursive: true });
      else if (fault === "metadata missing")
        await rm(path.join(second.current!.directory, ".release.json"));
      else
        await writeFile(
          path.join(second.current!.directory, ".release.json"),
          "{bad json",
        );
      const state = await f.installer.status();
      expect(state.current).toBeNull();
      expect(state.previous).toBeNull();
      expect(state).toMatchObject({
        corrupt: { current: expect.any(String), previous: expect.any(String) },
      });
      // Failed preparation must keep both old pointers available for diagnosis.
      await expect(f.installer.ensure("absent")).rejects.toThrow(/ENOENT/);
      expect(await f.installer.status()).toEqual(state);
      const repaired = await f.installer.ensure("second");
      expect(repaired.current!.releaseId).toBe("second");
      expect(repaired.previous).toBeNull();
      await rm(path.join(repaired.current!.directory, ".release.json"));
      const updated = await f.installer.update("first");
      expect(updated.current!.releaseId).toBe("first");
      expect(updated.previous).toBeNull();
    },
  );

  it("preserves a verified previous release when repairing a missing current directory", async () => {
    const f = await fixture();
    await release(f, "first");
    await release(f, "second", "2.0.0");
    const first = await f.installer.ensure("first");
    const second = await f.installer.update("second");
    await rm(second.current!.directory, { recursive: true });
    const repaired = await f.installer.ensure("second");
    expect(repaired.previous!.directory).toBe(first.current!.directory);
    expect((await f.installer.rollback()).current!.releaseId).toBe("first");
  });

  it("recovers an interrupted rollback without journaling a corrupt current as previous", async () => {
    const f = await fixture();
    await release(f, "first");
    await release(f, "second", "2.0.0");
    await f.installer.ensure("first");
    const second = await f.installer.update("second");
    await rm(second.current!.directory, { recursive: true });
    const installer = createManagedToolsInstaller({
      ...f.options,
      onSwitch: () => {
        throw new Error("interrupted rollback");
      },
    });
    await expect(installer.rollback()).rejects.toThrow("interrupted rollback");
    const recovered = await f.installer.status();
    expect(recovered.current!.releaseId).toBe("first");
    expect(recovered.previous).toBeNull();
  });

  it.each(["path", "directory link", "metadata link", "non-directory"])(
    "rejects unsafe journal previous %s without changing pointers",
    async (fault) => {
      const f = await fixture();
      await release(f, "first");
      await release(f, "second", "2.0.0");
      await f.installer.ensure("first");
      const second = await f.installer.update("second");
      const current = await readlink(path.join(f.installRoot, "previous"));
      const previous = await readlink(path.join(f.installRoot, "current"));
      const outside = path.join(f.root, "outside");
      await mkdir(outside);
      if (fault === "directory link" || fault === "non-directory") {
        await rm(second.current!.directory, { recursive: true });
        if (fault === "directory link")
          await symlink(outside, second.current!.directory);
        else await writeFile(second.current!.directory, "unmanaged");
      } else if (fault === "metadata link") {
        const metadata = path.join(second.current!.directory, ".release.json");
        await writeFile(
          path.join(outside, "metadata"),
          await readFile(metadata),
        );
        await rm(metadata);
        await symlink(path.join(outside, "metadata"), metadata);
      }
      const journalPath = path.join(f.installRoot, ".transaction.json");
      const journal = JSON.stringify({
        schema: 1,
        current,
        previous: fault === "path" ? "../outside" : previous,
      });
      await writeFile(journalPath, journal);
      for (const operation of [
        () => f.installer.status(),
        () => f.installer.ensure("first"),
        () => f.installer.update("first"),
        () => f.installer.rollback(),
      ])
        await expect(operation()).rejects.toMatchObject({
          code: "UNMANAGED_LAYOUT",
        });
      expect(await readlink(path.join(f.installRoot, "current"))).toBe(
        previous,
      );
      expect(await readlink(path.join(f.installRoot, "previous"))).toBe(
        current,
      );
      expect(await readFile(journalPath, "utf8")).toBe(journal);
      expect(await readdir(path.join(f.installRoot, ".locks"))).toEqual([]);
    },
  );

  it.each(["corrupt", "unmanaged"])(
    "rejects a journal with %s current without changing pointers",
    async (fault) => {
      const f = await fixture();
      await release(f, "first");
      const installed = await f.installer.ensure("first");
      const current = await readlink(path.join(f.installRoot, "current"));
      if (fault === "corrupt")
        await writeFile(
          path.join(installed.current!.directory, ".release.json"),
          "{bad json",
        );
      const journalPath = path.join(f.installRoot, ".transaction.json");
      const journal = JSON.stringify({
        schema: 1,
        current: fault === "unmanaged" ? "../outside" : current,
        previous: null,
      });
      await writeFile(journalPath, journal);
      await expect(f.installer.status()).rejects.toThrow();
      expect(await readlink(path.join(f.installRoot, "current"))).toBe(current);
      await expect(
        readlink(path.join(f.installRoot, "previous")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(journalPath, "utf8")).toBe(journal);
    },
  );

  it.each(["pointer", "directory", "metadata", "non-managed"])(
    "rejects unsafe current %s instead of repairing it",
    async (fault) => {
      const f = await fixture();
      await release(f, "first");
      const installed = await f.installer.ensure("first");
      const outside = path.join(f.root, "outside");
      await mkdir(outside);
      if (fault === "pointer" || fault === "non-managed") {
        await rm(path.join(f.installRoot, "current"));
        if (fault === "pointer")
          await symlink(outside, path.join(f.installRoot, "current"));
        else await mkdir(path.join(f.installRoot, "current"));
      } else if (fault === "directory") {
        await rm(installed.current!.directory, { recursive: true });
        await symlink(outside, installed.current!.directory);
      } else {
        const metadata = path.join(
          installed.current!.directory,
          ".release.json",
        );
        await writeFile(
          path.join(outside, "metadata"),
          await readFile(metadata),
        );
        await rm(metadata);
        await symlink(path.join(outside, "metadata"), metadata);
      }
      for (const action of [
        () => f.installer.status(),
        () => f.installer.ensure("first"),
        () => f.installer.update("first"),
      ])
        await expect(action()).rejects.toThrow();
      expect(await readdir(path.join(f.installRoot, ".locks"))).toEqual([]);
    },
  );

  it.each(["available", "unavailable"])(
    "hard-kills smoke processes that ignore SIGTERM and releases the lock with %s process groups",
    async (processGroups) => {
      if (processGroups === "unavailable") {
        const kill = process.kill.bind(process);
        vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
          if (pid < 0)
            throw Object.assign(new Error("Process group unavailable"), {
              code: "ESRCH",
            });
          return kill(pid, signal);
        });
      }
      const f = await fixture();
      await release(f, "first");
      const installed = await f.installer.ensure("first");
      const pidFile = path.join(f.root, "smoke-pids");
      const termFile = path.join(f.root, "smoke-term");
      const childCode = `const fixture = ${JSON.stringify(f.root)}; process.on('SIGTERM', () => {}); require('node:fs').writeSync(1, 'ready'); setInterval(() => {}, 1000);`;
      const script = `#!${process.execPath}\nimport { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs'; process.on('SIGTERM', () => writeFileSync(${JSON.stringify(termFile)}, 'received')); const child = spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}]); child.stdout.once('data', () => writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, child.pid]))); setInterval(() => {}, 1000);`;
      // Exercise the timeout on the first smoke target, before an unrelated
      // executable's cold startup can consume the fixture's short deadline.
      await release(f, "hung", "2.0.0", {
        teamhub: hashedEntries("teamhub", script),
      });
      const installer = createManagedToolsInstaller({
        ...f.options,
        smokeTimeoutMs: 1500,
      });
      // A process outside the installer's owned group must survive its cleanup.
      const unrelated = spawn(
        process.execPath,
        ["-e", "console.log('ready'); setInterval(() => {}, 1000);"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      await once(unrelated.stdout, "data");
      const started = Date.now();
      const operation = installer.update("hung");
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      try {
        await expect(
          Promise.race([
            operation,
            new Promise((_, reject) => {
              watchdog = setTimeout(
                () => reject(new Error("Smoke did not meet hard deadline")),
                5000,
              );
            }),
          ]),
        ).rejects.toThrow(/timed out/i);
        expect(Date.now() - started).toBeLessThan(4500);
        expect(await readFile(termFile, "utf8")).toBe("received");
        const pids: number[] = JSON.parse(await readFile(pidFile, "utf8"));
        for (const pid of pids) {
          // A killed orphan can remain a zombie until init reaps it, on macOS too.
          await vi.waitFor(
            async () => {
              if (process.platform === "linux") {
                const processState = await readFile(
                  `/proc/${pid}/stat`,
                  "utf8",
                ).catch(() => null);
                expect(
                  processState === null ||
                    processState.split(") ")[1].startsWith("Z "),
                ).toBe(true);
              } else if (process.platform === "darwin") {
                const result = await execute("ps", [
                  "-p",
                  String(pid),
                  "-o",
                  "stat=",
                ]).catch((error: { code?: number; stdout?: string }) => {
                  // ps exits 1 when no matching process exists; other failures
                  // must remain visible instead of being treated as death.
                  if (error.code === 1 && !error.stdout?.trim())
                    return { stdout: "" };
                  throw error;
                });
                expect(
                  result.stdout.trim(),
                  `Smoke process ${pid} remains active`,
                ).toMatch(/^(?:Z.*)?$/u);
              } else expect(() => process.kill(pid, 0)).toThrow();
            },
            { timeout: 500, interval: 10 },
          );
        }
        expect(await readdir(path.join(f.installRoot, ".locks"))).toEqual([]);
        expect(await readdir(path.join(f.installRoot, ".staging"))).toEqual([]);
        expect((await f.installer.ensure("first")).current!.directory).toBe(
          installed.current!.directory,
        );
        expect(unrelated.exitCode).toBeNull();
        expect(unrelated.signalCode).toBeNull();
      } finally {
        clearTimeout(watchdog);
        const pids: number[] = JSON.parse(
          await readFile(pidFile, "utf8").catch(() => "[]"),
        );
        for (const pid of pids) {
          try {
            const { stdout } = await execute("ps", [
              "-p",
              String(pid),
              "-o",
              "command=",
            ]);
            // Cleanup only this fixture's matching command if the test failed;
            // never signal a PID that has since been reused for another process.
            if (stdout.includes(f.root)) process.kill(pid, "SIGKILL");
          } catch {
            /* Already stopped. */
          }
        }
        await operation.catch(() => {});
        if (unrelated.exitCode === null && unrelated.signalCode === null) {
          const unrelatedExited = once(unrelated, "exit");
          unrelated.kill("SIGKILL");
          await unrelatedExited;
        }
      }
    },
  );

  it.each([
    [
      "stdout limit",
      'process.stdout.write(Buffer.alloc(1024 * 1024 + 1, "x"));',
      { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" },
    ],
    [
      "stderr limit",
      'process.stderr.write(Buffer.alloc(1024 * 1024 + 1, "x"));',
      { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" },
    ],
    [
      "exit code",
      'process.stdout.write("output"); process.stderr.write("failure"); process.exitCode = 7;',
      { code: 7, signal: null, stdout: "output", stderr: "failure" },
    ],
    [
      "termination signal",
      'process.kill(process.pid, "SIGTERM");',
      { code: null, signal: "SIGTERM" },
    ],
  ])(
    "preserves %s smoke failures without switching the current release",
    async (_label, code, failure) => {
      const f = await fixture();
      await release(f, "first");
      const installed = await f.installer.ensure("first");
      await release(f, "broken", "2.0.0", {
        teamhub: hashedEntries("teamhub", `#!${process.execPath}\n${code}\n`),
      });
      await expect(f.installer.update("broken")).rejects.toMatchObject(failure);
      expect((await f.installer.status()).current).toEqual(installed.current);
      expect(await readdir(path.join(f.installRoot, ".locks"))).toEqual([]);
      expect(await readdir(path.join(f.installRoot, ".staging"))).toEqual([]);
    },
  );

  it("supports environment configuration and leaves self-installed and legacy tools untouched", async () => {
    const f = await fixture();
    await release(f, "first");
    const ownedByUser = path.join(f.root, "user bin");
    await mkdir(ownedByUser);
    for (const name of ["teamhub", "lev8", "legacy-cli"])
      await writeFile(path.join(ownedByUser, name), "user-owned");
    vi.stubEnv("LINGER_TOOLS_ROOT", f.installRoot);
    vi.stubEnv("LINGER_CLI_RELEASES_BASE_URL", f.source);
    const installer = createManagedToolsInstaller({
      detectPlatform: f.options.detectPlatform,
    });
    expect((await installer.ensure("first")).current!.releaseId).toBe("first");
    for (const name of await readdir(ownedByUser))
      expect(await readFile(path.join(ownedByUser, name), "utf8")).toBe(
        "user-owned",
      );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("supports existing TeamHub entry/chunk manifests and detects a missing lazy chunk before activation", async () => {
    const f = await fixture();
    const js =
      "import { writeSync } from 'node:fs'; writeSync(1, 'teamhub 1.0.0\\n');";
    const chunk = "export const fixture = true;";
    const assets = [
      {
        path: "teamhub.js",
        size_bytes: Buffer.byteLength(js),
        sha256: digest(js),
      },
      {
        path: "teamhub-chunks/lazy.js",
        size_bytes: Buffer.byteLength(chunk),
        sha256: digest(chunk),
      },
    ];
    const entries = [
      { name: "teamhub.js", content: js },
      { name: "teamhub-chunks/lazy.js", content: chunk },
      {
        name: "teamhub-assets.json",
        content: JSON.stringify({
          schema_version: 1,
          entrypoint: "teamhub.js",
          assets,
        }),
      },
    ];
    await release(f, "first", "1.0.0", { teamhub: entries });
    const good = await f.installer.ensure("first");
    await release(f, "missing-chunk", "1.0.0", {
      teamhub: entries.filter((entry) => !entry.name.endsWith("lazy.js")),
    });
    await expect(f.installer.update("missing-chunk")).rejects.toThrow(/ENOENT/);
    expect((await f.installer.status()).current!.directory).toBe(
      good.current!.directory,
    );
  });

  it("accepts safe internal links and the historic lev8 archive wrapper", async () => {
    const f = await fixture();
    const binary = "#!/bin/sh\necho lev8 1.0.0\n";
    await release(f, "wrapped", "1.0.0", {
      lev8: [
        { name: "lev8_1.0.0_linux_amd64/actual", content: binary },
        { name: "lev8_1.0.0_linux_amd64/lev8", type: "2", link: "actual" },
        {
          name: "lev8_1.0.0_linux_amd64/files.sha256",
          content: `${digest(binary)}  actual\n${digest(binary)}  lev8\n`,
        },
      ],
    });
    expect((await f.installer.ensure("wrapped")).current!.releaseId).toBe(
      "wrapped",
    );
  });

  it("rejects missing checksum-listed files and an invalid rollback candidate", async () => {
    const f = await fixture();
    await release(f, "first");
    const old = await f.installer.ensure("first");
    await release(f, "missing-hashed", "1.0.0", {
      lev8: [
        { name: "lev8", content: "#!/bin/sh\necho lev8 1.0.0\n" },
        { name: "files.sha256", content: `${digest("absent")}  absent\n` },
      ],
    });
    await expect(f.installer.update("missing-hashed")).rejects.toThrow(
      /ENOENT/,
    );
    await release(f, "second", "2.0.0");
    const upgraded = await f.installer.update("second");
    await rm(path.join(old.current!.directory, "lev8/lev8"));
    await expect(f.installer.rollback()).rejects.toThrow(/ENOENT/);
    expect((await f.installer.status()).current!.directory).toBe(
      upgraded.current!.directory,
    );
  });
  it("installs a complete fixed release from a space-containing file URL and reuses it offline", async () => {
    const f = await fixture();
    await release(f, "20261014-first");
    const installer = createManagedToolsInstaller({
      ...f.options,
      baseUrl: pathToFileURL(f.source).href,
    });
    const installed = await installer.ensure("20261014-first");
    expect(installed.current!.releaseId).toBe("20261014-first");
    expect(installed.previous).toBeNull();
    for (const tool of ["teamhub", "lev8"])
      expect(
        await readFile(
          path.join(installed.current!.directory, tool, tool),
          "utf8",
        ),
      ).toContain("1.0.0");
    await rm(f.source, { recursive: true });
    expect((await installer.ensure("20261014-first")).current!.directory).toBe(
      installed.current!.directory,
    );
  });

  it.each([
    "sha256",
    "size",
    "missing",
    "file digest",
    "smoke",
    "version",
    "truncated tar",
  ])("does not activate a release with %s failure", async (fault) => {
    const f = await fixture();
    await release(f, "good");
    const old = await f.installer.ensure("good");
    const entries =
      fault === "missing"
        ? [{ name: "LICENSE", content: "fixture" }]
        : fault === "file digest"
          ? [
              { name: "lev8", content: "#!/bin/sh\necho lev8 2.0.0\n" },
              { name: "files.sha256", content: `${"0".repeat(64)}  lev8\n` },
            ]
          : fault === "smoke"
            ? hashedEntries("lev8", "#!/bin/sh\nexit 9\n")
            : fault === "version"
              ? hashedEntries("lev8", "#!/bin/sh\necho lev8 9.0.0\n")
              : undefined;
    const { manifest, manifestPath } = await release(
      f,
      "bad",
      "2.0.0",
      entries ? { lev8: entries } : {},
    );
    const artifact = manifest.tools.lev8.artifacts["linux-amd64"];
    if (fault === "sha256") artifact.sha256 = "0".repeat(64);
    if (fault === "size") {
      await writeFile(path.join(f.source, artifact.path), Buffer.alloc(4));
      artifact.sha256 = "0".repeat(64);
    }
    if (fault === "truncated tar") {
      const data = gzipSync(Buffer.alloc(512, 1));
      await writeFile(path.join(f.source, artifact.path), data);
      artifact.size = data.length;
      artifact.sha256 = digest(data);
    }
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(f.installer.update("bad")).rejects.toThrow(
      fault === "sha256" ? /SHA256/ : fault === "size" ? /size/ : /./,
    );
    expect((await f.installer.status()).current!.directory).toBe(
      old.current!.directory,
    );
  });

  it.each([
    [{ name: "../outside", content: "bad" }],
    [{ name: "/tmp/outside", content: "bad" }],
    [{ name: "escape", type: "2", link: "../../outside" }],
    [
      { name: "escape", type: "2", link: "/tmp" },
      { name: "escape/outside", content: "bad" },
    ],
    [
      { name: "alias", type: "2", link: "inside" },
      { name: "alias/file", content: "bad" },
    ],
    [{ name: "hardlink", type: "1", link: "../outside" }],
  ])(
    "rejects unsafe archive entries before activation: %j",
    async (...entries) => {
      const f = await fixture();
      await release(f, "unsafe", "1.0.0", { lev8: entries });
      await expect(f.installer.update("unsafe")).rejects.toThrow(
        /archive|path|link/i,
      );
      expect((await f.installer.status()).current).toBeNull();
      await expect(
        readFile(path.join(f.root, "outside")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("updates both tools together, rolls back, and repairs missing installed files", async () => {
    const f = await fixture();
    await release(f, "first");
    await release(f, "second", "2.0.0");
    await f.installer.ensure("first");
    const upgraded = await f.installer.update("second");
    expect(upgraded.previous!.releaseId).toBe("first");
    const rolledBack = await f.installer.rollback();
    expect(rolledBack.current!.releaseId).toBe("first");
    expect(rolledBack.previous!.releaseId).toBe("second");
    await rm(path.join(rolledBack.current!.directory, "lev8/lev8"));
    expect((await f.installer.ensure("first")).current!.directory).not.toBe(
      rolledBack.current!.directory,
    );
  });

  it("rejects unsupported manifest platforms and mismatched release identity", async () => {
    const f = await fixture();
    const { manifest, manifestPath } = await release(f, "first");
    delete manifest.tools.lev8.artifacts["linux-amd64"];
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(f.installer.update("first")).rejects.toThrow(/unsupported/i);
    manifest.release_id = "different";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(f.installer.update("first")).rejects.toThrow(/manifest/i);
    await expect(f.installer.ensure("../first")).rejects.toThrow(/release/i);
    await expect(f.installer.rollback()).rejects.toThrow(/previous/i);
  });

  it("serializes competing updates without mixing releases", async () => {
    const f = await fixture();
    await release(f, "first");
    await release(f, "second", "2.0.0");
    await Promise.all([
      f.installer.update("first"),
      createManagedToolsInstaller(f.options).update("second"),
    ]);
    const state = await f.installer.status();
    expect(
      new Set([state.current!.releaseId, state.previous!.releaseId]),
    ).toEqual(new Set(["first", "second"]));
    for (const slot of [state.current, state.previous])
      for (const tool of ["teamhub", "lev8"])
        expect(
          await readFile(path.join(slot!.directory, tool, tool), "utf8"),
        ).toContain(slot!.releaseId === "first" ? "1.0.0" : "2.0.0");
  });

  it.each(["prepared", "current", "previous"])(
    "recovers a killed switch at %s and reclaims the dead file lock",
    async (phase) => {
      const f = await fixture();
      await release(f, "first");
      await release(f, "second", "2.0.0");
      await f.installer.ensure("first");
      const moduleUrl = new URL("./managed-tools-install.mjs", import.meta.url)
        .href;
      const ready = path.join(f.root, "child-ready");
      const code = `import { writeFile } from 'node:fs/promises'; import { createManagedToolsInstaller } from ${JSON.stringify(moduleUrl)}; const installer = createManagedToolsInstaller({root: ${JSON.stringify(f.installRoot)}, baseUrl: ${JSON.stringify(f.source)}, detectPlatform: async () => 'linux-amd64', onSwitch: async phase => { if (phase === ${JSON.stringify(phase)}) { setInterval(() => {}, 1000); await writeFile(${JSON.stringify(ready)}, 'paused'); await new Promise(() => {}); } }}); await installer.update('second');`;
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", code],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let diagnostics = "";
      child.stderr.on("data", (data) => {
        diagnostics += data;
      });
      try {
        const deadline = Date.now() + 3000;
        while ((await readFile(ready, "utf8").catch(() => "")) !== "paused") {
          if (
            child.exitCode !== null ||
            child.signalCode !== null ||
            Date.now() >= deadline
          )
            throw new Error(`Child did not reach switch pause: ${diagnostics}`);
          await delay(10);
        }
        await expect(
          createManagedToolsInstaller({
            ...f.options,
            lockTimeoutMs: 50,
          }).update("first"),
        ).rejects.toThrow(/lock/);
        child.kill("SIGKILL");
        await once(child, "exit");
        const [recovered] = await Promise.all(
          Array.from({ length: 4 }, () =>
            createManagedToolsInstaller(f.options).status(),
          ),
        );
        expect(recovered.current!.releaseId).toBe("second");
        expect(recovered.previous!.releaseId).toBe("first");
        expect((await f.installer.rollback()).current!.releaseId).toBe("first");
        expect(await readdir(path.join(f.installRoot, ".locks"))).toEqual([]);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await once(child, "exit");
        }
      }
    },
  );
});

describe("managed platform detection", () => {
  it("reports musl even when ldd exits unsuccessfully", async () => {
    const probe = async (command: string, args: string[]) => {
      if (command === "ldd")
        throw Object.assign(new Error("ldd exited 1"), {
          stderr: "musl libc Version 1.2.4",
        });
      return args[0] === "-s" ? "Linux" : "x86_64";
    };
    await expect(detectManagedToolsPlatform(probe)).rejects.toThrow(/musl/);
  });
  function probe(outputs: Record<string, string>) {
    return vi.fn(async (command: string, args: string[]) => {
      const key = [command, ...args].join(" ");
      if (!(key in outputs)) throw new Error("unavailable");
      return outputs[key];
    });
  }
  it.each([
    ["x86_64", "amd64"],
    ["amd64", "amd64"],
    ["aarch64", "arm64"],
    ["arm64", "arm64"],
  ])("detects Linux %s with glibc 2.31", async (machine, architecture) => {
    expect(
      await detectManagedToolsPlatform(
        probe({
          "uname -s": "Linux",
          "uname -m": machine,
          "ldd --version": "ldd (GNU libc) 2.31",
        }),
      ),
    ).toBe(`linux-${architecture}`);
  });
  it.each([
    "ldd (GNU libc) 2.28",
    "musl libc (x86_64) Version 1.2.4",
    "unknown libc",
  ])("rejects incompatible Linux: %s", async (libc) => {
    await expect(
      detectManagedToolsPlatform(
        probe({
          "uname -s": "Linux",
          "uname -m": "x86_64",
          "ldd --version": libc,
        }),
      ),
    ).rejects.toThrow(/glibc|musl/);
  });
  it.each([
    ["x86_64", "0", "13.0", "darwin-amd64"],
    ["x86_64", "1", "14.7", "darwin-arm64"],
    ["arm64", "0", "15.0", "darwin-arm64"],
  ])(
    "detects Darwin %s translated=%s",
    async (machine, translated, version, expected) => {
      expect(
        await detectManagedToolsPlatform(
          probe({
            "uname -s": "Darwin",
            "uname -m": machine,
            "sysctl -n sysctl.proc_translated": translated,
            "sw_vers -productVersion": version,
          }),
        ),
      ).toBe(expected);
    },
  );
  it("rejects Darwin 12, unknown OS and unknown architecture", async () => {
    await expect(
      detectManagedToolsPlatform(
        probe({
          "uname -s": "Darwin",
          "uname -m": "arm64",
          "sw_vers -productVersion": "12.7",
        }),
      ),
    ).rejects.toThrow(/macOS.*13/);
    await expect(
      detectManagedToolsPlatform(
        probe({ "uname -s": "FreeBSD", "uname -m": "amd64" }),
      ),
    ).rejects.toThrow(/unsupported/i);
    await expect(
      detectManagedToolsPlatform(
        probe({ "uname -s": "Linux", "uname -m": "riscv64" }),
      ),
    ).rejects.toThrow(/unsupported/i);
  });
});
