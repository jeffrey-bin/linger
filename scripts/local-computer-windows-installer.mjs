// Runs only with a checksum-verified product Node. PowerShell embeds this file.
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import http from "node:http";
import https from "node:https";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";

export const WINDOWS_BUNDLE_ENTRIES = [
  "cli/linger-computer.exe",
  "daemon/linger-computer-daemon.exe",
  "runtime/bin/node.exe",
  "runtime/LICENSE",
];
// Managed tool runtime modules ship beside the CLI. Releases before they
// existed verify without them, so presence decides the checksum entry list.
export const MANAGED_TOOLS_BUNDLE_ENTRIES = [
  "cli/managed-tools-runtime.mjs",
  "cli/managed-tools-install.mjs",
  "cli/managed-tools-launchers.mjs",
  "cli/managed-tools-archive.mjs",
  "cli/managed-tools-lock.mjs",
  "cli/local-computer-node-distributions.mjs",
];
const TEAMHUB_BUNDLE_ENTRIES = [
  "cli/teamhub",
  "cli/teamhub.exe",
  "cli/teamhub-assets.json",
];
// Bundles before Computer 0.30.11 lack the command manifest; keep their
// checksum format so they can be verified before upgrade or removal.
const TEAMHUB_COMMANDS_ENTRY = "cli/teamhub-commands.json";
const teamhubAssetPath =
  /^(?:teamhub\.js|teamhub-chunks\/[A-Za-z0-9_-]+\.js)$/u;
const safeToolPath = (name) =>
  typeof name === "string" &&
  !name.includes(":") &&
  !name.includes("\\") &&
  !Array.from(name).some((character) => character.charCodeAt(0) < 0x20) &&
  name.split("/").every((part) => part && part !== "." && part !== "..");
const computerToolEntry = (name) =>
  name.startsWith("cli/computer-tools/") && safeToolPath(name);
export const permittedBundleEntry = (name) =>
  WINDOWS_BUNDLE_ENTRIES.includes(name) ||
  MANAGED_TOOLS_BUNDLE_ENTRIES.includes(name) ||
  TEAMHUB_BUNDLE_ENTRIES.includes(name) ||
  name === "cli/teamhub.cmd" ||
  name === TEAMHUB_COMMANDS_ENTRY ||
  computerToolEntry(name) ||
  (name.startsWith("cli/") && teamhubAssetPath.test(name.slice(4)));
const METADATA = [
  "active-bundle",
  "installed-checksum",
  "installed-bundle-checksum",
  "installed-runtime-checksum",
  "web-origin",
];
const JOURNAL = ".install-transaction.json";
const UNINSTALL_JOURNAL = ".uninstall-transaction.json";
const digestPattern = /^[0-9a-f]{64}$/u;
const bundlePattern = /^lib-[0-9a-f]{16}-[0-9a-f-]+$/u;
const missing = (error) => error?.code === "ENOENT";
const exists = (file) =>
  lstat(file).then(
    () => true,
    (error) => {
      if (missing(error)) return false;
      throw error;
    },
  );

export async function fileChecksum(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

export async function verifyWindowsExecutable(file, target) {
  const bytes = await readFile(file);
  const peOffset = bytes.length >= 64 ? bytes.readUInt32LE(60) : -1;
  const machine =
    target === "win32-arm64" ? 0xaa64 : target === "win32-x64" ? 0x8664 : -1;
  if (
    bytes.toString("ascii", 0, 2) !== "MZ" ||
    peOffset < 64 ||
    peOffset + 6 > bytes.length ||
    bytes.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0" ||
    bytes.readUInt16LE(peOffset + 4) !== machine
  ) {
    throw new Error(
      "Release executable architecture does not match this Windows system.",
    );
  }
}

export async function bundleChecksum(bundle, platform) {
  await platform.check(bundle, "directory");
  const digest = createHash("sha256");
  for (const entry of await windowsBundleEntries(bundle, platform)) {
    digest.update(entry).update("\0");
    digest.update(await readFile(path.join(bundle, entry)));
  }
  return digest.digest("hex");
}

// Each native platform request starts a process; checking a bundle file by
// file cost about 0.2 seconds per file on Windows.
async function checkPrivateFiles(platform, files) {
  if (platform.checkFiles) await platform.checkFiles(files);
  else for (const file of files) await platform.check(file, "file");
}

// A bundle this installer has just extracted into its private temporary
// directory is "fresh": every file was created exclusively there, so only an
// existing bundle needs its private-path checks.
async function windowsBundleEntries(bundle, platform, fresh = false) {
  const check = async (entries) => {
    if (!fresh)
      await checkPrivateFiles(
        platform,
        entries.map((entry) => path.join(bundle, entry)),
      );
  };
  const tools = await computerToolEntries(bundle, platform, fresh);
  const manifestFile = path.join(bundle, "cli/teamhub-assets.json");
  const managed = [];
  for (const entry of MANAGED_TOOLS_BUNDLE_ENTRIES) {
    if (await present(path.join(bundle, entry))) managed.push(entry);
  }
  const native = await present(path.join(bundle, "cli/teamhub.exe"));
  const commands = (await present(path.join(bundle, TEAMHUB_COMMANDS_ENTRY)))
    ? [TEAMHUB_COMMANDS_ENTRY]
    : [];
  const fixed = [
    ...WINDOWS_BUNDLE_ENTRIES,
    ...managed,
    ...(native
      ? TEAMHUB_BUNDLE_ENTRIES
      : TEAMHUB_BUNDLE_ENTRIES.map((entry) =>
          entry === "cli/teamhub.exe" ? "cli/teamhub.cmd" : entry,
        )),
    ...commands,
  ];
  await check(fixed);
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  if (
    manifest?.schema_version !== 1 ||
    manifest.entrypoint !== "teamhub.js" ||
    !Array.isArray(manifest.assets) ||
    !manifest.assets.every(
      (asset) =>
        asset &&
        typeof asset.path === "string" &&
        teamhubAssetPath.test(asset.path) &&
        Number.isSafeInteger(asset.size_bytes) &&
        asset.size_bytes > 0 &&
        typeof asset.sha256 === "string" &&
        digestPattern.test(asset.sha256),
    ) ||
    !manifest.assets.some((asset) => asset.path === "teamhub.js") ||
    !manifest.assets.some((asset) =>
      asset.path.startsWith("teamhub-chunks/"),
    ) ||
    new Set(manifest.assets.map((asset) => asset.path)).size !==
      manifest.assets.length ||
    createHash("sha256")
      .update(JSON.stringify(manifest.assets))
      .digest("hex") !== manifest.artifact_sha256
  )
    throw new Error("Release CLI asset manifest is invalid.");
  const assets = manifest.assets.map((asset) => `cli/${asset.path}`);
  await check(assets);
  for (const asset of manifest.assets) {
    const bytes = await readFile(path.join(bundle, "cli", asset.path));
    if (
      bytes.length !== asset.size_bytes ||
      createHash("sha256").update(bytes).digest("hex") !== asset.sha256
    )
      throw new Error(
        `Release CLI asset does not match its manifest: ${asset.path}`,
      );
  }
  return [...fixed, ...assets, ...tools];
}

async function present(file) {
  return await lstat(file).then(
    () => true,
    (error) => {
      if (missing(error)) return false;
      throw error;
    },
  );
}

async function computerToolEntries(bundle, platform, fresh) {
  const root = path.join(bundle, "cli/computer-tools");
  try {
    await lstat(root);
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
  if (!fresh) await platform.check(root, "directory");
  const manifest = JSON.parse(
    await readFile(path.join(root, "manifest.json"), "utf8"),
  );
  const assets = manifest.assets;
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  if (
    manifest.schema_version !== 1 ||
    !Array.isArray(assets) ||
    manifest.playwright_entry !== "node_modules/@playwright/mcp/cli.js" ||
    manifest.pi_extension !== "extensions/pi-mcp.mjs" ||
    manifest.cua_entry !== "cua/cua-driver.exe" ||
    !assets.some((a) => a.path === manifest.cua_entry) ||
    !assets.every(
      (a) =>
        safeToolPath(a.path) &&
        Number.isSafeInteger(a.size_bytes) &&
        a.size_bytes >= 0 &&
        digestPattern.test(a.sha256),
    ) ||
    new Set(assets.map((a) => a.path.toLowerCase())).size !== assets.length ||
    hash(JSON.stringify(assets)) !== manifest.artifact_sha256
  )
    throw new Error("Invalid Computer tool manifest.");
  const expected = new Set(["manifest.json", ...assets.map((a) => a.path)]);
  const actual = [];
  const walk = async (relative = "") => {
    for (const name of await readdir(path.join(root, relative))) {
      const entry = relative ? `${relative}/${name}` : name;
      const info = await lstat(path.join(root, entry));
      if (info.isDirectory() && !info.isSymbolicLink()) await walk(entry);
      else if (
        info.isFile() &&
        !info.isSymbolicLink() &&
        info.nlink === 1 &&
        expected.has(entry)
      )
        actual.push(entry);
      else throw new Error("Unlisted or unsafe Computer tool asset.");
    }
  };
  await walk();
  if (actual.length !== expected.size)
    throw new Error("Missing Computer tool asset.");
  for (const asset of assets) {
    const data = await readFile(path.join(root, asset.path));
    if (data.length !== asset.size_bytes || hash(data) !== asset.sha256)
      throw new Error("Computer tool asset checksum mismatch.");
  }
  if (
    !expected.has(manifest.playwright_entry) ||
    !expected.has(manifest.pi_extension)
  )
    throw new Error("Computer tool entrypoint is missing.");
  return [...expected].sort().map((entry) => `cli/computer-tools/${entry}`);
}

export function validateDownloadSource(source) {
  if (path.isAbsolute(source) || path.win32.isAbsolute(source)) return;
  const url = new URL(source);
  if (url.username || url.password || url.hash)
    throw new Error("Download URL contains credentials or a fragment.");
  if (url.protocol === "file:") {
    if (url.hostname && url.hostname !== "localhost")
      throw new Error("Remote file URLs are not supported.");
    return;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("Download URL must use HTTPS or HTTP.");
}

export function validateOrigin(value) {
  const url = new URL(value);
  validateDownloadSource(value);
  if (url.origin !== value || !["http:", "https:"].includes(url.protocol))
    throw new Error("Web URL must be an exact HTTP(S) origin.");
}

// Antivirus and the search indexer briefly hold files that were just written
// or run, and Windows then fails a directory rename with EPERM, EACCES, or
// EBUSY. Retry for about a minute, as graceful-fs does, before giving up.
export async function renameWithRetry(
  from,
  to,
  { move = rename, wait = delay, attempts = 40 } = {},
) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await move(from, to);
    } catch (error) {
      if (
        attempt >= attempts ||
        !["EPERM", "EACCES", "EBUSY"].includes(error?.code)
      )
        throw error;
      await wait(Math.min(250 * attempt, 2000));
    }
  }
}

