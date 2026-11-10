import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RuntimeLoginManager } from "./runtime-login.js";
vi.mock("@linger/local-installation/managed-codex", () => ({
  managedRuntimeEnvironment: async () => ({}),
}));
const clean: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of clean.splice(0).reverse()) await fn();
});
it(
  "starts the native login once, exposes only official authentication hints and checks completion",
  { timeout: 15000 },
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), "runtime-signin-"));
    clean.push(() => rm(home, { recursive: true, force: true }));
    const exe = path.join(home, "codex");
    await writeFile(
      exe,
      `#!${process.execPath}\nif(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['login','--device-auth']))process.exit(2);console.log('https://auth.openai.com/codex/device');console.log('ABCD-EFGHI');console.log('SECRET-NEVER-RETURN');setTimeout(()=>process.exit(0),5000);`,
      { mode: 0o700 },
    );
    let ready = false;
    const manager = new RuntimeLoginManager(
      async () => ({
        runtime: "codex",
        executable: exe,
        installed: true,
        ready,
        loginCommand: "unused",
        descriptor: {
          runtime: "codex",
          executable: exe,
          argvPrefix: [],
          installed: true,
          authenticated: false,
          authMode: null,
          loginCommand: { executable: exe, args: ["login"], env: {} },
          deviceLoginCommand: {
            executable: exe,
            args: ["login", "--device-auth"],
            env: {},
          },
        },
      }),
      "linux",
    );
    clean.push(async () => manager.close());
    const input = {
      instance: "default",
      home,
      root: home,
      runtime: "codex" as const,
    };
    await manager.start(input);
    await expect
      .poll(async () => (await manager.status(input)).deviceCode, {
        timeout: 5000,
      })
      .toBe("ABCD-EFGHI");
    expect(JSON.stringify(await manager.status(input))).not.toContain(
      "SECRET-NEVER-RETURN",
    );
    ready = true;
    await expect
      .poll(async () => (await manager.status(input)).state, { timeout: 5000 })
      .toBe("ready");
    expect((await manager.start(input)).state).toBe("ready");
  },
);
it(
  "does not trust arbitrary URLs in native output",
  { timeout: 15000 },
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), "runtime-untrusted-"));
    clean.push(() => rm(home, { recursive: true, force: true }));
    const exe = path.join(home, "claude");
    await writeFile(
      exe,
      `#!${process.execPath}\nconsole.log('https://attacker.invalid/auth?token=secret');process.exit(1)`,
      { mode: 0o700 },
    );
    const manager = new RuntimeLoginManager(async () => ({
      runtime: "claude",
      executable: exe,
      installed: true,
      ready: false,
      loginCommand: "unused",
      descriptor: {
        runtime: "claude",
        executable: exe,
        argvPrefix: [],
        installed: true,
        authenticated: false,
        authMode: null,
        loginCommand: { executable: exe, args: ["auth", "login"], env: {} },
        deviceLoginCommand: {
          executable: exe,
          args: ["login", "--device-auth"],
          env: {},
        },
      },
    }));
    clean.push(async () => manager.close());
    const input = {
      instance: "default",
      home,
      root: home,
      runtime: "claude" as const,
    };
    await manager.start(input);
    await expect
      .poll(async () => (await manager.status(input)).state, { timeout: 5000 })
      .toBe("failed");
    expect((await manager.status(input)).url).toBeUndefined();
  },
);

it(
  "accepts the authorization route emitted by pinned Claude 2.1.310",
  { timeout: 15000 },
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), "runtime-claude-current-"));
    clean.push(() => rm(home, { recursive: true, force: true }));
    const exe = path.join(home, "claude");
    const url =
      "https://claude.com/cai/oauth/authorize?code=true&state=fixture";
    await writeFile(
      exe,
      `#!${process.execPath}\nconsole.log(${JSON.stringify(url)});setTimeout(()=>{},5000);`,
      { mode: 0o700 },
    );
    const manager = new RuntimeLoginManager(async () => ({
      runtime: "claude",
      executable: exe,
      installed: true,
      ready: false,
      loginCommand: "unused",
      descriptor: {
        runtime: "claude",
        executable: exe,
        argvPrefix: [],
        installed: true,
        authenticated: false,
        authMode: null,
        loginCommand: { executable: exe, args: ["auth", "login"], env: {} },
        deviceLoginCommand: {
          executable: exe,
          args: ["login", "--device-auth"],
          env: {},
        },
      },
    }));
    clean.push(async () => manager.close());
    const input = {
      instance: "default",
      home,
      root: home,
      runtime: "claude" as const,
    };
    await manager.start(input);
    await expect
      .poll(async () => (await manager.status(input)).url, { timeout: 5000 })
      .toBe(url);
    expect((await manager.status(input)).acceptsCode).toBe(true);
  },
);

