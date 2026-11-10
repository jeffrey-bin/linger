import { describe, expect, it } from "vitest";

import { renderAgentMemoryNote } from "../../../../src/agent/agent-features/agent-memory/prompts.js";
import {
  assembleExecutionContextDeveloperInstructions,
  type ExecutionContextDeveloperInstructionsInput,
} from "../../../../src/agent/agent-features/context-instructions/index.js";

const common = {
  agentName: "Research Partner",
  agentActorId: "actor:agent-1",
  agentType: "anotherme",
  canSendDirectMessage: true,
  developerInstructions: undefined,
  sponsor: { actorId: "actor:sponsor", displayName: "Test Sponsor" },
  connectedApps: true,
  compactInstructions: false,
} as const;

const contexts: readonly (readonly [
  string,
  ExecutionContextDeveloperInstructionsInput,
])[] = [
  [
    "Meta",
    { ...common, contextKind: "meta", roomId: "room-1", roomKind: "direct" },
  ],
  ["AlterEgo", { ...common, contextKind: "alter_ego", taskId: "task-1" }],
];

// The memory note reaches the conversation beside the personal knowledge
// policy in the developer instructions, so it must not forbid or replace
// knowledge search.
describe("Agent memory beside the personal knowledge policy", () => {
  it.each(contexts)(
    "keeps one retrieval rule in the %s instructions",
    (_, context) => {
      const base = assembleExecutionContextDeveloperInstructions(context);
      const published = renderAgentMemoryNote("Orchard index");

      for (const memory of [undefined, published]) {
        const prompt = [base, memory].filter(Boolean).join("\n\n");
        expect(prompt).toContain("<personal-knowledge-policy>");
        expect(prompt).not.toMatch(/personal\/global memory/u);
        expect(prompt).not.toMatch(/say that you do not have it/u);
        expect(prompt).not.toMatch(/acknowledge it/u);
      }
      expect(published).toContain("teamhub knowledge");
      expect(published).toContain(
        "Do not write these files or keep a separate memory of your own.",
      );
      expect(published).toContain(
        "let the Human's stated preferences decide choices, plans and style",
      );
    },
  );
});
