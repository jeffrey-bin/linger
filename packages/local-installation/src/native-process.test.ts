import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const failure = vi.hoisted(() => ({ file: "" }));
vi.mock("./instance.js", async (original) => {
  const actual = await original<typeof import("./instance.js")>();
  return {
    ...actual,
    atomicPrivate: async (file: string, contents: string) => {
      if (file === failure.file) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        throw new Error("fixture persistence failed");
      }
      return actual.atomicPrivate(file, contents);
    },
  };
});
import { afterEach, expect, test, vi } from "vitest";
import {
  startNativeProcess,
  inspectNativeProcess,
  stopNativeProcess,
} from "./native-process.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    for (const name of ["web", "teamhub"] as const)
      await stopNativeProcess(root, name).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "native-process-"));
  roots.push(root);
  return root;
}
/** Gone or a zombie; Linux reads /proc so the check cannot pass when ps is absent. */
function exited(pid: number): boolean {
  try {
    const state =
      process.platform === "linux"
        ? readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "")
        : execFileSync("/bin/ps", ["-p", String(pid), "-o", "stat="], {
            encoding: "utf8",
          });
    return state.trim().startsWith("Z");
  } catch {
    return true;
  }
}
test("retains an owned service after launch and reuses its identity", async () => {
  const root = await fixture();
  const options = {
    root,
    name: "web" as const,
    executable: process.execPath,
    args: [
      "-e",
      "console.log('native fixture ready');setInterval(()=>{},1000)",
    ],
    cwd: root,
    env: process.env,
  };
  const first = await startNativeProcess(options);
  expect(first.running).toBe(true);
  const second = await startNativeProcess(options);
  expect(second.pid).toBe(first.pid);
  expect((await inspectNativeProcess(root, "web")).running).toBe(true);
  await expect
    .poll(async () => readFile(path.join(root, "native/logs/web.log"), "utf8"))
    .toContain("native fixture ready");
  await stopNativeProcess(root, "web");
  expect((await inspectNativeProcess(root, "web")).running).toBe(false);
  expect(
    await readFile(path.join(root, "native/logs/web.log"), "utf8"),
  ).toContain("native fixture ready");
});
test("refuses to signal a PID whose recorded lease differs", async () => {
  const root = await fixture();
  const options = {
    root,
    name: "web" as const,
    executable: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    cwd: root,
    env: process.env,
  };
  const processState = await startNativeProcess(options);
  const file = path.join(root, "native/processes/web.json");
  const original = await readFile(file, "utf8");
  const altered = JSON.parse(original);
  altered.lease = "0".repeat(64);
  await writeFile(file, JSON.stringify(altered), { mode: 0o600 });
  expect((await inspectNativeProcess(root, "web")).running).toBe(false);
  await expect(stopNativeProcess(root, "web")).rejects.toThrow(/identity/i);
  expect(() => process.kill(processState.pid!, 0)).not.toThrow();
  await writeFile(file, original, { mode: 0o600 });
});
test("rejects changed service configuration instead of leaking a duplicate", async () => {
  const root = await fixture();
  const options = {
    root,
    name: "teamhub" as const,
    executable: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    cwd: root,
    env: process.env,
  };
  await startNativeProcess(options);
  await expect(
    startNativeProcess({ ...options, args: ["-e", "process.exit(0)"] }),
  ).rejects.toThrow(/configuration/i);
  // Generated settings, such as a changed user.env, count as configuration.
  await expect(
    startNativeProcess({ ...options, settings: '{"XAI_API_KEY":"new"}' }),
  ).rejects.toThrow(/configuration/i);
});

