import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  checkNativeRuntime,
  markNativeRuntimeVerified,
  NATIVE_RUNTIME_DIRECTORY,
  NATIVE_RUNTIME_FILES,
  NATIVE_RUNTIME_VERIFIED,
  nativeRuntimeVerified,
  parseNativeRuntime,
} from "./native-runtime.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const ENTRIES = [
  "web/static-host.mjs",
  "web/dist/index.html",
  "node-services/dist/main.js",
  "node-services/dist/supervisor.js",
];

// A checkout with the runtime build-native-runtime.mjs writes for `target`.
async function checkout(target = "win32-x64") {
  const repo = await mkdtemp(path.join(tmpdir(), "native-runtime-"));
  roots.push(repo);
  const directory = path.join(repo, NATIVE_RUNTIME_DIRECTORY);
  const files: Record<string, { bytes: number; sha256: string }> = {};
  for (const file of [
    ...ENTRIES,
    "node-services/node_modules/sharp/package.json",
  ]) {
    const body = `contents of ${file}`;
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), body);
    files[file] = {
      bytes: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
    };
  }
  const manifest = {
    schema: 1,
    target,
    sourceCommit: "a".repeat(40),
    sourceArchiveSha256: "b".repeat(64),
    files,
  };
  await writeFile(
    path.join(directory, NATIVE_RUNTIME_FILES),
    JSON.stringify(manifest),
  );
  return { repo, directory, manifest };
}

test("verifies a runtime built for this computer", async () => {
  const f = await checkout();
  expect(await checkNativeRuntime(f.repo, { target: "win32-x64" })).toBe(
    "verified",
  );
  expect(existsSync(f.directory)).toBe(true);
});

test("knows a runtime as complete only with a record for its files.json", async () => {
  const f = await checkout();
  expect(await nativeRuntimeVerified(f.directory)).toBe(false);
  await markNativeRuntimeVerified(f.directory);
  expect(await nativeRuntimeVerified(f.directory)).toBe(true);
  await writeFile(
    path.join(f.directory, NATIVE_RUNTIME_FILES),
    JSON.stringify({ ...f.manifest, sourceCommit: "c".repeat(40) }),
  );
  expect(await nativeRuntimeVerified(f.directory)).toBe(false);
});

test("reports a checkout without a runtime as absent", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "native-runtime-"));
  roots.push(repo);
  expect(await checkNativeRuntime(repo, { target: "win32-x64" })).toBe(
    "absent",
  );
});

test("removes a runtime with a changed file", async () => {
  const f = await checkout();
  await writeFile(
    path.join(f.directory, "node-services/dist/main.js"),
    "contents of node-services/dist/mainXjs",
  );
  expect(await checkNativeRuntime(f.repo, { target: "win32-x64" })).toBe(
    "removed",
  );
  expect(existsSync(f.directory)).toBe(false);
});

test("removes a runtime with a missing file", async () => {
  const f = await checkout();
  await rm(
    path.join(f.directory, "node-services/node_modules/sharp/package.json"),
  );
  expect(await checkNativeRuntime(f.repo, { target: "win32-x64" })).toBe(
    "removed",
  );
});

test("removes a runtime built for another computer", async () => {
  const f = await checkout("linux-x64");
  expect(await checkNativeRuntime(f.repo, { target: "win32-x64" })).toBe(
    "removed",
  );
  expect(existsSync(f.directory)).toBe(false);
});

test("rejects manifests with unsafe paths or without the entries", async () => {
  const { manifest } = await checkout();
  const item = { bytes: 1, sha256: "c".repeat(64) };
  for (const file of [
    "../outside.js",
    "/etc/passwd",
    "C:/Windows/x.dll",
    "apps\\web\\x.js",
    "apps//web",
    NATIVE_RUNTIME_FILES,
  ])
    expect(() =>
      parseNativeRuntime({
        ...manifest,
        files: { ...manifest.files, [file]: item },
      }),
    ).toThrow("Invalid Native runtime manifest.");
  const { [ENTRIES[2]!]: _main, ...withoutMain } = manifest.files;
  expect(() => parseNativeRuntime({ ...manifest, files: withoutMain })).toThrow(
    "Invalid Native runtime manifest.",
  );
  // A layout this desktop does not know.
  expect(() => parseNativeRuntime({ ...manifest, schema: 2 })).toThrow(
    "Invalid Native runtime manifest.",
  );
  expect(parseNativeRuntime(manifest)).toEqual(manifest);
});

test("records a hashed runtime and later checks it by size", async () => {
  const f = await checkout();
  const checked: string[] = [];
  const check = () =>
    checkNativeRuntime(f.repo, {
      target: "win32-x64",
      checked: (how) => checked.push(how),
    });
  expect(await check()).toBe("verified");
  expect(existsSync(path.join(f.directory, NATIVE_RUNTIME_VERIFIED))).toBe(
    true,
  );
  // Same size, other contents: the record means the file is not read again.
  await writeFile(
    path.join(f.directory, "node-services/dist/main.js"),
    "contents of node-services/dist/mainXjs",
  );
  expect(await check()).toBe("verified");
  expect(checked).toEqual(["hashes", "sizes"]);
});

test("a recorded runtime with a truncated file is removed", async () => {
  const f = await checkout();
  await markNativeRuntimeVerified(f.directory);
  await writeFile(path.join(f.directory, "web/dist/index.html"), "");
  expect(await checkNativeRuntime(f.repo, { target: "win32-x64" })).toBe(
    "removed",
  );
});

test("a record for another manifest does not count", async () => {
  const f = await checkout();
  await markNativeRuntimeVerified(f.directory);
  await writeFile(
    path.join(f.directory, "node-services/dist/main.js"),
    "contents of node-services/dist/mainXjs",
  );
  await writeFile(
    path.join(f.directory, NATIVE_RUNTIME_FILES),
    JSON.stringify({ ...f.manifest, sourceCommit: "c".repeat(40) }),
  );
  expect(await checkNativeRuntime(f.repo, { target: "win32-x64" })).toBe(
    "removed",
  );
});

test("verifies many files at once", async () => {
  const f = await checkout();
  const files = { ...f.manifest.files };
  for (let index = 0; index < 100; index++) {
    const file = `node-services/node_modules/pkg/${String(index)}.js`;
    const body = `module ${String(index)}`;
    await mkdir(path.dirname(path.join(f.directory, file)), {
      recursive: true,
    });
    await writeFile(path.join(f.directory, file), body);
    files[file] = {
      bytes: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
    };
  }
  await writeFile(
    path.join(f.directory, NATIVE_RUNTIME_FILES),
    JSON.stringify({ ...f.manifest, files }),
  );
  expect(await checkNativeRuntime(f.repo, { target: "win32-x64" })).toBe(
    "verified",
  );
  await rm(path.join(f.directory, NATIVE_RUNTIME_VERIFIED));
  await writeFile(
    path.join(f.directory, "node-services/node_modules/pkg/57.js"),
    "module 99",
  );
  expect(await checkNativeRuntime(f.repo, { target: "win32-x64" })).toBe(
    "removed",
  );
});
