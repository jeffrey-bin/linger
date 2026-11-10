import { describe, expect, it } from "vitest";
import { createModelCallResults } from "../src/model-call-results.js";

const answer = (text: string) => ({ model: "codex", output: text });

describe("model call results", () => {
  it("keeps an answer until it expires", () => {
    let time = 0;
    const results = createModelCallResults({ now: () => time });
    results.put("a", answer("kept"), 1_000);
    time = 999;
    expect(results.get("a")).toEqual(answer("kept"));
    time = 1_000;
    expect(results.get("a")).toBeUndefined();
  });

  it("drops the oldest answers beyond its byte budget", () => {
    const size = JSON.stringify(answer("x".repeat(10))).length * 2;
    const results = createModelCallResults({ maxBytes: size * 2 });
    results.put("a", answer("a".repeat(10)), 60_000);
    results.put("b", answer("b".repeat(10)), 60_000);
    results.put("c", answer("c".repeat(10)), 60_000);
    results.put("huge", answer("h".repeat(100)), 60_000);
    expect(results.get("a")).toBeUndefined();
    expect(results.get("b")).toBeDefined();
    expect(results.get("c")).toBeDefined();
    expect(results.get("huge")).toBeUndefined();
  });
});
