import { describe, expect, it } from "vitest";
import { AgentLifecycleCoordinator } from "../../../src/agent/executor/lifecycle-coordinator.js";

class Deferred {
  resolve!: () => void;
  readonly promise = new Promise<void>((resolve) => {
    this.resolve = resolve;
  });
}

const room = (roomId: string) => ({
  kind: "meta" as const,
  agentId: "agent-1",
  roomId,
});

describe("AgentLifecycleCoordinator", () => {
  it("runs different Contexts concurrently but serializes the same Context", async () => {
    const coordinator = new AgentLifecycleCoordinator();
    const firstGate = new Deferred();
    const events: string[] = [];
    const first = coordinator.runContext(room("room-1"), async () => {
      events.push("first:start");
      await firstGate.promise;
      events.push("first:end");
    });
    const same = coordinator.runContext(room("room-1"), async () => {
      events.push("same:start");
    });
    const other = coordinator.runContext(room("room-2"), async () => {
      events.push("other:start");
    });

    await other;
    expect(events).toEqual(["first:start", "other:start"]);
    firstGate.resolve();
    await Promise.all([first, same]);
    expect(events).toEqual([
      "first:start",
      "other:start",
      "first:end",
      "same:start",
    ]);
  });

  it("keeps Agent-wide mutations exclusive across Contexts", async () => {
    const coordinator = new AgentLifecycleCoordinator();
    const firstStarted = new Deferred();
    const firstGate = new Deferred();
    const writerGate = new Deferred();
    const events: string[] = [];
    const first = coordinator.runContext(room("room-1"), async () => {
      events.push("first:start");
      firstStarted.resolve();
      await firstGate.promise;
    });
    await firstStarted.promise;
    const writer = coordinator.run("agent-1", async () => {
      events.push("writer:start");
      await writerGate.promise;
      events.push("writer:end");
    });
    const second = coordinator.runContext(room("room-2"), async () => {
      events.push("second:start");
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    firstGate.resolve();
    await first;
    await Promise.resolve();
    expect(events).toEqual(["first:start", "writer:start"]);
    writerGate.resolve();
    await Promise.all([writer, second]);
    expect(events).toEqual([
      "first:start",
      "writer:start",
      "writer:end",
      "second:start",
    ]);
  });
});
