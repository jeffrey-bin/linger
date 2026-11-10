import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  createLocalComputerRouteHandlers,
  LocalComputerHttpError,
} from "../../../../src/agent/executor/http/local-computer-http.js";
import {
  LocalBrowserConnectionError,
  LocalComputerCapabilityError,
  LocalComputerOfflineError,
  type LocalBrowserConnectionCommand,
  type LocalComputerManagement,
} from "../../../../src/agent/runner-gateway/local-computer-management.js";

const token = "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2H1g0F_-";
const path =
  "/v1/tenants/tenant-1/owners/actor-1/local-computers/computer-1/browser-connection";
const status = {
  mode: "user_chrome",
  state: "connected",
  platform: "darwin",
} as const;

const createApp = (
  connectLocalBrowser: (
    command: LocalBrowserConnectionCommand,
  ) => Promise<typeof status>,
) => {
  const handlers = createLocalComputerRouteHandlers({
    localComputerManagement: {
      connectLocalBrowser,
    } as unknown as LocalComputerManagement,
    pathId: (context, name) => context.req.param(name) ?? "",
    readJsonBody: (context) => context.req.json(),
  });
  const app = new Hono();
  app.get(
    "/v1/tenants/:tenantId/owners/:ownerActorId/local-computers/:computerId/browser-connection",
    handlers.getLocalComputerBrowserConnection,
  );
  app.put(
    "/v1/tenants/:tenantId/owners/:ownerActorId/local-computers/:computerId/browser-connection",
    handlers.configureLocalComputerBrowserConnection,
  );
  app.delete(
    "/v1/tenants/:tenantId/owners/:ownerActorId/local-computers/:computerId/browser-connection",
    handlers.disconnectLocalComputerBrowserConnection,
  );
  app.onError((error, context) =>
    error instanceof LocalComputerHttpError
      ? context.json({ code: error.errorCode }, error.status)
      : context.json({ code: "internal" }, 500),
  );
  return app;
};

describe("Agent Management browser connection routes", () => {
  it("forwards a configure command and returns only the status", async () => {
    const connect = vi.fn(
      async (_command: LocalBrowserConnectionCommand) => status,
    );
    const response = await createApp(connect).request(path, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ extension_token: token, profile: "Profile 2" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.text();
    expect(JSON.parse(body)).toEqual(status);
    expect(body).not.toContain(token);
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        ownerActorId: "actor-1",
        computerId: "computer-1",
        action: "configure",
        profile: "Profile 2",
        extensionToken: token,
      }),
    );
  });

  it("rejects an invalid token without echoing it or calling the Computer", async () => {
    const connect = vi.fn(
      async (_command: LocalBrowserConnectionCommand) => status,
    );
    const invalid = "PLAYWRIGHT_MCP_EXTENSION_TOKEN=" + token;
    const response = await createApp(connect).request(path, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ extension_token: invalid }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(token);
    expect(connect).not.toHaveBeenCalled();
  });

  it("sends status and disconnect without a token", async () => {
    const connect = vi.fn(
      async (_command: LocalBrowserConnectionCommand) => status,
    );
    const app = createApp(connect);
    expect((await app.request(path)).status).toBe(200);
    expect((await app.request(path, { method: "DELETE" })).status).toBe(200);
    expect(connect.mock.calls.map(([command]) => command.action)).toEqual([
      "status",
      "disconnect",
    ]);
    for (const [command] of connect.mock.calls) {
      expect(command).not.toHaveProperty("extensionToken");
    }
  });

  it.each([
    [new LocalComputerOfflineError(), 503, "local_computer_offline"],
    [
      new LocalComputerCapabilityError(),
      409,
      "browser_connection_capability_unavailable",
    ],
    [
      new LocalBrowserConnectionError(
        "BROWSER_CONNECTION_TIMEOUT",
        "timed out",
        true,
      ),
      503,
      "BROWSER_CONNECTION_TIMEOUT",
    ],
    [
      new LocalBrowserConnectionError("BROWSER_FAILED", "failed", false),
      502,
      "BROWSER_FAILED",
    ],
  ])("maps %s to HTTP %i", async (error, expectedStatus, code) => {
    const response = await createApp(async () => {
      throw error;
    }).request(path);
    expect(response.status).toBe(expectedStatus);
    expect(await response.json()).toEqual({ code });
  });
});
