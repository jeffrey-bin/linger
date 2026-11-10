package integration_test

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const anotherMeFixtureModel = "openai/gpt-5.4"
const anotherMeFixtureGrant = "grant_fixture_workspace"

// seedAnotherMeComputers puts one online Computer per Human with a ready Codex
// Runtime in local_computers, as the Runner Gateway records it. A new Another
// Me binds to the Computer of its Human.
func seedAnotherMeComputers(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	rows, err := pool.Query(t.Context(), `SELECT tenant_id,id FROM actors WHERE kind='human'`)
	if err != nil {
		t.Fatal(err)
	}
	humans, err := pgx.CollectRows(rows, pgx.RowToStructByPos[struct{ TenantID, ActorID string }])
	if err != nil {
		t.Fatal(err)
	}
	for _, human := range humans {
		computerID := anotherMeFixtureComputerID(human.TenantID, human.ActorID)
		if _, err := pool.Exec(t.Context(), `
INSERT INTO local_computers(computer_id,display_name,status,owner_tenant_id,owner_actor_id,runtime_inventory,workspace_grants,runtime_diagnostics,last_seen_at)
VALUES($1,'Fixture Mac','online',$2,$5,'["codex"]',
       jsonb_build_array(jsonb_build_object('grant_id',$3::text,'tenant_id',$2::text,'scope','owner','label','Workspace','mode','workspace-write')),
       jsonb_build_array(
           jsonb_build_object('type','codex','status','ready','protocol','app-server','checked_at',to_jsonb(now()),
               'models',jsonb_build_array(jsonb_build_object('id',$4::text,'label','GPT-5.4',
                   'allowed_reasoning_effort',jsonb_build_array('medium','high'),'default_reasoning_effort','high'))),
           jsonb_build_object('type','claude','status','not_installed','protocol','stream-json','checked_at',to_jsonb(now()))),
       now())
ON CONFLICT (computer_id) DO UPDATE SET status='online',last_seen_at=now()`,
			computerID, human.TenantID, anotherMeFixtureGrant, anotherMeFixtureModel, human.ActorID); err != nil {
			t.Fatal(err)
		}
	}
}

func anotherMeFixtureComputerID(tenantID, ownerID string) string {
	digest := sha256.Sum256([]byte(tenantID + "/" + ownerID))
	return fmt.Sprintf("computer_local_%x", digest[:12])
}

// bindLocalFixtureRegistration places an existing Another Me fixture on the
// Computer seedAnotherMeComputers records for its Human.
func bindLocalFixtureRegistration(t *testing.T, pool *pgxpool.Pool, actorID string) {
	t.Helper()
	var tenantID, ownerID string
	if err := pool.QueryRow(t.Context(), `SELECT tenant_id,created_by_actor_id FROM agent_registrations WHERE actor_id=$1`, actorID).Scan(&tenantID, &ownerID); err != nil {
		t.Fatal(err)
	}
	result, err := pool.Exec(t.Context(), `UPDATE agent_registrations
SET computer_id=$2,local_runtime_type='codex',workspace_grant_id=$3
WHERE actor_id=$1`, actorID, anotherMeFixtureComputerID(tenantID, ownerID), anotherMeFixtureGrant)
	if err != nil || result.RowsAffected() != 1 {
		t.Fatalf("bind local fixture %s: rows=%d error=%v", actorID, result.RowsAffected(), err)
	}
}

// fixtureComputerID is the Computer that seeded and HTTP-created fixture
// Agents run on. It belongs to Alice, the Space's one Human;
// seedReadyFixtureComputers owns it.
const fixtureComputerID = "computer_fixture"

// fixtureRuntime is an Agent runtime on the fixture Computer.
func fixtureRuntime(model string) map[string]any {
	return fixtureRuntimeOn(fixtureComputerID, model)
}

// fixtureRuntimeOn is an Agent runtime on another fixture Computer.
func fixtureRuntimeOn(computerID, model string) map[string]any {
	return map[string]any{"model": model, "placement": map[string]any{
		"type": "local", "computer_id": computerID, "runtime_type": "codex", "workspace_grant_id": "grant_files",
	}}
}

// seedReadyFixtureComputers puts the fixture Computer, owned by Alice, and every
// Computer a live Agent runs on online with a ready Codex Runtime.
func seedReadyFixtureComputers(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	seedFixtureComputers(t, pool, `SELECT '`+fixtureComputerID+`' AS computer_id,'tenant_acme' AS owner_tenant_id,'actor_acme_alice' AS owner_actor_id`)
	seedRegisteredAgentComputers(t, pool)
}

