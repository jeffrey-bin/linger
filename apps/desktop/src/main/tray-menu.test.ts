import { describe, expect, it } from "vitest";

import { trayMenu } from "./tray-menu.js";

describe("trayMenu", () => {
  it("leads with the status and ends with quit", () => {
    const items = trayMenu({
      status: { tone: "busy", label: "Running 2 Tasks" },
      preventSleep: true,
      enrolled: true,
    });
    expect(items[0]).toEqual({ kind: "label", label: "Running 2 Tasks" });
    expect(items).toContainEqual({
      kind: "action",
      action: "toggle-prevent-sleep",
      label: "Prevent Sleep",
      checked: true,
    });
    const actions = items.flatMap((i) => (i.kind === "action" ? i.action : []));
    expect(actions).toEqual([
      "open",
      "enroll",
      "toggle-prevent-sleep",
      "show-logs",
      "save-diagnostics",
      "quit",
    ]);
  });

  it("connects an unenrolled computer and reconnects an enrolled one", () => {
    const label = (enrolled: boolean) =>
      trayMenu({
        status: { tone: "setup", label: "Not Connected" },
        preventSleep: false,
        enrolled,
      }).find((i) => i.kind === "action" && i.action === "enroll");
    expect(label(false)).toMatchObject({ label: "Connect This Computer…" });
    expect(label(true)).toMatchObject({ label: "Reconnect This Computer" });
  });

  it("offers a downloaded update and says when it waits for tasks", () => {
    const menu = (waiting: boolean) =>
      trayMenu({
        status: { tone: "busy", label: "Running 1 Task" },
        preventSleep: false,
        enrolled: true,
        update: { kind: waiting ? "waiting" : "ready", version: "0.17.0" },
      }).slice(0, 2);
    expect(menu(false)[1]).toEqual({
      kind: "action",
      action: "install-update",
      label: "Restart to Update (0.17.0)",
    });
    expect(menu(true)[1]).toEqual({
      kind: "label",
      label: "Updating to 0.17.0 When Tasks Finish",
    });
  });

  it("offers to update the services on this computer", () => {
    const menu = (kind: "ready" | "waiting" | "installing") =>
      trayMenu({
        status: { tone: "online", label: "Online" },
        preventSleep: false,
        enrolled: true,
        update: { kind, version: "0.16.20", services: true },
      })[1];
    expect(menu("ready")).toEqual({
      kind: "action",
      action: "install-update",
      label: "Update Linger on This Computer",
    });
    expect(menu("waiting")).toEqual({
      kind: "label",
      label: "Updating When Tasks Finish",
    });
    expect(menu("installing")).toEqual({
      kind: "label",
      label: "Updating Linger on This Computer…",
    });
  });

  it("shows a download in progress", () => {
    const items = trayMenu({
      status: { tone: "online", label: "Online" },
      preventSleep: false,
      enrolled: true,
      update: { kind: "downloading", version: "0.17.0" },
    });
    expect(items[1]).toEqual({
      kind: "label",
      label: "Downloading Update 0.17.0…",
    });
  });

  it("says why an update failed and offers to try again", () => {
    const items = trayMenu({
      status: { tone: "online", label: "Online" },
      preventSleep: false,
      enrolled: true,
      update: { kind: "failed", error: `Couldn't unpack ${"x".repeat(200)}` },
    });
    expect(items[1]).toMatchObject({ kind: "label" });
    const label = (items[1] as { label: string }).label;
    expect(label.startsWith("Update Failed: Couldn't unpack")).toBe(true);
    expect(label.length).toBe("Update Failed: ".length + 80);
    expect(items[2]).toEqual({
      kind: "action",
      action: "check-update",
      label: "Try Updating Again",
    });
  });

  it("shows nothing while idle or checking", () => {
    for (const kind of ["idle", "checking"] as const) {
      const items = trayMenu({
        status: { tone: "online", label: "Online" },
        preventSleep: false,
        enrolled: true,
        update: { kind },
      });
      expect(items[1]).toEqual({ kind: "separator" });
    }
  });
});
