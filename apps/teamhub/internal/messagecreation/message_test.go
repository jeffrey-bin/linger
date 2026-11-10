package messagecreation

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func TestMessagePayloadShowsOnlySetRelations(t *testing.T) {
	message := Persisted{
		Message: Message{
			ID: "message-1", RoomID: "room-1", MessageKind: "conversation", CreatedAt: time.Unix(0, 0).UTC(),
			Author: store.Actor{ID: "actor-1", TenantID: "tenant-1", Kind: "agent", DisplayName: "Agent"},
		},
		tenantID: "tenant-1", body: "hello", segments: json.RawMessage(`[{"type":"text","content":"hello"}]`),
	}
	encoded, err := json.Marshal(message.payload())
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if got, ok := decoded["attachments"].([]any); !ok || len(got) != 0 {
		t.Fatalf("attachments=%#v, want an empty array", decoded["attachments"])
	}
	for _, key := range []string{"context_messages", "reply_to_message_id", "card_context_message_id", "card"} {
		if _, found := decoded[key]; found {
			t.Fatalf("payload carries unset %s: %s", key, encoded)
		}
	}

	message.Message.ReplyToMessageID = "message-0"
	message.cardContextMessageID = "message-card"
	message.Card = json.RawMessage(`{"intent":"decision_requested"}`)
	encoded, err = json.Marshal(message.payload())
	if err != nil {
		t.Fatal(err)
	}
	decoded = map[string]any{}
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["reply_to_message_id"] != "message-0" || decoded["card_context_message_id"] != "message-card" ||
		decoded["card"].(map[string]any)["intent"] != "decision_requested" {
		t.Fatalf("payload=%s", encoded)
	}
}

func TestNormalizePreservesSkillSegmentMetadata(t *testing.T) {
	content, err := Normalize([]Segment{{
		Type: "skill", Content: "/review-changes", Target: "actor-reviewer",
		SkillID: "skill-review", ManifestVersion: "1.0.0",
	}})
	if err != nil {
		t.Fatalf("Normalize: %v", err)
	}
	if content.RawMessage != "/review-changes" || len(content.Segments) != 1 {
		t.Fatalf("content=%+v", content)
	}
	segment := content.Segments[0]
	if segment.Target != "actor-reviewer" || segment.SkillID != "skill-review" || segment.ManifestVersion != "1.0.0" {
		t.Fatalf("segment=%+v", segment)
	}
}

func TestNormalizePreservesDocumentSegmentIdentity(t *testing.T) {
	content, err := Normalize([]Segment{{
		Type: "document", Content: "@Launch_plan", DocumentID: "document_launch", Presentation: "inline",
	}})
	if err != nil {
		t.Fatalf("Normalize: %v", err)
	}
	if content.RawMessage != "@Launch_plan" || len(content.Segments) != 1 ||
		content.Segments[0].DocumentID != "document_launch" || content.Segments[0].DocumentVersionID != "" || content.Segments[0].Presentation != "inline" {
		t.Fatalf("content=%+v", content)
	}
	for _, malformed := range []Segment{
		{Type: "document", Content: "@Launch_plan"},
		{Type: "document", Content: "@Launch_plan", DocumentID: "document.with.dot"},
		{Type: "document", Content: "@Launch_plan", DocumentID: "document_launch", Presentation: "banner"},
		{Type: "file", Content: "file", DocumentID: "document_launch"},
	} {
		if _, err := Normalize([]Segment{malformed}); err == nil {
			t.Fatalf("Normalize accepted malformed Document segment: %+v", malformed)
		}
	}
}

func TestNormalizePreservesDeliveredDocumentCard(t *testing.T) {
	segment := Segment{
		Type: "document", Content: "notes.md", DocumentID: "document_notes", Presentation: "card",
	}
	content, err := Normalize([]Segment{segment})
	if err != nil || content.RawMessage != "notes.md" || len(content.Segments) != 1 || content.Segments[0] != segment {
		t.Fatalf("content=%+v error=%v", content, err)
	}
}

func TestNormalizePreservesCanvasDocument(t *testing.T) {
	segment := Segment{
		Type: "document", Content: "Email to Lisa", DocumentID: "document_canvas", Presentation: "canvas",
	}
	content, err := Normalize([]Segment{segment})
	if err != nil || content.RawMessage != "Email to Lisa" || len(content.Segments) != 1 || content.Segments[0] != segment {
		t.Fatalf("content=%+v error=%v", content, err)
	}
}

func TestNormalizeAttachmentsWithLiveDocumentCardsAllowsMixedArtifacts(t *testing.T) {
	fileAttachment := Attachment{
		ID: "attachment_file", DocumentID: "document_file", DocumentVersionID: "version_file",
		Filename: "brief.txt", MediaType: "text/plain", SizeBytes: 5,
		SHA256: "abc", Available: true,
	}
	segments := []Segment{
		{Type: "text", Content: "Start here."},
		{Type: "document", Content: "Native brief", DocumentID: "document_native", Presentation: "card"},
		{Type: "document", Content: "brief.txt", DocumentID: "document_file", Presentation: "card"},
	}
	attachments, err := normalizeAttachmentsWithLiveDocumentCards(
		segments, []Attachment{fileAttachment}, maxMessageAttachments,
	)
	if err != nil || len(attachments) != 1 || attachments[0] != fileAttachment {
		t.Fatalf("mixed attachments=%+v error=%v", attachments, err)
	}

	for _, malformed := range [][]Segment{
		{
			{Type: "document", Content: "Native brief", DocumentID: "document_native", Presentation: "card"},
		},
		{
			{Type: "file", Content: "wrong", DocumentID: "document_native", DocumentVersionID: "version_native"},
			{Type: "document", Content: "brief.txt", DocumentID: "document_file", Presentation: "card"},
		},
	} {
		if _, err := normalizeAttachmentsWithLiveDocumentCards(
			malformed, []Attachment{fileAttachment}, maxMessageAttachments,
		); err == nil {
			t.Fatalf("accepted malformed mixed attachment segments: %+v", malformed)
		}
	}
}

