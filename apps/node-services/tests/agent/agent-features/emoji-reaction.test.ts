import { describe, expect, it } from "vitest";

import { featureMatches } from "../../../src/agent/agent-features/compose.js";
import {
  createEmojiReactionFeature,
  EMOJI_REACTION_INSTRUCTIONS,
} from "../../../src/agent/agent-features/emoji-reaction/index.js";

describe("emoji-reaction feature", () => {
  it("guides every Agent type in Contexts that see Room conversation", () => {
    const feature = createEmojiReactionFeature();
    for (const agentType of ["general", "anotherme"] as const) {
      for (const contextKind of ["meta", "alter_ego"] as const)
        expect(featureMatches(feature, { agentType, contextKind })).toBe(true);
      expect(
        featureMatches(feature, { agentType, contextKind: "document" }),
      ).toBe(false);
    }
  });

  it("names the command, the emoji cases and the standalone Reaction rule", () => {
    for (const text of [
      "teamhub message emoji <message-id> <emoji>",
      "- ok_hand:",
      "- yawning_face:",
      "- eyes:",
      "- pray:",
      "react and send no text reply",
      "the Reaction never replaces a needed answer",
    ])
      expect(EMOJI_REACTION_INSTRUCTIONS).toContain(text);
  });
});
