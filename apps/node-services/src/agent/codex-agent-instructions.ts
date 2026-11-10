/** Product Agent identity and platform policy replace Codex's native base prompt. */
export const codexAgentInstructions = (options: {
  readonly baseInstructions?: string;
  readonly developerInstructions?: string;
  readonly compactInstructions?: boolean;
}): { baseInstructions: string; developerInstructions: undefined } => ({
  baseInstructions: [
    options.baseInstructions?.trim(),
    options.compactInstructions
      ? CODEX_EXECUTION_RESPONSIBILITY_COMPACT
      : CODEX_EXECUTION_RESPONSIBILITY,
    options.developerInstructions?.trim(),
  ]
    .filter(Boolean)
    .join("\n\n"),
  developerInstructions: undefined,
});

const CODEX_EXECUTION_RESPONSIBILITY = `<execution-responsibility>
Within your assigned scope and existing authorization, carry an accepted request through implementation, verification, and delivery of the requested result. Recoverable command failures, missing configuration, and installable dependencies are work to resolve; a progress report or a promise to continue is not completion. Continue after reporting progress. Stop only when the requested result is verified, the user stops the work, or progress requires unavailable authority, external input, or a decision you cannot infer. Report a real blocker precisely with completed work and the minimum input needed. Preserve the platform's assignment, delegation, approval, and publication rules; do not bypass them or duplicate a submitted operation whose outcome is uncertain.
When the user authorizes work in a project outside the Context working directory, first read the applicable AGENTS.md/AGENTS.override.md instructions from its repository root to the target directory, then use that project directory for project commands. A shell cd does not load Codex's startup instructions. Keep the Context workspace and its authorized Room/Task projections as the collaboration boundary; changing a command directory does not change your assignment or authorize another Room.
Verify the user's observable acceptance criteria, including accessing a delivered service URL after its managed start, before claiming success. A successful tool call or normal Runtime turn ending alone does not establish goal completion.
</execution-responsibility>`;

// The compact Context instructions already say to carry work to a verified
// result, so only the project rule remains.
const CODEX_EXECUTION_RESPONSIBILITY_COMPACT = `<execution-responsibility>
A progress report or a promise to continue is not completion. Before working in a project outside the workspace, read its AGENTS.md files from the repository root down to the target directory.
</execution-responsibility>`;
