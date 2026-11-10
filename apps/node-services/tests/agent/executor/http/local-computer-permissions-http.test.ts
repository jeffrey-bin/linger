import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  createLocalComputerRouteHandlers,
  LocalComputerHttpError,
  registerLocalComputerPermissionRoutes,
} from "../../../../src/agent/executor/http/local-computer-http.js";
import {
  LocalComputerCapabilityError,
  LocalComputerNotFoundError,
  LocalComputerOfflineError,
  LocalComputerPermissionError,
  type LocalComputerManagement,
  type LocalComputerPermissionCommand,
  type LocalComputerPermissionStatus,
} from "../../../../src/agent/runner-gateway/local-computer-management.js";

const path =
  "/v1/tenants/tenant-1/owners/actor-1/local-computers/computer-1/permissions";
const status: LocalComputerPermissionStatus = {
  platform: "linux",
  host: "standalone",
  subjects: [],
};

const createApp = (
  computerPermissions: (
    command: LocalComputerPermissionCommand,
  ) => Promise<LocalComputerPermissionStatus>,
) => {
  const handlers = createLocalComputerRouteHandlers({
    localComputerManagement: {
      computerPermissions,
    } as unknown as LocalComputerManagement,
    pathId: (context, name) => context.req.param(name) ?? "",
    readJsonBody: (context) => context.req.json(),
  });
  const app = new Hono();
  registerLocalComputerPermissionRoutes(app, handlers);
  app.onError((error, context) =>
    error instanceof LocalComputerHttpError
      ? context.json({ code: error.errorCode }, error.status)
      : context.json({ code: "internal" }, 500),
  );
  return app;
};

const post = (app: Hono, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("Agent Management computer permission routes", () => {
  it("reads the status of the owned Computer", async () => {
    const act = vi.fn(
      async (_command: LocalComputerPermissionCommand) => status,
    );
    const response = await createApp(act).request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(status);
    expect(act).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        ownerActorId: "actor-1",
        computerId: "computer-1",
        action: "status",
      }),
    );
    expect(act.mock.calls[0]![0]).not.toHaveProperty("subject");
  });

  it("forwards prompt, open_settings, and relaunch steps", async () => {
    const act = vi.fn(
      async (_command: LocalComputerPermissionCommand) => status,
    );
    const app = createApp(act);
    for (const body of [
      { action: "prompt", subject: "linger", permission: "screen_recording" },
      {
        action: "open_settings",
        subject: "computer_use",
        permission: "accessibility",
      },
      { action: "relaunch", subject: "linger" },
    ]) {
      expect((await post(app, body)).status).toBe(200);
    }
    expect(
      act.mock.calls.map(([{ action, subject, permission }]) => ({
        action,
        subject,
        permission,
      })),
    ).toEqual([
      { action: "prompt", subject: "linger", permission: "screen_recording" },
      {
        action: "open_settings",
        subject: "computer_use",
        permission: "accessibility",
      },
      { action: "relaunch", subject: "linger", permission: undefined },
    ]);
  });

  it.each([
    { action: "prompt", subject: "linger" },
    { action: "open_settings", subject: "computer_use" },
    { action: "relaunch", subject: "linger", permission: "accessibility" },
    { action: "status", subject: "linger" },
    { action: "prompt", permission: "screen_recording" },
    { action: "prompt", subject: "cua", permission: "screen_recording" },
    { action: "prompt", subject: "linger", permission: "camera" },
    {
      action: "prompt",
      subject: "linger",
      permission: "screen_recording",
      extra: true,
    },
    [],
  ])("rejects the invalid body %j", async (body) => {
    const act = vi.fn(
      async (_command: LocalComputerPermissionCommand) => status,
    );
    const response = await post(createApp(act), body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "invalid_computer_permission_action",
    });
    expect(act).not.toHaveBeenCalled();
  });

  it("allows only GET and POST", async () => {
    const response = await createApp(async () => status).request(path, {
      method: "DELETE",
    });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, POST");
  });

  it.each([
    [new LocalComputerNotFoundError(), 404, "local_computer_not_found"],
    [new LocalComputerOfflineError(), 503, "local_computer_offline"],
    [
      new LocalComputerCapabilityError(),
      409,
      "computer_permission_capability_unavailable",
    ],
    [
      new LocalComputerPermissionError(
        "COMPUTER_PERMISSION_TIMEOUT",
        "timed out",
        true,
      ),
      503,
      "COMPUTER_PERMISSION_TIMEOUT",
    ],
    [
      new LocalComputerPermissionError(
        "COMPUTER_PERMISSION_RELAUNCH_UNAVAILABLE",
        "failed",
        false,
      ),
      502,
      "COMPUTER_PERMISSION_RELAUNCH_UNAVAILABLE",
    ],
  ])("maps %s to HTTP %i", async (error, expectedStatus, code) => {
    const response = await createApp(async () => {
      throw error;
    }).request(path);
    expect(response.status).toBe(expectedStatus);
    expect(await response.json()).toEqual({ code });
  });
});
