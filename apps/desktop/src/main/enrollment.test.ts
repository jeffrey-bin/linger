import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { EnrollmentError, enrollComputer } from "./enrollment.js";

const claims = (value: object): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const TOKEN = `sr1.${claims({
  runner_id: "computer_1",
  tenant_owners: [{ tenant_id: "tenant_acme", owner_actor_id: "actor_ann" }],
})}.${"s".repeat(43)}`;

interface Call {
  readonly url: string;
  readonly method: string;
  readonly cookie: string | undefined;
  readonly body: Record<string, unknown> | undefined;
}

const fakeServer = (
  overrides: { exchangeStatus?: number; bundle?: Record<string, unknown> } = {},
): { fetch: typeof fetch; calls: Call[] } => {
  const calls: Call[] = [];
  let challenge = "";
  const fetchImpl = (async (input: URL, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const body = init.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    calls.push({
      url: input.pathname,
      method: init.method ?? "GET",
      cookie: headers.cookie,
      body,
    });
    const json = (value: unknown, status = 200): Response =>
      new Response(JSON.stringify(value), { status });
    if (input.pathname === "/v0/me")
      return json({ actors: [{ kind: "human", tenant_id: "tenant_acme" }] });
    if (input.pathname.endsWith("/local-computer-enrollments")) {
      challenge = String(body?.code_challenge);
      return json({
        enrollment_id: "enr_1",
        computer_id: "computer_1",
        authorization_code: "code_1",
        expires_at: "2026-10-16T08:00:00Z",
      });
    }
    if (overrides.exchangeStatus) return json({}, overrides.exchangeStatus);
    const verifier = String(body?.code_verifier);
    if (createHash("sha256").update(verifier).digest("base64url") !== challenge)
      return json({}, 400);
    return json(
      overrides.bundle ?? {
        computer_id: "computer_1",
        tenant_id: "tenant_acme",
        gateway_url: "wss://linger.example.com/v1/runner",
        gateway_token: TOKEN,
        credential_expires_at: "2026-11-16T08:00:00Z",
      },
    );
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
};

const input = {
  serverUrl: "https://linger.example.com",
  cookie: "teamhub_session=abc",
  displayName: "Laptop",
};

describe("enrollComputer", () => {
  it("creates with the session cookie and exchanges as the computer", async () => {
    const server = fakeServer();
    const enrolled = await enrollComputer({ ...input, fetch: server.fetch });
    expect(enrolled).toEqual({
      computerId: "computer_1",
      tenantId: "tenant_acme",
      ownerActorId: "actor_ann",
      gatewayUrl: "wss://linger.example.com/v1/runner",
      credential: TOKEN,
    });
    expect(server.calls.map((c) => [c.method, c.url, !!c.cookie])).toEqual([
      ["GET", "/v0/me", true],
      ["POST", "/v0/tenants/tenant_acme/local-computer-enrollments", true],
      ["POST", "/v0/local-computer-enrollments/enr_1/exchange", false],
    ]);
    expect(server.calls[1]?.body).not.toHaveProperty("computer_id");
  });

  it("keeps the Computer identity when enrolling again", async () => {
    const server = fakeServer();
    await enrollComputer({
      ...input,
      computerId: "computer_1",
      fetch: server.fetch,
    });
    expect(server.calls[1]?.body?.computer_id).toBe("computer_1");
  });

  it("rejects a bundle for another Computer", async () => {
    const server = fakeServer({
      bundle: {
        computer_id: "computer_2",
        tenant_id: "tenant_acme",
        gateway_url: "wss://linger.example.com/v1/runner",
        gateway_token: TOKEN,
        credential_expires_at: "2026-11-16T08:00:00Z",
      },
    });
    await expect(
      enrollComputer({ ...input, fetch: server.fetch }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("rejects a credential scoped to another tenant", async () => {
    const server = fakeServer({
      bundle: {
        computer_id: "computer_1",
        tenant_id: "tenant_acme",
        gateway_url: "wss://linger.example.com/v1/runner",
        gateway_token: `sr1.${claims({
          runner_id: "computer_1",
          tenant_owners: [
            { tenant_id: "tenant_other", owner_actor_id: "actor_ann" },
          ],
        })}.${"s".repeat(43)}`,
        credential_expires_at: "2026-11-16T08:00:00Z",
      },
    });
    await expect(
      enrollComputer({ ...input, fetch: server.fetch }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("reports a removed enrollment", async () => {
    const failure = await enrollComputer({
      ...input,
      fetch: fakeServer({ exchangeStatus: 410 }).fetch,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EnrollmentError);
    expect(failure).toMatchObject({ code: "ENROLLMENT_REMOVED" });
  });

  it("rejects a bundle without a WebSocket gateway", async () => {
    const server = fakeServer({
      bundle: {
        computer_id: "computer_1",
        tenant_id: "tenant_acme",
        gateway_url: "https://linger.example.com/v1/runner",
        gateway_token: TOKEN,
        credential_expires_at: "2026-11-16T08:00:00Z",
      },
    });
    await expect(
      enrollComputer({ ...input, fetch: server.fetch }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});
