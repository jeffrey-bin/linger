// The Daemon's session mode for benchmark scripts, after
// apps/computer/local-daemon/internal/provider/native/codex_model_session.go:
// structured calls that name a session run on one resident `codex app-server`,
// one thread per session, instructions, schema and effort. A thread holds the
// call's instructions as its base instructions (replacing Codex's own) and
// sees each call as a new turn, so the provider serves the unchanged prefix
// from its cache. A thread retires once a turn's prompt reaches 150,000
// tokens; a busy thread makes the call run on its own.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

const MAX_INPUT_TOKENS = 150_000;
const STARTUP_MS = 30_000;

export interface SessionCall {
  session: string;
  instructions: string;
  input: string;
  outputSchema: Readonly<Record<string, unknown>>;
  effort: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface SessionAnswer {
  text: string;
  input: number;
  cached: number;
  output: number;
  reasoning: number;
}

interface Turn {
  text: string;
  usage: { input: number; cached: number; output: number; reasoning: number };
  failure?: string;
  /** Errors Codex retried itself, and the turn's latest event, for a timeout. */
  retries: string[];
  lastEvent: string;
  lastAt: number;
  done: () => void;
}

interface Thread {
  id?: string;
  busy: boolean;
}

export class CodexSessions {
  #child: ChildProcessWithoutNullStreams | undefined;
  #nextId = 0;
  readonly #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  readonly #turns = new Map<string, Turn>();
  readonly #threads = new Map<string, Thread>();
  #starting: Promise<void> | undefined;

  constructor(
    readonly binary: string,
    readonly environment: NodeJS.ProcessEnv,
    readonly directory: string,
  ) {}