const DOWNLOAD_LIMIT_BYTES = 256 * 1024 * 1024;

const get = (url, signal) =>
  new Promise((resolve, reject) => {
    (url.startsWith("https:") ? https : http)
      .get(url, { signal }, resolve)
      .once("error", reject);
  });

// A slow network may take many minutes for the package. Abort only when no
// bytes arrive for stallMs, never on total duration. fetch read the package
// about twenty times slower than node:https on Windows.
export async function download(
  source,
  destination,
  onProgress = () => {},
  stallMs = 120_000,
) {
  validateDownloadSource(source);
  let content;
  if (path.isAbsolute(source) || path.win32.isAbsolute(source))
    content = await readFile(source);
  else if (source.startsWith("file:"))
    content = await readFile(fileURLToPath(source));
  else {
    let url = source;
    const controller = new AbortController();
    const stall = setTimeout(
      () =>
        controller.abort(
          new Error("Download stalled; check the network and retry."),
        ),
      stallMs,
    );
    try {
      for (let redirects = 0; ; redirects++) {
        validateDownloadSource(url);
        const response = await get(url, controller.signal);
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.resume();
          if (redirects >= 5 || !response.headers.location)
            throw new Error("Download redirect limit exceeded.");
          url = new URL(response.headers.location, url).href;
          continue;
        }
        if (status < 200 || status > 299) {
          response.resume();
          throw new Error(`Download failed (${status}).`);
        }
        const total = Number(response.headers["content-length"]) || 0;
        if (total > DOWNLOAD_LIMIT_BYTES) {
          response.destroy();
          throw new Error("Release download exceeds the size limit.");
        }
        const chunks = [];
        let received = 0;
        for await (const chunk of response) {
          stall.refresh();
          received += chunk.length;
          if (received > DOWNLOAD_LIMIT_BYTES)
            throw new Error("Release download exceeds the size limit.");
          chunks.push(chunk);
          onProgress(received, total);
        }
        content = Buffer.concat(chunks);
        break;
      }
    } catch (error) {
      throw controller.signal.aborted ? controller.signal.reason : error;
    } finally {
      clearTimeout(stall);
    }
  }
  if (content.length > DOWNLOAD_LIMIT_BYTES)
    throw new Error("Release download exceeds the size limit.");
  await writeFile(destination, content, { flag: "wx", mode: 0o600 });
}

export function downloadDetail(received, total) {
  const megabytes = (bytes) => (bytes / 1024 / 1024).toFixed(1);
  if (!total) return `${megabytes(received)} MB`;
  const filled = Math.min(20, Math.floor((received / total) * 20));
  return `[${"#".repeat(filled)}${"-".repeat(20 - filled)}] ${Math.floor((received / total) * 100)}% ${megabytes(received)}/${megabytes(total)} MB`;
}

export function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

