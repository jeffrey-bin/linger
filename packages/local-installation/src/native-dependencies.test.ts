import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
  symlink,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { c as pack } from "tar";
import {
  acquireNativeArtifact,
  validateNativeSource,
  readPublishedNativeSources,
  readNativeToolVersions,
  prepareNativeDependencies,
  prepareNativeVoiceTools,
  readPublishedVoiceTools,
  validateNativeVoiceTools,
} from "./native-dependencies.js";
import * as downloads from "./download.js";
import type { InstallerEvent } from "./events.js";
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function temp() {
  const p = await mkdtemp(path.join(tmpdir(), "native-deps-"));
  roots.push(p);
  return p;
}
const source = {
  target: "darwin-arm64",
  url: "https://releases.example/native.tgz",
  sha256: "a".repeat(64),
  bytes: 100,
  postgresVersion: "17.10",
  pgvectorVersion: "0.8.6",
};
describe("trusted native dependency inputs", () => {
  it("rejects credentials, unsupported targets and unpinned versions", () => {
    for (const value of [
      { ...source, url: "https://user:secret@example.com/a" },
      { ...source, target: "win32-arm64" },
      { ...source, postgresVersion: "latest" },
      { ...source, pgvectorVersion: "0.8" },
    ])
      expect(() => validateNativeSource(value)).toThrow();
    expect(validateNativeSource(source)).toEqual(source);
  });
  it("loads publisher nativeSources without accepting another distribution target", async () => {
    const file = path.join(await temp(), "distribution.json");
    await writeFile(
      file,
      JSON.stringify({
        platform: process.platform,
        arch: process.arch,
        nativeSources: [source],
      }),
    );
    expect(await readPublishedNativeSources(file)).toEqual([source]);
    await writeFile(
      file,
      JSON.stringify({
        platform: "win32",
        arch: "arm64",
        nativeSources: [source],
      }),
    );
    await expect(readPublishedNativeSources(file)).rejects.toThrow(/target/);
  });
  it("takes a bundled archive only as a contained file beside distribution.json", async () => {
    const name = "native/postgres-win32-x64.tar.gz";
    const bundled = {
      target: "win32-x64",
      file: name,
      sha256: source.sha256,
      bytes: source.bytes,
      postgresVersion: source.postgresVersion,
      pgvectorVersion: source.pgvectorVersion,
    };
    const directory = path.resolve("installer");
    expect(validateNativeSource(bundled, directory)).toEqual({
      ...bundled,
      file: path.join(directory, name),
    });
    // The environment carries the resolved, absolute path.
    const absolute = { ...bundled, file: path.join(directory, name) };
    expect(validateNativeSource(absolute)).toEqual(absolute);
    for (const [value, base] of [
      [bundled, undefined],
      [absolute, directory],
      [{ ...bundled, file: "../postgres.tar.gz" }, directory],
      [{ ...bundled, file: "native/postgres.zip" }, directory],
      [{ ...bundled, url: source.url }, directory],
      [{ ...bundled, mirrors: [] }, directory],
      [{ ...bundled, sha256: "x" }, directory],
      [{ ...bundled, bytes: 0 }, directory],
    ] as const)
      expect(() => validateNativeSource(value, base)).toThrow(/Bundled/);
    // An http url is still refused; bundling is not a way around HTTPS.
    expect(() =>
      validateNativeSource({ ...source, url: "http://host/native.tgz" }),
    ).toThrow();
    const file = path.join(await temp(), "distribution.json");
    await writeFile(
      file,
      JSON.stringify({
        platform: process.platform,
        arch: process.arch,
        nativeSources: [bundled],
      }),
    );
    expect(await readPublishedNativeSources(file)).toEqual([
      { ...bundled, file: path.join(path.dirname(file), name) },
    ]);
  });
  it("reads exact Go toolchain and package manager from checkout", async () => {
    const repo = await temp();
    await mkdir(path.join(repo, "apps/teamhub"), { recursive: true });
    await writeFile(
      path.join(repo, "package.json"),
      JSON.stringify({
        packageManager: "pnpm@11.7.0",
        engines: { node: ">=26.5.0 <27" },
      }),
    );
    await writeFile(
      path.join(repo, "apps/teamhub/go.mod"),
      "module test\ngo 1.26.0\ntoolchain go1.26.5\n",
    );
    expect(await readNativeToolVersions(repo)).toEqual({
      go: "1.26.5",
      pnpm: "11.7.0",
    });
    await writeFile(
      path.join(repo, "package.json"),
      JSON.stringify({ packageManager: "pnpm@latest" }),
    );
    await expect(readNativeToolVersions(repo)).rejects.toThrow(/pinned/);
  });
});
describe("verified extraction", () => {
  async function fixture(link = false) {
    const root = await temp(),
      input = path.join(root, "input"),
      home = path.join(root, "home");
    await mkdir(path.join(input, "bin"), { recursive: true });
    await writeFile(path.join(input, "bin/tool"), "payload", { mode: 0o755 });
    if (link) await symlink("/etc/passwd", path.join(input, "bin/escape"));
    const archive = path.join(root, "payload.tgz");
    await pack({ cwd: input, file: archive, gzip: true }, ["bin"]);
    const bytes = await readFile(archive);
    const artifact = {
      url: "https://releases.example/tool.tgz",
      algorithm: "sha256" as const,
      digest: createHash("sha256").update(bytes).digest("hex"),
      maxBytes: bytes.length,
    };
    const fetcher = (async () =>
      new Response(bytes, {
        headers: { "content-length": String(bytes.length) },
      })) as typeof fetch;
    return { home, bytes, artifact, fetcher };
  }
  it("verifies bytes and caches immutable component identities with real progress", async () => {
    const f = await fixture(),
      progress: number[] = [];
    const directory = await acquireNativeArtifact(
      f.home,
      f.artifact,
      new AbortController().signal,
      (n) => progress.push(n),
      f.fetcher,
    );
    expect(await readFile(path.join(directory, "bin/tool"), "utf8")).toBe(
      "payload",
    );
    expect(progress.at(-1)).toBe(f.bytes.length);
    await writeFile(path.join(directory, "bin/tool"), "changed");
    await expect(
      acquireNativeArtifact(
        f.home,
        f.artifact,
        new AbortController().signal,
        undefined,
        f.fetcher,
      ),
    ).rejects.toThrow(/cache/);
  });
  it("checksum failure leaves no promoted component and permits clean retry", async () => {
    const f = await fixture();
    await expect(
      acquireNativeArtifact(
        f.home,
        { ...f.artifact, digest: "0".repeat(64) },
        new AbortController().signal,
        undefined,
        f.fetcher,
      ),
    ).rejects.toThrow(/checksum/);
    const directory = await acquireNativeArtifact(
      f.home,
      f.artifact,
      new AbortController().signal,
      undefined,
      f.fetcher,
    );
    expect(await readFile(path.join(directory, "bin/tool"), "utf8")).toBe(
      "payload",
    );
  });
  it("verifies and extracts a bundled archive without the network", async () => {
    const f = await fixture(),
      file = path.join(path.dirname(f.home), "payload.tgz"),
      progress: number[] = [];
    const fetcher = vi.fn<typeof fetch>();
    const bundled = { ...f.artifact, url: undefined, file };
    await expect(
      acquireNativeArtifact(
        f.home,
        { ...bundled, digest: "0".repeat(64) },
        new AbortController().signal,
        undefined,
        fetcher,
      ),
    ).rejects.toThrow(/checksum/);
    await expect(
      acquireNativeArtifact(
        f.home,
        { ...bundled, maxBytes: f.bytes.length - 1 },
        new AbortController().signal,
        undefined,
        fetcher,
      ),
    ).rejects.toThrow(/larger/);
    await expect(
      acquireNativeArtifact(
        f.home,
        { ...bundled, file: `${file}.missing` },
        new AbortController().signal,
        undefined,
        fetcher,
      ),
    ).rejects.toThrow(/missing/);
    await expect(
      acquireNativeArtifact(
        f.home,
        { ...bundled, file: "payload.tgz" },
        new AbortController().signal,
        undefined,
        fetcher,
      ),
    ).rejects.toThrow(/local file/);
    const directory = await acquireNativeArtifact(
      f.home,
      bundled,
      new AbortController().signal,
      (n) => progress.push(n),
      fetcher,
    );
    expect(await readFile(path.join(directory, "bin/tool"), "utf8")).toBe(
      "payload",
    );
    expect(progress.at(-1)).toBe(f.bytes.length);
    expect(fetcher).not.toHaveBeenCalled();
    // The app's copy stays in place for the next install.
    expect(await readFile(file)).toEqual(f.bytes);
  });
  it("rejects symbolic links before promotion", async () => {
    const f = await fixture(true);
    await expect(
      acquireNativeArtifact(
        f.home,
        f.artifact,
        new AbortController().signal,
        undefined,
        f.fetcher,
      ),
    ).rejects.toThrow(/archive/);
  });
});

