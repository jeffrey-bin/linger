// A ModelCall for benchmark scripts: every structured call goes to the LLM
// gateway memo_eval and the memory.md benchmark use
// (TEAMHUB_ONBOARDING_LLM_GATEWAY_URL / _API_KEY, loaded with
// `node --env-file`), not to an Agent Runtime. Workspace calls are not
// supported. Usage is counted per call so a run can report its token cost.
import {
  ModelCallError,
  type ModelCall,
  type ModelCallRequest,
} from "../src/runtime-model-call.js";

export interface GatewayUsage {
  calls: number;
  prompt: number;
  cached: number;
  completion: number;
  failures: number;
}

interface GatewayResponse {
  model?: string;
  error?: unknown;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  choices?: { message?: { content?: string } }[];
}

export function createGatewayModelCall(options: {
  model: string;
  /** Concurrent requests; later calls wait. */
  concurrency?: number;
}): { modelCall: ModelCall; usage: GatewayUsage } {
  const base = (process.env.TEAMHUB_ONBOARDING_LLM_GATEWAY_URL ?? "").replace(
    /\/+$/u,
    "",
  );
  if (!base) throw new Error("TEAMHUB_ONBOARDING_LLM_GATEWAY_URL is not set");
  const url = `${base.endsWith("/v1") ? base : `${base}/v1`}/chat/completions`;
  const usage: GatewayUsage = {
    calls: 0,
    prompt: 0,
    cached: 0,
    completion: 0,
    failures: 0,
  };
  const limit = options.concurrency ?? 8;
  let active = 0;
  const waiting: (() => void)[] = [];
  const acquire = async () => {
    while (active >= limit)
      await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
  };
  const release = () => {
    active -= 1;
    waiting.shift()?.();
  };
  const chat = async (
    body: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ) => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.TEAMHUB_ONBOARDING_LLM_GATEWAY_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: options.model, ...body }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    }).catch((error: unknown) => {
      throw new ModelCallError(
        "failed",
        `Gateway unreachable: ${String(error)}`,
      );
    });
    const json = (await response.json().catch(() => ({}))) as GatewayResponse;
    return { status: response.status, json };
  };
  const call = async (request: ModelCallRequest) => {
    await acquire();
    try {
      let last = "";
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        // A dropped connection is retried like a 5xx answer.
        const answer = await chat(
          {
            messages: [
              ...(request.instructions
                ? [{ role: "system", content: request.instructions }]
                : []),
              { role: "user", content: request.input },
            ],
            max_completion_tokens: 32_000,
            reasoning_effort: request.effort ?? "low",
            response_format: {
              type: "json_schema",
              json_schema: {
                name: request.schemaName,
                strict: true,
                schema: request.outputSchema,
              },
            },
          },
          request.timeoutMs ?? 10 * 60_000,
          request.signal,
        ).catch((error: unknown) => {
          if (attempt >= 3 || request.signal?.aborted) throw error;
          return undefined;
        });
        if (!answer) {
          usage.failures += 1;
          await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
          continue;
        }
        const { status, json } = answer;
        last = `${status} ${JSON.stringify(json.error ?? "").slice(0, 500)}`;
        if (status === 400)
          throw new ModelCallError(
            "invalid_request",
            `Gateway rejected the request: ${last}`,
          );
        if (status !== 200) {
          usage.failures += 1;
          if (attempt < 3) {
            await new Promise((resolve) =>
              setTimeout(resolve, attempt * 2_000),
            );
            continue;
          }
          throw new ModelCallError("failed", `Gateway call failed: ${last}`);
        }
        usage.calls += 1;
        usage.prompt += json.usage?.prompt_tokens ?? 0;
        usage.cached += json.usage?.prompt_tokens_details?.cached_tokens ?? 0;
        usage.completion += json.usage?.completion_tokens ?? 0;
        const text = json.choices?.[0]?.message?.content ?? "";
        try {
          return {
            model: json.model ?? options.model,
            output: JSON.parse(text) as Record<string, unknown>,
          };
        } catch {
          throw new ModelCallError(
            "invalid_output",
            "Gateway returned invalid JSON",
            { output: text },
          );
        }
      }
      throw new ModelCallError("failed", `Gateway call failed: ${last}`);
    } finally {
      release();
    }
  };
  const unused = () =>
    Promise.reject(new Error("only structured calls are used"));
  const modelCall: ModelCall = {
    call,
    text: unused,
    workspace: unused,
    // A chain's calls go straight to the gateway; nothing is queued.
    chain: (spec, body) =>
      body({
        signal: spec.signal ?? new AbortController().signal,
        call: (request) =>
          call({
            ...request,
            kind: spec.kind,
            key: `${spec.key}/${request.step}`,
          }),
        text: unused,
        workspace: unused,
      }),
  };
  return { modelCall, usage };
}
