// Memory's business days follow the process time zone (set TZ to change it):
// the Daily window, Session dates, meeting folders and the scheduler calendar.

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** `YYYY-MM-DD` of the instant in the process time zone. */
export function localDate(instant: Date | string = new Date()): string {
  const value = new Date(instant);
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

export function assertDateString(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Expected date in YYYY-MM-DD format, got ${value}`);
  }
  return value;
}

export function previousDate(date: string): string {
  assertDateString(date);
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

/** The instants a local date spans: 23 or 25 hours across a DST change. */
export function localDateWindow(date: string): {
  startIso: string;
  endIso: string;
} {
  assertDateString(date);
  const [year, month, day] = date.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  return {
    startIso: new Date(year, month - 1, day).toISOString(),
    endIso: new Date(year, month - 1, day + 1).toISOString(),
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function localMeetingTime(start: Date): string {
  return [start.getHours(), start.getMinutes(), start.getSeconds()]
    .map((value) => pad(value))
    .join("-");
}
