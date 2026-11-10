package agentsendmessage

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestAtomicIntentHashIgnoresStagingIdentityButPreservesOrderedBusinessInput(t *testing.T) {
	input := Input{InvocationID: "agent-invocation-sha256:" + strings.Repeat("a", 64), InboxID: "room:room_example", Atomic: &AtomicInput{Segments: []PreparedSegment{{Type: "document", UploadID: "upload_0"}}, Uploads: []PreparedUpload{{UploadID: "upload_0", Filename: "report.pdf", RepresentationFormat: "pdf", MediaType: "application/pdf", SizeBytes: 3, SHA256: strings.Repeat("b", 64), ObjectKey: "object_first"}}}}
	first, err := normalizeAtomicInput(input)
	if err != nil {
		t.Fatal(err)
	}
	input.Atomic.Uploads[0].ObjectKey = "object_retry"
	second, err := normalizeAtomicInput(input)
	if err != nil {
		t.Fatal(err)
	}
	if first.canonicalRequestHash != second.canonicalRequestHash {
		t.Fatal("transport staging identity changed business receipt")
	}
	input.Atomic.Uploads[0].SHA256 = strings.Repeat("c", 64)
	changed, err := normalizeAtomicInput(input)
	if err != nil {
		t.Fatal(err)
	}
	if first.canonicalRequestHash == changed.canonicalRequestHash {
		t.Fatal("different bytes reused business receipt")
	}
}
func TestAtomicIntentRejectsMixedBranchesAndUnusedUploads(t *testing.T) {
	base := Input{InvocationID: "agent-invocation-sha256:" + strings.Repeat("a", 64), InboxID: "room:room_example"}
	for _, intent := range []*AtomicInput{
		{Segments: []PreparedSegment{{Type: "text", Content: "ok", DocumentID: "document_smuggled"}}},
		{Segments: []PreparedSegment{{Type: "fragment", Content: "<p>ok</p>", UploadID: "upload_0"}}},
		{Segments: []PreparedSegment{{Type: "text", Content: "ok"}}, Uploads: []PreparedUpload{{UploadID: "upload_0", Filename: "x", RepresentationFormat: "bin", MediaType: "application/octet-stream", SHA256: strings.Repeat("b", 64)}}},
		{Segments: []PreparedSegment{{Type: "document", UploadID: "missing"}}},
	} {
		base.Atomic = intent
		if _, err := normalizeAtomicInput(base); err == nil {
			t.Fatalf("accepted %#v", intent)
		}
	}
}

func TestAtomicExistingDocumentAcceptsCanvasPresentation(t *testing.T) {
	base := Input{InvocationID: "agent-invocation-sha256:" + strings.Repeat("a", 64), InboxID: "room:room_example"}
	base.Atomic = &AtomicInput{Segments: []PreparedSegment{{Type: "document", Content: "Email to Lisa", DocumentID: "document_canvas", Presentation: "canvas"}}}
	if _, err := normalizeAtomicInput(base); err != nil {
		t.Fatalf("canvas rejected: %v", err)
	}
	base.Atomic.Segments[0].Presentation = "banner"
	if _, err := normalizeAtomicInput(base); err == nil {
		t.Fatal("unknown presentation accepted")
	}
}

func TestAtomicSegmentDoesNotDropForbiddenEmptyProperties(t *testing.T) {
	var intent AtomicInput
	if err := json.Unmarshal([]byte(`{"segments":[{"type":"text","content":"ok","document_id":""}],"uploads":[]}`), &intent); err != nil {
		t.Fatal(err)
	}
	if err := ValidateAtomicInput(Input{InvocationID: "agent-invocation-sha256:" + strings.Repeat("a", 64), InboxID: "room:room_example", Atomic: &intent}); err == nil {
		t.Fatal("empty forbidden field disappeared before strict branch validation")
	}
}
func TestAtomicIntentRejectsImageAndVideoBranches(t *testing.T) {
	// Images and videos are ordinary documents; there is no media branch.
	for _, kind := range []string{"image", "video"} {
		intent := AtomicInput{Segments: []PreparedSegment{{Type: kind, DocumentID: "document_example"}}}
		if err := ValidateAtomicInput(Input{InvocationID: "agent-invocation-sha256:" + strings.Repeat("a", 64), InboxID: "room:room_example", Atomic: &intent}); err == nil {
			t.Fatalf("%s branch accepted", kind)
		}
	}
}

func TestContinuesDeclarationIsPartOfRequestIdentity(t *testing.T) {
	text := Input{InvocationID: "agent-invocation-sha256:" + strings.Repeat("a", 64), InboxID: "room:room_example", Atomic: &AtomicInput{Segments: []PreparedSegment{{Type: "text", Content: "On it"}}}}
	upload := Input{InvocationID: text.InvocationID, InboxID: text.InboxID, Atomic: &AtomicInput{Segments: []PreparedSegment{{Type: "document", UploadID: "upload_0"}}, Uploads: []PreparedUpload{{UploadID: "upload_0", Filename: "report.pdf", RepresentationFormat: "pdf", MediaType: "application/pdf", SizeBytes: 3, SHA256: strings.Repeat("b", 64)}}}}
	for name, input := range map[string]Input{"text": text, "upload": upload} {
		final, err := normalizeAtomicInput(input)
		if err != nil {
			t.Fatal(err)
		}
		input.Continues = true
		continuing, err := normalizeAtomicInput(input)
		if err != nil {
			t.Fatal(err)
		}
		replay, err := normalizeAtomicInput(input)
		if err != nil {
			t.Fatal(err)
		}
		if final.canonicalRequestHash == continuing.canonicalRequestHash {
			t.Fatalf("%s: same invocation with a different continuation declaration reused the receipt", name)
		}
		if continuing.canonicalRequestHash != replay.canonicalRequestHash {
			t.Fatalf("%s: identical continuing replay changed request identity", name)
		}
	}
}

func TestAtomicFragmentNeedsOneShortTitleLine(t *testing.T) {
	base := Input{InvocationID: "agent-invocation-sha256:" + strings.Repeat("a", 64), InboxID: "room:room_example"}
	fragment := func(title string) *AtomicInput {
		return &AtomicInput{Segments: []PreparedSegment{{Type: "fragment", Content: "<p>ok</p>", Title: title}}}
	}
	base.Atomic = fragment("Launch tracker")
	normalized, err := normalizeAtomicInput(base)
	if err != nil {
		t.Fatalf("titled fragment rejected: %v", err)
	}
	if got := normalized.content.Segments[0].Content; got != "Launch tracker" {
		t.Fatalf("fragment previews as %q, want its title", got)
	}
	for _, title := range []string{"", " padded", "two\nlines", strings.Repeat("あ", 121)} {
		base.Atomic = fragment(title)
		if _, err := normalizeAtomicInput(base); err == nil {
			t.Fatalf("accepted fragment title %q", title)
		}
	}
}
