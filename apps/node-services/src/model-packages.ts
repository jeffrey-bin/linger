import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { mirrorHome, packageRoot } from "./paths.js";

// Packages holding model data that installers do not ship: they install
// separately, on first use. A production bundle lists them in models.json
// beside dist/ (apps/desktop/scripts/build-native-runtime.mjs), pinned to the
// lockfile's version and integrity. Without that file, as in development and
// the images, they come from node_modules like any other package.
export const MODEL_PACKAGES_FILE = "models.json";

export type ModelPackageGroup = "ocr" | "voice";

export interface ModelPackage {
  group: ModelPackageGroup;
  version: string;
  /** The lockfile's Subresource Integrity of the tarball (sha512). */
  integrity: string;
  /** Registry URLs of the same tarball, tried in order. */
  tarballs: string[];
}

const COMPLETE = ".simplex-model-package.json";

let listed: Record<string, ModelPackage> | undefined;
function modelPackages(): Record<string, ModelPackage> {
  if (!listed) {
    const file = path.join(packageRoot, MODEL_PACKAGES_FILE);
    listed = existsSync(file)
      ? (
          JSON.parse(readFileSync(file, "utf8")) as {
            packages: Record<string, ModelPackage>;
          }
        ).packages
      : {};
  }
  return listed;
}

/** The listed packages of `group`; none when they come from node_modules. */
export function modelPackageNames(group: ModelPackageGroup): string[] {
  return Object.entries(modelPackages())
    .filter(([, item]) => item.group === group)
    .map(([name]) => name);
}

/** Where downloaded model packages live, as a node_modules folder. */
export function modelPackagesRoot(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(mirrorHome(environment), "models", "node_modules");
}

const installedIntegrity = (directory: string): string | undefined => {
  try {
    return (
      JSON.parse(readFileSync(path.join(directory, COMPLETE), "utf8")) as {
        integrity?: string;
      }
    ).integrity;
  } catch {
    return undefined;
  }
};

/**
 * The directory of package `name` when it is listed: throws until it has been
 * installed. Undefined when it is not listed and resolves from node_modules.
 */
export function modelPackageDirectory(
  name: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const item = modelPackages()[name];
  if (!item) return undefined;
  const directory = path.join(modelPackagesRoot(environment), name);
  if (installedIntegrity(directory) !== item.integrity)
    throw new Error(`Model package ${name} is not installed`);
  return directory;
}

/** Whether every listed package in `names` is installed. */
export function modelPackagesInstalled(
  names: string[],
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return names.every((name) => {
    try {
      modelPackageDirectory(name, environment);
      return true;
    } catch {
      return false;
    }
  });
}

const installing = new Map<string, Promise<void>>();
// A failed download is not tried again for a minute, so callers without a
// network fail at once instead of each waiting for it.
const RETRY_AFTER_MS = 60_000;
const failed = new Map<string, { at: number; error: unknown }>();

/**
 * Downloads the listed packages in `names` that are not installed yet and
 * checks each tarball against its lockfile integrity. Concurrent callers in
 * one process share a download.
 */
export async function installModelPackages(
  names: string[],
  environment: NodeJS.ProcessEnv = process.env,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<void> {
  for (const name of names) {
    if (modelPackagesInstalled([name], environment)) continue;
    const failure = failed.get(name);
    if (failure && Date.now() - failure.at < RETRY_AFTER_MS)
      throw failure.error;
    let pending = installing.get(name);
    if (!pending) {
      pending = install(name, modelPackages()[name]!, environment, options);
      installing.set(name, pending);
      void pending.then(
        () => {
          installing.delete(name);
          failed.delete(name);
        },
        (error: unknown) => {
          installing.delete(name);
          failed.set(name, { at: Date.now(), error });
        },
      );
    }
    await pending;
  }
}

async function install(
  name: string,
  item: ModelPackage,
  environment: NodeJS.ProcessEnv,
  options: { fetch?: typeof fetch; timeoutMs?: number },
): Promise<void> {
  const root = modelPackagesRoot(environment);
  const directory = path.join(root, name);
  const tarball = await download(name, item, options);
  await mkdir(path.dirname(directory), { recursive: true });
  // A download another process left half way, or one that stopped with it.
  for (const entry of await readdir(path.dirname(directory))) {
    const partial = path.join(path.dirname(directory), entry);
    if (
      entry.startsWith(`${path.basename(directory)}.partial-`) &&
      Date.now() - (await stat(partial)).mtimeMs > 10 * 60_000
    )
      await rm(partial, { recursive: true, force: true });
  }
  const staging = `${directory}.partial-${randomUUID()}`;
  try {
    for (const [file, body] of unpackTarball(gunzipSync(tarball))) {
      const target = path.join(staging, ...file.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, body);
    }
    await writeFile(
      path.join(staging, COMPLETE),
      JSON.stringify({ version: item.version, integrity: item.integrity }),
    );
    await rm(directory, { recursive: true, force: true });
    await rename(staging, directory);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (installedIntegrity(directory) === item.integrity) return;
    throw error;
  }
}

async function download(
  name: string,
  item: ModelPackage,
  options: { fetch?: typeof fetch; timeoutMs?: number },
): Promise<Buffer> {
  const [algorithm, expected] = item.integrity.split(/-(.*)/s);
  if (algorithm !== "sha512" || !expected)
    throw new Error(`Model package ${name} has no sha512 integrity`);
  const errors: string[] = [];
  for (const url of item.tarballs) {
    try {
      const response = await (options.fetch ?? fetch)(url, {
        signal: AbortSignal.timeout(options.timeoutMs ?? 10 * 60_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = Buffer.from(await response.arrayBuffer());
      if (createHash("sha512").update(body).digest("base64") !== expected)
        throw new Error("integrity mismatch");
      return body;
    } catch (error) {
      errors.push(
        `${new URL(url).host}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw new Error(
    `Could not download model package ${name} (${errors.join("; ")})`,
  );
}

const field = (header: Buffer, start: number, length: number) =>
  header
    .subarray(start, start + length)
    .toString("utf8")
    .replace(/\0.*$/s, "");

/**
 * The regular files of an npm tarball (ustar, with pax path records), by path
 * inside its `package/` folder. Other entry types are skipped; a path that
 * leaves the folder rejects the tarball.
 */
export function unpackTarball(tar: Buffer): [string, Buffer][] {
  const files: [string, Buffer][] = [];
  let longName: string | undefined;
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(field(header, 124, 12).trim() || "0", 8);
    const type = field(header, 156, 1) || "0";
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8"))?.[1];
      continue;
    }
    const prefix = field(header, 345, 155);
    const name =
      longName ??
      (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    longName = undefined;
    if (type !== "0") continue;
    const parts = name.split("/").slice(1);
    if (
      parts.length === 0 ||
      parts.some((part) => part === "" || part === "." || part === "..") ||
      name.includes("\\")
    )
      throw new Error(`Unsafe path in model package: ${name}`);
    files.push([parts.join("/"), Buffer.from(body)]);
  }
  return files;
}