it("uses native browser OAuth on Mac instead of requiring device-code settings", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "runtime-mac-oauth-"));
  clean.push(() => rm(home, { recursive: true, force: true }));
  const exe = path.join(home, "codex");
  const url =
    "https://auth.openai.com/oauth/authorize?response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=fixture";
  await writeFile(
    exe,
    `#!${process.execPath}\nif(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['login']))process.exit(2);console.log(${JSON.stringify(url)});setTimeout(()=>{},5000);`,
    { mode: 0o700 },
  );
  const manager = new RuntimeLoginManager(
    async () => ({
      runtime: "codex",
      executable: exe,
      installed: true,
      ready: false,
      loginCommand: "unused",
      descriptor: {
        runtime: "codex",
        executable: exe,
        argvPrefix: [],
        installed: true,
        authenticated: false,
        authMode: null,
        loginCommand: { executable: exe, args: ["login"], env: {} },
        deviceLoginCommand: {
          executable: exe,
          args: ["login", "--device-auth"],
          env: {},
        },
      },
    }),
    "darwin",
  );
  clean.push(async () => manager.close());
  const input = {
    instance: "default",
    home,
    root: home,
    runtime: "codex" as const,
  };
  await manager.start(input);
  await expect
    .poll(async () => (await manager.status(input)).url, { timeout: 5000 })
    .toBe(url);
  expect((await manager.status(input)).deviceCode).toBeUndefined();
}, 10000);

it("uses browser OAuth on native Windows", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "runtime-windows-oauth-"));
  clean.push(() => rm(home, { recursive: true, force: true }));
  const exe = path.join(home, "codex");
  const url =
    "https://auth.openai.com/oauth/authorize?response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=fixture";
  await writeFile(
    exe,
    `#!${process.execPath}\nif(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['login']))process.exit(2);console.log(${JSON.stringify(url)});setTimeout(()=>{},5000);`,
    { mode: 0o700 },
  );
  const manager = new RuntimeLoginManager(
    async () => ({
      runtime: "codex",
      executable: exe,
      installed: true,
      ready: false,
      loginCommand: "unused",
      descriptor: {
        runtime: "codex",
        executable: exe,
        argvPrefix: [],
        installed: true,
        authenticated: false,
        authMode: null,
        loginCommand: { executable: exe, args: ["login"], env: {} },
        deviceLoginCommand: {
          executable: exe,
          args: ["login", "--device-auth"],
          env: {},
        },
      },
    }),
    "win32",
  );
  clean.push(async () => manager.close());
  const input = {
    instance: "default",
    home,
    root: home,
    runtime: "codex" as const,
  };
  await manager.start(input);
  await expect
    .poll(async () => (await manager.status(input)).url, { timeout: 5000 })
    .toBe(url);
  expect((await manager.status(input)).deviceCode).toBeUndefined();
}, 10000);

it("does not expose a browser OAuth URL with a non-local callback", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "runtime-unsafe-callback-"));
  clean.push(() => rm(home, { recursive: true, force: true }));
  const exe = path.join(home, "codex");
  await writeFile(
    exe,
    `#!${process.execPath}\nconsole.log('https://auth.openai.com/oauth/authorize?redirect_uri=https%3A%2F%2Fattacker.invalid%2Fauth%2Fcallback');setTimeout(()=>process.exit(1),100);`,
    { mode: 0o700 },
  );
  const manager = new RuntimeLoginManager(
    async () => ({
      runtime: "codex",
      executable: exe,
      installed: true,
      ready: false,
      loginCommand: "unused",
      descriptor: {
        runtime: "codex",
        executable: exe,
        argvPrefix: [],
        installed: true,
        authenticated: false,
        authMode: null,
        loginCommand: { executable: exe, args: ["login"], env: {} },
        deviceLoginCommand: {
          executable: exe,
          args: ["login", "--device-auth"],
          env: {},
        },
      },
    }),
    "darwin",
  );
  clean.push(async () => manager.close());
  const input = {
    instance: "default",
    home,
    root: home,
    runtime: "codex" as const,
  };
  await manager.start(input);
  await expect
    .poll(async () => (await manager.status(input)).state, { timeout: 5000 })
    .toBe("failed");
  expect((await manager.status(input)).url).toBeUndefined();
});

