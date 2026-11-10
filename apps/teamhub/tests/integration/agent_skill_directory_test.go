package integration_test

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

//go:embed testdata/agent_skill_directory.sql
var agentSkillDirectoryFixture string

// Record the statement used by the production sqlc method, so the plan probe
// cannot drift into measuring a hand-copied or simplified query.
type directoryQueryRecorder struct {
	store.DBTX
	statement string
}

func (r *directoryQueryRecorder) Query(ctx context.Context, statement string, args ...any) (pgx.Rows, error) {
	r.statement = statement
	return r.DBTX.Query(ctx, statement, args...)
}

type directoryQueryPlan struct {
	Rows         float64              `json:"Actual Rows"`
	Loops        float64              `json:"Actual Loops"`
	Filtered     float64              `json:"Rows Removed by Filter"`
	JoinFiltered float64              `json:"Rows Removed by Join Filter"`
	Plans        []directoryQueryPlan `json:"Plans"`
}

func (p directoryQueryPlan) work() float64 {
	total := (p.Rows + p.Filtered + p.JoinFiltered) * p.Loops
	for _, child := range p.Plans {
		total += child.work()
	}
	return total
}

func TestAgentSkillDirectoryScopesBindingHistory(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newAgentRegistrationEnv(t, &recordingAgentManagement{})
	if _, err := env.pool.Exec(t.Context(), agentSkillDirectoryFixture); err != nil {
		t.Fatal(err)
	}
	ids := []string{"actor_acme_official"}
	for n := 1; n <= 6; n++ {
		ids = append(ids, fmt.Sprintf("actor_directory_%d", n))
	}
	// All seven selected General Agents receive the thirteen current catalog
	// defaults; the official Agent also binds the three explicit-only Skills.
	const generalDefaultSkills = 13
	const explicitSkills = 3
	expectedBindings := len(ids)*generalDefaultSkills + explicitSkills
	recorder := &directoryQueryRecorder{DBTX: env.pool}
	queries := store.New(recorder)
	started := time.Now()
	bindings, err := queries.ListAgentSkillRegistrationsForAgents(t.Context(), ids)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("directory SQL: agents=%d bindings=%d elapsed=%s", len(ids), len(bindings), time.Since(started))
	explicit := 0
	for _, binding := range bindings {
		if !binding.IsDefault {
			explicit++
		}
		if binding.AgentActorID == "actor_directory_other" {
			t.Fatalf("unrequested Agent binding: %+v", binding)
		}
	}
	if len(bindings) != expectedBindings || explicit != explicitSkills {
		t.Fatalf("bindings=%d explicit=%d want %d/%d", len(bindings), explicit, expectedBindings, explicitSkills)
	}
	var raw []byte
	if err := env.pool.QueryRow(t.Context(), "EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) "+recorder.statement, ids).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var plans []struct {
		Plan      directoryQueryPlan `json:"Plan"`
		Execution float64            `json:"Execution Time"`
	}
	if err := json.Unmarshal(raw, &plans); err != nil {
		t.Fatal(err)
	}
	work := plans[0].Plan.work()
	t.Logf("directory plan: execution_ms=%.3f row_visits=%.0f", plans[0].Execution, work)
	// Bound repeated work, not machine-dependent milliseconds or a particular
	// join operator. A tiny requested set must not rescan unrelated bindings
	// millions of times across the Skill catalog.
	if work > 200000 {
		t.Errorf("directory query rescans unrelated bindings: %.0f row visits exceeds 200000", work)
	}
	httpStatus, _, body := env.request(alice, http.MethodGet, "/v0/tenants/tenant_acme/agents?limit=200", nil, "")
	if httpStatus != http.StatusOK {
		t.Fatalf("directory status=%d body=%s", httpStatus, body)
	}
	var directory struct {
		Items []struct {
			Actor struct {
				ID string `json:"id"`
			} `json:"actor"`
			SkillBindings []agentSkillRegistrationResponse `json:"skill_bindings"`
		} `json:"items"`
	}
	decode(t, body, &directory)
	// The unrequested Agent shares the one Space, so the directory lists it
	// too; only the selected Agents' bindings are counted.
	agents, count := 0, 0
	for _, item := range directory.Items {
		if item.Actor.ID == "actor_directory_other" {
			continue
		}
		agents++
		count += len(item.SkillBindings)
	}
	if agents != len(ids) || count != expectedBindings {
		t.Fatalf("HTTP Agents/bindings=%d/%d want %d/%d", agents, count, len(ids), expectedBindings)
	}
	for _, selected := range [][]string{nil, {}, {"missing_actor"}} {
		rows, err := queries.ListAgentSkillRegistrationsForAgents(t.Context(), selected)
		if err != nil || len(rows) != 0 {
			t.Fatalf("empty selection returned %d bindings: %v", len(rows), err)
		}
	}
	// Only the current binding state contributes, including a removal.
	for version := 2; version <= 4; version++ {
		tx, err := env.pool.Begin(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		_, err = tx.Exec(t.Context(), `UPDATE agent_skill_bindings
                SET enabled=$2,binding_version=$1,deleted_at=CASE WHEN $3::boolean THEN now() END
                WHERE id='directory_selected_1'`, version, version == 3, version == 4)
		if err != nil {
			_ = tx.Rollback(t.Context())
			t.Fatal(err)
		}
		if err = tx.Commit(t.Context()); err != nil {
			t.Fatal(err)
		}
		rows, err := queries.ListAgentSkillRegistrationsForAgents(t.Context(), []string{"actor_acme_official"})
		expected := generalDefaultSkills + explicitSkills
		if version != 3 {
			expected--
		}
		if err != nil || len(rows) != expected {
			t.Fatalf("revision %d bindings=%d want %d error=%v", version, len(rows), expected, err)
		}
	}
}
