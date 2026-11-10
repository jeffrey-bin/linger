import { describe, expect, it, vi } from "vitest";
import {
  assertValidFeatureCatalog,
  composeActivationFeatures,
  composeContextFeatures,
  composeRunFeatures,
  featureMatches,
} from "../../../src/agent/agent-features/compose.js";
import type {
  BoundFeatureContext,
  ContextBoundSource,
  FeatureContext,
  FeatureDeclaration,
  RuntimePreparation,
} from "../../../src/agent/agent-features/contracts.js";
import { defineFeature } from "../../../src/agent/agent-features/contracts.js";
import type { Message } from "../../../src/agent/executor/types.js";
import type { AgentInput } from "../../../src/agent/executor/provider.js";
import {
  makeTestActivationView,
  makeTestFeatureContext,
  makeTestMessage,
} from "./fixtures.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const contextFeature = (
  id: string,
  ports: Record<
    string,
    { after?: readonly string[]; requires?: readonly string[] }
  >,
  handlers: Record<string, unknown>,
  extra?: { match?: FeatureDeclaration["match"] },
): FeatureDeclaration =>
  defineFeature({
    id,
    ...(extra?.match ? { match: extra.match } : {}),
    context: {
      ports,
      create: () => handlers,
    },
  });

describe("assertValidFeatureCatalog", () => {
  const valid = (id: string) =>
    contextFeature(id, { onRunEvent: {} }, { onRunEvent: () => null });

  it("rejects duplicate identities", () => {
    expect(() => assertValidFeatureCatalog([valid("a"), valid("a")])).toThrow(
      /Duplicate feature identity: a/,
    );
  });

  it("rejects a feature without any lifecycle scope", () => {
    const bare = { id: "bare" } as FeatureDeclaration;
    expect(() => assertValidFeatureCatalog([bare])).toThrow(
      /declares no lifecycle scope/,
    );
  });

  it("rejects an empty ports declaration", () => {
    const empty = defineFeature({
      id: "empty",
      context: { ports: {}, create: () => ({}) },
    });
    expect(() => assertValidFeatureCatalog([empty])).toThrow(
      /declares no context ports/,
    );
  });

  it("rejects unknown port names", () => {
    const feature = contextFeature(
      "bad-port",
      { nope: {} },
      {
        nope: () => null,
      },
    );
    expect(() => assertValidFeatureCatalog([feature])).toThrow(
      /unknown port context.nope/,
    );
  });

  it("rejects after references to unknown features", () => {
    const feature = contextFeature(
      "a",
      { onRunEvent: { after: ["ghost"] } },
      { onRunEvent: () => null },
    );
    expect(() => assertValidFeatureCatalog([feature])).toThrow(
      /orders after unknown feature ghost/,
    );
  });

  it("rejects after references to a feature missing that port", () => {
    const a = contextFeature(
      "a",
      { onRunEvent: { after: ["b"] } },
      { onRunEvent: () => null },
    );
    const b = contextFeature(
      "b",
      { onRunTerminal: {} },
      { onRunTerminal: () => undefined },
    );
    expect(() => assertValidFeatureCatalog([a, b])).toThrow(
      /after b, which does not declare that port/,
    );
  });

  it("rejects requires references to unknown features or missing scopes", () => {
    const a = contextFeature(
      "a",
      { onRunEvent: { requires: ["ghost"] } },
      { onRunEvent: () => null },
    );
    expect(() => assertValidFeatureCatalog([a])).toThrow(
      /requires unknown feature ghost/,
    );
    const b = contextFeature(
      "b",
      { onRunEvent: { requires: ["c"] } },
      { onRunEvent: () => null },
    );
    const c: FeatureDeclaration = {
      id: "c",
      activation: { ports: { prepareRuntime: {} }, create: () => ({}) },
    };
    expect(() => assertValidFeatureCatalog([b, c])).toThrow(/does not declare/);
  });

  it("rejects empty match dimensions", () => {
    const a = contextFeature(
      "a",
      { onRunEvent: {} },
      { onRunEvent: () => null },
      { match: { agentTypes: [] } },
    );
    expect(() => assertValidFeatureCatalog([a])).toThrow(/empty agentTypes/);
  });

  it("rejects ordering cycles", () => {
    const a = contextFeature(
      "a",
      { onRunEvent: { after: ["b"] } },
      { onRunEvent: () => null },
    );
    const b = contextFeature(
      "b",
      { onRunEvent: { after: ["a"] } },
      { onRunEvent: () => null },
    );
    expect(() => assertValidFeatureCatalog([a, b])).toThrow(/ordering cycle/);
  });
});

