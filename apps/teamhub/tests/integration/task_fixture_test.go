package integration_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
)

// These tests explicitly drive Task worker HTTP commands. Keep a private DB,
// server and object root, but do not start unrelated application schedulers.
// Startup catalog/audit tests continue to use the normal application fixture.
func newTaskWorkerEnv(t *testing.T, appOptions ...appOption) (*testEnv, *http.Client) {
	t.Helper()
	return newTaskWorkerEnvWithDatabase(t, newIntegrationDatabase(t), appOptions...)
}

func newTaskWorkerEnvWithDatabase(t *testing.T, databaseURL string, appOptions ...appOption) (*testEnv, *http.Client) {
	t.Helper()
	pool, err := pgxpool.New(t.Context(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	seedReadyFixtureComputers(t, pool)
	root := t.TempDir()
	application, err := newIntegrationApp(t.Context(), config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.TeamHubInternalToken = teamHubInternalToken
		c.NodeServicesInternalToken = nodeServicesInternalToken
		c.AgentRunTokenSecret = agentRunTokenSecret
		c.ArtifactStorageRoot = root
		c.ArtifactMaxBytes = 64 << 20
	}), appOptions...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server, artifactRoot: root}
	return env, env.login("alice", alicePassword)
}
