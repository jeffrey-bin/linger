import { renderProactiveEventDecideInstructions } from "./prompt.js";

interface OpenItem {
  readonly content: string;
  readonly dueAt?: string;
}

/** Open items with their due time on the Human's clock, as AnotherMe reads them. */
export function promptOpenItems(
  openItems: readonly {
    readonly content: string;
    readonly due_at?: string | null;
  }[],
  now: Date,
): { content: string; due?: string }[] {
  return openItems.map(({ content, due_at }) =>
    due_at
      ? {
          content,
          due: `${localTime(new Date(due_at))}, ${timeUntil(new Date(due_at), now)}`,
        }
      : { content },
  );
}

/** What AnotherMe gets to judge an outside event itself. */
export function eventDecideInstructions(
  input: {
    readonly specific: readonly string[];
    readonly openItems: readonly OpenItem[];
  },
  now: Date,
): string {
  return renderProactiveEventDecideInstructions(
    input.specific,
    promptOpenItems(
      input.openItems.map(({ content, dueAt }) => ({
        content,
        ...(dueAt ? { due_at: dueAt } : {}),
      })),
      now,
    ),
  );
}

/**
 * ISO 8601 local time with its offset (`2026-11-03T14:30+08:00`) on the
 * process clock, so AnotherMe reads one language-neutral form.
 */
const localTime = (time: Date): string => {
  const pad = (value: number) => String(Math.abs(value)).padStart(2, "0");
  const offset = -time.getTimezoneOffset();
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}T${pad(time.getHours())}:${pad(time.getMinutes())}${offset < 0 ? "-" : "+"}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
};

/** How far away a time is, so AnotherMe weighs closeness without doing date math. */
export const timeUntil = (time: Date, now: Date): string => {
  const minutes = Math.round((time.getTime() - now.getTime()) / 60_000);
  if (minutes < 0) return "already passed";
  if (minutes < 60) return `in ${minutes} minutes`;
  if (minutes < 48 * 60) return `in ${Math.round(minutes / 60)} hours`;
  return `in ${Math.round(minutes / 1440)} days`;
};
