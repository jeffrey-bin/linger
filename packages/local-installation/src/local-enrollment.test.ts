import { mkdtemp, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { Instance } from "./instance.js";
import { prepareLocalEnrollment } from "./local-enrollment.js";
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "linger-enroll-"));
  roots.push(root);
  await writeFile(
    path.join(root, "local-account.json"),
    JSON.stringify({
      email: "owner@linger.local",
      password: "p".repeat(32),
      provisioned: true,
    }),
    { mode: 0o600 },
  );
  return {
    instance: {
      mode: "source-native",
      root,
      origin: "http://localhost:3000",
      name: "test",
      port: 3000,
      releaseDir: "/source",
      source: {
        repo: "/source",
        ports: {
          web: 3000,
          teamhub: 3001,
          nodeServices: 3002,
          document: 3003,
          postgres: 3004,
        },
      },
    } as Instance,
    signal: new AbortController().signal,
  };
}
it("authorizes through the local owner session, persists one private PKCE token, reuses it and logs out", async () => {
  const f = await fixture();
  const requests: {
    url: string;
    body: Record<string, string>;
    cookie?: string;
  }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      requests.push({
        url,
        body: JSON.parse((init.body as string | undefined) ?? "{}"),
        cookie: (init.headers as Record<string, string>).Cookie,
      });
      if (url.endsWith("/login"))
        return new Response(null, {
          status: 200,
          headers: { "set-cookie": "session=private; HttpOnly" },
        });
      if (url.endsWith("/tenants"))
        return Response.json({ items: [{ id: "tenant-one" }] });
      if (url.endsWith("/logout")) return new Response(null, { status: 204 });
      return Response.json(
        {
          enrollment_id: "enrollment-one",
          computer_id: "computer-one",
          authorization_code: "a".repeat(43),
          expires_at: new Date(Date.now() + 300_000).toISOString(),
        },
        { status: 201 },
      );
    }),
  );
  const file = await prepareLocalEnrollment(f.instance, f.signal);
  const text = await readFile(file, "utf8");
  const token = JSON.parse(
    Buffer.from(text.trim().split(".")[1]!, "base64url").toString(),
  );
  expect(token.origin).toBe(f.instance.origin);
  expect(token.tenant_id).toBe("tenant-one");
  expect(token.code_verifier).toHaveLength(43);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  const enrollment = requests.find((r) =>
    r.url.endsWith("/local-computer-enrollments"),
  )!;
  expect(enrollment.cookie).toBe("session=private");
  expect(enrollment.body.redirect_uri).toBe("http://127.0.0.1:9/callback");
  expect(enrollment.body.code_challenge).toBe(
    createHash("sha256").update(token.code_verifier).digest("base64url"),
  );
  expect(requests.at(-1)?.url).toMatch(/logout$/);
  vi.mocked(fetch).mockClear();
  expect(await prepareLocalEnrollment(f.instance, f.signal)).toBe(file);
  expect(fetch).not.toHaveBeenCalled();
});
it("does not accept remote instances or leak login error bodies", async () => {
  const f = await fixture();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("private-password", { status: 401 })),
  );
  await expect(
    prepareLocalEnrollment(
      { ...f.instance, origin: "https://example.com" },
      f.signal,
    ),
  ).rejects.toThrow(/verified local instance/);
  expect(fetch).not.toHaveBeenCalled();
  await expect(prepareLocalEnrollment(f.instance, f.signal)).rejects.toThrow(
    "Local Computer sign-in failed (HTTP 401)",
  );
});
it("renews an expired token for the same Computer rather than creating a duplicate", async () => {
  const f = await fixture();
  const previous = {
    origin: f.instance.origin,
    computer_id: "computer-existing",
    tenant_id: "tenant-one",
    enrollment_id: "enrollment-old",
    expires_at: "2020-01-01T00:00:00Z",
  };
  await writeFile(
    path.join(f.instance.root, "computer-enrollment.token"),
    "linger-connect-v1." +
      Buffer.from(JSON.stringify(previous)).toString("base64url"),
    { mode: 0o600 },
  );
  let requestedComputer: unknown;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/login"))
        return new Response(null, {
          headers: { "set-cookie": "session=private; HttpOnly" },
        });
      if (url.endsWith("/tenants"))
        return Response.json({ items: [{ id: "tenant-one" }] });
      if (url.endsWith("/logout")) return new Response(null, { status: 204 });
      if (url.endsWith("/local-computers"))
        return Response.json({ items: [{ computer_id: "computer-existing" }] });
      requestedComputer = JSON.parse(init.body as string).computer_id;
      return Response.json(
        {
          enrollment_id: "enrollment-new",
          computer_id: "computer-existing",
          authorization_code: "a".repeat(43),
          expires_at: new Date(Date.now() + 300_000).toISOString(),
        },
        { status: 201 },
      );
    }),
  );
  await prepareLocalEnrollment(f.instance, f.signal);
  expect(requestedComputer).toBe("computer-existing");
});