// Numbered steps in plain ASCII: Windows PowerShell 5.1 consoles render no
// Unicode symbols. An interactive console redraws the current line with a
// spinner and elapsed time; redirected output gets one heartbeat line at most
// every ten seconds. The PowerShell bootstrap opens a step and passes it here.
export function createProgress({
  total,
  interactive = false,
  write,
  now = Date.now,
  startedAt = now(),
  step = 0,
  label = "",
  stepStartedAt = now(),
  heartbeatMs = 10_000,
}) {
  let current = step ? { step, label, startedAt: stepStartedAt } : null;
  let detail = "";
  let frame = 0;
  let drawn = 0;
  let timer = null;
  const prefix = () => `[${current.step}/${total}] ${current.label}...`;
  const elapsed = () => formatDuration(now() - current.startedAt);
  const draw = (suffix, final = false) => {
    const line = `${prefix()} ${suffix}`;
    write(
      `\r${line}${" ".repeat(Math.max(0, drawn - line.length))}${final ? "\n" : ""}`,
    );
    drawn = final ? 0 : line.length;
  };
  const tick = () => {
    if (interactive)
      draw(`${detail ? `${detail} ` : ""}${"|/-\\"[frame++ % 4]} ${elapsed()}`);
    else write(`      ${detail || "still working"} (${elapsed()})\n`);
  };
  const start = () => {
    timer = setInterval(tick, interactive ? 250 : heartbeatMs);
    timer.unref?.();
    if (interactive) tick();
  };
  const stop = (result) => {
    if (!current) return;
    clearInterval(timer);
    if (interactive) draw(`${result} (${elapsed()})`, true);
    else write(`${prefix()} ${result} (${elapsed()})\n`);
    current = null;
    detail = "";
  };
  if (current) start();
  return {
    get step() {
      return current?.step ?? 0;
    },
    begin(number, text) {
      stop("OK");
      current = { step: number, label: text, startedAt: now() };
      if (!interactive) write(`${prefix()}\n`);
      start();
    },
    update(text) {
      detail = text;
    },
    end(result = "OK") {
      stop(result);
    },
    fail() {
      stop("FAILED");
    },
    note(text) {
      if (interactive && current) {
        write(`\r${" ".repeat(drawn)}\r${text}\n`);
        drawn = 0;
        tick();
      } else write(`${text}\n`);
    },
    total: () => formatDuration(now() - startedAt),
  };
}

// The Agent Service image ships each Windows target as a dependency archive
// (Node and computer tools) and an application archive (daemon and CLI), both
// unpacked into one bundle. The installer the deployment rendered names their
// digests; TLS to that origin is the trust root.
export const WINDOWS_RELEASE_ARCHIVES = ["deps", "app"];

export function validateWindowsRelease(release, target) {
  for (const kind of WINDOWS_RELEASE_ARCHIVES) {
    const archive = release?.[kind];
    if (
      !archive ||
      !digestPattern.test(archive.sha256) ||
      archive.file !== `${kind}-${target}-${archive.sha256}.tar.gz` ||
      !Number.isSafeInteger(archive.size) ||
      archive.size < 1 ||
      archive.size > DOWNLOAD_LIMIT_BYTES
    )
      throw new Error("Installer release metadata is invalid.");
  }
}

/** One installed identity for the pair: either archive changing reinstalls. */
export const windowsReleaseDigest = (release) =>
  createHash("sha256")
    .update(`${release.deps.sha256}\n${release.app.sha256}`)
    .digest("hex");

// Only product files and manifest-listed CLI chunks are accepted as regular
// USTAR entries; general archive layouts remain outside this trust boundary.
// Unpacks every archive into one bundle and returns the bundle checksum,
// computed from the archive bytes it wrote. No entry may repeat across them.
export async function extractWindowsBundle(
  archivePaths,
  destination,
  platform,
) {
  const found = new Map();
  await platform.ensure(destination);
  for (const archivePath of archivePaths)
    await extractWindowsArchive(archivePath, destination, found);
  const expected = await windowsBundleEntries(destination, platform, true);
  if (expected.some((entry) => !found.has(entry)))
    throw new Error("Release archive is incomplete.");
  if (found.size !== expected.length)
    throw new Error(
      "Release archive contains entries outside its CLI manifest.",
    );
  const digest = createHash("sha256");
  for (const entry of expected)
    digest.update(entry).update("\0").update(found.get(entry));
  return digest.digest("hex");
}

async function extractWindowsArchive(archivePath, destination, found) {
  const archive = gunzipSync(await readFile(archivePath), {
    maxOutputLength: 512 * 1024 * 1024,
  });
  let offset = 0;
  let terminated = false;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      terminated = true;
      if (archive.subarray(offset).some((byte) => byte !== 0))
        throw new Error("Archive has trailing content.");
      break;
    }
    const text = (start, end) =>
      header.subarray(start, end).toString("utf8").replace(/\0.*$/su, "");
    const prefix = text(345, 500);
    const name = prefix ? `${prefix}/${text(0, 100)}` : text(0, 100);
    const sizeText = text(124, 136).trim();
    const checksumText = text(148, 156).trim();
    const expectedHeaderChecksum = Number.parseInt(checksumText, 8);
    const actualHeaderChecksum = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    if (
      !/^[0-7]+$/u.test(sizeText) ||
      !/^[0-7]+$/u.test(checksumText) ||
      expectedHeaderChecksum !== actualHeaderChecksum ||
      !permittedBundleEntry(name) ||
      found.has(name) ||
      ![0, 48].includes(header[156]) ||
      (prefix !== "" && !computerToolEntry(name))
    ) {
      throw new Error(
        "Release archive contains an invalid or unexpected entry.",
      );
    }
    const size = Number.parseInt(sizeText, 8);
    if (
      !Number.isSafeInteger(size) ||
      size < (computerToolEntry(name) ? 0 : 1) ||
      offset + size > archive.length
    )
      throw new Error("Release archive is truncated.");
    const destinationFile = path.join(destination, name);
    const content = archive.subarray(offset, offset + size);
    // The destination is private and every file is newly created, so each
    // directory inherits its ACL; links and pre-existing files are rejected.
    await mkdir(path.dirname(destinationFile), { recursive: true });
    await writeFile(destinationFile, content, { flag: "wx", mode: 0o700 });
    found.set(name, content);
    offset += Math.ceil(size / 512) * 512;
  }
  if (!terminated) throw new Error("Release archive is incomplete.");
}

export function windowsLauncherConfig(dataRoot) {
  return JSON.stringify({ schemaVersion: 1, dataRoot });
}

