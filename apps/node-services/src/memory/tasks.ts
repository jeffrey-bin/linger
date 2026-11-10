import { loadAnotherMeSubjects } from "./collector.js";
import { runDailyCli } from "./daily-cli.js";
import { localDate } from "./date.js";
import { recordSubjectFailure, recordWikiRefresh } from "./run-telemetry.js";
import type { MemoryScheduledTask, SubjectLane } from "./scheduler.js";
import { runWikiSessionSources, runWeeklyCli } from "./sync-runners.js";
import {
  filesystemMemoryTaskState,
  type MemoryTaskState,
} from "./task-state.js";
import { runWikiSyncCli, type WikiSyncResult } from "./wiki-sync-cli.js";

const taskSteps = {
  daily: runDailyCli,
  wiki: runWikiSessionSources,
  weekly: runWeeklyCli,
  wikiSync: runWikiSyncCli,
};

export interface MemoryTaskRuntime {
  listSubjects?: () => Promise<string[]>;
  /** Indexes a subject's Session Raw before its Wiki refresh; the Wiki reads
   * Sessions from the index. */
  indexSessionRaw?: (agentId: string) => Promise<unknown>;
  indexPeriodReports?: (
    memorySubjectKey: string,
    kind: "daily" | "weekly",
  ) => Promise<void>;
  /** The task is a rebuild step; see WikiSyncRuntime.subjectResult. */
  rebuild?: boolean;
  /** The scheduled midnight slot, including delayed or recovered attempts. */
  nightly?: boolean;
  /** Serializes each fanned-out subject with that subject's other work. */
  subjectLane?: SubjectLane;
}

export async function runMemoryTask(
  memoryRoot: string,
  input: MemoryScheduledTask,
  steps: typeof taskSteps = taskSteps,
  taskState: MemoryTaskState = filesystemMemoryTaskState,
  runtime: MemoryTaskRuntime = {},
): Promise<void> {
  if (!input.memorySubjectKey) {
    const allSubjectKeys = await (
      runtime.listSubjects ?? listMemorySubjectKeys
    )();
    if (allSubjectKeys.length === 0) {
      throw new Error(
        "No AnotherMe memory subjects matched the supplied options",
      );
    }
    const held =
      "heldMemorySubjectKeys" in input ? input.heldMemorySubjectKeys : [];
    const subjectKeys = allSubjectKeys.filter((key) => !held?.includes(key));
    if (subjectKeys.length === 0) return;
    const lane: SubjectLane = runtime.subjectLane ?? ((_, work) => work());
    const runOne = (memorySubjectKey: string) =>
      lane(memorySubjectKey, () =>
        runMemoryTask(
          memoryRoot,
          scopedTask(input, memorySubjectKey),
          steps,
          taskState,
          runtime,
        ),
      );
    // A deployment has one account and so normally one subject.
    if (subjectKeys.length === 1) {
      await runOne(subjectKeys[0]!);
      return;
    }
    await runIsolatedSubjects(subjectKeys, runOne);
    return;
  }

  const rootArgs = ["--memory-root", memoryRoot];
  const scopeArgs = ["--memory-subject-key", input.memorySubjectKey];
  switch (input.task) {
    case "wiki": {
      // The marker survives a crash between staging Session sources and
      // publishing them to the Wiki.
      const wikiPending =
        input.resumeDownstream ||
        (await taskState.hasWikiPending(
          memoryRoot,
          input.date,
          input.memorySubjectKey,
        ));
      const args = [
        "run",
        "--date",
        input.date,
        "--concurrency",
        String(input.concurrency),
        ...rootArgs,
        ...scopeArgs,
        ...(input.roomId ? ["--room-id", input.roomId] : []),
        ...(input.recordingId ? ["--recording-id", input.recordingId] : []),
      ];
      const result = await steps.wiki(args);
      if (result.updatedSessionCount > 0) {
        await taskState.markWikiPending(
          memoryRoot,
          input.date,
          input.memorySubjectKey,
        );
      }
      if (runtime.nightly || wikiPending || result.updatedSessionCount > 0) {
        // Raw is staged and indexed on every run; only a meeting and the run
        // that closes a day ask for a Wiki refresh. The Wiki reads Sessions
        // from the index, so the sync indexes before it asks. No refresh is
        // awaited: the Daily reads the raw conversations, not the Wiki.
        const closesDay =
          runtime.nightly || (runtime.rebuild && input.date < localDate());
        await runWikiSyncStep(steps, runtime, [
          "--date",
          input.date,
          ...rootArgs,
          ...scopeArgs,
          ...(input.recordingId
            ? ["--capture-id", input.recordingId]
            : closesDay
              ? []
              : ["--index-only"]),
        ]);
        // A Session that arrives for a closed date brings that date's Daily
        // up to date. Calendar hourly work does not re-run Daily here.
        if (
          input.date < localDate() &&
          (input.roomId || input.recordingId || input.resumeDownstream)
        ) {
          const daily = await steps.daily([
            "run",
            "--date",
            input.date,
            ...rootArgs,
            ...scopeArgs,
          ]);
          if (daily.processedSubjectCount > 0) {
            await runtime.indexPeriodReports?.(input.memorySubjectKey, "daily");
          }
        }
        await taskState.clearWikiPending(
          memoryRoot,
          input.date,
          input.memorySubjectKey,
        );
      }
      return;
    }
    case "daily": {
      const args = ["run", "--date", input.date, ...rootArgs, ...scopeArgs];
      const result = await steps.daily(args);
      if (result.processedSubjectCount === 0) return;
      await runtime.indexPeriodReports?.(input.memorySubjectKey, "daily");
      return;
    }
    case "weekly": {
      const result = await steps.weekly([
        "run",
        "--week-start",
        input.weekStart,
        "--concurrency",
        String(input.concurrency),
        ...rootArgs,
        ...scopeArgs,
      ]);
      if (result.processedSubjectCount === 0) return;
      await runtime.indexPeriodReports?.(input.memorySubjectKey, "weekly");
      return;
    }
    default:
      // Rebuild init/index steps are dispatched by the service, not here.
      throw new Error(`Unsupported Memory task: ${input.task}`);
  }
}

