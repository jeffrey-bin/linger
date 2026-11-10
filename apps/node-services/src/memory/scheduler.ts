import type { MemoryScheduleConfig } from "./config.js";
import {
  memoryScheduleRunLevel,
  memorySubjectFailureLog,
  memoryWikiRefreshLog,
  writeMemoryLog,
  type MemorySubjectFailure,
  type MemoryWikiRefresh,
} from "./run-telemetry.js";
import { isComputerOffline } from "../runtime-model-call.js";

export type MemoryScheduledTask =
  | {
      readonly task: "wiki";
      readonly date: string;
      readonly concurrency: number;
      readonly memorySubjectKey?: string;
      readonly roomId?: string;
      readonly recordingId?: string;
      readonly resumeDownstream?: boolean;
    }
  | {
      readonly task: "daily";
      readonly date: string;
      readonly concurrency: number;
      readonly memorySubjectKey?: string;
      /** Subjects whose dependency has not succeeded yet; they are skipped. */
      readonly heldMemorySubjectKeys?: readonly string[];
    }
  | {
      readonly task: "weekly";
      readonly weekStart: string;
      readonly concurrency: number;
      readonly memorySubjectKey?: string;
      readonly heldMemorySubjectKeys?: readonly string[];
    }
  | {
      /** Rebuild-only steps; `date` is the day the rebuild was started. */
      readonly task: MemoryRebuildStep;
      readonly date: string;
      readonly concurrency: number;
      readonly memorySubjectKey?: string;
    };

/** Runs one subject's share of a calendar run on that subject's serial lane. */
export type SubjectLane = <T>(
  subject: string,
  work: () => Promise<T>,
) => Promise<T>;

export type MemoryRebuildStep = "init" | "index-initial" | "index-final";
const REBUILD_STEPS: readonly string[] = [
  "init",
  "index-initial",
  "index-final",
];

export function isRebuildStep(
  input: MemoryScheduledTask,
): input is Extract<MemoryScheduledTask, { task: MemoryRebuildStep }> {
  return REBUILD_STEPS.includes(input.task);
}

/** One scheduled task attempt, written as the `memory_schedule_run` log. */
interface MemorySchedulerRun {
  readonly input: MemoryScheduledTask;
  readonly period: string;
  readonly reason: MemorySchedulerReason;
  readonly startedAt: string;
  finishedAt?: string;
  wikiRefreshes?: MemoryWikiRefresh[];
  status: "failed" | "running" | "succeeded";
  error?: string;
  subjectFailures?: MemorySubjectFailure[];
}

export type MemorySchedulerReason =
  | "hourly"
  | "daily"
  | "weekly"
  | "idle"
  | "recording"
  | "rebuild";

// Provider outages are usually brief: retry fast first, then back off.
const CALENDAR_RETRY_DELAYS_MS = [15_000, 60_000, 180_000, 600_000, 3_600_000];
const MAX_CALENDAR_ATTEMPTS = CALENDAR_RETRY_DELAYS_MS.length + 1;
// How long a task waits for an offline Computer before it asks again.
const COMPUTER_OFFLINE_RETRY_DELAY_MS = 5 * 60_000;
// A Computer that stays offline this long is treated as gone, so the task
// fails terminally instead of waiting forever.
const COMPUTER_OFFLINE_WAIT_LIMIT_MS = 7 * 24 * 3_600_000;

/** The running scheduler cannot accept an operator rebuild in its current mode. */
export class MemoryRebuildUnavailableError extends Error {}

/** A calendar or rebuild task the scheduler keeps until it settles. */
export type MemoryCalendarTask = DueTask;

/** The durable calendar: the last planned hour and every unsettled task. */
export interface MemoryCalendarState {
  readonly timeZone: string;
  /** Epoch hours of the last planned slot. */
  readonly hour: number;
  readonly completed: readonly string[];
  readonly pending: readonly MemoryCalendarTask[];
  readonly failed: readonly MemoryCalendarTask[];
}

/** Where the calendar lives; `saved` is read once, before the scheduler starts. */
export interface MemoryCalendarStore {
  readonly saved: MemoryCalendarState | undefined;
  save(state: MemoryCalendarState): Promise<void>;
}

/** Work the scheduler's one timer runs every `everyMs`, first at start. */
export interface MemoryPeriodicWork {
  /** Names the work in the failure log. */
  readonly name: string;
  readonly everyMs: number;
  run(now: Date): Promise<void>;
}

// With nothing due sooner the timer still wakes once a minute, so sources
// that change without telling this process are seen within that minute.
export const MEMORY_SCHEDULER_FALLBACK_MS = 60_000;
const MIN_PASS_INTERVAL_MS = 1_000;

interface DueTask {
  readonly input: MemoryScheduledTask;
  readonly period: string;
  readonly reason: MemorySchedulerReason;
  readonly dependsOn?: string;
  attempts?: number;
  nextAttemptAt?: number;
  retrySubjects?: string[];
  /** When the task first waited for an offline Computer, in epoch ms. */
  offlineSince?: number;
  terminalReason?: string;
}

