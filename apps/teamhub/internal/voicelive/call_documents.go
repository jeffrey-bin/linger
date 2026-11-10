package voicelive

import (
	"encoding/json"
	"fmt"
	"strings"
)

// maxCallDocuments bounds the Documents a provider session starting over in
// the same call is reminded of.
const maxCallDocuments = 8

// ToolCallRecord is one tool call of this call as TeamHub kept it.
type ToolCallRecord struct {
	Name, Arguments, Output string
}

// CallDocument is a Document this call's tools worked on, with the last
// call on it and how that call ended.
type CallDocument struct {
	ID, Title, Last string
}

// CallDocuments lists the Documents the calls named, newest call first. A
// provider session that starts over keeps only the room's messages, so the
// model would otherwise lose which Document it was working on.
func CallDocuments(newestFirst []ToolCallRecord) []CallDocument {
	var documents []CallDocument
	seen := map[string]bool{}
	for _, call := range newestFirst {
		var args, output struct {
			DocumentID string `json:"document_id"`
			Status     string `json:"status"`
			Error      string `json:"error"`
		}
		_ = json.Unmarshal([]byte(call.Arguments), &args)
		_ = json.Unmarshal([]byte(call.Output), &output)
		id := args.DocumentID
		if id == "" {
			id = output.DocumentID
		}
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		outcome := output.Status
		if output.Error != "" {
			outcome = output.Error
		}
		if outcome == "" {
			outcome = "done"
		}
		documents = append(documents, CallDocument{ID: id, Last: call.Name + " → " + outcome})
		if len(documents) == maxCallDocuments {
			break
		}
	}
	return documents
}

// CallDocumentsNote tells the model which Documents this call worked on.
func CallDocumentsNote(documents []CallDocument) string {
	if len(documents) == 0 {
		return ""
	}
	var note strings.Builder
	note.WriteString("\n\nDocuments this call already worked on, newest first. When the user means one of them, use its document_id from here, not one from an older message or a task's title:")
	for _, document := range documents {
		fmt.Fprintf(&note, "\n- %q document_id=%s, last: %s", document.Title, document.ID, document.Last)
	}
	return note.String()
}
