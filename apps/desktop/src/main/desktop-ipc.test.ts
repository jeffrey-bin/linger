import { afterEach, describe, expect, it, vi } from "vitest";

import { IPC } from "../shared/api.js";

const handlers = vi.hoisted(
  () => new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
);
vi.mock("electron", () => ({
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: unknown, ...args: unknown[]) => unknown,
    ) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
}));

const { DesktopIpcModule } = await import("./desktop-ipc.js");
const { stubModule, testHost } = await import("./test-support.js");

const SERVER = "http://localhost:3000";
const PASSWORD = "a-private-password";

const fixture = async (
  localServer: {
    servesWindow?: () => Promise<boolean>;
    signInWithAccount?: () => Promise<void>;
  } = {},
) => {
  const local = {
    ...stubModule("LocalServer"),
    servesWindow: vi.fn(localServer.servesWindow ?? (async () => true)),
    signInWithAccount: vi.fn(localServer.signInWithAccount ?? (async () => {})),
  };
  const host = testHost(
    [
      stubModule("Enrollment"),
      stubModule("PowerGuard"),
      stubModule("ComputerDaemon"),
      stubModule("WindowManager"),
      stubModule("WorkspaceGrants"),
      local as never,
      new DesktopIpcModule({ defaultDisplayName: "Desk" }),
    ],
    { serverUrl: SERVER },
  );
  await host.start();
  const invoke = (channel: string, origin = SERVER) =>
    handlers.get(channel)!({ senderFrame: { origin } });
  return { host, local, invoke };
};

afterEach(() => handlers.clear());

describe("DesktopIpcModule local account", () => {
  it("offers the account only for the installed server", async () => {
    const f = await fixture({ servesWindow: async () => false });
    expect(await f.invoke(IPC.localAccountAvailable)).toBe(false);
    f.local.servesWindow.mockResolvedValue(true);
    expect(await f.invoke(IPC.localAccountAvailable)).toBe(true);
    await f.host.stop("quit");
  });

  it("rejects pages from any other origin", async () => {
    const f = await fixture();
    expect(() =>
      f.invoke(IPC.localAccountSignIn, "https://evil.example.com"),
    ).toThrow("Not allowed");
    expect(() =>
      f.invoke(IPC.localAccountAvailable, "https://evil.example.com"),
    ).toThrow("Not allowed");
    expect(f.local.signInWithAccount).not.toHaveBeenCalled();
    await f.host.stop("quit");
  });

  it("signs in and returns no account data to the page", async () => {
    const f = await fixture();
    expect(await f.invoke(IPC.localAccountSignIn)).toEqual({ ok: true });
    expect(f.local.signInWithAccount).toHaveBeenCalledOnce();
    await f.host.stop("quit");
  });

  it("returns why signing in failed", async () => {
    const f = await fixture({
      signInWithAccount: async () => {
        throw new Error(
          "The local account file must be private and owned by the current user (chmod 600).",
        );
      },
    });
    const result = await f.invoke(IPC.localAccountSignIn);
    expect(result).toEqual({
      ok: false,
      message:
        "The local account file must be private and owned by the current user (chmod 600).",
    });
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    await f.host.stop("quit");
  });
});
