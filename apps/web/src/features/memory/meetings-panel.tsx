import {
  ArrowDown01Icon,
  Delete02Icon,
  File01Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";

import {
  calendarMonths,
  formatMeetingDay,
  formatMeetingWhen,
  meetingLevel,
  meetingsByDate,
  monthLabels,
} from "./meetings-calendar";
import { Spinner } from "@/components/ui/spinner";
import { dayKey } from "@/lib/date-format";
import { meetingPath, useMeetings } from "./memory-queries";
import { HideMeetingDialog } from "./hide-meeting-dialog";

const levelClass = [
  "bg-[#f1f0ec]",
  "bg-[#dedcd1]",
  "bg-[#b5b3a5]",
  "bg-[#7d7b6e]",
  "bg-app-ink",
] as const;
const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const recentDayCount = 7;

/** Which meetings the panel shows; `?meetings=` keeps the choice in the URL. */
export type MeetingsRange = "all" | "today" | "week";
const meetingRanges: ReadonlyArray<{ id: MeetingsRange; label: string }> = [
  { id: "today", label: "Today" },
  { id: "week", label: "Past 7 days" },
  { id: "all", label: "All meetings" },
];
const rangeParam: Record<MeetingsRange, string> = {
  all: "all",
  today: "today",
  week: "7d",
};

export function meetingsRangeFromSearch(
  searchParams: URLSearchParams,
): MeetingsRange {
  const value = searchParams.get("meetings");
  return value === "all" ? "all" : value === "today" ? "today" : "week";
}

/** The Workspace Meetings tab, with the range the URL names. */
export function meetingsTabPath(tenantId: string, range: MeetingsRange) {
  return `/t/${encodeURIComponent(tenantId)}/library?tab=meetings&meetings=${rangeParam[range]}`;
}

/** "2026-10-05" shifted by -6 days -> "2026-09-29". */
function shiftDate(date: string, days: number) {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/**
 * The Workspace Meetings tab. Today, Past 7 days, and All meetings choose the
 * range: the past seven days show one gray square per day, All meetings a
 * LeetCode-style year. Choosing a day scrolls the list to it; search narrows
 * the list by file name, date, or time.
 */
export function MeetingsPanel({ tenantId }: { tenantId: string }) {
  const meetings = useMeetings(tenantId);
  const byDate = useMemo(
    () => meetingsByDate(meetings.data ?? []),
    [meetings.data],
  );
  const today = dayKey(new Date());
  const months = useMemo(
    () =>
      calendarMonths(
        today,
        new Map([...byDate].map(([date, items]) => [date, items.length])),
      ),
    [byDate, today],
  );
  const latest = [...byDate.keys()].sort().at(-1);
  const [searchParams, setSearchParams] = useSearchParams();
  const range = meetingsRangeFromSearch(searchParams);
  const recentOnly = range === "week";
  const rangeFrom =
    range === "all"
      ? ""
      : range === "today"
        ? today
        : shiftDate(today, -(recentDayCount - 1));
  const rangeLabel = meetingRanges.find(
    (candidate) => candidate.id === range,
  )!.label;
  const [chosen, setChosen] = useState<string>();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [tip, setTip] = useState<{ text: string; x: number; y: number }>();
  const [deleting, setDeleting] = useState<{
    captureId: string;
    name: string;
  }>();
  const recentDays = Array.from({ length: recentDayCount }, (_, index) => {
    const date = shiftDate(today, index - (recentDayCount - 1));
    const [, month, day] = date.split("-");
    return {
      date,
      count: byDate.get(date)?.length ?? 0,
      weekday: weekdayLabels[new Date(`${date}T00:00:00Z`).getUTCDay()]!,
      label: `${monthLabels[Number(month) - 1]} ${Number(day)}`,
    };
  });
  const selected = chosen ?? (byDate.has(today) ? today : (latest ?? today));
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const days = [...byDate.entries()]
    .filter(([date]) => date >= rangeFrom && date <= today)
    .sort(([left], [right]) => right.localeCompare(left))
    .map(([date, items]) => ({
      date,
      items: needle
        ? items.filter((item) =>
            `meeting ${item.recordingFilename} ${date} ${item.time} ${formatMeetingDay(date)}`
              .toLowerCase()
              .includes(needle),
          )
        : items,
    }))
    .filter((day) => day.items.length > 0);
  const dayRefs = useRef(new Map<string, HTMLElement>());
  // A day chosen on the calendar brings its meetings into view.
  useEffect(() => {
    if (chosen)
      dayRefs.current.get(chosen)?.scrollIntoView?.({ block: "nearest" });
  }, [chosen]);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Open on the current month at the right edge.
  useLayoutEffect(() => {
    const grid = scrollRef.current;
    if (grid) grid.scrollLeft = grid.scrollWidth;
  }, [meetings.data]);

  function showTip(cell: Element, day: { date: string; count: number }) {
    const box = cell.getBoundingClientRect();
    setTip({
      text: `${formatMeetingDay(day.date)} · ${day.count} ${day.count === 1 ? "meeting" : "meetings"}`,
      x: box.left + box.width / 2,
      y: box.top,
    });
  }

  function chooseRange(next: MeetingsRange) {
    setChosen(undefined);
    setCollapsed(new Set());
    setSearchParams(
      (current) => {
        const params = new URLSearchParams(current);
        params.set("meetings", rangeParam[next]);
        return params;
      },
      { replace: true },
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div
        aria-label="Meeting range"
        className="inline-flex w-fit gap-0.5 rounded-lg bg-muted p-0.5"
        role="radiogroup"
      >
        {meetingRanges.map((candidate) => (
          <button
            aria-checked={candidate.id === range}
            className={`h-7 rounded-md px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none ${
              candidate.id === range
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
            key={candidate.id}
            onClick={() => chooseRange(candidate.id)}
            role="radio"
            type="button"
          >
            {candidate.label}
          </button>
        ))}
      </div>
      <div>
        {meetings.isPending ? (
          <p className="flex items-center gap-2 text-sm text-app-muted">
            <Spinner size={15} />
            Loading meetings…
          </p>
        ) : meetings.isError ? (
          <p role="alert" className="text-sm text-app-danger">
            Meetings could not be loaded.{" "}
            <button type="button" onClick={() => void meetings.refetch()}>
              Retry
            </button>
          </p>
        ) : (
          <div className="flex w-full flex-col gap-4">
            {range === "today" ? null : (
              <section
                aria-label="Meeting calendar"
                className="rounded-xl border border-border bg-card p-4 md:p-5"
              >
                {recentOnly ? (
                  // The past seven days as the same gray squares, one per day,
                  // large enough to carry their weekday, date, and count.
                  <div className="mx-auto grid max-w-2xl grid-cols-7 gap-2 text-[12px] text-app-muted sm:gap-3">
                    {recentDays.map((day) => {
                      const level = meetingLevel(day.count);
                      return (
                        <div
                          className="flex min-w-0 flex-col items-center gap-1.5"
                          key={day.date}
                        >
                          <button
                            aria-label={`${day.date}: ${day.count} ${day.count === 1 ? "meeting" : "meetings"}`}
                            aria-pressed={day.date === selected}
                            className={`meeting-calendar-cell flex aspect-square w-full items-center justify-center rounded-lg text-[15px] font-semibold tabular-nums transition-colors hover:outline hover:outline-1 hover:outline-app-ink/40 ${levelClass[level]} ${level >= 3 ? "text-app-surface" : "text-app-ink"} ${day.date === today ? "meeting-today" : ""} ${day.date === selected ? "ring-2 ring-app-ink ring-offset-2 ring-offset-app-surface" : ""}`}
                            onClick={() => {
                              setChosen(day.date);
                              setCollapsed((current) => {
                                const next = new Set(current);
                                next.delete(day.date);
                                return next;
                              });
                            }}
                            title={`${day.date} · ${day.count} ${day.count === 1 ? "meeting" : "meetings"}`}
                            type="button"
                          >
                            {day.count || ""}
                          </button>
                          <span className="text-center leading-4">
                            <span className="block font-medium text-app-ink">
                              {day.date === today ? "Today" : day.weekday}
                            </span>
                            {day.label}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <>
                    {/* Squares scale with the card; narrow screens scroll instead
                    of shrinking them below a readable size. */}
                    <div
                      ref={scrollRef}
                      className="workspace-scrollbar overflow-x-auto pb-1"
                    >
                      <div className="flex min-w-[860px] items-start gap-3 text-[12px] text-app-muted">
                        {months.map((month) => (
                          <div
                            key={month.key}
                            className="flex min-w-0 flex-col items-center gap-1.5"
                            style={{ flex: `${month.weeks.length} 1 0` }}
                          >
                            <div
                              className="grid w-full gap-[3px]"
                              style={{
                                gridAutoFlow: "column",
                                gridTemplateColumns: `repeat(${month.weeks.length}, minmax(0, 1fr))`,
                                gridTemplateRows: "repeat(7, auto)",
                              }}
                            >
                              {month.weeks.flatMap((week, index) =>
                                week.map((day, weekday) =>
                                  !day || day.future ? (
                                    <span
                                      key={day?.date ?? `${index}:${weekday}`}
                                      className="aspect-square w-full"
                                    />
                                  ) : (
                                    <button
                                      key={day.date}
                                      aria-label={`${day.date}: ${day.count} ${day.count === 1 ? "meeting" : "meetings"}`}
                                      aria-pressed={day.date === selected}
                                      className={`meeting-heatmap-cell aspect-square w-full rounded-[4px] ${levelClass[meetingLevel(day.count)]} ${day.date === today ? "meeting-today" : ""} ${day.date === selected ? "ring-2 ring-app-ink ring-offset-1 ring-offset-app-surface" : ""}`}
                                      onClick={() => {
                                        setChosen(day.date);
                                        setCollapsed((current) => {
                                          const next = new Set(current);
                                          next.delete(day.date);
                                          return next;
                                        });
                                      }}
                                      onBlur={() => setTip(undefined)}
                                      onFocus={(event) =>
                                        showTip(event.currentTarget, day)
                                      }
                                      onMouseEnter={(event) =>
                                        showTip(event.currentTarget, day)
                                      }
                                      onMouseLeave={() => setTip(undefined)}
                                      type="button"
                                    />
                                  ),
                                ),
                              )}
                            </div>
                            <span className="leading-3">{month.label}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
                {tip ? (
                  <span
                    aria-hidden="true"
                    className="meeting-tip"
                    style={{ left: tip.x, top: tip.y }}
                  >
                    {tip.text}
                  </span>
                ) : null}
              </section>
            )}
            <section aria-label={rangeLabel} className="meeting-events">
              <div className="flex flex-wrap items-center gap-3 py-3">
                <label className="flex h-9 w-full items-center gap-2 rounded-lg border border-border bg-card px-3 text-muted-foreground transition-colors hover:border-border-hover focus-within:border-foreground focus-within:ring-2 focus-within:ring-ring/40 sm:w-64">
                  <Icon icon={Search01Icon} size={16} />
                  <input
                    aria-label="Search meetings"
                    className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search by date or time"
                    type="search"
                    value={query}
                  />
                </label>
              </div>
              {chosen && !byDate.has(chosen) && !needle ? (
                <p className="border-b border-app-border px-4 py-2.5 text-sm text-app-muted md:px-5">
                  No meetings on {formatMeetingDay(chosen)}.
                </p>
              ) : null}
              {days.length ? (
                <div>
                  {days.map((day) => (
                    <section
                      aria-label={`Meetings on ${day.date}`}
                      className="meeting-date-group"
                      key={day.date}
                      ref={(node) => {
                        if (node) dayRefs.current.set(day.date, node);
                        else dayRefs.current.delete(day.date);
                      }}
                    >
                      <h3>
                        <button
                          aria-expanded={!collapsed.has(day.date)}
                          className="meeting-date-toggle"
                          onClick={() =>
                            setCollapsed((current) => {
                              const next = new Set(current);
                              if (next.has(day.date)) next.delete(day.date);
                              else next.add(day.date);
                              return next;
                            })
                          }
                          type="button"
                        >
                          {formatMeetingDay(day.date)}
                          {day.date === today ? " · Today" : ""}
                          <Icon
                            icon={ArrowDown01Icon}
                            size={14}
                            className={
                              collapsed.has(day.date) ? "-rotate-90" : ""
                            }
                          />
                        </button>
                      </h3>
                      <ul className="pb-2" hidden={collapsed.has(day.date)}>
                        {day.items.map((meeting) => {
                          const to = meetingPath(tenantId, meeting.id);
                          const name = `Meeting ${formatMeetingWhen(meeting.date, meeting.time)}`;
                          return (
                            <li
                              className="group flex items-center gap-3 transition-colors duration-300 hover:bg-muted/70"
                              key={meeting.id}
                            >
                              <Link
                                className="min-w-0 flex-1 truncate py-2 text-sm text-app-ink"
                                to={to}
                              >
                                Meeting{" "}
                                {formatMeetingWhen(meeting.date, meeting.time)}
                              </Link>
                              {meeting.summaryReady ? (
                                // The meeting entry opens on its summary.
                                <Link
                                  aria-label={`Summary of Meeting ${formatMeetingWhen(meeting.date, meeting.time)}`}
                                  className="inline-flex shrink-0 items-center gap-1 rounded text-xs text-app-muted hover:text-app-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-focus"
                                  to={to}
                                >
                                  <Icon icon={File01Icon} size={12} />
                                  Summary
                                </Link>
                              ) : null}
                              <button
                                aria-label={`Delete ${name}`}
                                className="flex size-6 shrink-0 items-center justify-center rounded text-app-muted opacity-0 transition-opacity hover:text-app-danger focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-focus group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                                onClick={() =>
                                  setDeleting({
                                    captureId: meeting.captureId,
                                    name,
                                  })
                                }
                                title="Delete meeting"
                                type="button"
                              >
                                <Icon icon={Delete02Icon} size={14} />
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  ))}
                </div>
              ) : (
                <p className="px-4 py-3 text-sm text-app-muted md:px-5">
                  {needle
                    ? `No meetings match “${query.trim()}”.`
                    : range === "today"
                      ? "No meetings today."
                      : recentOnly
                        ? "No meetings in the past 7 days."
                        : "No meetings yet."}
                </p>
              )}
            </section>
          </div>
        )}
      </div>
      {deleting ? (
        <HideMeetingDialog
          captureId={deleting.captureId}
          name={deleting.name}
          onClose={() => setDeleting(undefined)}
          tenantId={tenantId}
        />
      ) : null}
    </div>
  );
}
