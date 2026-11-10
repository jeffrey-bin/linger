import http from "node:http";
import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startInstallerServer } from "./server.js";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "installer-http-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const webDir = path.join(home, "web");
  await mkdir(webDir);
  await writeFile(path.join(webDir, "index.html"), "offline installer");
  const server = await startInstallerServer({ home, sourceRepo: home, webDir });
  cleanup.push(server.close);
  return server;
}
test("serves offline UI independently and rejects missing session, hostile Host and Origin", async () => {
  const s = await setup();
  expect(await (await fetch(s.origin)).text()).toBe("offline installer");
  expect((await fetch(`${s.origin}/api/jobs`)).status).toBe(401);
  expect(
    await new Promise<number>((resolve) =>
      http.get(s.origin, { headers: { Host: "evil.example" } }, (response) => {
        response.resume();
        resolve(response.statusCode!);
      }),
    ),
  ).toBe(403);
  expect(
    (
      await fetch(`${s.origin}/api/session`, {
        method: "POST",
        headers: { Origin: "https://evil.example" },
        body: JSON.stringify({ token: s.bootstrapToken }),
      })
    ).status,
  ).toBe(403);
});
test("one-use bootstrap sets private cookie and cannot be reused", async () => {
  const s = await setup();
  const options = {
    method: "POST",
    headers: { Origin: s.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ token: s.bootstrapToken }),
  };
  const response = await fetch(`${s.origin}/api/session`, options);
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toMatch(
    /HttpOnly; SameSite=Strict/,
  );
  expect((await fetch(`${s.origin}/api/session`, options)).status).toBe(401);
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  expect(
    (await fetch(`${s.origin}/api/jobs`, { headers: { Cookie: cookie } }))
      .status,
  ).toBe(200);
  expect(
    (
      await fetch(`${s.origin}/api/shutdown`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: "https://evil.example" },
      })
    ).status,
  ).toBe(403);
});

test("only one manager may own the installer home at a time", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "installer-singleton-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const first = await startInstallerServer({ home, sourceRepo: home });
  cleanup.push(first.close);
  await expect(
    startInstallerServer({ home, sourceRepo: home }),
  ).rejects.toThrow("installer is already running");
});

test("launcher navigation from a local file loads the public page while cross-site APIs remain blocked", async () => {
  const s = await setup();
  // Node fetch forces sec-fetch-mode=cors; use the browser's actual navigation headers.
  const response = await new Promise<{
    status: number;
    body: string;
    cookie: unknown;
  }>((resolve, reject) => {
    http
      .get(
        s.origin,
        {
          headers: {
            "Sec-Fetch-Site": "cross-site",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Dest": "document",
          },
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () =>
            resolve({
              status: res.statusCode!,
              body,
              cookie: res.headers["set-cookie"],
            }),
          );
        },
      )
      .on("error", reject);
  });
  expect(response.status).toBe(200);
  expect(response.body).toBe("offline installer");
  expect(response.cookie).toBeUndefined();
  expect(
    (
      await fetch(s.origin, {
        headers: { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors" },
      })
    ).status,
  ).toBe(403);
  for (const pathname of ["/api/jobs", "/api/setup"]) {
    expect(
      (
        await fetch(s.origin + pathname, {
          headers: { "Sec-Fetch-Site": "cross-site" },
        })
      ).status,
    ).toBe(403);
  }
  expect(
    (
      await fetch(s.origin + "/api/session", {
        method: "POST",
        headers: {
          Origin: s.origin,
          "Sec-Fetch-Site": "cross-site",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token: s.bootstrapToken }),
      })
    ).status,
  ).toBe(403);
});

test("an unopened private launcher remains usable during the manager idle window but still expires", async () => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    const server = await setup();
    const request = {
      method: "POST",
      headers: { Origin: server.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ token: server.bootstrapToken }),
    };
    clock.mockReturnValue(now + 6 * 60_000);
    expect((await fetch(`${server.origin}/api/session`, request)).status).toBe(
      200,
    );
    expect((await fetch(`${server.origin}/api/session`, request)).status).toBe(
      401,
    );
    const expired = await setup();
    clock.mockReturnValue(now + 37 * 60_000);
    expect(
      (
        await fetch(`${expired.origin}/api/session`, {
          ...request,
          headers: {
            Origin: expired.origin,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ token: expired.bootstrapToken }),
        })
      ).status,
    ).toBe(401);
  } finally {
    clock.mockRestore();
  }
});
