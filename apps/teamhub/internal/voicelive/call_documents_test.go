package voicelive

import (
	"strings"
	"testing"
)

// The Documents a call worked on come back newest first, once each, with
// the last call on each and how it ended.
func TestCallDocumentsNamesEachDocumentsLastCall(t *testing.T) {
	documents := CallDocuments([]ToolCallRecord{
		{Name: "send_email_canvas", Arguments: `{"document_id":"doc_new","confirmed":true}`, Output: `{"status":"needs_confirmation"}`},
		{Name: "search_documents", Arguments: `{"query":"x"}`, Output: `{"documents":[]}`},
		{Name: "edit_email_canvas", Arguments: `{"document_id":"doc_new"}`, Output: `{"status":"changed"}`},
		{Name: "send_email_canvas", Arguments: `{"document_id":"doc_old"}`, Output: `{"error":"already_sent"}`},
		{Name: "open_email_canvas", Arguments: `{"subject":"s"}`, Output: `{"status":"opened","document_id":"doc_first"}`},
		{Name: "edit_document", Arguments: `not json`, Output: ``},
	})
	want := []CallDocument{
		{ID: "doc_new", Last: "send_email_canvas → needs_confirmation"},
		{ID: "doc_old", Last: "send_email_canvas → already_sent"},
		{ID: "doc_first", Last: "open_email_canvas → opened"},
	}
	if len(documents) != len(want) {
		t.Fatalf("documents=%v", documents)
	}
	for index := range want {
		if documents[index] != want[index] {
			t.Fatalf("documents[%d]=%v, want %v", index, documents[index], want[index])
		}
	}
	documents[0].Title = "Wednesday pickup"
	if note := CallDocumentsNote(documents[:1]); !strings.Contains(note, `"Wednesday pickup" document_id=doc_new, last: send_email_canvas → needs_confirmation`) {
		t.Fatalf("note=%q", note)
	}
	if CallDocumentsNote(nil) != "" {
		t.Fatal("a call that worked on no Document has no note")
	}
}
