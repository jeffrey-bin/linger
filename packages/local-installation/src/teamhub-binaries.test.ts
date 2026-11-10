import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  checkTeamhubBinaries,
  installTeamhubBinaries,
  parseTeamhubBinaries,
  TEAMHUB_BINARY_DIRECTORY,
  TEAMHUB_COMMANDS,
} from "./teamhub-binaries.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const sourceArchiveSha256 = "c".repeat(64);
const target = "win32-x64";

// A desktop build's binaries for `target`, as build-teamhub.mjs writes them.
async function bundle() {
  const root = await mkdtemp(path.join(tmpdir(), "teamhub-binaries-"));
  roots.push(root);
  const from = path.join(root, "native/teamhub-win32-x64");
  const repo = path.join(root, "source");
  await mkdir(from, { recursive: true });
  await mkdir(repo);
  const binaries: Record<string, object> = {};
  for (const command of TEAMHUB_COMMANDS) {
    const body = `${command} for windows`;
    await writeFile(path.join(from, `${command}.exe`), body);
    binaries[command] = {
      file: `${command}.exe`,
      sha256: createHash("sha256").update(body).digest("hex"),
      bytes: body.length,
    };
  }
  const manifest = {
    target,
    sourceCommit: "d".repeat(40),
    sourceArchiveSha256,
    goVersion: "1.26.5",
    binaries,
  };
  await writeFile(path.join(from, "manifest.json"), JSON.stringify(manifest));
  return { from, repo, manifest };
}

test("copies the binaries of its own source package into the source", async () => {
  const f = await bundle();
  const expected = { target, sourceArchiveSha256 };
  expect(await installTeamhubBinaries(f.from, f.repo, expected)).toBe(
    "installed",
  );
  const directory = path.join(f.repo, TEAMHUB_BINARY_DIRECTORY);
  expect(await readFile(path.join(directory, "teamhub.exe"), "utf8")).toBe(
    "teamhub for windows",
  );
  expect(
    JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")),
  ).toEqual(f.manifest);
  expect(await installTeamhubBinaries(f.from, f.repo, expected)).toBe(
    "current",
  );
  expect(await checkTeamhubBinaries(f.repo, target)).toBe("verified");
  // A build without them leaves Native to compile.
  expect(
    await installTeamhubBinaries(path.join(f.from, "none"), f.repo, expected),
  ).toBe("absent");
});

test("refuses binaries of another target or source package", async () => {
  const f = await bundle();
  await expect(
    installTeamhubBinaries(f.from, f.repo, {
      target: "linux-x64",
      sourceArchiveSha256,
    }),
  ).rejects.toThrow("are for win32-x64, not linux-x64");
  await expect(
    installTeamhubBinaries(f.from, f.repo, {
      target,
      sourceArchiveSha256: "e".repeat(64),
    }),
  ).rejects.toThrow("built from another source package");
  expect(existsSync(path.join(f.repo, TEAMHUB_BINARY_DIRECTORY))).toBe(false);
});

test("a binary that does not match leaves no manifest behind", async () => {
  const f = await bundle();
  await writeFile(path.join(f.from, "account.exe"), "account for windowz");
  await expect(
    installTeamhubBinaries(f.from, f.repo, { target, sourceArchiveSha256 }),
  ).rejects.toThrow("account.exe does not match");
  expect(existsSync(path.join(f.repo, TEAMHUB_BINARY_DIRECTORY))).toBe(false);
  expect(await checkTeamhubBinaries(f.repo, target)).toBe("absent");
});

test("check removes binaries for another computer or that changed", async () => {
  const f = await bundle();
  await installTeamhubBinaries(f.from, f.repo, { target, sourceArchiveSha256 });
  expect(await checkTeamhubBinaries(f.repo, "linux-x64")).toBe("removed");
  expect(existsSync(path.join(f.repo, TEAMHUB_BINARY_DIRECTORY))).toBe(false);
  await installTeamhubBinaries(f.from, f.repo, { target, sourceArchiveSha256 });
  await writeFile(
    path.join(f.repo, TEAMHUB_BINARY_DIRECTORY, "teamhub.exe"),
    "changed",
  );
  expect(await checkTeamhubBinaries(f.repo, target)).toBe("removed");
});

test("a manifest names only plain files", () => {
  const binary = { sha256: "f".repeat(64), bytes: 1 };
  const manifest = (file: string) => ({
    target,
    sourceCommit: "d".repeat(40),
    sourceArchiveSha256,
    goVersion: "1.26.5",
    binaries: Object.fromEntries(
      TEAMHUB_COMMANDS.map((command) => [command, { ...binary, file }]),
    ),
  });
  expect(() => parseTeamhubBinaries(manifest("teamhub.exe"))).not.toThrow();
  for (const file of ["../teamhub.exe", "bin/teamhub", "C:teamhub.exe"])
    expect(() => parseTeamhubBinaries(manifest(file))).toThrow(
      "Invalid TeamHub binary manifest.",
    );
});
