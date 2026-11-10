import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ConfigStore } from "./config.js";
import { EventBus, ModuleHost } from "./modules.js";
import {
  silentLog,
  stubModule,
  tempDirectory,
  testHost,
} from "./test-support.js";
import { WorkspaceGrantsModule } from "./workspace-grants.js";

const pickNothing = async () => undefined;

describe("WorkspaceGrantsModule", () => {
  it("grants the default folder on start for a connected computer", async () => {
    const directory = path.join(tempDirectory(), "Linger");
    const grants = new WorkspaceGrantsModule({
      pickDirectory: pickNothing,
      defaultDirectory: directory,
    });
    const host = testHost([stubModule("Config"), grants], {
      computerId: "computer_1",
    });
    await host.start();

    expect(existsSync(directory)).toBe(true);
    expect(grants.list()).toMatchObject([
      { path: realpathSync(directory), label: "Linger", access: "read_write" },
    ]);
    await host.stop("quit");
  });

  it("grants the default folder once the computer connects", async () => {
    const directory = path.join(tempDirectory(), "Linger");
    const grants = new WorkspaceGrantsModule({
      pickDirectory: pickNothing,
      defaultDirectory: directory,
    });
    const bus = new EventBus();
    const host = new ModuleHost([stubModule("Config"), grants], {
      config: new ConfigStore(path.join(tempDirectory(), "config.json"), {}),
      log: silentLog,
      bus,
    });
    await host.start();
    expect(grants.list()).toEqual([]);

    const changed = new Promise<void>((resolve) =>
      bus.on("grants.changed", () => resolve()),
    );
    bus.emit("computer.changed", "computer_1");
    await changed;
    expect(grants.list().map((g) => g.label)).toEqual(["Linger"]);
    await host.stop("quit");
  });

  it("keeps folders the user already granted", async () => {
    const existing = tempDirectory();
    const grants = new WorkspaceGrantsModule({
      pickDirectory: pickNothing,
      defaultDirectory: path.join(tempDirectory(), "Linger"),
    });
    const host = testHost([stubModule("Config"), grants], {
      computerId: "computer_1",
      workspaceGrants: [
        {
          grantId: "grant_1",
          path: existing,
          label: "mine",
          access: "read_write",
          createdAt: "2026-10-20T00:00:00.000Z",
        },
      ],
    });
    await host.start();

    expect(grants.list().map((g) => g.grantId)).toEqual(["grant_1"]);
    await host.stop("quit");
  });
});
