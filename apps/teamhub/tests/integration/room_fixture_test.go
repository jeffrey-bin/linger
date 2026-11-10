package integration_test

import (
	"net/http"
	"testing"
)

func TestRoomFixtureCreatesOnlyRequestedAuthSessions(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRoomMembershipEnv(t)
	if got := countRows(t, env, `SELECT count(*) FROM auth_sessions`); got != 0 {
		t.Fatalf("unused fixture auth sessions=%d want=0", got)
	}

	alice := env.login("alice", alicePassword)
	if got := countRows(t, env, `SELECT count(*) FROM auth_sessions WHERE account_id='account_alice'`); got != 1 {
		t.Fatalf("Alice auth sessions=%d want=1", got)
	}
	if got := countRows(t, env, `SELECT count(*) FROM auth_sessions WHERE account_id<>'account_alice'`); got != 0 {
		t.Fatalf("unrequested users have %d auth sessions", got)
	}
	if code, _, _ := env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/rooms", nil, ""); code != http.StatusOK {
		t.Fatalf("requested user cannot read Rooms: %d", code)
	}
	if code, _, _ := env.request(newClient(t), http.MethodGet, "/v0/tenants/"+acmeTenant+"/rooms", nil, ""); code != http.StatusUnauthorized {
		t.Fatalf("anonymous client status=%d want=401", code)
	}
}
