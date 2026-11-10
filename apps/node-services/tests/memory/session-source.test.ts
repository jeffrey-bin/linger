import { describe, expect, it } from "vitest";
import {
  sessionPath,
  SESSION_PATH_PATTERN,
} from "../../src/memory/session-source.js";

describe("Session source paths", () => {
  it("keeps Room paths unchanged and isolates every Capture", () => {
    expect(sessionPath("2026-09-15", "room_1")).toBe(
      "evidence/2026-09-15/sessions/room_1.md",
    );
    expect(sessionPath("2026-09-15", "room_1", "capture_1")).toBe(
      "evidence/2026-09-15/sessions/recordings/capture_1.md",
    );
    expect(sessionPath("2026-09-15", "room_2", "capture_1")).toBe(
      sessionPath("2026-09-15", "room_1", "capture_1"),
    );
    expect(
      SESSION_PATH_PATTERN.test(
        sessionPath("2026-09-15", "room_1", "capture_1"),
      ),
    ).toBe(true);
  });
  it("rejects unsafe source identifiers", () => {
    for (const id of ["../escape", "a/b", "", "a".repeat(65)]) {
      expect(() => sessionPath("2026-09-15", "room_1", id)).toThrow();
    }
  });
});
