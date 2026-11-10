import type { AgentManagerOperationalReadiness } from "../executor/http/agent-manager-http-server.js";

export interface AgentManagerOperationalReadinessOptions {
  readonly teamHubBaseUrl: string;
  readonly requestTimeoutMs: number;
  readonly fetch?: typeof globalThis.fetch;
}

export const createAgentManagerOperationalReadiness = (
  options: AgentManagerOperationalReadinessOptions,
): (() => Promise<AgentManagerOperationalReadiness>) => {
  if (
    !Number.isSafeInteger(options.requestTimeoutMs) ||
    options.requestTimeoutMs < 1
  ) {
    throw new TypeError("Agent readiness timeout must be a positive integer");
  }
  const request = options.fetch ?? globalThis.fetch;
  const teamHubReadinessUrl = serviceEndpoint(
    options.teamHubBaseUrl,
    "/healthz",
  );

  return async () => {
    if (
      !(await probe(request, teamHubReadinessUrl, options.requestTimeoutMs))
    ) {
      return { ready: false, reason: "teamhub_unavailable" };
    }
    return { ready: true };
  };
};

const probe = async (
  fetch: typeof globalThis.fetch,
  url: string,
  requestTimeoutMs: number,
): Promise<boolean> => {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
};

const serviceEndpoint = (baseUrl: string, pathname: string): string => {
  const parsed = new URL(baseUrl);
  parsed.pathname = pathname;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
};
