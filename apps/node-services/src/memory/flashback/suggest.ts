import { entityNamePatterns, sessionDate } from "../graph/inferred-edges.js";
import type { StoredWikiGraph } from "../graph/build.js";
import { NATIVE_LINK_STRENGTH, pairTies } from "../graph/pair-strength.js";
import type { FlashbackReason, FlashbackSuggestion } from "../../flashback.js";
import {
  dailyCard,
  experienceCard,
  type DailyItem,
  type DailyReport,
} from "./card.js";

/**
 * Flashback picks at most one earlier meeting or day worth recalling for the
 * current message. It never fires at random; it needs a cue: the message
 * names a known Project, Client, or Contact.
 *
 * Recalling what was said about the cue itself is ordinary retrieval, so it
 * forms the current topic and is left out: the cue pages, pages tied to a cue
 * at `sameTopicStrength` or more, and Daily items that name a cue. A
 * flashback is a different matter reached through a bridge: a Project,
 * Client, Contact, or Topic page tied to a cue (or the cue itself, for a
 * meeting that only touches it in passing). Two things talked over in the
 * same meeting are not tied by that alone, so meetings are never bridges.
 * What is recalled is a meeting's Session page tied to the bridge, or the
 * items of one day's Daily report that name the bridge; a chat is recalled
 * through its Daily. An item names an entity as firmly as a page links it,
 * so it ties at the native link strength. The best candidate has to score
 * above a threshold:
 *
 *   score = cue strength × cue-to-bridge tie × fan(bridge)
 *           × bridge-to-meeting or bridge-to-item tie × forgotten
 *           × (1 + 0.5 if it left open items)
 *   fan(bridge) = min(1, 2 / ln(1 + pages the bridge is tied to))
 *
 * so a hub tied to everything links little. Directory index pages are
 * never bridges or recalled.
 *   forgotten = 1 − e^(−days since the meeting or day / forgetDays)
 *
 * so yesterday is not a flashback, and an unresolved matter is worth more. A
 * Daily item citing the Room being talked in now is never recalled, and
 * budgets keep flashbacks rare.
 */
export interface FlashbackSettings {
  forgetDays: number;
  threshold: number;
  roomCooldownMinutes: number;
  episodeRepeatDays: number;
  dailyLimit: number;
  /** A page that led to a flashback is not a cue again for this long. */
  cueCooldownHours: number;
  nativeLinkStrength: number;
  /** A tie at least this strong to a cue makes a page part of its topic. */
  sameTopicStrength: number;
}

export const DEFAULT_FLASHBACK_SETTINGS: FlashbackSettings = {
  forgetDays: 14,
  threshold: 0.2,
  roomCooldownMinutes: 30,
  episodeRepeatDays: 7,
  dailyLimit: 3,
  cueCooldownHours: 24,
  nativeLinkStrength: NATIVE_LINK_STRENGTH,
  sameTopicStrength: NATIVE_LINK_STRENGTH,
};

/** One flashback the Agent actually used, kept to enforce the budgets. */
export interface FlashbackRecord {
  episode: string;
  cue?: string;
  roomId?: string;
  at: string;
}

