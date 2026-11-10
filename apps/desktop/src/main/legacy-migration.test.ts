import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { CredentialStore } from "./computer-credential.js";
import { ConfigStore } from "./config.js";
import {
  legacyGatewayUrl,
  migrateLegacyComputer,
  retireLegacyBridge,
} from "./legacy-migration.js";

const TOKEN = "sr1.legacy-credential-0123456789abcdefghij";

const setup = (computerId = "computer-1") => {
  const root = mkdtempSync(path.join(os.tmpdir(), "legacy-migration-"));
  const layout = {
    bridgeStateDirectory: path.join(root, "bridge"),
    runtimeDirectory: path.join(root, "runtime"),
    daemonStateDirectory: path.join(root, "computer/state"),
  };
  mkdirSync(layout.bridgeStateDirectory, { recursive: true });
  mkdirSync(layout.runtimeDirectory, { recursive: true });
  const config = new ConfigStore(path.join(root, "config.json"));
  config.update({ computerId, tenantId: "tenant-1" });
  const credentials = new CredentialStore(
    path.join(root, "computer/credential.json"),
  );
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { layout, config, credentials, log };
};

const writeLegacy = (
  layout: { bridgeStateDirectory: string; runtimeDirectory: string },
  computerId = "computer-1",
) => {
  writeFileSync(
    path.join(layout.bridgeStateDirectory, "credential.json"),
    JSON.stringify({
      serverUrl: "https://linger.example",
      computerId,
      token: TOKEN,
    }),
  );
  writeFileSync(
    path.join(layout.runtimeDirectory, "daemon-identity.json"),
    '{"identity":"kept"}',
  );
};

describe("migrateLegacyComputer", () => {
  it("keeps the identity and moves the credential without logging it", () => {
    const { layout, config, credentials, log } = setup();
    writeLegacy(layout);
    migrateLegacyComputer(layout, config, credentials, log);
    expect(credentials.read()).toEqual({
      computerId: "computer-1",
      gatewayUrl: "wss://linger.example/v1/runner-gateway",
      token: TOKEN,
    });
    expect(
      readFileSync(
        path.join(layout.daemonStateDirectory, "daemon-identity.json"),
        "utf8",
      ),
    ).toBe('{"identity":"kept"}');
    expect(
      existsSync(path.join(layout.runtimeDirectory, "daemon-identity.json")),
    ).toBe(false);
    expect(
      existsSync(path.join(layout.bridgeStateDirectory, "credential.json")),
    ).toBe(false);
    expect(JSON.stringify(log.info.mock.calls)).not.toContain(TOKEN);
  });

  it("drops a credential of another computer", () => {
    const { layout, config, credentials, log } = setup();
    writeLegacy(layout, "computer-2");
    migrateLegacyComputer(layout, config, credentials, log);
    expect(credentials.read()).toBeUndefined();
    expect(
      existsSync(path.join(layout.bridgeStateDirectory, "credential.json")),
    ).toBe(false);
  });

  it("keeps what the daemon already has", () => {
    const { layout, config, credentials, log } = setup();
    mkdirSync(layout.daemonStateDirectory, { recursive: true });
    writeFileSync(
      path.join(layout.daemonStateDirectory, "daemon-identity.json"),
      '{"identity":"new"}',
    );
    const current = {
      computerId: "computer-1",
      gatewayUrl: "ws://192.168.1.2:3000/v1/runner-gateway",
      token: "sr1.current-credential-0123456789abcdefghij",
    };
    credentials.write(current);
    writeLegacy(layout);
    migrateLegacyComputer(layout, config, credentials, log);
    expect(credentials.read()).toEqual(current);
    expect(
      readFileSync(
        path.join(layout.daemonStateDirectory, "daemon-identity.json"),
        "utf8",
      ),
    ).toBe('{"identity":"new"}');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("does nothing on a new install", () => {
    const { layout, config, credentials, log } = setup();
    migrateLegacyComputer(layout, config, credentials, log);
    expect(credentials.read()).toBeUndefined();
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe("legacyGatewayUrl", () => {
  it("derives the Gateway from the server origin", () => {
    expect(legacyGatewayUrl("http://192.168.1.2:3000/app")).toBe(
      "ws://192.168.1.2:3000/v1/runner-gateway",
    );
    expect(legacyGatewayUrl("file:///tmp")).toBeUndefined();
    expect(legacyGatewayUrl("not a url")).toBeUndefined();
  });
});

describe("retireLegacyBridge", () => {
  it("asks a running bridge to shut down and waits until it closed", async () => {
    let closed: (() => void) | undefined;
    const client = {
      onClose: (listener: () => void) => {
        closed = listener;
        return () => {};
      },
      request: vi.fn(async () => {
        setImmediate(() => closed?.());
        return {};
      }),
      close: vi.fn(),
    };
    const connect = vi.fn(async () => ({ client }));
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await retireLegacyBridge(
      "/tmp/bridge",
      "0.17.0",
      log,
      connect as unknown as Parameters<typeof retireLegacyBridge>[3],
    );
    expect(client.request).toHaveBeenCalledWith({
      op: "shutdown",
      reason: "upgrade",
    });
    expect(client.close).toHaveBeenCalled();
  });

  it("does nothing without a bridge", async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await retireLegacyBridge("/tmp/bridge", "0.17.0", log, () =>
      Promise.reject(new Error("ENOENT")),
    );
    expect(log.info).not.toHaveBeenCalled();
  });
});
