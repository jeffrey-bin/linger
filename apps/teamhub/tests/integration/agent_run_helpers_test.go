package integration_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
)

func newAgentRunEnv(t *testing.T, agentServiceURL string, appOptions ...appOption) (*testEnv, *http.Client) {
	t.Helper()
	return newAgentRunEnvWithConfig(t, agentServiceURL, nil, appOptions...)
}

// newAgentRunEnvWithConfig lets configure adjust the App configuration, for
// example to point it at a fake Composio.
func newAgentRunEnvWithConfig(t *testing.T, agentServiceURL string, configure func(*config.Config), appOptions ...appOption) (*testEnv, *http.Client) {
	t.Helper()
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(t.Context(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	artifactRoot := t.TempDir()
	cfg := config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.NodeServicesURL = agentServiceURL
		c.TeamHubInternalToken = teamHubInternalToken
		c.NodeServicesInternalToken = nodeServicesInternalToken
		c.AgentRunTokenSecret = agentRunTokenSecret
		c.ArtifactStorageRoot = artifactRoot
		c.ArtifactMaxBytes = 1 << 20
		c.RoomDocument.RuntimeURL = "http://document-runtime.test"
	})
	if configure != nil {
		configure(&cfg)
	}
	application, err := newIntegrationApp(context.Background(), cfg, appOptions...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server, artifactRoot: artifactRoot}
	return env, env.login("alice", alicePassword)
}
