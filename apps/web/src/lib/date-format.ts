export const APP_LOCALE = "en-US";

export function dateTimeFormat(
  options?: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(APP_LOCALE, options);
}

export function formatDateTime(
  value: Date | string | number,
  options: Intl.DateTimeFormatOptions = {
    dateStyle: "medium",
    timeStyle: "short",
  },
): string {
  return dateTimeFormat(options).format(new Date(value));
}

/** `YYYY-MM-DD` of the instant in the browser's time zone. Memory, Pocket Notes
 * and the Wiki partition days in the server's local zone; on one machine the
 * two are the same. */
export function dayKey(value: Date): string {
  const parts = dateTimeFormat({
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: string) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

const relativeFormatter = new Intl.RelativeTimeFormat(APP_LOCALE, {
  numeric: "auto",
});
const relativeUnits = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
] as const;
const RELATIVE_WINDOW_MS = 7 * 86_400_000;

/**
 * When something last changed, the one way lists and cards say it: "2 hours
 * ago" within a week, then "Nov 7", with the year only when it is not this one.
 */
export function formatUpdatedAt(
  value: Date | string | number,
  now = Date.now(),
): string {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "—";
  const elapsed = Math.max(0, now - time);
  if (elapsed < 60_000) return "just now";
  if (elapsed < RELATIVE_WINDOW_MS) {
    const [unit, size] = relativeUnits.find(([, size]) => elapsed >= size)!;
    return relativeFormatter.format(-Math.floor(elapsed / size), unit);
  }
  const sameYear = new Date(time).getFullYear() === new Date(now).getFullYear();
  return dateTimeFormat({
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(time);
}
