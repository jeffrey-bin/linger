package messagecreation

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func TestMessageRunWithoutClaimLookup(t *testing.T) {
	// Standalone commands need no execution state, and trusted callbacks keep
	// their known Run even when a request happens to carry a different claim.
	for _, test := range []struct {
		claim, trusted, want string
	}{
		{},
		{trusted: "trusted-run", want: "trusted-run"},
		{claim: "untrusted-run", trusted: "trusted-run", want: "trusted-run"},
	} {
		ctx := WithRunClaim(t.Context(), test.claim)
		got, err := messageRun(ctx, nil, Draft{TrustedRunID: test.trusted})
		if err != nil || got.String != test.want || got.Valid != (test.want != "") {
			t.Errorf("claim=%q trusted=%q: got=%+v err=%v", test.claim, test.trusted, got, err)
		}
	}
}

func TestResolveRunClaimDoesNotHideLookupFailure(t *testing.T) {
	unavailable := errors.New("database unavailable")
	for _, test := range []struct {
		name string
		err  error
		want string
	}{
		{name: "eligible Run", want: "claimed-run"},
		{name: "ineligible Run", err: pgx.ErrNoRows},
		{name: "dependency failure", err: unavailable},
	} {
		t.Run(test.name, func(t *testing.T) {
			db := &runClaimDB{err: test.err}
			got, err := ResolveRunClaim(WithRunClaim(t.Context(), "claimed-run"), store.New(db), "tenant", "agent", "room")
			if errors.Is(test.err, unavailable) {
				if !errors.Is(err, unavailable) {
					t.Fatalf("lookup failure must abort the write: %v", err)
				}
				return
			}
			if err != nil || got.String != test.want || got.Valid != (test.want != "") {
				t.Fatalf("Run=%+v err=%v want %q", got, err, test.want)
			}
		})
	}
}

type runClaimDB struct {
	store.DBTX
	err error
}

func (db *runClaimDB) QueryRow(context.Context, string, ...any) pgx.Row {
	return runClaimRow{err: db.err}
}

type runClaimRow struct{ err error }

func (row runClaimRow) Scan(dest ...any) error {
	if row.err == nil {
		*dest[0].(*string) = "claimed-run"
	}
	return row.err
}
