import { describe, expect, it } from "vitest";

import { parseSetupCommand } from "./setup-command.js";

describe("parseSetupCommand", () => {
  it("accepts known commands", () => {
    expect(parseSetupCommand({ op: "prevent-sleep.set", on: true })).toEqual({
      op: "prevent-sleep.set",
      on: true,
    });
    expect(
      parseSetupCommand({ op: "server.set", serverUrl: "https://x.test" }),
    ).toEqual({ op: "server.set", serverUrl: "https://x.test" });
    expect(
      parseSetupCommand({ op: "permission.settings", id: "full-disk" }),
    ).toEqual({ op: "permission.settings", id: "full-disk" });
    expect(parseSetupCommand({ op: "local.start" })).toEqual({
      op: "local.start",
    });
    expect(
      parseSetupCommand({
        op: "local.start",
        runtime: "local",
      }),
    ).toEqual({ op: "local.start", runtime: "local" });
    expect(parseSetupCommand({ op: "local.location.pick" })).toEqual({
      op: "local.location.pick",
    });
    expect(parseSetupCommand({ op: "local.location.reset" })).toEqual({
      op: "local.location.reset",
    });
    expect(parseSetupCommand({ op: "local.signin.start" })).toEqual({
      op: "local.signin.start",
    });
    expect(
      parseSetupCommand({ op: "local.signin.start", code: " abc#def " }),
    ).toEqual({ op: "local.signin.start", code: "abc#def" });
    expect(parseSetupCommand({ op: "local.signin.cancel" })).toEqual({
      op: "local.signin.cancel",
    });
    expect(parseSetupCommand({ op: "local.account.show", on: true })).toEqual({
      op: "local.account.show",
      on: true,
    });
    expect(parseSetupCommand({ op: "local.account.copy" })).toEqual({
      op: "local.account.copy",
    });
    expect(parseSetupCommand({ op: "local.account.reveal" })).toEqual({
      op: "local.account.reveal",
    });
    expect(
      parseSetupCommand({ op: "local.signin.switch", runtime: "claude" }),
    ).toEqual({ op: "local.signin.switch", runtime: "claude" });
  });

  it("takes provider keys with local.start, trimmed, and nothing else", () => {
    expect(
      parseSetupCommand({
        op: "local.start",
        keys: { composio: " key-0 ", soniox: " key-1 ", xai: "" },
      }),
    ).toEqual({
      op: "local.start",
      keys: { composio: "key-0", soniox: "key-1", xai: "" },
    });
    expect(() =>
      parseSetupCommand({ op: "local.start", keys: { livekit: "x" } }),
    ).toThrow();
    expect(() =>
      parseSetupCommand({ op: "local.start", keys: { xai: "a b" } }),
    ).toThrow();
    expect(() =>
      parseSetupCommand({ op: "local.start", keys: { xai: "x".repeat(513) } }),
    ).toThrow();
    // A rejected key is not repeated in the error.
    let message = "";
    try {
      parseSetupCommand({ op: "local.start", keys: { xai: "secret value" } });
    } catch (error) {
      message = String(error);
    }
    expect(message).not.toContain("secret value");
  });

  it("rejects unknown commands and extra fields", () => {
    expect(() => parseSetupCommand({ op: "shell.exec" })).toThrow();
    expect(() => parseSetupCommand({ op: "finish", path: "/" })).toThrow();
    expect(() => parseSetupCommand({ op: "prevent-sleep.set" })).toThrow();
    expect(() => parseSetupCommand({ op: "docker.open" })).toThrow();
    // The page never names a folder or a source; the main process asks the
    // user, and the source is the app's own.
    expect(() =>
      parseSetupCommand({ op: "local.location.pick", path: "/" }),
    ).toThrow();
    expect(() =>
      parseSetupCommand({ op: "local.start", location: "/" }),
    ).toThrow();
    expect(() =>
      parseSetupCommand({ op: "local.start", source: "checkout" }),
    ).toThrow();
    expect(() =>
      parseSetupCommand({ op: "local.start", runtime: "local-models" }),
    ).toThrow();
    expect(() =>
      parseSetupCommand({ op: "local.start", models: ["decision"] }),
    ).toThrow();
    // The sign-in page is the runtime's own; the page never names a URL,
    // and switching names one of the runtimes that sign in.
    expect(() =>
      parseSetupCommand({ op: "local.signin.open", url: "https://x.test" }),
    ).toThrow();
    expect(() =>
      parseSetupCommand({ op: "local.signin.start", code: "  " }),
    ).toThrow();
    expect(() =>
      parseSetupCommand({ op: "local.signin.switch", runtime: "local" }),
    ).toThrow();
    // The account file is the installation's own; the page never names one.
    expect(() =>
      parseSetupCommand({ op: "local.account.reveal", file: "/etc/passwd" }),
    ).toThrow();
    expect(() => parseSetupCommand({ op: "local.account.show" })).toThrow();
    // Task access modes were removed with the runtime host.
    expect(() =>
      parseSetupCommand({ op: "sandbox.set", mode: "ask" }),
    ).toThrow();
    // Full Disk Access has no prompt; only System Settings grants it.
    expect(() =>
      parseSetupCommand({ op: "permission.request", id: "full-disk" }),
    ).toThrow();
  });
});
