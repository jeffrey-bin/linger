package roomattention

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// fakeDB records the arguments of each statement by sqlc query name.
type fakeDB struct {
	args map[string][]any
}

func (f *fakeDB) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	f.args[sqlName(sql)] = args
	return pgconn.CommandTag{}, nil
}

func (f *fakeDB) Query(context.Context, string, ...any) (pgx.Rows, error) {
	panic("unexpected query")
}

func (f *fakeDB) QueryRow(context.Context, string, ...any) pgx.Row {
	panic("unexpected query")
}

// sqlName reads the name from sqlc's "-- name: Name :kind" header.
func sqlName(sql string) string {
	return strings.Fields(sql)[2]
}

func TestAppendForTenantHumansPublishesOneRoomHint(t *testing.T) {
	db := &fakeDB{args: map[string][]any{}}
	if err := AppendForTenantHumans(t.Context(), store.New(db), RoomSummaryUpdate{
		TenantID: "tenant_a", RoomID: "room_a", RoomSeq: 12, Reason: "work_item.changed",
	}); err != nil {
		t.Fatal(err)
	}
	// topic, kind, resource_id, room_seq
	if hint := db.args["PublishInvalidation"]; !reflect.DeepEqual(hint, []any{"tenant:tenant_a", "invalidate.room", "room_a", int64(12)}) {
		t.Fatalf("invalidation=%v", db.args)
	}
}
