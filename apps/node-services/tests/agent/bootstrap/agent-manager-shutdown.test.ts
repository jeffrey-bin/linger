import { describe, expect, it, vi } from "vitest";

import { closeAgentManagerResources } from "../../../src/agent/bootstrap/agent-manager-shutdown.js";

describe("Agent Manager shutdown dependencies", () => {
  it.each([false, true])(
    "keeps Runtime and network available until Manager settles (failure=%s)",
    async (fail) => {
      const events: string[] = [];
      const stopped = deferred();
      const request = deferred();
      const resource = (name: string) => ({
        close: vi.fn(async () => {
          events.push(name);
        }),
      });
      const managerError = new Error("terminal response unavailable");
      const resources = {
        server: {
          ...resource("network"),
          drain: vi.fn(async () => {
            events.push("admission");
            await request.promise;
          }),
        },
        taskWorker: resource("task"),
        wakeStream: resource("wake"),
        modelCalls: resource("model-calls"),
        runWakes: {
          close: vi.fn(() => {
            events.push("run-wakes");
          }),
        },
        agentManager: {
          close: vi.fn(async () => {
            events.push("manager");
            await stopped.promise;
            if (fail) throw managerError;
          }),
        },
        runtimeHosts: resource("runtime"),
        runtimeStatusPublisher: resource("status"),
        contextViewSessions: {
          close: vi.fn(() => {
            events.push("views");
          }),
        },
        localMcpRelay: resource("relay"),
      };
      const closing = closeAgentManagerResources(resources);
      const result = closing.catch((error) => error);
      await vi.waitFor(() => expect(events).toContain("manager"));
      expect(events).toContain("admission");
      expect(events).toContain("task");
      expect(events).toContain("model-calls");
      expect(events).not.toContain("runtime");
      expect(events).not.toContain("network");
      stopped.resolve();
      await Promise.resolve();
      expect(events).not.toContain("runtime");
      request.resolve();
      expect(await result).toBe(fail ? managerError : undefined);
      expect(events.indexOf("runtime")).toBeGreaterThan(
        events.indexOf("manager"),
      );
      expect(events.indexOf("network")).toBeGreaterThan(
        events.indexOf("runtime"),
      );
      expect(events.indexOf("views")).toBeGreaterThan(
        events.indexOf("network"),
      );
      expect(events.indexOf("wake")).toBeGreaterThanOrEqual(0);
      expect(events.indexOf("wake")).toBeLessThan(events.indexOf("runtime"));
      expect(events.indexOf("run-wakes")).toBeLessThan(
        events.indexOf("runtime"),
      );
      expect(events).toContain("relay");
    },
  );
});

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
