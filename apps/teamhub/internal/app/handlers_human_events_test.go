package app

import (
	"reflect"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/realtime"
)

func TestParseRoomCursors(t *testing.T) {
	cursors, ok := parseRoomCursors([]string{"room_a:7", "room_b:0", "room_a:3"})
	if !ok || !reflect.DeepEqual(cursors, map[string]int64{"room_a": 3, "room_b": 0}) {
		t.Fatalf("cursors=%v ok=%t", cursors, ok)
	}
	tooMany := make([]string, maxEventStreamRoomCursors+1)
	for index := range tooMany {
		tooMany[index] = "room_a:1"
	}
	for _, values := range [][]string{
		{"room_a"}, {"room_a:-1"}, {":4"}, {"room:a:4"}, {"room_a:99999999999999999999"},
		{strings.Repeat("r", 65) + ":1"}, tooMany,
	} {
		if _, ok := parseRoomCursors(values); ok {
			t.Fatalf("accepted %v", values[0])
		}
	}
}

func TestClassifyHumanWakes(t *testing.T) {
	cursors := map[string]int64{"room_active": 5}
	burst := classifyHumanWakes([]realtime.Event{
		{Topic: "room:room_active", Kind: "room.event", ResourceID: "e1", Sequence: 5},
		{Topic: "room:room_other", Kind: "room.event", ResourceID: "e2", Sequence: 2},
		{Topic: "room:room_active", Kind: "room.event", ResourceID: "e3", Sequence: 6},
		{Topic: "room:room_active", Kind: "room.event", ResourceID: "e4", Sequence: 7},
		{Topic: "room:room_other", Kind: "room.event", ResourceID: "e5", Sequence: 4},
		{Topic: "tenant:tenant_1", Kind: "invalidate.room", ResourceID: "room_x", Sequence: 2},
		{Topic: "tenant:tenant_1", Kind: "invalidate.room", ResourceID: "room_x", Sequence: 3},
		{Topic: "tenant:tenant_1", Kind: "invalidate.document", ResourceID: "document_1"},
		{Topic: "tenant:tenant_1", Kind: "invalidate.document", ResourceID: "document_1"},
	}, cursors)
	if burst.reconcile || !reflect.DeepEqual(burst.cursorRooms, []string{"room_active"}) ||
		!reflect.DeepEqual(burst.otherRooms, map[string]int64{"room_other": 4}) {
		t.Fatalf("burst=%+v", burst)
	}
	wantHints := []realtime.Invalidation{
		{TenantID: "tenant_1", Resource: realtime.InvalidateRoom, ID: "room_x", RoomSeq: 3},
		{TenantID: "tenant_1", Resource: realtime.InvalidateDocument, ID: "document_1"},
	}
	if !reflect.DeepEqual(burst.hints, wantHints) {
		t.Fatalf("hints=%+v", burst.hints)
	}
	if stale := classifyHumanWakes([]realtime.Event{{Topic: "room:room_active", Kind: "room.event", Sequence: 4}}, cursors); len(stale.cursorRooms) != 0 {
		t.Fatalf("an applied room_seq reread the Room: %+v", stale)
	}
	if reconcile := classifyHumanWakes([]realtime.Event{{Topic: realtime.HumanEventsTopic, Kind: realtime.ReconcileKind}}, cursors); !reconcile.reconcile {
		t.Fatal("reconcile was not reported")
	}
}
