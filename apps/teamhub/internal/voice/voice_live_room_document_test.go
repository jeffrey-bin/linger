package voice

import (
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func TestVoiceLiveReadsTheRoomDocumentItWasAskedFor(t *testing.T) {
	at := func(minute int) pgtype.Timestamptz {
		return pgtype.Timestamptz{Time: time.Date(2026, 11, 2, 20, minute, 0, 0, time.UTC), Valid: true}
	}
	rows := []store.ListVoiceLiveRoomDocumentsRow{
		{DocumentID: "document_a", Title: "きんようびディナーしょうたい", SharedAt: at(54)},
		{DocumentID: "document_b", Title: "Q3 Budget", SharedAt: at(40)},
	}
	for _, check := range []struct{ id, query, want string }{
		{"document_b", "", "document_b"},
		{"", "きんようび ディナー", "document_a"},
		{"", "ディナーしょうたいメールしたがききんようび", ""},
		{"", "q3 budget plan", "document_b"},
		{"", "", "document_a"},
		{"document_x", "", ""},
	} {
		row, ok := voiceLiveRoomDocument(rows, check.id, check.query)
		if got := map[bool]string{true: row.DocumentID}[ok]; got != check.want {
			t.Fatalf("id=%q query=%q: got %q, want %q", check.id, check.query, got, check.want)
		}
	}
}
