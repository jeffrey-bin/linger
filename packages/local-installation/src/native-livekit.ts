import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import net from "node:net";
import path from "node:path";
import { parseEnv } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { atomicPrivate, readPrivate } from "./instance.js";
import { inspectNativeProcess, startNativeProcess } from "./native-process.js";

// The LiveKit server Native voice runs, as docker-compose.yml runs it for
// Docker: the voice workers and the browser meet there. It listens on
// loopback only: signalling over HTTP/WebSocket on `httpPort` and media over
// UDP on `rtcPort`. LiveKit's ICE/TCP fallback always listens on every
// interface, so Native turns it off; on one computer UDP over loopback
// always works.
export interface LiveKitSettings {
  httpPort: number;
  rtcPort: number;
  apiKey: string;
  apiSecret: string;
}
const settingsFile = (root: string) => path.join(root, "livekit.env");

function parseSettings(text: string): LiveKitSettings | undefined {
  const values = parseEnv(text);
  const port = (value: string | undefined) => {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 1024 && number <= 65535
      ? number
      : undefined;
  };
  const httpPort = port(values.LIVEKIT_HTTP_PORT);
  const rtcPort = port(values.LIVEKIT_RTC_PORT);
  const apiKey = values.LIVEKIT_API_KEY;
  const apiSecret = values.LIVEKIT_API_SECRET;
  if (
    !httpPort ||
    !rtcPort ||
    !apiKey ||
    !/^[A-Za-z0-9]{8,64}$/.test(apiKey) ||
    !apiSecret ||
    !/^[A-Za-z0-9]{32,128}$/.test(apiSecret)
  )
    return undefined;
  return { httpPort, rtcPort, apiKey, apiSecret };
}
/** The instance's LiveKit ports and keys, when it has them. */
export async function readLiveKitSettings(
  root: string,
): Promise<LiveKitSettings | undefined> {
  const text = await readPrivate(settingsFile(root));
  return text === undefined ? undefined : parseSettings(text);
}
async function freeTcpPort(reserved: Set<number>): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as net.AddressInfo;
        server.close((error) => (error ? reject(error) : resolve(port)));
      });
    });
    if (!reserved.has(port)) {
      reserved.add(port);
      return port;
    }
  }
}
async function freeUdpPort(reserved: Set<number>): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const socket = createSocket("udp4");
      socket.once("error", reject);
      socket.bind(0, "127.0.0.1", () => {
        const { port } = socket.address();
        socket.close(() => resolve(port));
      });
    });
    if (!reserved.has(port)) {
      reserved.add(port);
      return port;
    }
  }
}
/**
 * The instance's LiveKit ports and keys, made once and kept in the
 * owner-only livekit.env so services and LiveKit agree across restarts.
 * `reserved` holds the ports other instances and services use.
 */
export async function prepareLiveKitSettings(
  root: string,
  reserved: Set<number>,
): Promise<LiveKitSettings> {
  const existing = await readLiveKitSettings(root);
  if (existing) return existing;
  const settings: LiveKitSettings = {
    httpPort: await freeTcpPort(reserved),
    rtcPort: await freeUdpPort(reserved),
    // LiveKit signs access tokens with the secret; it needs 32+ characters.
    apiKey: `API${randomBytes(6).toString("hex")}`,
    apiSecret: randomBytes(32).toString("hex"),
  };
  await atomicPrivate(
    settingsFile(root),
    [
      `LIVEKIT_HTTP_PORT=${settings.httpPort}`,
      `LIVEKIT_RTC_PORT=${settings.rtcPort}`,
      `LIVEKIT_API_KEY=${settings.apiKey}`,
      `LIVEKIT_API_SECRET=${settings.apiSecret}`,
    ].join("\n") + "\n",
  );
  return settings;
}
/** The names TeamHub, node-services and the voice workers read, as in Docker. */
export function liveKitEnvironment(settings: LiveKitSettings) {
  return {
    LIVEKIT_URL: `ws://127.0.0.1:${settings.httpPort}`,
    LIVEKIT_API_URL: `http://127.0.0.1:${settings.httpPort}`,
    LIVEKIT_API_KEY: settings.apiKey,
    LIVEKIT_API_SECRET: settings.apiSecret,
  };
}
/**
 * The LiveKit configuration of docker-compose.yml for this instance's ports, as one line of
 * YAML (JSON) for --config-body: the command line records the ports, so a
 * change restarts LiveKit. No webhook, as in Docker; keys come from the
 * environment.
 */
export function liveKitConfig(settings: LiveKitSettings): string {
  return JSON.stringify({
    port: settings.httpPort,
    bind_addresses: ["127.0.0.1"],
    rtc: {
      tcp_port: 0,
      udp_port: settings.rtcPort,
      use_external_ip: false,
      node_ip: "127.0.0.1",
      enable_loopback_candidate: true,
      ips: { includes: ["127.0.0.1/32"] },
    },
    logging: { level: "info" },
  });
}
/** Whether LiveKit answers its health check (GET / is "OK"). */
export async function liveKitReady(
  root: string,
  settings: LiveKitSettings,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    if (!(await inspectNativeProcess(root, "livekit")).running) return false;
    const response = await fetch(`http://127.0.0.1:${settings.httpPort}/`, {
      redirect: "error",
      signal: AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(2_000),
      ]),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}
/** Starts (or keeps) the instance's LiveKit and waits until it is healthy. */
export async function startNativeLiveKit(options: {
  root: string;
  executable: string;
  settings: LiveKitSettings;
  signal: AbortSignal;
  timeoutMs?: number;
}) {
  const { settings } = options;
  await startNativeProcess({
    root: options.root,
    name: "livekit",
    executable: options.executable,
    args: ["--config-body", liveKitConfig(settings)],
    cwd: path.join(options.root, "native"),
    // Only what a program needs to run, and the keys, never in its arguments.
    env: {
      PATH: process.env.PATH,
      ...(process.platform === "win32"
        ? { SystemRoot: process.env.SystemRoot }
        : {}),
      LIVEKIT_KEYS: `${settings.apiKey}: ${settings.apiSecret}`,
    },
    signal: options.signal,
    redactions: [settings.apiSecret],
    restartOnConfigurationChange: true,
  });
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  for (;;) {
    if (await liveKitReady(options.root, settings, options.signal)) return;
    if (!(await inspectNativeProcess(options.root, "livekit")).running)
      throw new Error(
        `Native LiveKit stopped during startup. Inspect ${path.join(options.root, "native/logs/livekit.log")}.`,
      );
    if (Date.now() >= deadline)
      throw new Error(
        `Native LiveKit did not become ready. Inspect ${path.join(options.root, "native/logs/livekit.log")}.`,
      );
    await delay(250, undefined, { signal: options.signal });
  }
}
