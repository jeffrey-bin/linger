import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

export function relativeArchivePath(name) {
  if (
    typeof name !== "string" ||
    !name ||
    name.includes("\\") ||
    name.includes("\0") ||
    path.posix.isAbsolute(name) ||
    name.split("/").includes("..") ||
    /^[A-Za-z]:/u.test(name)
  ) {
    throw new Error(`Unsafe archive path: ${name}`);
  }
  const normalized = path.posix.normalize(name).replace(/\/$/u, "");
  if (normalized === ".") throw new Error(`Invalid archive file path: ${name}`);
  return normalized;
}

// Release packages use USTAR. Reject extensions, hardlinks, devices and sparse
// entries rather than delegating extraction to platform-dependent tar behavior.
export async function extractManagedToolsArchive(compressed, destination) {
  const archive = gunzipSync(compressed, {
    maxOutputLength: 512 * 1024 * 1024,
  });
  const entries = new Map();
  let offset = 0;
  let terminated = false;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      if (
        archive.length - offset < 512 ||
        archive.subarray(offset).some((byte) => byte !== 0)
      )
        throw new Error("Invalid archive termination");
      terminated = true;
      break;
    }
    const text = (start, end) =>
      header.subarray(start, end).toString("utf8").replace(/\0.*$/su, "");
    const octal = (start, end) => {
      const value = text(start, end).trim();
      if (!/^[0-7]+$/u.test(value))
        throw new Error("Invalid archive numeric field");
      return Number.parseInt(value, 8);
    };
    const checksum = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    if (
      octal(148, 156) !== checksum ||
      !["ustar", ""].includes(text(257, 263).trim())
    )
      throw new Error("Invalid archive header");
    const rawName = [text(345, 500), text(0, 100)].filter(Boolean).join("/");
    const type = String.fromCharCode(header[156] || 48);
    const size = octal(124, 136);
    const mode = octal(100, 108) & 0o777;
    if (!["0", "2", "5"].includes(type) || (type !== "0" && size !== 0))
      throw new Error("Unsupported archive entry or link");
    if (
      !Number.isSafeInteger(size) ||
      offset + Math.ceil(size / 512) * 512 > archive.length
    )
      throw new Error("Truncated archive");
    if (type === "5" && /^\.\/?$/u.test(rawName)) continue;
    const name = relativeArchivePath(rawName);
    if (entries.has(name)) throw new Error("Duplicate archive path");
    const link = text(157, 257);
    if (type === "2") {
      if (
        !link ||
        link.includes("\\") ||
        path.posix.isAbsolute(link) ||
        /^[A-Za-z]:/u.test(link)
      )
        throw new Error("Unsafe archive link");
      relativeArchivePath(path.posix.join(path.posix.dirname(name), link));
    }
    entries.set(name, {
      type,
      mode,
      link,
      content: archive.subarray(offset, offset + size),
    });
    offset += Math.ceil(size / 512) * 512;
  }
  if (!terminated) throw new Error("Incomplete archive");
  // Validate the whole tree before writing anything. Never traverse a link,
  // even an internal one, while materializing another archive entry.
  for (const name of entries.keys()) {
    let parent = path.posix.dirname(name);
    while (parent !== ".") {
      if (entries.has(parent) && entries.get(parent).type !== "5")
        throw new Error("Archive path traverses a file or link");
      parent = path.posix.dirname(parent);
    }
  }
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const [name, entry] of entries) {
    const target = path.join(destination, name);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
    if (entry.type === "5")
      await mkdir(target, { recursive: true, mode: 0o755 });
    else if (entry.type === "0")
      await writeFile(target, entry.content, { flag: "wx", mode: entry.mode });
  }
  for (const [name, entry] of entries)
    if (entry.type === "2")
      await symlink(entry.link, path.join(destination, name));
  for (const [name, entry] of entries)
    if (entry.type === "2") {
      const resolved = await realpath(path.join(destination, name));
      if (!resolved.startsWith(`${await realpath(destination)}${path.sep}`))
        throw new Error("Archive link escapes installation directory");
    }
}

export async function verifyManagedPackage(directory, tool) {
  if (!["teamhub", "lev8"].includes(tool))
    throw new Error("Explicit managed package type is required");
  const files = await regularFiles(directory);
  const packageRoot = await realpath(directory);
  for (const name of files) {
    const resolved = await realpath(path.join(directory, name));
    if (!resolved.startsWith(`${packageRoot}${path.sep}`))
      throw Object.assign(
        new Error("Package link escapes installation directory"),
        {
          code: "UNMANAGED_LAYOUT",
        },
      );
  }
  // The tool and entrypoint define the package type; missing integrity metadata
  // never selects an unchecked legacy format.
  const javascript =
    tool === "teamhub" &&
    (await lstat(path.join(directory, "teamhub.js")).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    ));
  let checksums;
  try {
    checksums = await readFile(path.join(directory, "files.sha256"), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT" || !javascript || files.includes("teamhub"))
      throw error;
  }
  if (checksums !== undefined) {
    const listed = new Set();
    for (const line of checksums.trimEnd().split("\n")) {
      const match = /^([0-9a-f]{64}) [ *](.+)$/iu.exec(line);
      if (!match) throw new Error("Invalid files.sha256");
      const name = relativeArchivePath(match[2]);
      if (listed.has(name)) throw new Error("Duplicate files.sha256 entry");
      listed.add(name);
      if (
        sha256(await readFile(path.join(directory, name))) !==
        match[1].toLowerCase()
      )
        throw new Error(`Package file SHA256 mismatch: ${name}`);
    }
    for (const name of files)
      if (name !== "files.sha256" && !listed.has(name))
        throw new Error(`Package file missing from files.sha256: ${name}`);
  }
  if (!javascript && !files.includes("teamhub-assets.json")) return;
  // The build-cli.mjs contract requires the entry and all lazy chunks.
  const assets = JSON.parse(
    await readFile(path.join(directory, "teamhub-assets.json"), "utf8"),
  );
  if (
    assets.schema_version !== 1 ||
    assets.entrypoint !== "teamhub.js" ||
    !Array.isArray(assets.assets) ||
    !assets.assets.some((asset) => asset.path === assets.entrypoint)
  )
    throw new Error("Invalid TeamHub asset manifest");
  for (const asset of assets.assets) {
    const data = await readFile(
      path.join(directory, relativeArchivePath(asset.path)),
    );
    if (data.length !== asset.size_bytes || sha256(data) !== asset.sha256)
      throw new Error(`TeamHub asset verification failed: ${asset.path}`);
  }
}

async function regularFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(path.join(directory, prefix), {
    withFileTypes: true,
  })) {
    const name = path.posix.join(prefix, entry.name);
    if (entry.isDirectory())
      files.push(...(await regularFiles(directory, name)));
    else files.push(name);
  }
  return files;
}
