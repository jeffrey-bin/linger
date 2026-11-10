import { describe, expect, it, vi } from "vitest";

import {
  agentInstructions,
  agentStepSchema,
  estimateTokens,
  runAgentTask,
  strictObject,
  taskTokens,
  type AgentEnvironment,
  type AgentTask,
} from "../src/memory-agent.js";
import {
  ModelCallError,
  type ModelChain,
  type ModelChainCallRequest,
} from "../src/runtime-model-call.js";

const task: AgentTask = {
  name: "test.task",
  instructions: "Keep the notes current.",
  objects: [
    {
      type: "note",
      instructions: "A note is one line.",
      payloadSchema: strictObject({ text: { type: "string" } }),
    },
  ],
  tools: [
    {
      name: "read",
      description: "Read a source.",
      argumentsSchema: strictObject({ source: { type: "string" } }),
    },
  ],
  maxSteps: 3,
  maxActions: 5,
  maxResultChars: 2_000,
  effort: "low",
  timeoutMs: 1_000,
};

/** A model chain whose calls fail unless the test gives `call`. */
function stubChain(overrides: Partial<ModelChain> = {}): ModelChain {
  const unused = () => Promise.reject(new Error("unused model call"));
  return {
    signal: new AbortController().signal,
    call: unused,
    text: unused,
    workspace: unused,
    ...overrides,
  };
}

function environment(
  overrides: Partial<AgentEnvironment> = {},
): AgentEnvironment {
  return {
    runTool: vi.fn(async (_name, args) => ({
      ok: true,
      content: `text of ${String(args.source)}`,
    })),
    propose: vi.fn(async (_object, _target, payload) =>
      String(payload.text).length > 0
        ? { ok: true, content: "accepted" }
        : { ok: false, content: "text is empty" },
    ),
    ...overrides,
  };
}

describe("agentStepSchema", () => {
  it("allows each tool, each object's proposal and finish, with every property required", () => {
    const schema = agentStepSchema(task) as {
      properties: {
        actions: {
          maxItems: number;
          items: { anyOf: { required: string[] }[] };
        };
      };
      required: string[];
    };
    expect(schema.required).toEqual(["actions"]);
    expect(schema.properties.actions.maxItems).toBe(5);
    expect(
      schema.properties.actions.items.anyOf.map((branch) => branch.required),
    ).toEqual([
      ["tool", "arguments"],
      ["tool", "object", "target", "payload"],
      ["tool", "summary"],
    ]);
  });
});

describe("agentInstructions", () => {
  it("puts the shared principles, the task, its objects and tools in one fixed prefix", () => {
    const text = agentInstructions(task);
    expect(text.indexOf("# Shared Memory Principles")).toBe(0);
    expect(text).toContain("Keep the notes current.");
    expect(text).toContain("### note\n\nA note is one line.");
    expect(text).toContain("- `read`: Read a source.");
    expect(text).toContain("at most 3 steps");
  });
});

