import { describe, expect, it, vi } from "vitest";

import type {
  RuntimeStateSchemas,
  TeamHubRuntimeStateClient,
} from "../../../src/agent/executor/teamhub-runtime-state-client.js";
import { createRuntimeStatusPublisher } from "../../../src/agent/executor/runtime-status.js";

const contextKey = '["meta","agent_1","room","room-1"]';

describe("TeamHub Runtime status publisher", () => {
  it("opens the Run's status under its epoch and publishes the initial working event", async () => {
    const fixture = createClientFixture();
    const publisher = createRuntimeStatusPublisher({ client: fixture.client });

    await publisher.open({
      executionId: "run_1",
      ref: { kind: "meta", agentId: "agent_1", roomId: "room-1" },
      epoch: "agent-epoch-test",
      sourceInboxIds: ["room:room_1", "room:room_1"],
    });

    expect(fixture.openStatus).toHaveBeenCalledWith({
      context_key: contextKey,
      epoch: "agent-epoch-test",
      local_run_id: "run_1",
      initial_source_ids: ["room:room_1"],
    });
    expect(fixture.offers).toEqual([
      {
        command_id: expect.any(String),
        local_run_id: "run_1",
        event: { type: "status.changed", status: "working" },
      },
    ]);
  });

  it("publishes each batch in one request", async () => {
    const fixture = createClientFixture();
    const publisher = createRuntimeStatusPublisher({ client: fixture.client });
    const session = await publisher.open(validOpenInput());

    await session.publish([
      { type: "status.changed", status: "thinking" },
      { type: "plan.updated", steps: [] },
    ]);

    expect(fixture.batches.map((batch) => batch.events.length)).toEqual([1, 2]);
    expect(fixture.offers.map(({ event }) => event.type)).toEqual([
      "status.changed",
      "status.changed",
      "plan.updated",
    ]);
  });

  it("serializes every batch in publish order", async () => {
    let releaseThinking!: () => void;
    const thinkingGate = new Promise<void>((resolve) => {
      releaseThinking = resolve;
    });
    const fixture = createClientFixture(async (body) => {
      if (
        body.event.type === "status.changed" &&
        body.event.status === "thinking"
      ) {
        await thinkingGate;
      }
    });
    const publisher = createRuntimeStatusPublisher({ client: fixture.client });
    const session = await publisher.open(validOpenInput());

    const thinking = session.publish([
      {
        type: "status.changed",
        status: "thinking",
        title: "Inspecting runtime status",
      },
    ]);
    const plan = session.publish([
      {
        type: "plan.updated",
        explanation: "Next",
        steps: [{ content: "Inspect", status: "in_progress" }],
      },
    ]);
    await Promise.resolve();
    await Promise.resolve();

    expect(fixture.offers.map(({ event }) => event.type)).toEqual([
      "status.changed",
      "status.changed",
    ]);
    releaseThinking();
    await Promise.all([thinking, plan]);
    expect(fixture.offers.map(({ event }) => event.type)).toEqual([
      "status.changed",
      "status.changed",
      "plan.updated",
    ]);
    expect(fixture.offers[1]?.event).toEqual({
      type: "status.changed",
      status: "thinking",
      title: "Inspecting runtime status",
    });
  });

  it("maps the complete public activity lifecycle", async () => {
    const fixture = createClientFixture();
    const publisher = createRuntimeStatusPublisher({ client: fixture.client });
    const session = await publisher.open(validOpenInput());

    await session.publish([
      {
        type: "activity.started",
        activityId: "activity-7",
        content: [
          { content: "runtime status", format: "text", label: "Query" },
        ],
        kind: "search",
        title: "Searching the web",
      },
    ]);
    await session.publish([
      {
        type: "activity.updated",
        activityId: "activity-7",
        detail: "Reading source pages",
      },
    ]);
    await session.publish([
      {
        type: "activity.finished",
        activityId: "activity-7",
        content: [{ content: "3 results", format: "text", label: "Results" }],
        outcome: "succeeded",
      },
    ]);

    expect(fixture.offers.slice(-3).map(({ event }) => event)).toEqual([
      {
        type: "activity.started",
        activity_id: "activity-7",
        content: [
          { content: "runtime status", format: "text", label: "Query" },
        ],
        kind: "search",
        title: "Searching the web",
      },
      {
        type: "activity.updated",
        activity_id: "activity-7",
        detail: "Reading source pages",
      },
      {
        type: "activity.finished",
        activity_id: "activity-7",
        content: [{ content: "3 results", format: "text", label: "Results" }],
        outcome: "succeeded",
      },
    ]);
  });

  it("drops public activity content outside its bounded contract", async () => {
    const fixture = createClientFixture();
    const publisher = createRuntimeStatusPublisher({ client: fixture.client });
    const session = await publisher.open(validOpenInput());

    await expect(
      session.publish([
        {
          type: "activity.started",
          activityId: "activity-7",
          content: [{ content: "x".repeat(4001), format: "code" }],
          kind: "command",
          title: "Running a command",
        },
      ]),
    ).resolves.toBeUndefined();
    expect(fixture.offers).toHaveLength(1);
  });

  it("keeps later batches live after one callback failure", async () => {
    let failures = 0;
    const fixture = createClientFixture((body) => {
      if (body.event.type === "plan.updated" && failures++ === 0) {
        throw new Error("temporary callback failure");
      }
    });
    const publisher = createRuntimeStatusPublisher({ client: fixture.client });
    const session = await publisher.open(validOpenInput());

    await expect(
      session.publish([{ type: "plan.updated", steps: [] }]),
    ).rejects.toThrow("temporary callback failure");
    await expect(
      session.publish([{ type: "status.changed", status: "thinking" }]),
    ).resolves.toBeUndefined();
    expect(fixture.offers.at(-1)?.event).toEqual({
      type: "status.changed",
      status: "thinking",
    });
  });

  it("drops titles outside the public thinking-title boundary", async () => {
    const fixture = createClientFixture();
    const publisher = createRuntimeStatusPublisher({ client: fixture.client });
    const session = await publisher.open(validOpenInput());

    await expect(
      session.publish([
        {
          type: "status.changed",
          status: "working",
          title: "Not allowed",
        },
      ]),
    ).resolves.toBeUndefined();
    expect(fixture.offers).toHaveLength(1);
    await expect(
      session.publish([
        {
          type: "status.changed",
          status: "thinking",
          title: "x".repeat(201),
        },
      ]),
    ).resolves.toBeUndefined();
    expect(fixture.offers.at(-1)?.event).toEqual({
      type: "status.changed",
      status: "thinking",
      title: "x".repeat(201),
    });
  });

  it("returns a no-op session for invalid or closed publishers", async () => {
    const fixture = createClientFixture();
    const publisher = createRuntimeStatusPublisher({ client: fixture.client });

    const invalid = await publisher.open({
      ...validOpenInput(),
      sourceInboxIds: [],
    });
    await invalid.publish([{ type: "status.changed", status: "thinking" }]);
    await publisher.close();
    const closed = await publisher.open(validOpenInput());
    await closed.publish([{ type: "status.changed", status: "thinking" }]);

    expect(fixture.openStatus).not.toHaveBeenCalled();
    expect(fixture.offers).toEqual([]);
  });
});

