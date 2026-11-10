// A ModelCall for benchmark scripts that runs Codex the way the Daemon's
// model.invoke does (apps/computer/local-daemon/internal/provider/model_invoke.go):
// one `codex exec --ephemeral` per call with the prompt on stdin, the same
// sandbox and feature switches, workspace files inlined into the prompt, and
// the reply read from `-o last.txt`. A structured call that names a session
// runs as the Daemon's session mode does (codex-app-server.ts). Codex runs in
// its own home, as the Daemon's does, with the local login linked in (never
// read) and the user's model. Every call's usage is recorded with its kind,
// key and step.
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { Ajv } from "ajv";

import {
  ModelCallError,
  type ModelCall,
  type ModelCallEffort,
  type ModelChain,
  type WorkspaceFile,
} from "../src/runtime-model-call.js";
import { CodexSessions } from "./codex-app-server.js";

const DISABLED_FEATURES = [
  "shell_tool",
  "unified_exec",
  "code_mode_host",
  "multi_agent",
  "goals",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "in_app_browser",
  "apps",
  "plugins",
  "hooks",
  "image_generation",
  "view_image",
  "tool_suggest",
  "skill_search",
  "sleep_tool",
];

export interface CodexCallRecord {
  mode: "structured" | "text" | "workspace";
  kind: string;
  /** The call's key, `<task key>/<step>` for a task's call. */
  key: string;
  /** Answered in a session's resident thread. */
  session: boolean;
  startedAt: number;
  ms: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  ok: boolean;
  error?: string;
}

