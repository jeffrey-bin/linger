package agentsendmessage

import (
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
)

const validInvocationID = "agent-invocation-sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func TestNormalizeInputPreservesCanonicalStructuredMessage(t *testing.T) {
	segments := []messagecreation.Segment{
		{Type: "text", Content: "Start "},
		{Type: "reference", Content: "@Ada", Target: "actor_ada", TargetType: "user"},
		{Type: "file", Content: " report", DocumentID: "document_report"},
		{Type: "document", Content: " @Plan", DocumentID: "document_plan"},
	}
	sourceInboxIDs := []string{"room:room_source", "meta:actor_agent:task.alpha:7", "taskmeta:task.alpha:7"}
	normalized, err := normalizeInput(Input{
		SourceInboxIDs:  sourceInboxIDs,
		InvocationID:    validInvocationID,
		InboxID:         "room:room_target",
		messageSegments: segments,
	})
	if err != nil {
		t.Fatalf("normalize valid input: %v", err)
	}
	if normalized.target.kind != "room" || normalized.target.id != "room_target" || normalized.target.raw != "room:room_target" {
		t.Fatalf("target=%+v", normalized.target)
	}
	if normalized.content.RawMessage != "Start @Ada report @Plan" || !slices.Equal(normalized.content.Segments, segments) {
		t.Fatalf("content=%+v", normalized.content)
	}
	if normalized.canonicalRequestHash == ([32]byte{}) {
		t.Fatal("canonical request hash is empty")
	}

	segments[0].Content = "mutated"
	sourceInboxIDs[0] = "room:changed"
	if normalized.content.Segments[0].Content != "Start " ||
		normalized.sourceInboxIDs[0] != "room:room_source" {
		t.Fatalf("normalized input aliases caller slices: %+v", normalized)
	}
}

func TestParseInboxUsesExactPublicInboxGrammar(t *testing.T) {
	valid := []struct {
		inbox string
		kind  string
		id    string
	}{
		{inbox: "room:r", kind: "room", id: "r"},
		{inbox: "room:" + strings.Repeat("r", 64), kind: "room", id: strings.Repeat("r", 64)},
		{inbox: "thread:t", kind: "thread", id: "t"},
		{inbox: "thread:" + strings.Repeat("t", 64), kind: "thread", id: strings.Repeat("t", 64)},
	}
	for _, test := range valid {
		t.Run(test.inbox, func(t *testing.T) {
			target, err := parseInbox(test.inbox)
			if err != nil || target.kind != test.kind || target.id != test.id || target.raw != test.inbox {
				t.Fatalf("target=%+v error=%v", target, err)
			}
		})
	}

	invalid := []string{
		"", "room", "task", "meta:actor:task", "room:", "task:", "unknown:r",
		"r", "room:r.with-dot", "room:r:scope", "room:-r", "task:.task", "task:-task",
		"room:" + strings.Repeat("r", 65), "task:t", "task:task.with:scope-1_2",
	}
	for _, inbox := range invalid {
		t.Run("reject_"+inbox, func(t *testing.T) {
			if _, err := parseInbox(inbox); !errors.Is(err, ErrInvalid) {
				t.Fatalf("parseInbox(%q) error=%v want ErrInvalid", inbox, err)
			}
		})
	}
}

