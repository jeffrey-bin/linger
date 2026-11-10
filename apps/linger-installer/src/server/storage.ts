import { windowsPrivatePath } from "@linger/local-installation/windows-private";
import {
  privateDirectory as corePrivateDirectory,
  atomicPrivate,
} from "@linger/local-installation/instance";
import { lstat, readFile } from "node:fs/promises";
export async function privateDirectory(directory: string) {
  await corePrivateDirectory(directory);
}
export async function privateWrite(file: string, value: unknown) {
  await atomicPrivate(file, JSON.stringify(value));
}
export async function privateRead(file: string): Promise<unknown> {
  const info = await lstat(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (process.platform !== "win32" &&
      (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))
  )
    throw new Error("Unsafe private file");
  if (process.platform === "win32") await windowsPrivatePath(file, "file");
  return JSON.parse(await readFile(file, "utf8"));
}
