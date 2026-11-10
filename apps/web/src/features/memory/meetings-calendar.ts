import type { TeamHubMemoryEntry } from "@/features/teamhub/teamhub-types";

export interface CalendarMeeting {
  id: string;
  captureId: string;
  date: string;
  time: string;
  recordingFilename: string;
  summaryReady: boolean;
}

export interface CalendarDay {
  date: string;
  count: number;
  future: boolean;
}

/** One month block: Monday-first week columns; days outside the month are null. */
export interface CalendarMonth {
  key: string;
  label: string;
  weeks: (CalendarDay | null)[][];
}

const monthsShown = 12;
export const monthLabels = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
// Meeting folders are named in the server's local time; the calendar uses the
// same dates so a meeting sits on the same day in both places.
const meetingPath =
  /^Meetings\/(\d{4})\/(\d{2})\/(\d{2})\/Meeting (\d{2})-(\d{2})-(\d{2})/u;

/** The date and start time a meeting's folder path names. */
export function meetingWhen(
  path: string,
): { date: string; time: string } | undefined {
  const match = meetingPath.exec(path);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second] = match;
  return {
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}:${second}`,
  };
}

/** Meetings by folder date, each day sorted by start time. */
export function meetingsByDate(
  entries: readonly TeamHubMemoryEntry[],
): Map<string, CalendarMeeting[]> {
  const days = new Map<string, CalendarMeeting[]>();
  for (const entry of entries) {
    const match = meetingPath.exec(entry.path);
    if (!entry.meeting || !match) continue;
    const [, year, month, day, hour, minute, second] = match;
    const date = `${year}-${month}-${day}`;
    const meetings = days.get(date) ?? [];
    meetings.push({
      id: entry.id,
      captureId: entry.meeting.capture_id,
      date,
      time: `${hour}:${minute}:${second}`,
      recordingFilename: entry.meeting.recording_filename,
      summaryReady: entry.meeting.summary_ready,
    });
    days.set(date, meetings);
  }
  for (const meetings of days.values())
    meetings.sort((a, b) => a.time.localeCompare(b.time));
  return days;
}

/** LeetCode-style month blocks for the last year, ending with this month. */
export function calendarMonths(
  today: string,
  counts: ReadonlyMap<string, number>,
): CalendarMonth[] {
  const [year, month] = today.split("-").map(Number) as [number, number];
  const months: CalendarMonth[] = [];
  for (let back = monthsShown - 1; back >= 0; back--) {
    const first = new Date(Date.UTC(year, month - 1 - back, 1));
    const days = new Date(
      Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
    ).getUTCDate();
    const lead = (first.getUTCDay() + 6) % 7;
    const weeks: (CalendarDay | null)[][] = [];
    for (let slot = 0; slot < lead + days; slot++) {
      if (slot % 7 === 0) weeks.push(Array<CalendarDay | null>(7).fill(null));
      if (slot < lead) continue;
      const day = new Date(first);
      day.setUTCDate(slot - lead + 1);
      const date = day.toISOString().slice(0, 10);
      weeks.at(-1)![slot % 7] = {
        date,
        count: counts.get(date) ?? 0,
        future: date > today,
      };
    }
    months.push({
      key: first.toISOString().slice(0, 7),
      label: monthLabels[first.getUTCMonth()]!,
      weeks,
    });
  }
  return months;
}

/** 0 (none) to 4 (busiest) shades of gray. */
export function meetingLevel(count: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count === 2) return 2;
  if (count <= 4) return 3;
  return 4;
}

/** "2026-10-01", "09:05:00" -> "Oct 1, 09:05". */
export function formatMeetingWhen(date: string, time: string) {
  const [, month, day] = date.split("-");
  return `${monthLabels[Number(month) - 1]} ${Number(day)}, ${time.slice(0, 5)}`;
}

/** "2026-10-01" -> "Thu, Oct 1"; the date is already a local day. */
export function formatMeetingDay(date: string) {
  const [, month, day] = date.split("-");
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weekday]}, ${monthLabels[Number(month) - 1]} ${Number(day)}`;
}
