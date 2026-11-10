package native

const (
	// toolOutputTokens is the most one tool result may keep when the model's
	// window is unknown or large: Codex's global limit, in its bytes/4 token
	// estimate, before Codex cuts out the middle.
	toolOutputTokens = 12000
	// minToolOutputTokens keeps a small window's limit large enough to read a
	// page of a file or a command's error.
	minToolOutputTokens = 4000
)

// toolOutputTokenLimit sizes the tool output limit by the model's context
// window: a sixteenth of it, so one tool result never fills a small window,
// and at most toolOutputTokens. Codex estimates four bytes per token, which
// dense or binary output can exceed threefold. A zero window is unknown and
// keeps toolOutputTokens.
func toolOutputTokenLimit(contextWindow int) int {
	if contextWindow <= 0 {
		return toolOutputTokens
	}
	return min(max(contextWindow/16, minToolOutputTokens), toolOutputTokens)
}