export class MemoryScheduler {
  readonly #completed = new Set<string>();
  readonly #config: MemoryScheduleConfig;
  readonly #pending = new Map<string, DueTask>();
  readonly #failed = new Map<string, DueTask>();
  #now = Date.now();
  readonly #runTask: (
    input: MemoryScheduledTask,
    reason: MemorySchedulerReason,
    subjectLane: SubjectLane,
    period: string,
  ) => Promise<void>;
  readonly #scheduled = new Set<string>();
  /** Unscoped calendar runs keep their order (Daily follows its Wiki); each
   * subject's share of them still runs on that subject's lane. */
  #calendarQueue = Promise.resolve();
  /** Tail of each subject's serial lane. A subject's writes never overlap,
   * while different subjects run in parallel, so one slow or failing subject
   * cannot hold everyone else's Memory work. */
  readonly #lanes = new Map<string, Promise<void>>();
  readonly #inflight = new Set<Promise<void>>();
  #persisting = Promise.resolve();
  #timer: NodeJS.Timeout | undefined;
  #timerAt = 0;
  #lastPassAt = 0;
  #started = false;
  #stopped = false;
  #calendarHour: number | undefined;
  #restorePending = false;
  /** Running rebuild step keys by subject; at most one per subject. */
  readonly #rebuildRunning = new Map<string, string>();
  readonly #calendar: MemoryCalendarStore | undefined;
  readonly #periodic: readonly {
    readonly work: MemoryPeriodicWork;
    lastRunAt?: number;
    running?: boolean;
  }[];

  constructor(
    config: MemoryScheduleConfig,
    runTask: (
      input: MemoryScheduledTask,
      reason: MemorySchedulerReason,
      subjectLane: SubjectLane,
      period: string,
    ) => Promise<void>,
    periodic: readonly MemoryPeriodicWork[] = [],
    calendar?: MemoryCalendarStore,
  ) {
    this.#config = config;
    this.#runTask = runTask;
    this.#periodic = periodic.map((work) => ({ work }));
    this.#calendar = calendar;
    const saved = calendar?.saved;
    // Calendar hours are counted in one time zone; another zone starts over.
    if (saved && saved.timeZone === config.timeZone) {
      this.#calendarHour = saved.hour;
      for (const key of saved.completed) this.#completed.add(key);
      for (const due of saved.pending) {
        if ((due.attempts ?? 0) >= MAX_CALENDAR_ATTEMPTS) {
          this.#failed.set(taskKey(due), {
            ...due,
            terminalReason: "Interrupted final attempt; manual retry required",
          });
        } else this.#pending.set(taskKey(due), { ...due });
      }
      for (const due of saved.failed)
        this.#failed.set(taskKey(due), { ...due });
      this.#restorePending = true;
    }
  }

  /** Arms the one timer. Each pass sleeps until the next due calendar hour,
   * retry or periodic work, at most a minute; settled work wakes it early. */
  start(): void {
    if (this.#started) throw new Error("Memory scheduler is already started");
    this.#started = true;
    this.wake();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** Runs the next pass soon; a no-op before start and after stop. Passes
   * stay a second apart, so a wake from every settled task cannot spin. */
  wake(): void {
    this.#arm(
      Math.max(0, this.#lastPassAt + MIN_PASS_INTERVAL_MS - Date.now()),
    );
  }

  #arm(delayMs: number): void {
    if (!this.#started || this.#stopped) return;
    if (this.#timer && this.#timerAt <= Date.now() + delayMs) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timerAt = Date.now() + delayMs;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const now = new Date();
      this.#lastPassAt = now.getTime();
      this.runDueTasks(now);
      this.#arm(Math.max(MIN_PASS_INTERVAL_MS, this.nextDelayMs(now)));
    }, delayMs);
    this.#timer.unref();
  }

  /** How long the timer may sleep after a pass at `now`. */
  nextDelayMs(now: Date): number {
    const at = now.getTime();
    let next = at + MEMORY_SCHEDULER_FALLBACK_MS;
    const local = zonedDate(now, this.#config.timeZone);
    // Every zone offset is whole minutes, so local seconds equal UTC seconds.
    next = Math.min(
      next,
      at -
        (local.minute * 60_000 +
          now.getUTCSeconds() * 1_000 +
          now.getUTCMilliseconds()) +
        3_600_000,
    );
    for (const due of this.#pending.values())
      if ((due.nextAttemptAt ?? 0) > at)
        next = Math.min(next, due.nextAttemptAt!);
    for (const entry of this.#periodic)
      if (entry.lastRunAt !== undefined && !entry.running)
        next = Math.min(next, entry.lastRunAt + entry.work.everyMs);
    return Math.max(0, next - at);
  }

  async idle(): Promise<void> {
    while (this.#inflight.size) await Promise.all([...this.#inflight]);
  }

  /** Exhausted calendar tasks and backed-off retries, without run output. */
  failures() {
    const view = (due: DueTask) => ({
      key: taskKey(due),
      task: due.input.task,
      period: businessPeriod(due.input),
      subjects:
        due.retrySubjects ??
        (due.input.memorySubjectKey ? [due.input.memorySubjectKey] : []),
      attempts: due.attempts ?? 0,
    });
    return {
      exhausted: [...this.#failed.values()].map((due) => ({
        ...view(due),
        terminal_reason: (due.terminalReason ?? "").slice(0, 300),
      })),
      pending_retries: [...this.#pending.values()]
        .filter((due) => (due.attempts ?? 0) > 0)
        .map((due) => ({
          ...view(due),
          next_attempt_at: new Date(
            due.nextAttemptAt ?? this.#now,
          ).toISOString(),
        })),
    };
  }

  /** Moves exhausted tasks (all when keys are omitted) and the dependents they
   * blocked back to pending; the next tick runs them with fresh attempts. */
  async retryFailed(keys?: readonly string[]): Promise<string[]> {
    const selected = new Set(keys ?? this.#failed.keys());
    const depth = new Map<string, number>();
    const blockedDepth = (key: string): number | undefined => {
      if (selected.has(key)) return 0;
      const due = this.#failed.get(key);
      if (
        !due?.dependsOn ||
        due.terminalReason !== `Dependency exhausted: ${due.dependsOn}`
      )
        return undefined;
      const parent = blockedDepth(due.dependsOn);
      return parent === undefined ? undefined : parent + 1;
    };
    for (const key of this.#failed.keys()) {
      const value = blockedDepth(key);
      if (value !== undefined) depth.set(key, value);
    }
    // Dependencies enter the queue before the tasks they unblock.
    const revived = [...depth.keys()].sort(
      (left, right) => depth.get(left)! - depth.get(right)!,
    );
    for (const key of revived) {
      // A revived task starts over without its previous terminal reason.
      const { terminalReason, ...due } = this.#failed.get(key)!;
      void terminalReason;
      this.#failed.delete(key);
      this.#pending.set(key, { ...due, attempts: 0, nextAttemptAt: this.#now });
    }
    if (revived.length) {
      this.#restorePending = true;
      await this.#persistCalendar();
      this.wake();
    }
    return revived;
  }

  /** Queues one Another Me subject's rebuild: Wiki init from its documents,
   * one initial index, each Session date's Wiki -> Daily (Weekly after a closed
   * week's last Session date), then one final index. The first start (or a
   * restart) runs `prepare` on the subject's lane before any step is admitted. */
  enqueueRebuild(
    input: {
      memorySubjectKey: string;
      sessionDates: readonly string[];
      from?: string;
      restart?: boolean;
    },
    prepare?: () => Promise<void>,
    now = new Date(),
  ): Promise<{ task_keys: string[]; queued: string[] }> {
    if (!this.#calendar)
      throw new MemoryRebuildUnavailableError(
        "Rebuild requires the production calendar",
      );
    const today = formatDate(zonedDate(now, this.#config.timeZone));
    const { memorySubjectKey: subject, from } = input;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(subject))
      throw new TypeError("Rebuild subject is invalid");
    if (
      (from !== undefined && (!isDate(from) || from > today)) ||
      !input.sessionDates.every(isDate)
    )
      throw new TypeError("Rebuild from must be a date no later than today");
    const dates = [...new Set(input.sessionDates)]
      .filter((date) => (!from || date >= from) && date <= today)
      .sort();
    const chain = rebuildChain(subject, dates, today, this.#config.concurrency);
    return this.enqueue(async () => {
      if (this.#calendarHour === undefined)
        throw new MemoryRebuildUnavailableError("Calendar has not started");
      const owned = (key: string) => rebuildSubject(key) === subject;
      const existing = [
        ...this.#completed,
        ...this.#pending.keys(),
        ...this.#failed.keys(),
      ].filter(owned);
      if (!input.restart && existing.length)
        return { task_keys: existing, queued: [] };
      if ([...this.#pending.keys()].some(owned))
        throw new MemoryRebuildUnavailableError(
          "A rebuild is still pending for this subject",
        );
      for (const key of existing) {
        this.#completed.delete(key);
        this.#failed.delete(key);
      }
      await prepare?.();
      for (const due of chain) this.#pending.set(taskKey(due), due);
      await this.#persistCalendar();
      this.wake();
      writeMemoryLog("memory_rebuild_index_hold_started", {
        memory_subject_key: subject,
        session_dates: dates.length,
      });
      const keys = chain.map(taskKey);
      return { task_keys: keys, queued: keys };
    }, subject);
  }

  /** Subjects whose automatic indexing waits for their rebuild. Derived from
   * durable pending steps, so it survives restarts and ends with the chain. */
  rebuildHolds(): Set<string> {
    const held = new Set<string>();
    for (const due of this.#pending.values())
      if (due.reason === "rebuild") held.add(due.input.memorySubjectKey!);
    return held;
  }

  rebuildStatus(memorySubjectKey: string) {
    const owned = (key: string) => rebuildSubject(key) === memorySubjectKey;
    const pending = [...this.#pending.values()].filter((due) =>
      owned(taskKey(due)),
    );
    const failed = [...this.#failed.values()].filter((due) =>
      owned(taskKey(due)),
    );
    const completed = [...this.#completed].filter(owned);
    const sessionKeys = [...completed, ...[...pending, ...failed].map(taskKey)]
      .filter((key) => key.startsWith("wiki:"))
      .sort((left, right) => left.slice(-10).localeCompare(right.slice(-10)));
    const runningKey = this.#rebuildRunning.get(memorySubjectKey);
    const current =
      pending.find((due) => taskKey(due) === runningKey) ?? pending[0];
    return {
      memory_subject_key: memorySubjectKey,
      phase: current
        ? isRebuildStep(current.input)
          ? current.input.task
          : "sessions"
        : failed.length
          ? "failed"
          : completed.includes(`index-final:rebuild:${memorySubjectKey}`)
            ? "completed"
            : null,
      index_hold: pending.length > 0,
      from: sessionKeys[0]?.slice(-10) ?? null,
      to: sessionKeys.at(-1)?.slice(-10) ?? null,
      sessions: {
        total: sessionKeys.length,
        completed: sessionKeys.filter((key) => this.#completed.has(key)).length,
      },
      total: completed.length + pending.length + failed.length,
      completed: completed.length,
      pending: pending.length,
      failed: failed.length,
      running: pending.some((due) => taskKey(due) === runningKey),
      current_task: current ? taskKey(current) : null,
      current_date:
        current && !isRebuildStep(current.input)
          ? businessPeriod(current.input)
          : null,
      ...(current?.attempts
        ? {
            current_attempts: current.attempts,
            next_attempt_at: new Date(
              current.nextAttemptAt ?? this.#now,
            ).toISOString(),
          }
        : {}),
      failures: failed.slice(0, 200).map((due) => ({
        key: taskKey(due),
        attempts: due.attempts ?? 0,
        terminal_reason: (due.terminalReason ?? "").slice(0, 300),
      })),
    };
  }

  /** Runs work on a subject's lane, or on the ordered calendar queue when it
   * names no subject. A rejected job cannot poison either. */
  enqueue<T>(work: () => Promise<T>, subject?: string): Promise<T> {
    if (subject) return this.#inLane(subject, work);
    const result = this.#calendarQueue.then(work);
    this.#calendarQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return this.#track(result);
  }

  #inLane<T>(subject: string, work: () => Promise<T>): Promise<T> {
    const result = (this.#lanes.get(subject) ?? Promise.resolve()).then(work);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#lanes.set(subject, tail);
    void tail.then(() => {
      if (this.#lanes.get(subject) === tail) this.#lanes.delete(subject);
    });
    return this.#track(result);
  }

  #track<T>(work: Promise<T>): Promise<T> {
    const settled = work.then(
      () => undefined,
      () => undefined,
    );
    this.#inflight.add(settled);
    void settled.then(() => this.#inflight.delete(settled));
    return work;
  }

  runDueTasks(now: Date): void {
    this.#now = now.getTime();
    for (const entry of this.#periodic) {
      if (
        entry.running ||
        (entry.lastRunAt !== undefined &&
          entry.lastRunAt + entry.work.everyMs > this.#now)
      )
        continue;
      entry.running = true;
      entry.lastRunAt = this.#now;
      void entry.work
        .run(now)
        .catch(() => {
          writeMemoryLog(
            "memory_periodic_work_failed",
            { work: entry.work.name },
            "ERROR",
          );
        })
        .finally(() => {
          entry.running = false;
        });
    }
    const local = zonedDate(now, this.#config.timeZone);
    if (this.#calendar) {
      this.#scheduleDurableCalendar(local);
      // Due calendar work is admitted before new rebuild steps.
      this.#scheduleRebuild();
      return;
    }
    if (local.minute !== 0) return;
    const currentPeriod = `${formatDate(local)}T${pad(local.hour)}`;
    for (const [key, retry] of this.#pending) {
      if (
        retry.period === currentPeriod ||
        (retry.nextAttemptAt ?? 0) > this.#now
      )
        continue;
      this.#pending.delete(key);
      this.#schedule(retry);
    }
    for (const due of dueTasks(local, this.#config)) this.#schedule(due);
  }

  #scheduleDurableCalendar(local: ReturnType<typeof zonedDate>): void {
    const hour =
      Date.UTC(local.year, local.month - 1, local.day, local.hour) / 3_600_000;
    const newHour =
      hour > (this.#calendarHour ?? -Infinity) || this.#restorePending;
    this.#restorePending = false;
    for (const due of this.#pending.values()) {
      if (due.reason === "rebuild") continue;
      // Between hours, run only due retries; dependents wait for their result.
      if (
        !newHour &&
        due.dependsOn &&
        !this.#completed.has(due.dependsOn) &&
        !this.#failed.has(due.dependsOn)
      )
        continue;
      this.#schedule(due);
    }
    if (!newHour) return;
    const first =
      this.#calendarHour === undefined
        ? hour - local.hour
        : this.#calendarHour + 1;
    for (let slot = first; slot <= hour; slot += 1) {
      const date = new Date(slot * 3_600_000);
      // Intermediate hourly scans add no evidence; closed dates still require
      // their own Session -> Daily -> Weekly dependency chain in date order.
      if (date.getUTCHours() !== 0 && slot !== hour) continue;
      const missed = {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        hour: date.getUTCHours(),
        minute: 0,
        weekday: ((date.getUTCDay() + 6) % 7) + 1,
      };
      for (const due of dueTasks(missed, this.#config)) this.#schedule(due);
    }
    this.#calendarHour = Math.max(hour, this.#calendarHour ?? hour);
    void this.#track(this.#persistCalendar()).catch(() => {
      writeMemoryLog("wiki_calendar_checkpoint_failed", {}, "ERROR");
    });
  }

  /** Concurrent rebuild steps share one checkpoint; writes run in order and
   * each snapshots the state when it starts, so the last write is the newest. */
  #persistCalendar(): Promise<void> {
    const write = this.#persisting.then(async () => {
      if (!this.#calendar || this.#calendarHour === undefined) return;
      await this.#calendar.save({
        timeZone: this.#config.timeZone,
        hour: this.#calendarHour,
        completed: [...this.#completed],
        pending: [...this.#pending.values()],
        failed: [...this.#failed.values()],
      });
    });
    this.#persisting = write.catch(() => undefined);
    return write;
  }

  /** Runs one rebuild step at a time. The step holds its subject's lane, so it
   * never overlaps that subject's other work while every other subject keeps
   * running. */
  #scheduleRebuild(): void {
    const blocked = new Set<string>();
    const next: DueTask[] = [];
    const capacity = 1 - this.#rebuildRunning.size;
    // Chains are inserted in order, so one pass settles a whole blocked tail.
    for (const [key, due] of this.#pending) {
      if (due.reason !== "rebuild") continue;
      const subject = due.input.memorySubjectKey!;
      if (due.dependsOn && this.#failed.has(due.dependsOn)) {
        this.#pending.delete(key);
        this.#failed.set(key, {
          ...due,
          terminalReason: `Dependency exhausted: ${due.dependsOn}`,
        });
        blocked.add(subject);
      } else if (
        next.length < capacity &&
        !this.#rebuildRunning.has(subject) &&
        !next.some((task) => task.input.memorySubjectKey === subject) &&
        (!due.dependsOn || this.#completed.has(due.dependsOn)) &&
        (due.nextAttemptAt ?? 0) <= this.#now
      )
        next.push(due);
    }
    if (blocked.size) {
      for (const subject of blocked) this.#logHoldRelease(subject);
      void this.#track(this.#persistCalendar()).catch(() => {
        writeMemoryLog("wiki_calendar_checkpoint_failed", {}, "ERROR");
      });
    }
    for (const due of next) {
      const subject = due.input.memorySubjectKey!;
      this.#rebuildRunning.set(subject, taskKey(due));
      void this.enqueue(async () => {
        try {
          await this.#run(due);
        } finally {
          this.#rebuildRunning.delete(subject);
          this.#logHoldRelease(subject);
        }
      }, subject).catch(() => undefined);
    }
  }

  #logHoldRelease(subject: string): void {
    if (this.rebuildHolds().has(subject)) return;
    const completed = this.#completed.has(`index-final:rebuild:${subject}`);
    writeMemoryLog(
      "memory_rebuild_index_hold_released",
      {
        memory_subject_key: subject,
        outcome: completed ? "completed" : "failed",
      },
      completed ? "INFO" : "ERROR",
    );
  }

  /** Subjects still failing in a dependency that already ran; undefined while
   * it has not run or when its failure is not attributable to subjects. */
  #heldSubjects(key: string): string[] | undefined {
    const dependency = this.#pending.get(key) ?? this.#failed.get(key);
    if (!dependency?.attempts || this.#scheduled.has(key)) return undefined;
    return dependency.retrySubjects?.length
      ? dependency.retrySubjects
      : undefined;
  }

  #schedule(due: DueTask): void {
    const key = taskKey(due);
    if (
      this.#scheduled.has(key) ||
      this.#completed.has(key) ||
      this.#failed.has(key) ||
      (due.nextAttemptAt ?? 0) > this.#now
    )
      return;
    if (due.reason === "hourly") {
      const dependencies = new Set(
        [...this.#pending.values()].map((task) => task.dependsOn),
      );
      for (const [oldKey, old] of this.#pending) {
        if (
          old.reason === "hourly" &&
          old.input.task === "wiki" &&
          due.input.task === "wiki" &&
          old.input.date === due.input.date &&
          old.period < due.period &&
          !dependencies.has(oldKey) &&
          !old.retrySubjects?.length
        )
          this.#pending.delete(oldKey);
      }
    }
    this.#scheduled.add(key);
    if (this.#calendar) this.#pending.set(key, due);
    void this.enqueue(() => this.#run(due), due.input.memorySubjectKey).catch(
      () => undefined,
    );
  }

  /** Targeted work runs on its subject's lane beside other subjects. Durable
   * retries for source-triggered work belong to SessionTriggerMonitor. */
  runTarget(
    input: Extract<MemoryScheduledTask, { task: "wiki" }>,
    period: string,
    reason: "idle" | "recording",
    isReady?: () => Promise<boolean>,
  ): Promise<void> {
    return this.enqueue(async () => {
      if (isReady && !(await isReady())) return;
      if (!(await this.#run({ input, period, reason })))
        throw new Error("Targeted Wiki Session update failed");
    }, input.memorySubjectKey);
  }

  async #run(due: DueTask): Promise<boolean> {
    // Each subject depends only on its own share of the dependency: subjects
    // still failing there are held, every other subject proceeds.
    const held =
      due.dependsOn && !this.#completed.has(due.dependsOn)
        ? (this.#heldSubjects(due.dependsOn) ?? [])
        : [];
    if (await this.#deferOnDependency(due, held)) return false;
    const carried = held.filter(
      (subject) => !due.retrySubjects || due.retrySubjects.includes(subject),
    );
    if (due.reason !== "idle" && due.reason !== "recording")
      due.attempts = (due.attempts ?? 0) + 1;
    const wikiRefreshes: MemoryWikiRefresh[] = [];
    const run: MemorySchedulerRun = {
      input: due.input,
      period: due.period,
      reason: due.reason,
      startedAt: new Date().toISOString(),
      ...(due.input.task === "wiki" ? { wikiRefreshes } : {}),
      status: "running",
    };
    const subjectFailures: MemorySubjectFailure[] = [];
    try {
      // Record the intent before side effects; a crash replays only unsettled work.
      await this.#persistCalendar();
      await memoryWikiRefreshLog.run(wikiRefreshes, () =>
        memorySubjectFailureLog.run(subjectFailures, () =>
          this.#runSubjects(due, carried, subjectFailures),
        ),
      );
      if (subjectFailures.length)
        throw new Error("Some AnotherMe subjects require retry");
      attachRunTelemetry(run, subjectFailures);
      run.status = "succeeded";
      await this.#settleSucceeded(due, carried);
      return true;
    } catch (error) {
      attachRunTelemetry(run, subjectFailures);
      run.error = error instanceof Error ? error.message : String(error);
      run.status = "failed";
      await this.#settleFailed(due, error, run.error, carried, subjectFailures);
      return false;
    } finally {
      run.finishedAt = new Date().toISOString();
      writeMemoryLog(
        "memory_schedule_run",
        { ...run },
        memoryScheduleRunLevel(run),
      );
      // Dependents and the next rebuild step become due when a task settles.
      this.wake();
    }
  }

  /**
   * Parks a task whose unsettled dependency holds every subject it would run,
   * or fails it when that dependency is exhausted. Returns whether it parked.
   */
  async #deferOnDependency(
    due: DueTask,
    held: readonly string[],
  ): Promise<boolean> {
    // Waiting on a dependency is not a provider attempt and must not burn retries.
    if (
      !due.dependsOn ||
      this.#completed.has(due.dependsOn) ||
      (held.length &&
        !due.retrySubjects?.every((subject) => held.includes(subject)))
    )
      return false;
    this.#scheduled.delete(taskKey(due));
    if (this.#failed.has(due.dependsOn)) {
      due.terminalReason = `Dependency exhausted: ${due.dependsOn}`;
      this.#failed.set(taskKey(due), due);
      this.#pending.delete(taskKey(due));
      writeMemoryLog(
        "memory_calendar_dependency_exhausted",
        {
          input: due.input,
          period: due.period,
          depends_on: due.dependsOn,
          subjects: due.retrySubjects,
        },
        "ERROR",
      );
    } else this.#pending.set(taskKey(due), due);
    await this.#persistCalendar();
    return true;
  }

  /** Runs the whole task, or each durable retry subject on its own lane. */
  async #runSubjects(
    due: DueTask,
    carried: string[],
    subjectFailures: MemorySubjectFailure[],
  ): Promise<void> {
    const lane: SubjectLane = (subject, work) => this.#inLane(subject, work);
    if (!due.retrySubjects)
      return this.#runTask(
        carried.length &&
          (due.input.task === "daily" || due.input.task === "weekly")
          ? { ...due.input, heldMemorySubjectKeys: carried }
          : due.input,
        due.reason,
        lane,
        due.period,
      );
    // Successful subjects are absent from this durable retry set.
    await Promise.all(
      due.retrySubjects
        .filter((subject) => !carried.includes(subject))
        .map(async (subject) => {
          try {
            await lane(subject, () =>
              this.#runTask(
                { ...due.input, memorySubjectKey: subject },
                due.reason,
                lane,
                due.period,
              ),
            );
          } catch (error) {
            subjectFailures.push({
              memory_subject_key: subject,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }),
    );
  }

  async #settleSucceeded(due: DueTask, carried: string[]): Promise<void> {
    if (carried.length) {
      // Held subjects run once their own dependency share succeeds.
      due.retrySubjects = carried;
      this.#pending.set(taskKey(due), due);
      this.#scheduled.delete(taskKey(due));
      await this.#persistCalendar();
      return;
    }
    if (due.reason !== "idle" && due.reason !== "recording")
      this.#completed.add(taskKey(due));
    this.#pending.delete(taskKey(due));
    await this.#persistCalendar();
  }

  /** Records the failing subjects and schedules the retry or the failure. */
  async #settleFailed(
    due: DueTask,
    error: unknown,
    runError: string,
    carried: readonly string[],
    subjectFailures: readonly MemorySubjectFailure[],
  ): Promise<void> {
    if (subjectFailures.length && !due.input.memorySubjectKey) {
      due.retrySubjects = [
        ...new Set([
          ...subjectFailures.map((f) => f.memory_subject_key),
          ...carried,
        ]),
      ];
    }
    if (
      due.reason !== "idle" &&
      due.reason !== "recording" &&
      !this.#supersededByLaterHourly(due)
    )
      this.#scheduleRetry(due, error, runError, subjectFailures);
    this.#scheduled.delete(taskKey(due));
    this.#completed.delete(taskKey(due));
    try {
      await this.#persistCalendar();
    } catch {
      writeMemoryLog("wiki_calendar_checkpoint_failed", {}, "ERROR");
    }
  }

  /** A failed hourly Wiki run that a later hour of the same date replaces. */
  #supersededByLaterHourly(due: DueTask): boolean {
    const pending = [...this.#pending.values()];
    return (
      due.reason === "hourly" &&
      !due.retrySubjects?.length &&
      due.input.task === "wiki" &&
      !pending.some((task) => task.dependsOn === taskKey(due)) &&
      pending.some(
        (task) =>
          task.reason === "hourly" &&
          task.input.task === "wiki" &&
          due.input.task === "wiki" &&
          task.input.date === due.input.date &&
          task.period > due.period,
      )
    );
  }

  /** Moves a failed task along its backoff, or fails it terminally. */
  #scheduleRetry(
    due: DueTask,
    error: unknown,
    runError: string,
    subjectFailures: readonly MemorySubjectFailure[],
  ): void {
    // A model call that waited for an offline Computer is not an attempt:
    // the task waits for the Computer without moving along its backoff,
    // up to the wait limit.
    const offline =
      isComputerOffline(error) ||
      (subjectFailures.length > 0 &&
        subjectFailures.every((failure) =>
          isComputerOffline(new Error(failure.error)),
        ));
    if (offline) due.offlineSince ??= this.#now;
    else due.offlineSince = undefined;
    const offlineExpired =
      offline &&
      this.#now - due.offlineSince! >= COMPUTER_OFFLINE_WAIT_LIMIT_MS;
    if (offline && !offlineExpired) {
      due.attempts = Math.max(0, (due.attempts ?? 1) - 1);
      due.nextAttemptAt = this.#now + COMPUTER_OFFLINE_RETRY_DELAY_MS;
      this.#pending.set(taskKey(due), due);
    } else if (offlineExpired || (due.attempts ?? 0) >= MAX_CALENDAR_ATTEMPTS) {
      due.terminalReason = runError;
      this.#failed.set(taskKey(due), due);
      this.#pending.delete(taskKey(due));
      writeMemoryLog(
        "memory_calendar_retries_exhausted",
        {
          input: due.input,
          period: due.period,
          attempts: due.attempts,
          subjects: due.retrySubjects,
        },
        "ERROR",
      );
    } else {
      due.nextAttemptAt =
        this.#now +
        CALENDAR_RETRY_DELAYS_MS[Math.max(0, (due.attempts ?? 1) - 1)]!;
      this.#pending.set(taskKey(due), due);
    }
  }
}

function businessPeriod(input: MemoryScheduledTask): string {
  return input.task === "weekly" ? input.weekStart : input.date;
}

const REBUILD_KEY =
  /^(?:(?:wiki|daily|weekly):rebuild:([A-Za-z0-9][A-Za-z0-9_-]{0,63}):\d{4}-\d{2}-\d{2}|(?:init|index-initial|index-final):rebuild:([A-Za-z0-9][A-Za-z0-9_-]{0,63}))$/u;

function rebuildSubject(key: string): string | undefined {
  const match = REBUILD_KEY.exec(key);
  return match?.[1] ?? match?.[2];
}

/** Wiki init -> initial index -> each Session date's Wiki, Daily for a closed
 * date, and Weekly (Monday week start) after the last Session date of a closed
 * week -> final index. Every step depends on the one before it. */
function rebuildChain(
  subject: string,
  dates: readonly string[],
  today: string,
  concurrency: number,
): DueTask[] {
  const tasks: DueTask[] = [];
  const add = (input: MemoryScheduledTask) => {
    const previous = tasks.at(-1);
    tasks.push({
      input,
      period: isRebuildStep(input)
        ? `rebuild:${subject}`
        : `rebuild:${subject}:${businessPeriod(input)}`,
      reason: "rebuild",
      ...(previous ? { dependsOn: taskKey(previous) } : {}),
    });
  };
  const base = { concurrency, memorySubjectKey: subject };
  add({ task: "init", date: today, ...base });
  add({ task: "index-initial", date: today, ...base });
  const monday = (date: string) => {
    const day = new Date(`${date}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
    return day;
  };
  dates.forEach((date, index) => {
    add({ task: "wiki", date, ...base });
    if (date >= today) return;
    add({ task: "daily", date, ...base });
    const start = monday(date);
    const next = dates[index + 1];
    if (next && monday(next).getTime() === start.getTime()) return;
    const sunday = new Date(start);
    sunday.setUTCDate(sunday.getUTCDate() + 6);
    if (sunday.toISOString().slice(0, 10) >= today) return;
    add({
      task: "weekly",
      weekStart: start.toISOString().slice(0, 10),
      ...base,
    });
  });
  add({ task: "index-final", date: today, ...base });
  return tasks;
}

function isDate(value: string): boolean {
  const time = Date.parse(`${value}T00:00:00Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
    Number.isFinite(time) &&
    new Date(time).toISOString().slice(0, 10) === value
  );
}

function dueTasks(
  local: ReturnType<typeof zonedDate>,
  config: MemoryScheduleConfig,
): DueTask[] {
  const date = formatDate(local);
  const closedDate = previousDate(local);
  const hourPeriod = `${date}T${pad(local.hour)}`;
  const tasks: DueTask[] = [
    {
      // The midnight slot closes yesterday; 01:00 resumes today's sessions.
      input: {
        task: "wiki",
        date: local.hour === 0 ? closedDate : date,
        concurrency: config.concurrency,
      },
      period: hourPeriod,
      reason: "hourly",
    },
  ];
  if (local.hour !== 0) return tasks;
  tasks.push({
    input: {
      task: "daily",
      date: closedDate,
      concurrency: config.concurrency,
    },
    period: closedDate,
    reason: "daily",
    dependsOn: `wiki:${hourPeriod}`,
  });
  if (local.weekday === config.weeklyDay) {
    const start = previousWeekStart(local);
    tasks.push({
      input: {
        task: "weekly",
        weekStart: start,
        concurrency: config.concurrency,
      },
      period: start,
      reason: "weekly",
      dependsOn: `daily:${closedDate}`,
    });
  }
  return tasks;
}

function attachRunTelemetry(
  run: MemorySchedulerRun,
  subjectFailures: MemorySubjectFailure[],
): void {
  if (subjectFailures.length > 0) {
    run.subjectFailures = subjectFailures;
  }
}

function taskKey(task: DueTask): string {
  return `${task.input.task}:${task.period}`;
}

function zonedDate(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    timeZone,
    weekday: "short",
    year: "numeric",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(
    parts.find((part) => part.type === "weekday")?.value ?? "",
  );
  if (weekday < 0) throw new Error("Unable to determine weekday");
  return {
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    month: value("month"),
    weekday: weekday + 1,
    year: value("year"),
  };
}

function formatDate(date: {
  day: number;
  month: number;
  year: number;
}): string {
  return `${date.year}-${pad(date.month)}-${pad(date.day)}`;
}

function weekStart(date: ReturnType<typeof zonedDate>): string {
  const utcDate = new Date(Date.UTC(date.year, date.month - 1, date.day));
  utcDate.setUTCDate(utcDate.getUTCDate() - (date.weekday - 1));
  return utcDate.toISOString().slice(0, 10);
}

function previousWeekStart(date: ReturnType<typeof zonedDate>): string {
  const start = new Date(`${weekStart(date)}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 7);
  return start.toISOString().slice(0, 10);
}

function previousDate(date: ReturnType<typeof zonedDate>): string {
  const utcDate = new Date(Date.UTC(date.year, date.month - 1, date.day));
  utcDate.setUTCDate(utcDate.getUTCDate() - 1);
  return utcDate.toISOString().slice(0, 10);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
