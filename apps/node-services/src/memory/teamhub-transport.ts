import { AsyncLocalStorage } from "node:async_hooks";
import type { TeamHubAgentCallbackFetch } from "@linger/wire-contracts/teamhub-internal/client";

const traceContext = new AsyncLocalStorage<string>();
const traceparentPattern =
  /^00-(?!0{32}-)[0-9a-f]{32}-(?!0{16}-)[0-9a-f]{16}-[0-9a-f]{2}$/u;

export function withTeamHubTrace<T>(
  traceparent: string | undefined,
  operation: () => T,
): T {
  return traceContext.run(
    traceparent && traceparentPattern.test(traceparent) ? traceparent : "",
    operation,
  );
}

/** All memory TeamHub traffic, including standalone CLIs, uses this transport. */
export function teamHubFetch(
  fetcher: TeamHubAgentCallbackFetch = globalThis.fetch,
): TeamHubAgentCallbackFetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    const version =
      process.env.APP_VERSION?.replace(/[^A-Za-z0-9._+-]/gu, "").slice(
        0,
        128,
      ) || "dev";
    headers.set("user-agent", `linger-memory/${version}`);
    const traceparent = traceContext.getStore();
    if (traceparent) headers.set("traceparent", traceparent);
    return fetcher(input, { ...init, headers });
  };
}