it.each([
  "present",
  "absent",
  "unavailable",
  "transport",
  "malformed",
] as const)(
  "rechecks expired enrollment against owner inventory (%s) before renewing",
  async (inventory) => {
    const f = await fixture();
    f.instance.computerName = "Same name computer";
    const file = path.join(f.instance.root, "computer-enrollment.token");
    const previous = {
      origin: f.instance.origin,
      computer_id: "pending-computer",
      tenant_id: "saved-tenant",
      enrollment_id: "enrollment-old",
      expires_at: "2020-01-01T00:00:00Z",
    };
    const text =
      "linger-connect-v1." +
      Buffer.from(JSON.stringify(previous)).toString("base64url");
    await writeFile(file, text, { mode: 0o600 });
    let authorized = 0;
    let body: Record<string, unknown> | undefined;
    let queried = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith("/login"))
          return new Response(null, {
            headers: { "set-cookie": "session=private; HttpOnly" },
          });
        if (url.endsWith("/logout")) return new Response(null, { status: 204 });
        if (url.endsWith("/tenants"))
          return Response.json({
            items: [{ id: "different-first-tenant" }, { id: "saved-tenant" }],
          });
        if (url.endsWith("/local-computers")) {
          expect(url).toContain("/tenants/saved-tenant/");
          queried = true;
          if (inventory === "transport")
            throw new Error("private-transport-details");
          if (inventory === "unavailable")
            return new Response("private-provider-details", { status: 503 });
          if (inventory === "malformed")
            return Response.json({ unexpected: [] });
          return Response.json({
            items:
              inventory === "present"
                ? [{ computer_id: "pending-computer" }]
                : [
                    {
                      computer_id: "other-computer",
                      display_name: f.instance.computerName,
                    },
                  ],
          });
        }
        authorized++;
        body = JSON.parse(init.body as string);
        return Response.json(
          {
            enrollment_id: "enrollment-new",
            computer_id:
              inventory === "present" ? "pending-computer" : "fresh-computer",
            authorization_code: "a".repeat(43),
            expires_at: new Date(Date.now() + 300000).toISOString(),
          },
          { status: 201 },
        );
      }),
    );
    if (["transport", "unavailable", "malformed"].includes(inventory)) {
      await expect(
        prepareLocalEnrollment(f.instance, f.signal),
      ).rejects.toThrow();
      expect(authorized).toBe(0);
      expect(await readFile(file, "utf8")).toBe(text);
    } else {
      await prepareLocalEnrollment(f.instance, f.signal);
      expect(queried).toBe(true);
      expect(authorized).toBe(1);
      expect(body?.computer_id).toBe(
        inventory === "present" ? "pending-computer" : undefined,
      );
    }
  },
);
it("accepts a validated source descriptor and rejects an unvalidated one", async () => {
  const f = await fixture();
  const source = f.instance.source;
  delete f.instance.source;
  await expect(prepareLocalEnrollment(f.instance, f.signal)).rejects.toThrow(
    "verified",
  );
  f.instance.source = source;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/login"))
        return new Response(null, {
          status: 200,
          headers: { "set-cookie": "session=private" },
        });
      if (url.endsWith("/tenants"))
        return Response.json({ items: [{ id: "tenant-one" }] });
      if (url.endsWith("/logout")) return new Response(null, { status: 204 });
      return Response.json(
        {
          enrollment_id: "enrollment-one",
          computer_id: "computer-one",
          authorization_code: "a".repeat(43),
          expires_at: new Date(Date.now() + 300_000).toISOString(),
        },
        { status: 201 },
      );
    }),
  );
  expect(await prepareLocalEnrollment(f.instance, f.signal)).toBe(
    path.join(f.instance.root, "computer-enrollment.token"),
  );
});
