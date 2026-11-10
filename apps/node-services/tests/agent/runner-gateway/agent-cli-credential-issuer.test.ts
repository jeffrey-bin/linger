import { describe, expect, it, vi } from "vitest";
import { requestBodyText, requestUrlText } from "@linger/service-kit";

import { createTeamHubAgentCliCredentialIssuer } from "../../../src/agent/runner-gateway/agent-cli-credential-issuer.js";

const identity = { tenantId: "tenant_one", agentId: "agent_one" };
const placement = { computerId: "computer_one", workspaceGrantId: "grant_one" };
const token = `th_agent_${"a".repeat(43)}`;

const issued = (overrides: Record<string, unknown> = {}) =>
  Response.json(
    {
      credential_id: "credential_one",
      tenant_id: "tenant_one",
      agent_id: "agent_one",
      access_token: token,
      ...overrides,
    },
    { status: 201 },
  );

const subject = (
  options: Partial<
    Parameters<typeof createTeamHubAgentCliCredentialIssuer>[0]
  > = {},
) => {
  const fetcher = vi.fn<typeof globalThis.fetch>(async () => issued());
  return {
    fetcher,
    issuer: createTeamHubAgentCliCredentialIssuer({
      baseUrl: "https://teamhub.example",
      serviceToken: "service-secret",
      fetch: fetcher,
      ...options,
    }),
  };
};

describe("TeamHub Agent CLI credential issuer", () => {
  it("issues with the Agent Service token and returns the token", async () => {
    const { fetcher, issuer } = subject();
    await expect(issuer.issue(identity, placement)).resolves.toEqual({
      accessToken: token,
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(requestUrlText(url)).toBe(
      "https://teamhub.example/internal/agents/agent_one/access-credentials",
    );
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer service-secret",
    );
    expect(JSON.parse(requestBodyText(init?.body))).toEqual({
      label: "Managed Agent CLI",
      computer_id: "computer_one",
      workspace_grant_id: "grant_one",
    });
  });

  it("asks TeamHub about the held token and issues nothing while it is live", async () => {
    const { fetcher, issuer } = subject();
    fetcher.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const held = "b".repeat(64);
    await expect(issuer.issue(identity, placement, held)).resolves.toBe(
      "current",
    );
    expect(
      JSON.parse(requestBodyText(fetcher.mock.calls[0]![1]?.body)),
    ).toMatchObject({ held_token_sha256: held });
    // A 204 answers only a question about a held token.
    fetcher.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(issuer.issue(identity, placement)).rejects.toThrow(
      "TeamHub CLI credential preparation failed (204)",
    );
  });

  it("installs the Local Computer CLI origin without changing where it issues", async () => {
    const { fetcher, issuer } = subject({
      cliBaseUrl: "https://public.teamhub.example",
    });
    expect(issuer.profile(identity)).toEqual({
      url: "https://public.teamhub.example",
      tenantId: "tenant_one",
      agentId: "agent_one",
    });
    await issuer.issue(identity, placement);
    expect(requestUrlText(fetcher.mock.calls[0]![0])).toBe(
      "https://teamhub.example/internal/agents/agent_one/access-credentials",
    );
    expect(JSON.stringify(issuer.profile(identity))).not.toContain(
      "service-secret",
    );
  });

  it.each([
    ["another tenant", { tenant_id: "other_tenant" }],
    ["another Agent", { agent_id: "other_agent" }],
    ["a malformed token", { access_token: "th_agent_short" }],
  ])("rejects a response with %s", async (_case, overrides) => {
    const { fetcher, issuer } = subject();
    fetcher.mockResolvedValueOnce(issued(overrides));
    await expect(issuer.issue(identity, placement)).rejects.toThrow(
      "TeamHub returned an invalid Agent CLI identity",
    );
  });

  it("reports TeamHub failures without the service token", async () => {
    const { fetcher, issuer } = subject();
    fetcher.mockRejectedValueOnce(new Error("service-secret leaked"));
    const error = await issuer
      .issue(identity, placement)
      .catch((reason: unknown) => reason);
    expect(String(error)).toContain(
      "TeamHub CLI credential preparation failed",
    );
    expect(String(error)).not.toContain("service-secret");
    fetcher.mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(issuer.issue(identity, placement)).rejects.toThrow(
      "TeamHub CLI credential preparation failed (403)",
    );
  });

  it.each([
    "http://localhost:8080",
    "http://[::1]:8080",
    "http://teamhub.internal",
  ])("allows HTTP: %s", async (cliBaseUrl) => {
    const { issuer } = subject({ cliBaseUrl });
    await expect(issuer.issue(identity, placement)).resolves.toBeDefined();
  });

  it("rejects a non-HTTP CLI URL", async () => {
    const { issuer, fetcher } = subject({
      cliBaseUrl: "ftp://teamhub.internal",
    });
    await expect(issuer.issue(identity, placement)).rejects.toThrow(
      "requires an HTTP or HTTPS URL",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});
