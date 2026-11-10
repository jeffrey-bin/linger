import { describe, expect, it, vi } from "vitest";

import { createTeamHubAgentCliCredentialIssuer } from "../../../src/agent/runner-gateway/agent-cli-credential-issuer.js";
import {
  parseLocalContextRuntimeConfiguration,
  parseRunnerGatewayConfiguration,
} from "../../../src/agent/runner-gateway/runner-gateway-config.js";
import { serviceCredential } from "@linger/service-kit/node";

const seed = {
  LINGER_SECRET_SEED: "test-seed-0123456789abcdef0123456789",
};

describe("Runner Gateway credential config", () => {
  it("turns the Gateway on with its public URL and derives the shared HTTP origin", () => {
    expect(parseRunnerGatewayConfiguration(seed)).toBeUndefined();
    expect(
      parseRunnerGatewayConfiguration({
        AGENT_RUNNER_PUBLIC_GATEWAY_URL: "  ",
      }),
    ).toBeUndefined();
    expect(
      parseRunnerGatewayConfiguration({
        AGENT_RUNNER_PUBLIC_GATEWAY_URL:
          "ws://10.0.0.5:31046/v1/runner-gateway",
      }),
    ).toEqual({
      publicOrigin: "http://10.0.0.5:31046/",
    });
    expect(
      parseRunnerGatewayConfiguration({
        AGENT_RUNNER_PUBLIC_GATEWAY_URL:
          "wss://agent.example.test/v1/runner-gateway",
      })?.publicOrigin,
    ).toBe("https://agent.example.test/");
    expect(() =>
      parseRunnerGatewayConfiguration({
        AGENT_RUNNER_PUBLIC_GATEWAY_URL:
          "https://agent.example.test/v1/runner-gateway",
      }),
    ).toThrow("AGENT_RUNNER_PUBLIC_GATEWAY_URL must use ws or wss");
  });

  it("accepts plaintext HTTP for the Gateway, Local Context and Agent CLI", async () => {
    const environment = {
      ...seed,
      AGENT_RUNNER_PUBLIC_GATEWAY_URL:
        "ws://owner.example.test/v1/runner-gateway",
    };
    const configuration = parseRunnerGatewayConfiguration(environment)!;

    expect(
      parseLocalContextRuntimeConfiguration(configuration, environment),
    ).toMatchObject({ publicOrigin: "http://owner.example.test/" });

    const issuer = createTeamHubAgentCliCredentialIssuer({
      baseUrl: "https://teamhub.example",
      cliBaseUrl: "http://teamhub.internal",
      serviceToken: "service-secret",
      fetch: vi.fn<typeof globalThis.fetch>(async () =>
        Response.json({}, { status: 500 }),
      ),
    });
    await expect(
      issuer.issue(
        { tenantId: "tenant-a", agentId: "agent-a" },
        { computerId: "computer-a", workspaceGrantId: "grant-a" },
      ),
    ).rejects.toThrow("TeamHub CLI credential preparation failed (500)");
  });

  it("derives a dedicated content signing key for Local Context transport", () => {
    const configuration = parseRunnerGatewayConfiguration({
      AGENT_RUNNER_PUBLIC_GATEWAY_URL:
        "wss://agent.example.test/v1/runner-gateway",
    })!;
    expect(() =>
      parseLocalContextRuntimeConfiguration(configuration, {}),
    ).toThrow("LINGER_SECRET_SEED must be set");
    expect(parseLocalContextRuntimeConfiguration(configuration, seed)).toEqual({
      publicOrigin: "https://agent.example.test/",
      contentSigningKey: serviceCredential("local-context-file-signing", seed),
    });
    expect(serviceCredential("local-context-file-signing", seed)).not.toBe(
      serviceCredential("runner-signing", seed),
    );
  });
});
