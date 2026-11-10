const readWiki = vi.hoisted(() => vi.fn());
vi.mock("../../src/memory/teamhub-wiki.js", () => ({
  readPublishedWiki: readWiki,
  teamHubWikiAccess: () => ({}),
}));
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const model = vi.hoisted(() => vi.fn());
vi.mock("../../src/memory/collector.js", async (original) => ({
  ...(await original<typeof import("../../src/memory/collector.js")>()),
  loadAnotherMeSubjects: async () => [
    {
      memorySubjectKey: "agent_alice",
      agentManagementId: "agent_alice",
      representedHumanActorId: "actor_alice",
      representedHumanDisplayName: "Alice",
      tenantId: "tenant_test",
    },
  ],
}));
vi.mock("../../src/memory/llm.js", async (original) => ({
  ...(await original<typeof import("../../src/memory/llm.js")>()),
  runValidatedMemoryModelUpdate: model,
}));
import {
  hasCurrentWeekEvidence,
  runWeeklyCli,
} from "../../src/memory/sync-runners.js";
import { renderDailyReport } from "../../src/memory/daily-report.js";
import type { WeeklyCollection } from "../../src/memory/types.js";
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "weekly-evidence-"));
  model.mockClear();
  readWiki.mockResolvedValue(undefined);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
const write = async (relative: string, text: string) => {
  const file = path.join(
    root,
    "agent_alice",
    relative.startsWith("evidence/") ? "memory-state" : "memory",
    relative,
  );
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
};
it.each([false, true])(
  "skips an empty week and preserves existing reports even with last week's content (placeholder=%s)",
  async (placeholder) => {
    await write(
      "timeline/weekly/2026-10-05.md",
      "Prior active project and preference",
    );
    await write(
      "timeline/weekly/2026-10-12.md",
      "Existing report must survive",
    );
    if (placeholder)
      await write(
        "timeline/daily/2026-10-13.md",
        "---\ntype: Daily Memory\n---\n\n## Daily Work\n\nNone observed.\n\n## Pattern\n\nNone observed.\n\n## Sources\n\n- [Room](teamhub://documents/d/versions/v)\n",
      );
    await expect(
      runWeeklyCli([
        "run",
        "--week-start",
        "2026-10-12",
        "--memory-root",
        root,
      ]),
    ).resolves.toEqual({ processedSubjectCount: 0 });
    expect(model).not.toHaveBeenCalled();
    expect(
      await fs.readFile(
        path.join(root, "agent_alice/memory/timeline/weekly/2026-10-12.md"),
        "utf8",
      ),
    ).toBe("Existing report must survive");
  },
);
it("does not classify a missing Daily as an empty week when Session collection is present", async () => {
  await write(
    "evidence/2026-10-13/sessions/room_a.md",
    "Raw collected, Daily pending",
  );
  await expect(
    runWeeklyCli(["run", "--week-start", "2026-10-12", "--memory-root", root]),
  ).rejects.toThrow("Daily report is not ready");
  expect(model).not.toHaveBeenCalled();
});
it("skips a published Session week whose completed Daily has no substantive evidence", async () => {
  await write(
    "timeline/daily/2026-10-13.md",
    "## Daily Work\n\nNone observed.\n\n## Pattern\n\nNone observed.\n",
  );
  await write("timeline/weekly/2026-10-12.md", "Existing report must survive");
  readWiki.mockResolvedValue({
    isCurrent: true,
    pages: [{ path: "sessions/2026-10-13/room_a.md" }],
  });
  await expect(
    runWeeklyCli(["run", "--week-start", "2026-10-12", "--memory-root", root]),
  ).resolves.toEqual({ processedSubjectCount: 0 });
  expect(model).not.toHaveBeenCalled();
  expect(
    await fs.readFile(
      path.join(root, "agent_alice/memory/timeline/weekly/2026-10-12.md"),
      "utf8",
    ),
  ).toBe("Existing report must survive");
});
it("finds current-week evidence only in a rendered Daily with activity items", () => {
  const daily = (resolved: string[]) =>
    renderDailyReport(
      {
        title: "Day",
        description: "Day.",
        source_refs: ["room_a"],
        daily_work: [],
        resolved_items: resolved,
        unresolved_items: [],
        tomorrow_focus: [],
        changes_compared_to_yesterday: [],
        pattern: [],
      },
      {
        date: "2026-10-13",
        memorySubjectKey: "agent_alice",
        hasYesterdayBaseline: false,
        catalog: [{ sourceRef: "room_a", resource: "teamhub://x", title: "A" }],
        now: new Date(),
      },
    );
  const collection = (path: string, content: string): WeeklyCollection => ({
    schemaVersion: 1,
    weekStart: "2026-10-12",
    weekEnd: "2026-10-18",
    timeZone: "Asia/Shanghai",
    generatedAt: "now",
    source: { memoryRoot: root },
    memorySubjectKey: "agent_alice",
    existingMemoryFiles: [{ path, content }],
  });
  const dailyPath = "agent_alice/timeline/daily/2026-10-13.md";
  expect(
    hasCurrentWeekEvidence(collection(dailyPath, daily(["Shipped."]))),
  ).toBe(true);
  expect(hasCurrentWeekEvidence(collection(dailyPath, daily([])))).toBe(false);
  expect(
    hasCurrentWeekEvidence(
      collection(
        "agent_alice/timeline/weekly/2026-10-05.md",
        daily(["Shipped."]),
      ),
    ),
  ).toBe(false);
});
