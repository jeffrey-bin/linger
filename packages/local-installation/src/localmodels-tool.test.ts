import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  readFile,
  readdir,
  stat,
  utimes,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { withInstanceLock, type Instance } from "./instance.js";
import { afterEach, expect, test, vi } from "vitest";
import {
  ensureLocalmodelsTool,
  runLocalmodels,
  validateToolSource,
} from "./localmodels-tool.js";
const roots: string[] = [];
async function reopenDirectories(directory: string): Promise<void> {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true }))
    if (entry.isDirectory())
      await reopenDirectories(path.join(directory, entry.name));
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map(async (p) => {
      // Verified kits are sealed read-only; reopen them before cleanup.
      if (process.platform !== "win32") await reopenDirectories(p);
      await rm(p, { recursive: true, force: true });
    }),
  );
});
const hash = (b: string | Buffer) =>
  createHash("sha256").update(b).digest("hex");
async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "linger-model-tool-"));
  roots.push(home);
  const manifest = {
    schemaVersion: 1,
    platform: process.platform,
    arch: process.arch,
    sourceCommit: "a".repeat(40),
    python: "python/python",
    moduleDir: "modules",
    assets: {
      "python/python": hash("python"),
      "modules/localmodels/__init__.py": hash("package"),
    },
  };
  const body = JSON.stringify(manifest);
  const source = {
    url: "https://example.com/tool.tgz",
    sha256: "b".repeat(64),
    bytes: 100,
    manifestSha256: hash(body),
    sourceCommit: "a".repeat(40),
  };
  const directory = path.join(home, "tools", "localmodels", source.sha256);
  await mkdir(path.join(directory, "python"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(directory, "modules/localmodels"), { recursive: true });
  await writeFile(path.join(directory, "tool.json"), body, { mode: 0o600 });
  await writeFile(path.join(directory, "python/python"), "python", {
    mode: 0o700,
  });
  await writeFile(
    path.join(directory, "modules/localmodels/__init__.py"),
    "package",
  );
  return { home, source, directory };
}
test("requires a fixed authenticated-free tool source and source identity", () => {
  expect(() =>
    validateToolSource({
      url: "https://example.com/tool",
      sha256: "a".repeat(64),
      bytes: 1,
    }),
  ).toThrow();
  expect(() =>
    validateToolSource({
      url: "https://user:pass@example.com/tool",
      sha256: "a".repeat(64),
      bytes: 1,
      sourceCommit: "b".repeat(40),
      manifestSha256: "c".repeat(64),
    }),
  ).toThrow();
});
test("reuses only a complete checksum-verified private upstream kit", async () => {
  const f = await fixture();
  const tool = await ensureLocalmodelsTool(f.home, {}, { source: f.source });
  expect(tool.python).toBe(path.join(f.directory, "python/python"));
  await chmod(path.join(f.directory, "modules/localmodels"), 0o700);
  await chmod(path.join(f.directory, "modules/localmodels/__init__.py"), 0o600);
  await writeFile(
    path.join(f.directory, "modules/localmodels/__init__.py"),
    "corrupt",
  );
  // The altered kit is replaced from its pinned source, never trusted as is.
  await expect(
    ensureLocalmodelsTool(
      f.home,
      {},
      {
        source: f.source,
        fetcher: async () => new Response("not the kit", { status: 200 }),
      },
    ),
  ).rejects.toThrow(/checksum|size|SHA/i);
});
test("hashes a verified kit again only where an asset's size or time changed", async () => {
  const f = await fixture();
  const file = path.join(f.directory, "modules/localmodels/__init__.py");
  // Whole seconds, which utimes sets exactly.
  const time = 1_800_000_000;
  await utimes(file, time, time);
  await ensureLocalmodelsTool(f.home, {}, { source: f.source });
  const stamps = JSON.parse(
    await readFile(`${f.directory}.verified.json`, "utf8"),
  ) as { manifestSha256: string; stamps: Record<string, unknown> };
  expect(stamps.manifestSha256).toBe(f.source.manifestSha256);
  expect(Object.keys(stamps.stamps).sort()).toEqual([
    "modules/localmodels/__init__.py",
    "python/python",
  ]);
  await chmod(path.dirname(file), 0o700);
  await chmod(file, 0o600);
  // Same size and time: the recorded stamp stands for the checksum.
  await writeFile(file, "PACKAGE");
  await utimes(file, time, time);
  await expect(
    ensureLocalmodelsTool(f.home, {}, { source: f.source }),
  ).resolves.toMatchObject({ moduleDir: path.join(f.directory, "modules") });
  // A new time makes it hash the asset, which no longer matches.
  await utimes(file, time, time + 5);
  await expect(
    ensureLocalmodelsTool(
      f.home,
      {},
      {
        source: f.source,
        fetcher: async () => new Response("not the kit", { status: 200 }),
      },
    ),
  ).rejects.toThrow(/checksum|size|SHA/i);
});
test.skipIf(process.platform === "win32")(
  "seals a verified kit read-only so upstream bytecode writes cannot alter it",
  async () => {
    const f = await fixture();
    await ensureLocalmodelsTool(f.home, {}, { source: f.source });
    const mode = async (file: string) =>
      (await stat(path.join(f.directory, file))).mode & 0o777;
    expect(await mode(".")).toBe(0o500);
    expect(await mode("modules/localmodels")).toBe(0o500);
    expect(await mode("python/python")).toBe(0o500);
    expect(await mode("modules/localmodels/__init__.py")).toBe(0o400);
  },
);
test.skipIf(process.platform === "win32")(
  "repairs a kit altered after verification by fetching the same pinned archive",
  async () => {
    const f = await fixture();
    const archive = path.join(f.home, "kit.tgz");
    execFileSync("tar", ["-czf", archive, "-C", f.directory, "."], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    const bytes = await readFile(archive);
    const source = { ...f.source, sha256: hash(bytes), bytes: bytes.length };
    const directory = path.join(f.home, "tools/localmodels", source.sha256);
    const first = vi.fn(async () => new Response(bytes));
    await ensureLocalmodelsTool(f.home, {}, { source, fetcher: first });
    expect(first).toHaveBeenCalledTimes(1);
    // Simulate a Python child recompiling bytecode inside the kit.
    await chmod(path.join(directory, "modules/localmodels"), 0o700);
    await mkdir(path.join(directory, "modules/localmodels/__pycache__"));
    await chmod(path.join(directory, "modules/localmodels/__init__.py"), 0o600);
    await writeFile(
      path.join(directory, "modules/localmodels/__init__.py"),
      "recompiled",
    );
    const events: string[] = [];
    const repair = vi.fn(async () => new Response(bytes));
    const tool = await ensureLocalmodelsTool(
      f.home,
      { onEvent: (event) => events.push(event.message) },
      { source, fetcher: repair },
    );
    expect(repair).toHaveBeenCalledTimes(1);
    expect(events).toContain(
      "Repairing the model and Harness installation tool…",
    );
    expect(tool.moduleDir).toBe(path.join(directory, "modules"));
    expect(
      await readFile(
        path.join(directory, "modules/localmodels/__init__.py"),
        "utf8",
      ),
    ).toBe("package");
    expect(await readdir(path.join(directory, "modules/localmodels"))).toEqual([
      "__init__.py",
    ]);
    expect((await stat(directory)).mode & 0o777).toBe(0o500);
    expect(
      (await readdir(path.join(f.home, "tools/localmodels"))).filter((name) =>
        /^(?:invalid|pending)-|\.tgz$/.test(name),
      ),
    ).toEqual([]);
  },
);
test.skipIf(process.platform === "win32")(
  "downloads the kit from the publisher's mirror when the primary host fails",
  async () => {
    const f = await fixture();
    const archive = path.join(f.home, "kit.tgz");
    execFileSync("tar", ["-czf", archive, "-C", f.directory, "."], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    await rm(f.directory, { recursive: true, force: true });
    const bytes = await readFile(archive);
    const source = {
      ...f.source,
      mirrors: ["https://mirror.example/tool.tgz"],
      sha256: hash(bytes),
      bytes: bytes.length,
    };
    const hosts: string[] = [];
    const tool = await ensureLocalmodelsTool(
      f.home,
      {},
      {
        source,
        fetcher: async (url) => {
          hosts.push(new URL(url as URL).host);
          return new URL(url as URL).host === "example.com"
            ? new Response("missing", { status: 404 })
            : new Response(bytes);
        },
      },
    );
    expect(hosts).toEqual(["example.com", "mirror.example"]);
    expect(tool.moduleDir).toBe(
      path.join(f.home, "tools/localmodels", source.sha256, "modules"),
    );
  },
);
test("does not silently fall back to a user Python or local implementation", async () => {
  const f = await fixture();
  vi.stubEnv("LINGER_LOCALMODELS_TOOL_JSON", "");
  await expect(ensureLocalmodelsTool(f.home)).rejects.toThrow(
    /distribution|metadata/i,
  );
});
test("invokes the verified upstream module with isolated module and state paths", async () => {
  const f = await fixture();
  vi.stubEnv("LINGER_LOCALMODELS_TOOL_JSON", JSON.stringify(f.source));
  const run = vi.fn(async () => ({ code: 0, stdout: "{}", stderr: "" }));
  await runLocalmodels(
    f.home,
    ["setup", "inspect", "--json"],
    {
      input: "private",
      env: { PYTHONPATH: "/untrusted", LOCALMODELS_STATE: "/untrusted" },
    },
    { run },
  );
  expect(run).toHaveBeenCalledWith(
    path.join(f.directory, "python/python"),
    ["-P", "-s", "-m", "localmodels", "setup", "inspect", "--json"],
    expect.objectContaining({
      input: "private",
      env: expect.objectContaining({
        PYTHONPATH: path.join(f.directory, "modules"),
        LOCALMODELS_STATE: path.join(f.home, "runtime/localmodels/state"),
      }),
    }),
  );
  expect(await readFile(path.join(f.directory, "tool.json"), "utf8")).toContain(
    "sourceCommit",
  );
});
test("reads a publisher-pinned upstream kit only for this host target", async () => {
  const f = await fixture();
  const file = path.join(f.home, "distribution.json");
  await writeFile(
    file,
    JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      localmodelsTool: f.source,
    }),
  );
  const { readPublishedTool } = await import("./localmodels-tool.js");
  expect(await readPublishedTool(file)).toEqual(f.source);
  await writeFile(
    file,
    JSON.stringify({
      platform: "unsupported",
      arch: process.arch,
      localmodelsTool: f.source,
    }),
  );
  await expect(readPublishedTool(file)).rejects.toThrow(/target/i);
});
test("deduplicates concurrent first-page tool preparation instead of rejecting one request as busy", async () => {
  const f = await fixture();
  const result = await Promise.all([
    ensureLocalmodelsTool(f.home, {}, { source: f.source }),
    ensureLocalmodelsTool(f.home, {}, { source: f.source }),
  ]);
  expect(result[0]).toEqual(result[1]);
});
test("verified tool reads do not contend with another process holding the publication lock", async () => {
  const f = await fixture();
  const lock = path.join(f.home, "tools", "localmodels", "lock");
  await mkdir(lock, { mode: 0o700 });
  await withInstanceLock({ root: lock } as Instance, async () => {
    const tool = await ensureLocalmodelsTool(f.home, {}, { source: f.source });
    expect(tool.python).toBe(path.join(f.directory, "python/python"));
  });
});
test("forwards real Harness byte progress without forwarding native logs or secret fields", async () => {
  const f = await fixture();
  vi.stubEnv("LINGER_LOCALMODELS_TOOL_JSON", JSON.stringify(f.source));
  const onEvent = vi.fn();
  const run = vi.fn<typeof import("./process.js").runProcess>(
    async (_file, _args, options) => {
      options?.onOutput?.(
        'private token=hidden\n{"kind":"progress","stage":"download","completed":4,',
      );
      options?.onOutput?.('"total":10,"unit":"bytes","apiKey":"hidden"}\n');
      return { code: 0, stdout: "{}", stderr: "" };
    },
  );
  await runLocalmodels(
    f.home,
    ["harness", "apply", "plan", "--jsonl"],
    { onEvent },
    { run },
  );
  expect(onEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      progress: { completed: 4, total: 10, unit: "bytes" },
    }),
  );
  expect(JSON.stringify(onEvent.mock.calls)).not.toContain("hidden");
});

