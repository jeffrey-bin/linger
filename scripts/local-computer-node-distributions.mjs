#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const NODE_RUNTIME_VERSION = "26.5.0";
export const NODE_RUNTIME_RELEASES = Object.freeze({
  "darwin-arm64": {
    archive: `node-v${NODE_RUNTIME_VERSION}-darwin-arm64.tar.gz`,
    sha256: "ee920559aaa2391569cff4d737e3b83963430e3a14dedd91bfe0ff53171b5af9",
  },
  "darwin-x64": {
    archive: `node-v${NODE_RUNTIME_VERSION}-darwin-x64.tar.gz`,
    sha256: "98293394c945a24e64e00b4177bf075ec963ea70b34d1d2e24bd4a71716d334f",
  },
  "linux-arm64": {
    archive: `node-v${NODE_RUNTIME_VERSION}-linux-arm64.tar.gz`,
    sha256: "308e5fe89a82461ba5a6cf15ff5221b2cdbd7ae87600aa72bb3c3fbdc66412d1",
  },
  "linux-x64": {
    archive: `node-v${NODE_RUNTIME_VERSION}-linux-x64.tar.gz`,
    sha256: "22b5f47ad6ae78837e4c2b846019965ce1a06ba143de176102294a1bf44fc677",
  },
  "win32-arm64": {
    archive: `node-v${NODE_RUNTIME_VERSION}-win-arm64.zip`,
    sha256: "c0cfa5877b6de743301e622f5abc4d26fb0ff8798adffc8fffd2885f426008ba",
  },
  "win32-x64": {
    archive: `node-v${NODE_RUNTIME_VERSION}-win-x64.zip`,
    sha256: "d3b2277dbcccfdf24ef6302928f64f484cff1d77a6d3caa3a28f4d20ce9158f6",
  },
});

export const RELEASE_TARGETS = Object.freeze(
  Object.keys(NODE_RUNTIME_RELEASES),
);
export const NODE_RUNTIME_DOWNLOAD_BASE_URL = "https://nodejs.org/dist";
// Serves the same archives, so the pinned checksums still decide what is
// used; tried when nodejs.org is unreachable or slow.
export const NODE_RUNTIME_DOWNLOAD_MIRRORS = Object.freeze([
  "https://cdn.npmmirror.com/binaries/node",
]);
const NODE_RUNTIME_IDLE_TIMEOUT_MS = 60_000;

/** Every host for one pinned archive, the official one first. */
export function nodeRuntimeDownloadUrls(
  archive,
  version = NODE_RUNTIME_VERSION,
  baseUrls = [NODE_RUNTIME_DOWNLOAD_BASE_URL, ...NODE_RUNTIME_DOWNLOAD_MIRRORS],
) {
  return baseUrls.map(
    (base) => `${base.replace(/\/$/u, "")}/v${version}/${archive}`,
  );
}

export function parseNodeDistributionArguments(arguments_) {
  const options = {
    downloadBaseUrl: null,
    output: null,
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--download-base-url" || argument === "--output") {
      const value = arguments_[index + 1];
      if (!value) throw new Error(`${argument} requires a value.`);
      options[argument === "--output" ? "output" : "downloadBaseUrl"] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown Node distribution argument: ${argument}`);
  }
  if (!options.output) throw new Error("--output is required.");
  if (options.downloadBaseUrl) new URL(options.downloadBaseUrl);
  return options;
}

export async function ensureNodeRuntimeArchives(
  outputDirectory,
  {
    downloadBaseUrl,
    fetchImplementation = fetch,
    releases = NODE_RUNTIME_RELEASES,
    version = NODE_RUNTIME_VERSION,
  } = {},
) {
  await mkdir(outputDirectory, { recursive: true });
  return await Promise.all(
    Object.keys(releases).map(async (target) => ({
      archivePath: await ensureNodeRuntimeArchive(target, outputDirectory, {
        downloadBaseUrl,
        fetchImplementation,
        releases,
        version,
      }),
      target,
    })),
  );
}

export async function ensureNodeRuntimeArchive(
  target,
  outputDirectory,
  {
    // One explicit host replaces nodejs.org and its mirrors.
    downloadBaseUrl,
    fetchImplementation = fetch,
    releases = NODE_RUNTIME_RELEASES,
    version = NODE_RUNTIME_VERSION,
    idleTimeoutMs = NODE_RUNTIME_IDLE_TIMEOUT_MS,
  } = {},
) {
  const release = releases[target];
  if (!release) throw new Error(`Missing pinned Node runtime for ${target}.`);
  await mkdir(outputDirectory, { recursive: true });
  const destination = path.join(outputDirectory, release.archive);
  if ((await fileChecksum(destination)) === release.sha256) return destination;

  const pending = path.join(
    outputDirectory,
    `.${release.archive}.${process.pid}.${randomUUID()}.tmp`,
  );
  const urls = nodeRuntimeDownloadUrls(
    release.archive,
    version,
    downloadBaseUrl ? [downloadBaseUrl] : undefined,
  );
  const failures = [];
  try {
    // Each host in turn; a slow, failing or altered copy moves on to the next.
    for (const url of urls) {
      try {
        await download(fetchImplementation, url, pending, idleTimeoutMs);
        if ((await sha256(pending)) !== release.sha256)
          throw new Error("checksum mismatch");
        await rename(pending, destination);
        return destination;
      } catch (error) {
        failures.push(
          `${new URL(url).host}: ${error instanceof Error ? error.message : error}`,
        );
        await rm(pending, { force: true });
      }
    }
    throw new Error(
      `Node runtime download of ${release.archive} failed (${failures.join("; ")}).`,
    );
  } finally {
    await rm(pending, { force: true });
  }
}

// Writes one response to `file`; a body that stops sending fails the attempt.
async function download(fetchImplementation, url, file, idleTimeoutMs) {
  const stalled = new AbortController();
  let idle;
  const watch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => stalled.abort(), idleTimeoutMs);
  };
  const stall = new Promise((_resolve, reject) =>
    stalled.signal.addEventListener("abort", () =>
      reject(new Error("stalled")),
    ),
  );
  stall.catch(() => {});
  watch();
  const handle = await open(file, "wx", 0o600);
  try {
    const response = await Promise.race([
      fetchImplementation(url, { signal: stalled.signal }),
      stall,
    ]);
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), stall]);
        if (done) return;
        watch();
        await handle.writeFile(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  } finally {
    clearTimeout(idle);
    await handle.close();
  }
}

async function fileChecksum(filePath) {
  try {
    return await sha256(filePath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function sha256(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  const options = parseNodeDistributionArguments(process.argv.slice(2));
  const archives = await ensureNodeRuntimeArchives(
    path.resolve(options.output),
    {
      downloadBaseUrl: options.downloadBaseUrl ?? undefined,
    },
  );
  const files = await readdir(path.resolve(options.output));
  if (files.some((file) => file.endsWith(".tmp"))) {
    throw new Error("Node distribution output contains an incomplete file.");
  }
  process.stdout.write(
    `Prepared ${archives.length} pinned Node distributions.\n`,
  );
}