export function suggestFlashback(input: {
  graph: StoredWikiGraph;
  aliases: ReadonlyMap<string, readonly string[]>;
  dailies: readonly DailyReport[];
  text: string;
  roomId?: string;
  now: Date;
  history: readonly FlashbackRecord[];
  settings?: FlashbackSettings;
}): { reason: FlashbackReason; suggestion?: FlashbackSuggestion } {
  const settings = input.settings ?? DEFAULT_FLASHBACK_SETTINGS;
  const now = input.now.getTime();
  const since = (record: FlashbackRecord) => now - Date.parse(record.at);
  if (
    input.roomId &&
    input.history.some(
      (record) =>
        record.roomId === input.roomId &&
        since(record) < settings.roomCooldownMinutes * 60_000,
    )
  )
    return { reason: "room_cooldown" };
  if (
    input.history.filter((record) => since(record) < 86_400_000).length >=
    settings.dailyLimit
  )
    return { reason: "daily_limit" };

  const byId = new Map(input.graph.nodes.map((node) => [node.id, node]));
  const cues = new Map<string, { strength: number; via: "name" }>();
  for (const { target, pattern } of entityNamePatterns(
    input.graph.nodes,
    input.aliases,
  ))
    if (input.text.match(pattern))
      cues.set(target, { strength: 1, via: "name" });
  // Talking on about the same entity should not keep recalling around it.
  for (const record of input.history)
    if (record.cue && since(record) < settings.cueCooldownHours * 3_600_000)
      cues.delete(record.cue);
  if (!cues.size) return { reason: "no_cue" };

  const recent = new Set(
    input.history
      .filter(
        (record) => since(record) < settings.episodeRepeatDays * 86_400_000,
      )
      .map((record) => record.episode),
  );
  const ties = pairTies(
    {
      ...input.graph,
      nodes: input.graph.nodes.filter((node) => !isIndexPage(node.id)),
      edges: input.graph.edges.filter(
        (edge) => !isIndexPage(edge.source) && !isIndexPage(edge.target),
      ),
      inferredEdges: input.graph.inferredEdges?.filter(
        (edge) => !isIndexPage(edge.source) && !isIndexPage(edge.target),
      ),
    },
    settings.nativeLinkStrength,
  );
  const fan = (id: string) =>
    Math.min(1, 2 / Math.log(1 + Math.max(1, ties.get(id)?.size ?? 1)));
  const topic = new Set<string>(cues.keys());
  for (const cue of cues.keys())
    for (const [id, tie] of ties.get(cue) ?? [])
      if (tie.strength >= settings.sameTopicStrength) topic.add(id);
  const dailies = new Map(
    input.dailies.map((daily) => [dailyEpisode(daily.date), daily]),
  );
  const recallable = (item: DailyItem) =>
    !item.entities.some((id) => cues.has(id)) &&
    !(input.roomId && item.rooms.includes(input.roomId));

  interface Best {
    cue: string;
    bridge: string;
    strength: number;
    kinds: FlashbackSuggestion["ties"];
  }
  const best = new Map<string, Best>();
  const offer = (episode: string, candidate: Best) => {
    const current = best.get(episode);
    if (
      candidate.strength &&
      (!current || candidate.strength > current.strength)
    )
      best.set(episode, candidate);
  };
  for (const [cue, { strength }] of cues) {
    const bridges = [
      { id: cue, strength: 1 },
      ...[...(ties.get(cue) ?? [])]
        .filter(([id]) => !sessionDate(id))
        .map(([id, tie]) => ({ id, strength: tie.strength * fan(id) })),
    ];
    for (const bridge of bridges) {
      for (const [id, tie] of ties.get(bridge.id) ?? [])
        if (sessionDate(id) && !topic.has(id) && !recent.has(id))
          offer(id, {
            cue,
            bridge: bridge.id,
            strength: strength * bridge.strength * tie.strength,
            kinds: tie.kinds,
          });
      for (const [episode, daily] of dailies)
        if (
          !recent.has(episode) &&
          daily.items.some(
            (item) => recallable(item) && item.entities.includes(bridge.id),
          )
        )
          offer(episode, {
            cue,
            bridge: bridge.id,
            strength: strength * bridge.strength * settings.nativeLinkStrength,
            kinds: ["mention"],
          });
    }
  }

  let chosen: FlashbackSuggestion | undefined;
  for (const [episode, candidate] of best) {
    const daily = dailies.get(episode);
    const date = daily?.date ?? sessionDate(episode)!;
    const days = Math.max(
      0,
      (now - Date.parse(`${date}T00:00:00Z`)) / 86_400_000,
    );
    const forgotten = 1 - Math.exp(-days / settings.forgetDays);
    const card = daily
      ? dailyCard(
          daily.items.filter(
            (item) =>
              recallable(item) && item.entities.includes(candidate.bridge),
          ),
        )
      : experienceCard(byId.get(episode)!.body);
    const score =
      candidate.strength * forgotten * (card.openItems.length ? 1.5 : 1);
    if (chosen && score <= chosen.score) continue;
    chosen = {
      ...card,
      episode,
      title: daily?.title ?? byId.get(episode)!.title,
      date,
      cue: {
        id: candidate.cue,
        title: byId.get(candidate.cue)!.title,
        via: cues.get(candidate.cue)!.via,
      },
      ...(candidate.bridge !== candidate.cue
        ? {
            bridge: {
              id: candidate.bridge,
              title: byId.get(candidate.bridge)!.title,
            },
          }
        : {}),
      ties: candidate.kinds,
      strength: round(candidate.strength),
      score: round(score),
    };
  }
  if (!chosen) return { reason: "no_candidate" };
  if (chosen.score < settings.threshold) return { reason: "below_threshold" };
  return { reason: "suggested", suggestion: chosen };
}

/** The episode a Daily report's items are recalled and budgeted under. */
function dailyEpisode(date: string): string {
  return `daily/${date}`;
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}

function isIndexPage(id: string) {
  return id === "index" || id.endsWith("/index");
}
