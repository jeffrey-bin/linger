import type { components } from "@linger/wire-contracts/node-services-internal/types";
import { isRecord } from "@linger/service-kit";
import { isModelCallKind, modelCallPolicies } from "../../../model-tasks.js";
import {
  ModelCallError,
  modelCallEfforts,
  type ModelCall,
  type ModelCallEffort,
  type TextModelCallRequest,
} from "../../../runtime-model-call.js";

type ModelCallResultBody = components["schemas"]["ModelCallResult"];

export interface ModelCallHttpRequest extends TextModelCallRequest {
  readonly output?: {
    readonly name: string;
    readonly schema: Record<string, unknown>;
  };
  /** Applies to structured calls only. */
  readonly sessionKey?: string;
}

const OUTPUT_NAME = /^[A-Za-z0-9_-]{1,64}$/u;
/** Instructions and input share one character budget that keeps the prompt
 * under the 3 MiB invocation limit even at three UTF-8 bytes per UTF-16 unit;
 * Skill-based instructions such as the Profile prompt run past 200,000. */
const MAX_PROMPT_CHARS = 1_000_000;

const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));

const isText = (value: unknown, min: number, max: number): value is string =>
  typeof value === "string" && value.length >= min && value.length <= max;

/** A ModelCallRequest body as a call, or undefined when it breaks the contract. */
export function readModelCallRequest(
  body: unknown,
  signal?: AbortSignal,
): ModelCallHttpRequest | undefined {
  if (
    !isRecord(body) ||
    !hasOnlyKeys(body, [
      "kind",
      "key",
      "owner",
      "effort",
      "instructions",
      "input",
      "output",
      "timeoutMs",
      "sessionKey",
      "runOperationId",
    ]) ||
    !isModelCallKind(body.kind) ||
    !isText(body.key, 1, 300) ||
    !isText(body.input, 1, MAX_PROMPT_CHARS) ||
    (body.instructions !== undefined &&
      !isText(body.instructions, 0, MAX_PROMPT_CHARS - body.input.length)) ||
    (body.effort !== undefined &&
      !modelCallEfforts.includes(body.effort as ModelCallEffort)) ||
    (body.timeoutMs !== undefined &&
      (!Number.isInteger(body.timeoutMs) ||
        (body.timeoutMs as number) < 1_000 ||
        (body.timeoutMs as number) > 600_000)) ||
    (body.sessionKey !== undefined && !isText(body.sessionKey, 1, 200)) ||
    (body.runOperationId !== undefined &&
      (body.kind !== "approval" || !isText(body.runOperationId, 1, 200)))
  )
    return undefined;
  const owner = body.owner;
  if (
    owner !== undefined &&
    (!isRecord(owner) ||
      !hasOnlyKeys(owner, ["tenantId", "ownerActorId"]) ||
      !isText(owner.tenantId, 1, 200) ||
      !isText(owner.ownerActorId, 1, 200))
  )
    return undefined;
  const output = body.output;
  if (
    output !== undefined &&
    (!isRecord(output) ||
      !hasOnlyKeys(output, ["name", "schema"]) ||
      typeof output.name !== "string" ||
      !OUTPUT_NAME.test(output.name) ||
      !isRecord(output.schema))
  )
    return undefined;
  return {
    kind: body.kind,
    key: body.key,
    ...(isRecord(owner)
      ? {
          owner: {
            tenantId: owner.tenantId as string,
            ownerActorId: owner.ownerActorId as string,
          },
        }
      : {}),
    ...(body.effort === undefined
      ? {}
      : { effort: body.effort as ModelCallEffort }),
    ...(body.instructions === undefined
      ? {}
      : { instructions: body.instructions }),
    input: body.input,
    ...(isRecord(output)
      ? {
          output: {
            name: output.name as string,
            schema: output.schema as Record<string, unknown>,
          },
        }
      : {}),
    ...(body.timeoutMs === undefined
      ? {}
      : { timeoutMs: body.timeoutMs as number }),
    ...(body.sessionKey === undefined ? {} : { sessionKey: body.sessionKey }),
    ...(body.runOperationId === undefined
      ? {}
      : { runOperationId: body.runOperationId }),
    ...(signal ? { signal } : {}),
  };
}

/** How long one request waits for work nobody is waiting on; the call runs
 * on and the same request later joins it or receives its result. */
const MODEL_CALL_MAX_WAIT_MS = 300_000;

/** Runs the call and shapes its ModelCallResult body. A call nobody is
 * waiting on that is still queued or running after the wait bound answers
 * pending. */
export async function answerModelCall(
  modelCall: ModelCall,
  { output, ...request }: ModelCallHttpRequest,
  maxWaitMs = MODEL_CALL_MAX_WAIT_MS,
): Promise<ModelCallResultBody> {
  const waited = new AbortController();
  const timer = modelCallPolicies[request.kind].interactive
    ? undefined
    : setTimeout(() => waited.abort(), maxWaitMs);
  const signal = request.signal
    ? AbortSignal.any([request.signal, waited.signal])
    : waited.signal;
  try {
    if (output) {
      const result = await modelCall.call({
        ...request,
        signal,
        schemaName: output.name,
        outputSchema: output.schema,
      });
      return { model: result.model, output: result.output };
    }
    const result = await modelCall.text({ ...request, signal });
    return { model: result.model, text: result.output };
  } catch (error) {
    if (waited.signal.aborted && !request.signal?.aborted)
      throw new ModelCallError(
        "pending",
        "The model call is still queued or running; ask again later",
      );
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
