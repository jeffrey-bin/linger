vi.mock("../../src/memory/collector.js", async (original) => ({
  ...(await original<typeof import("../../src/memory/collector.js")>()),
  loadAnotherMeSubjects: async () => [
    { memorySubjectKey: "agent_scope", representedHumanActorId: "actor_scope" },
  ],
}));
vi.mock("../../src/memory/pocket-note-source.js", () => ({
  stagePocketNote: async () => false,
}));
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runDailyCli } from "../../src/memory/daily-cli.js";
import { writeWeeklyPrompt } from "../../src/memory/prompt.js";
import {
  memoryOutputPrefixes,
  memorySyncPolicy,
} from "../../src/memory/sync-policy.js";

const subject = "agent_scope";
const date = "2026-09-02";
const dailyPath = `${subject}/timeline/daily/${date}.md`;
describe("unified Wiki period scope", () => {
  it("restricts executable policies to Daily and user dynamics without deletes", () => {
    expect(memoryOutputPrefixes("daily", "write")).toEqual(["timeline/daily/"]);
    expect(memoryOutputPrefixes("weekly", "write")).toEqual([
      "timeline/weekly/",
    ]);
    expect(memoryOutputPrefixes("daily", "delete")).toEqual([]);
    expect(memoryOutputPrefixes("weekly", "delete")).toEqual([]);
    expect(JSON.stringify(memorySyncPolicy("weekly"))).not.toContain(
      "flow_memory",
    );
  });

  it("builds scoped prompts and schemas using existing runners", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-period-scope-"));
    try {
      const sessions = path.join(
        root,
        subject,
        "memory-state/evidence",
        date,
        "sessions",
      );
      await fs.mkdir(sessions, { recursive: true });
      await fs.writeFile(
        path.join(sessions, "room_a.md"),
        "---\ntitle: Review\nroom_id: room_a\n---\n\n# Review\nDecided to ship.\n\n## Pattern\n\nUser requested: search evidence, compare options, then confirm the change. Source: room_a message_1.",
      );
      await runDailyCli([
        "prompt",
        "--date",
        date,
        "--memory-root",
        root,
        "--memory-subject-key",
        subject,
      ]);
      const directory = path.join(root, "updates/daily", date, subject);
      const collection = JSON.parse(
        await fs.readFile(path.join(directory, "collection.json"), "utf8"),
      );
      expect(collection.requiredOutputs).toEqual({
        dailyMemoryPath: dailyPath,
      });
      const prompt = await fs.readFile(
        path.join(directory, "daily.prompt.md"),
        "utf8",
      );
      expect(prompt).toContain("Daily summary for the unified Wiki");
      expect(prompt).toContain("Decided to ship.");
      expect(prompt).toContain("`daily_work`");
      expect(prompt).toContain("`pattern`");
      expect(prompt).toContain("conversations as\ntheir Raw evidence");
      expect(prompt).toContain("A draft is not final delivery");
      expect(prompt).not.toContain("userMemoryPath");
      const schema = JSON.parse(
        await fs.readFile(path.join(directory, "daily.schema.json"), "utf8"),
      );
      expect(schema.properties.source_refs.items.enum).toEqual(["room_a"]);
      expect(schema).not.toHaveProperty("properties.files");
      const weekly = await writeWeeklyPrompt(
        { memoryRoot: root, weekStart: date },
        {
          schemaVersion: 1,
          weekStart: date,
          weekEnd: "2026-09-08",
          timeZone: "Asia/Shanghai",
          generatedAt: new Date().toISOString(),
          source: { memoryRoot: root },
          memorySubjectKey: subject,
          existingMemoryFiles: [
            {
              path: dailyPath,
              content:
                "Daily evidence\n\n## Pattern\n\nConfirmed daily sequence: inspect, compare, then decide. Source date: 2026-09-02.",
            },
            {
              path: `${subject}/knowledge/topics/a.md`,
              content: "EXCLUDED_WORKFLOW_CONTEXT",
            },
          ],
        },
        {
          representedHumanActorId: "actor_alice",
          representedHumanDisplayName: "Alice",
        },
      );
      const weeklyPrompt = await fs.readFile(weekly.promptPath, "utf8");
      expect(weeklyPrompt).toContain('"actorId": "actor_alice"');
      expect(weeklyPrompt).toContain('"displayName": "Alice"');
      expect(weeklyPrompt).toContain(
        "Weekly user dynamics for the unified Wiki",
      );
      expect(weeklyPrompt).toContain("Daily evidence");
      expect(weeklyPrompt).toContain("`work_intensity`");
      expect(weeklyPrompt).toContain("`pattern`");
      expect(weeklyPrompt).toContain(
        "Confirmed daily sequence: inspect, compare, then decide",
      );
      expect(weeklyPrompt).toContain(
        "Critically review Daily Pattern candidates",
      );
      expect(weeklyPrompt).not.toContain("EXCLUDED_WORKFLOW_CONTEXT");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
