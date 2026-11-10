package collaboration

import (
	"encoding/json"
	"testing"

	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func TestNormalizeMessageCreateRequest(t *testing.T) {
	tests := []struct {
		name         string
		request      string
		wantRaw      string
		wantCount    int
		wantContexts []string
		wantInvalid  bool
	}{
		{name: "explicit conversation", request: `{"raw_message":"ordinary","segments":[{"type":"text","content":"ordinary"}],"message_kind":"conversation"}`, wantRaw: "ordinary", wantCount: 1},
		{name: "structured", request: `{"raw_message":"@Alice done","segments":[{"type":"reference","content":"@Alice","target":"actor_acme_alice","target_type":"user"},{"type":"text","content":" done"}]}`, wantRaw: "@Alice done", wantCount: 2},
		{name: "structured skill", request: `{"raw_message":"/summarize this","segments":[{"type":"skill","content":"/summarize","target":"agent_reviewer","skill_id":"skill_summarize","manifest_version":"1.0.0"},{"type":"text","content":" this"}]}`, wantRaw: "/summarize this", wantCount: 2},
		{name: "Document card", request: `{"raw_message":"report.md","segments":[{"type":"document","content":"report.md","document_id":"document_1","presentation":"card"}]}`, wantRaw: "report.md", wantCount: 1},
		{name: "structured reply context", request: `{"raw_message":"Please review","segments":[{"type":"text","content":"Please review"}],"context_message_ids":["message_1","message_2"]}`, wantRaw: "Please review", wantCount: 1, wantContexts: []string{"message_1", "message_2"}},
		{name: "too many reply contexts", request: `{"raw_message":"Too many","segments":[{"type":"text","content":"Too many"}],"context_message_ids":["message_1","message_2","message_3","message_4","message_5","message_6","message_7","message_8","message_9","message_10","message_11"]}`, wantInvalid: true},
		{name: "duplicate reply context", request: `{"raw_message":"Duplicate","segments":[{"type":"text","content":"Duplicate"}],"context_message_ids":["message_1","message_1"]}`, wantInvalid: true},
		{name: "invalid reply context id", request: `{"raw_message":"Invalid","segments":[{"type":"text","content":"Invalid"}],"context_message_ids":["message/1"]}`, wantInvalid: true},
		{name: "Human runtime kind rejected", request: `{"raw_message":"working","segments":[{"type":"text","content":"working"}],"message_kind":"agent_runtime"}`, wantInvalid: true},
		{name: "missing segments", request: `{"raw_message":"missing"}`, wantInvalid: true},
		{name: "reconstruction mismatch", request: `{"raw_message":"one","segments":[{"type":"text","content":"two"}]}`, wantInvalid: true},
		{name: "invalid skill token", request: `{"raw_message":"summarize","segments":[{"type":"skill","content":"summarize","target":"agent_reviewer","skill_id":"skill_summarize","manifest_version":"1.0.0"}]}`, wantInvalid: true},
		{name: "client supplied file metadata", request: `{"raw_message":"report","segments":[{"type":"file","content":"report","document_id":"document_1","document_version_id":"version_1","filename":"spoof.pdf","media_type":"application/pdf"}]}`, wantInvalid: true},
		{name: "invalid Document presentation", request: `{"raw_message":"report","segments":[{"type":"document","content":"report","document_id":"document_1","presentation":"banner"}]}`, wantInvalid: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var request httpapi.MessageCreateRequest
			if err := json.Unmarshal([]byte(test.request), &request); err != nil {
				t.Fatal(err)
			}
			content, err := NormalizeMessageCreateRequest(request)
			if test.wantInvalid {
				if err == nil {
					t.Fatalf("expected invalid request, got %+v", content)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if content.rawMessage != test.wantRaw || len(content.segments) != test.wantCount {
				t.Fatalf("content=%+v want raw=%q segments=%d", content, test.wantRaw, test.wantCount)
			}
			if !equalStrings(content.contextMessageIDs, test.wantContexts) {
				t.Fatalf("context message ids=%v want=%v", content.contextMessageIDs, test.wantContexts)
			}
		})
	}
}

func TestAppendAttachmentUsesDocumentCard(t *testing.T) {
	content, err := storedMessageContent("Delivered", []byte(`[{"type":"text","content":"Delivered"}]`))
	if err != nil {
		t.Fatal(err)
	}
	content, err = content.appendAttachment("report.md", "document_1")
	if err != nil {
		t.Fatal(err)
	}
	if content.rawMessage != "Delivered\nreport.md" || len(content.segments) != 3 {
		t.Fatalf("content=%+v", content)
	}
	document, err := content.segments[2].AsDocumentSegment()
	if err != nil || document.DocumentId != "document_1" || document.Presentation == nil || *document.Presentation != httpapi.DocumentSegmentPresentationCard {
		t.Fatalf("Document card=%+v err=%v", document, err)
	}
}

func equalStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func TestForwardedMessageContentKeepsFileSegments(t *testing.T) {
	encoded := []byte(`[{"type":"file","content":"report.pdf","document_id":"document_1","document_version_id":"version_1"}]`)
	content, err := forwardedMessageContent("report.pdf", encoded)
	if err != nil {
		t.Fatal(err)
	}
	if len(content.segments) != 1 {
		t.Fatalf("forwarded content=%+v", content)
	}
	file, err := content.segments[0].AsFileSegment()
	if err != nil || file.DocumentId != "document_1" || file.DocumentVersionId != "version_1" {
		t.Fatalf("forwarded file=%+v err=%v", file, err)
	}
}

func TestStoredArtifactTreeMessageCanBeReadAndForwarded(t *testing.T) {
	encoded := []byte(`[{"type":"artifact_tree","content":"Published delivery","publication_group_id":"document_publication_group_1","root_path":"delivery","file_count":2,"directory_count":1,"total_bytes":12474}]`)
	stored, err := storedMessageContent("Published delivery", encoded)
	if err != nil {
		t.Fatal(err)
	}
	if len(stored.segments) != 1 {
		t.Fatalf("stored segments=%d", len(stored.segments))
	}
	forwarded, err := forwardedMessageContent("Published delivery", encoded)
	if err != nil {
		t.Fatal(err)
	}
	if len(forwarded.segments) != 1 {
		t.Fatalf("forwarded segments=%d", len(forwarded.segments))
	}
	text, err := forwarded.segments[0].AsTextSegment()
	if err != nil || text.Content != "Published delivery" {
		t.Fatalf("forwarded segment=%+v err=%v", text, err)
	}
}
