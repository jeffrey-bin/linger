import { describe, expect, it, vi } from "vitest";

import {
  composeContextFeatures,
  featureMatches,
} from "../../../../src/agent/agent-features/compose.js";
import type { BoundFeatureContext } from "../../../../src/agent/agent-features/contracts.js";
import {
  createInboxSourceFeature,
  INBOX_SOURCE_FEATURE_ID,
  type InboxSourceHost,
} from "../../../../src/agent/agent-features/inbox-source/index.js";
import type {
  RunWakeKind,
  RunWakeTarget,
} from "../../../../src/agent/agent-features/inbox-source/types.js";
import { makeTestFeatureContext } from "../fixtures.js";

const registrar = () => {
  const targets: RunWakeTarget[] = [];
  const stops: RunWakeTarget[] = [];
  return {
    targets,
    stops,
    registerTarget: vi.fn((target: RunWakeTarget) => {
      targets.push(target);
      return { stop: () => stops.push(target) };
    }),
  };
};

const host = () => {
  const wakes: Array<{ context: BoundFeatureContext; kind: RunWakeKind }> = [];
  const implementation: InboxSourceHost = {
    takeUpQueuedInput: vi.fn((context, kind) => wakes.push({ context, kind })),
  };
  return { host: implementation, wakes };
};

describe("createInboxSourceFeature", () => {
  it("matches only Meta Contexts", () => {
    const feature = createInboxSourceFeature({
      wakes: registrar(),
      host: host().host,
    });
    expect(featureMatches(feature, { contextKind: "meta" })).toBe(true);
    expect(featureMatches(feature, { contextKind: "alter_ego" })).toBe(false);
  });

  it("fails assembly without the registrar or host capability", () => {
    expect(() =>
      createInboxSourceFeature({ host: host().host } as never),
    ).toThrow("inbox-source feature requires wakes and host");
    expect(() =>
      createInboxSourceFeature({ wakes: registrar() } as never),
    ).toThrow("inbox-source feature requires wakes and host");
  });

  it("hands each wake for the bound Context to the host and unregisters on release", async () => {
    const wakes = registrar();
    const hostFixture = host();
    const feature = createInboxSourceFeature({
      wakes,
      host: hostFixture.host,
    });
    const { context } = makeTestFeatureContext();
    const composed = composeContextFeatures({ context, features: [feature] });
    expect(composed.matched).toEqual([INBOX_SOURCE_FEATURE_ID]);
    await composed.bindSources({ bootstrap: "new" });

    expect(wakes.targets).toHaveLength(1);
    expect(wakes.targets[0]!.ref).toEqual(context.ref);
    wakes.targets[0]!.wake("queued");
    wakes.targets[0]!.wake("steered");
    expect(hostFixture.wakes.map(({ kind }) => kind)).toEqual([
      "queued",
      "steered",
    ]);
    // The host receives only the restricted bound context.
    const bound = hostFixture.wakes[0]!.context;
    expect(bound.signal).toBe(context.signal);
    expect(bound).not.toHaveProperty("steer");
    expect(bound).not.toHaveProperty("followUp");

    await composed.release();
    expect(wakes.stops).toEqual([wakes.targets[0]]);
  });
});
