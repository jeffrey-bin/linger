import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ConfigStore, type DesktopConfig } from "./config.js";
import type { Logger } from "./log.js";
import { EventBus, ModuleHost, type Module } from "./modules.js";

export const silentLog: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export const tempDirectory = (): string =>
  mkdtempSync(path.join(os.tmpdir(), "desktop-test-"));

export const testHost = (
  modules: readonly Module[],
  defaults: Partial<DesktopConfig> = {},
  bus = new EventBus(),
): ModuleHost =>
  new ModuleHost(modules, {
    config: new ConfigStore(
      path.join(tempDirectory(), "config.json"),
      defaults,
    ),
    log: silentLog,
    bus,
  });

export const stubModule = (name: string, dependsOn: string[] = []): Module => ({
  name,
  dependsOn,
  start: async () => {},
  stop: async () => {},
});
