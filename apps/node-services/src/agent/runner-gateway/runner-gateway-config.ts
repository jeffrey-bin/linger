import { serviceCredential } from "@linger/service-kit/node";

export interface RunnerGatewayConfiguration {
  /** The Gateway's HTTP origin, shared by the Local MCP Relay and Local Context. */
  readonly publicOrigin: string;
}

/** Setting AGENT_RUNNER_PUBLIC_GATEWAY_URL turns the Runner Gateway on. */
export const parseRunnerGatewayConfiguration = (
  environment: NodeJS.ProcessEnv,
): RunnerGatewayConfiguration | undefined => {
  const gatewayUrl = environment.AGENT_RUNNER_PUBLIC_GATEWAY_URL?.trim();
  if (!gatewayUrl) return undefined;
  const url = new URL(gatewayUrl);
  if (url.protocol === "ws:") url.protocol = "http:";
  else if (url.protocol === "wss:") url.protocol = "https:";
  else
    throw new TypeError("AGENT_RUNNER_PUBLIC_GATEWAY_URL must use ws or wss");
  return { publicOrigin: `${url.origin}/` };
};

export interface LocalContextRuntimeConfiguration {
  readonly publicOrigin: string;
  /** Signs the per-connection Context View content URL handed to Computers. */
  readonly contentSigningKey: string;
}

export const parseLocalContextRuntimeConfiguration = (
  configuration: RunnerGatewayConfiguration,
  environment: NodeJS.ProcessEnv,
): LocalContextRuntimeConfiguration => {
  const contentSigningKey = serviceCredential(
    "local-context-file-signing",
    environment,
  );
  if (!contentSigningKey) {
    throw new TypeError("LINGER_SECRET_SEED must be set");
  }
  return {
    publicOrigin: configuration.publicOrigin,
    contentSigningKey,
  };
};