export async function invoke(
  command,
  arguments_,
  environment,
  input,
  maxOutputBytes = 4 * 1024 * 1024,
) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      env: environment,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [],
      stderr = [];
    let size = 0;
    let stderrSize = 0;
    let overflow = false;
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxOutputBytes) {
        overflow = true;
        child.kill("SIGKILL");
      } else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (stderrSize < 64 * 1024)
        stderr.push(chunk.subarray(0, 64 * 1024 - stderrSize));
      stderrSize += chunk.length;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (overflow)
        return reject(
          new Error("Computer command output exceeds the size limit."),
        );
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export function nativePlatform(daemon) {
  const request = async (action, values, maxOutputBytes) => {
    const result = await invoke(
      daemon,
      ["platform"],
      process.env,
      JSON.stringify({ action, ...values }),
      maxOutputBytes,
    );
    if (result.code !== 0)
      throw new Error(`Windows ${action} failed. ${result.stderr.trim()}`);
    return JSON.parse(result.stdout || "{}");
  };
  return {
    ensure: async (directory) =>
      request("ensure-private-directory", { path: directory }),
    check: async (file, kind) =>
      request("check-private-path", { path: file, kind, ownerOnly: true }),
    checkFiles: async (files) => {
      try {
        await request("check-private-paths", { paths: files, kind: "file" });
      } catch {
        // Daemons built before the batch request reject it. Checking each file
        // also reports the real error when one of them is unsafe.
        for (const file of files)
          await request("check-private-path", {
            path: file,
            kind: "file",
            ownerOnly: true,
          });
      }
    },
    read: async (file, maxBytes = 4 * 1024 * 1024) =>
      (
        await request(
          "read-private-file",
          {
            path: file,
            maxBytes,
          },
          maxBytes > 4 * 1024 * 1024 ? maxBytes * 2 : undefined,
        )
      ).data,
    write: async (file, data) =>
      request("write-private-file", { path: file, data }),
    request,
    acquire: async (root) => {
      const marker = path.join(root, ".install-helper.json");
      const identity = (await request("inspect-process", { pid: process.pid }))
        .identity;
      if (!identity)
        throw new Error("Installer process identity could not be established.");
      try {
        await lstat(marker);
        const previous = JSON.parse(
          (await request("read-private-file", { path: marker })).data,
        );
        const actual = (await request("inspect-process", { pid: previous.pid }))
          .identity;
        if (actual && actual.startTime === previous.startTime)
          throw new Error("Another Local Computer installer helper is active.");
        await rm(marker);
      } catch (error) {
        if (!missing(error)) throw error;
      }
      await request("write-private-file", {
        path: marker,
        data: JSON.stringify(identity),
        exclusive: true,
      });
      return async () => {
        await rm(marker, { force: true });
      };
    },
  };
}

export async function runWindowsInstaller(settings, dependencies = {}) {
  const { log } = dependencies;
  const progress =
    dependencies.progress ??
    createProgress({
      total: settings.operation === "uninstall" ? 3 : 4,
      ...settings.progress,
      interactive: !log && process.stdout.isTTY === true,
      write: log
        ? (text) => log(text.trim())
        : (text) => process.stdout.write(text),
    });
  if (!progress.step) progress.begin(1, "Checking the installed version");
  const platform =
    dependencies.platform ??
    nativePlatform(
      path.join(settings.bootstrapRoot, "daemon/linger-computer-daemon.exe"),
    );
  const root = path.resolve(settings.dataRoot);
  try {
    if (
      root === path.parse(root).root ||
      root === path.resolve(process.env.USERPROFILE || process.env.HOME || ".")
    )
      throw new Error("Install destination is unsafe.");
    await platform.ensure(root);
    const releaseLock = await platform.acquire?.(root);
    try {
      return await performWindowsInstaller(settings, {
        ...dependencies,
        platform,
        progress,
      });
    } finally {
      await releaseLock?.();
    }
  } catch (error) {
    progress.fail();
    throw error;
  }
}

// Install steps share one context: the resolved install paths, the platform
// and process adapters, and the progress reporter of the current run.
function installContext(settings, dependencies) {
  const root = path.resolve(settings.dataRoot);
  // Each environment has its own launcher, linger-computer-<environment>.exe,
  // bound to its install root by the configuration beside it.
  if (!/^linger-computer-[a-z0-9][a-z0-9-]*$/u.test(settings.commandName ?? ""))
    throw new Error("Installer command name is invalid.");
  const launcher = path.join(
    path.resolve(settings.binDirectory),
    `${settings.commandName}.exe`,
  );
  const configFile = settings.configFile || path.join(root, "config.json");
  const { progress } = dependencies;
  return {
    settings,
    dependencies,
    platform: dependencies.platform,
    transfer: dependencies.download ?? download,
    execute: dependencies.invoke ?? invoke,
    progress,
    log: (message) => progress.note(message),
    root,
    launcher,
    launcherConfig: path.join(
      path.dirname(launcher),
      `${settings.commandName}.launcher.json`,
    ),
    legacyLauncher: path.join(path.dirname(launcher), "linger-computer.cmd"),
    // linger-computer.exe runs the only environment launcher beside it and
    // lists them otherwise. A file there that is not a native launcher is left
    // alone, and a copy that is running keeps its current version.
    dispatcher: path.join(path.dirname(launcher), "linger-computer.exe"),
    configFile,
    environment: {
      ...process.env,
      LINGER_COMPUTER_DATA_DIR: root,
      LINGER_COMPUTER_CONFIG: configFile,
    },
  };
}

const metadataPath = (c, name) => path.join(c.root, name);

