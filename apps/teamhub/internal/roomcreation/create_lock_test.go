package roomcreation

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

var errStopAfterLocks = errors.New("stop after locks")

// lockRecorder records advisory lock keys and fails the first read, so a test
// sees exactly the locks taken before any row is touched.
type lockRecorder struct{ keys []string }

func (r *lockRecorder) Exec(_ context.Context, _ string, args ...any) (pgconn.CommandTag, error) {
	r.keys = append(r.keys, args[0].(string))
	return pgconn.CommandTag{}, nil
}

func (r *lockRecorder) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, errStopAfterLocks
}

func (r *lockRecorder) QueryRow(context.Context, string, ...any) pgx.Row {
	return failedRow{}
}

type failedRow struct{}

func (failedRow) Scan(...any) error { return errStopAfterLocks }

func TestCreateLocksAdmittedAgentsFirst(t *testing.T) {
	human := store.Actor{ID: "actor_human", TenantID: "tenant", Kind: "human"}
	agent := store.Actor{ID: "actor_creator", TenantID: "tenant", Kind: "agent"}
	for _, test := range []struct {
		name    string
		creator store.Actor
		want    []string
	}{
		{"Human creator", human, []string{"agent-authority|actor_m1", "agent-authority|actor_m2"}},
		{"Agent creator", agent, []string{"agent-authority|actor_creator", "agent-authority|actor_m1", "agent-authority|actor_m2"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			recorder := &lockRecorder{}
			// An empty name fails validation right after the locks.
			_, err := Create(t.Context(), store.New(recorder), Spec{
				TenantID: "tenant", Creator: test.creator, Owner: human, MemberActorIDs: []string{"actor_m2", "actor_m1"},
			})
			if !errors.Is(err, ErrInvalid) {
				t.Fatalf("err=%v", err)
			}
			if !slices.Equal(recorder.keys, test.want) {
				t.Fatalf("keys=%v want=%v", recorder.keys, test.want)
			}
		})
	}
}

func TestOpenOrCreateDirectRoomLocksTheAgentFirst(t *testing.T) {
	recorder := &lockRecorder{}
	_, err := OpenOrCreateDirectRoom(t.Context(), store.New(recorder), DirectSpec{
		TenantID: "tenant",
		Human:    store.Actor{ID: "actor_human", TenantID: "tenant", Kind: "human"},
		Agent:    store.Actor{ID: "actor_agent", TenantID: "tenant", Kind: "agent"},
	})
	if !errors.Is(err, errStopAfterLocks) {
		t.Fatalf("err=%v", err)
	}
	want := []string{"agent-authority|actor_agent", "direct-room|tenant|actor_human|actor_agent"}
	if !slices.Equal(recorder.keys, want) {
		t.Fatalf("keys=%v want=%v", recorder.keys, want)
	}
}
