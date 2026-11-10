import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

import type { CredentialStore } from "./computer-credential.js";
import type { ConfigStore } from "./config.js";
import {
  connectLegacyBridge,
  type LegacyBridgeClient,
} from "./legacy-bridge.js";
import type { Logger } from "./log.js";

// One-time move from the bridge + runtime-host layout (Desktop 0.16 and
// earlier) to the Go daemon. Removable once no supported install predates it.

export interface LegacyLayout {
  // The bridge state directory that held credential.json.
  readonly bridgeStateDirectory: string;
  // The runtime-host directory that held daemon-identity.json.
  readonly runtimeDirectory: string;
  // The Go daemon state directory.
  readonly daemonStateDirectory: string;
}

const RETIRE_TIMEOUT_MS = 5_000;

// The bridge kept the server origin of the Gateway; the Gateway itself is at
// /v1/runner-gateway on that origin.
export const legacyGatewayUrl = (serverUrl: string): string | undefined => {
  try {
    const url = new URL(serverUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    const protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${url.host}/v1/runner-gateway`;
  } catch {
    return undefined;
  }
};

// Keeps the Computer id and daemon identity of an enrolled computer and moves
// its credential out of the bridge. Never logs the credential.
export const migrateLegacyComputer = (
  layout: LegacyLayout,
  config: ConfigStore,
  credentials: CredentialStore,
  log: Logger,
): void => {
  const identity = path.join(layout.runtimeDirectory, "daemon-identity.json");
  const target = path.join(layout.daemonStateDirectory, "daemon-identity.json");
  try {
    mkdirSync(layout.daemonStateDirectory, { recursive: true, mode: 0o700 });
    // COPYFILE_EXCL keeps an identity the daemon already has.
    copyFileSync(identity, target, 1);
    rmSync(identity, { force: true });
    log.info("migration.identity_moved");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "EEXIST")
      log.warn("migration.identity_failed", { error: String(error) });
  }

  const legacy = path.join(layout.bridgeStateDirectory, "credential.json");
  let stored: unknown;
  try {
    stored = JSON.parse(readFileSync(legacy, "utf8"));
  } catch {
    return;
  }
  const computerId = config.get().computerId;
  const {
    serverUrl,
    computerId: storedId,
    token,
  } = (stored ?? {}) as {
    serverUrl?: unknown;
    computerId?: unknown;
    token?: unknown;
  };
  const gatewayUrl =
    typeof serverUrl === "string" ? legacyGatewayUrl(serverUrl) : undefined;
  if (
    computerId &&
    storedId === computerId &&
    typeof token === "string" &&
    gatewayUrl &&
    !credentials.read()
  ) {
    try {
      credentials.write({ computerId, gatewayUrl, token });
      log.info("migration.credential_moved", { computer_id: computerId });
    } catch (error) {
      log.warn("migration.credential_failed", { error: String(error) });
      return;
    }
  }
  // A credential for another computer, or one already moved, is not used.
  rmSync(legacy, { force: true });
};

// Stops a bridge an older version left running, so it does not keep the
// computer connected with the old credential. Best effort.
export const retireLegacyBridge = async (
  stateDirectory: string,
  version: string,
  log: Logger,
  connect: typeof connectLegacyBridge = connectLegacyBridge,
): Promise<void> => {
  let client: LegacyBridgeClient;
  try {
    ({ client } = await connect({
      stateDirectory,
      client: { name: "desktop", version },
    }));
  } catch {
    return;
  }
  log.info("migration.bridge_retiring");
  const closed = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, RETIRE_TIMEOUT_MS);
    client.onClose(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  await client
    .request({ op: "shutdown", reason: "upgrade" })
    .catch(() => undefined);
  await closed;
  client.close();
};
