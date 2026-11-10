import { describe, expect, it } from "vitest";
import {
  activityStatusLine,
  toolGroupPresentation,
  toolPresentation,
} from "./runtime-tool-presentation";

describe("toolPresentation", () => {
  it.each([
    ["command", "command"],
    ["read", "read"],
    ["file_change", "edit"],
    ["search", "search"],
    ["browse", "browser"],
    ["message", "message"],
    ["message_read", "message_read"],
    ["delegation", "delegation"],
    ["recovery", "recovery"],
    ["tool", "tool"],
    ["unknown_kind", "tool"],
  ])("presents the %s kind as %s", (kind, category) => {
    expect(toolPresentation(kind).category).toBe(category);
  });

  it("does not expose tool input in activity path summaries", () => {
    expect(toolPresentation("read").summary).toBe("Reviewing files");
    expect(toolPresentation("message").summary).toBe("Sending an update");
    expect(toolPresentation("tool").summary).toBe("Working on the task");
  });

  it("summarizes mixed or unknown operations as user-facing steps", () => {
    expect(
      toolGroupPresentation(
        ["read", "command", "search"].map((kind) => toolPresentation(kind)),
      ).label,
    ).toBe("Working through 3 steps");
    expect(
      toolGroupPresentation([
        toolPresentation("tool"),
        toolPresentation("tool"),
      ]).label,
    ).toBe("Working through 2 steps");
    expect(toolGroupPresentation([toolPresentation("search")]).label).toBe(
      "Searching for information",
    );
  });
});

describe("activityStatusLine", () => {
  it("takes the Runtime's description as a group title", () => {
    expect(
      activityStatusLine(
        "command",
        JSON.stringify({
          command: "npm test",
          status_title: "Run the unit tests",
          status_steps: ["Running tests"],
        }),
      ),
    ).toEqual({ steps: [], title: "Run the unit tests" });
  });

  it("plays the steps the Computer read from the call", () => {
    expect(
      activityStatusLine("search", {
        status_steps: ['Searching for "fares"', "", 3, "Reading notes.md"],
      }),
    ).toEqual({ steps: ['Searching for "fares"', "Reading notes.md"] });
  });

  it.each([
    [
      "read",
      { file_path: "/work/docs/travel-préférences.md" },
      ["Reading files"],
    ],
    ["file_change", { paths: ["src/app.tsx"] }, ["Editing files"]],
    ["search", { query: "Tokyo flights Nov 7" }, ["Searching"]],
    ["browse", { url: "https://www.ceair.com/flights" }, ["Browsing the web"]],
    ["message_read", {}, ["Reading messages"]],
    ["recovery", {}, ["Recovering the task"]],
    ["tool", { server: "computer", arguments: {} }, ["Using tools"]],
    ["unknown", "{invalid", ["Using tools"]],
    ["command", { command: "python3 compare_fares.py" }, []],
  ])("names an unnamed %s call by its kind", (kind, input, steps) => {
    expect(
      activityStatusLine(
        kind,
        typeof input === "string" ? input : JSON.stringify(input),
      ),
    ).toEqual({ steps });
  });
});
