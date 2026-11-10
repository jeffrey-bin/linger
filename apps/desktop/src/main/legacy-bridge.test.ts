import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bridgeSocketPath,
  connectLegacyBridge,
  defaultBridgeStateDirectory,
} from "./legacy-bridge.js";
import { retireLegacyBridge } from "./legacy-migration.js";

const frame = (value: unknown): Buffer => {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
};

// A stand-in for the 0.16 bridge: checks the token, then stops on shutdown.
const fakeBridge = (stateDirectory: string, token: string) => {
  const received: Array<Record<string, unknown>> = [];
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (
        buffer.length >= 4 &&
        buffer.length >= 4 + buffer.readUInt32BE(0)
      ) {
        const length = buffer.readUInt32BE(0);
        const message = JSON.parse(
          buffer.subarray(4, 4 + length).toString("utf8"),
        ) as Record<string, unknown>;
        buffer = buffer.subarray(4 + length);
        received.push(message);
        if (message.op === "hello" && message.token !== token) {
          socket.write(
            frame({
              op: "error",
              rid: message.rid,
              ok: false,
              code: "IPC_UNAUTHENTICATED",
              message: "bad token",
            }),
          );
          continue;
        }
        socket.write(frame({ op: "result", rid: message.rid, ok: true }));
        if (message.op === "shutdown") socket.end();
      }
    });
  });
  return {
    received,
    server,
    listen: () => {
      // A long state path puts the socket under /tmp, as the bridge did.
      const socketPath = bridgeSocketPath(stateDirectory);
      mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
      return new Promise<void>((resolve) => server.listen(socketPath, resolve));
    },
  };
};

const servers: net.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise((r) => s.close(r))),
  );
});

describe.skipIf(process.platform === "win32")("legacy bridge socket", () => {
  it("authenticates and asks a running bridge to shut down", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "bridge-"));
    writeFileSync(path.join(dir, "ipc-token"), "secret\n");
    const bridge = fakeBridge(dir, "secret");
    servers.push(bridge.server);
    await bridge.listen();

    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await retireLegacyBridge(dir, "0.17.0", log);

    expect(bridge.received.map((m) => m.op)).toEqual(["hello", "shutdown"]);
    expect(bridge.received[1]).toMatchObject({ reason: "upgrade" });
    expect(log.info).toHaveBeenCalledWith("migration.bridge_retiring");
  });

  it("fails to connect with a wrong token", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "bridge-"));
    writeFileSync(path.join(dir, "ipc-token"), "stale");
    const bridge = fakeBridge(dir, "secret");
    servers.push(bridge.server);
    await bridge.listen();

    await expect(
      connectLegacyBridge({
        stateDirectory: dir,
        client: { name: "desktop", version: "0.17.0" },
      }),
    ).rejects.toThrow();
  });
});

describe("defaultBridgeStateDirectory", () => {
  it("matches the 0.16 bridge layout", () => {
    expect(defaultBridgeStateDirectory("darwin", {}, "/Users/a")).toBe(
      "/Users/a/Library/Application Support/Simplex/bridge",
    );
    expect(defaultBridgeStateDirectory("linux", {}, "/home/a")).toBe(
      "/home/a/.local/state/simplex/bridge",
    );
    expect(
      defaultBridgeStateDirectory("linux", { LINGER_BRIDGE_STATE_DIR: "/x" }),
    ).toBe("/x");
  });
});
