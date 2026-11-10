import { describe, expect, it } from "vitest";

import {
  MacPermissions,
  type PermissionId,
  type PermissionProbes,
} from "./mac-permissions.js";

const errno = (code: string) => Object.assign(new Error(code), { code });

const setup = (probes: Partial<PermissionProbes>) => {
  const asked: PermissionId[] = [];
  const calls: string[] = [];
  const permissions = new MacPermissions({
    home: "/Users/me",
    asked: () => asked,
    markAsked: (id) => asked.push(id),
    probes: {
      openFile: async (file) => {
        calls.push(`open ${file}`);
        await probes.openFile?.(file);
      },
      listDirectory: async (directory) => {
        calls.push(`list ${directory}`);
        await probes.listDirectory?.(directory);
      },
      appleScript: async (script) => {
        calls.push("osascript");
        await probes.appleScript?.(script);
      },
    },
  });
  return { permissions, asked, calls };
};

describe("MacPermissions", () => {
  it("checks only Full Disk Access until the user asks for more", async () => {
    const { permissions, calls } = setup({
      openFile: async () => {
        throw errno("EPERM");
      },
    });
    expect(await permissions.statuses()).toEqual({
      "full-disk": "denied",
      folders: "unknown",
      automation: "unknown",
    });
    // Listing Downloads or running AppleScript would show a system prompt.
    expect(calls).toEqual([
      "open /Users/me/Library/Application Support/com.apple.TCC/TCC.db",
    ]);
  });

  it("treats Full Disk Access as covering the protected folders", async () => {
    const { permissions, calls } = setup({});
    expect((await permissions.statuses()).folders).toBe("granted");
    expect(calls.some((c) => c.startsWith("list"))).toBe(false);
  });

  it("asks once and then reports the answers", async () => {
    const { permissions, asked } = setup({
      openFile: async () => {
        throw errno("EPERM");
      },
      listDirectory: async (directory) => {
        if (directory.endsWith("Desktop")) throw errno("EPERM");
      },
      appleScript: async () => {
        throw new Error(
          "execution error: Not authorized to send Apple events to System Events. (-1743)",
        );
      },
    });
    await permissions.request("folders");
    await permissions.request("automation");
    expect(asked).toEqual(["folders", "automation"]);
    expect(await permissions.statuses()).toEqual({
      "full-disk": "denied",
      folders: "denied",
      automation: "denied",
    });
  });

  it("does not call other failures a refusal", async () => {
    const { permissions } = setup({
      openFile: async () => {
        throw errno("ENOENT");
      },
      listDirectory: async () => {
        throw errno("ENOENT");
      },
      appleScript: async () => {
        throw new Error("Command failed: timeout");
      },
    });
    await permissions.request("folders");
    await permissions.request("automation");
    expect(await permissions.statuses()).toEqual({
      "full-disk": "unknown",
      folders: "unknown",
      automation: "unknown",
    });
  });
});
