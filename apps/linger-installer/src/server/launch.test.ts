import { expect, test, afterEach } from "vitest";
import {
  mkdtemp,
  rm,
  readFile,
  stat,
  mkdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { launchInstaller } from "./launch.js";
const clean: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const fn of clean.splice(0).reverse()) await fn();
});
test("launcher passes only owner-private local HTML path to opener and removes file after exchange", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "installer-launch-"));
  clean.push(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, "web"));
  await writeFile(path.join(home, "web/index.html"), "offline");
  let opened = "";
  const server = await launchInstaller({
    home,
    sourceRepo: home,
    webDir: path.join(home, "web"),
    open: async (target) => {
      opened = target;
    },
  });
  clean.push(server.close);
  expect(opened).toBe(path.join(home, "installer", "launch.html"));
  expect((await stat(opened)).mode & 0o777).toBe(0o600);
  const html = await readFile(opened, "utf8");
  expect(html).toContain("#token=");
  expect(html).toContain('lang="en"');
  expect(html).toContain("Open Linger installer");
  expect(opened).not.toContain(server.bootstrapToken);
  expect(
    (
      await fetch(server.origin + "/api/session", {
        method: "POST",
        headers: { Origin: server.origin, "Content-Type": "application/json" },
        body: JSON.stringify({ token: server.bootstrapToken }),
      })
    ).status,
  ).toBe(200);
  await expect(stat(opened)).rejects.toHaveProperty("code", "ENOENT");
});

test("reopening mints fresh browser bootstrap and preserves existing manager and running job", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "installer-reopen-"));
  clean.push(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, "web"));
  await writeFile(path.join(home, "web/index.html"), "offline");
  let release!: () => void;
  let runs = 0;
  const opened: string[] = [];
  const options = {
    home,
    sourceRepo: home,
    webDir: path.join(home, "web"),
    open: async (file: string) => {
      opened.push(file);
    },
    dependencies: {
      run: async (
        _input: unknown,
        signal: AbortSignal,
        emit: (event: {
          kind: "stage";
          stage: "images";
          state: "running";
          message: string;
        }) => void,
      ) => {
        runs++;
        emit({
          kind: "stage",
          stage: "images",
          state: "running",
          message: "Preparing resources",
        });
        await new Promise<void>((resolve) => {
          release = resolve;
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { state: "ready", code: 0, message: "Complete" };
      },
    },
  };
  const first = await launchInstaller(options);
  clean.push(first.close);
  const session = await fetch(`${first.origin}/api/session`, {
    method: "POST",
    headers: { Origin: first.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ token: first.bootstrapToken }),
  });
  const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
  const job = await (
    await fetch(`${first.origin}/api/jobs`, {
      method: "POST",
      headers: {
        Origin: first.origin,
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify({ instance: "default" }),
    })
  ).json();
  const second = await launchInstaller(options);
  expect(second.reused).toBe(true);
  expect(second.origin).toBe(first.origin);
  await second.closed;
  await second.close();
  const html = await readFile(opened.at(-1)!, "utf8");
  const token = html.match(/#token=([A-Za-z0-9_-]+)/)?.[1];
  expect(Boolean(token) && token !== first.bootstrapToken).toBe(true);
  const fresh = await fetch(`${first.origin}/api/session`, {
    method: "POST",
    headers: { Origin: first.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  expect(fresh.status).toBe(200);
  expect(
    (
      await fetch(`${first.origin}/api/session`, {
        method: "POST",
        headers: { Origin: first.origin, "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      })
    ).status,
  ).toBe(401);
  const freshCookie = fresh.headers.get("set-cookie")!.split(";")[0]!;
  const current = await (
    await fetch(`${first.origin}/api/jobs/${job.id}`, {
      headers: { Cookie: freshCookie },
    })
  ).json();
  expect(current.id).toBe(job.id);
  expect(current.state).toBe("running");
  expect(runs).toBe(1);
  expect(
    (await fetch(`${first.origin}/api/jobs`, { headers: { Cookie: cookie } }))
      .status,
  ).toBe(200);
  release();
});

test("reopen requires a separate private control capability and refuses non-private metadata", async () => {
  const { chmod } = await import("node:fs/promises");
  const home = await mkdtemp(path.join(tmpdir(), "installer-reopen-security-"));
  clean.push(() => rm(home, { recursive: true, force: true }));
  const options = { home, sourceRepo: home, noOpen: true };
  const first = await launchInstaller(options);
  clean.push(first.close);
  const denied = await fetch(`${first.origin}/api/reopen`, {
    method: "POST",
    headers: { Origin: first.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ token: "invalid" }),
  });
  expect(denied.status).toBe(401);
  const file = path.join(home, "installer/session.json");
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  await chmod(file, 0o644);
  let refused = false;
  try {
    await launchInstaller(options);
  } catch {
    refused = true;
  }
  expect(refused).toBe(true);
});

test("browser opener failure preserves a reachable installer and private launcher", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "installer-headless-"));
  clean.push(() => rm(home, { recursive: true, force: true }));
  const server = await launchInstaller({
    home,
    sourceRepo: home,
    open: async () => {
      throw new Error("xdg-open unavailable");
    },
  });
  clean.push(server.close);
  expect((await fetch(server.origin)).status).toBeLessThan(500);
  expect(
    (await stat(path.join(home, "installer/launch.html"))).mode & 0o777,
  ).toBe(0o600);
  const reopened = await launchInstaller({
    home,
    sourceRepo: home,
    open: async () => {
      throw new Error("no browser");
    },
  });
  expect(reopened.reused).toBe(true);
});

test("source launch keeps its trusted instance and refuses a different manager context", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "installer-source-context-"));
  clean.push(() => rm(home, { recursive: true, force: true }));
  const options = {
    home,
    sourceRepo: "/checkout-one",
    instanceName: "source-dev",
    noOpen: true,
  };
  const first = await launchInstaller(options);
  clean.push(first.close);
  const session = await fetch(`${first.origin}/api/session`, {
    method: "POST",
    headers: { Origin: first.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ token: first.bootstrapToken }),
  });
  const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
  const config = await (
    await fetch(`${first.origin}/api/config`, { headers: { Cookie: cookie } })
  ).json();
  expect(config).toMatchObject({
    instance: "source-dev",
    releaseAvailable: true,
  });
  const injection = await fetch(`${first.origin}/api/jobs`, {
    method: "POST",
    headers: {
      Origin: first.origin,
      "Content-Type": "application/json",
      Cookie: cookie,
    },
    body: JSON.stringify({
      instance: "source-dev",
      sourceRepo: "/attacker-checkout",
    }),
  });
  expect(injection.status).toBe(400);
  const engineInjection = await fetch(`${first.origin}/api/jobs`, {
    method: "POST",
    headers: {
      Origin: first.origin,
      "Content-Type": "application/json",
      Cookie: cookie,
    },
    body: JSON.stringify({ instance: "source-dev", sourceEngine: "docker" }),
  });
  expect(engineInjection.status).toBe(400);

  await expect(
    launchInstaller({ ...options, sourceRepo: "/checkout-two" }),
  ).rejects.toThrow();
  await expect(
    launchInstaller({ ...options, instanceName: "other" }),
  ).rejects.toThrow();
  await expect(
    launchInstaller({ home, sourceRepo: home, noOpen: true }),
  ).rejects.toThrow();
  expect((await launchInstaller(options)).reused).toBe(true);
});

