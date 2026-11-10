import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  linkSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertArchiveEntries,
  assertTarget,
  verifySource,
  nativeLibraryChanges,
  createRuntimeArchive,
  WINDOWS_POSTGRES,
  WINDOWS_RUNTIME,
  SOURCES,
  windowsRuntimeFiles,
} from "./prepare-native-postgres.mjs";

describe("native PostgreSQL publisher", () => {
  it("rejects source corruption before extraction", () => {
    expect(() => verifySource(Buffer.from("modified"), "0".repeat(64))).toThrow(
      "checksum mismatch",
    );
  });
  it("only builds for its actual supported host", () => {
    expect(() => assertTarget("../../root", "darwin-arm64")).toThrow(
      "Unsupported",
    );
    expect(() => assertTarget("linux-x64", "darwin-arm64")).toThrow("host");
    expect(assertTarget("linux-x64", "linux-x64")).toBe("linux-x64");
    // pgvector for Windows needs MSVC, so Windows also builds on Windows.
    expect(() => assertTarget("win32-x64", "linux-x64")).toThrow("host");
    expect(assertTarget("win32-x64", "win32-x64")).toBe("win32-x64");
  });
  it("rejects traversal, absolute paths and unexpected archive roots", () => {
    for (const entry of [
      "../evil",
      "/etc/passwd",
      "pg/../../evil",
      "other/bin",
    ])
      expect(() => assertArchiveEntries([entry], "pg")).toThrow("Unsafe");
    expect(() =>
      assertArchiveEntries(["pg/", "pg/src/file"], "pg"),
    ).not.toThrow();
  });
});

it("pins Windows PostgreSQL to the same release as the source build", () => {
  expect(WINDOWS_POSTGRES.version).toBe(SOURCES.postgres.version);
  expect(WINDOWS_POSTGRES.url).toContain(
    `postgresql-${SOURCES.postgres.version}-1-windows-x64-binaries.zip`,
  );
  // EDB entries sit under one root; pgAdmin and StackBuilder stay out.
  expect(() =>
    assertArchiveEntries(
      ["pgsql/bin/postgres.exe", "pgsql/pgAdmin 4/x.py"],
      WINDOWS_POSTGRES.root,
    ),
  ).not.toThrow();
  expect(WINDOWS_POSTGRES.keep).not.toContain("pgAdmin 4");
});

it("ships the newest x64 Visual C++ runtime the EDB zip leaves out", async () => {
  const redist = mkdtempSync(path.join(os.tmpdir(), "vc-redist-"));
  try {
    await expect(windowsRuntimeFiles(undefined)).rejects.toThrow(
      "Native Tools Command Prompt",
    );
    for (const crt of ["Microsoft.VC142.CRT", "Microsoft.VC143.CRT"])
      mkdirSync(path.join(redist, "x64", crt), { recursive: true });
    mkdirSync(path.join(redist, "x64", "Microsoft.VC143.OPENMP"));
    expect(await windowsRuntimeFiles(redist)).toEqual(
      WINDOWS_RUNTIME.map((name) =>
        path.join(redist, "x64", "Microsoft.VC143.CRT", name),
      ),
    );
    expect(WINDOWS_RUNTIME).toContain("vcruntime140.dll");
  } finally {
    rmSync(redist, { recursive: true, force: true });
  }
});

it("relocates only actual Mach-O dependencies, ignoring static archive member headers", () => {
  const prefix = "/private/build/prefix";
  expect(
    nativeLibraryChanges(`${prefix}/lib/libecpg.a(member.o):\n`, prefix, "lib"),
  ).toEqual([]);
  expect(
    nativeLibraryChanges(
      `${prefix}/bin/psql:\n\t${prefix}/lib/libpq.5.dylib (compatibility version 5.0.0)\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)`,
      prefix,
      "bin",
    ),
  ).toEqual([
    [`${prefix}/lib/libpq.5.dylib`, "@loader_path/../lib/libpq.5.dylib"],
  ]);
});

it("publishes only regular files even when PostgreSQL installs hardlinked timezone aliases", async () => {
  const temporary = mkdtempSync(
    path.join(os.tmpdir(), "postgres-archive-test-"),
  );
  try {
    const prefix = path.join(temporary, "prefix");
    mkdirSync(prefix);
    writeFileSync(path.join(prefix, "original"), "runtime-data");
    linkSync(path.join(prefix, "original"), path.join(prefix, "hardlink"));
    symlinkSync("original", path.join(prefix, "symlink"));
    const archive = path.join(temporary, "runtime.tar.gz");
    await createRuntimeArchive(prefix, archive);
    const listing = spawnSync("tar", ["-tvzf", archive], { encoding: "utf8" });
    expect(listing.status).toBe(0);
    expect(
      listing.stdout.split("\n").filter((line) => /^[hl]/.test(line)),
    ).toEqual([]);
    expect(listing.stdout).toContain("original");
    expect(listing.stdout).toContain("hardlink");
    expect(listing.stdout).toContain("symlink");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