export async function createCodexModelCall(
  options: {
    binary?: string;
    model?: string;
    concurrency?: number;
    /** Caps each call's timeout, for runs that retry a hung Codex instead. */
    maxTimeoutMs?: number;
  } = {},
): Promise<{
  modelCall: ModelCall;
  records: CodexCallRecord[];
  close(): Promise<void>;
}> {
  const binary =
    options.binary ??
    process.env.CODEX_BIN ??
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
  const records: CodexCallRecord[] = [];
  const limit = options.concurrency ?? 4;
  let active = 0;
  const waiting: (() => void)[] = [];
  const ajv = new Ajv({ allErrors: true, strict: false });
  const root = await mkdtemp(join(tmpdir(), "codex-bench-"));
  const home = join(root, "home");
  await mkdir(home);
  await symlink(
    join(homedir(), ".codex", "auth.json"),
    join(home, "auth.json"),
  );
  await writeFile(
    join(home, "config.toml"),
    `model = "${options.model ?? "gpt-6-astra"}"\n`,
  );
  const sessionDirectory = join(root, "session");
  await mkdir(join(sessionDirectory, "tmp"), { recursive: true });
  const sessions = new CodexSessions(
    binary,
    {
      ...process.env,
      CODEX_HOME: home,
      TMPDIR: join(sessionDirectory, "tmp"),
      TMP: join(sessionDirectory, "tmp"),
      TEMP: join(sessionDirectory, "tmp"),
    },
    sessionDirectory,
  );

  async function invoke(request: {
    mode: CodexCallRecord["mode"];
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
    const call = await mkdtemp(join(root, "call-"));
    const scratch = join(call, "tmp");
    const work = join(call, "work");
    await mkdir(scratch);
    await mkdir(work);
    const record: CodexCallRecord = {
      mode: request.mode,
      kind: request.kind,
      key: request.key,
      session: false,
      startedAt: Date.now(),
      ms: 0,
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      ok: false,
    };
    try {
      for (const file of request.files ?? []) {
        await mkdir(dirname(join(work, file.path)), { recursive: true });
        await writeFile(join(work, file.path), file.content);
      }
      const args = [
        "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "--sandbox",
        request.mode === "workspace" ? "workspace-write" : "read-only",
        "--ignore-rules",
        "--color",
        "never",
        "-C",
        work,
        "-c",
        `model_reasoning_effort="${request.effort ?? "low"}"`,
        "-c",
        'web_search="disabled"',
        ...(request.mode === "workspace"
          ? [
              "-c",
              "sandbox_workspace_write.exclude_slash_tmp=true",
              "-c",
              "sandbox_workspace_write.exclude_tmpdir_env_var=true",
            ]
          : []),
      ];
      for (const feature of DISABLED_FEATURES)
        if (!(request.mode === "workspace" && feature === "code_mode_host"))
          args.push("--disable", feature);
      if (request.outputSchema) {
        await writeFile(
          join(call, "schema.json"),
          JSON.stringify(request.outputSchema),
        );
        args.push("--output-schema", join(call, "schema.json"));
      }
      args.push("--json", "-o", join(call, "last.txt"));
      let prompt = request.instructions
        ? `${request.instructions}\n\n<input>\n${request.input}\n</input>\n`
        : request.input;
      if (request.mode === "workspace")
        prompt += workspaceFilesPrompt(request.files ?? []);
      const { code, stderr, events } = await run(
        binary,
        args,
        work,
        prompt,
        {
          ...process.env,
          CODEX_HOME: home,
          TMPDIR: scratch,
          TMP: scratch,
          TEMP: scratch,
        },
        Math.min(
          request.timeoutMs ?? 10 * 60_000,
          options.maxTimeoutMs ?? Infinity,
        ),
        request.signal,
      );
      for (const line of events) {
        if (line.type !== "turn.completed" || !line.usage) continue;
        record.inputTokens += line.usage.input_tokens ?? 0;
        record.cachedTokens += line.usage.cached_input_tokens ?? 0;
        record.outputTokens += line.usage.output_tokens ?? 0;
        record.reasoningTokens += line.usage.reasoning_output_tokens ?? 0;
      }
      if (code === "timeout")
        throw new ModelCallError("timed_out", "Codex call timed out");
      const failure = events
        .filter((line) => line.type === "turn.failed" || line.type === "error")
        .map((line) => JSON.stringify(line).slice(0, 400))
        .join(" ");
      if (code !== 0)
        throw new ModelCallError(
          /context|too long|maximum/iu.test(stderr + failure)
            ? "invalid_request"
            : "failed",
          `Codex exited ${code}: ${(failure || stderr).slice(-600)}`,
        );
      const text = await readFile(join(call, "last.txt"), "utf8").catch(
        () => "",
      );
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
      await rm(call, { recursive: true, force: true });
      active -= 1;
      waiting.shift()?.();
    }
  }

  /** A session call in its resident thread; undefined when it must run on its own. */
  async function inSession(
    request: Omit<Parameters<typeof invoke>[0], "mode"> & {
      outputSchema: Readonly<Record<string, unknown>>;
      sessionKey: string;
      instructions: string;
    },
  ): Promise<string | undefined> {
    while (active >= limit)
      await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    const record: CodexCallRecord = {
      mode: "structured",
      kind: request.kind,
      key: request.key,
      session: true,
      startedAt: Date.now(),
      ms: 0,
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      ok: false,
    };
    try {
      const answer = await sessions.run({
        session: request.sessionKey,
        instructions: request.instructions,
        input: request.input,
        outputSchema: request.outputSchema,
        effort: request.effort ?? "low",
        timeoutMs: Math.min(
          request.timeoutMs ?? 10 * 60_000,
          options.maxTimeoutMs ?? Infinity,
        ),
        ...(request.signal ? { signal: request.signal } : {}),
      });
      if (!answer) return undefined;
      Object.assign(record, {
        ok: true,
        inputTokens: answer.input,
        cachedTokens: answer.cached,
        outputTokens: answer.output,
        reasoningTokens: answer.reasoning,
      });
      return answer.text;
    } catch (error) {
      record.error =
        error instanceof Error ? error.message.slice(0, 300) : String(error);
      // A stalled turn is a timeout, which the agent loop asks once more.
      throw new ModelCallError(
        record.error.includes("timed out") ? "timed_out" : "failed",
        `Codex session call failed: ${record.error}`,
      );
    } finally {
      record.ms = Date.now() - record.startedAt;
      if (record.ok || record.error) records.push(record);
      active -= 1;
      waiting.shift()?.();
    }
  }

  async function structured(
    request: Omit<Parameters<typeof invoke>[0], "mode"> & {
      outputSchema: Readonly<Record<string, unknown>>;
      sessionKey?: string;
    },
  ): Promise<Record<string, unknown>> {
    const text =
      (request.sessionKey && request.instructions
        ? await inSession({
            ...request,
            sessionKey: request.sessionKey,
            instructions: request.instructions,
          })
        : undefined) ?? (await invoke({ ...request, mode: "structured" })).text;
    let output: unknown;
    try {
      output = JSON.parse(text);
    } catch {
      throw new ModelCallError("invalid_output", "Codex reply is not JSON", {
        output: text,
      });
    }
    const check = ajv.compile(request.outputSchema);
    if (!check(output))
      throw new ModelCallError(
        "invalid_output",
        `Codex reply does not match the schema: ${ajv.errorsText(check.errors)}`,
        { output: text },
      );
    return output as Record<string, unknown>;
  }

  const modelCall: ModelCall = {
    async call(request) {
      // A one-shot call gets one schema correction, as the kind's attempts allow.
      try {
        return { output: await structured(request), model: "codex" };
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
          model: "codex",
        };
      }
    },
    async text(request) {
      const { text } = await invoke({ ...request, mode: "text" });
      return { output: text, model: "codex" };
    },
    async workspace(request) {
      const { files } = await invoke({ ...request, mode: "workspace" });
      return { output: files ?? [], model: "codex" };
    },
    // Nothing is queued: a chain's calls go straight to Codex, one attempt each.
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
          model: "codex",
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
          model: "codex",
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
          model: "codex",
        }),
      };
      return body(chain);
    },
  };
  return {
    modelCall,
    records,
    close: async () => {
      sessions.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

interface CodexEvent {
  type?: string;
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
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
): Promise<{
  code: number | "timeout";
  stderr: string;
  events: CodexEvent[];
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
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
      const events: CodexEvent[] = [];
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line) as CodexEvent);
        } catch {
          // A line cut by the buffer; usage comes from turn.completed lines.
        }
      }
      resolve({ code: timedOut ? "timeout" : (code ?? 1), stderr, events });
    });
    child.stdin.end(prompt);
  });
}

/** Inlines the working directory's files, as the Daemon does for Codex. */
function workspaceFilesPrompt(files: readonly WorkspaceFile[]): string {
  let prompt =
    "\n<workspace_files>\nThe working directory already holds these files. You cannot read files, so their full contents are given here. Create, change or delete files only with apply_patch, using paths relative to the working directory.\n";
  for (const file of files) {
    const text = Buffer.from(file.content).toString("utf8");
    if (Buffer.from(text, "utf8").equals(Buffer.from(file.content)))
      prompt += `<workspace_file path=${JSON.stringify(file.path)}>\n${text}\n</workspace_file>\n`;
    else
      prompt += `<workspace_file path=${JSON.stringify(file.path)} bytes="${file.content.length}" binary="true"/>\n`;
  }
  return `${prompt}</workspace_files>\n`;
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