describe("featureMatches", () => {
  const feature = (match?: FeatureDeclaration["match"]) =>
    defineFeature({
      id: "m",
      ...(match ? { match } : {}),
      context: { ports: { onRunEvent: {} }, create: () => ({}) },
    });

  it("treats an omitted match as always matching", () => {
    expect(featureMatches(feature(), { contextKind: "document" })).toBe(true);
  });

  it("applies AND across dimensions and OR inside one dimension", () => {
    const f = feature({
      agentTypes: ["anotherme", "general"],
      contextKinds: ["meta"],
    });
    expect(
      featureMatches(f, { agentType: "general", contextKind: "meta" }),
    ).toBe(true);
    expect(
      featureMatches(f, { agentType: "general", contextKind: "document" }),
    ).toBe(false);
    expect(
      featureMatches(f, { agentType: "anotherme", contextKind: "meta" }),
    ).toBe(true);
  });

  it("fails loudly when a declared agentTypes dim has no supplied value", () => {
    const f = feature({ agentTypes: ["anotherme"] });
    expect(() => featureMatches(f, { contextKind: "meta" })).toThrow(
      /no agentType was supplied/,
    );
  });
});

describe("composeContextFeatures", () => {
  const compose = (
    features: readonly FeatureDeclaration[],
    overrides?: Partial<FeatureContext>,
    extra?: {
      mergeInputContribution?: Parameters<
        typeof composeContextFeatures
      >[0]["mergeInputContribution"];
    },
  ) => {
    const { context } = makeTestFeatureContext(overrides);
    return composeContextFeatures({ context, features, ...extra });
  };

  it("matches on agentType and contextKind from the bound context", () => {
    const onlyAnotherMe = contextFeature(
      "only-am",
      { onRunEvent: {} },
      { onRunEvent: () => null },
      { match: { agentTypes: ["anotherme"] } },
    );
    const onlyMeta = contextFeature(
      "only-meta",
      { onRunEvent: {} },
      { onRunEvent: () => null },
      { match: { contextKinds: ["meta"] } },
    );
    const onlyDocument = contextFeature(
      "only-doc",
      { onRunEvent: {} },
      { onRunEvent: () => null },
      { match: { contextKinds: ["document"] } },
    );
    const composed = compose([onlyAnotherMe, onlyMeta, onlyDocument]);
    expect([...composed.matched].sort()).toEqual(["only-am", "only-meta"]);
  });

  it("fails when a required feature is unmatched", () => {
    const a = contextFeature(
      "a",
      { onRunEvent: { requires: ["b"] } },
      { onRunEvent: () => null },
    );
    const b = contextFeature(
      "b",
      { onRunEvent: {} },
      { onRunEvent: () => null },
      { match: { contextKinds: ["document"] } },
    );
    expect(() => compose([a, b])).toThrow(/requires b .*not matched/);
  });

  it("fails when a declared port returns no handler", () => {
    const a = contextFeature("a", { onRunEvent: {} }, {});
    expect(() => compose([a])).toThrow(
      /declares port context.onRunEvent but returned no handler/,
    );
  });

  it("fails on undeclared returned handlers", () => {
    const a = contextFeature(
      "a",
      { onRunEvent: {} },
      { onRunEvent: () => null, onRunTerminal: () => undefined },
    );
    expect(() => compose([a])).toThrow(
      /undeclared handler context.onRunTerminal/,
    );
  });

  it("orders handlers by after edges with stable id tie-break", () => {
    const calls: string[] = [];
    const record = (id: string) => () => {
      calls.push(id);
      return null;
    };
    const a = contextFeature(
      "a",
      { onRunEvent: { after: ["c"] } },
      { onRunEvent: record("a") },
    );
    const b = contextFeature(
      "b",
      { onRunEvent: {} },
      { onRunEvent: record("b") },
    );
    const c = contextFeature(
      "c",
      { onRunEvent: {} },
      { onRunEvent: record("c") },
    );
    compose([a, b, c]).onRunEvent({ type: "run.started" });
    expect(calls).toEqual(["b", "c", "a"]);
  });

  it("joins context instructions in declared order", () => {
    const a = contextFeature(
      "a",
      { contributeContextInstructions: {} },
      { contributeContextInstructions: () => "A" },
    );
    const b = contextFeature(
      "b",
      { contributeContextInstructions: {} },
      { contributeContextInstructions: () => undefined },
    );
    const c = contextFeature(
      "c",
      { contributeContextInstructions: {} },
      { contributeContextInstructions: () => "C" },
    );
    expect(
      compose([a, b, c]).contextInstructions({
        connectedApps: true,
        compactInstructions: false,
      }),
    ).toBe("A\n\nC");
  });

  it("flatMaps notification contributions in order with the same input", () => {
    const seen: [string, unknown][] = [];
    const a = contextFeature(
      "a",
      { contributeNotificationContext: {} },
      {
        contributeNotificationContext: (_view: unknown, input: unknown) => {
          seen.push(["a", input]);
          return ["A1", "A2"];
        },
      },
    );
    const b = contextFeature(
      "b",
      { contributeNotificationContext: {} },
      {
        contributeNotificationContext: (_view: unknown, input: unknown) => {
          seen.push(["b", input]);
          return ["B"];
        },
      },
    );
    const input = { inboxId: "room-1", messages: [] };
    expect(compose([a, b]).notificationContext(input)).toEqual([
      "A1",
      "A2",
      "B",
    ]);
    expect(seen[0]![1]).toBe(input);
    expect(seen[1]![1]).toBe(input);
  });

  it("passes the same original message to every prepareInput handler and merges in order", () => {
    const seen: Message[] = [];
    const a = contextFeature(
      "a",
      { prepareInput: {} },
      {
        prepareInput: (_view: unknown, message: Message) => {
          seen.push(message);
          return { text: "A" };
        },
      },
    );
    const b = contextFeature(
      "b",
      { prepareInput: {} },
      {
        prepareInput: (_view: unknown, message: Message) => {
          seen.push(message);
          return null;
        },
      },
    );
    const original = makeTestMessage("body");
    const prepared = compose([a, b]).prepareInput(original);
    expect(seen[0]).toBe(original);
    expect(seen[1]).toBe(original);
    expect(prepared.rawMessage).toBe("body\n\nA");
    expect(prepared.segments[0]).toEqual({
      type: "text",
      content: "body\n\nA",
    });
  });

  it("keeps segment-only messages visible when merging a contribution", () => {
    const a = contextFeature(
      "a",
      { prepareInput: {} },
      { prepareInput: () => ({ text: "extra" }) },
    );
    const original: Message = {
      messageId: "m-1",
      rawMessage: "",
      segments: [
        { type: "text", content: "body" },
        {
          type: "file",
          content: "attachment",
          document_id: "doc-1",
          document_version_id: "v-1",
        },
      ],
    };
    const prepared = compose([a]).prepareInput(original);
    // The formatter falls back to segment contents when rawMessage is empty;
    // a contribution-only rawMessage would shadow the original body.
    expect(prepared.rawMessage).toBe("");
    expect(prepared.segments[0]).toEqual({
      type: "text",
      content: "body\n\nextra",
    });
    expect(prepared.segments[1]).toEqual(original.segments[1]);
  });

  it("appends a trailing text segment when a segment-only message has no text", () => {
    const a = contextFeature(
      "a",
      { prepareInput: {} },
      { prepareInput: () => ({ text: "extra" }) },
    );
    const original: Message = {
      messageId: "m-1",
      rawMessage: "",
      segments: [
        {
          type: "file",
          content: "attachment",
          document_id: "doc-1",
          document_version_id: "v-1",
        },
      ],
    };
    const prepared = compose([a]).prepareInput(original);
    expect(prepared.rawMessage).toBe("");
    expect(prepared.segments).toEqual([
      original.segments[0],
      { type: "text", content: "extra" },
    ]);
  });

  it("uses the injected contribution merger", () => {
    const merge = vi.fn((message: Message, contribution: { text: string }) =>
      Object.freeze({ ...message, rawMessage: `<<${contribution.text}>>` }),
    );
    const a = contextFeature(
      "a",
      { prepareInput: {} },
      { prepareInput: () => ({ text: "X" }) },
    );
    const { context } = makeTestFeatureContext();
    const composed = composeContextFeatures({
      context,
      features: [a],
      mergeInputContribution: merge,
    });
    composed.prepareInput(makeTestMessage("m"));
    expect(merge).toHaveBeenCalledTimes(1);
  });

  it("hides submission capabilities from non-submitting ports and create", async () => {
    let createSaw: BoundFeatureContext | undefined;
    let boundSaw: BoundFeatureContext | undefined;
    let afterSaw: FeatureContext | undefined;
    let timerSaw: FeatureContext | undefined;
    const a = defineFeature({
      id: "a",
      context: {
        ports: {
          onContextBound: {},
          afterInboxInputAccepted: {},
          onTimer: {},
        },
        create: (context) => {
          createSaw = context;
          return {
            onContextBound: (bound) => {
              boundSaw = bound;
            },
            afterInboxInputAccepted: (context) => {
              afterSaw = context;
            },
            onTimer: (context) => {
              timerSaw = context;
            },
          };
        },
      },
    });
    const { context } = makeTestFeatureContext();
    const composed = composeContextFeatures({ context, features: [a] });
    await composed.bindSources({ bootstrap: "new" });
    composed.afterInboxInputAccepted({
      inboxId: "i",
      inputId: "in-1",
      targeted: true,
    });
    composed.onTimer("a.check");
    expect(createSaw && "steer" in createSaw).toBe(false);
    expect(createSaw?.signal).toBe(context.signal);
    expect(boundSaw && "steer" in boundSaw).toBe(false);
    expect(afterSaw && "steer" in afterSaw).toBe(true);
    expect(timerSaw && "followUp" in timerSaw).toBe(true);
  });

  describe("bindSources", () => {
    it("binds in declared order and stops in reverse on release", async () => {
      const order: string[] = [];
      const source = (id: string) => ({
        stop: async () => {
          order.push(`stop:${id}`);
        },
      });
      const a = contextFeature(
        "a",
        { onContextBound: {} },
        { onContextBound: () => source("a") },
      );
      const b = contextFeature(
        "b",
        { onContextBound: { after: ["a"] } },
        { onContextBound: () => source("b") },
      );
      const composed = compose([a, b]);
      await composed.bindSources({ bootstrap: "new" });
      await composed.release();
      expect(order).toEqual(["stop:b", "stop:a"]);
    });

    it("stops earlier sources exactly once when a later bind fails", async () => {
      const stop = vi.fn(async () => undefined);
      const a = contextFeature(
        "a",
        { onContextBound: {} },
        { onContextBound: () => ({ stop }) },
      );
      const b = contextFeature(
        "b",
        { onContextBound: { after: ["a"] } },
        {
          onContextBound: () => {
            throw new Error("bind failed");
          },
        },
      );
      const composed = compose([a, b]);
      await expect(composed.bindSources({ bootstrap: "new" })).rejects.toThrow(
        /bind failed/,
      );
      expect(stop).toHaveBeenCalledTimes(1);
      await composed.release();
      expect(stop).toHaveBeenCalledTimes(1);
    });

    it("aborts subsequent binds and cleans up when the scope aborts mid-way", async () => {
      const stop = vi.fn(async () => undefined);
      const { context, scope } = makeTestFeatureContext();
      const a = contextFeature(
        "a",
        { onContextBound: {} },
        {
          onContextBound: () => {
            scope.abort();
            return { stop };
          },
        },
      );
      const later = vi.fn();
      const b = contextFeature(
        "b",
        { onContextBound: { after: ["a"] } },
        { onContextBound: later },
      );
      const composed = composeContextFeatures({ context, features: [a, b] });
      await expect(
        composed.bindSources({ bootstrap: "new" }),
      ).rejects.toThrow();
      expect(later).not.toHaveBeenCalled();
      expect(stop).toHaveBeenCalledTimes(1);
    });

    it("rejects binding after release", async () => {
      const composed = compose([]);
      await composed.release();
      await expect(composed.bindSources({ bootstrap: "new" })).rejects.toThrow(
        /after release/,
      );
    });

    it("stops a late-resolving source exactly once when release wins the wait", async () => {
      const stop = vi.fn(async () => undefined);
      const gate = deferred<ContextBoundSource>();
      const a = contextFeature(
        "a",
        { onContextBound: {} },
        { onContextBound: () => gate.promise },
      );
      const composed = compose([a]);
      const bind = composed.bindSources({ bootstrap: "new" });
      const release = composed.release();
      gate.resolve({ stop });
      await expect(bind).rejects.toThrow(/released during binding/);
      await expect(release).resolves.toBeUndefined();
      expect(stop).toHaveBeenCalledTimes(1);
    });

    it("rejects a second bind whether the first is in flight or completed", async () => {
      const gate = deferred<ContextBoundSource>();
      const a = contextFeature(
        "a",
        { onContextBound: {} },
        { onContextBound: () => gate.promise },
      );
      const composed = compose([a]);
      const first = composed.bindSources({ bootstrap: "new" });
      await expect(composed.bindSources({ bootstrap: "new" })).rejects.toThrow(
        /bind only once/,
      );
      gate.resolve({ stop: async () => undefined });
      await first;
      await expect(composed.bindSources({ bootstrap: "new" })).rejects.toThrow(
        /bind only once/,
      );
    });

    it("rejects a second bind after the first failed", async () => {
      const a = contextFeature(
        "a",
        { onContextBound: {} },
        {
          onContextBound: () => {
            throw new Error("bind failed");
          },
        },
      );
      const composed = compose([a]);
      await expect(composed.bindSources({ bootstrap: "new" })).rejects.toThrow(
        /bind failed/,
      );
      await expect(composed.bindSources({ bootstrap: "new" })).rejects.toThrow(
        /bind only once/,
      );
    });

    it("shares one cleanup promise across concurrent releases", async () => {
      const stop = vi.fn(async () => undefined);
      const a = contextFeature(
        "a",
        { onContextBound: {} },
        { onContextBound: () => ({ stop }) },
      );
      const composed = compose([a]);
      await composed.bindSources({ bootstrap: "new" });
      await Promise.all([
        composed.release(),
        composed.release(),
        composed.release(),
      ]);
      expect(stop).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps dispatching terminal observations while stopping", async () => {
    const terminal = vi.fn();
    const a = contextFeature(
      "a",
      { onRunTerminal: {} },
      { onRunTerminal: terminal },
    );
    const composed = compose([a]);
    await composed.release();
    composed.onRunTerminal({
      runId: "run-1",
      terminal: { type: "succeeded" },
    });
    expect(terminal).toHaveBeenCalledTimes(1);
  });

  it("isolates observer errors per feature in declared order", () => {
    const calls: string[] = [];
    const logger = vi.fn();
    const a = contextFeature(
      "a",
      { afterInboxInputAccepted: {} },
      {
        afterInboxInputAccepted: () => {
          calls.push("a");
          throw new Error("boom");
        },
      },
    );
    const b = contextFeature(
      "b",
      { afterInboxInputAccepted: {} },
      { afterInboxInputAccepted: () => calls.push("b") },
    );
    const { context } = makeTestFeatureContext();
    const composed = composeContextFeatures({
      context,
      features: [a, b],
      logger,
    });
    expect(() =>
      composed.afterInboxInputAccepted({
        inboxId: "i",
        inputId: "in-1",
        targeted: false,
      }),
    ).not.toThrow();
    expect(calls).toEqual(["a", "b"]);
    expect(logger).toHaveBeenCalledWith(
      "warn",
      "feature.after_inbox_input_failed",
      expect.objectContaining({ feature: "a" }),
    );
  });

  it("passes every timer name to every onTimer handler and isolates errors", () => {
    const calls: string[] = [];
    const logger = vi.fn();
    const a = contextFeature(
      "a",
      { onTimer: {} },
      {
        onTimer: (_context: unknown, name: string) => {
          calls.push(`a:${name}`);
          throw new Error("boom");
        },
      },
    );
    const b = contextFeature(
      "b",
      { onTimer: {} },
      {
        onTimer: (_context: unknown, name: string) => calls.push(`b:${name}`),
      },
    );
    const { context } = makeTestFeatureContext();
    const composed = composeContextFeatures({
      context,
      features: [a, b],
      logger,
    });
    expect(() => composed.onTimer("b.check")).not.toThrow();
    expect(calls).toEqual(["a:b.check", "b:b.check"]);
    expect(logger).toHaveBeenCalledWith(
      "warn",
      "feature.timer_failed",
      expect.objectContaining({ feature: "a" }),
    );
  });
});

describe("composeActivationFeatures", () => {
  const view = makeTestActivationView();
  const signal = new AbortController().signal;

  const activationFeature = (
    id: string,
    handlers: Record<string, unknown>,
    extra?: { match?: FeatureDeclaration["match"]; after?: readonly string[] },
  ): FeatureDeclaration =>
    defineFeature({
      id,
      ...(extra?.match ? { match: extra.match } : {}),
      activation: {
        ports: {
          prepareRuntime: { ...(extra?.after ? { after: extra.after } : {}) },
        },
        create: () => handlers,
      },
    });

  it("merges contributions in declared order", async () => {
    const a = activationFeature("a", {
      prepareRuntime: async () => ({
        runtimeViewMappings: [{ source: "a" }],
        checkNextRun: async () => true,
      }),
    });
    const b = activationFeature("b", {
      prepareRuntime: async () => ({ runtimeViewMappings: [{ source: "b" }] }),
    });
    const composed = composeActivationFeatures({ view, features: [a, b] });
    const prepared = await composed.prepare({ signal });
    expect(prepared.runtimeViewMappings).toEqual([
      { source: "a" },
      { source: "b" },
    ]);
    expect(prepared.checks).toHaveLength(1);
  });

  it("stops preparing after abort and cleans acquired releases", async () => {
    const relA = vi.fn(async () => undefined);
    const controller = new AbortController();
    const later = vi.fn();
    const a = activationFeature("a", {
      prepareRuntime: async () => {
        controller.abort();
        return { release: relA };
      },
    });
    const b = activationFeature(
      "b",
      { prepareRuntime: later },
      { after: ["a"] },
    );
    const composed = composeActivationFeatures({
      view,
      features: [a, b],
    });
    await expect(
      composed.prepare({ signal: controller.signal }),
    ).rejects.toThrow();
    expect(later).not.toHaveBeenCalled();
    expect(relA).toHaveBeenCalledTimes(1);
  });

  it("logs each feature preparation duration with its outcome", async () => {
    const logs: { level: string; event: string; fields: unknown }[] = [];
    const a = activationFeature("a", {
      prepareRuntime: async () => ({}),
    });
    const b = activationFeature("b", {
      prepareRuntime: async () => {
        throw new Error("b failed");
      },
    });
    const composed = composeActivationFeatures({
      view,
      features: [a, b],
      logger: (level, event, fields) => logs.push({ level, event, fields }),
    });
    await expect(composed.prepare({ signal })).rejects.toThrow("b failed");
    const prepared = logs.filter(
      ({ event }) => event === "context_activation.runtime_feature_prepared",
    );
    expect(prepared).toHaveLength(2);
    expect(prepared).toEqual(
      expect.arrayContaining([
        {
          level: "info",
          event: "context_activation.runtime_feature_prepared",
          fields: {
            feature: "a",
            durationMs: expect.any(Number),
            outcome: "fulfilled",
          },
        },
        {
          level: "info",
          event: "context_activation.runtime_feature_prepared",
          fields: {
            feature: "b",
            durationMs: expect.any(Number),
            outcome: "rejected",
          },
        },
      ]),
    );
  });

  it("matches agentTypes on the activation view and fails loudly without it", async () => {
    const onlyAnotherMe = activationFeature(
      "only-am",
      { prepareRuntime: async () => ({}) },
      { match: { agentTypes: ["anotherme"] } },
    );
    const composed = composeActivationFeatures({
      view,
      features: [onlyAnotherMe],
    });
    expect(composed.matched).toEqual(["only-am"]);
    const withoutType = { ...view, agentType: undefined };
    expect(() =>
      composeActivationFeatures({
        view: withoutType,
        features: [onlyAnotherMe],
      }),
    ).toThrow(/no agentType was supplied/);
  });

  it("releases a late-resolving preparation exactly once when release wins the wait", async () => {
    const rel = vi.fn(async () => undefined);
    const gate = deferred<RuntimePreparation>();
    const a = activationFeature("a", { prepareRuntime: () => gate.promise });
    const composed = composeActivationFeatures({ view, features: [a] });
    const prepare = composed.prepare({ signal });
    const release = composed.release();
    gate.resolve({ release: rel });
    await expect(prepare).rejects.toThrow(/released during preparation/);
    await expect(release).resolves.toBeUndefined();
    expect(rel).toHaveBeenCalledTimes(1);
  });

  it("releases in reverse order and only once", async () => {
    const order: string[] = [];
    const rel = (id: string) => async () => {
      order.push(id);
    };
    const a = activationFeature("a", {
      prepareRuntime: async () => ({ release: rel("a") }),
    });
    const b = activationFeature(
      "b",
      { prepareRuntime: async () => ({ release: rel("b") }) },
      { after: ["a"] },
    );
    const composed = composeActivationFeatures({ view, features: [a, b] });
    await composed.prepare({ signal });
    await composed.release();
    await composed.release();
    expect(order).toEqual(["b", "a"]);
  });

  it("starts independent preparations together and aborts the rest on the first failure", async () => {
    const failure = new Error("b failed");
    const signals: AbortSignal[] = [];
    const a = activationFeature("a", {
      prepareRuntime: (_view: unknown, input: { signal: AbortSignal }) => {
        signals.push(input.signal);
        return new Promise<never>((_resolve, reject) => {
          input.signal.addEventListener(
            "abort",
            () => reject(input.signal.reason),
            { once: true },
          );
        });
      },
    });
    const b = activationFeature("b", {
      prepareRuntime: async () => {
        throw failure;
      },
    });
    const composed = composeActivationFeatures({ view, features: [a, b] });
    await expect(composed.prepare({ signal })).rejects.toBe(failure);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(true);
  });
});

describe("composeRunFeatures", () => {
  const view = makeTestActivationView();
  const signal = new AbortController().signal;

  it("prepares run input sequentially in declared order", async () => {
    const order: string[] = [];
    const append =
      (id: string, text: string) =>
      async (_view: unknown, input: AgentInput) => {
        order.push(id);
        return { ...input, text: `${input.text}${text}` };
      };
    const a: FeatureDeclaration = {
      id: "a",
      run: {
        ports: { prepareRunInput: {} },
        create: () => ({ prepareRunInput: append("a", "-a") }),
      },
    };
    const b: FeatureDeclaration = {
      id: "b",
      run: {
        ports: { prepareRunInput: { after: ["a"] } },
        create: () => ({ prepareRunInput: append("b", "-b") }),
      },
    };
    const composed = composeRunFeatures({ view, features: [b, a] });
    const result = await composed.prepareRunInput(
      { type: "text", text: "x" },
      signal,
    );
    expect(order).toEqual(["a", "b"]);
    expect(result.text).toBe("x-a-b");
  });

  it("never invokes a handler when the signal is already aborted", async () => {
    const handler = vi.fn(async (_view: unknown, input: AgentInput) => input);
    const a: FeatureDeclaration = {
      id: "a",
      run: {
        ports: { prepareRunInput: {} },
        create: () => ({ prepareRunInput: handler }),
      },
    };
    const composed = composeRunFeatures({ view, features: [a] });
    const controller = new AbortController();
    controller.abort();
    await expect(
      composed.prepareRunInput({ type: "text", text: "x" }, controller.signal),
    ).rejects.toThrow(/abort/i);
    expect(handler).not.toHaveBeenCalled();
  });

  it("honors cancellation for an empty composition", async () => {
    const composed = composeRunFeatures({ view, features: [] });
    const controller = new AbortController();
    controller.abort();
    await expect(
      composed.prepareRunInput({ type: "text", text: "x" }, controller.signal),
    ).rejects.toThrow(/abort/i);
  });
});
