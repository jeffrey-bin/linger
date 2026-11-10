import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  liveKitConfig,
  liveKitEnvironment,
  prepareLiveKitSettings,
  readLiveKitSettings,
  startNativeLiveKit,
} from "./native-livekit.js";
import { inspectNativeProcess, stopNativeProcess } from "./native-process.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await stopNativeProcess(root, "livekit").catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
async function temp() {
  const root = await mkdtemp(path.join(tmpdir(), "native-livekit-"));
  roots.push(root);
  return root;
}

test("an instance keeps its LiveKit ports and keys in an owner-only file", async () => {
  const root = await temp();
  const reserved = new Set([1]);
  const settings = await prepareLiveKitSettings(root, reserved);
  expect(settings.httpPort).not.toBe(settings.rtcPort);
  expect(reserved).toEqual(new Set([1, settings.httpPort, settings.rtcPort]));
  expect(settings.apiSecret).toMatch(/^[a-f0-9]{64}$/);
  if (process.platform !== "win32")
    expect((await stat(path.join(root, "livekit.env"))).mode & 0o777).toBe(
      0o600,
    );
  expect(await prepareLiveKitSettings(root, new Set())).toEqual(settings);
  expect(await readLiveKitSettings(root)).toEqual(settings);
  // A damaged file is made again rather than half used.
  await writeFile(path.join(root, "livekit.env"), "LIVEKIT_HTTP_PORT=80\n");
  expect(await readLiveKitSettings(root)).toBeUndefined();
  expect(await prepareLiveKitSettings(root, new Set())).not.toEqual(settings);
});

test("LiveKit listens on loopback only, with Docker's names for its address", () => {
  const settings = {
    httpPort: 30000,
    rtcPort: 30001,
    apiKey: "APIabcdef123456",
    apiSecret: "s".repeat(64),
  };
  expect(liveKitEnvironment(settings)).toEqual({
    LIVEKIT_URL: "ws://127.0.0.1:30000",
    LIVEKIT_API_URL: "http://127.0.0.1:30000",
    LIVEKIT_API_KEY: settings.apiKey,
    LIVEKIT_API_SECRET: settings.apiSecret,
  });
  const config = liveKitConfig(settings);
  expect(JSON.parse(config)).toMatchObject({
    port: 30000,
    bind_addresses: ["127.0.0.1"],
    // ICE/TCP would listen on every interface.
    rtc: { tcp_port: 0, udp_port: 30001, node_ip: "127.0.0.1" },
  });
  expect(config).not.toContain(settings.apiSecret);
});

test.skipIf(process.platform === "win32")(
  "starts LiveKit, waits for its health check and never logs the secret",
  async () => {
    const root = await temp();
    const settings = await prepareLiveKitSettings(root, new Set());
    // A stand-in server: answers GET / with OK on the configured port and
    // prints the keys it was given.
    const server = path.join(root, "livekit-server");
    const code = `const port=JSON.parse(process.argv[1]).port;console.log(process.env.LIVEKIT_KEYS);require('node:http').createServer((q,s)=>s.end('OK')).listen(port,'127.0.0.1')`;
    await writeFile(
      server,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)} "$2"\n`,
      { mode: 0o755 },
    );
    await startNativeLiveKit({
      root,
      executable: server,
      settings,
      signal: new AbortController().signal,
    });
    expect((await inspectNativeProcess(root, "livekit")).running).toBe(true);
    const log = await readFile(
      path.join(root, "native/logs/livekit.log"),
      "utf8",
    );
    expect(log).toContain(settings.apiKey);
    expect(log).not.toContain(settings.apiSecret);
    await stopNativeProcess(root, "livekit");
    expect((await inspectNativeProcess(root, "livekit")).running).toBe(false);
  },
);
