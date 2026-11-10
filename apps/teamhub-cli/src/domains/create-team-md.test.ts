import { describe, expect, it } from "vitest";
import { createTeamMdSchema } from "./collaboration/tools/create-team-md.js";

const document = `---
collaborate_pattern: fan-out-and-synthesize
---

## Task Goal

Summarize the competitive landscape.

## Orchestrator

- Coordinator
  - ID: actor_1

## Team Member

- Researcher
  - ID: actor_2
  - Report to: Coordinator
`;

describe("TeamHub Collaboration create_team_md", () => {
  it("rejects an empty document, a missing document, and unknown fields", () => {
    for (const input of [
      {},
      { content: "" },
      { content: document, room_id: "room_1" },
      { content: document, inbox_id: "room_1" },
      { content: "x".repeat(65_537) },
    ]) {
      expect(() => createTeamMdSchema.input.parse(input)).toThrow();
    }
  });
});
