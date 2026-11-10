vi.mock("../../src/memory/collector.js", async (original) => ({
  ...(await original<typeof import("../../src/memory/collector.js")>()),
  loadAnotherMeSubjects: async () => [
    { memorySubjectKey: "agent_alice", representedHumanActorId: "actor_alice" },
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

const subjectKey = "agent_alice";

describe("Daily required output validation", () => {
  it("applies a saved answer only when it matches the Daily schema", async () => {
    const memoryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "memory-daily-apply-"),
    );
    const sourceDir = path.join(
      memoryRoot,
      subjectKey,
      "memory-state",
      "evidence",
      "2026-09-02",
      "sessions",
    );
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(
      path.join(sourceDir, "room-alpha.md"),
      "---\ntype: Session Evidence\nsources:\n  - resource: teamhub://rooms/room-alpha/messages\n---\n\n# Raw\n",
    );
    const args = (action: string) => [
      action,
      "--date",
      "2026-09-02",
      "--memory-root",
      memoryRoot,
      "--memory-subject-key",
      subjectKey,
    ];
    const updateDir = path.join(
      memoryRoot,
      "updates",
      "daily",
      "2026-09-02",
      subjectKey,
    );
    const answer = {
      title: "Hardware day",
      description: "Reviewed hardware.",
      source_refs: ["room-alpha"],
      daily_work: [{ topic: "Hardware", text: "Chose vendor A." }],
      resolved_items: [],
      unresolved_items: [],
      tomorrow_focus: [],
      changes_compared_to_yesterday: [],
      pattern: [],
    };
    try {
      await runDailyCli(args("prompt"));
      const outputPath = path.join(updateDir, "daily.llm-output.json");
      await fs.writeFile(outputPath, JSON.stringify({ ...answer, files: [] }));
      await expect(runDailyCli(args("apply"))).rejects.toThrow(
        "Daily output does not match its schema",
      );
      await fs.writeFile(outputPath, JSON.stringify(answer));
      await runDailyCli(args("apply"));
      const daily = await fs.readFile(
        path.join(
          memoryRoot,
          subjectKey,
          "memory",
          "timeline",
          "daily",
          "2026-09-02.md",
        ),
        "utf8",
      );
      expect(daily).toContain("- **Hardware**: Chose vendor A.\n");
      expect(daily).toContain(
        "## Changes Compared To Yesterday\n\nNo yesterday baseline available.\n",
      );
      expect(daily).toContain(
        "## Sources\n\n- [room-alpha](teamhub://rooms/room-alpha/messages)\n",
      );
    } finally {
      await fs.rm(memoryRoot, { force: true, recursive: true });
    }
  });

  it("collects only the previous Daily baseline", async () => {
    const memoryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "memory-daily-policy-"),
    );
    const subjectRoot = path.join(memoryRoot, subjectKey, "memory");
    const sourceDir = path.join(
      memoryRoot,
      subjectKey,
      "memory-state",
      "evidence",
      "2026-09-02",
      "sessions",
    );
    const projectPath = path.join(
      subjectRoot,
      "knowledge",
      "projects",
      "project-alpha.md",
    );
    const userPath = path.join(subjectRoot, "me", "memory.md");
    const previousDailyPath = path.join(
      subjectRoot,
      "timeline",
      "daily",
      "2026-09-01.md",
    );
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.mkdir(path.dirname(projectPath), { recursive: true });
    await fs.mkdir(path.dirname(userPath), { recursive: true });
    await fs.mkdir(path.dirname(previousDailyPath), { recursive: true });
    await Promise.all([
      fs.writeFile(
        path.join(sourceDir, "room-alpha.md"),
        `## Goals And Intended Outcomes\n\n- Ship project Alpha.\n\n## Decisions Made\n\n- Use the existing API.\n`,
      ),
      fs.writeFile(projectPath, "# Project Alpha\n"),
      fs.writeFile(userPath, "# Current User Memory\n"),
      fs.writeFile(previousDailyPath, "# Previous Daily\n"),
    ]);

    try {
      await runDailyCli([
        "collect",
        "--date",
        "2026-09-02",
        "--memory-root",
        memoryRoot,
        "--memory-subject-key",
        subjectKey,
      ]);
      const collection = JSON.parse(
        await fs.readFile(
          path.join(
            memoryRoot,
            "updates",
            "daily",
            "2026-09-02",
            subjectKey,
            "collection.json",
          ),
          "utf8",
        ),
      ) as {
        previousDailyFiles: Array<{ path: string }>;
        requiredOutputs: {
          dailyMemoryPath: string;
        };
      };

      expect(collection.requiredOutputs).toEqual({
        dailyMemoryPath: `${subjectKey}/timeline/daily/2026-09-02.md`,
      });
      expect(collection.previousDailyFiles).toEqual([
        {
          path: `${subjectKey}/timeline/daily/2026-09-01.md`,
          content: "# Previous Daily\n",
        },
      ]);
      await expect(
        fs.stat(path.join(subjectRoot, "me/history")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(memoryRoot, { force: true, recursive: true });
    }
  });
});
