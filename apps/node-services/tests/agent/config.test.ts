import path from "node:path";

import { serviceCredential } from "@linger/service-kit/node";
import { describe, expect, it } from "vitest";

import { readAgentServiceConfig } from "../../src/agent/config.js";

const seed = {
  LINGER_SECRET_SEED: "test-seed-0123456789abcdef0123456789",
  AGENT_HOME: "/var/lib/agent-home",
};

describe("readAgentServiceConfig", () => {
  it("defaults the log directory under the Agent home unless it is set", () => {
    expect(readAgentServiceConfig(seed).logDirectory).toBe(
      path.join("/var/lib/agent-home", "agent-manager", "logs"),
    );
    expect(
      readAgentServiceConfig({ ...seed, AGENT_LOG_DIRECTORY: " /logs " })
        .logDirectory,
    ).toBe("/logs");
    expect(
      readAgentServiceConfig({ ...seed, AGENT_LOG_DIRECTORY: "" }),
    ).not.toHaveProperty("logDirectory");
  });

  it("calls the Agent CLI through TeamHub's base URL unless a CLI URL is set", () => {
    const config = readAgentServiceConfig({
      ...seed,
      TEAMHUB_BASE_URL: "http://teamhub.internal:8080",
    });
    expect(config.teamHubCliBaseUrl).toBe("http://teamhub.internal:8080");
    expect(
      readAgentServiceConfig({
        ...seed,
        TEAMHUB_CLI_BASE_URL: " https://teamhub.example ",
      }).teamHubCliBaseUrl,
    ).toBe("https://teamhub.example");
  });

  it("requires the secret seed", () => {
    expect(() => readAgentServiceConfig({})).toThrow(
      "LINGER_SECRET_SEED must be set in .env",
    );
  });

  it("derives the Runner signing key only when the Runner Gateway is on", () => {
    expect(readAgentServiceConfig(seed)).not.toHaveProperty("runnerGateway");
    const gateway = readAgentServiceConfig({
      ...seed,
      AGENT_RUNNER_PUBLIC_GATEWAY_URL:
        "wss://agent.example.test/v1/runner-gateway",
    }).runnerGateway;
    expect(gateway).toMatchObject({
      configuration: { publicOrigin: "https://agent.example.test/" },
      localContextRuntime: { publicOrigin: "https://agent.example.test/" },
      runnerSigningKey: serviceCredential("runner-signing", seed),
    });
  });
});
