import { defineConfig, devices } from "@playwright/test";

import {
  realServiceE2ESpecs,
  roomDocumentE2EShards,
} from "./playwright.e2e-specs";

const webPort = process.env.PLAYWRIGHT_ROOM_DOCUMENT_WEB_PORT ?? "3008";
const webUrl = `http://127.0.0.1:${webPort}`;
const runtimePort = process.env.PLAYWRIGHT_ROOM_DOCUMENT_RUNTIME_PORT ?? "4328";
const controlPort = process.env.PLAYWRIGHT_ROOM_DOCUMENT_CONTROL_PORT ?? "8088";
const teamHubPort = process.env.PLAYWRIGHT_ROOM_DOCUMENT_TEAMHUB_PORT ?? "8089";
const postgresPort =
  process.env.PLAYWRIGHT_ROOM_DOCUMENT_POSTGRES_PORT ?? "54343";
const shouldManageWebServers = process.env.PLAYWRIGHT_SKIP_WEB_SERVER !== "1";

function roomDocumentTestMatch(): string[] {
  const rawShard = process.env.ROOM_DOCUMENT_E2E_SHARD;
  if (!rawShard) {
    return [...realServiceE2ESpecs];
  }
  const match = /^(\d+)\/(\d+)$/.exec(rawShard);
  const current = Number(match?.[1]);
  const total = Number(match?.[2]);
  const shardCount = roomDocumentE2EShards.length;
  if (!match || total !== shardCount || current < 1 || current > total) {
    throw new Error(
      `ROOM_DOCUMENT_E2E_SHARD must use current/${shardCount} with 1 <= current <= ${shardCount}, got ${rawShard}`,
    );
  }
  const files = roomDocumentE2EShards[current - 1];
  if (!files) {
    throw new Error(
      `ROOM_DOCUMENT_E2E_SHARD must use current/${shardCount} with 1 <= current <= ${shardCount}, got ${rawShard}`,
    );
  }
  return [...files];
}

export default defineConfig({
  testDir: "../apps/web/e2e",
  testMatch: roomDocumentTestMatch(),
  timeout: 90_000,
  // File-list shards already partition the suite; Playwright shard: would split again.
  fullyParallel: true,
  workers: 1,
  retries: 0,
  outputDir: "../test-results/room-document",
  reporter: process.env.CI
    ? [
        ["dot"],
        [
          "html",
          { open: "never", outputFolder: "../playwright-report/room-document" },
        ],
      ]
    : "list",
  expect: {
    timeout: 5_000,
  },
  use: {
    baseURL: webUrl,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  webServer: shouldManageWebServers
    ? [
        {
          command: `pnpm --filter @linger/web run build:assets && PLAYWRIGHT_ROOM_DOCUMENT_WEB_PORT=${webPort} PLAYWRIGHT_ROOM_DOCUMENT_TEAMHUB_PORT=${teamHubPort} PLAYWRIGHT_ROOM_DOCUMENT_RUNTIME_PORT=${runtimePort} pnpm --filter @linger/web exec node e2e/room-startup-production-server.mjs`,
          cwd: "..",
          reuseExistingServer: false,
          timeout: 180_000,
          url: `${webUrl}/healthz`,
        },
        {
          command: `WEB_PUBLIC_ORIGIN=${webUrl} TEAMHUB_TEST_POSTGRES_PORT=${postgresPort} ROOM_DOCUMENT_E2E_CONTROL_PORT=${controlPort} ROOM_DOCUMENT_E2E_TEAMHUB_PORT=${teamHubPort} ROOM_DOCUMENT_E2E_RUNTIME_PORT=${runtimePort} ROOM_DOCUMENT_E2E_TEAMHUB_STARTUP_TIMEOUT_MS=120000 apps/teamhub/scripts/with-test-database.sh pnpm --filter @linger/node-services exec tsx tests/document/realtime-e2e-harness.ts`,
          cwd: "..",
          stdout: "pipe",
          gracefulShutdown: { signal: "SIGTERM", timeout: 30_000 },
          reuseExistingServer: false,
          timeout: 180_000,
          url: `http://127.0.0.1:${controlPort}/healthz`,
        },
      ]
    : undefined,
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        permissions: ["clipboard-read", "clipboard-write"],
        // CI cannot reach Google Fonts; fail at DNS instead of hanging page loads.
        launchOptions: {
          args: [
            "--host-resolver-rules=MAP fonts.googleapis.com ~NOTFOUND, MAP fonts.gstatic.com ~NOTFOUND",
          ],
        },
      },
    },
  ],
});
