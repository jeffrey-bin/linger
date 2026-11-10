// Answers one question the way the Another Me does: memory.md and the
// Personal Knowledge policy as instructions, the question with its date, and
// the Agent's `teamhub knowledge search` / `read` as two tools over the
// product's own Memory handlers. The model decides what to search and read;
// the benchmark adds no evidence selection or reader prompt.
import { renderUserMemory } from "../../src/agent/agent-features/user-memory/feature.js";
import { PERSONAL_KNOWLEDGE_POLICY } from "../../src/agent/prompt/personal-knowledge-policy.js";
import type { Case } from "./datasets.js";
import type { Knowledge, ReadInput, SearchInput } from "./knowledge.js";
import type { PreparedCorpus } from "./product.js";

/**
 * - `product`: what the Another Me has, memory.md plus search over every source.
 * - `search`: search over every source, without memory.md.
 * - `wiki`: search over the Wiki pages and the Dailies only.
 * - `memory-md`: memory.md only, no search.
 * - `none`: no memory, the floor.
 */
export type Arm = "product" | "search" | "wiki" | "memory-md" | "none";
export const ARMS: readonly Arm[] = [
  "product",
  "search",
  "wiki",
  "memory-md",
  "none",
];
/** Arms that need the nightly stages in the prepared history. */
export const NIGHTLY_ARMS: readonly Arm[] = ["product", "wiki", "memory-md"];

const SEARCH_ARMS: readonly Arm[] = ["product", "search", "wiki"];
const MEMORY_ARMS: readonly Arm[] = ["product", "memory-md"];

const MAX_ROUNDS = 24;

// The CLI commands as function tools. The policy keeps its CLI wording; the
// tool descriptions name the command each one stands for.
const TOOLS = [
  {
    type: "function",
    function: {
      name: "knowledge_search",
      description:
        "teamhub knowledge search: one search over every source of the Human owner's knowledge. Returns ranked candidates, Session facts and section directories as JSON.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", description: "The quoted query." },
          alternates: {
            type: "array",
            maxItems: 6,
            items: { type: "string" },
            description:
              "--alternate: synonyms, translations or related terms.",
          },
          dateFrom: { type: "string", description: "--date-from YYYY-MM-DD" },
          dateTo: { type: "string", description: "--date-to YYYY-MM-DD" },
          eventFrom: { type: "string", description: "--event-from YYYY-MM-DD" },
          eventTo: { type: "string", description: "--event-to YYYY-MM-DD" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "knowledge_read",
      description:
        "teamhub knowledge read: read 1-8 sections of one evidence item returned by knowledge_search.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["evidenceId", "sectionIds"],
        properties: {
          evidenceId: { type: "string", description: "The raw_ evidence ID." },
          sectionIds: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: { type: "string" },
            description: "--section-id values from the directory.",
          },
          offset: {
            type: "integer",
            description: "--offset to continue one truncated section.",
          },
        },
      },
    },
  },
];

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
}

interface ChatResponse {
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  choices?: { message: ChatMessage; finish_reason?: string }[];
}

export interface AnswerRecord {
  answer: string;
  requested_model: string;
  response_models: string[];
  rounds: number;
  tool_calls: {
    round: number;
    name: string;
    input: unknown;
    output: unknown;
    error?: string;
    seconds: number;
  }[];
  usage: { prompt: number; completion: number };
  seconds: number;
}

/** The question as the user sends it: the request date, then the question. */
export function questionMessage(item: Case): string {
  return `Current date: ${item.askedAt.slice(0, 16).replace("T", " ")}\n\n${item.question}`;
}

