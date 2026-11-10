package document

import (
	"fmt"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestBuildDocumentCommentsMarkdownIncludesEveryVisibleCommentWhenItFits(t *testing.T) {
	comments := []notificationComment{
		{ID: "comment_1", AuthorName: "Alice", AuthorKind: "human", Body: "first", CreatedAt: time.Unix(1, 0)},
		{ID: "comment_2", AuthorName: "Agent", AuthorKind: "agent", Body: "second", CreatedAt: time.Unix(2, 0)},
	}

	result, err := buildDocumentCommentsMarkdown(
		"Plan", "thread_1", "comment_2", "selected", "before", "after", comments,
	)
	if err != nil {
		t.Fatalf("build comments Markdown: %v", err)
	}
	for _, expected := range []string{
		"thread_id: thread_1", "trigger_comment_id: comment_2", "Visible comments: 2",
		"comment_1: Alice (human", "comment_2: Agent (agent", "first", "second",
	} {
		if !strings.Contains(result, expected) {
			t.Fatalf("comments Markdown missing %q: %s", expected, result)
		}
	}
	if strings.Contains(result, "Showing the latest") {
		t.Fatalf("small comments Markdown was unexpectedly truncated: %s", result)
	}
}

func TestDocumentSelectionMarkdownKeepsOnlyImmediateContextSentences(t *testing.T) {
	result := documentSelectionMarkdown(
		"selected",
		"Older sentence. Immediate sentence!",
		"First sentence after? Later sentence.",
	)
	want := "Selected text:\n\"selected\"\n\nContext:\nImmediate sentence!\n[selection]\nFirst sentence after?\n"
	if result != want {
		t.Fatalf("selection Markdown mismatch:\nwant:\n%s\ngot:\n%s", want, result)
	}
}

func TestDocumentSelectionMarkdownUsesLineBoundariesAndBoundsLongSentences(t *testing.T) {
	result := documentSelectionMarkdown(
		"selected",
		"Description sentence.\nCore principles",
		strings.Repeat("x", maxNotificationContextBytes*2)+". Later sentence.",
	)
	if !strings.Contains(result, "\nCore principles\n[selection]\n") {
		t.Fatalf("selection Markdown did not use the nearest line: %s", result)
	}
	if strings.Contains(result, "Description sentence") || strings.Contains(result, "Later sentence") {
		t.Fatalf("selection Markdown included non-immediate context: %s", result)
	}
	contextAfter := strings.SplitN(result, "[selection]\n", 2)[1]
	if len(contextAfter) > maxNotificationContextBytes+1 {
		t.Fatalf("context after bytes=%d", len(contextAfter))
	}
}

func TestBuildDocumentCommentsMarkdownBoundsOversizedThreadsWithoutHidingTruncation(t *testing.T) {
	comments := make([]notificationComment, 100)
	for index := range comments {
		comments[index] = notificationComment{
			ID: fmt.Sprintf("comment_%03d", index), AuthorName: "Alice", AuthorKind: "human",
			Body: strings.Repeat("x", 50000), CreatedAt: time.Unix(int64(index+1), 0),
		}
	}

	result, err := buildDocumentCommentsMarkdown(
		"Plan", "thread_1", "comment_099", "selected", "", "", comments,
	)
	if err != nil {
		t.Fatalf("build comments Markdown: %v", err)
	}
	if len(result) > maxDocumentCommentsMarkdownBytes {
		t.Fatalf("comments Markdown size=%d", len(result))
	}
	if !strings.Contains(result, "Showing the latest") ||
		!strings.Contains(result, "comment_099") || strings.Contains(result, "comment_000") {
		t.Fatalf("oversized projection did not retain a visible latest-comment suffix")
	}
}

func TestTruncateUTF8BytesReturnsValidBoundedText(t *testing.T) {
	result := truncateUTF8Bytes(strings.Repeat("\u4f60", 20), 31)
	if len(result) > 31 || !utf8.ValidString(result) || !strings.HasSuffix(result, "... [truncated]") {
		t.Fatalf("truncated value=%q bytes=%d", result, len(result))
	}
}
