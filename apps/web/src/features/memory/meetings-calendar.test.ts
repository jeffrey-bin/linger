import { describe, expect, it } from "vitest";
import type { TeamHubMemoryEntry } from "@/features/teamhub/teamhub-types";
import {
  calendarMonths,
  meetingLevel,
  meetingsByDate,
} from "./meetings-calendar";

const meeting = (id: string, path: string, summary = false) =>
  ({
    id,
    path,
    meeting: { recording_filename: `${id}.webm`, summary_ready: summary },
  }) as unknown as TeamHubMemoryEntry;

describe("meeting calendar", () => {
  it("groups meetings by their folder date and orders a day by start time", () => {
    const days = meetingsByDate([
      meeting("late", "Meetings/2026/10/01/Meeting 17-41-02", true),
      meeting("early", "Meetings/2026/10/01/Meeting 09-05-00"),
      meeting("other", "Meetings/2026/09/30/Meeting 23-59-59"),
      { id: "not-a-meeting", path: "Memory/notes" } as TeamHubMemoryEntry,
    ]);
    expect([...days.keys()].sort()).toEqual(["2026-09-30", "2026-10-01"]);
    expect(days.get("2026-10-01")!.map((item) => item.id)).toEqual([
      "early",
      "late",
    ]);
    expect(days.get("2026-10-01")![1]).toMatchObject({
      time: "17:41:02",
      recordingFilename: "late.webm",
      summaryReady: true,
    });
  });

  it("lays out twelve LeetCode-style month blocks ending with this month", () => {
    const months = calendarMonths("2026-10-01", new Map([["2026-10-01", 2]]));
    expect(months.map((month) => month.key)).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
      "2026-10",
    ]);
    const october = months.at(-1)!;
    expect(october.label).toBe("Oct");
    // 2026-10-01 is a Thursday: Monday-first leaves three empty slots, and
    // 3 + 31 days fill five week columns.
    expect(october.weeks).toHaveLength(5);
    expect(october.weeks[0]!.slice(0, 3)).toEqual([null, null, null]);
    expect(october.weeks[0]![3]).toEqual({
      date: "2026-10-01",
      count: 2,
      future: false,
    });
    expect(october.weeks[0]![4]!.future).toBe(true);
    expect(october.weeks.flat().filter(Boolean)).toHaveLength(31);
  });

  it("shades busier days darker", () => {
    expect([0, 1, 2, 3, 4, 9].map(meetingLevel)).toEqual([0, 1, 2, 3, 3, 4]);
  });
});
