package integration_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
)

func newHardwareVoiceCaptureEnvWithStorageAndLimitsAndConfig(
	t *testing.T,
	artifactMaxBytes, captureMaxBytes int64,
	configure func(*config.Config),
	appOptions ...appOption,
) (*testEnv, *http.Client, string) {
	t.Helper()
	return newHardwareVoiceEnv(t, artifactMaxBytes, captureMaxBytes, configure, false, appOptions...)
}

// newVoiceServiceEnv is a voice env whose App runs a voice media Service with
// no LiveKit provider or materializer. The Service needs the database pool,
// because it enqueues and runs its River jobs there.
func newVoiceServiceEnv(t *testing.T, configure func(*config.Config), appOptions ...appOption) (*testEnv, *http.Client, string) {
	t.Helper()
	return newHardwareVoiceEnv(t, 1<<20, 1<<30, configure, true, appOptions...)
}

func newHardwareVoiceEnv(
	t *testing.T,
	artifactMaxBytes, captureMaxBytes int64,
	configure func(*config.Config),
	voiceService bool,
	appOptions ...appOption,
) (*testEnv, *http.Client, string) {
	t.Helper()
	databaseURL := newIntegrationDatabase(t)
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	storageRoot := t.TempDir()
	appConfig := config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.TeamHubInternalToken = teamHubInternalToken
		c.NodeServicesInternalToken = nodeServicesInternalToken
		c.AgentRunTokenSecret = agentRunTokenSecret
		c.ArtifactStorageRoot = storageRoot
		c.ArtifactMaxBytes = artifactMaxBytes
		c.CaptureMaxBytes = captureMaxBytes
	})
	if configure != nil {
		configure(&appConfig)
	}
	if voiceService {
		appOptions = append([]appOption{withVoiceMedia(voicemedia.New(pool, nil, nil))}, appOptions...)
	}
	application, err := newIntegrationApp(ctx, appConfig, appOptions...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server, application: application}
	return env, env.login("alice", alicePassword), storageRoot
}

// loginSessionOf returns the Account's newest active login session. A
// VoiceSession created directly in SQL belongs to it, as one created through
// the API belongs to the caller's login session.
func loginSessionOf(t *testing.T, env *testEnv, accountID string) pgtype.Text {
	t.Helper()
	var id string
	if err := env.pool.QueryRow(t.Context(), `SELECT id FROM auth_sessions
		WHERE account_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 1`, accountID).Scan(&id); err != nil {
		t.Fatalf("login session of %s: %v", accountID, err)
	}
	return pgtype.Text{String: id, Valid: true}
}
