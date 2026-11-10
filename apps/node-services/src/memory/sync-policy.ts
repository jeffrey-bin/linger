export type MemorySyncTask = "daily" | "weekly";
export type MemoryPathCapability = "read" | "write" | "delete";

export interface MemoryPathRule {
  /** Path relative to the subject. Braces describe runtime values. */
  readonly path: string;
  readonly matchPrefix?: string;
  readonly capabilities: readonly MemoryPathCapability[];
  readonly scope?: string;
}

export interface MemorySyncPolicy {
  readonly inputs: readonly MemoryPathRule[];
  readonly outputs: readonly MemoryPathRule[];
}

/** Filesystem boundaries for the two current summary stages. */
export const MEMORY_SYNC_POLICIES: Record<MemorySyncTask, MemorySyncPolicy> = {
  daily: {
    inputs: [
      {
        path: "sessions/{date}/",
        capabilities: ["read"],
        scope:
          "the Raw evidence of every conversation and recording of the logical date, and the Human's Pocket Note for the date when present",
      },
      { path: "timeline/daily/{previousDate}.md", capabilities: ["read"] },
    ],
    outputs: [{ path: "timeline/daily/", capabilities: ["write"] }],
  },
  weekly: {
    inputs: [
      {
        path: "timeline/daily/{date}.md",
        capabilities: ["read"],
        scope: "the seven calendar dates starting at weekStart",
      },
      {
        path: "timeline/weekly/{previousWeekStart}.md",
        capabilities: ["read"],
        scope: "previous weekly baseline for comparison when present",
      },
    ],
    outputs: [
      {
        path: "timeline/weekly/{weekStart}.md",
        matchPrefix: "timeline/weekly/",
        capabilities: ["write"],
      },
    ],
  },
};

export function memorySyncPolicy(task: MemorySyncTask): MemorySyncPolicy {
  return MEMORY_SYNC_POLICIES[task];
}

export function memoryOutputPrefixes(
  task: MemorySyncTask,
  capability: "write" | "delete",
): string[] {
  return memoryOutputPrefixesForPolicy(memorySyncPolicy(task), capability);
}

export function memoryOutputPrefixesForPolicy(
  policy: MemorySyncPolicy,
  capability: "write" | "delete",
): string[] {
  return policy.outputs
    .filter((rule) => rule.capabilities.includes(capability))
    .map((rule) => rule.matchPrefix ?? rule.path);
}