test("restarts a service whose settings changed, keeps one whose did not", async () => {
  const root = await fixture();
  const options = {
    root,
    name: "teamhub" as const,
    executable: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    cwd: root,
    env: process.env,
    restartOnConfigurationChange: true,
  };
  const first = await startNativeProcess(options);
  expect((await startNativeProcess(options)).pid).toBe(first.pid);
  const second = await startNativeProcess({ ...options, settings: "voice-1" });
  expect(second.pid).not.toBe(first.pid);
  expect(
    (await startNativeProcess({ ...options, settings: "voice-1" })).pid,
  ).toBe(second.pid);
  expect((await startNativeProcess(options)).pid).not.toBe(second.pid);
});
test("redacts complete lines before persisting split writes and known secrets", async () => {
  const root = await fixture();
  await startNativeProcess({
    root,
    name: "web",
    executable: process.execPath,
    args: [
      "-e",
      "process.stdout.write('generated-');setTimeout(()=>console.log('opaque-secret'),40);console.error(process.env.PGPASSWORD);setInterval(()=>{},1000)",
    ],
    cwd: root,
    env: { ...process.env, PGPASSWORD: "bare-private-value" },
    redactions: ["generated-opaque-secret"],
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const log = await readFile(path.join(root, "native/logs/web.log"), "utf8");
  expect(log).not.toContain("generated-");
  expect(log).not.toContain("opaque-secret");
  expect(log).not.toContain("bare-private-value");
  expect(log).toContain("[REDACTED]");
});

test("stops descendants that ignore SIGINT after the service leader exits", async () => {
  const root = await fixture();
  const childCode =
    "process.on('SIGINT',()=>{});console.log('descendant-ready');setInterval(()=>{},1000)";
  await startNativeProcess({
    root,
    name: "web",
    executable: process.execPath,
    args: [
      "-e",
      `const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'inherit'});fs.writeFileSync('descendant.pid',String(c.pid));process.on('SIGINT',()=>process.exit(0));setInterval(()=>{},1000)`,
    ],
    cwd: root,
    env: process.env,
  });
  await expect
    .poll(async () => readFile(path.join(root, "native/logs/web.log"), "utf8"))
    .toContain("descendant-ready");
  const pid = Number(await readFile(path.join(root, "descendant.pid"), "utf8"));
  await stopNativeProcess(root, "web");
  await expect.poll(() => exited(pid)).toBe(true);
}, 20_000);

test("cleans the launched owned group when identity persistence fails", async () => {
  const root = await fixture();
  failure.file = path.join(root, "native/processes/web.json");
  try {
    await expect(
      startNativeProcess({
        root,
        name: "web",
        executable: process.execPath,
        args: [
          "-e",
          "require('node:fs').writeFileSync('launched.pid',String(process.pid));setInterval(()=>{},1000)",
        ],
        cwd: root,
        env: process.env,
      }),
    ).rejects.toThrow("fixture persistence failed");
    const files = await readFile(path.join(root, "launched.pid"), "utf8");
    if (files)
      await expect
        .poll(() => {
          try {
            process.kill(Number(files), 0);
            return false;
          } catch {
            return true;
          }
        })
        .toBe(true);
  } finally {
    failure.file = "";
  }
});

test("bundled entry resolves its packaged worker and survives caller exit", async () => {
  const root = await fixture();
  const app = fileURLToPath(
    new URL("../../../apps/linger-installer/", import.meta.url),
  );
  const { build } = createRequire(path.join(app, "package.json"))(
    "esbuild",
  ) as { build: (options: Record<string, unknown>) => Promise<void> };
  const entry = path.join(root, "entry.mjs");
  await writeFile(
    entry,
    `import {startNativeProcess} from ${JSON.stringify(fileURLToPath(new URL("./native-process.ts", import.meta.url)))};await startNativeProcess({root:${JSON.stringify(root)},name:'web',executable:process.execPath,args:['-e',"console.log('packaged-ready');setInterval(()=>{},1000)"],cwd:${JSON.stringify(root)},env:process.env});`,
  );
  for (const [source, outfile] of [
    [entry, path.join(root, "packaged.mjs")],
    [
      fileURLToPath(new URL("./native-process-worker.mjs", import.meta.url)),
      path.join(root, "native-process-worker.mjs"),
    ],
  ])
    await build({
      entryPoints: [source],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node26",
    });
  const caller = spawn(process.execPath, [path.join(root, "packaged.mjs")], {
    stdio: "ignore",
  });
  expect(await new Promise((resolve) => caller.once("exit", resolve))).toBe(0);
  expect((await inspectNativeProcess(root, "web")).running).toBe(true);
  await expect
    .poll(async () => readFile(path.join(root, "native/logs/web.log"), "utf8"))
    .toContain("packaged-ready");
}, 20_000);

test.each(["ENOSPC", "EIO"])(
  "retains ownership after log writes fail with %s",
  async (code) => {
    const root = await fixture();
    const app = fileURLToPath(
      new URL("../../../apps/linger-installer/", import.meta.url),
    );
    const { build } = createRequire(path.join(app, "package.json"))(
      "esbuild",
    ) as {
      build: (options: Record<string, unknown>) => Promise<void>;
    };
    for (const [source, output] of [
      ["native-process.ts", "core.mjs"],
      ["native-process-worker.mjs", "worker-implementation.mjs"],
    ] as const)
      await build({
        entryPoints: [fileURLToPath(new URL(source, import.meta.url))],
        outfile: path.join(root, output),
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node26",
      });
    // Inject only the OS write error. The supervisor, service, identity checks,
    // detached process group, and shutdown below all run in real processes.
    await writeFile(
      path.join(root, "native-process-worker.mjs"),
      `
    import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    fs.writeSync = () => { throw Object.assign(new Error('fixture I/O failure'), {code: ${JSON.stringify(code)}}); };
    syncBuiltinESMExports();
    await import('./worker-implementation.mjs');
  `,
    );
    const core = (await import(
      path.join(root, "core.mjs")
    )) as typeof import("./native-process.js");
    try {
      const owner = await core.startNativeProcess({
        root,
        name: "web",
        executable: process.execPath,
        cwd: root,
        env: process.env,
        args: [
          "-e",
          "require('node:fs').writeFileSync('service.pid',String(process.pid));setInterval(()=>console.log('token=private-fixture-value'),20)",
        ],
      });
      await expect
        .poll(async () => readFile(path.join(root, "service.pid"), "utf8"))
        .toMatch(/^\d+$/);
      const service = Number(
        await readFile(path.join(root, "service.pid"), "utf8"),
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect((await core.inspectNativeProcess(root, "web")).running).toBe(true);
      expect(() => process.kill(service, 0)).not.toThrow();
      expect(
        await readFile(path.join(root, "native/logs/web.log"), "utf8"),
      ).toBe("");
      await core.stopNativeProcess(root, "web");
      expect((await core.inspectNativeProcess(root, "web")).running).toBe(
        false,
      );
      expect(() => process.kill(owner.pid!, 0)).toThrow();
      expect(() => process.kill(service, 0)).toThrow();
    } finally {
      // A failed assertion must also reclaim the real group on the unfixed code.
      const record = await readFile(
        path.join(root, "native/processes/web.json"),
        "utf8",
      ).catch(() => "");
      if (record) {
        try {
          process.kill(-JSON.parse(record).pid, "SIGKILL");
        } catch {
          /* Gone. */
        }
      }
    }
  },
  20_000,
);

test.each([false, true])(
  "stops leased orphan descendants across groups (owner killed: %s)",
  async (killOwner) => {
    const root = await fixture();
    let orphan: number | undefined;
    const unrelated = spawn(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      { detached: true, stdio: "ignore" },
    );
    unrelated.unref();
    try {
      const owner = await startNativeProcess({
        root,
        name: "web",
        executable: process.execPath,
        cwd: root,
        env: process.env,
        args: [
          "-e",
          `
        const {spawn} = require('node:child_process');
        const child = spawn(process.execPath, ['-e', "process.on('SIGINT',()=>{});require('node:fs').writeFileSync('orphan.pid',String(process.pid));setInterval(()=>{},1000)"], {detached:true,stdio:'ignore'});
        child.unref();
      `,
        ],
      });
      await expect
        .poll(async () => readFile(path.join(root, "orphan.pid"), "utf8"))
        .toMatch(/^\d+$/);
      orphan = Number(await readFile(path.join(root, "orphan.pid"), "utf8"));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect((await inspectNativeProcess(root, "web")).running).toBe(true);
      if (killOwner) {
        process.kill(owner.pid!, "SIGKILL");
        await expect
          .poll(async () => (await inspectNativeProcess(root, "web")).running)
          .toBe(false);
      }
      await stopNativeProcess(root, "web");
      expect((await inspectNativeProcess(root, "web")).running).toBe(false);
      await expect.poll(() => exited(orphan!)).toBe(true);
      expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
    } finally {
      unrelated.kill("SIGKILL");
      if (orphan) {
        try {
          process.kill(orphan, "SIGKILL");
        } catch {
          /* Gone. */
        }
      }
    }
  },
  25_000,
);
