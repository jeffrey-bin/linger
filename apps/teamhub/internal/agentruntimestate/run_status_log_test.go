package agentruntimestate

import (
	"encoding/json"
	"testing"

	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func TestOutputsAndTheStoppedEventCloseTheirSegment(t *testing.T) {
	for _, test := range []struct {
		eventType string
		payload   string
		closes    bool
	}{
		{"presentation.output_created", `{"type":"presentation.output_created"}`, true},
		{"status.changed", `{"type":"status.changed","status":"stopped","outcome":"completed"}`, true},
		{"status.changed", `{"type":"status.changed","status":"working"}`, false},
		{"status.changed", `{"type":"status.changed","status":"queued"}`, false},
		{"activity.finished", `{"type":"activity.finished","activity_id":"a","outcome":"succeeded"}`, false},
		{"plan.updated", `{"type":"plan.updated","steps":[]}`, false},
	} {
		if got := closesSegment(test.eventType, json.RawMessage(test.payload)); got != test.closes {
			t.Fatalf("%s %s closes=%t want %t", test.eventType, test.payload, got, test.closes)
		}
	}
}

func TestPublicRunStatusShowsUnfinishedRunsAsActive(t *testing.T) {
	for status, want := range map[string]httpapi.RoomRunStatusState{
		"queued": httpapi.RoomRunStatusStateActive, "running": httpapi.RoomRunStatusStateActive,
		"succeeded": httpapi.RoomRunStatusStateCompleted,
		"failed":    httpapi.RoomRunStatusStateAborted, "canceled": httpapi.RoomRunStatusStateAborted,
	} {
		if got := PublicRunStatus(status); got != want {
			t.Fatalf("%s -> %s, want %s", status, got, want)
		}
	}
}

func TestSegmentIDsAreStablePerRunAndOrdinal(t *testing.T) {
	first, again, second := deriveSegmentID("run-1", 1), deriveSegmentID("run-1", 1), deriveSegmentID("run-1", 2)
	if first != again || first == second || first == deriveSegmentID("run-2", 1) {
		t.Fatalf("segment IDs %s %s %s", first, again, second)
	}
}
