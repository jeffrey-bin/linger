package tenantmembership

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// lockRecorder records the advisory lock keys a transaction takes.
type lockRecorder struct{ keys []string }

func (r *lockRecorder) Exec(_ context.Context, _ string, args ...any) (pgconn.CommandTag, error) {
	r.keys = append(r.keys, args[0].(string))
	return pgconn.CommandTag{}, nil
}

func (r *lockRecorder) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, errors.New("unexpected Query")
}

func (r *lockRecorder) QueryRow(context.Context, string, ...any) pgx.Row {
	panic("unexpected QueryRow")
}

func TestLockAgentsTakesEachAgentOnceInIDOrder(t *testing.T) {
	recorder := &lockRecorder{}
	if err := LockAgents(t.Context(), store.New(recorder), "actor_c", "", "actor_a", "actor_c", "actor_b"); err != nil {
		t.Fatal(err)
	}
	want := []string{"agent-authority|actor_a", "agent-authority|actor_b", "agent-authority|actor_c"}
	if !slices.Equal(recorder.keys, want) {
		t.Fatalf("keys=%v want=%v", recorder.keys, want)
	}
}

func TestLockAgentKeyHasNoTenant(t *testing.T) {
	recorder := &lockRecorder{}
	if err := LockAgent(t.Context(), store.New(recorder), "actor_a"); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(recorder.keys, []string{"agent-authority|actor_a"}) {
		t.Fatalf("keys=%v", recorder.keys)
	}
}

func TestLockRequiresTenant(t *testing.T) {
	recorder := &lockRecorder{}
	if err := Lock(t.Context(), store.New(recorder), ""); !errors.Is(err, ErrInvalidTenant) {
		t.Fatalf("err=%v", err)
	}
	if len(recorder.keys) != 0 {
		t.Fatalf("keys=%v", recorder.keys)
	}
}
