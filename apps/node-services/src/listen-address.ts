/** Where a listener binds: `host:port`, `[ipv6]:port`, or `:port` for every
 * interface, the same shape as TeamHub's TEAMHUB_HTTP_ADDRESS. */
export interface ListenAddress {
  host: string;
  port: number;
}

/** The shared listener of the Agent Service, Memory and LLM Wiki. */
export const NODE_SERVICES_DEFAULT_ADDRESS: ListenAddress = {
  host: "127.0.0.1",
  port: 4319,
};

/** The Document Runtime listener on its worker thread. */
export const DOCUMENT_RUNTIME_DEFAULT_ADDRESS: ListenAddress = {
  host: "127.0.0.1",
  port: 4321,
};

/**
 * Parses the named variable, or returns the fallback when it is unset or
 * blank. Port 0 (an ephemeral port) is accepted only when allowZeroPort is set,
 * because a deployment always names its port.
 */
export function readListenAddress(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: ListenAddress,
  allowZeroPort = false,
): ListenAddress {
  const value = environment[name]?.trim();
  if (!value) return fallback;
  const separator = value.lastIndexOf(":");
  const rawHost = separator < 0 ? "" : value.slice(0, separator);
  const rawPort = value.slice(separator + 1);
  const port = Number(rawPort);
  const minimum = allowZeroPort ? 0 : 1;
  if (
    separator < 0 ||
    !/^\d+$/u.test(rawPort) ||
    port < minimum ||
    port > 65_535
  ) {
    throw new TypeError(
      `${name} must be host:port with a port between ${minimum} and 65535`,
    );
  }
  const host = rawHost.replace(/^\[(.*)\]$/u, "$1") || "0.0.0.0";
  return { host, port };
}
