// The nightly day read: one memory Agent task reads a day's raw conversations
// once and writes both memory.md edits and the Daily report, memory.md first.
// Each write is checked as its own task does it (the memory.md quote check,
// the Daily schema and rendering); a rejected one is fixed in the next step.
// A day too large for one task falls back to the separate Daily and
// memory.md calls.
import fs from "node:fs/promises";
import path from "node:path";

import {
  estimateTokens,
  taskTokens,
  runAgentTask,
  type AgentEnvironment,
  type AgentObservation,
  type AgentTask,
} from "../memory-agent.js";
import {
  applyCheckedDaily,
  checkDailyReport,
  dailyPrompt,
  dailySourceCatalog,
  writeDailyReport,
  type DailyCollection,
  type DailyOptions,
} from "./daily-cli.js";
import { memoryDatabase } from "./database.js";
import { memoryContextWindow, runMemoryModelChain } from "./llm.js";
import { promptRoot } from "./paths.js";
import type { MemoryUpdateOutput } from "./types.js";
import { writeMemoryLog } from "./run-telemetry.js";
import {
  applyUserMemoryEdits,
  emptyUserMemory,
  initialUserMemory,
  postgresUserMemoryStore,
  renderUserMemory,
  UserMemoryConflictError,
  userMemoryCapacity,
  userMemoryEditSchema,
  type UserMemoryEdit,
  type UserMemoryEvidence,
  type UserMemorySections,
  type UserMemoryStore,
} from "./user-memory.js";
import { projectUserMemory, syncDailyMemory } from "./user-memory-sync.js";

const LIMITS = { steps: 3, actions: 4, output: 12_000, result: 3_000 };
// A step normally answers within about a minute; a stalled Runtime turn is
// cut here and retried within the Memory kind's attempts.
const STEP_TIMEOUT_MS = 5 * 60_000;

export interface DayReadResult {
  /** The Daily file, when one was written. */
  dailyPath: string | undefined;
  /** memory.md edits applied; dropped ones failed the quote check. */
  memory: { changed: boolean; edits: number; dropped: number };
  /** Whether the day fit one task; otherwise the separate calls ran. */
  merged: boolean;
}

