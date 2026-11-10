import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// Just enough of the Desktop 0.16 bridge layout and local socket to find its
// state and ask a running bridge to stop. Removable with legacy-migration.ts.

const SOCKET_FILE_NAME = "control.sock";
const MAX_SOCKET_PATH_BYTES = 100;
const IPC_VERSION = 1;

export const defaultBridgeStateDirectory = (
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string => {
  if (env.LINGER_BRIDGE_STATE_DIR)
    return path.resolve(env.LINGER_BRIDGE_STATE_DIR);
  if (platform === "darwin") {
    return path.join(
      home,
      "Library",
      "Application Support",
      "Simplex",
      "bridge",
    );
  }
  if (platform === "win32") {
    return path.win32.join(
      env.LOCALAPPDATA ?? path.win32.join(home, "AppData", "Local"),
      "Simplex",
      "bridge",
    );
  }
  return path.join(
    env.XDG_STATE_HOME ?? path.join(home, ".local", "state"),
    "simplex",
    "bridge",
  );
};

export const bridgeSocketPath = (
  stateDirectory: string,
  platform: NodeJS.Platform = process.platform,
): string => {
  if (platform === "win32") {
    const key = createHash("sha256")
      .update(
        path.win32.resolve(stateDirectory).replaceAll("\\", "/").toLowerCase(),
      )
      .digest("hex");
    return `\\\\.\\pipe\\linger-bridge-${key}`;
  }
  const resolved = path.resolve(stateDirectory);
  const colocated = path.join(resolved, SOCKET_FILE_NAME);
  if (Buffer.byteLength(colocated) <= MAX_SOCKET_PATH_BYTES) return colocated;
  const uid = process.getuid?.();
  if (uid === undefined)
    throw new Error("Long socket paths require a Unix user identity");
  const key = createHash("sha256").update(resolved).digest("hex");
  return path.join(
    "/tmp",
    `sx-b-${String(uid)}-${key.slice(0, 32)}`,
    SOCKET_FILE_NAME,
  );
};

export interface LegacyBridgeClient {
  request(request: { op: string; [key: string]: unknown }): Promise<unknown>;
  onClose(listener: () => void): void;
  close(): void;
}

// Frames are a 4-byte big-endian length followed by UTF-8 JSON.
const encodeFrame = (value: unknown): Buffer => {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
};

export const connectLegacyBridge = async (options: {
  readonly stateDirectory: string;
  readonly client: { name: string; version: string };
}): Promise<{ client: LegacyBridgeClient }> => {
  const token = (
    await readFile(path.join(options.stateDirectory, "ipc-token"), "utf8")
  ).trim();
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.createConnection(bridgeSocketPath(options.stateDirectory));
    s.once("connect", () => {
      s.off("error", reject);
      resolve(s);
    });
    s.once("error", reject);
  });
  const pending = new Map<
    string,
    { resolve: (data: unknown) => void; reject: (error: Error) => void }
  >();
  const closeListeners = new Set<() => void>();
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0);
      if (buffer.length < 4 + length) break;
      const body = buffer.subarray(4, 4 + length).toString("utf8");
      buffer = buffer.subarray(4 + length);
      let message: { op?: unknown; rid?: unknown; data?: unknown };
      try {
        message = JSON.parse(body) as typeof message;
      } catch {
        socket.destroy();
        return;
      }
      if (typeof message.rid !== "string") continue;
      const waiter = pending.get(message.rid);
      if (!waiter) continue;
      pending.delete(message.rid);
      if (message.op === "result") waiter.resolve(message.data);
      else waiter.reject(new Error("Bridge request failed"));
    }
  });
  socket.on("close", () => {
    for (const { reject } of pending.values())
      reject(new Error("Bridge connection closed"));
    pending.clear();
    for (const listener of closeListeners) listener();
  });
  socket.on("error", () => socket.destroy());

  const client: LegacyBridgeClient = {
    request: (request) =>
      new Promise((resolve, reject) => {
        if (socket.destroyed) {
          reject(new Error("Bridge connection closed"));
          return;
        }
        const rid = randomUUID();
        pending.set(rid, { resolve, reject });
        socket.write(encodeFrame({ ...request, rid }));
      }),
    onClose: (listener) => {
      closeListeners.add(listener);
    },
    close: () => socket.end(),
  };
  try {
    await client.request({
      op: "hello",
      v: IPC_VERSION,
      token,
      client: { ...options.client, pid: process.pid },
    });
  } catch (error) {
    socket.destroy();
    throw error;
  }
  return { client };
};
