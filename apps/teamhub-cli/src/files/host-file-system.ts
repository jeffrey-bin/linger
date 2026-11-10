import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, link, lstat, open, rename } from "node:fs/promises";
import path from "node:path";

/** Node cannot open or fsync directory handles on Windows (EPERM). */
export async function syncHostDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const WINDOWS_SHARING_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const REPLACE_RETRY_BUDGET_MS = 3_000;

/**
 * Windows refuses to replace a file another process holds open without
 * delete sharing (antivirus scans briefly, Office for as long as it is open),
 * so retry only those sharing errors there; other platforms rename directly.
 */
export async function replaceHostFile(
  source: string,
  target: string,
  beforeReplace?: () => Promise<void>,
): Promise<void> {
  if (process.platform !== "win32") {
    await beforeReplace?.();
    return rename(source, target);
  }
  let delay = 25;
  let waited = 0;
  for (;;) {
    try {
      // The target can change while sharing violations delay replacement.
      await beforeReplace?.();
      return await rename(source, target);
    } catch (error) {
      if (
        !isWindowsFileSharingError(error) ||
        waited >= REPLACE_RETRY_BUDGET_MS
      )
        throw error;
    }
    const wait = Math.min(delay, REPLACE_RETRY_BUDGET_MS - waited);
    await new Promise((resolve) => setTimeout(resolve, wait));
    waited += wait;
    delay *= 2;
  }
}

/** Recognizes sharing errors even when a file reader wraps the OS error. */
export function isWindowsFileSharingError(error: unknown): boolean {
  if (process.platform !== "win32" || !(error instanceof Error)) return false;
  const cause = error.cause instanceof Error ? error.cause : error;
  return WINDOWS_SHARING_CODES.has((cause as NodeJS.ErrnoException).code ?? "");
}

/**
 * Installs source at target and refuses an existing target with EEXIST.
 * exFAT/FAT32 volumes and some network shares lack hard links, so any other
 * link failure falls back to an exclusive copy. That copy is not atomic: a
 * crash mid-copy can leave a partial target, but an existing target is still
 * never replaced.
 */
export async function createHostFileExclusive(
  source: string,
  target: string,
): Promise<void> {
  try {
    await link(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw error;
    await copyFile(source, target, constants.COPYFILE_EXCL);
  }
}

/** mkdir's mode is ignored on Windows; protect recovery bytes with a DACL. */
export async function protectWindowsDirectories(
  directories: readonly string[],
): Promise<void> {
  if (process.platform !== "win32") return;
  try {
    await protectWindowsDirectoryPermissions(directories);
  } catch {
    throw Object.assign(
      new Error(
        "Could not protect local recovery metadata. Check workspace ownership and Windows PowerShell availability before retrying.",
      ),
      { code: "state_unavailable" },
    );
  }
}

async function protectWindowsDirectoryPermissions(
  directories: readonly string[],
): Promise<void> {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !/^[a-z]:[\\/]/iu.test(systemRoot))
    throw new Error("Windows system directory is unavailable");
  // An absolute system path avoids executing a workspace powershell.exe.
  const powershell = path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const identities = await Promise.all(
    directories.map(async (directory) => {
      const metadata = await lstat(directory, { bigint: true });
      if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw new Error("Recovery metadata is not a local directory");
      return metadata;
    }),
  );
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
$directories = ConvertFrom-Json ([Console]::In.ReadToEnd())
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
$inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
foreach ($directory in $directories) {
  if (([IO.File]::GetAttributes($directory) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Recovery metadata must not be a reparse point'
  }
  $existing = [IO.Directory]::GetAccessControl($directory)
  if ($existing.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user.Value) {
    throw 'Recovery metadata belongs to a different user'
  }
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @($user.Value, 'S-1-5-18', 'S-1-5-32-544')) {
    $identity = New-Object Security.Principal.SecurityIdentifier($sid)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', $inheritance, 'None', 'Allow')
    $acl.AddAccessRule($rule)
  }
  [IO.Directory]::SetAccessControl($directory, $acl)
}
`;
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, encoding: "utf8" },
      (error) =>
        error
          ? reject(error instanceof Error ? error : new Error(error.message))
          : resolve(),
    );
    child.stdin?.on("error", reject);
    // PowerShell 5.1/.NET otherwise fails above MAX_PATH, even when Node
    // created the directory successfully. Avoid the legacy provider path APIs.
    child.stdin?.end(
      JSON.stringify(
        directories.map((directory) => path.win32.toNamespacedPath(directory)),
      ),
    );
  });
  for (const [index, directory] of directories.entries()) {
    const metadata = await lstat(directory, { bigint: true });
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.dev !== identities[index]!.dev ||
      metadata.ino !== identities[index]!.ino
    )
      throw new Error("Recovery metadata directory changed");
  }
}
