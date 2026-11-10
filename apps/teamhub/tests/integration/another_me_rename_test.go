package integration_test

import (
	"net/http"
	"testing"
)

// The Human's Another Me follows their name, unless they renamed it by hand.
func TestAccountRenameRenamesTheHumansAnotherMe(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newAgentRegistrationEnv(t, &recordingAgentManagement{})
	seedOwnedFixtureComputer(t, env.pool, "computer_fixture_rename", acmeTenant, "actor_acme_alice")
	const actorID = "actor_rename_alice_me"
	if _, err := env.pool.Exec(t.Context(), `
		INSERT INTO actors(id,tenant_id,kind,display_name,handle)
		SELECT $1,$2,'agent',display_name || '''s Another Me','alice-me-rename'
		FROM actors WHERE id='actor_acme_alice'
	`, actorID, acmeTenant); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `
		INSERT INTO agent_registrations(
			actor_id,tenant_id,agent_management_id,status,description,instructions,
			runtime_model,created_by_actor_id,visibility_scope,agent_type,represented_human_actor_id,
			computer_id,local_runtime_type,workspace_grant_id
		) VALUES($1,$2,'management_rename_alice_me','active',
			(SELECT 'Private delegate for ' || display_name FROM actors WHERE id='actor_acme_alice'),'Delegate safely',
			'codex-default','actor_acme_alice','sponsor','anotherme','actor_acme_alice','computer_fixture_rename','codex','grant_files')
	`, actorID, acmeTenant); err != nil {
		t.Fatal(err)
	}
	rename := func(name string) {
		t.Helper()
		status, _, body := env.request(alice, http.MethodPatch, "/v0/tenants/"+acmeTenant+"/account-profile", map[string]any{"name": name}, "")
		if status != http.StatusOK {
			t.Fatalf("rename to %q: %d %s", name, status, body)
		}
	}
	anotherMeName := func() string {
		t.Helper()
		var name string
		if err := env.pool.QueryRow(t.Context(), `SELECT display_name FROM actors WHERE id=$1`, actorID).Scan(&name); err != nil {
			t.Fatal(err)
		}
		return name
	}
	anotherMeDescription := func() (string, int64) {
		t.Helper()
		var description string
		var revision int64
		if err := env.pool.QueryRow(t.Context(), `SELECT description, configuration_revision FROM agent_registrations WHERE actor_id=$1`, actorID).Scan(&description, &revision); err != nil {
			t.Fatal(err)
		}
		return description, revision
	}
	_, revisionBefore := anotherMeDescription()

	rename("Alice Stone")
	if got := anotherMeName(); got != "Alice Stone's Another Me" {
		t.Fatalf("Another Me after the rename = %q", got)
	}
	if description, revision := anotherMeDescription(); description != "Private delegate for Alice Stone" || revision != revisionBefore+1 {
		t.Fatalf("Another Me description after the rename = %q at revision %d", description, revision)
	}

	// A name left behind by an earlier rename still follows the next one.
	if _, err := env.pool.Exec(t.Context(), `UPDATE actors SET display_name='onboarding-test''s Another Me' WHERE id=$1`, actorID); err != nil {
		t.Fatal(err)
	}
	rename("Alicia Stone")
	if got := anotherMeName(); got != "Alicia Stone's Another Me" {
		t.Fatalf("a stale Another Me name after the rename = %q", got)
	}

	if _, err := env.pool.Exec(t.Context(), `UPDATE actors SET display_name='Helper' WHERE id=$1`, actorID); err != nil {
		t.Fatal(err)
	}
	rename("Ally Stone")
	if got := anotherMeName(); got != "Helper" {
		t.Fatalf("a hand-named Another Me was renamed to %q", got)
	}
}
