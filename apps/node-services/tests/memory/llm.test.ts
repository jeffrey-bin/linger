import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  requestMemoryStructuredOutput,
  runMemoryModelChain,
  runValidatedMemoryModelUpdate,
  setMemoryModelCall,
} from "../../src/memory/llm.js";
import { parseMemoryUpdateOutput } from "../../src/memory/apply.js";
import {
  ModelCallError,
  type ModelCall,
} from "../../src/runtime-model-call.js";
import { stubModelCall } from "../model-call-stub.js";

const owner = { tenantId: "tenant_1", ownerActorId: "human_1" };
let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-model-test-"));
});

afterEach(async () => {
  setMemoryModelCall(() => undefined);
  await fs.rm(root, { recursive: true, force: true });
});

async function artifactsWith(name: string, prompt = "{}", schema = "{}") {
  const artifacts = {
    promptPath: path.join(root, `${name}-prompt.txt`),
    schemaPath: path.join(root, `${name}-schema.json`),
    outputPath: path.join(root, `${name}-output.json`),
  };
  await fs.writeFile(artifacts.promptPath, prompt);
  await fs.writeFile(artifacts.schemaPath, schema);
  return artifacts;
}

/** A model call answering with the first output the request's check
 * accepts, as the kind's attempts would. */
function answering(...outputs: Record<string, unknown>[]) {
  const reasons: string[] = [];
  const call = vi.fn<ModelCall["call"]>(async (request) => {
    for (const output of outputs) {
      const reason = await request.validate?.(output);
      if (reason === undefined) return { output, model: "codex" };
      reasons.push(reason);
    }
    throw new ModelCallError("invalid_output", reasons.join("; "));
  });
  return { modelCall: stubModelCall({ call }), call, reasons };
}

const accept = async () => undefined;

describe("Memory model calls", () => {
  it("sends the owner, prompt and schema at low effort as the Memory kind", async () => {
    const artifacts = await artifactsWith("prompt", '{"updates":[]}');
    const { modelCall, call } = answering({ updates: [] });
    await expect(
      runValidatedMemoryModelUpdate(owner, artifacts, accept, { modelCall }),
    ).resolves.toBe(artifacts.outputPath);
    expect(call).toHaveBeenCalledWith({
      kind: "memory",
      key: "memory:memory_update",
      owner,
      input: '{"updates":[]}',
      schemaName: "memory_update",
      outputSchema: {},
      validate: expect.any(Function),
    });
    await expect(fs.readFile(artifacts.outputPath, "utf8")).resolves.toBe(
      '{\n  "updates": []\n}\n',
    );
  });

  it("passes a structured request's effort and instructions", async () => {
    const { modelCall, call } = answering({ ok: true });
    await requestMemoryStructuredOutput(
      {
        owner,
        system: "rules",
        user: "input",
        schemaName: "tracking_extract",
        schema: {},
        reasoningEffort: "medium",
      },
      { modelCall },
    );
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        owner,
        effort: "medium",
        instructions: "rules",
        input: "input",
      }),
    );
  });

  it("fails without the agent role's model call", async () => {
    const artifacts = await artifactsWith("none");
    await expect(
      runValidatedMemoryModelUpdate(owner, artifacts, accept),
    ).rejects.toThrow("Memory model calls need the agent role");
  });

  it("runs a Memory flow as one ModelCall chain", async () => {
    const spec = { kind: "memory", owner, key: "memory.facts:abc" } as const;
    const body = async () => "done";
    const chain = vi.fn(async () => "queued");
    await expect(
      runMemoryModelChain(spec, body, {
        modelCall: stubModelCall({ chain: chain as ModelCall["chain"] }),
      }),
    ).resolves.toBe("queued");
    expect(chain).toHaveBeenCalledWith(spec, body);
  });

  it("rejects an answer the file validator refuses, with its message as the reason", async () => {
    const subject = "agent_5f85f4dfa28c0c66c29addd6c20f5a8e";
    const artifacts = await artifactsWith("subject", "Return project memory.");
    const file = (prefix: string) => ({
      schema_version: 1,
      date: "2026-08-25",
      deleted_paths: [],
      memory_log_entries: [],
      files: [
        {
          path: `${prefix}/knowledge/projects/new-project.md`,
          content: "# Project\n",
        },
      ],
    });
    const { modelCall, reasons } = answering(
      file(subject.slice(0, -1)),
      file(subject),
    );
    setMemoryModelCall(() => modelCall);
    await runValidatedMemoryModelUpdate(
      owner,
      artifacts,
      async (outputPath) => {
        parseMemoryUpdateOutput(await fs.readFile(outputPath, "utf8"), [
          subject,
        ]);
      },
    );
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("knowledge/projects/new-project.md");
    expect(
      parseMemoryUpdateOutput(await fs.readFile(artifacts.outputPath, "utf8"), [
        subject,
      ]).files[0]?.path,
    ).toBe(`${subject}/knowledge/projects/new-project.md`);
  });

  it("writes the answer of a call it joined, whose check it never ran", async () => {
    const artifacts = await artifactsWith("joined");
    const answer = {
      files: [{ content: "## **Daily Work**:\n", path: " a\\b.md " }],
    };
    const call = vi.fn<ModelCall["call"]>(async () => ({
      output: answer,
      model: "codex",
    }));
    await runValidatedMemoryModelUpdate(owner, artifacts, accept, {
      modelCall: stubModelCall({ call }),
    });
    expect(JSON.parse(await fs.readFile(artifacts.outputPath, "utf8"))).toEqual(
      answer,
    );
  });
});
