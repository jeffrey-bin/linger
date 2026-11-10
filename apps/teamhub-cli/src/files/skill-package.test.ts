import { describe, expect, it } from "vitest";

import { computeSkillPackageSha256 } from "./skill-package.js";

describe("Skill package digest", () => {
  it("computes the package digest shared with TeamHub and the Daemon", () => {
    expect(
      computeSkillPackageSha256([
        {
          path: "SKILL.md",
          content: Buffer.from(
            "---\nname: sample-skill\ndescription: A sample local Skill\n---\n\n# Sample\n",
          ),
        },
        {
          path: "scripts/run.sh",
          content: Buffer.from("#!/bin/sh\nexit 0\n"),
        },
      ]),
    ).toBe("d37a492e077c9dbea7ad7de7de46bcf668b12ec8678dc6a569afbc7901d241b0");
  });
});
