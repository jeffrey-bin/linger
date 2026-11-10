import { describe, expect, it } from "vitest";

import {
  cadenceFromDraft,
  cadenceLabel,
  draftFromRoutine,
  dayHeading,
  emptyRoutineDraft,
  formatWhen,
} from "./routine-cadence";

describe("once Routine cadence", () => {
  it("displays dates in English while using the local time", () => {
    const date = new Date(2026, 10, 1, 9, 0);
    expect(formatWhen(date.toISOString())).toMatch(/Nov 1, 9:00 AM/);
    expect(dayHeading(date, new Date(2026, 9, 28)).day).toBe("Nov 1");
  });

  it("turns the chosen local time into run_at and back", () => {
    const draft = {
      ...emptyRoutineDraft(),
      kind: "once" as const,
      runAt: "2026-10-22T14:30",
    };
    const cadence = cadenceFromDraft(draft);
    expect(cadence.kind).toBe("once");
    expect(cadence.run_at).toBe(new Date("2026-10-22T14:30").toISOString());
    expect(cadenceLabel(cadence)).toMatch(/^Once · /u);
    const routine = {
      name: "check",
      instruction: "look",
      cadence,
      enabled: false,
    } as Parameters<typeof draftFromRoutine>[0];
    expect(draftFromRoutine(routine).runAt).toBe("2026-10-22T14:30");
  });

  it("asks for a time before saving", () => {
    expect(() =>
      cadenceFromDraft({ ...emptyRoutineDraft(), kind: "once", runAt: "" }),
    ).toThrow("Choose when the Routine runs.");
  });
});