describe("runAgentTask", () => {
  it("runs reads before proposals, feeds the results back and stops at finish", async () => {
    const inputs: string[] = [];
    const steps: string[] = [];
    const replies = [
      {
        actions: [
          {
            tool: "propose",
            object: "note",
            target: "n1",
            payload: { text: "" },
          },
          { tool: "read", arguments: { source: "s1" } },
        ],
      },
      {
        actions: [
          {
            tool: "propose",
            object: "note",
            target: "n1",
            payload: { text: "fixed" },
          },
          { tool: "finish", summary: "done" },
        ],
      },
    ];
    const model = stubChain({
      call: vi.fn(async (request: ModelChainCallRequest) => {
        inputs.push(request.input);
        steps.push(request.step);
        expect(request.schemaName).toBe("memory_agent_step");
        expect(request.instructions).toContain("Keep the notes current.");
        return { output: replies.shift()!, model: "test" };
      }),
    });
    const env = environment();
    const result = await runAgentTask({
      model,
      step: "test",
      task,
      input: "Evidence: s1.",
      environment: env,
    });
    expect(result).toMatchObject({
      finished: true,
      summary: "done",
      accepted: 1,
      rejected: 1,
    });
    expect(result.steps[0]!.calls).toEqual([
      'read {"source":"s1"}',
      "propose note n1",
    ]);
    expect(inputs[1]).toContain("rejected: text is empty");
    // The rejected draft comes back so the next step fixes it.
    expect(inputs[1]).toContain(
      'Your rejected draft, to fix and resend in full: {"text":""}',
    );
    expect(inputs[1]).toContain("ok: text of s1");
    expect(inputs[1]).toContain("This is step 2 of at most 3.");
    expect(steps).toEqual(["test/1", "test/2"]);
  });

  it("keeps going after a finish whose step had a rejected proposal", async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({
        output: {
          actions: [
            {
              tool: "propose",
              object: "note",
              target: "n1",
              payload: { text: "" },
            },
            { tool: "finish", summary: "too early" },
          ],
        },
        model: "test",
      })
      .mockResolvedValueOnce({
        output: {
          actions: [
            {
              tool: "propose",
              object: "note",
              target: "n1",
              payload: { text: "fixed" },
            },
            { tool: "finish", summary: "done" },
          ],
        },
        model: "test",
      });
    const result = await runAgentTask({
      model: stubChain({ call }),
      step: "test",
      task,
      input: "",
      environment: environment(),
    });
    expect(result).toMatchObject({
      finished: true,
      summary: "done",
      accepted: 1,
    });
    expect(call).toHaveBeenCalledTimes(2);
    // The model learns its finish waited for the fix.
    expect(call.mock.calls[1]![0].input).toContain(
      "- finish\n  rejected: Not done yet: resend the rejected proposals above, fixed",
    );
  });

  it("ends unfinished at the step limit, ignores actions outside the task and runs a repeated read once", async () => {
    const model = stubChain({
      call: vi.fn(async () => ({
        output: {
          actions: [
            { tool: "write_file", arguments: { path: "x" } },
            { tool: "propose", object: "other", target: "x", payload: {} },
            { tool: "read", arguments: { source: "s1" } },
          ],
        },
        model: "test",
      })),
    });
    const env = environment();
    const result = await runAgentTask({
      model,
      step: "test",
      task,
      input: "",
      environment: env,
    });
    expect(result.finished).toBe(false);
    expect(result.steps).toHaveLength(3);
    expect(env.runTool).toHaveBeenCalledTimes(1);
    expect(result.steps[2]!.observations[0]!.content).toBe(
      "Same as in step 1; its result is above.",
    );
    expect(env.propose).not.toHaveBeenCalled();
  });

  it("sends each step once with its cap in a session of its own", async () => {
    const call = vi.fn().mockResolvedValue({
      output: { actions: [{ tool: "finish", summary: "ok" }] },
      model: "test",
    });
    const result = await runAgentTask({
      model: stubChain({ call }),
      step: "test",
      task: { ...task, maxOutputChars: 24_000 },
      input: "",
      environment: environment(),
    });
    expect(result.finished).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]![0]).toMatchObject({
      step: "test/1",
      maxOutputChars: 24_000,
      sessionKey: expect.stringMatching(/\/1$/u),
    });
  });

  it("passes a step's failure past its kind's attempts to the caller", async () => {
    for (const kind of [
      "computer_offline",
      "timed_out",
      "output_limited",
      "invalid_output",
    ] as const) {
      const call = vi.fn().mockRejectedValue(new ModelCallError(kind, kind));
      await expect(
        runAgentTask({
          model: stubChain({ call }),
          step: "test",
          task,
          input: "",
          environment: environment(),
        }),
      ).rejects.toMatchObject({ kind });
      expect(call).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps a rejected draft until it is resent, says what is owed and ends once nothing is", async () => {
    const inputs: string[] = [];
    const propose = (text: string) => ({
      actions: [
        { tool: "propose", object: "note", target: "n1", payload: { text } },
      ],
    });
    const replies = [
      propose(""),
      { actions: [{ tool: "read", arguments: { source: "s1" } }] },
      propose(""),
      // No finish: the task ends once the note is accepted.
      propose("fixed"),
    ];
    const call = vi.fn(async (request: ModelChainCallRequest) => {
      inputs.push(request.input);
      return { output: replies.shift()!, model: "test" };
    });
    let written = false;
    const env = environment({
      unfinished: () => (written ? undefined : "propose note n1"),
    });
    const accept = env.propose;
    env.propose = vi.fn(async (object, target, payload) => {
      const result = await accept(object, target, payload);
      written ||= result.ok;
      return result;
    });
    const result = await runAgentTask({
      model: stubChain({ call }),
      step: "test",
      task: { ...task, maxSteps: 4 },
      input: "",
      environment: env,
    });
    expect(call).toHaveBeenCalledTimes(4);
    expect(result).toMatchObject({ finished: true, accepted: 1 });
    // A read in between does not drop the draft of the earlier rejection.
    expect(inputs[2]).toContain(
      'Your rejected draft, to fix and resend in full: {"text":""}',
    );
    expect(inputs[2]).toContain("Still to do: propose note n1.");
    // Once resent, the older rejection only points at the newer one.
    expect(inputs[3]).toContain(
      "- propose note n1\n  rejected; resent in step 3",
    );
    expect(inputs[3]).toContain("This is the last step (4 of 4).");
  });

  it("ends as soon as nothing is owed, without asking the model to finish", async () => {
    const call = vi.fn(async () => ({
      output: {
        actions: [
          {
            tool: "propose",
            object: "note",
            target: "n1",
            payload: { text: "done" },
          },
        ],
      },
      model: "test",
    }));
    const result = await runAgentTask({
      model: stubChain({ call }),
      step: "test",
      task,
      input: "",
      environment: environment({ unfinished: () => undefined }),
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ finished: true, accepted: 1 });
  });

  it("refuses a finish while work is owed, until the steps run out", async () => {
    const inputs: string[] = [];
    const call = vi.fn(async (request: ModelChainCallRequest) => {
      inputs.push(request.input);
      return {
        output: { actions: [{ tool: "finish", summary: "done" }] },
        model: "test",
      };
    });
    const result = await runAgentTask({
      model: stubChain({ call }),
      step: "test",
      task,
      input: "",
      environment: environment({ unfinished: () => "note n2" }),
    });
    expect(call).toHaveBeenCalledTimes(3);
    expect(inputs[1]).toContain("Not done yet: note n2");
    expect(result).toMatchObject({ finished: true, summary: "done" });
  });

  it("shortens older steps when a call would pass 85% of its token budget", async () => {
    const inputs: string[] = [];
    let read = 0;
    const call = vi.fn(async (request: ModelChainCallRequest) => {
      inputs.push(request.input);
      read += 1;
      return {
        output: {
          actions: [{ tool: "read", arguments: { source: `s${read}` } }],
        },
        model: "test",
      };
    });
    const instructionTokens = estimateTokens(agentInstructions(task));
    await runAgentTask({
      model: stubChain({ call }),
      step: "test",
      task: { ...task, maxSteps: 4 },
      input: "Evidence.",
      environment: environment({
        runTool: async (_name, args) => ({
          ok: true,
          content: `${String(args.source)} ${"x".repeat(1_500)}`,
        }),
      }),
      // Room for the fixed prefix and about one step's results.
      maxInputTokens: Math.ceil((instructionTokens + 700) / 0.85),
    });
    // The latest step keeps its result; older ones lose theirs, then go.
    expect(inputs[3]).toContain("ok: s3 x");
    expect(inputs[3]).not.toContain("ok: s1 x");
    expect(inputs[3]).toMatch(/Steps 1 to \d are omitted|result shortened/u);
  });

  it("cuts a step's results to the task's character budget", async () => {
    const model = stubChain({
      call: vi
        .fn()
        .mockResolvedValueOnce({
          output: { actions: [{ tool: "read", arguments: { source: "big" } }] },
          model: "test",
        })
        .mockResolvedValueOnce({
          output: { actions: [{ tool: "finish", summary: "" }] },
          model: "test",
        }),
    });
    const result = await runAgentTask({
      model,
      step: "test",
      task,
      input: "",
      environment: environment({
        runTool: async () => ({ ok: true, content: "x".repeat(5_000) }),
      }),
    });
    expect(result.steps[0]!.observations[0]!.content).toMatch(
      /^x{2000}\n…\[3000 more characters cut/u,
    );
  });
});

describe("budget", () => {
  it("gives each task half of the model's context window, with no cap", () => {
    expect(taskTokens(128_000)).toBe(64_000);
    expect(taskTokens(1_000_000)).toBe(500_000);
    // An unknown window is taken as 200,000 tokens.
    expect(taskTokens(undefined)).toBe(100_000);
  });

  it("estimates tokens as UTF-8 bytes over three", () => {
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("メモ")).toBe(2);
  });
});
