package mcpcontext

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func TestResolveIdentitySelectsOneLockedQueryPerAuthority(t *testing.T) {
	for _, scenario := range identityQueryScenarios() {
		t.Run(scenario.name, func(t *testing.T) {
			db := &identityQueryDB{t: t}
			identity, err := resolveIdentity(t.Context(), store.New(db), "agent", scenario.ref)
			if err != nil {
				t.Fatal(err)
			}
			want := Identity{
				AgentID: "agent", AgentActorID: "locked-actor", TenantID: "locked-tenant",
				AgentType: "general", UserArtifactOwnerActorID: "locked-owner",
				ContextKind: scenario.ref.Kind, RoomID: scenario.ref.RoomID, TaskID: scenario.ref.TaskID,
			}
			if scenario.ref.RoomID != "" {
				want.MembershipEpochID = "locked-epoch"
			}
			if identity != want {
				t.Fatalf("identity=%+v want=%+v", identity, want)
			}
			queries := []string{"GetActiveMcpContextAgentForShare", scenario.query + "ForShare"}
			if !slices.Equal(db.calls, queries) {
				t.Fatalf("queries=%v want=%v", db.calls, queries)
			}
		})
	}
}

func TestResolveIdentityRejectsRetiredBuilderBeforeResolvingResource(t *testing.T) {
	db := &identityQueryDB{t: t, agentType: "builder"}
	identity, err := resolveIdentity(t.Context(), store.New(db), "agent", ContextRef{Kind: "meta", RoomID: "room"})
	if !errors.Is(err, ErrIdentityInvalid) || identity != (Identity{}) {
		t.Fatalf("retired Builder identity=%+v error=%v", identity, err)
	}
	if !slices.Equal(db.calls, []string{"GetActiveMcpContextAgentForShare"}) {
		t.Fatalf("retired Builder resolved resource authority: %v", db.calls)
	}
}

func TestResolveIdentityRejectsMetaWithoutRoom(t *testing.T) {
	db := &identityQueryDB{t: t}
	identity, err := resolveIdentity(t.Context(), store.New(db), "agent", ContextRef{Kind: "meta"})
	if !errors.Is(err, ErrIdentityInvalid) || identity != (Identity{}) {
		t.Fatalf("room-less Meta identity=%+v error=%v", identity, err)
	}
	if !slices.Equal(db.calls, []string{"GetActiveMcpContextAgentForShare"}) {
		t.Fatalf("room-less Meta resolved resource authority: %v", db.calls)
	}
}

func TestResolveIdentityFailuresDoNotFallBack(t *testing.T) {
	queryFailure := errors.New("authority query failed")
	for _, scenario := range identityQueryScenarios() {
		for _, failureAt := range []string{"GetActiveMcpContextAgentForShare", scenario.query + "ForShare"} {
			for _, failure := range []error{pgx.ErrNoRows, queryFailure} {
				t.Run(scenario.name+"/"+failureAt+"/"+failure.Error(), func(t *testing.T) {
					db := &identityQueryDB{t: t, failureAt: failureAt, failure: failure}
					identity, err := resolveIdentity(t.Context(), store.New(db), "agent", scenario.ref)
					wantErr := failure
					if errors.Is(failure, pgx.ErrNoRows) {
						wantErr = ErrIdentityInvalid
					}
					if !errors.Is(err, wantErr) || identity != (Identity{}) {
						t.Fatalf("identity=%+v error=%v want empty identity and %v", identity, err, wantErr)
					}
					queries := []string{"GetActiveMcpContextAgentForShare"}
					if failureAt != queries[0] {
						queries = append(queries, failureAt)
					}
					if !slices.Equal(db.calls, queries) {
						t.Fatalf("queries=%v want=%v", db.calls, queries)
					}
				})
			}
		}
	}
}

func identityQueryScenarios() []struct {
	name  string
	ref   ContextRef
	query string
} {
	return []struct {
		name  string
		ref   ContextRef
		query string
	}{
		{"per-room", ContextRef{Kind: "meta", RoomID: "room"}, "AuthorizePerRoomMetaMcpContext"},
		{"alter-ego", ContextRef{Kind: "alter_ego", TaskID: "task"}, "AuthorizeAlterEgoMcpContext"},
	}
}

type identityQueryDB struct {
	store.DBTX
	t         *testing.T
	calls     []string
	failureAt string
	failure   error
	agentType string
}

func (db *identityQueryDB) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	name := strings.Fields(sql)[2] // sqlc's named query header.
	db.calls = append(db.calls, name)
	return identityQueryRow(func(dest ...any) error {
		if name == db.failureAt {
			return db.failure
		}
		source := "locked"
		*dest[0].(*string), *dest[1].(*string) = source+"-actor", source+"-tenant"
		switch strings.TrimSuffix(name, "ForShare") {
		case "GetActiveMcpContextAgent":
			*dest[2].(*pgtype.Text) = pgtype.Text{String: "agent", Valid: true}
			*dest[3].(*string) = "general"
			if db.agentType != "" {
				*dest[3].(*string) = db.agentType
			}
			*dest[4].(*pgtype.Text) = pgtype.Text{String: source + "-owner", Valid: true}
		case "AuthorizePerRoomMetaMcpContext":
			*dest[2].(*pgtype.Text) = pgtype.Text{String: source + "-epoch", Valid: true}
		case "AuthorizeAlterEgoMcpContext":
			*dest[2].(*pgtype.Int8) = pgtype.Int8{Int64: 1, Valid: true}
		default:
			db.t.Fatalf("unexpected query %s", name)
		}
		return nil
	})
}

type identityQueryRow func(...any) error

func (row identityQueryRow) Scan(dest ...any) error { return row(dest...) }
