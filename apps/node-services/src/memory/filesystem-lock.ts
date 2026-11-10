import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";

const ownership = new AsyncLocalStorage<{ error?: Error }>();

/** Fence publication if a heartbeat discovers that another process owns the lock. */
export function assertDirectoryLock(): void {
  const error = ownership.getStore()?.error;
  if (error) throw error;
}

const operations = new Map<string, Promise<unknown>>();

/** One lock protocol for HTTP workers and standalone Wiki/Raw CLIs. */
export async function withDirectoryLock<T>(
  directory: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = path.resolve(directory);
  const previous = operations.get(key) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(async () => {
      await fs.mkdir(key, { recursive: true });
      if ((await fs.lstat(key)).isSymbolicLink()) {
        throw new Error("A Wiki write directory cannot be a symbolic link");
      }
      const canonical = await fs.realpath(key);
      const state: { error?: Error } = {};
      const release = await lockfile.lock(canonical, {
        stale: 120_000,
        update: 10_000,
        retries: {
          retries: 3_600,
          factor: 1,
          minTimeout: 1_000,
          maxTimeout: 1_000,
        },
        onCompromised: (error) => {
          state.error = error;
        },
      });
      try {
        return await ownership.run(state, async () => {
          const result = await operation();
          assertDirectoryLock();
          return result;
        });
      } finally {
        if (!state.error) await release();
      }
    });
  operations.set(key, current);
  try {
    return await current;
  } finally {
    if (operations.get(key) === current) operations.delete(key);
  }
}
