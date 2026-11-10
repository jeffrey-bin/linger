import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { performance } from "node:perf_hooks";

export interface TimingFields {
  readonly request_id?: string;
  readonly operation_id?: string;
  readonly method?: string;
  readonly http_status?: number;
  readonly outcome?: "success" | "failure" | "canceled";
}
export interface TimingEvent extends TimingFields {
  readonly stage: string;
  readonly duration_ms: number;
}

/** Optional metadata only. A timing failure must never change a business result. */
export function createTiming(
  env: NodeJS.ProcessEnv,
  now: () => number = () => performance.now(),
) {
  const filename = env.TEAMHUB_TIMING_FILE;
  if (!filename) return undefined;
  const events: TimingEvent[] = [];
  let droppedEvents = 0;
  const record = (
    stage: string,
    durationMs: number,
    fields: TimingFields = {},
  ) => {
    if (events.length >= 512) {
      droppedEvents++;
      return;
    }
    events.push({
      stage,
      duration_ms: Math.max(0, durationMs),
      ...fields,
    });
  };
  return {
    now,
    record,
    async measure<T>(stage: string, action: () => Promise<T>): Promise<T> {
      const started = now();
      try {
        const result = await action();
        record(stage, now() - started, { outcome: "success" });
        return result;
      } catch (error) {
        record(stage, now() - started, { outcome: "failure" });
        throw error;
      }
    },
    async flush(): Promise<boolean> {
      let handle;
      try {
        // New private file only: never truncate a user file or follow a symlink.
        handle = await open(
          filename,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        await handle.writeFile(
          JSON.stringify({
            schema_version: 1,
            node_version: process.version,
            events,
            dropped_events: droppedEvents,
          }) + "\n",
        );
        return true;
      } catch {
        return false;
      } finally {
        await handle?.close().catch(() => undefined);
      }
    },
  };
}

export type CliTiming = NonNullable<ReturnType<typeof createTiming>>;