/** Writes the day's memory.md edits and Daily from its raw conversations. */
export async function runDayRead(
  options: DailyOptions,
  collection: DailyCollection,
  store: UserMemoryStore = postgresUserMemoryStore(memoryDatabase()),
): Promise<DayReadResult> {
  const owner = {
    tenantId: options.subject.tenantId,
    ownerActorId: options.subject.representedHumanActorId,
  };
  const base = await store.latest(owner);
  const current =
    base?.sections ??
    initialUserMemory(
      options.subject.representedHumanDisplayName,
      owner.ownerActorId,
      options.date,
    );
  const catalog = dailySourceCatalog(collection.sessionFiles);
  const evidence: UserMemoryEvidence[] = collection.sessionFiles.map(
    (file) => ({
      ref: catalog.find((entry) => entry.resource === file.path)!.sourceRef,
      kind: "session",
      content: file.content,
      source: file.path,
    }),
  );
  const daily = await dailyPrompt(options, collection);
  const task = dayReadTask(
    await fs.readFile(path.join(promptRoot, "user-memory/update.md"), "utf8"),
    daily.prompt,
    userMemoryEditSchema(evidence.map(({ ref }) => ref)),
    daily.schema,
  );
  const input = JSON.stringify({
    human: options.subject.representedHumanDisplayName,
    date: options.date,
    cadence: "daily",
    memory: current,
    ...userMemoryCapacity(current),
  });
  const loopTokens = taskTokens(await memoryContextWindow(owner));
  if (
    estimateTokens(task.instructions) +
      estimateTokens(input) +
      LIMITS.steps * (LIMITS.output + LIMITS.result) >
    loopTokens
  )
    return separate(options, collection);

  const staged: {
    memory?: {
      sections: UserMemorySections;
      applied: UserMemoryEdit[];
      dropped: number;
      note: string;
    };
    daily?: MemoryUpdateOutput;
  } = {};
  const environment: AgentEnvironment = {
    runTool: async (name) => ({ ok: false, content: `Unknown tool ${name}` }),
    propose: async (object, _target, payload): Promise<AgentObservation> => {
      try {
        if (object === "memory.md") {
          const edits = payload.edits as UserMemoryEdit[];
          const stage = (skipInvalid: boolean) => {
            const { sections, applied } = applyUserMemoryEdits(
              current,
              edits,
              options.date,
              evidence,
              skipInvalid,
            );
            staged.memory = {
              sections,
              applied,
              dropped: edits.length - applied.length,
              note: (typeof payload.change_note === "string"
                ? payload.change_note
                : ""
              ).slice(0, 1000),
            };
            return applied;
          };
          let applied: UserMemoryEdit[];
          try {
            applied = stage(false);
          } catch (error) {
            // Without a corrected proposal, the valid edits still apply.
            try {
              stage(true);
            } catch {
              // Nothing valid to keep; the rejection below asks again.
            }
            throw error;
          }
          return {
            ok: true,
            content: `accepted ${applied.length} edits; ${edits.length - applied.length} dropped because their quote is not in the cited conversation`,
          };
        }
        staged.daily = await checkDailyReport(
          options,
          collection,
          JSON.stringify(payload),
        );
        return { ok: true, content: "accepted the Daily" };
      } catch (error) {
        return {
          ok: false,
          content: error instanceof Error ? error.message : String(error),
        };
      }
    },
    unfinished: () =>
      [staged.memory ? "" : "memory.md", staged.daily ? "" : "daily"]
        .filter(Boolean)
        .join(" and ") || undefined,
  };
  const startedAt = Date.now();
  const result = await runMemoryModelChain(
    {
      kind: "memory",
      key: `memory:day-read:${options.subject.memorySubjectKey}:${options.date}`,
      owner,
    },
    (model) =>
      runAgentTask({
        model,
        step: "day-read",
        task,
        input,
        maxInputTokens: loopTokens,
        environment,
      }),
  );
  writeMemoryLog("memory_day_read", {
    memory_subject_key: options.subject.memorySubjectKey,
    date: options.date,
    steps: result.steps.length,
    accepted: result.accepted,
    rejected: result.rejected,
    duration_ms: Date.now() - startedAt,
  });

  let memory = { changed: false, edits: 0, dropped: 0 };
  if (staged.memory) {
    memory = {
      changed: false,
      edits: staged.memory.applied.length,
      dropped: staged.memory.dropped,
    };
    if (
      renderUserMemory(staged.memory.sections) !==
      renderUserMemory(base?.sections ?? emptyUserMemory())
    ) {
      const note = staged.memory.note;
      const save = (
        from: typeof base,
        sections: UserMemorySections,
        applied: UserMemoryEdit[],
      ) =>
        store.save(owner, from, {
          sections,
          baseProfileRevisionId: from?.baseProfileRevisionId ?? null,
          source: "daily",
          changeNote: note,
          evidence: [
            { edits: applied },
            ...evidence.map(({ ref, kind, source }) => ({ ref, kind, source })),
          ],
        });
      try {
        await save(base, staged.memory.sections, staged.memory.applied);
      } catch (error) {
        if (!(error instanceof UserMemoryConflictError)) throw error;
        // A Profile sync can write memory.md while the day is read; the
        // day's edits then go onto that version, once.
        const latest = await store.latest(owner);
        const { sections, applied } = applyUserMemoryEdits(
          latest?.sections ?? current,
          staged.memory.applied,
          options.date,
          evidence,
          true,
        );
        memory.edits = applied.length;
        memory.dropped += staged.memory.applied.length - applied.length;
        await save(latest, sections, applied);
      }
      await projectUserMemory(
        options.memoryRoot,
        options.subject.memorySubjectKey,
        owner,
        store,
      );
      memory.changed = true;
    }
  } else {
    writeMemoryLog(
      "memory_day_read_incomplete",
      {
        memory_subject_key: options.subject.memorySubjectKey,
        date: options.date,
        missing: "memory.md",
      },
      "ERROR",
    );
    await syncDailyMemory(
      options.memoryRoot,
      options.subject,
      options.date,
      collection.sessionFiles,
      store,
    );
  }
  let dailyPath: string | undefined;
  if (staged.daily) {
    await applyCheckedDaily(options, collection, staged.daily);
    dailyPath = collection.requiredOutputs.dailyMemoryPath;
  } else {
    writeMemoryLog(
      "memory_day_read_incomplete",
      {
        memory_subject_key: options.subject.memorySubjectKey,
        date: options.date,
        missing: "daily",
      },
      "ERROR",
    );
    dailyPath = await writeDailyReport(options, collection);
  }
  return { dailyPath, memory, merged: true };
}

/** The separate calls for a day too large for one task. */
async function separate(
  options: DailyOptions,
  collection: DailyCollection,
): Promise<DayReadResult> {
  const dailyPath = await writeDailyReport(options, collection);
  await syncDailyMemory(
    options.memoryRoot,
    options.subject,
    options.date,
    collection.sessionFiles,
  );
  return {
    dailyPath,
    memory: { changed: false, edits: 0, dropped: 0 },
    merged: false,
  };
}

function dayReadTask(
  memoryRules: string,
  dailyRules: string,
  memorySchema: Record<string, unknown>,
  dailySchema: Record<string, unknown>,
): AgentTask {
  return {
    name: "memory.day_read",
    instructions: `Read one day's conversations once and write two things from them, in this order: the memory.md edits, then the Daily report.

- Propose both in your first step: \`memory.md\` first, then \`daily\`. \`target\` is "memory.md" and "daily".
- memory.md is edited from the conversations themselves, not from the Daily you write after it. Every edit quotes the represented Human's own words from the cited conversation.
- A rejected proposal comes back with its reason; resend only that one, in full. The task finishes when both are accepted.
- The input is the memory.md state (JSON). The day's conversations, yesterday's Daily and the Pocket Note are in the Daily collection inside the Daily rules below; their \`source_ref\` values are the refs both writes cite.`,
    objects: [
      {
        type: "memory.md",
        instructions: memoryRules.trim(),
        payloadSchema: memorySchema,
      },
      {
        type: "daily",
        instructions: dailyRules.trim(),
        payloadSchema: dailySchema,
      },
    ],
    tools: [],
    maxSteps: LIMITS.steps,
    maxActions: LIMITS.actions,
    maxResultChars: LIMITS.result * 3,
    effort: "medium",
    timeoutMs: STEP_TIMEOUT_MS,
  };
}
