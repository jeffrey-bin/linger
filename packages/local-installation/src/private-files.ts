import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { windowsPrivatePath } from "./windows-private.js";

// Owner-only files and directories, kept apart from instance.ts so callers
// such as the desktop app need not load its SQLite lock.
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException)?.code === "ENOENT";

export async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    await windowsPrivatePath(directory, "directory", true);
    return;
  }
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.()
  )
    throw new Error("Instance directory must be an owned directory");
  await chmod(directory, 0o700);
}
export async function atomicPrivate(
  file: string,
  contents: string,
): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    if (process.platform === "win32")
      await windowsPrivatePath(temporary, "file", true);
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
export async function readPrivate(file: string): Promise<string | undefined> {
  try {
    const info = await lstat(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (process.platform !== "win32" &&
        (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))
    )
      throw new Error("Instance settings must be private owned files");
    if (process.platform === "win32") await windowsPrivatePath(file, "file");
    return await readFile(file, "utf8");
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}
