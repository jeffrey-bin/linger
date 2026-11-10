import { describe, expect, it, vi } from "vitest";

import {
  composeContextFeatures,
  featureMatches,
} from "../../../../src/agent/agent-features/compose.js";
import {
  defineFeature,
  type AcceptedInboxFact,
  type ContextFeatureHandlers,
} from "../../../../src/agent/agent-features/contracts.js";
import { createFlashbackFeature } from "../../../../src/agent/agent-features/flashback/index.js";
import type {
  FlashbackResponse,
  FlashbackSuggestion,
} from "../../../../src/flashback.js";
import type { AgentLogger } from "../../../../src/agent/observability/agent-log.js";
import { makeTestFeatureContext } from "../fixtures.js";

const suggestion = (score = 0.8): FlashbackSuggestion => ({
  episode: "sessions/2026-08-25/capture_session_a",
  title: "GrowMax creator discovery",
  date: "2026-08-25",
  cue: { id: "clients/growmax", title: "GrowMax", via: "name" },
  ties: [],
  strength: 0.9,
  score,
  situation: "Agreed on a small creator search trial.",
  decisions: [],
  completed: [],
  openItems: [],
});

const suggested = (): FlashbackResponse => ({
  reason: "suggested",
  suggestion: suggestion(),
});

const logger = (): AgentLogger => {
  const value: AgentLogger = { log: vi.fn(), child: () => value };
  return value;
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const ownerMessage = (text: string, actorId = "human_1") => ({
  sequence: 1n,
  messageId: `m-${text}`,
  sender: { actorId, type: "user" as const },
  segments: [{ type: "text" as const, content: text }],
  disposition: "notify" as const,
  mentioned: false,
});

const fact = (
  inputId: string,
  messages = [ownerMessage("How did the creator search go?")],
): AcceptedInboxFact => ({
  inboxId: "room:room-1",
  inputId,
  targeted: true,
  messages,
});

const setup = (
  contextOverrides: Parameters<typeof makeTestFeatureContext>[0] = {},
) => {
  const client = {
    suggest: vi.fn(async (): Promise<FlashbackResponse> => suggested()),
    record: vi.fn(async () => undefined),
  };
  const trackBackground = vi.fn();
  const feature = createFlashbackFeature({
    client,
    logger: logger(),
    settings: {
      followUpWindowMs: 60_000,
      followUpMinScore: 0.6,
      claimWaitMs: 0,
    },
    trackBackground,
  });
  const { context, scope } = makeTestFeatureContext({
    runtime: { type: "local", placement: { runtimeType: "codex" } },
    identity: {
      actorId: "agent-actor",
      agentType: "anotherme",
      representedHuman: { actorId: "human_1", displayName: "Leo" },
      sponsor: { actorId: "sponsor-1", displayName: "Sponsor" },
    },
    steer: vi.fn(async () => ({ status: "accepted" as const })),
    followUp: vi.fn(async () => ({ status: "accepted" as const })),
    ...contextOverrides,
  });
  const handlers: ContextFeatureHandlers = feature.context!.create(context);
  const accept = (accepted: AcceptedInboxFact) =>
    handlers.afterInboxInputAccepted!(context, accepted);
  const drain = async () => {
    for (const [operation] of vi.mocked(trackBackground).mock.calls)
      await operation;
  };
  return { client, trackBackground, feature, context, scope, accept, drain };
};

describe("createFlashbackFeature", () => {
  it("matches only Another Me meta contexts", () => {
    const { feature } = setup();
    expect(
      featureMatches(feature, { agentType: "anotherme", contextKind: "meta" }),
    ).toBe(true);
    expect(
      featureMatches(feature, { agentType: "general", contextKind: "meta" }),
    ).toBe(false);
    expect(
      featureMatches(feature, {
        agentType: "anotherme",
        contextKind: "document",
      }),
    ).toBe(false);
  });

  it("composes standalone", () => {
    const { context, feature } = setup();
    const alone = composeContextFeatures({ context, features: [feature] });
    expect(alone.matched).toEqual(["flashback"]);
  });

  it("recalls the represented Human's text and steers a codex run", async () => {
    const { client, context, accept, drain } = setup();
    accept(fact("in-1"));
    await drain();
    expect(client.suggest).toHaveBeenCalledWith({
      tenant_id: "tenant-1",
      owner_actor_id: "human_1",
      room_id: "room-1",
      text: "How did the creator search go?",
    });
    expect(context.steer).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        rawMessage: expect.stringContaining(
          '<historical_context source="flashback">',
        ),
      }),
      expect.objectContaining({ canSubmit: expect.any(Function) }),
    );
    expect(client.record).toHaveBeenCalledWith(
      expect.objectContaining({
        episode: "sessions/2026-08-25/capture_session_a",
        cue_id: "clients/growmax",
      }),
    );
  });

  it("skips recall when there is no represented Human or no owner text", async () => {
    const withoutHuman = setup({
      identity: {
        actorId: "agent-actor",
        agentType: "anotherme",
        sponsor: { actorId: "sponsor-1", displayName: "Sponsor" },
      },
    });
    withoutHuman.accept(fact("in-1"));
    await withoutHuman.drain();
    expect(withoutHuman.client.suggest).not.toHaveBeenCalled();

    const { client, accept, drain } = setup();
    accept(fact("in-1", [ownerMessage("hello", "teammate_1")]));
    await drain();
    expect(client.suggest).not.toHaveBeenCalled();
    // The skipped fact still counted as accepted input; the next owner fact
    // recalls normally on the bumped generation.
    accept(fact("in-2"));
    await drain();
    expect(client.suggest).toHaveBeenCalledTimes(1);
  });

  it("dedupes stable inputId replays instead of recalling twice", async () => {
    const { client, accept, drain } = setup();
    accept(fact("in-1"));
    accept(fact("in-1"));
    await drain();
    expect(client.suggest).toHaveBeenCalledTimes(1);
  });

  it("follows up without steer for a non-steer runtime once the reply is done", async () => {
    const { context, accept, drain } = setup({
      runtime: { type: "local", placement: { runtimeType: "claude" } },
      activeRunId: () => undefined,
    });
    accept(fact("in-1"));
    await drain();
    expect(context.steer).not.toHaveBeenCalled();
    expect(context.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ sourceInboxIds: ["room:room-1"] }),
      expect.objectContaining({ canSubmit: expect.any(Function) }),
    );
  });

  it("drops the recall while a non-steer runtime is still replying", async () => {
    const { context, accept, drain } = setup({
      runtime: { type: "local", placement: { runtimeType: "claude" } },
      activeRunId: () => "run-9",
    });
    accept(fact("in-1"));
    await drain();
    expect(context.steer).not.toHaveBeenCalled();
    expect(context.followUp).not.toHaveBeenCalled();
  });

  it("marks the submission stale through canSubmit after newer input", async () => {
    const { context, accept, drain } = setup();
    let canSubmit: (() => boolean) | undefined;
    vi.mocked(context.steer).mockImplementationOnce(
      async (_runId, _message, options) => {
        canSubmit = options?.canSubmit;
        return { status: "accepted" as const };
      },
    );
    accept(fact("in-1"));
    await drain();
    expect(canSubmit).toBeTypeOf("function");
    expect(canSubmit!()).toBe(true);
    accept(fact("in-2"));
    expect(canSubmit!()).toBe(false);
  });

  it("drops the late result and record when the instance is released", async () => {
    const { client, context, scope, accept, drain } = setup();
    const gate = deferred<FlashbackResponse>();
    vi.mocked(client.suggest).mockReturnValueOnce(gate.promise);
    accept(fact("in-1"));
    scope.abort();
    gate.resolve(suggested());
    await drain();
    expect(context.steer).not.toHaveBeenCalled();
    expect(context.followUp).not.toHaveBeenCalled();
    expect(client.record).not.toHaveBeenCalled();
  });

  it("binds in-flight results to the released instance, not the same-ref replacement", async () => {
    // Two compositions over the same ref model a Context replacement: the
    // released instance's late suggestion is dropped while the replacement
    // instance re-accepts the same inputId and recalls normally.
    const first = setup();
    const gate = deferred<FlashbackResponse>();
    vi.mocked(first.client.suggest).mockReturnValueOnce(gate.promise);
    first.accept(fact("in-1"));
    first.scope.abort();
    gate.resolve(suggested());
    await first.drain();
    expect(first.context.steer).not.toHaveBeenCalled();
    expect(first.client.record).not.toHaveBeenCalled();

    const second = setup();
    second.accept(fact("in-1"));
    await second.drain();
    expect(second.context.steer).toHaveBeenCalled();
    expect(second.client.record).toHaveBeenCalled();
  });

  it("dispatches through the composed catalog with the full FeatureContext", async () => {
    const peer = defineFeature({
      id: "peer-observer",
      context: {
        ports: { afterInboxInputAccepted: {} },
        create: () => ({ afterInboxInputAccepted: () => undefined }),
      },
    });
    const { client, context, feature, drain } = setup();
    const composed = composeContextFeatures({
      context,
      features: [peer, feature],
    });
    expect(composed.matched).toEqual(["peer-observer", "flashback"]);
    composed.afterInboxInputAccepted(fact("in-1"));
    await drain();
    expect(client.suggest).toHaveBeenCalled();
  });
});