describe("verified zip extraction", () => {
  // Python's zipfile writes ordinary deflated release zips, like go.dev does.
  async function zip(entries: Record<string, string>, stored = false) {
    const root = await temp(),
      archive = path.join(root, "payload.zip");
    execFileSync("python3", [
      "-c",
      "import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_STORED if sys.argv[3]=='1' else zipfile.ZIP_DEFLATED) as z:\n  [z.writestr(k,v) for k,v in json.loads(sys.argv[2]).items()]",
      archive,
      JSON.stringify(entries),
      stored ? "1" : "0",
    ]);
    const bytes = await readFile(archive);
    return {
      home: path.join(root, "home"),
      artifact: {
        url: "https://releases.example/tool.zip",
        algorithm: "sha256" as const,
        digest: createHash("sha256").update(bytes).digest("hex"),
        maxBytes: bytes.length,
        format: "zip" as const,
      },
      fetcher: (async () => new Response(bytes)) as typeof fetch,
    };
  }
  it.each([false, true])(
    "extracts and caches a release zip (stored=%s)",
    async (stored) => {
      const f = await zip(
        { "go/": "", "go/bin/go.exe": "binary".repeat(100) },
        stored,
      );
      const directory = await acquireNativeArtifact(
        f.home,
        f.artifact,
        new AbortController().signal,
        undefined,
        f.fetcher,
      );
      expect(
        await readFile(path.join(directory, "go/bin/go.exe"), "utf8"),
      ).toBe("binary".repeat(100));
      expect(
        await acquireNativeArtifact(
          f.home,
          f.artifact,
          new AbortController().signal,
          undefined,
          f.fetcher,
        ),
      ).toBe(directory);
    },
  );
  it.each(["../escape", "go\\..\\escape", "C:/escape"])(
    "rejects the unsafe zip entry %s",
    async (name) => {
      const f = await zip({ [name]: "unsafe" });
      await expect(
        acquireNativeArtifact(
          f.home,
          f.artifact,
          new AbortController().signal,
          undefined,
          f.fetcher,
        ),
      ).rejects.toThrow(/archive/);
      expect(await readdir(f.home)).not.toContain("escape");
    },
  );
});