// seedOwnedFixtureComputer puts one more online Computer, with the shared
// writable grant, under a single Human owner.
func seedOwnedFixtureComputer(t *testing.T, pool *pgxpool.Pool, computerID, tenantID, ownerActorID string) {
	t.Helper()
	seedFixtureComputers(t, pool, `SELECT '`+computerID+`' AS computer_id,'`+tenantID+`' AS owner_tenant_id,'`+ownerActorID+`' AS owner_actor_id`)
}

// seedRegisteredAgentComputers puts every Computer a live Agent runs on online
// with a ready Codex Runtime. A Computer shared by several Sponsors' fixture
// Agents belongs to the first of them.
func seedRegisteredAgentComputers(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	seedFixtureComputers(t, pool, `SELECT DISTINCT ON (computer_id) computer_id,tenant_id AS owner_tenant_id,created_by_actor_id AS owner_actor_id
FROM agent_registrations WHERE status<>'revoked' ORDER BY computer_id,created_by_actor_id`)
}

func seedFixtureComputers(t *testing.T, pool *pgxpool.Pool, computers string) {
	t.Helper()
	if _, err := pool.Exec(t.Context(), `
INSERT INTO local_computers(computer_id,display_name,status,owner_tenant_id,owner_actor_id,runtime_inventory,workspace_grants,runtime_diagnostics,last_seen_at)
SELECT computer.computer_id,'Fixture Computer','online',computer.owner_tenant_id,computer.owner_actor_id,'["codex"]',
       (SELECT jsonb_agg(jsonb_build_object('grant_id','grant_files','tenant_id',tenant.id,'scope','owner','mode','workspace-write') ORDER BY tenant.id) FROM (SELECT DISTINCT tenant_id AS id FROM actors WHERE kind='human') tenant),
       jsonb_build_array(
           jsonb_build_object('type','codex','status','ready','protocol','app-server','checked_at',to_jsonb(now())),
           jsonb_build_object('type','claude','status','not_installed','protocol','stream-json','checked_at',to_jsonb(now()))),
       now()-interval '5 seconds'
FROM (`+computers+`) computer
ON CONFLICT(computer_id) DO UPDATE SET status='online',last_seen_at=excluded.last_seen_at`); err != nil {
		t.Fatal(err)
	}
}

// connectAnotherMeComputer records the Human's fixture Computer offline and
// then reports it online through the Runner touch route, as the Runner Gateway
// does when the Computer connects. That creates the Human's Another Me. It
// returns the Another Me's Actor ID, or "" when there is none.
func connectAnotherMeComputer(t *testing.T, env *testEnv, tenantID, humanActorID string) string {
	t.Helper()
	seedAnotherMeComputers(t, env.pool)
	computerID := anotherMeFixtureComputerID(tenantID, humanActorID)
	if _, err := env.pool.Exec(t.Context(), `UPDATE local_computers SET status='offline',last_seen_at=now()-interval '1 minute' WHERE computer_id=$1`, computerID); err != nil {
		t.Fatal(err)
	}
	touchAnotherMeComputer(t, env, computerID, nil)
	return anotherMeActorID(t, env, tenantID, humanActorID)
}

// touchAnotherMeComputer reports a fixture Computer online, with new Runtime
// diagnostics when diagnostics is not nil.
func touchAnotherMeComputer(t *testing.T, env *testEnv, computerID string, diagnostics []map[string]any) {
	t.Helper()
	payload := map[string]any{"computer_id": computerID, "status": "online", "seen_at": time.Now().UTC()}
	if diagnostics != nil {
		payload["runtime_diagnostics"] = diagnostics
	}
	status, body := agentRuntimeStateRequest(t, env.server.Config.Handler, http.MethodPost,
		"/v0/agent-runtime/local-computers/touch", teamHubInternalToken, payload)
	if status != http.StatusOK {
		t.Fatalf("touch Computer %s status=%d body=%s", computerID, status, body)
	}
}

func anotherMeActorID(t *testing.T, env *testEnv, tenantID, humanActorID string) string {
	t.Helper()
	var actorID string
	err := env.pool.QueryRow(t.Context(), `
		SELECT actor_id FROM agent_registrations
		WHERE tenant_id=$1 AND represented_human_actor_id=$2 AND agent_type='anotherme' AND status='active'
	`, tenantID, humanActorID).Scan(&actorID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ""
	}
	if err != nil {
		t.Fatal(err)
	}
	return actorID
}