func TestNormalizeInputRejectsInvalidInvocationAndMessageShapes(t *testing.T) {
	valid := func() Input {
		return Input{
			SourceInboxIDs:  []string{"room:room_source"},
			InvocationID:    validInvocationID,
			InboxID:         "room:r",
			messageSegments: []messagecreation.Segment{{Type: "text", Content: "message"}},
		}
	}
	duplicateSources := valid()
	duplicateSources.SourceInboxIDs = []string{"room:room_source", "room:room_source"}
	invalidSource := valid()
	invalidSource.SourceInboxIDs = []string{"meta:task_1"}
	invalidTaskMetaSource := valid()
	invalidTaskMetaSource.SourceInboxIDs = []string{"taskmeta:-task_1"}
	callerChosenInvocation := valid()
	callerChosenInvocation.InvocationID = "request-1"
	noSegments := valid()
	noSegments.messageSegments = nil
	blankAggregate := valid()
	blankAggregate.messageSegments = []messagecreation.Segment{{Type: "text", Content: " \n\t"}}
	oversized := valid()
	oversized.messageSegments = []messagecreation.Segment{
		{Type: "text", Content: strings.Repeat("€", 25001)},
		{Type: "text", Content: strings.Repeat("€", 25000)},
	}
	skill := valid()
	skill.messageSegments = []messagecreation.Segment{{
		Type: "skill", Content: "/summarize", Target: "actor_agent",
	}}
	htmlFragment := valid()
	htmlFragment.messageSegments = []messagecreation.Segment{{
		Type: "html_fragment", Content: "Visual fragment",
	}}
	unknown := valid()
	unknown.messageSegments = []messagecreation.Segment{{Type: "card", Content: "message"}}
	malformedFile := valid()
	malformedFile.messageSegments = []messagecreation.Segment{{Type: "file", Content: "file", DocumentID: "document.with.dot"}}
	tests := []struct {
		name  string
		input Input
	}{
		{name: "duplicate source Inbox", input: duplicateSources},
		{name: "invalid source Inbox", input: invalidSource},
		{name: "invalid Task Meta source Inbox", input: invalidTaskMetaSource},
		{name: "caller chosen invocation", input: callerChosenInvocation},
		{name: "no segments", input: noSegments},
		{name: "blank aggregate", input: blankAggregate},
		{name: "total over fifty thousand runes", input: oversized},
		{name: "skill", input: skill},
		{name: "html_fragment", input: htmlFragment},
		{name: "unknown segment", input: unknown},
		{name: "malformed file", input: malformedFile},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := normalizeInput(test.input); !errors.Is(err, ErrInvalid) {
				t.Fatalf("normalizeInput error=%v want ErrInvalid", err)
			}
		})
	}
}

func TestNormalizeInputAcceptsExplicitEmptySourceInboxSet(t *testing.T) {
	normalized, err := normalizeInput(Input{
		SourceInboxIDs:  []string{},
		InvocationID:    validInvocationID,
		InboxID:         "room:room_1",
		messageSegments: []messagecreation.Segment{{Type: "text", Content: "message"}},
	})
	if err != nil {
		t.Fatalf("normalize explicit empty source Inbox set: %v", err)
	}
	if normalized.sourceInboxIDs == nil || len(normalized.sourceInboxIDs) != 0 {
		t.Fatalf("normalized source Inbox set=%v", normalized.sourceInboxIDs)
	}
}

func TestCanonicalRequestHashIncludesInboxAndOrderedNormalizedSegments(t *testing.T) {
	base := Input{
		SourceInboxIDs: []string{"room:room_source"},
		InvocationID:   validInvocationID,
		InboxID:        "room:room_1",
		messageSegments: []messagecreation.Segment{
			{Type: "text", Content: "first"},
			{Type: "file", Content: "second", DocumentID: "document_1"},
		},
	}
	normalized, err := normalizeInput(base)
	if err != nil {
		t.Fatalf("normalize base: %v", err)
	}
	hash := normalized.canonicalRequestHash
	same := base
	same.InvocationID = "agent-invocation-sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
	sameNormalized, err := normalizeInput(same)
	if err != nil || sameNormalized.canonicalRequestHash != hash {
		t.Fatalf("infrastructure invocation changed request hash: hash=%x same=%x error=%v", hash, sameNormalized.canonicalRequestHash, err)
	}

	differentInbox := base
	differentInbox.InboxID = "room:room_2"
	inboxNormalized, _ := normalizeInput(differentInbox)
	if inboxNormalized.canonicalRequestHash == hash {
		t.Fatal("inbox identity is missing from canonical request hash")
	}

	reordered := base
	reordered.messageSegments = []messagecreation.Segment{base.messageSegments[1], base.messageSegments[0]}
	orderedNormalized, _ := normalizeInput(reordered)
	if orderedNormalized.canonicalRequestHash == hash {
		t.Fatal("segment order is missing from canonical request hash")
	}

	changedSource := base
	changedSource.SourceInboxIDs = []string{"task:task_source"}
	sourceNormalized, _ := normalizeInput(changedSource)
	if sourceNormalized.canonicalRequestHash == hash {
		t.Fatal("source Inbox provenance is missing from canonical request hash")
	}
}
