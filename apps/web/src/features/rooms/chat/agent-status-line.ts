import { useEffect, useEffectEvent, useReducer } from "react";

/** What one Agent's status line shows: dots while waiting, else a text. */
export type AgentStatusLineContent =
  | { tone: "wait" }
  | {
      tone: "live" | "muted" | "danger" | "warn";
      text: string;
      /** The running Activity the line names, whose running time it shows. */
      runningActivityId?: string;
    };

/** One entry of an Agent's queue, keyed stably across renders. */
export interface AgentStatusLineItem {
  key: string;
  content: AgentStatusLineContent;
}

export interface AgentStatusLineTarget {
  id: string;
  content: AgentStatusLineContent;
  /**
   * The entries of the Agent's current group in order, ending with
   * `content`. The Agent holding the line shows each of them in turn.
   */
  queue?: readonly AgentStatusLineItem[];
}

export interface AgentStatusLineShown {
  id: string;
  content: AgentStatusLineContent;
  key: string;
  /** The queue entry shown. */
  itemKey?: string;
  /** Whole minutes the named Activity has been running, from one on. */
  minutes?: number;
}

export interface AgentStatusLineState {
  current?: AgentStatusLineShown;
  /** The line rolling out, kept until its animation has finished. */
  previous?: AgentStatusLineShown;
  changedAt: number;
  /** When the current Agent's turn in the rotation began. */
  turnAt: number;
  lines: Readonly<Record<string, AgentLine>>;
}

/** What an Agent's line shows, since when, and since when its Activity runs. */
interface AgentLine {
  shown: AgentStatusLineContent;
  shownAt: number;
  runningSince?: number;
  /** The text changed while another Agent held the line. */
  fresh?: boolean;
}

interface EffectiveTarget {
  id: string;
  content: AgentStatusLineContent;
  itemKey?: string;
}

// grok-bot's status line: 2s turns, and a line stays at least 1.2s, as
// grok-bot's queued activity does, rolling a little quicker than its 300ms.
// An Agent's queue keeps at most three entries waiting behind the shown one.
export const AGENT_STATUS_LINE_TIMING = {
  turnMs: 2000,
  minShowMs: 1200,
  rollMs: 260,
  tickMs: 200,
  queuedMax: 3,
};

const INITIAL_STATE: AgentStatusLineState = {
  changedAt: Number.NEGATIVE_INFINITY,
  lines: {},
  turnAt: Number.NEGATIVE_INFINITY,
};

const ended = (content: AgentStatusLineContent) =>
  content.tone === "danger" || content.tone === "warn";

const contentKey = (content: AgentStatusLineContent) =>
  content.tone === "wait" ? "wait" : `${content.tone}:${content.text}`;

const lineKey = (content: AgentStatusLineContent) =>
  content.tone === "wait"
    ? "wait"
    : `${contentKey(content)}|${content.runningActivityId ?? ""}`;

/**
 * The entry an Agent's line moves to next. The Agent holding the line plays
 * its queue: the entry after the shown one, or the start of a new group, but
 * never more than `queuedMax` entries behind. Other Agents show their latest.
 */
function effectiveTarget(
  target: AgentStatusLineTarget,
  current: AgentStatusLineShown | undefined,
): EffectiveTarget {
  const queue = target.queue;
  if (!queue?.length) return { id: target.id, content: target.content };
  const last = queue.length - 1;
  let next = last;
  if (current?.id === target.id) {
    const shown = queue.findIndex((item) => item.key === current.itemKey);
    next = Math.min(
      last,
      Math.max(shown + 1, last - AGENT_STATUS_LINE_TIMING.queuedMax),
    );
  }
  const item = queue[next]!;
  return { id: target.id, content: item.content, itemKey: item.key };
}

function shownTarget(
  target: EffectiveTarget,
  minutes: number | undefined,
): AgentStatusLineShown {
  return {
    id: target.id,
    content: target.content,
    key: contentKey(target.content),
    ...(target.itemKey === undefined ? {} : { itemKey: target.itemKey }),
    ...(minutes === undefined ? {} : { minutes }),
  };
}

/**
 * Advances the one-line status of a Room's Agents. Running Agents take turns;
 * failed or unconfirmed ones show only after every other Agent is done.
 * Only a new status changes an Agent's line; time alone never does, except
 * that the Agent holding the line plays its queued entries one by one. An
 * Agent whose text changed while another held the line takes it next, the
 * earliest change first, without waiting for the turn. A shown line stays at
 * least `minShowMs` unless its Agent has left or it is only dots.
 */
