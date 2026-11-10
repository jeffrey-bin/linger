import { describe, expect, it, vi } from "vitest";

import { composeRunFeatures } from "../../../src/agent/agent-features/compose.js";
import {
  defineFeature,
  type FeatureDeclaration,
} from "../../../src/agent/agent-features/contracts.js";
import {
  createTaskInputFeature,
  TASK_INPUT_FEATURE_ID,
  type TaskInputFeatureDeps,
} from "../../../src/agent/agent-features/task-input/index.js";
import type { ContextRuntimeBackendActivation } from "../../../src/agent/executor/activation.js";
import type { AgentInput } from "../../../src/agent/executor/provider.js";
import { makeTestActivationView } from "./fixtures.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const input = (text: string): AgentInput => ({ type: "text", text });

const feature = (
  prepareRunInput?: TaskInputFeatureDeps["prepareRunInput"],
): FeatureDeclaration =>
  createTaskInputFeature({
    prepareRunInput: prepareRunInput ?? (async (current) => current),
  });

describe("createTaskInputFeature", () => {
  it("requires the CLI run-input capability", () => {
    expect(() => createTaskInputFeature({} as TaskInputFeatureDeps)).toThrow(
      /requires prepareRunInput/,
    );
  });

  it("matches ordinary activation views", () => {
    const composed = composeRunFeatures({
      view: makeTestActivationView(),
      features: [feature()],
    });
    expect(composed.matched).toEqual([TASK_INPUT_FEATURE_ID]);
  });

  it("returns the backend capability output verbatim", async () => {
    const preparedOutput: AgentInput = {
      type: "text",
      text: "prepared",
      cliRunContext: {
        run_id: "run-one",
        scope: { kind: "task", id: "task-one" },
      },
    };
    const prepare = vi.fn(async () => preparedOutput);
    const signal = new AbortController().signal;
    const composed = composeRunFeatures({
      view: makeTestActivationView(),
      features: [feature(prepare)],
    });
    const original = input("original");
    const result = await composed.prepareRunInput(original, signal);
    expect(result).toBe(preparedOutput);
    expect(prepare).toHaveBeenCalledWith(original, signal);
  });

  it("composes with other run features in declared order", async () => {
    const order: string[] = [];
    const backend = vi.fn(async (current: AgentInput) => {
      order.push("backend");
      return { ...current, text: `${current.text}+cli` };
    });
    const later = defineFeature({
      id: "later",
      run: {
        ports: { prepareRunInput: { after: [TASK_INPUT_FEATURE_ID] } },
        create: () => ({
          prepareRunInput: async (_view, current) => {
            order.push("later");
            return { ...current, text: `${current.text}+later` };
          },
        }),
      },
    });
    const composed = composeRunFeatures({
      view: makeTestActivationView(),
      // Declaration order is irrelevant; the after edge decides.
      features: [later, feature(backend)],
    });
    expect(composed.matched).toEqual(["later", TASK_INPUT_FEATURE_ID]);
    const result = await composed.prepareRunInput(
      input("x"),
      new AbortController().signal,
    );
    expect(order).toEqual(["backend", "later"]);
    expect(result.text).toBe("x+cli+later");
  });

  it("waits for the backend capability before resolving", async () => {
    const gate = deferred<AgentInput>();
    const prepare = vi.fn((_current: AgentInput) => gate.promise);
    const composed = composeRunFeatures({
      view: makeTestActivationView(),
      features: [feature(prepare)],
    });
    const pending = composed.prepareRunInput(
      input("x"),
      new AbortController().signal,
    );
    let settled = false;
    void pending.then(
      () => (settled = true),
      () => (settled = true),
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.resolve(input("done"));
    await expect(pending).resolves.toEqual(input("done"));
  });

  it("propagates cancellation from the run signal", async () => {
    const controller = new AbortController();
    const prepare = vi.fn(async (current: AgentInput) => {
      controller.abort();
      return current;
    });
    const composed = composeRunFeatures({
      view: makeTestActivationView(),
      features: [feature(prepare)],
    });
    await expect(
      composed.prepareRunInput(input("x"), controller.signal),
    ).rejects.toThrow();
    expect(prepare).toHaveBeenCalledWith(input("x"), controller.signal);
  });

  it("keeps the backend receiver when the capability needs this binding", async () => {
    // The composition root contract: hand the factory the backend method
    // already bound to its activation instance.
    const backend: Pick<ContextRuntimeBackendActivation, "prepareRunInput"> & {
      readonly tag: string;
    } = {
      tag: "cli:",
      async prepareRunInput(current: AgentInput) {
        return { ...current, text: `${this.tag}${current.text}` };
      },
    };
    const composed = composeRunFeatures({
      view: makeTestActivationView(),
      features: [
        createTaskInputFeature({
          prepareRunInput: backend.prepareRunInput!.bind(backend),
        }),
      ],
    });
    await expect(
      composed.prepareRunInput(input("body"), new AbortController().signal),
    ).resolves.toEqual(input("cli:body"));
  });
});
