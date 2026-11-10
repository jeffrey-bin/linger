import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
describe("Raw excludes derived report ingestion", () => {
  it("does not scan or embed Daily/Weekly in MemoryChunkIndex", async () => {
    const source = await fs.readFile(
      new URL("../../src/memory/chunk-index.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("listPeriodSummaryChunkSources");
    expect(source).not.toContain("timeline/daily");
    expect(source).not.toContain("timeline/weekly");
    expect(source).toContain('source.originKind !== "period_summary"');
  });
});
