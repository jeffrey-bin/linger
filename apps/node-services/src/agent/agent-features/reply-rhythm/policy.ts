import { encodeExecutionContextRef } from "../../executor/context-ref.js";
import { DEFAULT_REPLY_RHYTHM_SETTINGS } from "./config.js";
import type {
  ReplyRhythmDecision,
  ReplyRhythmInput,
  ReplyRhythmSettings,
} from "./types.js";

export const prepareReplyRhythm = (
  input: ReplyRhythmInput,
): ReplyRhythmDecision => {
  const settings = input.settings ?? DEFAULT_REPLY_RHYTHM_SETTINGS;
  assertValidSettings(settings);
  if (
    !settings.enabled ||
    input.agentType !== "anotherme" ||
    input.contextRef.kind !== "meta"
  ) {
    return { state: "not_offered" };
  }

  const selectionKey = [
    "reply-rhythm",
    settings.version,
    input.agentId,
    encodeExecutionContextRef(input.contextRef),
    input.turnKey,
  ].join("\u0000");
  if (stableFraction(selectionKey) >= settings.activationRate) {
    return { state: "not_offered" };
  }
  return {
    state: "offered",
    maxMessageCount: settings.maxMessageCount,
    minMessageCount: settings.minMessageCount,
    version: settings.version,
  };
};

const assertValidSettings = (settings: ReplyRhythmSettings): void => {
  if (
    typeof settings.enabled !== "boolean" ||
    typeof settings.version !== "string" ||
    settings.version.trim().length === 0 ||
    !Number.isInteger(settings.minMessageCount) ||
    !Number.isInteger(settings.maxMessageCount) ||
    settings.minMessageCount < 2 ||
    settings.maxMessageCount < settings.minMessageCount ||
    settings.maxMessageCount > 8 ||
    !Number.isFinite(settings.activationRate) ||
    settings.activationRate < 0 ||
    settings.activationRate > 1
  ) {
    throw new TypeError("Reply rhythm settings are invalid");
  }
};

const stableFraction = (value: string): number => {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) / 2 ** 32;
};
