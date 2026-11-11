import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

// Folder names the installer accepts as instances; legacy-migration.ts skips
// the rest, so they never make a migration pending.
export const INSTANCE_NAME = /^[a-z][a-z0-9-]{0,39}$/;

/** The installation home: LINGER_HOME, else ~/.simplexai. */
export function lingerHome(
  environment: NodeJS.ProcessEnv = process.env,
  userHome: string = homedir(),
): string {
  return path.resolve(
    environment.LINGER_HOME || path.join(userHome, ".simplexai"),
  );
}

/**
 * Whether an instance under `home` still carries the project name of an
 * install from before the rename, so legacy-migration.ts has work to do.
 * Reads only each instance's record, so the desktop can ask before it starts
 * the installer to migrate.
 */
export async function legacyMigrationPending(home: string): Promise<boolean> {
  const directory = path.join(home, "instances");
  const names = await readdir(directory).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
      throw error;
    },
  );
  for (const name of names) {
    if (!INSTANCE_NAME.test(name)) continue;
    const record = await readFile(
      path.join(directory, name, "instance.json"),
      "utf8",
    ).catch(() => undefined);
    if (record === undefined) continue;
    let project: unknown;
    try {
      project = (JSON.parse(record) as { project?: unknown }).project;
    } catch {
      // A damaged record is not the migration's to judge; the installer
      // reports it when it reads the instance.
      continue;
    }
    if (typeof project === "string" && project.startsWith("simplex-"))
      return true;
  }
  return false;
}
