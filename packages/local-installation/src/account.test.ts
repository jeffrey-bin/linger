import {
  mkdtemp,
  readFile,
  writeFile,
  stat,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ensureLocalAccount } from "./account.js";
import type { Instance } from "./instance.js";

const provisionOwner =
  vi.fn<(email: string, password: string) => Promise<void>>();
const owner = { provisionOwner };
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "linger-account-"));
  roots.push(root);
  const instance = { root, origin: "http://localhost:3000" } as Instance;
  return {
    instance,
    file: path.join(root, "local-account.json"),
    signal: new AbortController().signal,
  };
}
it("creates the owner through stdin, confirms login and logs out before reusing private credentials", async () => {
  const f = await fixture();
  const requests: string[] = [];
  let created = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      requests.push(new URL(url).pathname);
      return new Response(null, {
        status: url.endsWith("/logout") ? 204 : created ? 200 : 401,
        headers: created ? { "set-cookie": "session=test; HttpOnly" } : {},
      });
    }),
  );
  provisionOwner.mockImplementation(async (email, password) => {
    const saved = JSON.parse(await readFile(f.file, "utf8"));
    expect(saved.provisioned).toBe(false);
    expect(email).toBe(saved.email);
    expect(password === saved.password).toBe(true);
    created = true;
  });
  const result = await ensureLocalAccount(f.instance, f.signal, owner);
  expect(result.email).toBe("owner@linger.local");
  expect(result.file).toBe(f.file);
  const saved = JSON.parse(await readFile(f.file, "utf8"));
  expect(saved.password.length).toBeGreaterThanOrEqual(24);
  expect(saved.provisioned).toBe(true);
  expect((await stat(f.file)).mode & 0o777).toBe(0o600);
  expect(requests).toEqual([
    "/v0/auth/login",
    "/v0/auth/login",
    "/v0/auth/logout",
  ]);
  vi.mocked(fetch).mockClear();
  provisionOwner.mockClear();
  await ensureLocalAccount(f.instance, f.signal, owner);
  expect(fetch).not.toHaveBeenCalled();
  expect(provisionOwner).not.toHaveBeenCalled();
  expect(
    JSON.parse(await readFile(f.file, "utf8")).password === saved.password,
  ).toBe(true);
});
it("recovers owner creation interrupted after commit using the saved password without resetting it", async () => {
  const f = await fixture();
  const password = "a".repeat(32);
  await writeFile(
    f.file,
    JSON.stringify({
      email: "owner@linger.local",
      password,
      provisioned: false,
    }),
    { mode: 0o600 },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(null, {
          status: 200,
          headers: { "set-cookie": "session=test; HttpOnly" },
        }),
    ),
  );
  await ensureLocalAccount(f.instance, f.signal, owner);
  expect(provisionOwner).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(f.file, "utf8")).provisioned).toBe(true);
  expect(JSON.parse(await readFile(f.file, "utf8")).password).toBe(password);
});
it("does not mark an existing owner provisioned when its saved password cannot log in", async () => {
  const f = await fixture();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 401 })),
  );
  provisionOwner.mockResolvedValue(undefined);
  await expect(
    ensureLocalAccount(f.instance, f.signal, owner).then(() => "success"),
  ).rejects.toThrow(/existing accounts will not be reset/);
  expect(provisionOwner).toHaveBeenCalledOnce();
  expect(JSON.parse(await readFile(f.file, "utf8")).provisioned).toBe(false);
});
it("confirms a committed owner after a command failure without exposing command diagnostics", async () => {
  const f = await fixture();
  let attempts = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () => new Response(null, { status: ++attempts === 1 ? 401 : 200 }),
    ),
  );
  provisionOwner.mockRejectedValue(new Error("private-server-secret"));
  await ensureLocalAccount(f.instance, f.signal, owner);
  expect(attempts).toBe(2);
  expect(JSON.parse(await readFile(f.file, "utf8")).provisioned).toBe(true);
});
it("keeps credentials private when command creation and login both fail", async () => {
  const f = await fixture();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 401 })),
  );
  provisionOwner.mockRejectedValue(new Error("private-server-secret"));
  const message = await ensureLocalAccount(f.instance, f.signal, owner).then(
    () => "success",
    (error: Error) => error.message,
  );
  expect(message).toMatch(/existing accounts will not be reset/);
  expect(message).not.toContain("private-server-secret");
  expect(JSON.parse(await readFile(f.file, "utf8")).provisioned).toBe(false);
});
it("does not create an owner on an unexpected login error or leak server response secrets", async () => {
  const f = await fixture();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("private-server-secret", { status: 503 })),
  );
  await expect(
    ensureLocalAccount(f.instance, f.signal, owner).then(() => "success"),
  ).rejects.toThrow("Local account login check failed (HTTP 503)");
  expect(provisionOwner).not.toHaveBeenCalled();
});
it("rejects nonprivate or linked credential files before network activity", async () => {
  const f = await fixture();
  const target = path.join(f.instance.root, "target");
  await writeFile(target, "{}", { mode: 0o600 });
  await symlink(target, f.file);
  vi.stubGlobal("fetch", vi.fn());
  await expect(ensureLocalAccount(f.instance, f.signal, owner)).rejects.toThrow(
    /private/,
  );
  expect(fetch).not.toHaveBeenCalled();
});
it("does not expose credential text from malformed JSON or continue after cancellation", async () => {
  const f = await fixture();
  await writeFile(f.file, '{"password":"private-password" malformed}', {
    mode: 0o600,
  });
  vi.stubGlobal("fetch", vi.fn());
  await expect(ensureLocalAccount(f.instance, f.signal, owner)).rejects.toThrow(
    "The local account file is invalid; existing credentials will not be overwritten.",
  );
  await rm(f.file);
  await expect(
    ensureLocalAccount(f.instance, AbortSignal.abort(), owner),
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
it("accepts first-time custom credentials and reuses them without resetting", async () => {
  const f = await fixture();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 200 })),
  );
  const expected = {
    email: "custom@example.com",
    password: "custom-password-123",
  };
  const result = await ensureLocalAccount(f.instance, f.signal, {
    ...expected,
    provisionOwner,
  });
  expect(result).toMatchObject(expected);
  const again = await ensureLocalAccount(f.instance, f.signal, {
    email: "other@example.com",
    password: "other-password-123",
    provisionOwner,
  });
  expect(again).toMatchObject(expected);
});
it("provides credentials only through a validated private login read", async () => {
  const { readLocalLogin } = await import("./account.js");
  const f = await fixture();
  await writeFile(
    f.file,
    JSON.stringify({
      email: "person@example.com",
      password: "a-private-password",
      provisioned: true,
    }),
    { mode: 0o600 },
  );
  expect(await readLocalLogin(f.instance)).toMatchObject({
    email: "person@example.com",
    password: "a-private-password",
  });
  const { chmod } = await import("node:fs/promises");
  await chmod(f.file, 0o644);
  await expect(readLocalLogin(f.instance)).rejects.toThrow(/private/);
});
it("rejects invalid custom credentials before writing or calling the account service", async () => {
  const f = await fixture();
  vi.stubGlobal("fetch", vi.fn());
  await expect(
    ensureLocalAccount(f.instance, f.signal, {
      email: "bad",
      password: "x",
      provisionOwner,
    }),
  ).rejects.toThrow(/email/);
  await expect(readFile(f.file, "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(fetch).not.toHaveBeenCalled();
});
it("uses a source owner provisioner with saved credentials and confirms login", async () => {
  const f = await fixture();
  let attempts = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () => new Response(null, { status: ++attempts === 1 ? 401 : 200 }),
    ),
  );
  provisionOwner.mockResolvedValue(undefined);
  let provisioned = false;
  await ensureLocalAccount(f.instance, f.signal, {
    provisionOwner: async (email, password) => {
      const saved = JSON.parse(await readFile(f.file, "utf8"));
      expect(email === saved.email && password === saved.password).toBe(true);
      provisioned = true;
    },
  });
  expect(provisioned).toBe(true);
  expect(attempts).toBe(2);
  expect(JSON.parse(await readFile(f.file, "utf8")).provisioned).toBe(true);
});
