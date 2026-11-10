package roomevent

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// fakeDB answers the single-row statements Append issues, by sqlc query name.
type fakeDB struct {
	seq      int64
	allocErr error
	calls    []string
	inserted []any
	// published is how many Messages CreateMessageCreatedRoomEvent stamps.
	published int64
}

func (f *fakeDB) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, errors.New("unexpected Exec")
}

func (f *fakeDB) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, errors.New("unexpected Query")
}

func (f *fakeDB) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	name := strings.Fields(sql)[2]
	f.calls = append(f.calls, name)
	if name == "CreateRoomEvent" {
		f.inserted = args
		// event_id, tenant_id, room_id, room_seq, event_type, actor_id, resource_id, payload, occurred_at
		return fakeRow{values: append(append([]any{}, args...), nil)}
	}
	if name == "CreateMessageCreatedRoomEvent" {
		f.inserted = args
		return fakeRow{values: []any{args[3], f.published}}
	}
	if f.allocErr != nil {
		return fakeRow{err: f.allocErr}
	}
	return fakeRow{values: []any{f.seq}}
}

type fakeRow struct {
	values []any
	err    error
}

func (r fakeRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	for index, value := range r.values {
		if value != nil {
			reflect.ValueOf(dest[index]).Elem().Set(reflect.ValueOf(value))
		}
	}
	return nil
}

func TestAppendAllocatesFromTheSelectedRoomStates(t *testing.T) {
	for allocation, want := range map[Allocation]string{
		ActiveRoomSeq:    "AllocateRoomSeq",
		DeletingRoomSeq:  "AllocateDeletingRoomSeq",
		LifecycleRoomSeq: "AllocateRoomLifecycleSeq",
	} {
		db := &fakeDB{seq: 7}
		seq, err := Append(t.Context(), store.New(db), Input{
			TenantID: "tenant_a", RoomID: "room_a", EventType: "room.updated",
			ActorID: "actor_a", ResourceID: "room_a", Payload: map[string]any{"kind": "room.updated"},
			Allocation: allocation,
		})
		if err != nil {
			t.Fatal(err)
		}
		if seq != 7 || !reflect.DeepEqual(db.calls, []string{want, "CreateRoomEvent"}) {
			t.Fatalf("allocation %d: seq=%d calls=%v", allocation, seq, db.calls)
		}
		if db.inserted[3] != int64(7) || string(db.inserted[7].([]byte)) != `{"kind":"room.updated"}` {
			t.Fatalf("allocation %d inserted %v", allocation, db.inserted)
		}
	}
}

func TestAppendNamesEventsRandomlyUnlessTheWriterGivesAnID(t *testing.T) {
	db := &fakeDB{seq: 1}
	if _, err := Append(t.Context(), store.New(db), Input{RoomID: "room_a", Payload: struct{}{}}); err != nil {
		t.Fatal(err)
	}
	if id := db.inserted[0].(string); !regexp.MustCompile(`^event_[0-9a-f]{32}$`).MatchString(id) {
		t.Fatalf("random event ID %q", id)
	}
	if _, err := Append(t.Context(), store.New(db), Input{RoomID: "room_a", Payload: struct{}{}, EventID: "event_fixed"}); err != nil {
		t.Fatal(err)
	}
	if db.inserted[0] != "event_fixed" {
		t.Fatalf("deterministic event ID %v", db.inserted[0])
	}
}

func TestAppendRecordsNothingWhenTheRoomCannotAllocate(t *testing.T) {
	db := &fakeDB{allocErr: pgx.ErrNoRows}
	_, err := Append(t.Context(), store.New(db), Input{RoomID: "room_deleted", Payload: struct{}{}})
	if !errors.Is(err, pgx.ErrNoRows) || len(db.calls) != 1 {
		t.Fatalf("err=%v calls=%v", err, db.calls)
	}
}

func TestAppendMessageCreatedStampsExactlyOneUnpublishedMessage(t *testing.T) {
	db := &fakeDB{seq: 9, published: 1}
	seq, err := AppendMessageCreated(t.Context(), store.New(db), Input{
		TenantID: "tenant_a", RoomID: "room_a", ActorID: "actor_a", ResourceID: "message_a",
		Payload: map[string]any{"kind": "message.created"},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if seq != 9 || !reflect.DeepEqual(db.calls, []string{"AllocateRoomSeq", "CreateMessageCreatedRoomEvent"}) {
		t.Fatalf("seq=%d calls=%v", seq, db.calls)
	}
	// event_id, tenant_id, room_id, room_seq, actor_id, message_id, payload, mentioned_actor_ids
	if db.inserted[5] != "message_a" || !reflect.DeepEqual(db.inserted[7], []string{}) {
		t.Fatalf("inserted %v", db.inserted)
	}
	db = &fakeDB{seq: 10, published: 0}
	if _, err := AppendMessageCreated(t.Context(), store.New(db), Input{
		TenantID: "tenant_a", RoomID: "room_a", ResourceID: "message_a", Payload: struct{}{},
	}, []string{"actor_b"}); !errors.Is(err, ErrMessagePublished) {
		t.Fatalf("republished Message: %v", err)
	}
}

func TestMemberRemovedCarriesThePublicRoomMember(t *testing.T) {
	encoded, err := json.Marshal(MemberRemoved(httpapi.RoomMember{
		RoomId: "room_a", Role: httpapi.RoomMemberRole("member"),
		Actor:   httpapi.ActorRef{Id: "actor_a", TenantId: "tenant_a", Kind: httpapi.ActorKind("human"), DisplayName: "A"},
		AddedBy: httpapi.ActorRef{Id: "actor_b", TenantId: "tenant_a", Kind: httpapi.ActorKind("human"), DisplayName: "B"},
	}))
	if err != nil {
		t.Fatal(err)
	}
	var payload struct {
		Kind   string `json:"kind"`
		Member struct {
			RoomID string `json:"room_id"`
			Actor  struct {
				ID string `json:"id"`
			} `json:"actor"`
		} `json:"member"`
	}
	if err := json.Unmarshal(encoded, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Kind != "room.member.removed" || payload.Member.RoomID != "room_a" || payload.Member.Actor.ID != "actor_a" {
		t.Fatalf("payload %s", encoded)
	}
}
