package typedcard

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
)

func TestRoomCreationHandoffTextCarriesRequestFactsAndDeliveredDocumentsOnly(t *testing.T) {
	purpose := "  Draft the launch plan.  "
	blank := "   "
	delivered := []RoomCreationArtifactSnapshot{{DocumentID: "doc-ok", DocumentVersionID: "version-1"}}
	decidedAt := time.Date(2026, 10, 22, 17, 39, 0, 123456000, time.FixedZone("CST", 8*60*60))
	for _, test := range []struct {
		name        string
		description *string
		wantPurpose string
	}{
		{"description", &purpose, "Draft the launch plan."},
		{"nil description", nil, ""},
		{"blank description", &blank, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			text, err := roomCreationHandoffText("request-1", "card-1", "room-origin", "room-new", test.description, delivered,
				"actor-owner", decidedAt)
			if err != nil {
				t.Fatal(err)
			}
			payloadText := strings.SplitN(strings.TrimPrefix(text, " Room creation handoff="), "\n", 2)[0]
			var payload map[string]any
			if err := json.Unmarshal([]byte(payloadText), &payload); err != nil {
				t.Fatalf("payload %q: %v", payloadText, err)
			}
			if payload["kind"] != "room_creation_handoff" || payload["creation_approval_request_id"] != "request-1" ||
				payload["approval_card_message_id"] != "card-1" || payload["origin_room_id"] != "room-origin" ||
				payload["origin_room_inbox_id"] != "room:room-origin" || payload["room_inbox_id"] != "room:room-new" {
				t.Fatalf("payload=%v", payload)
			}
			if payload["decision"] != "approved" || payload["decided_by"] != "actor-owner" ||
				payload["decided_at"] != "2026-10-22T09:39:00.123456Z" {
				t.Fatalf("decision fields=%v", payload)
			}
			got, present := payload["purpose"]
			if test.wantPurpose == "" {
				if present || strings.Contains(text, "purpose") {
					t.Fatalf("empty description must omit purpose: %s", text)
				}
			} else if got != test.wantPurpose {
				t.Fatalf("purpose=%v want %q", got, test.wantPurpose)
			}
			artifacts, ok := payload["delivered_artifacts"].([]any)
			if !ok || len(artifacts) != 1 || artifacts[0].(map[string]any)["document_id"] != "doc-ok" {
				t.Fatalf("delivered_artifacts=%v", payload["delivered_artifacts"])
			}
			for _, forbidden := range []string{"skipped"} {
				if strings.Contains(text, forbidden) {
					t.Fatalf("handoff contains %q: %s", forbidden, text)
				}
			}
			for _, expected := range []string{"<room-handoff-pattern>", "room:room-new", "teamhub docs get", "teamhub message read."} {
				if !strings.Contains(text, expected) {
					t.Fatalf("handoff missing %q: %s", expected, text)
				}
			}
		})
	}
	empty, err := roomCreationHandoffText("request-2", "card-2", "room-origin", "room-new", nil, nil, "actor-owner", decidedAt)
	if err != nil || !strings.Contains(empty, `"delivered_artifacts":[]`) {
		t.Fatalf("empty handoff=%q err=%v", empty, err)
	}
}

func TestRoomCreationHandoffMessageIDIsDerivedFromRequest(t *testing.T) {
	first := roomCreationHandoffMessageID("request-1")
	if first != roomCreationHandoffMessageID("request-1") || first == roomCreationHandoffMessageID("request-2") ||
		!strings.HasPrefix(first, "message_") || len(first) != len("message_")+32 {
		t.Fatalf("handoff message ID=%q", first)
	}
}

func TestRoomCreationRuntimeSummaryReportsAddressAndDelivery(t *testing.T) {
	summary, err := roomCreationRuntimeSummary("request-1", "room-new", "New Room",
		[]RoomCreationArtifactSnapshot{{DocumentID: "doc-ok", DocumentVersionID: "version-1"}},
		[]roomCreationSkippedArtifact{{DocumentID: "doc-gone", Reason: "document_unavailable"}})
	if err != nil {
		t.Fatal(err)
	}
	payloadText := strings.SplitN(strings.TrimPrefix(summary, " Room creation approval result="), "\n", 2)[0]
	var payload struct {
		RoomID    string                         `json:"created_room_id"`
		InboxID   string                         `json:"created_room_inbox_id"`
		Name      string                         `json:"created_room_name"`
		Delivered []RoomCreationArtifactSnapshot `json:"delivered_artifacts"`
		Skipped   []roomCreationSkippedArtifact  `json:"skipped_artifacts"`
	}
	if err := json.Unmarshal([]byte(payloadText), &payload); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(summary, `"reason":"delivered"`) {
		t.Fatalf("delivery reason missing: %s", summary)
	}
	if payload.RoomID != "room-new" || payload.InboxID != "room:room-new" || payload.Name != "New Room" || len(payload.Delivered) != 1 || len(payload.Skipped) != 1 {
		t.Fatalf("payload=%+v", payload)
	}
	for _, expected := range []string{"<room-communication-pattern>", "cannot send", "initial message", "room:room-new"} {
		if !strings.Contains(summary, expected) {
			t.Fatalf("summary missing %q: %s", expected, summary)
		}
	}
	emptySummary, err := roomCreationRuntimeSummary("request-2", "room-empty", "Empty", nil, nil)
	if err != nil || !strings.Contains(emptySummary, `"delivered_artifacts":[]`) || !strings.Contains(emptySummary, `"skipped_artifacts":[]`) {
		t.Fatalf("empty summary=%q err=%v", emptySummary, err)
	}
}

func TestRoomCreationInitialSegmentsExcludeSkippedDocuments(t *testing.T) {
	segments := []messagecreation.Segment{
		{Type: "text", Content: "Start."},
		{Type: "document", DocumentID: "doc-ok", Content: "Keep", Presentation: "card"},
		{Type: "document", DocumentID: "doc-gone", Content: "Skip", Presentation: "card"},
	}
	got := roomCreationInitialSegments(segments, []roomCreationSkippedArtifact{{DocumentID: "doc-gone", Reason: "document_unavailable"}})
	if len(got) != 2 || got[0].Content != "Start." || got[1].DocumentID != "doc-ok" {
		t.Fatalf("segments=%+v", got)
	}
	if len(segments) != 3 || segments[2].DocumentID != "doc-gone" {
		t.Fatal("mutated frozen snapshot")
	}
}
