import { defineFeature, type FeatureDeclaration } from "../contracts.js";
import { prepareReplyRhythm } from "./policy.js";
import { renderReplyRhythmDirective } from "./prompt.js";
import type { ReplyRhythmSettings } from "./types.js";

export const REPLY_RHYTHM_FEATURE_ID = "reply-rhythm";

/**
 * Narrow assembly dependencies bound once by the composition root: the offer
 * policy settings. Absent settings keep the built-in defaults.
 */
export interface ReplyRhythmFeatureDeps {
  readonly settings?: ReplyRhythmSettings;
}

/**
 * ReplyRhythm decides and renders text only. The contribution happens after canonical rebuild
 * (the mandatory formatting path), so start/steer and replay agree; the instruction is decided stably per messageId,
 * so replaying the same inputId yields the same result. A trusted notification (steered into an
 * active Run, such as a Flashback or control notification) is not a new turn and contributes nothing. The insertion position is decided by the domain merger
 * the host injects; the generic compose does not understand notification instruction sentinels.
 */
export const createReplyRhythmFeature = (
  deps?: ReplyRhythmFeatureDeps,
): FeatureDeclaration =>
  defineFeature({
    id: REPLY_RHYTHM_FEATURE_ID,
    match: { agentTypes: ["anotherme"], contextKinds: ["meta"] },
    context: {
      ports: { prepareInput: {} },
      create: () => ({
        prepareInput: (view, message) => {
          // A notice steered into an active Run is not a new turn.
          if (message.trustedNotification) return null;
          const decision = prepareReplyRhythm({
            agentId: view.ref.agentId,
            agentType: view.identity.agentType,
            contextRef: view.ref,
            settings: deps?.settings,
            turnKey: message.messageId,
          });
          if (decision.state !== "offered") return null;
          return {
            text: renderReplyRhythmDirective({
              canSendMessageSequence: view.ref.kind === "meta",
              maxMessageCount: decision.maxMessageCount,
            }),
          };
        },
      }),
    },
  });
