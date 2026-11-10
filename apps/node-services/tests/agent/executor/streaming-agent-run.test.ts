import { describe, expect, it } from "vitest";

import type { RunEvent } from "../../../src/agent/executor/provider.js";
import {
  STREAMING_AGENT_RUN_EVENT_BUFFER_LIMIT,
  STREAMING_AGENT_RUN_EVENT_BUFFER_BYTES,
  STREAMING_AGENT_RUN_MAX_RESPONSE_BYTES,
  STREAMING_AGENT_RUN_MAX_RESPONSE_MESSAGES,
  StreamingAgentRun,
} from "../../../src/agent/executor/provider.js";

describe("StreamingAgentRun", () => {
  it("does not consume provider events before a caller claims output", async () => {
    let sourceStarted = false;
    const run = new StreamingAgentRun(
      {
        async *[Symbol.asyncIterator]() {
          sourceStarted = true;
          yield { type: "run.completed" } as const;
        },
      },
      new AbortController(),
    );

    await Promise.resolve();
    expect(sourceStarted).toBe(false);

    await expect(run.wait()).resolves.toEqual({ finalResponse: "" });
    expect(sourceStarted).toBe(true);
  });

  it("starts on iterator claim and does not strand a return before next", async () => {
    let sourceStarted = false;
    let produced = 0;
    const run = new StreamingAgentRun(
      {
        async *[Symbol.asyncIterator]() {
          sourceStarted = true;
          for (
            let index = 0;
            index < STREAMING_AGENT_RUN_EVENT_BUFFER_LIMIT * 2;
            index += 1
          ) {
            produced += 1;
            yield {
              type: "message.delta",
              messageId: "message-1",
              delta: "x",
            } as const;
          }
        },
      },
      new AbortController(),
    );
    const iterator = run.events[Symbol.asyncIterator]();

    await waitUntil(() => produced > STREAMING_AGENT_RUN_EVENT_BUFFER_LIMIT);
    expect(sourceStarted).toBe(true);
    await expect(iterator.return?.()).resolves.toMatchObject({ done: true });
    await expect(run.wait()).resolves.toEqual({
      finalResponse: "x".repeat(STREAMING_AGENT_RUN_EVENT_BUFFER_LIMIT * 2),
    });
  });

  it("exposes the provider steer target for remote Runtime placement", () => {
    const run = new StreamingAgentRun(emptyEvents(), new AbortController(), {
      turnId: "turn-1",
    });

    expect(run.steerTarget).toEqual({ turnId: "turn-1" });
  });

  it("streams status and plan snapshots without dropping or interpreting them", async () => {
    const source: AsyncIterable<RunEvent> = {
      async *[Symbol.asyncIterator]() {
        yield {
          type: "status.changed",
          status: "thinking",
          title: "Inspecting runtime status",
        };
        yield {
          type: "plan.updated",
          explanation: "Refined after inspection",
          steps: [
            { content: "Inspect", status: "completed" },
            { content: "Implement", status: "in_progress" },
            { content: "Verify", status: "pending" },
            { content: "Discarded option", status: "canceled" },
          ],
        };
        yield { type: "status.changed", status: "working" };
        yield { type: "run.completed" };
      },
    };
    const run = new StreamingAgentRun(source, new AbortController());
    const events: RunEvent[] = [];
    const consumeEvents = (async () => {
      for await (const event of run.events) {
        events.push(event);
      }
    })();

    await expect(run.wait()).resolves.toEqual({ finalResponse: "" });
    await consumeEvents;
    expect(events).toEqual([
      {
        type: "status.changed",
        status: "thinking",
        title: "Inspecting runtime status",
      },
      {
        type: "plan.updated",
        explanation: "Refined after inspection",
        steps: [
          { content: "Inspect", status: "completed" },
          { content: "Implement", status: "in_progress" },
          { content: "Verify", status: "pending" },
          { content: "Discarded option", status: "canceled" },
        ],
      },
      { type: "status.changed", status: "working" },
      { type: "run.completed" },
    ]);
  });

  it("publishes a stable run.failed event without provider exception text", async () => {
    const source: AsyncIterable<RunEvent> = {
      async *[Symbol.asyncIterator]() {
        yield { type: "run.started" };
        throw new Error("PRIVATE_PROVIDER_TOKEN");
      },
    };
    const run = new StreamingAgentRun(source, new AbortController());
    const events: RunEvent[] = [];
    const consumeEvents = (async () => {
      for await (const event of run.events) {
        events.push(event);
      }
    })();

    const waitOutcome = await Promise.race([
      run.wait().then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      ),
      new Promise<{ status: "pending" }>((resolve) =>
        setTimeout(() => resolve({ status: "pending" }), 100),
      ),
    ]);

    expect(waitOutcome).toMatchObject({
      status: "rejected",
      error: new Error("Agent run failed"),
    });
    await expect(consumeEvents).resolves.toBeUndefined();
    expect(events.at(-1)).toEqual({
      type: "run.failed",
      message: "Agent run failed",
    });
    expect(JSON.stringify(events)).not.toContain("PRIVATE_PROVIDER_TOKEN");
  });

  it("redacts provider-controlled run.failed messages", async () => {
    const run = new StreamingAgentRun(
      {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "run.failed",
            message: "PRIVATE_PROVIDER_TOKEN",
          } as const;
        },
      },
      new AbortController(),
    );
    const events: RunEvent[] = [];
    const consumeEvents = (async () => {
      for await (const event of run.events) {
        events.push(event);
      }
    })();

    await expect(run.wait()).rejects.toThrow("Agent run failed");
    await consumeEvents;

    expect(events).toEqual([
      { type: "run.failed", message: "Agent run failed" },
    ]);
    expect(JSON.stringify(events)).not.toContain("PRIVATE_PROVIDER_TOKEN");
  });

  it("backpressures a claimed event stream instead of retaining an unbounded history", async () => {
    let produced = 0;
    const total = STREAMING_AGENT_RUN_EVENT_BUFFER_LIMIT * 4;
    const source: AsyncIterable<RunEvent> = {
      async *[Symbol.asyncIterator]() {
        while (produced < total) {
          produced += 1;
          yield {
            type: "message.delta",
            messageId: "message-1",
            delta: "x",
          };
        }
        yield { type: "run.completed" };
      },
    };
    const run = new StreamingAgentRun(source, new AbortController());
    const iterator = run.events[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    await waitUntil(() => produced >= STREAMING_AGENT_RUN_EVENT_BUFFER_LIMIT);

    expect(produced).toBeLessThan(total);

    while (!(await iterator.next()).done) {
      // Drain the bounded queue so the source can finish.
    }
    await expect(run.wait()).resolves.toEqual({
      finalResponse: "x".repeat(total),
    });
  });

  it("unblocks a full event buffer when the run is cancelled", async () => {
    const abortController = new AbortController();
    let produced = 0;
    const run = new StreamingAgentRun(
      {
        async *[Symbol.asyncIterator]() {
          while (!abortController.signal.aborted) {
            produced += 1;
            yield {
              type: "message.delta",
              messageId: "message-1",
              delta: "x",
            } as const;
          }
          throw new Error("PRIVATE_PROVIDER_TOKEN");
        },
      },
      abortController,
    );
    const iterator = run.events[Symbol.asyncIterator]();
    const events: RunEvent[] = [];
    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    await waitUntil(
      () => produced >= STREAMING_AGENT_RUN_EVENT_BUFFER_LIMIT + 2,
    );

    run.cancel();

    await expect(run.wait()).rejects.toThrow("Agent run failed");
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
    }
    expect(events.at(-1)).toEqual({
      type: "run.failed",
      message: "Agent run failed",
    });
    expect(JSON.stringify(events)).not.toContain("PRIVATE_PROVIDER_TOKEN");
  });

  it("fails closed when the final response exceeds its byte limit", async () => {
    const abortController = new AbortController();
    const source: AsyncIterable<RunEvent> = {
      async *[Symbol.asyncIterator]() {
        yield {
          type: "message.delta",
          messageId: "message-1",
          delta: "x".repeat(STREAMING_AGENT_RUN_MAX_RESPONSE_BYTES + 1),
        };
      },
    };
    const run = new StreamingAgentRun(source, abortController);

    await expect(run.wait()).rejects.toThrow("response byte limit");
    expect(abortController.signal.aborted).toBe(true);
  });

  it("fails closed when empty deltas create too many response messages", async () => {
    const abortController = new AbortController();
    const source: AsyncIterable<RunEvent> = {
      async *[Symbol.asyncIterator]() {
        for (
          let index = 0;
          index <= STREAMING_AGENT_RUN_MAX_RESPONSE_MESSAGES;
          index += 1
        ) {
          yield {
            type: "message.delta",
            messageId: `message-${String(index)}`,
            delta: "",
          };
        }
      },
    };
    const run = new StreamingAgentRun(source, abortController);

    await expect(run.wait()).rejects.toThrow("response message limit");
    expect(abortController.signal.aborted).toBe(true);
  });

  it("counts retained message identifiers against the response byte limit", async () => {
    const abortController = new AbortController();
    const source: AsyncIterable<RunEvent> = {
      async *[Symbol.asyncIterator]() {
        yield {
          type: "message.delta",
          messageId: "x".repeat(STREAMING_AGENT_RUN_MAX_RESPONSE_BYTES + 1),
          delta: "",
        };
      },
    };
    const run = new StreamingAgentRun(source, abortController);

    await expect(run.wait()).rejects.toThrow("response byte limit");
    expect(abortController.signal.aborted).toBe(true);
  });

  it("aborts the provider when one event exceeds its buffer byte limit", async () => {
    const abortController = new AbortController();
    const source: AsyncIterable<RunEvent> = {
      async *[Symbol.asyncIterator]() {
        yield {
          type: "message.delta",
          messageId: "message-1",
          delta: "x".repeat(STREAMING_AGENT_RUN_EVENT_BUFFER_BYTES + 1),
        };
      },
    };
    const run = new StreamingAgentRun(source, abortController);
    const consumeEvents = (async () => {
      const iterator = run.events[Symbol.asyncIterator]();
      while (!(await iterator.next()).done) {
        // Drain until the stream closes after its stable failure event.
      }
    })();

    await expect(run.wait()).rejects.toThrow("event exceeds");
    expect(abortController.signal.aborted).toBe(true);
    await expect(consumeEvents).resolves.toBeUndefined();
  });
});

async function* emptyEvents(): AsyncGenerator<RunEvent> {
  yield* [];
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("condition was not reached");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

it("preserves a stream failure cause for diagnosis", async () => {
  const cause = new Error("Local Runtime emitted run.started twice");
  async function* source() {
    yield { type: "run.started" } as const;
    throw cause;
  }
  const run = new StreamingAgentRun(source(), new AbortController());
  await expect(run.wait()).rejects.toMatchObject({
    message: "Agent run failed",
    cause,
  });
});
