import { assertDirectoryLock } from "./filesystem-lock.js";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { agentWorkspaceRoot } from "./paths.js";

/** Read by the Agent to version its Memory snapshot; sits outside memory/. */
export const MEMORY_REVISION_FILE = "memory.revision";

/**
 * Call after a batch of writes under an Agent's memory tree. The token is
 * random, so any bump invalidates a snapshot taken before it.
 */
export async function markMemoryChanged(
  dataRoot: string,
  agentId: string,
): Promise<void> {
  const workspace = agentWorkspaceRoot(dataRoot, agentId);
  await ensureDir(workspace);
  const target = path.join(workspace, MEMORY_REVISION_FILE);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    assertDirectoryLock();
    await fs.writeFile(
      temporary,
      `${randomUUID()}\n${new Date().toISOString()}\n`,
      { flag: "wx", mode: 0o600 },
    );
    assertDirectoryLock();
    await fs.rename(temporary, target);
  } finally {
    await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function writeAtomicJsonFile(
  filePath: string,
  value: unknown,
): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    assertDirectoryLock();
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    assertDirectoryLock();
    await fs.rename(temporary, filePath);
  } finally {
    await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function ensureDir(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

export async function writeJsonFile(
  filePath: string,
  value: unknown,
): Promise<void> {
  await ensureDir(path.dirname(filePath));
  assertDirectoryLock();
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextFile(
  filePath: string,
  content: string,
): Promise<void> {
  await ensureDir(path.dirname(filePath));
  assertDirectoryLock();
  await fs.writeFile(
    filePath,
    content.endsWith("\n") ? content : `${content}\n`,
  );
}

export async function* walkFiles(root: string): AsyncGenerator<string> {
  if (!(await pathExists(root))) {
    return;
  }
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(fullPath);
    } else if (entry.isFile()) {
      yield fullPath;
    }
  }
}