export async function answerQuestion(options: {
  item: Case;
  arm: Arm;
  /** The prepared history; `none` needs none. */
  prepared?: Pick<PreparedCorpus, "scope" | "wiki_scope" | "memory">;
  product: Knowledge;
  model: string;
}): Promise<AnswerRecord> {
  const { item, arm, prepared, product, model } = options;
  const started = performance.now();
  const searches = SEARCH_ARMS.includes(arm);
  if (arm !== "none" && !prepared)
    throw new Error(`The ${arm} arm needs a prepared history`);
  const scope = arm === "wiki" ? prepared?.wiki_scope : prepared?.scope;
  const instructions = [
    ...(MEMORY_ARMS.includes(arm) ? [renderUserMemory(prepared!.memory)] : []),
    ...(searches ? [PERSONAL_KNOWLEDGE_POLICY] : []),
  ];
  const messages: ChatMessage[] = [
    ...(instructions.length
      ? [{ role: "system" as const, content: instructions.join("\n\n") }]
      : []),
    { role: "user", content: questionMessage(item) },
  ];
  const record: AnswerRecord = {
    answer: "",
    requested_model: model,
    response_models: [],
    rounds: 0,
    tool_calls: [],
    usage: { prompt: 0, completion: 0 },
    seconds: 0,
  };
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const response = await chat({
      model,
      messages,
      ...(searches ? { tools: TOOLS } : {}),
      max_completion_tokens: 4096,
      reasoning_effort: "low",
    });
    record.rounds = round;
    record.response_models.push(response.model ?? "");
    record.usage.prompt += response.usage?.prompt_tokens ?? 0;
    record.usage.completion += response.usage?.completion_tokens ?? 0;
    const message = response.choices?.[0]?.message;
    if (!message) throw new Error("The model returned no message");
    const calls = message.tool_calls ?? [];
    if (!calls.length) {
      if (!message.content?.trim())
        throw new Error("The model returned neither an answer nor a tool call");
      record.answer = message.content;
      record.seconds = (performance.now() - started) / 1000;
      return record;
    }
    messages.push({
      role: "assistant",
      content: message.content ?? null,
      tool_calls: calls,
    });
    const results = await Promise.all(
      calls.map(async (call) => {
        const callStarted = performance.now();
        let input: unknown;
        let output: unknown;
        let error: string | undefined;
        try {
          input = JSON.parse(call.function.arguments);
          output =
            call.function.name === "knowledge_search"
              ? await product.search(scope!, input as SearchInput)
              : call.function.name === "knowledge_read"
                ? await product.read(scope!, input as ReadInput)
                : undefined;
          if (output === undefined)
            throw new Error(`Unknown tool ${call.function.name}`);
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause);
          output = { error: "tool_failed", message: error.slice(0, 300) };
        }
        record.tool_calls.push({
          round,
          name: call.function.name,
          input,
          output,
          ...(error ? { error } : {}),
          seconds: (performance.now() - callStarted) / 1000,
        });
        return { id: call.id, output };
      }),
    );
    for (const { id, output } of results)
      messages.push({
        role: "tool",
        tool_call_id: id,
        content: JSON.stringify(output),
      });
  }
  throw new Error(`No answer within ${MAX_ROUNDS} rounds`);
}

/** One Chat Completions request to the LLM gateway; 5xx and drops retry twice. */
async function chat(body: Record<string, unknown>): Promise<ChatResponse> {
  const base = (process.env.TEAMHUB_ONBOARDING_LLM_GATEWAY_URL ?? "").replace(
    /\/+$/u,
    "",
  );
  if (!base) throw new Error("TEAMHUB_ONBOARDING_LLM_GATEWAY_URL is not set");
  const url = `${base.endsWith("/v1") ? base : `${base}/v1`}/chat/completions`;
  let last = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.TEAMHUB_ONBOARDING_LLM_GATEWAY_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    }).catch((error: unknown) => {
      last = String(error);
      return undefined;
    });
    if (response?.ok) return (await response.json()) as ChatResponse;
    if (response)
      last = `${response.status} ${(await response.text()).slice(0, 300)}`;
    if (response && response.status < 500 && response.status !== 429) break;
    await new Promise((resolve) => setTimeout(resolve, attempt * 3_000));
  }
  throw new Error(`Gateway chat failed: ${last}`);
}
