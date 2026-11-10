/**
 * Every kind of model call, and how call management treats it. Adding a kind
 * of model call is adding a policy row.
 */

/** One-shot calls and chains; the only kinds the HTTP contract accepts. */
const modelCallKinds = [
  "approval",
  "voice_ask",
  "memory",
  "agent_memory",
  "wiki",
  "profile",
  "insight",
] as const;
export type ModelCallKind = (typeof modelCallKinds)[number];

/** What queued a Run; only logged. */
export type RunKind =
  | "chat"
  | "agent_message"
  | "task"
  | "task_callback"
  | "routine"
  | "proactive"
  | "follow_up"
  | "document";

/** Queue priorities, lowest first: an approval, then every Run alike, then
 * compaction, then the background kinds. */
export const RUN_PRIORITY = 10;
export const COMPACTION_PRIORITY = 20;

export interface ModelCallPolicy {
  /** Whether the call waits its turn on its endpoint's queue. */
  readonly queued: boolean;
  /** Queued work starts lowest priority first, in arrival order within one. */
  readonly priority: number;
  /** Someone waits on the answer: the call stops once nobody waits, and
   * over HTTP it never answers pending. */
  readonly interactive: boolean;
  /** Runtime attempts of one call, a lone call or a chain's, corrections
   * included. Callers do not retry a call themselves. */
  readonly attempts: number;
  /** One Runtime attempt when the request names none. */
  readonly timeoutMs: number;
}

export const modelCallPolicies: Readonly<
  Record<ModelCallKind, ModelCallPolicy>
> = {
  approval: {
    queued: true,
    priority: 0,
    interactive: true,
    attempts: 1,
    timeoutMs: 15_000,
  },
  voice_ask: {
    queued: false,
    priority: 0,
    interactive: true,
    attempts: 1,
    timeoutMs: 45_000,
  },
  agent_memory: {
    queued: true,
    priority: 30,
    interactive: false,
    attempts: 2,
    timeoutMs: 10 * 60_000,
  },
  memory: {
    queued: true,
    priority: 40,
    interactive: false,
    attempts: 3,
    timeoutMs: 10 * 60_000,
  },
  profile: {
    queued: true,
    priority: 50,
    interactive: false,
    attempts: 2,
    timeoutMs: 2 * 60_000,
  },
  insight: {
    queued: true,
    priority: 60,
    interactive: false,
    attempts: 2,
    timeoutMs: 2 * 60_000,
  },
  wiki: {
    queued: true,
    priority: 70,
    interactive: false,
    attempts: 2,
    timeoutMs: 10 * 60_000,
  },
};

export function isModelCallKind(value: unknown): value is ModelCallKind {
  return (
    typeof value === "string" &&
    (modelCallKinds as readonly string[]).includes(value)
  );
}
