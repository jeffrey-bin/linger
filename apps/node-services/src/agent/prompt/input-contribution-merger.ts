import {
  appendInputContribution,
  type InputContributionMerger,
} from "../agent-features/compose.js";

const NOTIFICATION_INSTRUCTION_START =
  "Use the messages shown above when they provide enough context.";

/**
 * Prompt-domain input merger for the composition root to inject as
 * `mergeInputContribution`. Text contributions land after the shown messages
 * and before the inbox notification instruction sentinel; messages without
 * that sentinel — including ordinary inputs — use the plain append merge.
 * The generic composer must not learn this English notification sentinel.
 */
export const mergePromptInputContribution: InputContributionMerger = (
  message,
  contribution,
) => {
  const instructionIndex = message.rawMessage.indexOf(
    NOTIFICATION_INSTRUCTION_START,
  );
  if (instructionIndex < 0) {
    return appendInputContribution(message, contribution);
  }
  const rawMessage = `${message.rawMessage
    .slice(0, instructionIndex)
    .trimEnd()}\n\n${contribution.text}\n\n${message.rawMessage.slice(
    instructionIndex,
  )}`;
  const [first, ...rest] = message.segments;
  const segments =
    first.type === "text"
      ? ([{ ...first, content: rawMessage }, ...rest] as const)
      : ([
          { type: "text" as const, content: rawMessage },
          ...message.segments,
        ] as const);
  return Object.freeze({ ...message, rawMessage, segments });
};
