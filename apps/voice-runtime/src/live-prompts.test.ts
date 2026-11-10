import { describe, expect, it } from "vitest";

import { updateCue } from "./live-prompts.js";

describe("updateCue", () => {
  it("gives a failure's own reason, and says when there is none", () => {
    const base = { taskId: "t1", goal: "Organize the lease agreement" };
    const failed = updateCue(
      [
        {
          ...base,
          kind: "failed",
          replies: [
            "Could not find the lease agreement file the user mentioned",
          ],
        },
      ],
      { kind: "idle" },
    );
    expect(failed).toContain(
      "Could not find the lease agreement file the user mentioned",
    );
    expect(failed).toContain("do not guess another reason");
    expect(
      updateCue([{ ...base, kind: "failed" }], { kind: "idle" }),
    ).toContain("It gave no reason.");
  });

  it("leads with the user's latest words so the reply keeps their language", () => {
    const cue = updateCue(
      [{ taskId: "t1", goal: "Q3 budget", kind: "report" }],
      { kind: "after" },
      "Take a look at the budget for me",
    );
    expect(cue.split("\n")[0]).toBe(
      `Answer in the language of the user's latest words in this call: "Take a look at the budget for me"`,
    );
    expect(
      updateCue([{ taskId: "t1", goal: "", kind: "alert" }], { kind: "idle" }),
    ).not.toContain("latest words in this call");
  });
});
