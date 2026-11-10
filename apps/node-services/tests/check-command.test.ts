import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const concurrentlyCli = join(
  dirname(require.resolve("concurrently/package.json")),
  "dist/bin/index.js",
);

it.each(["none", "typecheck", "lint", "test"])(
  "joins both static checks before tests and propagates %s failure",
  async (failure) => {
    const root = await mkdtemp(join(tmpdir(), "node-services-check-"));
    const { scripts } = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts: { check: string };
    };
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
const task = args[0];
const root = process.env.CHECK_PROBE;
if (!["typecheck", "lint", "test"].includes(task)) process.exit(99);
fs.writeFileSync(root + "/" + task + ".started", "");
if (task === "test") {
  if (!["typecheck", "lint"].every(name => fs.existsSync(root + "/" + name + ".finished"))) process.exit(97);
  fs.writeFileSync(root + "/test.finished", "");
  process.exit(process.env.CHECK_FAILURE === task ? 23 : 0);
}
const deadline = Date.now() + 3000;
const timer = setInterval(() => {
  if (!["typecheck", "lint"].every(name => fs.existsSync(root + "/" + name + ".started"))) {
    if (Date.now() > deadline) process.exit(98);
    return;
  }
  clearInterval(timer);
  setTimeout(() => {
    fs.writeFileSync(root + "/" + task + ".finished", "");
    process.exit(process.env.CHECK_FAILURE === task ? 23 : 0);
  }, process.env.CHECK_FAILURE === task ? 0 : 100);
}, 10);
`,
        { mode: 0o755 },
      );
      const result = await execFileAsync("/bin/sh", ["-c", scripts.check], {
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH}`,
          CHECK_PROBE: root,
          CHECK_FAILURE: failure,
        },
        timeout: 8_000,
      }).then(
        () => 0,
        () => 1,
      );
      expect(result).toBe(failure === "none" ? 0 : 1);
      const files = await readdir(root);
      expect(files).toContain("typecheck.finished");
      expect(files).toContain("lint.finished");
      expect(files.includes("test.started")).toBe(
        ["none", "test"].includes(failure),
      );
      if (["none", "test"].includes(failure))
        expect(files).toContain("test.finished");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  10_000,
);