  /** Answers the call in its session's thread, or returns undefined when the
   * thread is busy and the call must run on its own. */
  async run(call: SessionCall): Promise<SessionAnswer | undefined> {
    const key = createHash("sha256")
      .update(
        [
          call.session,
          call.instructions,
          JSON.stringify(call.outputSchema),
          call.effort,
        ]
          .map((part) => `${part.length}:${part}`)
          .join(""),
      )
      .digest("hex");
    const thread = this.#threads.get(key) ?? { busy: false };
    if (thread.busy) return undefined;
    this.#threads.set(key, thread);
    thread.busy = true;
    try {
      await this.#start();
      if (!thread.id) {
        const started = (await this.#call(
          "thread/start",
          {
            cwd: this.directory,
            baseInstructions: call.instructions,
            approvalPolicy: "never",
            sandbox: "read-only",
            ephemeral: true,
          },
          STARTUP_MS,
        )) as { thread?: { id?: string } };
        if (!started.thread?.id)
          throw new Error("codex thread/start returned no thread");
        thread.id = started.thread.id;
      }
      const answer = await this.#turn(thread.id, call);
      if (answer.input >= MAX_INPUT_TOKENS) {
        this.#threads.delete(key);
        void this.#call(
          "thread/unsubscribe",
          { threadId: thread.id },
          3_000,
        ).catch(() => undefined);
      }
      return answer;
    } catch (error) {
      this.#threads.delete(key);
      throw error;
    } finally {
      thread.busy = false;
    }
  }

  close(): void {
    this.#child?.kill("SIGTERM");
    this.#child = undefined;
  }

  async #turn(threadId: string, call: SessionCall): Promise<SessionAnswer> {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));
    const turn: Turn = {
      text: "",
      usage: { input: 0, cached: 0, output: 0, reasoning: 0 },
      retries: [],
      lastEvent: "",
      lastAt: Date.now(),
      done: finish,
    };
    this.#turns.set(threadId, turn);
    try {
      const started = (await this.#call("turn/start", {
        threadId,
        input: [{ type: "text", text: call.input }],
        outputSchema: call.outputSchema,
        effort: call.effort,
      })) as { turn?: { id?: string } };
      let timer: NodeJS.Timeout | undefined;
      const stopped = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Codex session turn timed out (last event ${turn.lastEvent || "none"}, quiet ${Math.round((Date.now() - turn.lastAt) / 1000)} s${turn.retries.length ? `; Codex retried: ${turn.retries.join(" | ")}` : ""})`,
              ),
            ),
          call.timeoutMs,
        );
        call.signal?.addEventListener(
          "abort",
          () => reject(new Error("Codex session turn aborted")),
          { once: true },
        );
      });
      try {
        await Promise.race([done, stopped]);
      } catch (error) {
        if (started.turn?.id)
          await this.#call(
            "turn/interrupt",
            { threadId, turnId: started.turn.id },
            3_000,
          ).catch(() => undefined);
        throw error;
      } finally {
        clearTimeout(timer);
      }
      if (turn.failure) throw new Error(turn.failure);
      if (!turn.text.trim()) throw new Error("Runtime exited without a reply");
      return { text: turn.text, ...turn.usage };
    } finally {
      this.#turns.delete(threadId);
    }
  }

  #start(): Promise<void> {
    if (this.#child) return Promise.resolve();
    this.#starting ??= (async () => {
      const child = spawn(
        this.binary,
        [
          "app-server",
          "--disable",
          "plugins",
          "--disable",
          "goals",
          "--listen",
          "stdio://",
          "--config",
          "features.memories=false",
          "--config",
          "features.memory_tool=false",
          "--config",
          "features.apps=false",
          "--config",
          "project_root_markers=[]",
          "--config",
          "skills.bundled.enabled=false",
        ],
        { cwd: this.directory, env: this.environment, stdio: "pipe" },
      );
      this.#child = child;
      child.on("exit", () => {
        this.#child = undefined;
        this.#threads.clear();
        for (const pending of this.#pending.values())
          pending.reject(new Error("codex app-server exited"));
        this.#pending.clear();
      });
      createInterface({ input: child.stdout }).on("line", (line) =>
        this.#receive(line),
      );
      child.stderr.on("data", () => undefined);
      await this.#call(
        "initialize",
        {
          clientInfo: {
            name: "linger-computer",
            title: "Linger Computer",
            version: "1",
          },
          capabilities: { experimentalApi: true },
        },
        STARTUP_MS,
      );
      this.#write({ jsonrpc: "2.0", method: "initialized" });
    })().finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }

  #call(method: string, params: unknown, timeoutMs = 0): Promise<unknown> {
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.#pending.delete(id);
              reject(new Error(`codex ${method} timed out`));
            }, timeoutMs)
          : undefined;
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  #write(message: unknown): void {
    this.#child?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #receive(line: string): void {
    let message: {
      id?: number | string;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: { message?: string };
    };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    if (message.method && message.id !== undefined) {
      // A session call has no tools and nobody to approve anything.
      const decline: Record<string, unknown> = {
        "item/commandExecution/requestApproval": { decision: "decline" },
        execCommandApproval: { decision: "decline" },
        "item/fileChange/requestApproval": { decision: "decline" },
        applyPatchApproval: { decision: "decline" },
        "item/permissions/requestApproval": { permissions: {}, scope: "turn" },
        "mcpServer/elicitation/request": {
          action: "decline",
          content: null,
          _meta: null,
        },
      };
      this.#write(
        message.method in decline
          ? { jsonrpc: "2.0", id: message.id, result: decline[message.method] }
          : {
              jsonrpc: "2.0",
              id: message.id,
              error: {
                code: -32601,
                message: `unsupported: ${message.method}`,
              },
            },
      );
      return;
    }
    if (message.method) {
      this.#notice(message.method, message.params ?? {});
      return;
    }
    const pending = this.#pending.get(Number(message.id));
    if (!pending) return;
    this.#pending.delete(Number(message.id));
    if (message.error)
      pending.reject(new Error(message.error.message ?? "codex error"));
    else pending.resolve(message.result);
  }

  #notice(method: string, params: Record<string, unknown>): void {
    const turn = this.#turns.get(
      typeof params.threadId === "string" ? params.threadId : "",
    );
    if (!turn) return;
    turn.lastEvent = method;
    turn.lastAt = Date.now();
    if (method === "item/completed") {
      const item = params.item as
        | { type?: string; text?: string; phase?: string | null }
        | undefined;
      if (
        item?.type === "agentMessage" &&
        item.text &&
        (item.phase === undefined ||
          item.phase === null ||
          item.phase === "final_answer")
      )
        turn.text = item.text;
    } else if (method === "thread/tokenUsage/updated") {
      const last = (params.tokenUsage as { last?: Record<string, number> })
        ?.last;
      if (last)
        turn.usage = {
          input: last.inputTokens ?? 0,
          cached: last.cachedInputTokens ?? 0,
          output: last.outputTokens ?? 0,
          reasoning: last.reasoningOutputTokens ?? 0,
        };
    } else if (method === "error") {
      const error = params.error as { message?: string } | undefined;
      if (error?.message && !params.willRetry) turn.failure = error.message;
      if (error?.message && params.willRetry)
        turn.retries.push(error.message.slice(0, 200));
    } else if (method === "turn/completed") {
      const completed = params.turn as
        | { status?: string; error?: { message?: string } }
        | undefined;
      if (completed?.status !== "completed" && !turn.failure)
        turn.failure =
          completed?.error?.message ?? `Codex turn ${completed?.status}`;
      turn.done();
    }
  }
}