describe("failure and cancellation boundaries", () => {
  it("rejects traversal without writing outside staging", async () => {
    const root = await temp(),
      input = path.join(root, "input");
    await mkdir(input);
    await writeFile(path.join(input, "escape"), "unsafe");
    const archive = path.join(root, "traversal.tar");
    await pack({ cwd: input, file: archive, prefix: "../outside" }, ["escape"]);
    const bytes = await readFile(archive);
    await expect(
      acquireNativeArtifact(
        path.join(root, "cache"),
        {
          url: "https://releases.example/a.tgz",
          algorithm: "sha256",
          digest: createHash("sha256").update(bytes).digest("hex"),
          maxBytes: bytes.length,
        },
        new AbortController().signal,
        undefined,
        async () => new Response(bytes),
      ),
    ).rejects.toThrow(/archive/);
    await expect(
      readFile(path.join(root, "cache/outside/escape")),
    ).rejects.toThrow();
  });
  it("rejects linked component roots before fetching", async () => {
    const root = await temp(),
      outside = await temp(),
      base = path.join(root, "cache");
    await symlink(outside, base);
    await expect(
      acquireNativeArtifact(
        base,
        {
          url: source.url,
          algorithm: "sha256",
          digest: source.sha256,
          maxBytes: 100,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/owned directory/);
  });
  it("aborted downloads leave no pending component", async () => {
    const root = await temp(),
      controller = new AbortController();
    controller.abort();
    await expect(
      acquireNativeArtifact(
        root,
        {
          url: source.url,
          algorithm: "sha256",
          digest: source.sha256,
          maxBytes: 100,
        },
        controller.signal,
      ),
    ).rejects.toThrow();
    const entries = await import("node:fs/promises").then((fs) =>
      fs.readdir(root),
    );
    expect(entries).toEqual([]);
  });
});

it("validates checksum identity before resolving cache paths", async () => {
  const root = await temp();
  await expect(
    acquireNativeArtifact(
      path.join(root, "cache"),
      { url: source.url, algorithm: "sha256", digest: "..", maxBytes: 100 },
      new AbortController().signal,
    ),
  ).rejects.toThrow(/trusted checksum/);
  await expect(
    readFile(path.join(root, "cache/operation.sqlite")),
  ).rejects.toThrow();
});

it("prepares real executable launchers and reuses verified warm dependencies entirely offline", async () => {
  const root = await temp(),
    repo = path.join(root, "repo"),
    home = path.join(root, "home");
  await mkdir(path.join(repo, "apps/teamhub"), { recursive: true });
  await writeFile(
    path.join(repo, "package.json"),
    JSON.stringify({
      packageManager: "pnpm@11.7.0",
      engines: { node: ">=26.5.0 <27" },
    }),
  );
  await writeFile(
    path.join(repo, "apps/teamhub/go.mod"),
    "module test\ngo 1.26.0\ntoolchain go1.26.5\n",
  );
  // Native modules install prebuilt, so no C toolchain may be required.
  vi.stubEnv("PATH", path.dirname(process.execPath));
  vi.stubEnv(
    "LINGER_NATIVE_DEPENDENCIES_JSON",
    JSON.stringify([
      {
        ...source,
        mirrors: ["https://mirror.example/postgres.tgz"],
        target: `${process.platform}-${process.arch}`,
      },
    ]),
  );
  vi.stubEnv("GOPROXY", "");
  const archives: Record<string, string> = {};
  async function archive(name: string, files: Record<string, string>) {
    const input = path.join(root, name);
    await mkdir(input);
    for (const [relative, body] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(input, relative)), {
        recursive: true,
      });
      await writeFile(path.join(input, relative), body, { mode: 0o755 });
    }
    const file = path.join(root, `${name}.tgz`);
    await pack({ cwd: input, file, gzip: true }, Object.keys(files));
    archives[name] = file;
  }
  const platform = `${process.platform}/${process.arch === "x64" ? "amd64" : process.arch}`;
  await archive("go", {
    "go/bin/go": `#!/bin/sh\nprintf 'go version go1.26.5 ${platform}\\n'\n`,
    "go/bin/gofmt": "#!/bin/sh\nexit 0\n",
  });
  await archive("pnpm", { "package/bin/pnpm.cjs": "console.log('11.7.0')" });
  await archive("npm", {
    "package/bin/npm-cli.js": "console.log('11.7.0')",
    "package/bin/npx-cli.js": "console.log('11.7.0')",
  });
  await archive(
    "postgres",
    Object.fromEntries(
      ["postgres", "initdb", "pg_ctl", "psql", "createdb"].map((name) => [
        `bin/${name}`,
        "#!/bin/sh\nprintf 'postgres (PostgreSQL) 17.10\\n'\n",
      ]),
    ),
  );
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Unexpected metadata request"));
  const download = vi
    .spyOn(downloads, "downloadVerified")
    .mockImplementation(async (options) => {
      const name = options.url.includes("/go/")
        ? "go"
        : options.url.includes("/pnpm/")
          ? "pnpm"
          : options.url.includes("/npm/")
            ? "npm"
            : "postgres";
      await writeFile(options.output, await readFile(archives[name]!));
    });
  const events: InstallerEvent[] = [];
  const result = await prepareNativeDependencies({
    repo,
    home,
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
  });
  expect(result.env.GOROOT).toContain("/components/");
  expect(result.env.GOTOOLCHAIN).toBe("local");
  expect(result.env.GOPROXY).toBe(
    "https://proxy.golang.org|https://goproxy.cn|direct",
  );
  // Toolchain work belongs to the release stage, not to starting services.
  expect(new Set(events.map((event) => event.stage))).toEqual(
    new Set(["release"]),
  );
  // Each component logs how long it took.
  expect(
    events
      .filter((event) => event.kind === "log")
      .map((event) => event.message.replace(/[\d.]+s\.\n$/, "Ns.")),
  ).toContain("Prepared private Go 1.26.5 in Ns.");
  expect(result.env.CGO_ENABLED).toBe("0");
  expect(result.env.PATH?.split(path.delimiter)[0]).toBe(
    path.join(result.toolchainRoot, "bin"),
  );
  expect(download).toHaveBeenCalledTimes(4);
  // Only the registry probe touches the network; it fails here, so the
  // public registry stays first.
  expect(
    fetcher.mock.calls.every(([url]) =>
      (url as URL | string).toString().includes("/pnpm-11.7.0.tgz"),
    ),
  ).toBe(true);
  expect(result.registries[0]).toBe("https://registry.npmjs.org/");
  expect(download.mock.calls[1]![0].mirrors).toEqual([
    "https://cdn.npmmirror.com/packages/pnpm/11.7.0/pnpm-11.7.0.tgz",
  ]);
  expect(download.mock.calls[3]![0].mirrors).toEqual([
    "https://mirror.example/postgres.tgz",
  ]);
  download.mockImplementation(async () => {
    throw new Error("offline download attempted");
  });
  fetcher.mockImplementation(async () => {
    throw new Error("offline metadata request attempted");
  });
  expect(
    await prepareNativeDependencies({
      repo,
      home,
      signal: new AbortController().signal,
    }),
  ).toEqual(result);
  // A checkout with its TeamHub binaries compiles no Go, so Go never downloads.
  download.mockClear();
  download.mockImplementation(async (options) => {
    if (options.url.includes("/go/")) throw new Error("Go download attempted");
    const name = options.url.includes("/pnpm/")
      ? "pnpm"
      : options.url.includes("/npm/")
        ? "npm"
        : "postgres";
    await writeFile(options.output, await readFile(archives[name]!));
  });
  const withoutGo = await prepareNativeDependencies({
    repo,
    home: path.join(root, "home-without-go"),
    signal: new AbortController().signal,
    go: false,
  });
  expect(download).toHaveBeenCalledTimes(3);
  expect(withoutGo.env.GOROOT).toBeUndefined();
  expect(withoutGo.env.GOBIN).toBeUndefined();
  expect(existsSync(path.join(withoutGo.toolchainRoot, "bin/go"))).toBe(false);
  expect(existsSync(path.join(withoutGo.toolchainRoot, "bin/pnpm"))).toBe(true);
  // A checkout with its built services installs no packages: only
  // PostgreSQL arrives, and no registry is probed.
  download.mockClear();
  fetcher.mockClear();
  download.mockImplementation(async (options) => {
    if (options.url !== source.url)
      throw new Error(`${options.url} downloaded`);
    await writeFile(options.output, await readFile(archives.postgres!));
  });
  const offline = await prepareNativeDependencies({
    repo,
    home: path.join(root, "home-offline"),
    signal: new AbortController().signal,
    go: false,
    packages: false,
  });
  expect(download).toHaveBeenCalledTimes(1);
  expect(fetcher).not.toHaveBeenCalled();
  expect(offline.registries).toEqual([]);
  expect(offline.env.PNPM_HOME).not.toBe(
    path.join(offline.toolchainRoot, "bin"),
  );
  expect(existsSync(path.join(offline.toolchainRoot, "bin/pnpm"))).toBe(false);
  expect(existsSync(path.join(offline.toolchainRoot, "bin/npm"))).toBe(false);
}, 15000);
describe("native voice tools", () => {
  const voice = {
    target: "linux-x64",
    file: "native/voice-tools-linux-x64.tar.gz",
    sha256: "b".repeat(64),
    bytes: 100,
    livekitVersion: "1.13.6",
    ffmpegVersion: "8.1.2",
  };
  it("takes pinned LiveKit and ffmpeg versions beside distribution.json", async () => {
    const directory = path.resolve("installer");
    expect(validateNativeVoiceTools(voice, directory)).toEqual({
      ...voice,
      file: path.join(directory, voice.file),
    });
    for (const value of [
      { ...voice, livekitVersion: "latest" },
      { ...voice, ffmpegVersion: "8" },
      { ...voice, target: "linux-arm64" },
    ])
      expect(() => validateNativeVoiceTools(value, directory)).toThrow(
        /versions/,
      );
    expect(() =>
      validateNativeVoiceTools(
        { ...voice, file: "../voice.tar.gz" },
        directory,
      ),
    ).toThrow(/Bundled native voice tools/);
    const file = path.join(await temp(), "distribution.json");
    await writeFile(file, JSON.stringify({ voiceTools: [voice] }));
    expect(await readPublishedVoiceTools(file)).toEqual([
      { ...voice, file: path.join(path.dirname(file), voice.file) },
    ]);
    // A distribution without voice tools keeps Native voice off.
    await writeFile(file, JSON.stringify({ nativeSources: [] }));
    expect(await readPublishedVoiceTools(file)).toBeUndefined();
  });
  it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
    "verifies the bundled tools and checks each one runs its pinned version",
    async () => {
      const root = await temp();
      const input = path.join(root, "input");
      await mkdir(path.join(input, "bin"), { recursive: true });
      const program = (line: string) => `#!/bin/sh\necho '${line}'\n`;
      await writeFile(
        path.join(input, "bin/livekit-server"),
        program("livekit-server version 1.13.6"),
        { mode: 0o755 },
      );
      for (const name of ["ffmpeg", "ffprobe"])
        await writeFile(
          path.join(input, "bin", name),
          program(`${name} version 8.1.2 Copyright (c) 2000-2026`),
          { mode: 0o755 },
        );
      const archive = path.join(root, "voice.tar.gz");
      await pack({ cwd: input, file: archive, gzip: true }, ["bin"]);
      const bytes = await readFile(archive);
      const pinned = {
        ...voice,
        file: archive,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
      };
      const home = path.join(root, "home");
      const signal = new AbortController().signal;
      // No distribution entry for this computer: voice stays off.
      vi.stubEnv("LINGER_NATIVE_VOICE_TOOLS_JSON", "");
      expect(await prepareNativeVoiceTools({ home, signal })).toBeUndefined();
      vi.stubEnv(
        "LINGER_NATIVE_VOICE_TOOLS_JSON",
        JSON.stringify([{ ...pinned, target: "win32-x64" }]),
      );
      expect(await prepareNativeVoiceTools({ home, signal })).toBeUndefined();
      vi.stubEnv("LINGER_NATIVE_VOICE_TOOLS_JSON", JSON.stringify([pinned]));
      const tools = await prepareNativeVoiceTools({ home, signal });
      expect(tools?.livekit).toBe(path.join(tools!.bin, "livekit-server"));
      expect(existsSync(path.join(tools!.bin, "ffmpeg"))).toBe(true);
      // A tool that runs another version is refused.
      vi.stubEnv(
        "LINGER_NATIVE_VOICE_TOOLS_JSON",
        JSON.stringify([{ ...pinned, livekitVersion: "1.13.7" }]),
      );
      await expect(prepareNativeVoiceTools({ home, signal })).rejects.toThrow(
        /required version/,
      );
    },
  );
});
