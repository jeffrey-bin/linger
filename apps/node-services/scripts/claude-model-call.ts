// A ModelCall for benchmark scripts that runs Claude Code the way the Daemon's
// Claude runtime does (apps/computer/local-daemon/internal/provider/model_invoke.go):
// one `claude -p --output-format json` per call with the prompt on stdin, a
// JSON schema for structured calls, only Read/Write/Edit/Glob/Grep in a
// workspace whose files are on disk, and no tools otherwise. Claude Code talks
// to the LLM gateway's Anthropic endpoint with the gateway key and its own
// empty config directory, so no personal login or subscription is used. Every
// call's usage is recorded with its kind, key and step.
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { Ajv } from "ajv";

import {
  ModelCallError,
  type ModelCall,
  type ModelCallEffort,
  type ModelChain,
  type WorkspaceFile,
} from "../src/runtime-model-call.js";

const WORKSPACE_TOOLS = "Read,Write,Edit,Glob,Grep";

export interface ClaudeCallRecord {
  mode: "structured" | "text" | "workspace";
  kind: string;
  key: string;
  startedAt: number;
  ms: number;
  /** Prompt tokens including cache reads and writes. */
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  ok: boolean;
  error?: string;
}

export async function createClaudeModelCall(
  options: {
    binary?: string;
    model?: string;
    concurrency?: number;
    maxTimeoutMs?: number;
  } = {},
): Promise<{
  modelCall: ModelCall;
  records: ClaudeCallRecord[];
  close(): Promise<void>;
}> {
  const binary = options.binary ?? process.env.CLAUDE_BIN ?? "claude";
  const model = options.model ?? "openrouter/claude-sonnet-5.5";
  const gateway = (process.env.TEAMHUB_ONBOARDING_LLM_GATEWAY_URL ?? "")
    .replace(/\/+$/u, "")
    .replace(/\/v1$/u, "");
  const key = process.env.TEAMHUB_ONBOARDING_LLM_GATEWAY_API_KEY ?? "";
  if (!gateway || !key)
    throw new Error("The LLM gateway URL and key must be set in the env file");
  const records: ClaudeCallRecord[] = [];
  const limit = options.concurrency ?? 4;
  let active = 0;
  const waiting: (() => void)[] = [];
  const ajv = new Ajv({ allErrors: true, strict: false });
  const root = await mkdtemp(join(tmpdir(), "claude-bench-"));
  const config = join(root, "config");
  await mkdir(config);
  // Only the gateway key: no personal login can be picked up.
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: root,
    CLAUDE_CONFIG_DIR: config,
    ANTHROPIC_BASE_URL: gateway,
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: model,
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };

  async function invoke(request: {
    mode: ClaudeCallRecord["mode"];
    kind: string;
    key: string;
    instructions?: string;
    input: string;
    effort?: ModelCallEffort;
    outputSchema?: Readonly<Record<string, unknown>>;
    files?: readonly WorkspaceFile[];
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<{ text: string; files?: WorkspaceFile[] }> {
    while (active >= limit)
      await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    const work = await mkdtemp(join(root, "call-"));
    const record: ClaudeCallRecord = {
      mode: request.mode,
      kind: request.kind,
      key: request.key,
      startedAt: Date.now(),
      ms: 0,
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      ok: false,
    };
    try {
      for (const file of request.files ?? []) {
        await mkdir(dirname(join(work, file.path)), { recursive: true });
        await writeFile(join(work, file.path), file.content);
      }
      const args = ["-p", "--output-format", "json", "--model", model];
      if (request.mode === "structured")
        args.push("--json-schema", JSON.stringify(request.outputSchema));
      if (request.mode === "workspace")
        args.push(
          "--tools",
          WORKSPACE_TOOLS,
          "--restricted",
          "--permission-mode",
          "acceptEdits",
        );
      else args.push("--tools", "", "--permission-mode", "dontAsk");
      args.push(
        "--safe-mode",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--disable-slash-commands",
        "--effort",
        request.effort ?? "low",
      );
      const prompt = request.instructions
        ? `${request.instructions}\n\n<input>\n${request.input}\n</input>\n`
        : request.input;
      const { code, stdout, stderr } = await run(
        binary,
        args,
        work,
        prompt,
        environment,
        Math.min(
          request.timeoutMs ?? 10 * 60_000,
          options.maxTimeoutMs ?? Infinity,
        ),
        request.signal,
      );
      if (code === "timeout")
        throw new ModelCallError("timed_out", "Claude call timed out");
      let reported: {
        is_error?: boolean;
        result?: string;
        structured_output?: unknown;
        usage?: {
          input_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
          output_tokens?: number;
        };
      };
      try {
        reported = JSON.parse(stdout) as typeof reported;
      } catch {
        throw new ModelCallError(
          "failed",
          `Claude exited ${code} without JSON: ${(stderr || stdout).slice(-600)}`,
        );
      }
      const usage = reported.usage ?? {};
      record.cachedTokens = usage.cache_read_input_tokens ?? 0;
      record.inputTokens =
        (usage.input_tokens ?? 0) +
        record.cachedTokens +
        (usage.cache_creation_input_tokens ?? 0);
      record.outputTokens = usage.output_tokens ?? 0;
      if (code !== 0 || reported.is_error)
        throw new ModelCallError(
          /context|too long|maximum/iu.test(reported.result ?? "")
            ? "invalid_request"
            : "failed",
          `Claude failed: ${(reported.result ?? stderr).slice(-600)}`,
        );
      const text =
        request.mode === "structured" &&
        reported.structured_output !== undefined &&
        reported.structured_output !== null
          ? JSON.stringify(reported.structured_output)
          : (reported.result ?? "");
      const files =
        request.mode === "workspace" ? await readTree(work) : undefined;
      record.ok = true;
      return { text, ...(files ? { files } : {}) };
    } catch (error) {
      record.error =
        error instanceof Error ? error.message.slice(0, 300) : String(error);
      throw error;
    } finally {
      record.ms = Date.now() - record.startedAt;
      records.push(record);
      await rm(work, { recursive: true, force: true });
      active -= 1;
      waiting.shift()?.();
    }
  }

  async function structured(
    request: Omit<Parameters<typeof invoke>[0], "mode"> & {
      outputSchema: Readonly<Record<string, unknown>>;
    },
  ): Promise<Record<string, unknown>> {
    const { text } = await invoke({ ...request, mode: "structured" });
    let output: unknown;
    try {
      output = JSON.parse(text);
    } catch {
      throw new ModelCallError("invalid_output", "Claude reply is not JSON", {
        output: text,
      });
    }
    const check = ajv.compile(request.outputSchema);
    if (!check(output))
      throw new ModelCallError(
        "invalid_output",
        `Claude reply does not match the schema: ${ajv.errorsText(check.errors)}`,
        { output: text },
      );
    return output as Record<string, unknown>;
  }

  const modelCall: ModelCall = {
    async call(request) {
      // A one-shot call gets one schema correction, as the kind's attempts allow.
      try {
        return { output: await structured(request), model: "claude" };
      } catch (error) {
        if (
          !(error instanceof ModelCallError) ||
          error.kind !== "invalid_output"
        )
          throw error;
        return {
          output: await structured({
            ...request,
            input: `${request.input}\n\nYour previous answer was rejected: ${error.message}. Answer again with one valid JSON object.`,
          }),
          model: "claude",
        };
      }
    },
    async text(request) {
      const { text } = await invoke({ ...request, mode: "text" });
      return { output: text, model: "claude" };
    },
    async workspace(request) {
      const { files } = await invoke({ ...request, mode: "workspace" });
      return { output: files ?? [], model: "claude" };
    },
    // Nothing is queued: a chain's calls go straight to Claude, one attempt each.
    chain: (spec, body) => {
      const signal = spec.signal ?? new AbortController().signal;
      const key = (step: string) => `${spec.key}/${step}`;
      const chain: ModelChain = {
        signal,
        call: async (request) => ({
          output: await structured({
            ...request,
            kind: spec.kind,
            key: key(request.step),
            signal,
          }),
          model: "claude",
        }),
        text: async (request) => ({
          output: (
            await invoke({
              ...request,
              mode: "text",
              kind: spec.kind,
              key: key(request.step),
              signal,
            })
          ).text,
          model: "claude",
        }),
        workspace: async (request) => ({
          output:
            (
              await invoke({
                ...request,
                mode: "workspace",
                kind: spec.kind,
                key: key(request.step),
                signal,
              })
            ).files ?? [],
          model: "claude",
        }),
      };
      return body(chain);
    },
  };
  return {
    modelCall,
    records,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

function run(
  binary: string,
  args: string[],
  cwd: string,
  prompt: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ code: number | "timeout"; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const kill = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    signal?.addEventListener("abort", kill, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-20_000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      resolve({ code: timedOut ? "timeout" : (code ?? 1), stdout, stderr });
    });
    child.stdin.end(prompt);
  });
}

async function readTree(root: string): Promise<WorkspaceFile[]> {
  const files: WorkspaceFile[] = [];
  for (const entry of await readdir(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files.push({ path: relative(root, path), content: await readFile(path) });
  }
  return files;
}
