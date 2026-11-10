/** Extra keep-requirements appended to the Runtime's native compaction prompt. */
export const renderCompactInstructions = (): string =>
  `Keep, for whoever continues this conversation:
- work in progress, and commitments made to whom;
- what you are waiting for, and from whom;
- Task ids and their current state;
- the latest human requests verbatim, with their message ids;
- agreements already settled in this Room;
- ids and paths of produced documents and files;
- the next step.
Drop completed and already reported process, and raw tool output. For anything the teamhub CLI can read again, keep only its id.`;

/** One-time notice on the first turn after the context was compacted. */
export const CONTEXT_COMPACTED_NOTICE = `<context_compacted>
Earlier conversation in this context was compacted into the summary above. For messages, documents, or Tasks the summary names only by id, read the details again with the teamhub CLI (message read, docs get, task list) instead of reconstructing them from the summary.
</context_compacted>`;
