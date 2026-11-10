import { RealRealtimeE2EEnvironment } from "./realtime-e2e-environment.js";
import { startRealtimeE2EHttpHarness } from "./realtime-e2e-http-harness.js";

const controlPort = readPort("ROOM_DOCUMENT_E2E_CONTROL_PORT", 8088);
const runtimePort = readPort("ROOM_DOCUMENT_E2E_RUNTIME_PORT", 4328);
const teamHubPort = readPort("ROOM_DOCUMENT_E2E_TEAMHUB_PORT", 8089);
const teamHubStartupTimeoutMs = readPositiveInteger(
  "ROOM_DOCUMENT_E2E_TEAMHUB_STARTUP_TIMEOUT_MS",
  120_000,
);
const environment = new RealRealtimeE2EEnvironment({
  runtimePort,
  teamHubPort,
  teamHubStartupTimeoutMs,
  // Arguments after the script go to TeamHub, such as the Connected Apps
  // proof's -composio-base-url.
  teamHubArgs: process.argv.slice(2),
});

try {
  await environment.startTeamHub();
  await startRealtimeE2EHttpHarness(environment, controlPort);
  await environment.startRuntime();
  environment.markReady();
} catch (error) {
  await environment.stop();
  throw error;
}

function readPort(name: string, fallback: number): number {
  const value = readPositiveInteger(name, fallback);
  if (value > 65_535) {
    throw new TypeError(`${name} must be an integer in 1..65535`);
  }
  return value;
}

function readPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}
