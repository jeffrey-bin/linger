import type { PromptArtifacts } from "./prompt.js";
import fs from "node:fs/promises";
import type {
  ModelCall,
  ModelCallEffort,
  ModelCallRequest,
  ModelOwner,
  ModelChain,
  ModelChainSpec,
} from "../runtime-model-call.js";

let memoryModelCall: () => ModelCall | undefined = () => undefined;

/** Memory calls the agent role's model call, which starts after Memory in the
 * same process; the source is read on every call. */
export function setMemoryModelCall(source: () => ModelCall | undefined): void {
  memoryModelCall = source;
}

interface MemoryModelDependencies {
  modelCall?: ModelCall;
}

/**
 * Writes a Memory update the file validator accepts to the artifacts' output
 * path. A rejected answer is corrected within the Memory kind's attempts,
 * with the validator's message as the reason.
 */
export async function runValidatedMemoryModelUpdate(
  owner: ModelOwner,
  artifacts: PromptArtifacts,
  validate: (outputPath: string) => Promise<void>,
  dependencies: MemoryModelDependencies = {},
): Promise<string> {
  const write = (output: Record<string, unknown>) =>
    fs.writeFile(artifacts.outputPath, `${JSON.stringify(output, null, 2)}\n`);
  const output = await requestMemoryModel(
    {
      owner,
      input: await fs.readFile(artifacts.promptPath, "utf8"),
      schemaName: "memory_update",
      outputSchema: JSON.parse(await fs.readFile(artifacts.schemaPath, "utf8")),
      validate: async (candidate) => {
        await write(candidate);
        try {
          await validate(artifacts.outputPath);
          return undefined;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    },
    dependencies,
  );
  // A request that joined a running call never wrote this file.
  await write(output);
  return artifacts.outputPath;
}

/**
 * One system + user prompt with a strict JSON schema on the owner's Agent
 * Runtime, with the Memory kind's budget and attempts.
 */
export async function requestMemoryStructuredOutput(
  request: {
    owner: ModelOwner;
    system: string;
    user: string;
    schemaName: string;
    schema: Record<string, unknown>;
    reasoningEffort?: ModelCallEffort;
    validate?: ModelCallRequest["validate"];
  },
  dependencies: MemoryModelDependencies = {},
): Promise<Record<string, unknown>> {
  return requestMemoryModel(
    {
      owner: request.owner,
      effort: request.reasoningEffort ?? "low",
      instructions: request.system,
      input: request.user,
      schemaName: request.schemaName,
      outputSchema: request.schema,
      ...(request.validate ? { validate: request.validate } : {}),
    },
    dependencies,
  );
}

/** Runs a Memory flow that splits or corrects itself; see runMemoryModelChain. */
export type MemoryModelChainRunner = <T>(
  spec: ModelChainSpec,
  body: (chain: ModelChain) => Promise<T>,
) => Promise<T>;

/**
 * Runs a Memory flow as one ModelCall chain: it is queued once and holds its
 * place, and a call that fails past the kind's attempts throws for the flow
 * to split or give up.
 */
export function runMemoryModelChain<T>(
  spec: ModelChainSpec,
  body: (chain: ModelChain) => Promise<T>,
  dependencies: MemoryModelDependencies = {},
): Promise<T> {
  return requireModelCall(dependencies).chain(spec, body);
}

/** The context window of the model the owner's calls run on; undefined when
 * it is unknown or no model call is available. Rejects with computer_offline
 * while the owner's Computer is offline. */
export async function memoryContextWindow(
  owner: { readonly tenantId: string; readonly ownerActorId: string },
  dependencies: MemoryModelDependencies = {},
): Promise<number | undefined> {
  const modelCall = dependencies.modelCall ?? memoryModelCall();
  return modelCall?.contextWindow?.({ owner });
}

function requireModelCall(dependencies: MemoryModelDependencies): ModelCall {
  const modelCall = dependencies.modelCall ?? memoryModelCall();
  if (!modelCall)
    throw new Error(
      "Memory model calls need the agent role and a Local Computer in this process",
    );
  return modelCall;
}

function requestMemoryModel(
  request: Omit<ModelCallRequest, "kind" | "key">,
  dependencies: MemoryModelDependencies,
): Promise<Record<string, unknown>> {
  return requireModelCall(dependencies)
    .call({ ...request, kind: "memory", key: `memory:${request.schemaName}` })
    .then(({ output }) => output);
}
