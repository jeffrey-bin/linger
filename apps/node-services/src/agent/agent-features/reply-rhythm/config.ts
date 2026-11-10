import type { ReplyRhythmSettings } from "./types.js";

export const DEFAULT_REPLY_RHYTHM_SETTINGS = Object.freeze({
  activationRate: 0.1,
  enabled: true,
  maxMessageCount: 4,
  minMessageCount: 2,
  version: "v2",
} satisfies ReplyRhythmSettings);
