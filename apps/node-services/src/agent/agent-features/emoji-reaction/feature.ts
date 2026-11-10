import { defineFeature, type FeatureDeclaration } from "../contracts.js";
import { TOOL_APPROVAL_FEATURE_ID } from "../tool-approval/feature.js";
import {
  EMOJI_REACTION_INSTRUCTIONS,
  EMOJI_REACTION_INSTRUCTIONS_COMPACT,
} from "./prompt.js";

export const EMOJI_REACTION_FEATURE_ID = "emoji-reaction";

/**
 * Emoji reaction guidance: any Agent in a Context that can see the Room conversation (Meta and Task
 * AlterEgo) decides for itself whether to react with teamhub message emoji. It contributes only static
 * Context instructions that do not vary per message, so they do not affect the prompt cache. Document Context
 * cannot see the conversation, so it does not match.
 */
export const createEmojiReactionFeature = (): FeatureDeclaration =>
  defineFeature({
    id: EMOJI_REACTION_FEATURE_ID,
    match: { contextKinds: ["meta", "alter_ego"] },
    context: {
      // Follows the tool approval protocol, which closes the Context's own
      // instructions.
      ports: {
        contributeContextInstructions: { after: [TOOL_APPROVAL_FEATURE_ID] },
      },
      create: () => ({
        contributeContextInstructions: (_view, facts) =>
          facts.compactInstructions
            ? EMOJI_REACTION_INSTRUCTIONS_COMPACT
            : EMOJI_REACTION_INSTRUCTIONS,
      }),
    },
  });