test("forwards safe extraction and verification stages after Harness downloads finish", async () => {
  const f = await fixture();
  vi.stubEnv("LINGER_LOCALMODELS_TOOL_JSON", JSON.stringify(f.source));
  const onEvent = vi.fn();
  const run = vi.fn<typeof import("./process.js").runProcess>(
    async (_file, _args, options) => {
      for (const stage of [
        "extract",
        "verify",
        "install",
        "private-secret-stage",
      ])
        options?.onOutput?.(
          JSON.stringify({
            kind: "stage",
            stage,
            state: stage === "install" ? "succeeded" : "running",
            message: "private-secret-message",
          }) + "\n",
        );
      return { code: 0, stdout: "{}", stderr: "" };
    },
  );
  await runLocalmodels(
    f.home,
    ["harness", "apply", "plan", "--jsonl"],
    { onEvent },
    { run },
  );
  expect(onEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      message: "Extracting Harness files and applying private permissions…",
    }),
  );
  expect(onEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      message: "Verifying the installed Harness executable…",
    }),
  );
  expect(onEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      message: "Harness files installed; checking runtime status…",
    }),
  );
  // The three stages, then how long the tool check and the run took.
  expect(onEvent).toHaveBeenCalledTimes(4);
  expect(onEvent).toHaveBeenLastCalledWith({
    kind: "log",
    message: expect.stringMatching(
      /^localmodels harness apply: tool checked in [\d.]+s, ran in [\d.]+s\.\n$/,
    ),
  });
  expect(JSON.stringify(onEvent.mock.calls)).not.toContain("private-secret");
});