test("a desktop-owned idle manager steps aside for the next bundled checkout", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "installer-upgrade-"));
  clean.push(() => rm(home, { recursive: true, force: true }));
  const options = {
    home,
    sourceRepo: "/source/one",
    externalComputer: true,
    instanceName: "desktop",
    noOpen: true,
  };
  const first = await launchInstaller(options);
  clean.push(first.close);
  const denied = await fetch(`${first.origin}/api/retire`, {
    method: "POST",
    headers: { Origin: first.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ token: "invalid" }),
  });
  expect(denied.status).toBe(401);
  await expect(
    launchInstaller({ ...options, externalComputer: false }),
  ).rejects.toThrow();
  const next = await launchInstaller({ ...options, sourceRepo: "/source/two" });
  clean.push(next.close);
  expect(next.reused).toBe(false);
  await first.closed;
  const metadata = JSON.parse(
    await readFile(path.join(home, "installer/session.json"), "utf8"),
  );
  expect(metadata.sourceRepo).toBe("/source/two");
});

test("after a failed attempt the desktop's next launch replaces the idle manager", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "installer-engine-switch-"));
  clean.push(() => rm(home, { recursive: true, force: true }));
  let release!: () => void;
  const options = {
    home,
    sourceRepo: "/source/one",
    externalComputer: true,
    instanceName: "desktop",
    noOpen: true,
    dependencies: {
      run: async (_input: unknown, signal: AbortSignal) => {
        await new Promise<void>((resolve) => {
          release = resolve;
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { state: "failed", code: 1, message: "No PostgreSQL" };
      },
    },
  };
  const native = await launchInstaller(options);
  clean.push(native.close);
  const session = await fetch(`${native.origin}/api/session`, {
    method: "POST",
    headers: { Origin: native.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ token: native.bootstrapToken }),
  });
  const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
  const job = await (
    await fetch(`${native.origin}/api/jobs`, {
      method: "POST",
      headers: {
        Origin: native.origin,
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify({ instance: "desktop" }),
    })
  ).json();
  // A running job is never interrupted, and the reason says so.
  await expect(
    launchInstaller({ ...options, sourceRepo: "/source/two" }),
  ).rejects.toMatchObject({
    code: "INSTALLER_BUSY",
    message:
      "An earlier installation is still running. Wait for it to finish or cancel it, then try again.",
  });
  release();
  for (;;) {
    const current = await (
      await fetch(`${native.origin}/api/jobs/${job.id}`, {
        headers: { Cookie: cookie },
      })
    ).json();
    if (current.state === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const next = await launchInstaller({ ...options, sourceRepo: "/source/two" });
  clean.push(next.close);
  expect(next.reused).toBe(false);
  await native.closed;
  const metadata = JSON.parse(
    await readFile(path.join(home, "installer/session.json"), "utf8"),
  );
  expect(metadata.sourceRepo).toBe("/source/two");
});
