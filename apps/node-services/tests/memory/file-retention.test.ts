import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pruneMemoryFiles } from "../../src/memory/file-retention.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

const now = new Date("2026-10-20T12:00:00Z");
const daysAgo = (days: number) =>
  new Date(now.getTime() - days * 24 * 60 * 60_000);

async function write(root: string, relative: string, text = "x") {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

/** Sets every entry under target, then target itself, to the given time. */
async function age(target: string, time: Date): Promise<void> {
  if ((await fs.lstat(target)).isDirectory())
    for (const entry of await fs.readdir(target))
      await age(path.join(target, entry), time);
  await fs.utimes(target, time, time);
}

const exists = (file: string) =>
  fs.stat(file).then(
    () => true,
    () => false,
  );

describe("Memory file retention", () => {
  it("drops run records idle for seven days, the retired update logs and scheduler files, and older rebuild archives", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-retention-"));
    roots.push(root);
    const updates = path.join(root, "updates");
    await write(root, "updates/sessionly/2026-09-01/agent_1/collection.json");
    await write(root, "updates/sessionly/2026-09-02/agent_1/collection.json");
    await write(root, "updates/task-state/wiki-pending/2026-09-02.json", "{}");
    await write(root, "updates/daily/2026-09-03/agent_1/collection.json");
    await write(root, "updates/daily/2026-09-03/agent_1/daily.prompt.md");
    await write(root, "updates/weekly/2026-08-31/agent_1/collection.json");
    await write(root, "updates/wiki-sync/2026-10-19/result.json");
    await write(root, "updates/chunk-agent-locks/agent_1/lock");
    await write(root, "updates/wiki-calendar.json", "{}");
    await write(root, "updates/wiki-calendar.json.invalid-1", "{}");
    await write(root, "updates/task-state/session-triggers/activation.json");
    await write(root, "updates/task-state/session-triggers/pending/a.json");
    await age(updates, daysAgo(10));
    // A replay rewrote one file of an old day; the day stays.
    await fs.utimes(
      path.join(updates, "daily/2026-09-03/agent_1/daily.prompt.md"),
      daysAgo(1),
      daysAgo(1),
    );
    await age(path.join(updates, "wiki-sync/2026-10-19"), daysAgo(1));
    for (const file of [
      "memory_log.jsonl",
      "db_changes.jsonl",
      "index.md",
      "manual-refresh.json",
    ])
      await write(root, `agent_1/memory/updates/${file}`);
    for (const archive of [
      "memory.pre-rebuild-2026-09-01T00-00-00-000Z",
      "memory.pre-rebuild-2026-10-01T00-00-00-000Z",
      "memory.pre-rebuild-2026-10-10T00-00-00-000Z",
    ])
      await write(root, `agent_1/${archive}/index.md`);

    await pruneMemoryFiles(root, now);

    expect(await exists(path.join(updates, "sessionly/2026-09-01"))).toBe(
      false,
    );
    // A pending Wiki sync still reads that day's Session records.
    expect(await exists(path.join(updates, "sessionly/2026-09-02"))).toBe(true);
    expect(await exists(path.join(updates, "daily/2026-09-03"))).toBe(true);
    expect(await exists(path.join(updates, "weekly/2026-08-31"))).toBe(false);
    expect(await exists(path.join(updates, "wiki-sync/2026-10-19"))).toBe(true);
    expect(await exists(path.join(updates, "chunk-agent-locks/agent_1"))).toBe(
      true,
    );
    expect(
      await exists(
        path.join(updates, "task-state/wiki-pending/2026-09-02.json"),
      ),
    ).toBe(true);
    // The scheduler state moved to Postgres; its old files go.
    expect(await fs.readdir(path.join(updates, "task-state"))).toEqual([
      "wiki-pending",
    ]);
    expect(
      (await fs.readdir(updates)).filter((name) =>
        name.startsWith("wiki-calendar"),
      ),
    ).toEqual([]);
    expect(await fs.readdir(path.join(root, "agent_1/memory/updates"))).toEqual(
      [],
    );
    expect(
      (await fs.readdir(path.join(root, "agent_1"))).filter((name) =>
        name.startsWith("memory.pre-rebuild-"),
      ),
    ).toEqual(["memory.pre-rebuild-2026-10-10T00-00-00-000Z"]);
  });

  it("does nothing on an empty data root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-retention-"));
    roots.push(root);
    await expect(pruneMemoryFiles(root, now)).resolves.toBeUndefined();
    expect(await fs.readdir(root)).toEqual([]);
  });
});
