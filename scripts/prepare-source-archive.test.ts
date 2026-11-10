import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseSourceArchiveArguments,
  prepareSourceArchive,
  sourceArchiveEnvironment,
} from "./prepare-source-archive.mjs";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    env: { ...process.env, GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" },
  });

const repository = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "source-archive-"));
  mkdirSync(path.join(root, "scripts"));
  writeFileSync(path.join(root, "scripts/source-native.mjs"), "");
  writeFileSync(path.join(root, "README.md"), "linger\n");
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-q", "--date=2026-01-01T00:00:00Z", "-m", "init");
  git(root, "tag", "v1.0.0");
  return root;
};

describe("source archive", () => {
  it("packs one tag under a single folder with a stable digest", async () => {
    const root = repository();
    const output = path.join(root, "out");
    const args = [
      "--ref",
      "v1.0.0",
      "--output",
      output,
      "--url-base",
      "https://github.com/simplexai-labs/linger/releases/download/v1.0.0",
    ];
    // Uncommitted changes never reach the archive.
    writeFileSync(path.join(root, "README.md"), "dirty\n");
    const first = await prepareSourceArchive(args, { cwd: root });
    const bytes = readFileSync(first.archive);
    expect(path.basename(first.archive)).toBe("linger-v1.0.0.tar.gz");
    expect(first.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(readFileSync(`${first.archive}.sha256`, "utf8")).toBe(
      `${first.sha256}  linger-v1.0.0.tar.gz\n`,
    );
    expect(
      execFileSync("tar", ["-tzf", first.archive], { encoding: "utf8" })
        .trim()
        .split("\n")
        .sort(),
    ).toEqual([
      "linger-v1.0.0/",
      "linger-v1.0.0/README.md",
      "linger-v1.0.0/scripts/",
      "linger-v1.0.0/scripts/source-native.mjs",
    ]);
    expect(
      execFileSync("tar", ["-xzOf", first.archive, "linger-v1.0.0/README.md"], {
        encoding: "utf8",
      }),
    ).toBe("linger\n");

    const second = await prepareSourceArchive(args, { cwd: root });
    expect(second.sha256).toBe(first.sha256);
    expect(await sourceArchiveEnvironment(output)).toEqual({
      LINGER_SOURCE_ARCHIVE_URL:
        "https://github.com/simplexai-labs/linger/releases/download/v1.0.0/linger-v1.0.0.tar.gz",
      LINGER_SOURCE_ARCHIVE_SHA256: first.sha256,
    });
  });

  it("names a non-tag ref after its commit", async () => {
    const root = repository();
    const result = await prepareSourceArchive(
      ["--output", path.join(root, "out")],
      { cwd: root },
    );
    expect(path.basename(result.archive)).toBe(
      `linger-${result.commit.slice(0, 12)}.tar.gz`,
    );
  });

  it("refuses a ref without the native source entry", async () => {
    const root = repository();
    git(root, "rm", "-q", "scripts/source-native.mjs");
    git(root, "commit", "-q", "-m", "drop");
    await expect(
      prepareSourceArchive(["--output", path.join(root, "out")], { cwd: root }),
    ).rejects.toThrow(/no scripts\/source-native\.mjs/);
  });

  it("validates its arguments", () => {
    expect(() => parseSourceArchiveArguments(["--tag", "x"])).toThrow(
      /Unknown/,
    );
    expect(() =>
      parseSourceArchiveArguments(["--url-base", "http://example.com"]),
    ).toThrow(/https/);
    expect(() => parseSourceArchiveArguments(["--label", "../x"])).toThrow(
      /plain file name/,
    );
  });
});
