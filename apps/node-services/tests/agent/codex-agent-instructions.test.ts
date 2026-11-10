import { describe, expect, it } from "vitest";
import { codexAgentInstructions } from "../../src/agent/codex-agent-instructions.js";

describe("Codex product instruction contract", () => {
  it("replaces native base behavior with the complete product instruction block", () => {
    const result = codexAgentInstructions({
      baseInstructions: "You are the assigned engineer.",
      developerInstructions: "Wait for approval before creating a Task.",
    });
    expect(result.developerInstructions).toBeUndefined();
    expect(result.baseInstructions).toContain("You are the assigned engineer.");
    expect(result.baseInstructions).toContain(
      "Wait for approval before creating a Task.",
    );
    expect(result.baseInstructions).toContain(
      "Continue after reporting progress",
    );
    expect(result.baseInstructions).toContain("AGENTS.md/AGENTS.override.md");
    expect(result.baseInstructions).toContain(
      "do not bypass them or duplicate a submitted operation",
    );
    expect(result.baseInstructions).toContain(
      "normal Runtime turn ending alone does not establish goal completion",
    );
  });
});
