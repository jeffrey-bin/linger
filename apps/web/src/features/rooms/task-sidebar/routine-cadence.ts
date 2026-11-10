import type {
  TeamHubRoutine,
  TeamHubRoutineCadence,
  TeamHubScheduledRoutine,
} from "@/features/teamhub/teamhub-types";

export const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export type CadenceKind = TeamHubRoutineCadence["kind"];

export interface RoutineDraft {
  instruction: string;
  kind: CadenceKind;
  time: string;
  weekdays: (typeof WEEKDAYS)[number][];
  timezone: string;
  intervalHours: number;
  /** Local date-time (YYYY-MM-DDTHH:mm) for a once Routine. */
  runAt: string;
}

export const emptyRoutineDraft = (): RoutineDraft => ({
  instruction: "",
  kind: "daily",
  time: "09:00",
  weekdays: ["monday"],
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  intervalHours: 1,
  runAt: "",
});

export function isScheduled(
  routine: TeamHubRoutine,
): routine is TeamHubScheduledRoutine {
  return routine.cadence !== undefined;
}

export function draftFromRoutine(
  routine: TeamHubScheduledRoutine,
): RoutineDraft {
  const hour = String(routine.cadence.hour ?? 9).padStart(2, "0");
  const minute = String(routine.cadence.minute ?? 0).padStart(2, "0");
  return {
    instruction: routine.instruction,
    kind: routine.cadence.kind,
    time: `${hour}:${minute}`,
    weekdays: routine.cadence.weekdays ?? ["monday"],
    timezone:
      routine.cadence.kind === "every_n_hours"
        ? Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
        : routine.cadence.timezone,
    intervalHours: routine.cadence.interval_hours ?? 1,
    runAt: routine.cadence.run_at ? localDateTime(routine.cadence.run_at) : "",
  };
}

function localDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function cadenceFromDraft(draft: RoutineDraft): TeamHubRoutineCadence {
  const timezone = draft.timezone;
  if (draft.kind === "once") {
    const runAt = new Date(draft.runAt);
    if (!draft.runAt || Number.isNaN(runAt.getTime()))
      throw new Error("Choose when the Routine runs.");
    return { kind: "once", timezone, run_at: runAt.toISOString() };
  }
  if (draft.kind === "every_n_hours") {
    return {
      kind: "every_n_hours",
      timezone,
      interval_hours: draft.intervalHours,
    };
  }
  const [hourRaw, minuteRaw] = draft.time.split(":");
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (draft.kind === "weekly") {
    if (draft.weekdays.length === 0)
      throw new Error("Choose at least one weekday.");
    return {
      kind: "weekly",
      timezone,
      hour,
      minute,
      weekdays: WEEKDAYS.filter((day) => draft.weekdays.includes(day)),
    };
  }
  return { kind: "daily", timezone, hour, minute };
}

export function cadenceLabel(cadence: TeamHubRoutineCadence) {
  if (cadence.kind === "every_n_hours") return repeatLabel(cadence);
  return `${repeatLabel(cadence)} · ${cadenceClock(cadence)}`;
}

/** How often a Routine runs, without its time of day. */
function repeatLabel(cadence: TeamHubRoutineCadence) {
  if (cadence.kind === "every_n_hours") {
    const hours = cadence.interval_hours ?? 1;
    return hours === 1 ? "Every hour" : `Every ${hours} hours`;
  }
  if (cadence.kind === "once") return "Once";
  if (cadence.kind === "daily") return "Daily";
  const days = cadence.weekdays ?? [];
  const ordered = WEEKDAYS.filter((day) => days.includes(day));
  if (ordered.length === 7) return "Every day";
  if (ordered.join(",") === WEEKDAYS.slice(0, 5).join(",")) return "Mon–Fri";
  return (
    ordered
      .map(
        (day) =>
          day[0]!.toUpperCase() +
          day.slice(1, ordered.length === 1 ? undefined : 3),
      )
      .join(", ") || "Weekly"
  );
}

/** When in the day a Routine runs; a once Routine also names its date. */
function cadenceClock(cadence: TeamHubRoutineCadence) {
  if (cadence.kind === "every_n_hours")
    return `${cadence.interval_hours ?? 1}h`;
  if (cadence.kind === "once") {
    return cadence.run_at ? formatWhen(cadence.run_at) : "";
  }
  return formatClock(cadence.hour ?? 0, cadence.minute ?? 0);
}

const nextRunFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const clockFormat = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
});

const dayFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

export function formatTimeOfDay(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : clockFormat.format(date);
}

/** "Today", "Tomorrow", or the date, plus how many days away it is. */
export function dayHeading(date: Date, now = new Date()) {
  const startOf = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOf(date) - startOf(now)) / 86_400_000);
  if (days <= 0) return { day: "Today", distance: "" };
  if (days === 1) return { day: "Tomorrow", distance: "" };
  return { day: dayFormat.format(date), distance: `in ${days} days` };
}

export function formatWhen(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return nextRunFormat.format(date);
}

function formatClock(hour: number, minute: number) {
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  return clockFormat.format(date);
}
