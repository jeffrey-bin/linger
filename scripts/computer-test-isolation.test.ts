import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";

const execute = promisify(execFile);
const launcher = resolve("apps/computer/run-test.sh");
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "computer-test-isolation-"));
  await executable("uname", 'console.log("Linux")');
});
afterEach(() => rm(directory, { recursive: true, force: true }));

function executable(name: string, source: string) {
  return writeFile(
    join(directory, name),
    `#!${process.execPath}\n${source}\n`,
    {
      mode: 0o755,
    },
  );
}

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  return execute("/bin/bash", [launcher, ...args], {
    cwd: directory,
    env: {
      ...process.env,
      PATH: directory,
      CI: "",
      COMPUTER_TEST_ISOLATION: "auto",
      ...env,
    },
  }).catch((error) => error);
}

it.each([
  { mode: "off", platform: "Linux", ci: "" },
  { mode: "auto", platform: "Linux", ci: "true" },
  { mode: "auto", platform: "Darwin", ci: "" },
])("preserves direct execution: %j", async ({ mode, platform, ci }) => {
  await executable("uname", `console.log(${JSON.stringify(platform)})`);
  const result = await run(
    [
      process.execPath,
      "-e",
      "console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(1)}));process.exit(29)",
      "space and $(not-a-command)",
    ],
    { CI: ci, COMPUTER_TEST_ISOLATION: mode },
  );
  expect(result.code).toBe(29);
  expect(JSON.parse(result.stdout)).toEqual({
    cwd: directory,
    args: ["space and $(not-a-command)"],
  });
});

it("fails clearly when local Linux isolation prerequisites are missing", async () => {
  const result = await run([process.execPath, "-e", "process.exit(0)"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("unshare");
  expect(result.stderr).toContain("COMPUTER_TEST_ISOLATION=off");
});

it("does not retry on the host when namespace creation fails", async () => {
  for (const name of ["unshare", "tini"])
    await executable(name, "process.exit(73)");
  const marker = join(directory, "must-not-run");
  const result = await run(
    [
      process.execPath,
      "-e",
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`,
    ],
    { CI: "true", COMPUTER_TEST_ISOLATION: "on" },
  );
  expect(result.code).toBe(73);
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([[], ["true"]])(
  "rejects missing commands or invalid mode: %j",
  async (...args) => {
    const result = await run(args, { COMPUTER_TEST_ISOLATION: "invalid" });
    expect(result.code).toBe(2);
  },
);

// Opt in on Linux with user namespaces and tini; CI needs no elevated privileges.
it
  .runIf(
    process.platform === "linux" &&
      process.env.COMPUTER_TEST_PIDNS_INTEGRATION === "1",
  )
  .each([
    { signal: null, exitCode: 37 },
    { signal: "SIGTERM", exitCode: 143 },
    { signal: "SIGINT", exitCode: 130 },
  ] as const)(
  "isolates /proc and closes the detached descendant after %j",
  async ({ signal, exitCode }) => {
    const hostNamespace = await readlink("/proc/self/ns/pid");
    // The detached descendant reports readiness and keeps the output pipe open.
    // Node's close event therefore proves it exited, without scanning host PIDs.
    const descendant = `
const fs = require('node:fs');
console.log(JSON.stringify({ namespace:fs.readlinkSync('/proc/self/ns/pid'), uid:process.getuid(), outsideNamespace:(() => { try { return fs.readlinkSync('/proc/${process.pid}/ns/pid'); } catch { return null; } })(), cwd:process.cwd() }));
setInterval(() => {}, 1000);
`;
    const program = `
require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { detached:true, stdio:['ignore', 'inherit', 'inherit'] }).unref();
process.stdin.once('data', () => process.exit(37));
setInterval(() => {}, 1000);
`;
    const child = spawn(
      "/bin/bash",
      [launcher, process.execPath, "-e", program],
      {
        cwd: directory,
        env: { ...process.env, COMPUTER_TEST_ISOLATION: "on" },
        detached: true,
        stdio: "pipe",
      },
    );
    let stdout = "",
      stderr = "",
      closed = false;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("close", () => {
      closed = true;
    });
    try {
      await expect
        .poll(
          () => {
            if (closed) throw new Error(`isolation exited: ${stderr}`);
            return stdout;
          },
          { timeout: 5_000 },
        )
        .toContain("\n");
      const data = JSON.parse(stdout);
      expect(data.namespace).not.toBe(hostNamespace);
      expect(data.outsideNamespace).not.toBe(hostNamespace);
      expect(data).toMatchObject({ uid: process.getuid!(), cwd: directory });
      if (signal) child.kill(signal);
      else child.stdin.write("finish\n");
      await expect.poll(() => closed, { timeout: 5_000 }).toBe(true);
      expect(child.exitCode).toBe(exitCode);
    } finally {
      if (!closed) {
        // This test owns a separate process group; killing its unshare launcher
        // also clears the PID namespace if cancellation is broken.
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          /* already exited */
        }
        await expect.poll(() => closed, { timeout: 5_000 }).toBe(true);
      }
    }
  },
  15_000,
);
