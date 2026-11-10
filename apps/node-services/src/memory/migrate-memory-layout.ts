import fs from "node:fs/promises";
import path from "node:path";
import { withDirectoryLock } from "./filesystem-lock.js";
import {
  markMemoryChanged,
  pathExists,
  walkFiles,
  writeAtomicJsonFile,
} from "./fs-utils.js";

/** One-time on-disk conversion before the scheduler or HTTP writers start. */
export async function migrateMemoryLayout(dataRoot: string): Promise<void> {
  if (!(await pathExists(dataRoot))) return;
  for (const entry of await fs.readdir(dataRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]{1,64}$/u.test(entry.name))
      continue;
    const workspace = path.join(dataRoot, entry.name);
    const memory = path.join(workspace, "memory");
    const state = path.join(workspace, "memory-state");
    const pending = path.join(state, "layout-migration.pending");
    if (
      !(await pathExists(pending)) &&
      !(
        await Promise.all(
          ["front", "mid", "long"].map((name) =>
            pathExists(path.join(memory, name)),
          ),
        )
      ).some(Boolean)
    )
      continue;
    await withDirectoryLock(state, async () => {
      await fs.writeFile(pending, "");
      for (const [from, to] of [
        ["front", "memory-state/evidence"],
        ["graph/raw", "memory-state/raw"],
        ["mid/daily_memory", "memory/timeline/daily"],
        ["long/user_dynamic", "memory/timeline/weekly"],
        ["long/user_profile.md", "memory/me/profile.md"],
        ["long/memory.md", "memory/me/memory.md"],
      ]) {
        const source = path.join(memory, from!);
        if (!(await pathExists(source))) continue;
        const dest = path.join(workspace, to!);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.rename(source, dest);
      }
      for await (const file of walkFiles(path.join(state, "raw"))) {
        if (path.basename(file) !== "manifest.json") continue;
        const source = JSON.parse(await fs.readFile(file, "utf8")) as {
          anchorPath: string;
        };
        if (!source.anchorPath.startsWith("memory/front/")) continue;
        source.anchorPath = source.anchorPath.replace(
          "memory/front/",
          "memory-state/evidence/",
        );
        await writeAtomicJsonFile(file, source);
      }
      for await (const file of walkFiles(path.join(memory, "timeline"))) {
        if (!file.endsWith(".md")) continue;
        if (path.basename(file) === "index.md") {
          await fs.unlink(file);
          continue;
        }
        const original = await fs.readFile(file, "utf8");
        const updated = original
          .replaceAll("](memory://mid/daily_memory/", "](../daily/")
          .replaceAll("](memory://long/user_dynamic/", "](../weekly/")
          .replaceAll("memory://mid/daily_memory/", "memory://timeline/daily/")
          .replaceAll(
            "memory://long/user_dynamic/",
            "memory://timeline/weekly/",
          );
        if (updated !== original) {
          const tmp = file + ".migrating";
          await fs.writeFile(tmp, updated);
          await fs.rename(tmp, file);
        }
      }
      for (const retired of ["mid", "long", "graph", "updates", "index.md"])
        await fs.rm(path.join(memory, retired), {
          recursive: true,
          force: true,
        });
      await fs.rm(path.join(state, "evidence/index.md"), { force: true });
      await markMemoryChanged(dataRoot, entry.name);
      await fs.unlink(pending);
    });
  }
}