// The native private read validates owner, DACL, and link count itself.
async function readOptional(c, file, maxBytes) {
  try {
    await lstat(file);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  return await c.platform.read(file, maxBytes);
}

async function readValue(c, name) {
  return (await readOptional(c, metadataPath(c, name)))?.trim() ?? null;
}

async function writeValue(c, name, value) {
  const file = metadataPath(c, name);
  if (value === null) {
    if ((await readOptional(c, file)) !== null) await rm(file);
  } else await c.platform.write(file, `${value}\n`);
  if (process.env.LINGER_INSTALL_TEST_FAIL_AFTER_METADATA_WRITE === name)
    throw new Error(`Injected metadata failure: ${name}`);
}

async function readLauncher(c) {
  try {
    await lstat(c.launcher);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  await c.platform.check(c.launcher, "file");
  const content = await readFile(c.launcher);
  if (!content.includes(Buffer.from("linger-native-cli-launcher-v1")))
    throw new Error(
      "Existing launcher is not owned by this installation; it was preserved.",
    );
  return content;
}

async function writeLauncher(c, content) {
  if (content === null) {
    await rm(c.launcher, { force: true });
    return;
  }
  if (!content.includes(Buffer.from("linger-native-cli-launcher-v1")))
    throw new Error("Native launcher is invalid.");
  if ((await readLauncher(c))?.equals(content)) return;
  const temporary = path.join(
    path.dirname(c.launcher),
    `.linger-launcher-${randomUUID()}`,
  );
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    await c.platform.check(temporary, "file");
    await rename(temporary, c.launcher);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function restoreLaunchers(c, journal, oldBundle = null) {
  if (journal.schemaVersion === 3) {
    const current = await readLauncher(c);
    if (journal.launcherChecksum === null) await writeLauncher(c, null);
    else if (
      !current ||
      createHash("sha256").update(current).digest("hex") !==
        journal.launcherChecksum
    ) {
      if (!oldBundle)
        throw new Error(
          "Previous native launcher cannot be verified; recovery files were preserved.",
        );
      const content = await readFile(path.join(oldBundle, "cli/teamhub.exe"));
      if (
        createHash("sha256").update(content).digest("hex") !==
        journal.launcherChecksum
      )
        throw new Error(
          "Previous native launcher checksum differs; recovery files were preserved.",
        );
      await writeLauncher(c, content);
    }
  } else {
    // Schema 1 contained the batch wrapper. Schema 2 embedded a native binary.
    await writeLauncher(
      c,
      journal.launcher === null
        ? null
        : Buffer.from(journal.launcher, "base64"),
    );
  }
  for (const [file, content] of [
    [c.launcherConfig, journal.launcherConfig],
    [c.legacyLauncher, journal.legacyLauncher],
  ]) {
    if (content == null) await rm(file, { force: true });
    else await c.platform.write(file, content);
  }
}

async function removeLaunchers(c) {
  for (const file of [c.launcher, c.launcherConfig, c.legacyLauncher])
    await rm(file, { force: true });
}

async function readDispatcher(c) {
  const content = await readFile(c.dispatcher).catch((error) => {
    if (missing(error)) return null;
    throw error;
  });
  return content === null ||
    content.includes(Buffer.from("linger-native-cli-launcher-v1"))
    ? content
    : undefined;
}

const inUse = (error) => ["EBUSY", "EPERM", "EACCES"].includes(error.code);

async function refreshDispatcher(c) {
  const current = await readDispatcher(c);
  const content = await readFile(c.launcher);
  if (current === undefined || current?.equals(content)) return;
  const temporary = path.join(
    path.dirname(c.launcher),
    `.linger-launcher-${randomUUID()}`,
  );
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    await c.platform.check(temporary, "file");
    await rename(temporary, c.dispatcher);
  } catch (error) {
    if (!inUse(error)) throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

async function removeDispatcherWithLastEnvironment(c) {
  const remaining = (await readdir(path.dirname(c.launcher))).some((name) =>
    /^linger-computer-[a-z0-9][a-z0-9-]*\.launcher\.json$/u.test(name),
  );
  if (remaining || !(await readDispatcher(c))) return;
  await rm(c.dispatcher, { force: true }).catch((error) => {
    if (!inUse(error)) throw error;
  });
}

async function cli(c, bundle, arguments_) {
  return await c.execute(
    path.join(bundle, "cli/linger-computer.exe"),
    arguments_,
    c.environment,
  );
}

async function cliChecked(c, bundle, arguments_) {
  const result = await cli(c, bundle, arguments_);
  if (result.code !== 0)
    throw new Error(
      result.stderr.trim() || `Computer ${arguments_[0]} failed.`,
    );
  return result.stdout;
}

async function daemonCli(c, bundle, arguments_, checked = false) {
  return checked
    ? cliChecked(c, bundle, ["daemon", ...arguments_])
    : cli(c, bundle, ["daemon", ...arguments_]);
}

async function status(c, bundle, allowUnconfigured = false) {
  const result = await daemonCli(c, bundle, ["status", "--json"]);
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    // Unparsable output fails below as a CLI that could not run.
  }
  if (
    report?.version !== 1 ||
    typeof report.daemon?.state !== "string" ||
    (!allowUnconfigured &&
      (report.config?.configured === false ||
        report.error?.category === "configuration")) ||
    !Number.isSafeInteger(report.daemon.active_operations ?? 0) ||
    (report.daemon.active_operations ?? 0) < 0
  ) {
    const reason =
      typeof report?.error?.message === "string" && report.error.message.trim()
        ? report.error.message.trim()
        : "the installed CLI could not run";
    throw new Error(
      `Unable to verify the Computer daemon state: ${reason}. The existing installation was preserved.`,
    );
  }
  return report;
}

async function safeBundle(c, name, expected) {
  if (!name || !bundlePattern.test(name) || !digestPattern.test(expected || ""))
    throw new Error("Installed bundle metadata is invalid.");
  const bundle = path.join(c.root, name);
  if ((await bundleChecksum(bundle, c.platform)) !== expected)
    throw new Error(
      "Installed bundle integrity verification failed; no installed program was executed.",
    );
  return bundle;
}

async function stateDirectory(c) {
  const content = await readOptional(c, c.configFile);
  if (content === null) return path.join(c.root, "state");
  const config = JSON.parse(content);
  if (
    typeof config.state_directory !== "string" ||
    !path.isAbsolute(config.state_directory)
  )
    throw new Error("Computer configuration has no valid state directory.");
  return config.state_directory;
}

async function stopIdle(c, bundle) {
  const report = await status(c, bundle);
  if ((report.daemon.active_operations ?? 0) > 0)
    throw new Error("Cannot upgrade while Agent Operations are active.");
  if (report.daemon.state !== "stopped")
    await daemonCli(c, bundle, ["stop", "--if-idle"], true);
  const stopped = await status(c, bundle);
  if (
    stopped.daemon.state !== "stopped" ||
    (stopped.daemon.active_operations ?? 0) !== 0
  )
    throw new Error(
      "Idle shutdown could not be confirmed; installation was preserved.",
    );
  return report;
}

async function saveJournal(c, journal) {
  const content = JSON.stringify(journal);
  if (Buffer.byteLength(content) > 4 * 1024 * 1024)
    throw new Error(
      "Install recovery journal exceeds the metadata size limit.",
    );
  await c.platform.write(metadataPath(c, JOURNAL), content);
}

async function restoreJournal(c, journal) {
  const { platform } = c;
  const published =
    (await readValue(c, "active-bundle")) === journal.newBundleName;
  if (journal.oldTrusted === false && !published) {
    // A failed repair must not leave a recovery journal that permanently
    // requires execution of the already-untrusted previous installation.
    for (const name of METADATA) {
      const content = journal.before[name];
      if (content === null) await rm(metadataPath(c, name), { force: true });
      else await platform.write(metadataPath(c, name), content);
    }
    await restoreLaunchers(c, journal);
    await rm(metadataPath(c, JOURNAL));
    return;
  }
  if (journal.oldTrusted === false && published) {
    const replacement = await safeBundle(
      c,
      journal.newBundleName,
      journal.newBundleChecksum,
    );
    await writeLauncher(
      c,
      await readFile(path.join(replacement, "cli/teamhub.exe")),
    );
    await platform.write(c.launcherConfig, windowsLauncherConfig(c.root));
    await rm(metadataPath(c, JOURNAL));
    throw new Error(
      "The verified replacement was preserved. Automatic rollback cannot execute the modified old installation; use status or retry the installer to recover.",
    );
  }
  if (journal.startAttempted) {
    const newBundle = await safeBundle(
      c,
      journal.newBundleName,
      journal.newBundleChecksum,
    );
    try {
      await stopIdle(c, newBundle);
    } catch {
      throw new Error(
        "Automatic rollback was deferred because idle shutdown could not be confirmed. Current installation and recovery journal were preserved; wait for active Operations and retry.",
      );
    }
  }
  // Check the old executable before restoring a pointer or restarting it.
  let oldBundle = null;
  if (journal.before["active-bundle"])
    oldBundle = await safeBundle(
      c,
      journal.before["active-bundle"].trim(),
      journal.before["installed-bundle-checksum"]?.trim(),
    );
  for (const name of METADATA.filter((entry) => entry !== "active-bundle")) {
    const content = journal.before[name];
    if (content === null) await rm(metadataPath(c, name), { force: true });
    else await platform.write(metadataPath(c, name), content);
  }
  await restoreLaunchers(c, journal, oldBundle);
  if (journal.before["active-bundle"] === null)
    await rm(metadataPath(c, "active-bundle"), { force: true });
  else
    await platform.write(
      metadataPath(c, "active-bundle"),
      journal.before["active-bundle"],
    );
  if (
    journal.wasRunning &&
    oldBundle &&
    (await status(c, oldBundle)).daemon.state === "stopped"
  )
    await daemonCli(c, oldBundle, ["start"], true);
  await rm(metadataPath(c, JOURNAL));
  // Keep immutable bundles: managed previews may still run an older daemon.
}

async function restoreUninstall(c, record) {
  if (
    record.schemaVersion !== 1 ||
    !/^\.uninstall-[0-9a-f-]+$/u.test(record.snapshot) ||
    !Array.isArray(record.bundles) ||
    record.bundles.some(
      (entry) =>
        !bundlePattern.test(entry.name) || !digestPattern.test(entry.checksum),
    )
  )
    throw new Error("Uninstall recovery journal is invalid.");
  const snapshot = path.join(c.root, record.snapshot);
  if (record.committed !== true) {
    // Uninstall moves each bundle whole into the snapshot, so a bundle is
    // in exactly one place; move back any that left.
    for (const entry of record.bundles) {
      const moved = path.join(snapshot, entry.name);
      const installed = path.join(c.root, entry.name);
      const source = (await exists(moved)) ? moved : installed;
      if ((await bundleChecksum(source, c.platform)) !== entry.checksum)
        throw new Error(
          "Uninstall recovery found a modified bundle; files were preserved.",
        );
      if (source === moved) await renameWithRetry(moved, installed);
    }
  } else {
    await removeLaunchers(c);
    for (const name of METADATA.filter((entry) => entry !== "web-origin"))
      await rm(metadataPath(c, name), { force: true });
  }
  await rm(metadataPath(c, UNINSTALL_JOURNAL));
  await rm(snapshot, { recursive: true, force: true });
}

async function stopOwned(c) {
  const state = await stateDirectory(c);
  const services = await c.platform.request("stop-managed-services", {
    stateDirectory: state,
  });
  if (services.stopped !== true)
    throw new Error(
      "Managed services have not stopped; installed files were preserved.",
    );
  await c.platform.request("cleanup-owned-processes", {
    stateDirectory: state,
  });
  const owned = await c.platform.request("owned-processes-stopped", {
    stateDirectory: state,
  });
  if (owned.stopped !== true)
    throw new Error(
      "Owned Computer processes have not stopped; installed files were preserved.",
    );
}

async function purgeState(c) {
  // Never recursively delete the install root: it may also contain projects.
  // fs.rm unlinks reparse/symbolic links; their targets remain outside scope.
  for (const name of [
    "config.json",
    "credentials",
    "state",
    "logs",
    "web-origin",
  ]) {
    const item = path.join(c.root, name);
    const info = await lstat(item).catch((error) => {
      if (missing(error)) return null;
      throw error;
    });
    if (info) {
      await c.platform.check(item, info.isDirectory() ? "directory" : "file");
      await rm(item, { recursive: info.isDirectory() });
    }
  }
}

// Refuses an unsafe destination or launcher files another installation owns,
// and returns the launcher files found beside this environment's launcher.
async function checkInstallDestination(c) {
  const { settings, platform, root } = c;
  if (!settings.target?.match(/^win32-(arm64|x64)$/u))
    throw new Error("Unsupported native Windows architecture.");
  if (
    root === path.parse(root).root ||
    root === path.resolve(process.env.USERPROFILE || process.env.HOME || ".")
  )
    throw new Error("Install destination is unsafe.");
  await platform.ensure(root);
  await platform.ensure(path.dirname(c.launcher));
  for (const name of METADATA) await readOptional(c, metadataPath(c, name));
  await readLauncher(c);
  const priorLauncherConfig = await readOptional(c, c.launcherConfig);
  const priorLegacyLauncher = await readOptional(c, c.legacyLauncher);
  if (
    priorLauncherConfig !== null &&
    priorLauncherConfig !== windowsLauncherConfig(root)
  )
    throw new Error(
      "Existing launcher is bound to a different installation; it was preserved.",
    );
  if (
    priorLegacyLauncher !== null &&
    !priorLegacyLauncher.includes("\r\nrem linger-computer-launcher-v1\r\n")
  )
    throw new Error(
      "Existing launcher is not owned by this installation; it was preserved.",
    );
  return { priorLauncherConfig, priorLegacyLauncher };
}

async function recoverInterruptedOperations(c) {
  // Only legacy schema 2 journals may need more than the normal metadata limit:
  // their embedded base64 executable is about 6 MiB. The native file reader
  // still validates ownership and bounds the read; new journals store a digest.
  const interrupted = await readOptional(
    c,
    metadataPath(c, JOURNAL),
    16 * 1024 * 1024,
  );
  if (interrupted !== null) {
    const journal = JSON.parse(interrupted);
    if (
      ![1, 2, 3].includes(journal.schemaVersion) ||
      (journal.schemaVersion !== 2 &&
        Buffer.byteLength(interrupted) > 4 * 1024 * 1024) ||
      !journal.before ||
      METADATA.some((name) => !Object.hasOwn(journal.before, name)) ||
      !bundlePattern.test(journal.newBundleName) ||
      !digestPattern.test(journal.newBundleChecksum) ||
      (journal.schemaVersion === 3
        ? journal.launcherChecksum !== null &&
          !digestPattern.test(journal.launcherChecksum || "")
        : ![null, "string"].includes(
            journal.launcher === null ? null : typeof journal.launcher,
          )) ||
      (journal.schemaVersion >= 2 &&
        [journal.launcherConfig, journal.legacyLauncher].some(
          (value) => value !== null && typeof value !== "string",
        ))
    )
      throw new Error(
        "Install recovery journal is invalid; files were preserved.",
      );
    if (journal.schemaVersion === 1) {
      journal.legacyLauncher = journal.launcher;
      journal.launcher = null;
      journal.launcherConfig = null;
    }
    await restoreJournal(c, journal);
    c.log("Recovered the interrupted installation.");
  }
  const interruptedUninstall = await readOptional(
    c,
    metadataPath(c, UNINSTALL_JOURNAL),
  );
  if (interruptedUninstall !== null) {
    await restoreUninstall(c, JSON.parse(interruptedUninstall));
    c.log("Recovered the interrupted uninstallation.");
  }
}

// An install repairs a bundle that fails verification; an uninstall refuses it.
async function findInstalledBundle(c) {
  const oldName = await readValue(c, "active-bundle");
  const installedDigest = await readValue(c, "installed-checksum");
  let oldBundle = null;
  if (oldName) {
    try {
      oldBundle = await safeBundle(
        c,
        oldName,
        await readValue(c, "installed-bundle-checksum"),
      );
    } catch (error) {
      if (c.settings.operation === "uninstall") throw error;
    }
  }
  return { oldName, installedDigest, oldBundle };
}

async function uninstall(c, installed) {
  const { settings, platform, progress, root, launcher } = c;
  const { oldName, oldBundle, priorLauncher, priorLegacyLauncher } = installed;
  if (!oldBundle) {
    if (
      oldName ||
      priorLauncher ||
      priorLegacyLauncher ||
      (await readdir(root)).some((name) => bundlePattern.test(name))
    )
      throw new Error(
        "Installed program cannot be verified; files were preserved.",
      );
    if (settings.purge) {
      await stopOwned(c);
      await purgeState(c);
    }
    progress.end("not installed");
    c.log("Local Computer is not installed.");
    return { installed: false, launcher };
  }
  progress.begin(2, "Stopping the Computer daemon");
  const report = await status(c, oldBundle, true);
  if (report.config?.configured !== false)
    await daemonCli(c, oldBundle, ["stop"], true);
  await stopOwned(c);
  if (
    report.config?.configured !== false &&
    (await status(c, oldBundle)).daemon.state !== "stopped"
  )
    throw new Error(
      "Computer daemon has not stopped; installed files were preserved.",
    );
  const record = {
    schemaVersion: 1,
    snapshot: `.uninstall-${randomUUID()}`,
    committed: false,
    bundles: [],
  };
  progress.begin(3, "Removing installed files");
  progress.update("verifying");
  await platform.ensure(path.join(root, record.snapshot));
  for (const name of (await readdir(root)).filter((entry) =>
    bundlePattern.test(entry),
  ))
    record.bundles.push({
      name,
      checksum: await bundleChecksum(path.join(root, name), platform),
    });
  await platform.write(
    metadataPath(c, UNINSTALL_JOURNAL),
    JSON.stringify(record),
  );
  progress.update("removing");
  try {
    // A rename is one step that either moves the whole bundle or fails on
    // a file another process still holds; copying thousands of files made
    // antivirus scan each one again.
    for (const entry of record.bundles)
      await (c.dependencies.moveBundle ?? renameWithRetry)(
        path.join(root, entry.name),
        path.join(root, record.snapshot, entry.name),
      );
    record.committed = true;
    await platform.write(
      metadataPath(c, UNINSTALL_JOURNAL),
      JSON.stringify(record),
    );
    await restoreUninstall(c, record);
  } catch (error) {
    try {
      await restoreUninstall(c, record);
    } catch (recoveryError) {
      throw new AggregateError(
        [error, recoveryError],
        `${error.message}\n${recoveryError.message}`,
        { cause: recoveryError },
      );
    }
    throw error;
  }
  if (settings.purge) await purgeState(c);
  await removeDispatcherWithLastEnvironment(c);
  progress.end();
  c.log(
    settings.purge
      ? `Uninstalled ${settings.commandName} (${settings.webOrigin}) and purged its product state in ${progress.total()}. User projects and Runtime authentication were preserved.`
      : `Uninstalled ${settings.commandName} (${settings.webOrigin}) in ${progress.total()}. Config, credentials, state, and logs were preserved in ${root}.`,
  );
  return { installed: false, launcher };
}

// The installed bundle already is this release with this environment's
// launcher files, so only the Web origin and dispatcher are refreshed.
async function isUpToDate(c, installed, releaseDigest) {
  const { oldBundle, installedDigest, priorLauncher } = installed;
  return (
    oldBundle &&
    installedDigest === releaseDigest &&
    priorLauncher?.equals(
      await readFile(path.join(oldBundle, "cli/teamhub.exe")).catch((error) => {
        if (missing(error)) return Buffer.alloc(0);
        throw error;
      }),
    ) &&
    installed.priorLauncherConfig === windowsLauncherConfig(c.root) &&
    installed.priorLegacyLauncher === null
  );
}

async function downloadRelease(c, temporary) {
  const { settings, progress } = c;
  const archives = [];
  for (const kind of WINDOWS_RELEASE_ARCHIVES) {
    const { file, sha256 } = settings.release[kind];
    const archive = path.join(temporary, file);
    const prepared = settings.bootstrapArchives?.[kind];
    if (prepared) {
      // PowerShell already downloaded this exact archive.
      await writeFile(archive, await readFile(prepared), { flag: "wx" });
    } else {
      if (progress.step !== 2) progress.begin(2, "Downloading the package");
      await c.transfer(
        `${settings.downloadBaseUrl.replace(/\/$/u, "")}/files/${file}`,
        archive,
        (received, size) => progress.update(downloadDetail(received, size)),
      );
    }
    archives.push({ archive, sha256 });
  }
  return archives;
}

// Checks the archives, unpacks them into one staged bundle, and runs only the
// staged programs whose integrity has been verified.
async function verifyRelease(c, archives, temporary) {
  const { settings, progress } = c;
  if (progress.step !== 3) progress.begin(3, "Verifying the package");
  for (const { archive, sha256 } of archives)
    if ((await fileChecksum(archive)) !== sha256)
      throw new Error("Release archive checksum verification failed.");
  const staged = path.join(temporary, "bundle");
  const stagedChecksum = await extractWindowsBundle(
    archives.map(({ archive }) => archive),
    staged,
    c.platform,
  );
  for (const entry of [...WINDOWS_BUNDLE_ENTRIES, "cli/teamhub.exe"].filter(
    (file) => file.endsWith(".exe"),
  )) {
    await (c.dependencies.checkExecutable ?? verifyWindowsExecutable)(
      path.join(staged, entry),
      settings.target,
    );
  }
  const version = (await cliChecked(c, staged, ["version"])).trim();
  if (!/^linger-computer \S+$/u.test(version))
    throw new Error("CLI version is invalid.");
  const runtimeVersion = await c.execute(
    path.join(staged, "runtime/bin/node.exe"),
    ["--version"],
    c.environment,
  );
  if (runtimeVersion.code !== 0 || runtimeVersion.stdout.trim() !== "v26.5.0")
    throw new Error("Bundled Node version does not match release metadata.");
  await cliChecked(c, staged, ["--help"]);
  await status(c, staged, true);
  return { staged, stagedChecksum, version };
}

// The journal records everything a rollback restores; the caller fills in the
// metadata snapshot.
async function createInstallJournal(c, installed, newName, stagedChecksum) {
  const { oldName, oldBundle, priorLauncher } = installed;
  const launcherChecksum =
    priorLauncher === null
      ? null
      : createHash("sha256").update(priorLauncher).digest("hex");
  if (
    oldBundle &&
    launcherChecksum !== null &&
    (await fileChecksum(path.join(oldBundle, "cli/teamhub.exe"))) !==
      launcherChecksum
  )
    throw new Error(
      "Existing native launcher differs from its verified bundle; installation was preserved.",
    );
  return {
    schemaVersion: 3,
    newBundleName: newName,
    newBundleChecksum: stagedChecksum,
    oldTrusted: (!oldName && priorLauncher === null) || oldBundle !== null,
    before: {},
    launcherChecksum,
    launcherConfig: await readOptional(c, c.launcherConfig),
    legacyLauncher: await readOptional(c, c.legacyLauncher),
    wasRunning: false,
    startAttempted: false,
  };
}

// Returns the daemon status from before the switch; the restarted daemon must
// bring back what was available then.
async function stopForSwitch(c, installed, journal, staged) {
  const { oldName, oldBundle } = installed;
  let baseline = null;
  if (oldName || (await readOptional(c, c.configFile)) !== null) {
    // A changed old binary is never executed. The staged verified CLI can
    // control the same daemon; invalid config still fails closed. Without
    // configuration the daemon cannot run, so nothing needs stopping.
    baseline = await status(c, oldBundle || staged, true);
    if (baseline.config?.configured === false) {
      // A daemon that started before its configuration disappeared still
      // holds the default state lock; refuse instead of switching under it.
      const owned = await c.platform.request("owned-processes-stopped", {
        stateDirectory: path.join(c.root, "state"),
      });
      if (owned.stopped !== true)
        throw new Error(
          "Unable to verify the Computer daemon state: configuration is missing but the daemon is still running. The existing installation was preserved.",
        );
    } else {
      baseline = await status(c, oldBundle || staged);
      journal.wasRunning = baseline.daemon.state !== "stopped";
      await saveJournal(c, journal);
      if (journal.wasRunning) c.progress.update("stopping the daemon");
      await stopIdle(c, oldBundle || staged);
    }
  }
  return baseline;
}

async function activateBundle(c, journal, staged, newName, releaseDigest) {
  c.progress.update("activating");
  await renameWithRetry(staged, path.join(c.root, newName));
  const newBundle = path.join(c.root, newName);
  await writeValue(c, "installed-bundle-checksum", journal.newBundleChecksum);
  await writeValue(c, "installed-checksum", releaseDigest);
  await writeValue(
    c,
    "installed-runtime-checksum",
    await fileChecksum(path.join(newBundle, "runtime/bin/node.exe")),
  );
  await writeValue(c, "web-origin", c.settings.webOrigin);
  await writeValue(c, "active-bundle", newName);
  // Keep the old launcher intact until the verified replacement is published.
  // This also preserves failed repairs whose old bundle cannot be trusted.
  await writeLauncher(
    c,
    await readFile(path.join(newBundle, "cli/teamhub.exe")),
  );
  await c.platform.write(c.launcherConfig, windowsLauncherConfig(c.root));
  return newBundle;
}

async function restartDaemon(c, journal, newBundle, baseline) {
  journal.startAttempted = true;
  await saveJournal(c, journal);
  c.progress.update("restarting the daemon");
  await daemonCli(c, newBundle, ["start"], true);
  const readinessMs = c.dependencies.readinessTimeoutMs ?? 30_000;
  const deadline = Date.now() + readinessMs;
  let ready;
  do {
    const report = await status(c, newBundle);
    ready =
      report.daemon.state === "running" &&
      report.daemon.gateway_state === "connected" &&
      report.daemon.reconciled === true &&
      (baseline.runtimes ?? [])
        .filter((runtime) => runtime.status === "ready")
        .every((runtime) =>
          (report.runtimes ?? []).some(
            (candidate) =>
              (candidate.type ?? candidate.runtime_type) ===
                (runtime.type ?? runtime.runtime_type) &&
              candidate.status === "ready",
          ),
        ) &&
      (baseline.runners ?? [])
        .filter((runner) => ["ready", "running", "idle"].includes(runner.state))
        .every((runner) =>
          (report.runners ?? []).some(
            (candidate) =>
              candidate.agent_id === runner.agent_id &&
              ["ready", "running", "idle"].includes(candidate.state),
          ),
        );
    if (
      ready ||
      ["authentication-failed", "upgrade-required"].includes(
        report.daemon.gateway_state,
      )
    )
      break;
    await delay(250);
  } while (Date.now() < deadline);
  if (!ready)
    throw new Error(
      `Upgraded daemon did not reconnect with reconciled, available Runtimes and Runners within ${formatDuration(readinessMs)}. See ${path.join(await stateDirectory(c), "daemon.log")}.`,
    );
}

async function install(c, installed) {
  const { settings, progress, launcher } = c;
  validateOrigin(settings.webOrigin);
  const temporary = path.join(c.root, `.install-${randomUUID()}`);
  await c.platform.ensure(temporary);
  let journal = null;
  let completed = false;
  let releaseDigest = null;
  try {
    validateWindowsRelease(settings.release, settings.target);
    releaseDigest = windowsReleaseDigest(settings.release);
    if (await isUpToDate(c, installed, releaseDigest)) {
      await status(c, installed.oldBundle, true);
      await writeValue(c, "web-origin", settings.webOrigin);
      await refreshDispatcher(c);
      completed = true;
      progress.end("up to date");
      c.log("Linger Computer is already up to date.");
      return { installed: true, unchanged: true, launcher };
    }
    const archives = await downloadRelease(c, temporary);
    const { staged, stagedChecksum, version } = await verifyRelease(
      c,
      archives,
      temporary,
    );
    const newName = `lib-${releaseDigest.slice(0, 16)}-${randomUUID()}`;
    journal = await createInstallJournal(c, installed, newName, stagedChecksum);
    // Assigned before its first write so a failed write still rolls back.
    for (const name of METADATA)
      journal.before[name] = await readOptional(c, metadataPath(c, name));
    await saveJournal(c, journal);
    progress.begin(4, "Installing");
    const baseline = await stopForSwitch(c, installed, journal, staged);
    const newBundle = await activateBundle(
      c,
      journal,
      staged,
      newName,
      releaseDigest,
    );
    if (journal.wasRunning)
      await restartDaemon(c, journal, newBundle, baseline);
    await rm(c.legacyLauncher, { force: true });
    await rm(metadataPath(c, JOURNAL));
    completed = true;
    await refreshDispatcher(c);
    progress.end();
    const label = version.replace(/^linger-computer /u, "");
    c.log(
      installed.oldName
        ? `Linger Computer upgraded to ${label} in ${progress.total()}.`
        : `Linger Computer ${label} installed in ${progress.total()}.`,
    );
    return { installed: true, unchanged: false, launcher };
  } catch (error) {
    if (journal && !completed) {
      try {
        await restoreJournal(c, journal);
        // The daemon waits out a cooldown before it upgrades to this release
        // again on its own (apps/computer/local-daemon/internal/selfupdate).
        await writeValue(
          c,
          "upgrade-failed",
          JSON.stringify({
            app_sha256: releaseDigest,
            failed_at: new Date().toISOString(),
          }),
        );
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `${error.message}\n${rollbackError.message}`,
          { cause: rollbackError },
        );
      }
    }
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function performWindowsInstaller(settings, dependencies) {
  const c = installContext(settings, dependencies);
  const { priorLauncherConfig, priorLegacyLauncher } =
    await checkInstallDestination(c);
  await recoverInterruptedOperations(c);
  const priorLauncher = await readLauncher(c);
  const installed = {
    ...(await findInstalledBundle(c)),
    priorLauncher,
    priorLauncherConfig,
    priorLegacyLauncher,
  };
  return settings.operation === "uninstall"
    ? await uninstall(c, installed)
    : await install(c, installed);
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  try {
    let source = "";
    for await (const chunk of process.stdin) source += chunk;
    await runWindowsInstaller(JSON.parse(source));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