export function advanceAgentStatusLine(
  state: AgentStatusLineState,
  {
    now,
    paused,
    targets,
  }: {
    now: number;
    paused: boolean;
    targets: readonly AgentStatusLineTarget[];
  },
): AgentStatusLineState {
  const timing = AGENT_STATUS_LINE_TIMING;
  const lines: Record<string, AgentLine> = {};
  const effective = targets.map((target) => {
    const next = effectiveTarget(target, state.current);
    const shown = next.content;
    const previous = state.lines[target.id];
    // An Activity that finishes changes its line's key, so the line counts
    // as new from when it finished, as grok-bot's does.
    const same = previous && lineKey(previous.shown) === lineKey(shown);
    const running = shown.tone === "wait" ? undefined : shown.runningActivityId;
    // Dots have nothing to read, and the lines already up when the Dock
    // first renders are not news.
    const fresh = previous
      ? shown.tone !== "wait" &&
        (previous.fresh || contentKey(previous.shown) !== contentKey(shown))
      : state.current !== undefined && shown.tone !== "wait";
    lines[target.id] = {
      shown,
      shownAt: same ? previous.shownAt : now,
      ...(running === undefined
        ? {}
        : { runningSince: (same ? previous.runningSince : undefined) ?? now }),
      ...(fresh ? { fresh } : {}),
    };
    return next;
  });
  const running = effective.filter((target) => !ended(target.content));
  const pool = running.length
    ? running
    : effective.filter((target) => ended(target.content));
  const previous =
    state.previous && now - state.changedAt < timing.rollMs
      ? state.previous
      : undefined;
  if (pool.length === 0) {
    const settled = settle(state, lines, previous);
    return settled.current ? { ...settled, current: undefined } : settled;
  }

  const shownId = state.current?.id;
  const current = pool.find((target) => target.id === shownId);
  const turnOver =
    !paused && pool.length > 1 && now - state.turnAt >= timing.turnMs;
  const changed =
    paused && current ? undefined : earliestFresh(pool, lines, shownId);
  const pick =
    changed ??
    (current && !turnOver ? current : nextAfter(targets, pool, shownId));
  const minutes = runningMinutes(lines[pick.id], now);
  if (pick.id === shownId && contentKey(pick.content) === state.current?.key) {
    const next = settle(state, seen(lines, pick.id), previous);
    const turned = turnOver ? { ...next, turnAt: now } : next;
    // The same words from another queue entry follow it without rolling.
    return minutes === state.current.minutes &&
      pick.itemKey === state.current.itemKey
      ? turned
      : { ...turned, current: shownTarget(pick, minutes) };
  }
  // Dots have nothing to read, so a real status replaces them at once.
  if (
    current &&
    state.current?.content.tone !== "wait" &&
    now - state.changedAt < timing.minShowMs
  )
    return settle(state, seen(lines, current.id), previous);
  return {
    current: shownTarget(pick, minutes),
    previous: state.current,
    changedAt: now,
    lines: seen(lines, pick.id),
    turnAt: pick.id === shownId ? state.turnAt : now,
  };
}

/** Keeps the same object while nothing changed, so idle ticks do not render. */
function settle(
  state: AgentStatusLineState,
  lines: AgentStatusLineState["lines"],
  previous: AgentStatusLineShown | undefined,
) {
  return previous === state.previous && sameLines(lines, state.lines)
    ? state
    : { ...state, lines, previous };
}

/** The shown Agent has nothing unseen. */
function seen(lines: Record<string, AgentLine>, id: string) {
  const line = lines[id];
  if (!line?.fresh) return lines;
  const unseen = { ...line };
  delete unseen.fresh;
  return { ...lines, [id]: unseen };
}

/** The other Agent whose unseen change is the oldest, roster order on ties. */
function earliestFresh(
  pool: readonly EffectiveTarget[],
  lines: Readonly<Record<string, AgentLine>>,
  shownId: string | undefined,
) {
  let found: EffectiveTarget | undefined;
  for (const target of pool) {
    const line = lines[target.id];
    if (target.id === shownId || !line?.fresh) continue;
    if (!found || line.shownAt < lines[found.id]!.shownAt) found = target;
  }
  return found;
}

function runningMinutes(line: AgentLine | undefined, now: number) {
  if (line?.runningSince === undefined) return undefined;
  const minutes = Math.floor((now - line.runningSince) / 60_000);
  return minutes >= 1 ? minutes : undefined;
}

function sameLines(
  next: AgentStatusLineState["lines"],
  current: AgentStatusLineState["lines"],
) {
  const ids = Object.keys(next);
  return (
    ids.length === Object.keys(current).length &&
    ids.every(
      (id) =>
        current[id] !== undefined &&
        lineKey(next[id]!.shown) === lineKey(current[id].shown) &&
        next[id]!.shownAt === current[id].shownAt &&
        next[id]!.runningSince === current[id].runningSince &&
        next[id]!.fresh === current[id].fresh,
    )
  );
}

function nextAfter(
  order: readonly AgentStatusLineTarget[],
  pool: readonly EffectiveTarget[],
  id: string | undefined,
) {
  const start = order.findIndex((target) => target.id === id);
  for (let step = 1; step <= order.length; step += 1) {
    const candidate = order[(start + step) % order.length];
    const match = pool.find((target) => target.id === candidate?.id);
    if (match) return match;
  }
  return pool[0]!;
}

/** Runs the status line on one timer for the lifetime of the Dock. */
export function useAgentStatusLine(
  targets: readonly AgentStatusLineTarget[],
  paused: boolean,
) {
  const [state, dispatch] = useReducer(
    advanceAgentStatusLine,
    { now: Date.now(), paused, targets },
    (input) => advanceAgentStatusLine(INITIAL_STATE, input),
  );
  const tick = useEffectEvent(() =>
    dispatch({ now: Date.now(), paused, targets }),
  );
  useEffect(() => {
    const timer = window.setInterval(
      () => tick(),
      AGENT_STATUS_LINE_TIMING.tickMs,
    );
    return () => window.clearInterval(timer);
  }, []);
  // Apply new statuses right away rather than on the next tick. The key keeps
  // a rerender with equal statuses from dispatching (and rendering) again.
  const targetsKey = targets
    .map(
      (target) =>
        `${target.id}=${lineKey(target.content)}|${target.queue?.map((item) => item.key).join(",") ?? ""}`,
    )
    .join("\n");
  useEffect(() => tick(), [targetsKey, paused]);
  return state;
}
