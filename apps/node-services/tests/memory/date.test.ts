import { afterEach, describe, expect, it, vi } from "vitest";

import {
  localDate,
  localDateWindow,
  localTimeZone,
} from "../../src/memory/date.js";

describe("Memory business days", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("puts the Daily window on the process zone's midnights, DST included", () => {
    vi.stubEnv("TZ", "America/New_York");
    expect(localTimeZone()).toBe("America/New_York");
    expect(localDateWindow("2026-09-15")).toEqual({
      startIso: "2026-09-15T04:00:00.000Z",
      endIso: "2026-09-16T04:00:00.000Z",
    });
    // The day daylight saving time ends lasts 25 hours, the day it starts 23.
    expect(localDateWindow("2026-11-01")).toEqual({
      startIso: "2026-11-01T04:00:00.000Z",
      endIso: "2026-11-02T05:00:00.000Z",
    });
    expect(localDateWindow("2026-03-08")).toEqual({
      startIso: "2026-03-08T05:00:00.000Z",
      endIso: "2026-03-09T04:00:00.000Z",
    });
  });

  it("dates an instant by the process zone", () => {
    vi.stubEnv("TZ", "America/New_York");
    expect(localDate(new Date("2026-09-16T03:59:59Z"))).toBe("2026-09-15");
    expect(localDate("2026-09-16T04:00:00Z")).toBe("2026-09-16");
    vi.stubEnv("TZ", "Asia/Shanghai");
    expect(localDate("2026-09-15T16:00:00Z")).toBe("2026-09-16");
  });
});