func TestNormalizePreservesArtifactTreeSegment(t *testing.T) {
	// An empty tree keeps total_bytes: the field is required even when zero.
	for _, totalBytes := range []int64{30416, 0} {
		segment := Segment{
			Type: "artifact_tree", Content: "Published morrow",
			PublicationGroupID: "publication_group_1", RootPath: "morrow",
			FileCount: 7, DirectoryCount: 2, TotalBytes: &totalBytes,
			EntryDocumentID: "document_1", EntryDocumentVersionID: "document_version_1",
		}
		content, err := Normalize([]Segment{segment})
		if err != nil {
			t.Fatalf("Normalize: %v", err)
		}
		if content.RawMessage != segment.Content || len(content.Segments) != 1 || content.Segments[0] != segment {
			t.Fatalf("content=%+v", content)
		}
		encoded, err := json.Marshal(content.Segments[0])
		if err != nil {
			t.Fatal(err)
		}
		var stored map[string]any
		if err := json.Unmarshal(encoded, &stored); err != nil || stored["total_bytes"] != float64(totalBytes) {
			t.Fatalf("stored segment=%s err=%v", encoded, err)
		}
	}
}

func TestNormalizeRejectsPartialArtifactTreeEntry(t *testing.T) {
	totalBytes := int64(0)
	base := Segment{
		Type: "artifact_tree", Content: "Published morrow",
		PublicationGroupID: "publication_group_1", RootPath: "morrow",
		FileCount: 1, DirectoryCount: 1, TotalBytes: &totalBytes,
	}
	if _, err := Normalize([]Segment{base}); err != nil {
		t.Fatalf("Normalize rejected a complete Artifact Tree: %v", err)
	}
	withoutTotal := base
	withoutTotal.TotalBytes = nil
	entryOnly, versionOnly := base, base
	entryOnly.EntryDocumentID = "document_1"
	versionOnly.EntryDocumentVersionID = "document_version_1"
	for _, segment := range []Segment{withoutTotal, entryOnly, versionOnly} {
		if _, err := Normalize([]Segment{segment}); err == nil {
			t.Fatalf("Normalize accepted an incomplete Artifact Tree: %+v", segment)
		}
	}
}

func TestNormalizeRejectsMalformedSkillSegment(t *testing.T) {
	for _, segment := range []Segment{
		{Type: "skill", Content: "review", Target: "actor-reviewer", SkillID: "skill-review", ManifestVersion: "1.0.0"},
		{Type: "skill", Content: "/review", Target: "actor-reviewer", SkillID: "skill-review"},
		{Type: "text", Content: "hello", SkillID: "skill-review"},
	} {
		if _, err := Normalize([]Segment{segment}); err == nil {
			t.Fatalf("Normalize accepted malformed segment: %+v", segment)
		}
	}
}

func TestMentionTokenJoinsDisplayNameSpaces(t *testing.T) {
	t.Parallel()
	if got := MentionToken(" @Ada Lovelace "); got != "@Ada_Lovelace" {
		t.Fatalf("token=%q", got)
	}
}

func TestEncodeAttachmentsKeepsOrderAndNeverEncodesNull(t *testing.T) {
	encoded, err := encodeAttachments(nil)
	if err != nil || string(encoded) != "[]" {
		t.Fatalf("no attachments=%s %v", encoded, err)
	}
	encoded, err = encodeAttachments([]Attachment{
		{ID: "message_attachment_b", DocumentID: "document_b", DocumentVersionID: "version_b", Filename: "b.txt"},
		{ID: "message_attachment_a", DocumentID: "document_a", DocumentVersionID: "version_a", Filename: "a.html"},
	})
	want := `[{"id":"message_attachment_b","document_id":"document_b","document_version_id":"version_b"},` +
		`{"id":"message_attachment_a","document_id":"document_a","document_version_id":"version_a"}]`
	if err != nil || string(encoded) != want {
		t.Fatalf("attachments=%s %v", encoded, err)
	}
}

func TestPersistRejectsMisplacedOrigins(t *testing.T) {
	author := store.Actor{ID: "actor-1", TenantID: "tenant-1", Kind: "human"}
	routine := &FiredRoutine{ID: "reminder-1", Instruction: "Send the brief."}
	for name, draft := range map[string]Draft{
		"routine on conversation":     {Kind: "conversation", FiredRoutine: routine},
		"routine without instruction": {Kind: "agent_runtime", FiredRoutine: &FiredRoutine{ID: "reminder-1"}},
		"routine without id":          {Kind: "agent_runtime", FiredRoutine: &FiredRoutine{Instruction: "Send the brief."}},
		"card kind without title":     {CardKind: "profile"},
		"unknown card kind":           {CardKind: "report", CardTitle: "Report"},
	} {
		draft.TenantID, draft.RoomID, draft.Author = "tenant-1", "room-1", author
		// Validation runs before any query, so no database is needed.
		if _, err := Persist(context.Background(), nil, draft); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: err=%v, want ErrInvalid", name, err)
		}
	}
}
