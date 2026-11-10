import { describe, expect, it } from "vitest";
import {
  APP_LOCALE,
  dateTimeFormat,
  dayKey,
  formatDateTime,
  formatUpdatedAt,
} from "./date-format";

describe("date-format", () => {
  it("keys days at local midnight", () => {
    expect(dayKey(new Date(2026, 9, 20, 23, 59, 59))).toBe("2026-10-20");
    expect(dayKey(new Date(2026, 9, 21))).toBe("2026-10-21");
  });

  it("formats string input with the default medium date and short time", () => {
    expect(
      formatDateTime("2026-10-21T08:05:00Z", {
        dateStyle: "medium",
        timeZone: "UTC",
      }),
    ).toBe("Oct 21, 2026");
    expect(formatDateTime("2026-10-21T08:05:00Z")).toMatch(/Oct 21, 2026/);
  });

  it("resolves to the app locale", () => {
    expect(APP_LOCALE).toBe("en-US");
    expect(dateTimeFormat().resolvedOptions().locale).toBe("en-US");
  });

  it("says when something changed: relative within a week, then a date", () => {
    const now = new Date(2026, 10, 7, 12).getTime();
    expect(formatUpdatedAt(now - 30_000, now)).toBe("just now");
    expect(formatUpdatedAt(now - 2 * 3_600_000, now)).toBe("2 hours ago");
    expect(formatUpdatedAt(now - 86_400_000, now)).toBe("yesterday");
    expect(formatUpdatedAt(new Date(2026, 9, 21, 9), now)).toBe("Oct 21");
    expect(formatUpdatedAt(new Date(2025, 9, 21, 9), now)).toBe("Oct 21, 2025");
    expect(formatUpdatedAt("not a date", now)).toBe("—");
  });
});