async function runWikiSyncStep(
  steps: typeof taskSteps,
  runtime: MemoryTaskRuntime,
  args: string[],
): Promise<void> {
  const results: WikiSyncResult[] =
    steps !== taskSteps
      ? await steps.wikiSync(args)
      : await runWikiSyncCli(args, {
          indexSessionRaw: runtime.indexSessionRaw,
          subjectResult: runtime.rebuild,
        });
  for (const result of results) {
    recordWikiRefresh({
      ...(result.refresh_id ? { id: result.refresh_id } : {}),
      memory_subject_key: result.memory_subject_key,
      status: result.refresh_status,
    });
  }
}

async function listMemorySubjectKeys(): Promise<string[]> {
  return (await loadAnotherMeSubjects()).map(
    (subject) => subject.memorySubjectKey,
  );
}

function scopedTask(
  input: MemoryScheduledTask,
  memorySubjectKey: string,
): MemoryScheduledTask {
  return { ...input, memorySubjectKey };
}

/** Each subject runs on its own lane; one failure does not stop the others. */
async function runIsolatedSubjects(
  subjectKeys: string[],
  runOne: (memorySubjectKey: string) => Promise<void>,
): Promise<void> {
  const failures: Array<{ error: string; memory_subject_key: string }> = [];
  await Promise.all(
    subjectKeys.map(async (memorySubjectKey) => {
      try {
        await runOne(memorySubjectKey);
      } catch (error) {
        const failure = {
          error: error instanceof Error ? error.message : String(error),
          memory_subject_key: memorySubjectKey,
        };
        failures.push(failure);
        recordSubjectFailure(failure);
      }
    }),
  );
  if (failures.length > 0) {
    throw new Error(
      `${failures.length === subjectKeys.length ? "All" : "Some"} ${failures.length} AnotherMe refreshes failed: ${failures
        .map(
          ({ memory_subject_key, error }) => `${memory_subject_key}: ${error}`,
        )
        .join("; ")}`,
    );
  }
}
