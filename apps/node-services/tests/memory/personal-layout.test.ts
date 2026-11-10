import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { migrateMemoryLayout } from "../../src/memory/migrate-memory-layout.js";
import { publishMemoryWiki } from "../../src/memory/published-memory-files.js";
import { readSessionWikiPathsForDate } from "../../src/memory/session-source.js";

const roots: string[] = [];
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "personal-layout-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
it("uses capture start times across midnight and keeps meeting links valid after summary edits", async () => {
  const root = await fixture();
  const memory = path.join(root, "alice/memory");
  const project = {
    page: { documentId: "doc_project", path: "projects/site.md" },
    content:
      "# Website redesign\n\n[Meeting](../sessions/2026-11-05/x.md#notes)",
  };
  const meeting = {
    page: { documentId: "doc_meeting", path: "sessions/2026-11-05/x.md" },
    content: "# Planning\n\n[Project](../../projects/site.md)",
  };
  const other = {
    page: { documentId: "other", path: "sessions/2026-11-05/y.md" },
    content: "# Planning\n",
  };
  const starts = new Map(
    ["x", "y"].map((id) => [id, new Date(2026, 10, 4, 23, 59, 58)] as const),
  );
  await publishMemoryWiki(root, "alice", [meeting, other, project], starts);
  expect(await fs.readdir(path.join(memory, "timeline/meetings"))).toHaveLength(
    2,
  );
  const open = async (from: string) => {
    const markdown = await fs.readFile(path.join(memory, from), "utf8");
    const link = markdown.match(/\]\(([^)]+)\)/u)![1]!.split("#")[0]!;
    return path.normalize(
      path.join(path.dirname(from), decodeURIComponent(link)),
    );
  };
  const before = await open("knowledge/projects/Website redesign.md");
  expect(before).toBe("timeline/meetings/2026-11-04 23-59-58.md");
  expect(await open(before)).toBe("knowledge/projects/Website redesign.md");
  meeting.content = meeting.content.replace("Planning", "Design review");
  await publishMemoryWiki(root, "alice", [meeting, project], starts);
  expect(await fs.readdir(path.join(memory, "timeline/meetings"))).toEqual([
    "2026-11-04 23-59-58.md",
  ]);
  expect(await open(await open("knowledge/projects/Website redesign.md"))).toBe(
    "knowledge/projects/Website redesign.md",
  );
  expect(
    await fs.readFile(
      path.join(memory, "knowledge/projects/Website redesign.md"),
      "utf8",
    ),
  ).toContain("#notes)");
  // A removed capture cannot be recovered from a heading or a transcript date.
  await publishMemoryWiki(root, "alice", [meeting, project], new Map());
  expect(await fs.readdir(path.join(memory, "timeline/meetings"))).toEqual([]);
  expect(
    await fs.readFile(
      path.join(memory, "knowledge/projects/Website redesign.md"),
      "utf8",
    ),
  ).toContain("Meeting");
  expect(
    await fs.readFile(
      path.join(memory, "knowledge/projects/Website redesign.md"),
      "utf8",
    ),
  ).not.toContain("sessions/");
});
it("converts existing files, citations and evidence outside the public tree and can restart", async () => {
  const root = await fixture();
  const workspace = path.join(root, "alice");
  const files = {
    "front/2026-11-05/sessions/chat.md": "chat",
    "graph/raw/2026/11/05/chat/manifest.json": JSON.stringify({
      id: "unchanged",
      anchorPath: "memory/front/2026-11-05/sessions/chat.md",
    }),
    "mid/daily_memory/2026-11-05.md": "day",
    "long/user_dynamic/2026-11-02.md":
      "[daily](memory://mid/daily_memory/2026-11-05.md)",
    "long/user_profile.md": "profile",
    "long/memory.md": "portrait",
  };
  for (const [file, content] of Object.entries(files)) {
    const name = path.join(workspace, "memory", file);
    await fs.mkdir(path.dirname(name), { recursive: true });
    await fs.writeFile(name, content);
  }
  await migrateMemoryLayout(root);
  await migrateMemoryLayout(root);
  expect((await fs.readdir(path.join(workspace, "memory"))).sort()).toEqual([
    "me",
    "timeline",
  ]);
  expect(
    await readSessionWikiPathsForDate(root, "alice", "2026-11-05"),
  ).toEqual(["alice/evidence/2026-11-05/sessions/chat.md"]);
  expect(
    JSON.parse(
      await fs.readFile(
        path.join(workspace, "memory-state/raw/2026/11/05/chat/manifest.json"),
        "utf8",
      ),
    ),
  ).toEqual({
    id: "unchanged",
    anchorPath: "memory-state/evidence/2026-11-05/sessions/chat.md",
  });
  expect(
    await fs.readFile(
      path.join(workspace, "memory/timeline/weekly/2026-11-02.md"),
      "utf8",
    ),
  ).toContain("../daily/2026-11-05.md");
});