it("lets native OAuth finish the browser callback after credentials become ready", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "runtime-callback-drain-"));
  clean.push(() => rm(home, { recursive: true, force: true }));
  const exe = path.join(home, "codex"),
    marker = path.join(home, "ready"),
    portFile = path.join(home, "port"),
    release = path.join(home, "release");
  await writeFile(
    exe,
    `#!${process.execPath}\nconst http=require('node:http'),fs=require('node:fs');const s=http.createServer((req,res)=>{fs.writeFileSync(${JSON.stringify(marker)},'ready');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);res.end('Signed in to Codex');s.close(()=>process.exit(0));}},10);});s.listen(0,'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(portFile)},String(s.address().port)));`,
    { mode: 0o700 },
  );
  const manager = new RuntimeLoginManager(
    async () => ({
      runtime: "codex",
      executable: exe,
      installed: true,
      ready: await access(marker).then(
        () => true,
        () => false,
      ),
      loginCommand: "unused",
      descriptor: {
        runtime: "codex",
        executable: exe,
        argvPrefix: [],
        installed: true,
        authenticated: false,
        authMode: null,
        loginCommand: { executable: exe, args: ["login"], env: {} },
        deviceLoginCommand: {
          executable: exe,
          args: ["login", "--device-auth"],
          env: {},
        },
      },
    }),
    "darwin",
  );
  clean.push(async () => manager.close());
  const input = {
    instance: "default",
    home,
    root: home,
    runtime: "codex" as const,
  };
  await manager.start(input);
  // The native child may start while both app gates and a source Docker build contend for CPU.
  await expect
    .poll(() => readFile(portFile, "utf8"), { timeout: 5000 })
    .toMatch(/^\d+$/);
  const response = fetch(
    `http://127.0.0.1:${await readFile(portFile, "utf8")}/callback`,
  ).then((r) => r.text());
  // Observe the readiness write while the browser response is still in flight.
  await expect
    .poll(async () => (await manager.status(input)).state, {
      interval: 20,
      timeout: 5000,
    })
    .toBe("ready");
  await writeFile(release, "finish browser response");
  expect(await response).toBe("Signed in to Codex");
}, 10000);
it(
  "cancel stops the native login and forgets it",
  { timeout: 15000 },
  async () => {
    const home = await mkdtemp(path.join(tmpdir(), "runtime-cancel-"));
    clean.push(() => rm(home, { recursive: true, force: true }));
    const exe = path.join(home, "claude");
    const pidFile = path.join(home, "pid");
    await writeFile(
      exe,
      `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));console.log('https://claude.com/cai/oauth/authorize?state=x');setInterval(()=>{},1000);`,
      { mode: 0o700 },
    );
    const manager = new RuntimeLoginManager(async () => ({
      runtime: "claude",
      executable: exe,
      installed: true,
      ready: false,
      loginCommand: "unused",
      descriptor: {
        runtime: "claude",
        executable: exe,
        argvPrefix: [],
        installed: true,
        authenticated: false,
        authMode: null,
        loginCommand: { executable: exe, args: ["auth", "login"], env: {} },
      },
    }));
    clean.push(async () => manager.close());
    const input = {
      instance: "default",
      home,
      root: home,
      runtime: "claude" as const,
    };
    await manager.start(input);
    await expect
      .poll(async () => (await manager.status(input)).state, { timeout: 5000 })
      .toBe("waiting_user");
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(manager.cancel("default")).toEqual({ state: "idle" });
    expect(await manager.status(input)).toEqual({ state: "idle" });
    await expect
      .poll(
        () => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 5000 },
      )
      .toBe(false);
  },
);
