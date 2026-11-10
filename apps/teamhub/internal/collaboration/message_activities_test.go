package collaboration

import (
	"context"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func TestMessageActivityRecordMatchesNativeTurn(t *testing.T) {
	callIDs := map[string]struct{}{"call-target": {}}
	turnIDs := map[string]struct{}{"turn-target": {}}
	tests := []struct {
		name   string
		record roomagent.RuntimeHistoryRecord
		want   bool
	}{
		{name: "same turn reasoning", record: roomagent.RuntimeHistoryRecord{TurnID: "turn-target", Category: "reasoning"}, want: true},
		{name: "same turn tool", record: roomagent.RuntimeHistoryRecord{TurnID: "turn-target", ToolCallID: "call-target"}, want: true},
		{name: "same call other turn", record: roomagent.RuntimeHistoryRecord{TurnID: "turn-other", ToolCallID: "call-target"}, want: false},
		{name: "other turn", record: roomagent.RuntimeHistoryRecord{TurnID: "turn-other"}, want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := messageActivityRecordMatches(test.record, callIDs, turnIDs); got != test.want {
				t.Fatalf("match=%t want=%t", got, test.want)
			}
		})
	}
}

func TestMessageActivityRecordFallsBackToExactCallWithoutNativeTurn(t *testing.T) {
	callIDs := map[string]struct{}{"call-target": {}}
	if !messageActivityRecordMatches(roomagent.RuntimeHistoryRecord{ToolCallID: "call-target"}, callIDs, nil) {
		t.Fatal("exact tool call did not match")
	}
	if messageActivityRecordMatches(roomagent.RuntimeHistoryRecord{ToolCallID: "call-other"}, callIDs, nil) {
		t.Fatal("unrelated tool call matched")
	}
}

func TestMessageActivityHistoryReadsTheCompleteExactNativeTurn(t *testing.T) {
	inspector := &messageActivityInspectorStub{pages: map[string]roomagent.RuntimeHistory{
		"": {
			Status: "available", ProviderKind: "codex", PreviousCursor: "earlier",
			Records: []roomagent.RuntimeHistoryRecord{
				{Ordinal: 4, TurnID: "turn-target", Category: "reasoning"},
				{Ordinal: 5, TurnID: "turn-target", Category: "message"},
				{Ordinal: 6, TurnID: "turn-neighbor", Category: "message"},
			},
		},
		"earlier": {
			Status: "available", ProviderKind: "codex",
			Records: []roomagent.RuntimeHistoryRecord{
				{Ordinal: 0, Category: "lifecycle"},
				{Ordinal: 1, TurnID: "turn-target", Category: "message"},
				{Ordinal: 2, TurnID: "turn-target", ToolCallID: "call-target", Category: "tool_call"},
				{Ordinal: 3, TurnID: "turn-target", ToolCallID: "call-target", Category: "tool_result"},
			},
		},
	}}
	target := roomagent.RuntimeContextTarget{TenantID: "tenant-1", ContextKey: "context-1"}
	activityIDs := map[string]struct{}{"call-target": {}}

	identity, err := findMessageActivityIdentity(context.Background(), inspector, target, activityIDs)
	if err != nil {
		t.Fatal(err)
	}
	if _, found := identity.turnIDs["turn-target"]; !found {
		t.Fatalf("turn IDs=%v", identity.turnIDs)
	}
	records, truncated, err := readMessageActivityRecords(context.Background(), inspector, target, identity)
	if err != nil {
		t.Fatal(err)
	}
	if truncated {
		t.Fatal("ordinary exact turn was truncated")
	}
	ordinals := make([]int, 0, len(records))
	for _, record := range records {
		ordinals = append(ordinals, record.Ordinal)
	}
	want := []int{1, 2, 3, 4, 5}
	if len(ordinals) != len(want) {
		t.Fatalf("ordinals=%v want=%v", ordinals, want)
	}
	for index := range want {
		if ordinals[index] != want[index] {
			t.Fatalf("ordinals=%v want=%v", ordinals, want)
		}
	}
}

func TestMessageActivityHistoryUsesPersistedNativeActivities(t *testing.T) {
	inspector := &messageActivityInspectorStub{pages: map[string]roomagent.RuntimeHistory{
		"": {Status: "available", ProviderKind: "codex", Records: []roomagent.RuntimeHistoryRecord{
			{Ordinal: 1, TurnID: "target-turn", ToolCallID: "call_cli", Category: "tool_call"},
			{Ordinal: 2, TurnID: "target-turn", Category: "reasoning"},
			{Ordinal: 3, TurnID: "other-turn", ToolCallID: "call_other", Category: "tool_call"},
		}},
	}}
	// A native activity ID: "native-" and the SHA-256 of the tool-call ID.
	for _, activityID := range []string{
		"native-" + "fc510e7a61a20c005db8225b6f1412ae2a8c2c0da9761b75e4667b1d692f676e",
		"call_cli", // Host Claude tool-use ID.
		"activity-" + "e3bb0c30dd84b186f252f69cd20cc9c5", // Local Computer, stable across recovery.
	} {
		activities := map[string]struct{}{activityID: {}}
		identity, err := findMessageActivityIdentity(context.Background(), inspector, roomagent.RuntimeContextTarget{}, activities, "operation_local")
		if err != nil {
			t.Fatal(err)
		}
		records, _, err := readMessageActivityRecords(context.Background(), inspector, roomagent.RuntimeContextTarget{}, identity)
		if err != nil || len(records) != 2 || records[0].TurnID != "target-turn" || records[1].TurnID != "target-turn" {
			t.Fatalf("activity=%s records=%+v err=%v", activityID, records, err)
		}
	}
}

type messageActivityInspectorStub struct {
	pages map[string]roomagent.RuntimeHistory
}

func (s *messageActivityInspectorStub) ReadRuntimeHistory(
	_ context.Context,
	_ roomagent.RuntimeContextTarget,
	options roomagent.RuntimeHistoryReadOptions,
) (roomagent.RuntimeHistory, error) {
	cursor := ""
	if options.Cursor != nil {
		cursor = *options.Cursor
	}
	return s.pages[cursor], nil
}

func TestTaskActivityNeverReadsNativeHistory(t *testing.T) {
	// No native reader or database: both public native activity routes share this guard.
	log, err := (&Service{}).runtimeActivityLog(t.Context(), runActivitySource{task: true}, nil)
	if err != nil || log.Status != httpapi.MessageActivityLogStatusUnavailable {
		t.Fatalf("native Task history log: %+v %v", log, err)
	}
}
