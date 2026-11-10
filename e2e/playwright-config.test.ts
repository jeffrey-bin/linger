import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  roomDocumentE2ESpecs,
  roomE2ESpecs,
  realServiceE2ESpecs,
  roomDocumentE2EShards,
} from "./playwright.e2e-specs";
import { blockExternalFonts } from "../apps/web/e2e/room-document-collaboration-test-support";

const e2eDir = join(process.cwd(), "apps/web/e2e");
describe("Playwright suite layering", () => {
  afterEach(() => vi.unstubAllEnvs());

  beforeEach(() => {
    vi.resetModules();
    delete process.env.PLAYWRIGHT_SKIP_WEB_SERVER;
    delete process.env.ROOM_DOCUMENT_E2E_SHARD;
    delete process.env.CI;
  });

  it("classifies every E2E spec exactly once in the real-service suite", () => {
    const discoveredSpecs = readdirSync(e2eDir)
      .filter((file) => file.endsWith(".spec.ts"))
      .sort();
    const classifiedSpecs = [...realServiceE2ESpecs].sort();

    expect(new Set(classifiedSpecs).size).toBe(classifiedSpecs.length);
    expect(classifiedSpecs).toEqual(discoveredSpecs);
  });

  it.each([undefined, "8189"])(
    "authenticates Room Document contexts through the real TeamHub session endpoint with port %s",
    async (port) => {
      vi.stubEnv("PLAYWRIGHT_ROOM_DOCUMENT_TEAMHUB_PORT", port);
      const { authenticateRoomDocumentContext } =
        await import("../apps/web/e2e/room-document-collaboration-test-support");
      const response = { ok: vi.fn(() => true), status: vi.fn(() => 200) };
      const post = vi.fn(async () => response);

      await authenticateRoomDocumentContext(
        { request: { post } } as never,
        "alice",
      );

      expect(post).toHaveBeenCalledWith(
        `http://127.0.0.1:${port ?? "8089"}/v0/auth/login`,
        {
          data: {
            identifier: "alice@example.com",
            password: "teamhub-dev-alice",
          },
        },
      );
    },
  );

  it("fails Room Document setup when TeamHub rejects the session", async () => {
    const { authenticateRoomDocumentContext } =
      await import("../apps/web/e2e/room-document-collaboration-test-support");
    const response = { ok: vi.fn(() => false), status: vi.fn(() => 401) };

    await expect(
      authenticateRoomDocumentContext(
        { request: { post: vi.fn(async () => response) } } as never,
        "bob",
      ),
    ).rejects.toThrow("Room Document E2E login failed with status 401");
  });

  it("keeps Room and Document scenarios in separate groups of the real-service suite", async () => {
    const config = (await import("./playwright.room-document.config")).default;

    expect(config.testMatch).toEqual(realServiceE2ESpecs);
    expect(roomE2ESpecs).toContain("room-startup-production.spec.ts");
    expect(roomE2ESpecs).toContain("room-routines.spec.ts");
    expect(
      roomDocumentE2ESpecs.every((spec) => spec.startsWith("room-document-")),
    ).toBe(true);
    expect(realServiceE2ESpecs).toEqual([
      "room-login-chain.spec.ts",
      ...roomE2ESpecs,
      ...roomDocumentE2ESpecs,
    ]);
    expect(config.fullyParallel).toBe(true);
    expect(config.workers).toBe(1);
    expect(config.outputDir).toBe("../test-results/room-document");
  });

  it("runs shared Room Document config checks only on the first CI shard", () => {
    const makefile = readFileSync("Makefile", "utf8");
    const target = makefile.match(
      /check-e2e-room-document:\n([\s\S]*?)\n\S/,
    )?.[1];

    expect(target).toContain('ROOM_DOCUMENT_E2E_SHARD%%/*}" = "1"');
    expect(target?.match(/pnpm test:e2e:config/g)).toHaveLength(1);
    expect(target?.match(/pnpm test:e2e:room-document/g)).toHaveLength(1);
  });

  it("assigns every real-service spec to exactly one Room Document file shard", () => {
    const assigned = roomDocumentE2EShards.flat();
    expect(new Set(assigned).size).toBe(assigned.length);
    expect([...assigned].sort()).toEqual([...realServiceE2ESpecs].sort());
  });

  it("selects each Room Document shard by file list and keeps the unsharded union", async () => {
    const unsharded = (await import("./playwright.room-document.config"))
      .default;
    expect(unsharded.shard).toBeUndefined();
    expect(unsharded.testMatch).toEqual([...realServiceE2ESpecs]);

    const shardedMatches: string[] = [];
    for (const [index, files] of roomDocumentE2EShards.entries()) {
      vi.resetModules();
      process.env.ROOM_DOCUMENT_E2E_SHARD = `${index + 1}/${roomDocumentE2EShards.length}`;
      const config = (await import("./playwright.room-document.config"))
        .default;
      expect(config.shard).toBeUndefined();
      expect(config.testMatch).toEqual([...files]);
      shardedMatches.push(...(config.testMatch as string[]));
    }
    expect(shardedMatches.sort()).toEqual([...realServiceE2ESpecs].sort());

    vi.resetModules();
    process.env.ROOM_DOCUMENT_E2E_SHARD = "3/2";
    await expect(import("./playwright.room-document.config")).rejects.toThrow(
      `ROOM_DOCUMENT_E2E_SHARD must use current/${roomDocumentE2EShards.length}`,
    );

    vi.resetModules();
    process.env.ROOM_DOCUMENT_E2E_SHARD = "1/2";
    await expect(import("./playwright.room-document.config")).rejects.toThrow(
      `ROOM_DOCUMENT_E2E_SHARD must use current/${roomDocumentE2EShards.length}`,
    );
  });

  it("blocks external fonts from Room Document navigation", async () => {
    const route = vi.fn();
    await blockExternalFonts({ route } as never);

    expect(route).toHaveBeenCalledOnce();
    const [matcher, handler] = route.mock.calls[0] as unknown as [
      RegExp,
      (route: { abort: (errorCode: string) => Promise<void> }) => Promise<void>,
    ];
    expect(matcher.test("https://fonts.googleapis.com/css2?family=Inter")).toBe(
      true,
    );
    expect(
      matcher.test("https://fonts.gstatic.com/s/inter/example.woff2"),
    ).toBe(true);
    expect(matcher.test("http://127.0.0.1:3008/src/main.tsx")).toBe(false);

    const abort = vi.fn().mockResolvedValue(undefined);
    await handler({ abort });
    expect(abort).toHaveBeenCalledOnce();
    expect(abort).toHaveBeenCalledWith("blockedbyclient");
  });

  it.each([
    ["3008", "8089", "4328"],
    ["23008", "28089", "24328"],
  ])(
    "builds production Web before serving the real-service suite on port %s",
    async (webPort, teamHubPort, runtimePort) => {
      vi.stubEnv("PLAYWRIGHT_ROOM_DOCUMENT_WEB_PORT", webPort);
      vi.stubEnv("PLAYWRIGHT_ROOM_DOCUMENT_TEAMHUB_PORT", teamHubPort);
      vi.stubEnv("PLAYWRIGHT_ROOM_DOCUMENT_RUNTIME_PORT", runtimePort);
      const config = (await import("./playwright.room-document.config"))
        .default;
      const webServers = Array.isArray(config.webServer)
        ? config.webServer
        : [config.webServer];

      expect(webServers).toHaveLength(2);
      expect(webServers[0]?.command).toContain("@linger/web run build:assets");
      expect(webServers[0]?.command).toContain(
        "room-startup-production-server.mjs",
      );
      expect(webServers[0]?.command).toContain(
        `PLAYWRIGHT_ROOM_DOCUMENT_WEB_PORT=${webPort}`,
      );
      expect(webServers[0]?.command).toContain(
        `PLAYWRIGHT_ROOM_DOCUMENT_TEAMHUB_PORT=${teamHubPort}`,
      );
      expect(webServers[0]?.command).toContain(
        `PLAYWRIGHT_ROOM_DOCUMENT_RUNTIME_PORT=${runtimePort}`,
      );
      expect(webServers[0]?.command).not.toContain("@linger/web exec vite");
      expect(webServers[0]?.timeout).toBe(180_000);
      expect(webServers[1]?.command).toContain("realtime-e2e-harness.ts");
      expect(webServers[1]?.command).toContain(
        `WEB_PUBLIC_ORIGIN=${config.use?.baseURL}`,
      );
      expect(webServers[1]?.command).toContain("with-test-database.sh");
      expect(webServers[1]?.gracefulShutdown).toEqual({
        signal: "SIGTERM",
        timeout: 30_000,
      });
      expect(webServers[1]?.command).toContain("TEAMHUB_TEST_POSTGRES_PORT=");
      expect(webServers[1]?.command).toContain(
        "ROOM_DOCUMENT_E2E_TEAMHUB_STARTUP_TIMEOUT_MS=120000",
      );
      expect(webServers[1]?.timeout).toBe(180_000);
      expect(webServers[1]?.url).toContain("/healthz");
    },
  );

  it("uses managed Chromium and independent failure evidence", async () => {
    process.env.CI = "true";
    const config = (await import("./playwright.room-document.config")).default;

    const chromiumProject = config.projects?.find(
      (project) => project.name === "chromium",
    );
    expect(chromiumProject?.use).not.toHaveProperty("channel");
    expect(chromiumProject?.use).toEqual(
      expect.objectContaining({
        permissions: expect.arrayContaining([
          "clipboard-read",
          "clipboard-write",
        ]),
      }),
    );
    expect(chromiumProject?.use?.launchOptions?.args).toContain(
      "--host-resolver-rules=MAP fonts.googleapis.com ~NOTFOUND, MAP fonts.gstatic.com ~NOTFOUND",
    );
    expect(config.retries).toBe(0);
    expect(config.use).toEqual(
      expect.objectContaining({
        screenshot: "only-on-failure",
        trace: "retain-on-failure",
        video: "retain-on-failure",
      }),
    );
    expect(config.reporter).toContainEqual([
      "html",
      { open: "never", outputFolder: "../playwright-report/room-document" },
    ]);
  });

  it("can disable service management", async () => {
    process.env.PLAYWRIGHT_SKIP_WEB_SERVER = "1";

    expect(
      (await import("./playwright.room-document.config")).default.webServer,
    ).toBe(undefined);
  });
});