type OfferedBatch =
  RuntimeStateSchemas["OfferAgentRuntimePresentationEventsRequest"];
type OfferedEvent = OfferedBatch["events"][number] & { local_run_id: string };

const createClientFixture = (
  beforeOffer: (body: OfferedEvent) => void | Promise<void> = () => undefined,
) => {
  const offers: OfferedEvent[] = [];
  const batches: OfferedBatch[] = [];
  const openStatus = vi.fn(async () => ({ opened: true, room_id: "room_1" }));
  const offerPresentationEvents = vi.fn(async (body: OfferedBatch) => {
    batches.push(body);
    for (const event of body.events) {
      const offered = { ...event, local_run_id: body.local_run_id };
      offers.push(offered);
      await beforeOffer(offered);
    }
    return { accepted: true, event_ordinal: String(offers.length) };
  });
  const client = {
    openStatus,
    offerPresentationEvents,
  } as unknown as TeamHubRuntimeStateClient;
  return { client, offers, batches, openStatus };
};

const validOpenInput = () => ({
  executionId: "run_1",
  ref: { kind: "meta" as const, agentId: "agent_1", roomId: "room-1" },
  epoch: "agent-epoch-test",
  replyToMessageId: "message_1",
  sourceInboxIds: ["room:room_1"],
});
