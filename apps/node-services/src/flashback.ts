/**
 * Another Me flashback. The memory role serves it; the host hands
 * it to the agent role when both run in this process, so the Agent calls it
 * directly instead of over HTTP.
 */
export interface Flashback {
  /** Read-only: at most one earlier meeting or day worth recalling. */
  suggest(request: FlashbackRequest): Promise<FlashbackResponse>;
  /** Counts a flashback the Agent actually used against the budgets. */
  record(request: FlashbackRecordRequest): Promise<void>;
}

export interface FlashbackRequest {
  tenant_id: string;
  owner_actor_id: string;
  /** The Room being talked in: a Daily item citing it is never recalled, and it has its own cooldown. */
  room_id?: string;
  text: string;
}

export interface FlashbackRecordRequest {
  tenant_id: string;
  owner_actor_id: string;
  room_id?: string;
  episode: string;
  cue_id: string;
}

export type FlashbackReason =
  | "suggested"
  | "no_cue"
  | "no_candidate"
  | "below_threshold"
  | "room_cooldown"
  | "daily_limit";

export interface FlashbackResponse {
  reason: FlashbackReason | "no_graph";
  suggestion?: FlashbackSuggestion & { wikiRevision?: string };
}

export interface FlashbackSuggestion {
  /** The recalled meeting's Session page, or `daily/<date>` for the items of one day's Daily report. */
  episode: string;
  title: string;
  /** The day of the meeting or of the Daily report. */
  date: string;
  /** The message named the cue page. */
  cue: { id: string; title: string; via: "name" };
  /** The page linking the current topic to the recalled matter. */
  bridge?: { id: string; title: string };
  /** How the bridge ties to the recalled meeting or Daily items. */
  ties: Array<"link" | "mention">;
  strength: number;
  score: number;
  /** What the meeting's Session page or the Daily items say happened. */
  situation: string;
  decisions: string[];
  completed: string[];
  openItems: string[];
}
