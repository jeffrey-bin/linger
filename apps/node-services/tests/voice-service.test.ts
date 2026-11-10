import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startVoiceService,
  selectedVoiceWorkers,
  type VoiceWorker,
} from "../src/voice/service.js";
import type { HttpHost } from "../src/http-host.js";
import type { JsonLogger } from "@linger/service-kit/node";

class Worker extends EventEmitter {
  kill = vi.fn(() => true);
}
afterEach(() => vi.useRealTimers());
describe("unified voice supervision", () => {
  it("only starts configured media capabilities", () => {
    expect(selectedVoiceWorkers({})).toEqual([]);
    expect(selectedVoiceWorkers({ SONIOX_API_KEY: "test" })).toEqual([
      "asr",
      "recorder",
    ]);
    expect(selectedVoiceWorkers({ XAI_API_KEY: "test" })).toEqual(["live"]);
    expect(
      selectedVoiceWorkers({ SONIOX_API_KEY: "test", XAI_API_KEY: "test" }),
    ).toEqual(["asr", "recorder", "live"]);
  });
  it("restarts only the failed worker and drains all media before returning", async () => {
    vi.useFakeTimers();
    const children = new Map<VoiceWorker, Worker[]>();
    const unmount = vi.fn();
    const service = await startVoiceService({
      logger: { log: vi.fn() } as unknown as JsonLogger,
      http: { mount: () => unmount } as unknown as HttpHost,
      environment: { SONIOX_API_KEY: "test", XAI_API_KEY: "test" },
      spawnWorker: (worker) => {
        const child = new Worker();
        children.set(worker, [...(children.get(worker) ?? []), child]);
        return child as unknown as ChildProcess;
      },
    });
    children.get("live")![0]!.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(1000);
    expect(children.get("live")).toHaveLength(2);
    expect(children.get("recorder")).toHaveLength(1);
    expect(children.get("asr")).toHaveLength(1);
    let drained = false;
    const stopping = service.stop().then(() => {
      drained = true;
    });
    for (const worker of ["asr", "recorder", "live"] as const)
      expect(children.get(worker)!.at(-1)!.kill).toHaveBeenCalledWith(
        "SIGTERM",
      );
    children.get("live")!.at(-1)!.emit("exit", 0, null);
    children.get("asr")![0]!.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(2000);
    expect(drained).toBe(false);
    children.get("recorder")![0]!.emit("exit", 0, null);
    await stopping;
    await vi.advanceTimersByTimeAsync(30000);
    expect(children.get("live")).toHaveLength(2);
    expect(unmount).toHaveBeenCalledOnce();
  });
});
