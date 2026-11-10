import {
  decodeExecutionContextKey,
  type ExecutionContextRef,
} from "../../executor/context-ref.js";
import type { Ghost } from "../../executor/ghost.js";
import type {
  RuntimeHistoryJsonValue,
  RuntimeHistoryOptions,
  RuntimeHistoryRecord,
  RuntimeHistoryInspection,
} from "../../executor/history.js";
import type { AgentId } from "../../executor/types.js";
import type { LocalRuntimeSettings } from "../../runtime-settings.js";
import type { TeamHubRuntimeStateClient } from "../../executor/teamhub-runtime-state-client.js";
import type { AgentLogger } from "../../observability/agent-log.js";
import { ModelCallError, type ModelCall } from "../../../runtime-model-call.js";
import type { MemoryClient } from "./client.js";
import { memoryInstructions, memoryOutputSchema } from "./prompts.js";
import {
  applyMemoryEdits,
  InvalidMemoryOutputError,
  memorySectionHeadings,
} from "./sections.js";
import { sha256Hex } from "@linger/service-kit/node";

// A failed maintenance step waits before retrying: 1, 2, 4 ... 60 minutes.
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 60 * 60_000;
const STAGE_TIMEOUT_MS = { extract: 5 * 60_000, consolidate: 10 * 60_000 };
// Passes whose stage call fails past its own attempts with an invalid or
// timed-out output, allowed per stage before maintenance stops for the Agent.
const MAX_STAGE_ATTEMPTS = 3;
// Extraction shares the model with the conversation it reads, so it waits
// for this many succeeded Meta Runs instead of following every one.
const RUNS_PER_EXTRACTION = 5;
// Consolidation sends the whole memory to the model. As in Codex, it waits until the
// Agent has had no succeeded Run for this long. Every consolidation needs a
// later Run to become due again, so this also spaces consolidations apart.
const IDLE_BEFORE_CONSOLIDATION_MS = 6 * 60 * 60_000;
// Waiting candidates past this size, or in every session slot, are
// consolidated before more are extracted, so an Agent that is never idle
// stays within the document limits.
const MAX_WAITING_CANDIDATE_BYTES = 64_000;
const MAX_SESSIONS = 30;
// Memory sources are the conversation and its tool traffic. Usage, lifecycle,
// reasoning and provider events add no fact (Codex repeats every item as a
// provider event), and a compaction summary restates earlier records.
const SOURCE_CATEGORIES: ReadonlySet<RuntimeHistoryRecord["category"]> =
  new Set(["message", "tool_call", "tool_result"]);
// A longer string, typically a file or page a tool returned, keeps its head.
const MAX_SOURCE_TEXT = 4_000;
// A stage's input, instructions included, takes half of the Agent model's
// context window at about three UTF-8 bytes per token. The other half holds
// the Runtime's own prompt, the output and reasoning, below the Runtime's
// automatic compaction. The fixed limits cap every window and apply alone
// when the window is unknown.
const WINDOW_INPUT_SHARE = 0.5;
const BYTES_PER_TOKEN = 3;
const MAX_INPUT_BYTES = 400_000;
const MAX_EXTRACTION_RECORD_BYTES = 250_000;
const MAX_MEMORY_BYTES = 200_000;

interface MemoryBudget {
  /** One stage's input, instructions included. */
  readonly input: number;
  /** The Memory a consolidation may produce: at most half of its input, so
   * candidates always have room beside it. */
  readonly memory: number;
}

function memoryBudget(contextWindow: number | undefined): MemoryBudget {
  const input =
    contextWindow === undefined
      ? MAX_INPUT_BYTES
      : Math.min(
          MAX_INPUT_BYTES,
          Math.floor(contextWindow * WINDOW_INPUT_SHARE * BYTES_PER_TOKEN),
        );
  return { input, memory: Math.min(MAX_MEMORY_BYTES, Math.floor(input / 2)) };
}

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * `resume` only finishes a pending stage, `extract` also reads new history,
 * and `consolidate` then merges every waiting candidate once.
 */
