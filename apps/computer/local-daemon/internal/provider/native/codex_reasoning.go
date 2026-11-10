package native

import (
	"strings"
	"sync"
)

// codexReasoningTitles turns streamed reasoning summaries into short
// titles. Each summary part resolves at most once; its body is never
// published.
type codexReasoningTitles struct {
	mu    sync.Mutex
	parts map[string]map[int]*codexSummaryPart
}

type codexSummaryPart struct {
	text     strings.Builder
	resolved bool
}

func (r *codexReasoningTitles) feed(itemID string, index int, delta string) (string, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.parts == nil {
		r.parts = map[string]map[int]*codexSummaryPart{}
	}
	if r.parts[itemID] == nil {
		r.parts[itemID] = map[int]*codexSummaryPart{}
	}
	part := r.parts[itemID][index]
	if part == nil {
		part = &codexSummaryPart{}
		r.parts[itemID][index] = part
	}
	if part.resolved {
		return "", false
	}
	part.text.WriteString(delta)
	title, ok := ReasoningTitle(part.text.String(), false)
	if ok {
		part.resolved = true
	}
	return title, ok
}

// complete resolves the parts still open when the item finishes and returns
// the last non-empty title. The item's state is dropped.
func (r *codexReasoningTitles) complete(itemID string, summary []string) string {
	r.mu.Lock()
	parts := r.parts[itemID]
	delete(r.parts, itemID)
	r.mu.Unlock()
	last := ""
	for index, text := range summary {
		if part := parts[index]; part != nil && part.resolved {
			continue
		}
		if title, _ := ReasoningTitle(text, true); title != "" {
			last = title
		}
	}
	return last
}
