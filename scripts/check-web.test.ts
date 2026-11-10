import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const concurrentlyCli = join(
  dirname(require.resolve("concurrently/package.json")),
  "dist/bin/index.js",
);

it.each(["none", "types", "lint", "tests", "doctor"])(
  "runs every Web check concurrently and preserves the %s failure",
  async (failure) => {
    const root = await mkdtemp(join(tmpdir(), "check-web-"));
    try {
      await writeFile(
        join(root, "pnpm"),
        `#!${process.execPath}
const fs = require("node:fs");
const cp = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "exec" && args[1] === "concurrently") {
  const child = cp.spawnSync(process.execPath, [${JSON.stringify(concurrentlyCli)}, ...args.slice(2)], { stdio: "inherit" });
  process.exit(child.status ?? 1);
}
const check = args.includes("typecheck") ? "types" : args.includes("lint") ? "lint" : args.includes("test") ? "tests" : args.includes("react:doctor") ? "doctor" : undefined;
if (!check) process.exit(99);
const root = process.env.CHECK_WEB_PROBE;
fs.writeFileSync(root + "/" + check + ".started", "");
const deadline = Date.now() + 5000;
const timer = setInterval(() => {
  if (!["types", "lint", "tests", "doctor"].every(name => fs.existsSync(root + "/" + name + ".started"))) {
    if (Date.now() > deadline) process.exit(98);
    return;
  }
  clearInterval(timer);
  setTimeout(() => {
    fs.writeFileSync(root + "/" + check + ".finished", "");
    process.exit(process.env.CHECK_WEB_FAILURE === check ? 23 : 0);
  }, check === process.env.CHECK_WEB_FAILURE ? 0 : 100);
}, 10);
`,
        { mode: 0o755 },
      );
      const result = await execFileAsync(
        "make",
        ["-f", resolve("Makefile"), "check-web"],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            PATH: `${root}:${process.env.PATH}`,
            CHECK_WEB_PROBE: root,
            CHECK_WEB_FAILURE: failure,
          },
          timeout: 8000,
        },
      ).then(
        () => 0,
        () => 1,
      );
      expect(result).toBe(failure === "none" ? 0 : 1);
      for (const check of ["types", "lint", "tests", "doctor"]) {
        expect(await readFile(join(root, `${check}.finished`), "utf8")).toBe(
          "",
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  10_000,
);