type PassMode = "resume" | "extract" | "consolidate";

function clip(value: RuntimeHistoryJsonValue): RuntimeHistoryJsonValue {
  if (typeof value === "string")
    return value.length > MAX_SOURCE_TEXT
      ? `${value.slice(0, MAX_SOURCE_TEXT)}… [${value.length - MAX_SOURCE_TEXT} characters omitted]`
      : value;
  if (Array.isArray(value)) return value.map(clip);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, clip(item)]),
    );
  return value;
}

/**
 * Narrow host capability the maintenance Coordinator needs: Ghost lookup for
 * Runtime placement and Meta Context history reads. Maintenance itself runs
 * as stateless model calls, never as a Context or Run.
 */
export interface AgentMemoryHost {
  getGhost(
    agentId: AgentId,
  ): Promise<Readonly<Ghost<LocalRuntimeSettings>> | null>;
  inspectDebugContextHistory(
    ref: ExecutionContextRef,
    options: RuntimeHistoryOptions,
  ): Promise<RuntimeHistoryInspection>;
}

/** Reconciles derived memory through stateless model calls; never a Run. */
export class AgentMemoryCoordinator {
  readonly #stop = new AbortController();
  readonly #running = new Map<string, Promise<void>>();
  readonly #backoff = new Map<string, { until: number; failures: number }>();
  // Meta Context input positions an Agent was last fully caught up to. A
  // scan skips the Agent until one of them receives new input.
  readonly #settled = new Map<string, string>();
  // Scheduling state is kept in process only. After a restart the Run count
  // starts from zero, and waiting candidates count from the first scan.
  // Succeeded Meta Runs since the Agent's last extracting pass.
  readonly #runs = new Map<string, number>();
  // When an Agent with unconsolidated work last finished a succeeded Run.
  readonly #lastRunAt = new Map<string, number>();
  readonly #timer: ReturnType<typeof setInterval>;
  constructor(
    private readonly options: {
      host: AgentMemoryHost;
      runtimeState: TeamHubRuntimeStateClient;
      memory: MemoryClient;
      modelCall: ModelCall;
      logger: Pick<AgentLogger, "log">;
      /**
       * Whether a Local Computer is online and can serve this Runtime's
       * history now. Maintenance never wakes or waits for a Computer.
       */
      canReadHistory?: (
        computerId: string,
        runtimeType: "codex" | "claude" | "pi",
      ) => boolean;
      now?: () => number;
    },
  ) {
    // Run terminals (recordRun) and compaction starts (wake) arrive through
    // the Context feature ports; no self-managed subscription here.
    this.#timer = setInterval(() => {
      void this.reconcile();
    }, 30_000);
    this.#timer.unref();
  }

  async reconcile(): Promise<void> {
    if (this.#stop.signal.aborted) return;
    try {
      const contexts = await this.options.runtimeState.listContexts(
        undefined,
        this.#stop.signal,
      );
      const inputs = new Map<string, string[]>();
      for (const context of contexts) {
        const positions = inputs.get(context.ref.agent_id) ?? [];
        if (context.ref.kind === "meta" && !context.terminal_reason)
          positions.push(
            `${context.context_key}:${context.next_input_sequence}`,
          );
        inputs.set(context.ref.agent_id, positions);
      }
      await Promise.all(
        [...inputs].map(([id, positions]) => {
          const signature = positions.sort().join("\n");
          return this.#settled.get(id) === signature &&
            !this.#extractionDue(id) &&
            !this.#consolidationDue(id)
            ? Promise.resolve()
            : this.#wake(id, signature);
        }),
      );
    } catch (error) {
      this.#log(error);
    }
  }

  /**
   * Counts one succeeded Meta Run: extraction starts once enough add up, and
   * consolidation waits for the Agent to stay idle after it.
   */
  recordRun(agentId: string): Promise<void> {
    this.#runs.set(agentId, (this.#runs.get(agentId) ?? 0) + 1);
    this.#lastRunAt.set(agentId, this.#now());
    return this.#extractionDue(agentId)
      ? this.#wake(agentId)
      : Promise.resolve();
  }

  /** Extracts and consolidates now, without waiting for Runs or idleness. */
  wake(agentId: string): Promise<void> {
    return this.#wake(agentId, undefined, true);
  }

  #extractionDue(agentId: string): boolean {
    return (this.#runs.get(agentId) ?? 0) >= RUNS_PER_EXTRACTION;
  }

  #consolidationDue(agentId: string): boolean {
    const lastRunAt = this.#lastRunAt.get(agentId);
    return (
      lastRunAt !== undefined &&
      this.#now() - lastRunAt >= IDLE_BEFORE_CONSOLIDATION_MS
    );
  }

  #wake(agentId: string, signature?: string, force = false): Promise<void> {
    if (this.#stop.signal.aborted) return Promise.resolve();
    const running = this.#running.get(agentId);
    if (running) return running;
    const backoff = this.#backoff.get(agentId);
    if (backoff && backoff.until > this.#now()) return Promise.resolve();
    const runs = this.#runs.get(agentId) ?? 0;
    const lastRunAt = this.#lastRunAt.get(agentId);
    const mode: PassMode =
      force || this.#consolidationDue(agentId)
        ? "consolidate"
        : runs >= RUNS_PER_EXTRACTION
          ? "extract"
          : "resume";
    const work = this.#advance(agentId, mode)
      .then((settled) => {
        this.#backoff.delete(agentId);
        if (settled && signature !== undefined)
          this.#settled.set(agentId, signature);
        else this.#settled.delete(agentId);
        if (settled && mode !== "resume") {
          // Runs that finished during this pass count toward the next one.
          const left = (this.#runs.get(agentId) ?? 0) - runs;
          if (left > 0) this.#runs.set(agentId, left);
          else this.#runs.delete(agentId);
        }
        // History left unread by this pass waits for the next Run, so an
        // offline Computer is not retried every scan.
        if (
          mode === "consolidate" &&
          this.#lastRunAt.get(agentId) === lastRunAt
        )
          this.#lastRunAt.delete(agentId);
      })
      .catch((error) => {
        this.#settled.delete(agentId);
        const failures = (backoff?.failures ?? 0) + 1;
        this.#backoff.set(agentId, {
          failures,
          until:
            this.#now() +
            Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS),
        });
        this.#log(error, agentId);
      })
      .finally(() => this.#running.delete(agentId));
    this.#running.set(agentId, work);
    return work;
  }

  async close(): Promise<void> {
    clearInterval(this.#timer);
    this.#stop.abort();
    await Promise.all(this.#running.values());
  }

  /**
   * Resolves true only when every Meta Context was read and nothing is left to
   * do. An extracting pass reads every batch its Contexts held when it began;
   * a consolidating pass then merges the waiting candidates once.
   */
  async #advance(agentId: string, mode: PassMode): Promise<boolean> {
    const { host, runtimeState, memory } = this.options;
    const signal = this.#stop.signal;
    const ghost = await host.getGhost(agentId);
    if (!ghost) {
      // Ghost store maps only HTTP 404 to null (teamhub-ghost-store.ts get catch + isNotFound).
      this.options.logger.log("info", "agent_memory.settled_config_gone", {
        agentId,
        status: 404,
      });
      return true;
    }
    const runtime = ghost.runtime.placement.runtimeType;
    if (runtime !== "codex" && runtime !== "claude" && runtime !== "pi")
      return true;
    const computerId = ghost.runtime.placement.computerId;
    // Both stages run on the Agent's own Computer and Runtime.
    const placement = {
      tenantId: ghost.runtime.placement.tenantId,
      ownerActorId: ghost.runtime.placement.ownerActorId,
      agentId,
      computerId,
      runtimeType: runtime,
    };
    // Looked up once per pass, and only when a stage is built or run. An
    // offline Computer fails the pass as the model call would, so no stage
    // is sized without the window.
    let budget: MemoryBudget | undefined;
    const budgetOf = async () =>
      (budget ??= memoryBudget(
        await this.options.modelCall.contextWindow?.({ placement }, signal),
      ));
    let document = await memory.read(agentId, signal);
    // Candidates found waiting after a restart start their idle period now.
    if (
      !this.#lastRunAt.has(agentId) &&
      Object.values(document.sessions).some((session) => session.raw_memory)
    )
      this.#lastRunAt.set(agentId, this.#now());
    // Reading history is not an execution demand: an offline or sleeping
    // Computer is skipped. Pending stages and consolidation need no Computer.
    const readable = this.options.canReadHistory?.(computerId, runtime) ?? true;
    let settled = true;
    // The newest record of each Context when this pass first read it. Records
    // written while the pass runs wait for the next one, so a busy
    // conversation cannot keep one pass going.
    const limits = new Map<string, number>();
    for (;;) {
      if (!document.pending) {
        // A pending stage always resumes; new work waits until it is due.
        if (mode === "resume") return settled;
        if (!readable) settled = false;
        const waiting = Object.entries(document.sessions).filter(
          ([, session]) => session.raw_memory,
        );
        const full =
          waiting.length >= MAX_SESSIONS ||
          waiting.reduce(
            (total, [, session]) => total + bytes(session.raw_memory),
            0,
          ) > MAX_WAITING_CANDIDATE_BYTES;
        let extracting = false;
        for (const context of full || !readable
          ? []
          : await runtimeState.listContexts(agentId, signal)) {
          if (context.ref.kind !== "meta" || context.terminal_reason) continue;
          // No input yet means no history to read.
          if (context.next_input_sequence === "0") continue;
          if (
            (await runtimeState.getWorkState(context.context_key, signal))
              .has_pending_work
          ) {
            settled = false;
            continue;
          }
          const ref = decodeExecutionContextKey(context.context_key);
          const page = await host.inspectDebugContextHistory(ref, {
            limit: 200,
            signal,
          });
          // Unreadable history waits for the next due pass.
          if (page.status !== "available") continue;
          if (page.snapshot.tailState !== "clean") {
            settled = false;
            continue;
          }
          const sourceKey = sha256Hex(context.context_key);
          const previous = document.sessions[sourceKey]?.summary;
          const cursorState = document.cursors[sourceKey];
          const through =
            cursorState?.thread_id === page.snapshot.threadId
              ? cursorState.through
              : -1;
          const limit =
            limits.get(context.context_key) ??
            page.records.reduce(
              (newest, record) => Math.max(newest, record.ordinal),
              through,
            );
          limits.set(context.context_key, limit);
          let records: RuntimeHistoryRecord[] = [...page.records];
          let cursor = page.previousCursor;
          // Read backwards only as far as the saved watermark. Batches stay bounded;
          // a long session is consumed over several batches rather than silently skipped.
          while (
            cursor &&
            records.every((record) => record.ordinal > through)
          ) {
            const older = await host.inspectDebugContextHistory(ref, {
              cursor,
              limit: 200,
              signal,
            });
            if (
              older.status !== "available" ||
              older.snapshot.id !== page.snapshot.id
            )
              throw new Error("Memory history changed while reading");
            records = [...older.records, ...records];
            cursor = older.previousCursor;
          }
          // Developer and system messages carry the Agent's configuration.
          records = records
            .filter(
              (record) =>
                record.ordinal > through &&
                record.ordinal <= limit &&
                SOURCE_CATEGORIES.has(record.category) &&
                record.role !== "developer" &&
                record.role !== "system",
            )
            .map((record) => ({
              ...record,
              nativeRecord: clip(
                record.nativeRecord,
              ) as RuntimeHistoryRecord["nativeRecord"],
            }))
            .sort((a, b) => a.ordinal - b.ordinal);
          if (
            !records.some(
              (record) =>
                record.category === "message" ||
                record.category === "tool_result",
            )
          )
            continue;
          // The records share the input with the instructions and the
          // previous summary.
          const room = Math.min(
            MAX_EXTRACTION_RECORD_BYTES,
            (await budgetOf()).input -
              bytes(memoryInstructions("extract", (await budgetOf()).memory)) -
              bytes(
                JSON.stringify({
                  source_context: context.context_key,
                  previous: previous ?? null,
                  records: [],
                }),
              ),
          );
          const batch: RuntimeHistoryRecord[] = [];
          let size = 0;
          for (const record of records) {
            const recordBytes = bytes(JSON.stringify(record));
            if (size + recordBytes > room) break;
            batch.push(record);
            size += recordBytes;
          }
          if (!batch.length)
            throw new Error("Memory history record exceeds extraction budget");
          const last = batch.at(-1)!.ordinal;
          const prompt = JSON.stringify({
            source_context: context.context_key,
            previous: previous ?? null,
            records: batch,
          });
          document = await memory.commit(
            agentId,
            {
              ...document,
              pending: {
                stage: "extract",
                prompt,
                source_key: sourceKey,
                thread_id: page.snapshot.threadId,
                through: last,
              },
            },
            signal,
          );
          extracting = true;
          break;
        }
        if (!extracting) {
          // Every consolidation clears the candidates it took, so this ends.
          if (!waiting.length || (!full && mode !== "consolidate"))
            return settled;
          const previousMemory = {
            summary: document.summary,
            memory: document.memory,
          };
          const memorySections = memorySectionHeadings(document.memory);
          let size =
            bytes(
              memoryInstructions("consolidate", (await budgetOf()).memory),
            ) +
            bytes(
              JSON.stringify({
                previous: previousMemory,
                memory_sections: memorySections,
                extractions: [],
              }),
            );
          // Sessions least recently extracted go first. Those that do not fit
          // wait for the next consolidation of this pass. A consolidation
          // always takes at least one session, so a small window never
          // blocks the candidates.
          const extractions: {
            key: string;
            context_key: string;
            summary: string;
            raw_memory: string;
          }[] = [];
          for (const [key, session] of waiting.sort(
            ([, a], [, b]) => a.updated_revision - b.updated_revision,
          )) {
            const extraction = {
              key,
              context_key: session.context_key,
              summary: session.summary,
              raw_memory: session.raw_memory,
            };
            const extractionBytes = bytes(JSON.stringify(extraction));
            if (
              extractions.length &&
              size + extractionBytes > (await budgetOf()).input
            )
              break;
            extractions.push(extraction);
            size += extractionBytes;
          }
          const prompt = JSON.stringify({
            previous: previousMemory,
            memory_sections: memorySections,
            extractions,
          });
          document = await memory.commit(
            agentId,
            { ...document, pending: { stage: "consolidate", prompt } },
            signal,
          );
        }
      }
      // Each pending stage runs to publication. The persisted pending stage is
      // the checkpoint across restarts and the bounded retry counter.
      for (
        let pending = document.pending;
        pending;
        pending = document.pending
      ) {
        const attempt = pending.attempt ?? 0;
        if (attempt >= MAX_STAGE_ATTEMPTS)
          throw new Error(
            `Memory ${pending.stage} produced no valid output in ${MAX_STAGE_ATTEMPTS} attempts`,
          );
        let output: Record<string, unknown>;
        let consolidated: string;
        const { stage } = pending;
        const memoryLimit = (await budgetOf()).memory;
        // Throws what the output schema cannot express; a consolidation
        // returns the memory its edits produce.
        const previous = document.memory;
        const checked = (candidate: Record<string, unknown>): string => {
          if (stage === "extract") {
            outputText(candidate, "session_summary", 32_000);
            outputText(candidate, "raw_memory", 32_000);
            return "";
          }
          outputText(candidate, "summary", 8_000);
          const edited = applyMemoryEdits(previous, candidate.edits);
          if (bytes(edited) > memoryLimit)
            throw new InvalidMemoryOutputError("Memory exceeds its limit");
          return edited;
        };
        try {
          ({ output } = await this.options.modelCall.call({
            kind: "agent_memory",
            key: `agent-memory:${agentId}:${stage}`,
            placement,
            instructions: memoryInstructions(stage, memoryLimit),
            input: pending.prompt,
            schemaName: `memory_${stage}`,
            outputSchema: memoryOutputSchema(stage),
            timeoutMs: STAGE_TIMEOUT_MS[stage],
            // The call corrects an output these checks reject, so a stage
            // fails only past its kind's attempts.
            validate: (candidate) => {
              try {
                checked(candidate);
                return undefined;
              } catch (error) {
                if (error instanceof InvalidMemoryOutputError)
                  return error.message;
                throw error;
              }
            },
            signal,
          }));
          consolidated = checked(output);
        } catch (error) {
          // Only an output the model produced, or a Runtime that ran out of
          // time producing one, counts against the attempt budget; an offline
          // Computer or a missing Runtime backs off instead. Either way the
          // stage backs off, so it never holds the model back to back.
          if (
            !(error instanceof InvalidMemoryOutputError) &&
            !(
              error instanceof ModelCallError &&
              (error.kind === "invalid_output" || error.kind === "timed_out")
            )
          )
            throw error;
          await memory.commit(
            agentId,
            { ...document, pending: { ...pending, attempt: attempt + 1 } },
            signal,
          );
          throw error;
        }
        const { pending: _, ...published } = document;
        if (pending.stage === "extract") {
          const { source_key: key, thread_id, through } = pending;
          if (
            key === undefined ||
            thread_id === undefined ||
            through === undefined
          )
            throw new Error("Memory extraction checkpoint names no source");
          const source = JSON.parse(pending.prompt) as {
            source_context: string;
          };
          const waiting = document.sessions[key]?.raw_memory ?? "";
          const found = outputText(output, "raw_memory", 32_000);
          const sessions = { ...document.sessions };
          sessions[key] = {
            context_key: source.source_context,
            thread_id,
            through,
            summary: outputText(output, "session_summary", 32_000),
            // Candidates wait here until the next consolidation merges them.
            raw_memory:
              waiting && found ? `${waiting}\n\n${found}` : waiting || found,
            updated_revision: document.revision + 1,
          };
          // A session whose candidates still wait is never evicted.
          const oldest = Object.keys(sessions)
            .filter((other) => other === key || !sessions[other]!.raw_memory)
            .sort(
              (a, b) =>
                sessions[a]!.updated_revision - sessions[b]!.updated_revision,
            );
          for (const evicted of oldest.slice(
            0,
            Math.max(0, Object.keys(sessions).length - MAX_SESSIONS),
          ))
            delete sessions[evicted];
          document = await memory.commit(
            agentId,
            {
              ...published,
              sessions,
              cursors: { ...document.cursors, [key]: { thread_id, through } },
            },
            signal,
          );
          continue;
        }
        const { extractions } = JSON.parse(pending.prompt) as {
          extractions: readonly { key: string }[];
        };
        const sessions = { ...document.sessions };
        for (const { key } of extractions)
          if (sessions[key])
            sessions[key] = { ...sessions[key], raw_memory: "" };
        document = await memory.commit(
          agentId,
          {
            ...published,
            sessions,
            summary: outputText(output, "summary", 8_000),
            memory: consolidated,
          },
          signal,
        );
      }
    }
  }

  #now(): number {
    return this.options.now?.() ?? Date.now();
  }

  #log(error: unknown, agentId?: string): void {
    if (!this.#stop.signal.aborted)
      this.options.logger.log("warn", "agent_memory.reconcile_failed", {
        agentId,
        error: String(error),
      });
  }
}

function outputText(
  value: Record<string, unknown>,
  field: string,
  limit: number,
): string {
  const text = value[field];
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > limit)
    throw new InvalidMemoryOutputError(`Invalid memory output: ${field}`);
  return text;
}
