import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const gate = join(process.cwd(), "scripts/ci/check-repository-gate.sh");
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => name !== "BASE"),
);

interface GateOptions {
  changedPath?: string;
  // Delete this base file in the head commit.
  deletedPath?: string;
  // Pass a target branch that moved past the merge base, as a local run does.
  advancedTarget?: boolean;
}

// Runs the gate in a temporary repository whose pnpm and make are stubs that
// record every invocation, so the tests observe the sequence of gate steps.
function runGate(options: GateOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "repository-gate-"));
  const bin = join(root, "bin");
  const log = join(root, "commands.log");
  try {
    mkdirSync(bin);
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: root,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.invalid",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.invalid",
        },
        encoding: "utf8",
      }).trim();
    git("init", "-q");
    if (options.deletedPath) {
      mkdirSync(join(root, options.deletedPath, ".."), { recursive: true });
      writeFileSync(join(root, options.deletedPath), "retired\n");
      git("add", ".");
    }
    git("commit", "-q", "--allow-empty", "-m", "base");
    const base = git("rev-parse", "HEAD");
    if (options.deletedPath) git("rm", "-q", options.deletedPath);
    const changed = options.changedPath ?? "apps/web/src/example.ts";
    mkdirSync(join(root, changed, ".."), { recursive: true });
    writeFileSync(join(root, changed), "export {};\n");
    git("add", ".");
    git("commit", "-q", "-m", "head");
    const head = git("rev-parse", "HEAD");
    let baseInput = base;
    if (options.advancedTarget) {
      git("branch", "team/fat", base);
      git("checkout", "-q", "team/fat");
      writeFileSync(join(root, "upstream.txt"), "upstream\n");
      git("add", ".");
      git("commit", "-q", "-m", "upstream");
      git("checkout", "-q", head);
      baseInput = "team/fat";
    }

    writeFileSync(
      join(bin, "pnpm"),
      `#!/usr/bin/env bash
printf 'pnpm %s\\n' "$*" >> "$COMMAND_LOG"
exit 0
`,
    );
    writeFileSync(
      join(bin, "make"),
      `#!/usr/bin/env bash
printf 'make %s\\n' "$*" >> "$COMMAND_LOG"
printf '%s\\n' "\${BASE:-unset}" >>"$COMMAND_LOG.base"
exit 0
`,
    );
    for (const command of ["pnpm", "make"])
      chmodSync(join(bin, command), 0o755);

    const result = spawnSync("bash", [gate], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...cleanEnv,
        PATH: `${bin}:${process.env.PATH}`,
        COMMAND_LOG: log,
        BASE: baseInput,
      },
    });
    // A failing step can exit before any stub runs, so the log may not exist.
    const commands = existsSync(log)
      ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
      : [];
    const makeBaseEnvironment = existsSync(`${log}.base`)
      ? readFileSync(`${log}.base`, "utf8").trim().split("\n")
      : [];
    return { ...result, commands, base, makeBaseEnvironment };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Each case creates a real git fixture and spawns bash processes, so it gets the
// process-test budget rather than the unit default.
describe("local repository gate", { timeout: 60_000 }, () => {
  it("requires BASE and prints a usage message", () => {
    const result = spawnSync("bash", [gate], {
      encoding: "utf8",
      env: { ...cleanEnv, BASE: "" },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Usage: BASE=<target-ref>");
  });

  it("runs commitlint, the env inventory, changed-file format and lint, and the repository checks", () => {
    const result = runGate();
    expect(result.status).toBe(0);
    expect(result.commands).toEqual([
      expect.stringMatching(/^pnpm exec commitlint --from \S+ --to \S+/),
      "pnpm env:inventory:check",
      "pnpm exec prettier --check apps/web/src/example.ts",
      "pnpm exec eslint apps/web/src/example.ts",
      "make check-scripts-fast check-docs",
    ]);
  });

  it("formats and lints only existing changed files outside published Skill versions", () => {
    const skill = runGate({
      changedPath: "skills/builtin/example/1.0.0/scripts/run.js",
    });
    expect(skill.status).toBe(0);
    expect(skill.commands.some((line) => line.includes("prettier"))).toBe(
      false,
    );

    const deleted = runGate({
      deletedPath: "retired/old.ts",
      changedPath: "docs/note.md",
    });
    expect(deleted.status).toBe(0);
    expect(deleted.commands).toContain(
      "pnpm exec prettier --check docs/note.md",
    );
    expect(deleted.commands.some((line) => line.includes("eslint"))).toBe(
      false,
    );
  });

  it("checks migration history only when migration SQL changed", () => {
    const unchanged = runGate();
    expect(unchanged.stderr).not.toContain("migration");

    // The fixture repository has no migration checker, so the step fails.
    const changed = runGate({
      changedPath: "apps/teamhub/migrations/00999_example.sql",
    });
    expect(changed.status).not.toBe(0);
    expect(changed.commands).toEqual([]);
  });

  it("keeps BASE out of the make environment", () => {
    const result = runGate();
    expect(result.status).toBe(0);
    expect(result.makeBaseEnvironment.length).toBeGreaterThan(0);
    expect(result.makeBaseEnvironment).toEqual(
      result.makeBaseEnvironment.map(() => "unset"),
    );
  });

  it("diffs from the merge base when the target ref moved ahead", () => {
    const result = runGate({ advancedTarget: true });
    expect(result.status).toBe(0);
    expect(result.commands.at(-1)).toBe("make check-scripts-fast check-docs");
    expect(result.commands[0]).toContain(`--from ${result.base} `);
  });
});
