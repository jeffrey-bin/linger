import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseSourceDependenciesArguments,
  prepareSourceDependencies,
  sourceDependenciesEnvironment,
} from "./prepare-source-dependencies.mjs";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
  });

// A committed source with the real install plan and a pnpm that records how
// it was called and fills the store it was given.
const repository = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "source-dependencies-"));
  mkdirSync(path.join(root, "scripts"));
  for (const file of [
    "source-native.mjs",
    "replace-process.mjs",
    "with-local-env.mjs",
  ])
    copyFileSync(
      path.join(import.meta.dirname, file),
      path.join(root, "scripts", file),
    );
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ packageManager: "pnpm@11.7.0" }),
  );
  writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "init");
  const pnpm = path.join(root, "fake-pnpm");
  const calls = path.join(root, "calls.json");
  writeFileSync(
    pnpm,
    `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("11.7.0"); process.exit(0); }
const store = args[args.indexOf("--store-dir") + 1];
fs.mkdirSync(path.join(store, "v11"), { recursive: true });
fs.writeFileSync(path.join(store, "v11", "index"), "packages");
fs.writeFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, workspace: fs.readFileSync("pnpm-workspace.yaml", "utf8") }));
`,
  );
  chmodSync(pnpm, 0o755);
  return { root, pnpm, calls };
};

describe("source dependencies", () => {
  it("packs one platform's store of the projects the source installs", async () => {
    const f = repository();
    const output = path.join(f.root, "out");
    const host = `${process.platform}-${process.arch}`;
    const target = host === "darwin-arm64" ? "linux-x64" : "darwin-arm64";
    const result = await prepareSourceDependencies(
      [
        "--target",
        target,
        "--label",
        "v1.0.0",
        "--output",
        output,
        "--url-base",
        "https://cdn.example/linger/v1.0.0",
      ],
      { cwd: f.root, pnpm: f.pnpm },
    );
    const fileName = `linger-v1.0.0-dependencies-${target}.tar.gz`;
    expect(path.basename(result.archive)).toBe(fileName);
    expect(result.sha256).toBe(
      createHash("sha256").update(readFileSync(result.archive)).digest("hex"),
    );
    expect(
      execFileSync("tar", ["-tzf", result.archive], { encoding: "utf8" })
        .trim()
        .split("\n")
        .sort(),
    ).toEqual(["pnpm-store/", "pnpm-store/v11/", "pnpm-store/v11/index"]);
    const { args, workspace } = JSON.parse(readFileSync(f.calls, "utf8"));
    expect(args.slice(0, 5)).toEqual([
      "install",
      "--filter",
      "@linger/node-services...",
      "--filter",
      "@linger/web...",
    ]);
    expect(args).toContain("--frozen-lockfile");
    // Another platform's packages, without running their install scripts.
    expect(args.at(-1)).toBe("--ignore-scripts");
    const [platform, cpu] = target.split("-");
    expect(workspace).toContain(
      `supportedArchitectures:\n  os: [${platform}]\n  cpu: [${cpu}]\n`,
    );
    expect(await sourceDependenciesEnvironment(output, target)).toEqual({
      LINGER_SOURCE_DEPENDENCIES_URL: `https://cdn.example/linger/v1.0.0/${fileName}`,
      LINGER_SOURCE_DEPENDENCIES_SHA256: result.sha256,
    });
  });

  it("validates its arguments", () => {
    expect(() =>
      parseSourceDependenciesArguments(["--target", "darwin-x64"]),
    ).toThrow("--target must be one of");
    expect(() =>
      parseSourceDependenciesArguments(["--url-base", "http://cdn.example"]),
    ).toThrow("--url-base must be https");
    expect(() => parseSourceDependenciesArguments(["--force"])).toThrow(
      "Unknown source dependencies argument",
    );
  });
});
