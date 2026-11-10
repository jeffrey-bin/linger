import { rename, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

// Windows refuses to rename or delete a folder while a file in it is open
// without delete sharing. Antivirus scanners and the search indexer open
// freshly written files for a moment, so a rename right after unpacking can
// fail with one of these until they let go.
const LOCKED = new Set(["EPERM", "EACCES", "EBUSY"]);

export interface RenameRetryOptions {
  readonly platform?: NodeJS.Platform;
  // How long to keep trying before giving up; 30 s by default.
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  // Called before each wait, for the log.
  readonly onRetry?: (error: NodeJS.ErrnoException, attempt: number) => void;
  readonly rename?: (from: string, to: string) => Promise<void>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

// Renames `from` to `to`, waiting out a lock on Windows with backoff. The
// last error keeps its code and says how long the files stayed locked.
export async function renameRetrying(
  from: string,
  to: string,
  options: RenameRetryOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const move = options.rename ?? rename;
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const started = now();
  let wait = 50;
  for (let attempt = 1; ; attempt++) {
    try {
      await move(from, to);
      return;
    } catch (error) {
      const failure = error as NodeJS.ErrnoException;
      if (platform !== "win32" || !LOCKED.has(failure.code ?? "")) throw error;
      const elapsed = now() - started;
      if (elapsed + wait > timeoutMs) {
        const locked = new Error(
          `${failure.message} (still locked after ${attempt} attempts over ${Math.round(elapsed / 1000)} s)`,
          { cause: failure },
        ) as NodeJS.ErrnoException;
        locked.code = failure.code;
        if (failure.syscall) locked.syscall = failure.syscall;
        if (failure.path) locked.path = failure.path;
        throw locked;
      }
      options.signal?.throwIfAborted();
      options.onRetry?.(failure, attempt);
      await sleep(wait);
      wait = Math.min(wait * 2, 1_000);
    }
  }
}

// Deletes a file or folder if present. Node retries EBUSY and EPERM itself
// with a growing delay, about 11 s in all.
export function removeRetrying(target: string): Promise<void> {
  return rm(target, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
}
