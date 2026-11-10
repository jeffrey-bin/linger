import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import {
  buildTeamhub,
  sourceCommit,
  verifyTeamhub,
} from "../../scripts/build-teamhub.mjs";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

// A source package as scripts/prepare-source-archive.mjs makes it, from a
// one-commit repository, and a `go` on PATH that records each build.
const fixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), "build-teamhub-"));
  roots.push(root);
  const repo = path.join(root, "repo");
  mkdirSync(path.join(repo, "apps/teamhub"), { recursive: true });
  writeFileSync(path.join(repo, "apps/teamhub/go.mod"), "module teamhub\n");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "source",
  );
  const archive = path.join(root, "linger-test.tar.gz");
  execFileSync("sh", [
    "-c",
    `git -C "${repo}" archive --format=tar --prefix=linger-test/ HEAD | gzip -n > "${archive}"`,
  ]);
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, "go"),
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "env") { console.log("go1.26.5"); process.exit(0); }
const out = args[args.indexOf("-o") + 1];
fs.writeFileSync(out, JSON.stringify({ args, goos: process.env.GOOS, cgo: process.env.CGO_ENABLED, cwd: process.cwd() }));
`,
  );
  chmodSync(path.join(bin, "go"), 0o755);
  vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
  return { root, archive, commit: git("rev-parse", "HEAD") };
};

it("reads the commit git archive records in a source package", async () => {
  const f = fixture();
  expect(await sourceCommit(f.archive)).toBe(f.commit);
  const plain = path.join(f.root, "plain.tar.gz");
  execFileSync("tar", ["-czf", plain, "-C", f.root, "bin"]);
  await expect(sourceCommit(plain)).rejects.toThrow(
    "does not record its commit",
  );
});

it("builds each TeamHub command for Windows from the source package", async () => {
  const f = fixture();
  const output = path.join(f.root, "out");
  const manifest = await buildTeamhub("win32-x64", f.archive, output);
  expect(manifest).toMatchObject({
    target: "win32-x64",
    sourceCommit: f.commit,
    goVersion: "1.26.5",
  });
  expect(Object.keys(manifest.binaries)).toEqual([
    "teamhub",
    "migrate",
    "account",
  ]);
  const built = JSON.parse(
    readFileSync(path.join(output, "migrate.exe"), "utf8"),
  );
  expect(built).toMatchObject({ goos: "windows", cgo: "0" });
  expect(built.args).toEqual([
    "build",
    "-trimpath",
    "-ldflags",
    "-s -w",
    "-o",
    path.join(output, "migrate.exe"),
    "./cmd/migrate",
  ]);
  expect(path.basename(path.dirname(built.cwd))).toBe("apps");
  // The packaging check refuses a changed binary or another source package.
  await expect(
    verifyTeamhub(output, "win32-x64", "0".repeat(64)),
  ).rejects.toThrow("another target or source package");
  writeFileSync(path.join(output, "account.exe"), "changed");
  await expect(
    verifyTeamhub(output, "win32-x64", manifest.sourceArchiveSha256),
  ).rejects.toThrow("account.exe does not match");
});
