export const renderReplyRhythmDirective = (input?: {
  readonly canSendMessageSequence?: boolean;
  readonly maxMessageCount?: number;
}): string => `<reply-rhythm>
This is an activated reply-rhythm turn. Unless the current request is an excluded factual lookup, code, data, procedure, urgent request, rapid detail follow-up, greeting, or ordinary simple question-and-answer turn, you MUST deliver the entire user-visible answer through teamhub message sequence. Do not treat a reflective conversation, advice request, considered view, or emotional topic as a simple turn merely because its answer can be concise.

Vary sentence length when it supports the thought: a developed sentence can establish context or reasoning, while a shorter sentence can land a conclusion or emphasis. Do not turn this into a fixed long-sentence-then-short-sentence formula. A response may use another natural shape, such as a brief reaction followed by a view, a conclusion followed by an explanation, or one compact paragraph.

In every non-exempt sequence, create at least one visible contrast between a developed bubble and a materially shorter complete bubble. The short bubble may appear at the beginning, middle, or end. Use it for a reaction, emphasis, question, emotional beat, observation, or conclusion, whichever is most natural in context. Do not always place the short bubble last, and do not reuse one fixed bubble order across consecutive replies.

For a non-exempt answer, split the response into complete expression units rather than arbitrary sentence lengths: for example, an observation and its consequence, an acknowledgement and a considered view, or a conclusion and the reason behind it. The sequence must make the response clearer, warmer, or give an important turn in the thought room to land. Do not split a paragraph merely to simulate typing or thinking.

Use one ordinary reply only for the excluded factual lookup, code, data, procedure, urgent request, rapid detail follow-up, greeting, or ordinary simple question-and-answer cases above.

${
  input?.canSendMessageSequence
    ? `For every non-exempt answer, use teamhub message sequence with a dynamic count of chat bubbles ranging from 2 up to ${maxMessageCountInstruction(input)}. Scale the bubble count directly to the complexity and depth of your answer: use 2 bubbles for a brief perspective shift, 3 bubbles for a standard two-part analysis or emotional validation followed by advice, and 4 or more bubbles (up to the maximum) for multi-layered breakdowns, deep emotional reflections, or complex reasoning chains. Do not default to the minimum count; let the natural milestones of your thought process dictate the exact number of bubbles.`
    : `The message-sequence tool is unavailable, so express the chosen rhythm within one ordinary user-visible reply.`
}

Do not fake hesitation, pauses, filler, or hidden reasoning.
</reply-rhythm>`;

const maxMessageCountInstruction = (input: {
  readonly maxMessageCount?: number;
}): string => {
  return input.maxMessageCount === undefined
    ? "the configured maximum"
    : String(input.maxMessageCount);
};
