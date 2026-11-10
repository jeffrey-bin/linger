import path from "node:path";

import { serviceCredential } from "@linger/service-kit/node";

import { computerReleaseRoot, contextHostRoot, mirrorHome } from "../paths.js";
import { teamHubBaseUrl } from "../teamhub-base-url.js";
import {
  parseLocalContextRuntimeConfiguration,
  parseRunnerGatewayConfiguration,
  type LocalContextRuntimeConfiguration,
  type RunnerGatewayConfiguration,
} from "./runner-gateway/runner-gateway-config.js";

/** Everything the Agent Service reads from the environment, read once at start. */
export interface AgentServiceConfig {
  readonly home: string;
  readonly contextHostRoot: string;
  readonly computerReleaseRoot: string;
  /** Root of the local NDJSON log files; absent, logs go to the terminal only. */
  readonly logDirectory?: string;
  readonly teamHubBaseUrl: string;
  /** The TeamHub origin the Agent CLI on a Local Computer calls. */
  readonly teamHubCliBaseUrl: string;
  readonly webPublicOrigin?: string;
  /** Authenticates the Agent Service's calls to TeamHub. */
  readonly serviceToken: string;
  /** Authenticates TeamHub's calls to the Agent Service. */
  readonly inboundServiceToken: string;
  /** Present when AGENT_RUNNER_PUBLIC_GATEWAY_URL turns the Runner Gateway on. */
  readonly runnerGateway?: {
    readonly configuration: RunnerGatewayConfiguration;
    readonly localContextRuntime: LocalContextRuntimeConfiguration;
    /** Signs Runner enrollment credentials. */
    readonly runnerSigningKey: string;
  };
}

export function readAgentServiceConfig(
  environment: NodeJS.ProcessEnv,
): AgentServiceConfig {
  const home = mirrorHome(environment);
  const baseUrl = teamHubBaseUrl(environment);
  const configuredLogDirectory = environment.AGENT_LOG_DIRECTORY;
  // An explicitly empty value turns the file sink off.
  const logDirectory =
    configuredLogDirectory === undefined
      ? path.join(home, "agent-manager", "logs")
      : configuredLogDirectory.trim() || undefined;
  const webPublicOrigin = environment.WEB_PUBLIC_ORIGIN?.trim() || undefined;
  const gateway = parseRunnerGatewayConfiguration(environment);
  return {
    home,
    contextHostRoot: contextHostRoot(environment),
    computerReleaseRoot: computerReleaseRoot(environment),
    ...(logDirectory ? { logDirectory } : {}),
    teamHubBaseUrl: baseUrl,
    teamHubCliBaseUrl: environment.TEAMHUB_CLI_BASE_URL?.trim() || baseUrl,
    ...(webPublicOrigin ? { webPublicOrigin } : {}),
    serviceToken: requiredSecret(
      serviceCredential("teamhub-internal", environment),
    ),
    inboundServiceToken: requiredSecret(
      serviceCredential("node-services-internal", environment),
    ),
    ...(gateway
      ? {
          runnerGateway: {
            configuration: gateway,
            localContextRuntime: parseLocalContextRuntimeConfiguration(
              gateway,
              environment,
            ),
            runnerSigningKey: requiredSecret(
              serviceCredential("runner-signing", environment),
            ),
          },
        }
      : {}),
  };
}

function requiredSecret(value: string | undefined): string {
  if (!value || value.trim().length === 0) {
    throw new TypeError("LINGER_SECRET_SEED must be set in .env");
  }
  return value;
}
