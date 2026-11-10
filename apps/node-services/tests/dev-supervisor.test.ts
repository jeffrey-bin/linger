import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  superviseNodeServicesDevelopment,
  waitForTeamHubHealth,
} from "../scripts/dev-supervisor.js";

class FakeNodeServicesChild extends EventEmitter {
  readonly kill = vi.fn(() => true);
}

describe("Node Services development supervisor", () => {
  it("waits for TeamHub again before restarting a failed child", async () => {
    const controller = new AbortController();
    const firstChild = new FakeNodeServicesChild();
    const secondChild = new FakeNodeServicesChild();
    const spawnNodeServices = vi
      .fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild);
    const waitForTeamHub = vi.fn().mockResolvedValue(undefined);
    const refreshFeatureCatalog = vi.fn().mockResolvedValue(undefined);

    const running = superviseNodeServicesDevelopment({
      signal: controller.signal,
      refreshFeatureCatalog,
      spawnNodeServices,
      waitBeforeRestart: vi.fn().mockResolvedValue(undefined),
      waitForTeamHub,
    });

    await vi.waitFor(() => expect(spawnNodeServices).toHaveBeenCalledOnce());
    firstChild.emit("exit", 1, null);
    await vi.waitFor(() => expect(spawnNodeServices).toHaveBeenCalledTimes(2));

    expect(waitForTeamHub).toHaveBeenCalledTimes(2);
    // The catalog refresh must run before every spawn so watch restarts pick
    // up added or removed feature directories.
    expect(refreshFeatureCatalog).toHaveBeenCalledTimes(2);
    for (const [
      index,
      callOrder,
    ] of spawnNodeServices.mock.invocationCallOrder.entries()) {
      expect(callOrder).toBeGreaterThan(
        refreshFeatureCatalog.mock.invocationCallOrder[index]!,
      );
    }
    controller.abort();
    expect(secondChild.kill).toHaveBeenCalledWith("SIGTERM");
    secondChild.emit("exit", null, "SIGTERM");
    await running;
  });

  it("retries TeamHub health checks until one succeeds", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await waitForTeamHubHealth(
      "http://teamhub.test/healthz",
      new AbortController().signal,
      { fetcher, sleep },
    );

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
