import { describe, expect, it } from "vitest";

import { PowerGuardModule, type PowerApi } from "./power-guard.js";
import { stubModule, testHost } from "./test-support.js";

const setup = async (preventSleep = false) => {
  const blocks: number[] = [];
  let powerListener: ((kind: "suspend" | "resume") => void) | undefined;
  let next = 0;
  const power: PowerApi = {
    block: () => {
      next += 1;
      blocks.push(next);
      return next;
    },
    unblock: (id) => {
      blocks.splice(blocks.indexOf(id), 1);
    },
    onPowerEvent: (listener) => {
      powerListener = listener;
      return () => (powerListener = undefined);
    },
  };
  const guard = new PowerGuardModule(power);
  const host = testHost([stubModule("ComputerDaemon"), guard], {
    preventSleep,
  });
  await host.start();
  return { host, guard, blocks, power: () => powerListener };
};

describe("PowerGuard module", () => {
  it("blocks sleep only while operations run", async () => {
    const { host, guard, blocks } = await setup();
    expect(guard.active()).toBe(false);
    host.ctx.bus.emit("runtime.activity", 2);
    expect(blocks).toEqual([1]);
    host.ctx.bus.emit("runtime.activity", 1);
    expect(blocks).toEqual([1]);
    host.ctx.bus.emit("runtime.activity", 0);
    expect(blocks).toEqual([]);
  });

  it("keeps blocking in always-on mode and saves the choice", async () => {
    const { host, guard, blocks } = await setup(true);
    expect(blocks).toHaveLength(1);
    guard.setAlwaysOn(false);
    expect(blocks).toHaveLength(0);
    expect(host.ctx.config.get().preventSleep).toBe(false);
    await host.stop("quit");
  });

  it("stops listening for power events when stopped", async () => {
    const { host, power } = await setup();
    expect(power()).toBeDefined();
    await host.stop("quit");
    expect(power()).toBeUndefined();
  });
});
