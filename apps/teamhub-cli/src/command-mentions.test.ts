import { describe, expect, it } from "vitest";
import { parseActorReferences } from "./command-mentions.js";

describe("ordinary body Actor references", () => {
  it("preserves raw Markdown, Unicode and mention order", () => {
    expect(
      parseActorReferences(
        "**Review** café [@Alice](user:actor_alice) and [@Researcher](agent:actor_researcher).\n",
      ),
    ).toEqual([
      { type: "text", content: "**Review** café " },
      {
        type: "reference",
        target: "actor_alice",
        target_type: "user",
        content: "Alice",
      },
      { type: "text", content: " and " },
      {
        type: "reference",
        target: "actor_researcher",
        target_type: "agent",
        content: "Researcher",
      },
      { type: "text", content: ".\n" },
    ]);
  });
  it("drops whitespace-only text around and between mentions", () => {
    expect(
      parseActorReferences(
        "Please see [@Alice](user:actor_alice) [@Bob](agent:actor_bob)\n",
      ),
    ).toEqual([
      { type: "text", content: "Please see " },
      {
        type: "reference",
        target: "actor_alice",
        target_type: "user",
        content: "Alice",
      },
      {
        type: "reference",
        target: "actor_bob",
        target_type: "agent",
        content: "Bob",
      },
    ]);
    expect(parseActorReferences("  \n")).toEqual([
      { type: "text", content: "  \n" },
    ]);
  });
  it("uses the distinct comment reference contract", () => {
    expect(
      parseActorReferences("[@Alice](user:actor_alice)", "comment"),
    ).toEqual([
      { type: "reference", actor_id: "actor_alice", content: "Alice" },
    ]);
  });
  it.each([
    "`[@Alice](user:actor_alice)`",
    "```md\n[@Alice](user:actor_alice)\n```",
    "    [@Alice](user:actor_alice)\n",
    "\\[@Alice](user:actor_alice)",
    "[website](https://example.com)",
    "@Alice",
  ])(
    "does not turn code, escapes or ordinary links into a reference: %s",
    (content) => {
      expect(parseActorReferences(content)).toEqual([
        { type: "text", content },
      ]);
    },
  );
  it.each([
    "[@Alice](user:)",
    "[@Alice](agent:bad/id)",
    "[@Alice](user:actor bad)",
  ])("rejects invalid explicit Actor identity: %s", (content) => {
    expect(() => parseActorReferences(content)).toThrow(/reference|Actor/i);
  });
});
