package integration_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/personalprofile"
)

// A Human edits their own Profile from the Wiki page: the edit becomes the
// current Revision, keeps the Revision's sources, schedules memory.md to take
// it in, and a stale edit conflicts.
func TestHumanEditsOwnProfile(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := t.Context()
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	generator := userProfileGenerator(func(context.Context, personalprofile.GenerationRequest) (personalprofile.GenerationResult, error) {
		return personalprofile.GenerationResult{Profile: testProfileDocument("Avery")}, nil
	})
	application, err := newTestApp(ctx, config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.ArtifactStorageRoot = t.TempDir()
		c.ArtifactMaxBytes = 2 << 20
	}), withPersonalProfileGenerator(generator), skipping(app.PersonalProfileJobs))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}
	alice := env.login("alice", alicePassword)
	status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/tenant_acme/personal-profile-generations", map[string]any{"sources": []map[string]any{{"kind": "external_ai_summary", "summary": "Avery coordinates design reviews."}}}, "profile-edit-source")
	if status != http.StatusCreated {
		t.Fatalf("create=%d %s", status, body)
	}
	if err = runJobsOnce(ctx, pool, application.AddPersonalProfileWorkers, "personal_profile.generation"); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `UPDATE personal_profile_revisions SET source_apps=ARRAY['gmail']`); err != nil {
		t.Fatal(err)
	}
	var first string
	if err = pool.QueryRow(ctx, `SELECT revision_id FROM personal_profile_currents`).Scan(&first); err != nil {
		t.Fatal(err)
	}

	var markdown string
	if err = pool.QueryRow(ctx, `SELECT markdown FROM personal_profile_revisions WHERE id=$1`, first).Scan(&markdown); err != nil {
		t.Fatal(err)
	}
	edited := strings.Replace(markdown, "Avery coordinates design reviews.", "Avery leads design reviews and hiring.\n\n### Timeline\n\n- –2019 · Example University\n  Ph.D.", 1)
	replace := func(base, markdown string) (int, map[string]any) {
		t.Helper()
		status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/tenant_acme/personal-profile/revisions", map[string]any{"base_revision_id": base, "markdown": markdown}, "")
		var decoded map[string]any
		_ = json.Unmarshal(body, &decoded)
		return status, decoded
	}

	status, revision := replace(first, edited)
	if status != http.StatusOK || revision["id"] == first {
		t.Fatalf("edit=%d %v", status, revision)
	}
	second, _ := revision["id"].(string)
	var overview, period, name string
	var apps []string
	if err = pool.QueryRow(ctx, `SELECT revision.profile->'background'->>'overview', revision.profile->'background'->'timeline'->0->>'period', revision.profile->>'name', revision.source_apps FROM personal_profile_currents current JOIN personal_profile_revisions revision ON revision.id=current.revision_id`).Scan(&overview, &period, &name, &apps); err != nil {
		t.Fatal(err)
	}
	if overview != "Avery leads design reviews and hiring." || period != "–2019" || name != "Avery" || len(apps) != 1 || apps[0] != "gmail" {
		t.Fatalf("current overview=%q period=%q name=%q apps=%v", overview, period, name, apps)
	}

	// Both publications wait in one memory.md sync a while later.
	var syncs int
	var later bool
	if err = pool.QueryRow(ctx, `
		SELECT count(*), coalesce(bool_and(scheduled_at > now() + interval '30 seconds'), false)
		FROM river_job WHERE kind='personal_profile.memory_sync' AND state='scheduled'
	`).Scan(&syncs, &later); err != nil {
		t.Fatal(err)
	}
	if syncs != 1 || !later {
		t.Fatalf("memory.md syncs=%d scheduled later=%v", syncs, later)
	}

	// Saving the same Profile again keeps the Revision.
	if status, revision = replace(second, edited); status != http.StatusOK || revision["id"] != second {
		t.Fatalf("unchanged edit=%d %v", status, revision)
	}
	// An edit started from an older Revision conflicts.
	if status, _ = replace(first, markdown); status != http.StatusConflict {
		t.Fatalf("stale edit=%d", status)
	}
	// A section the layout does not know names its line.
	status, revision = replace(second, edited+"\n\n## Hobbies\n\nChess")
	if apiError, _ := revision["error"].(map[string]any); status != http.StatusBadRequest || apiError["code"] != "profile_markdown_invalid" {
		t.Fatalf("unknown section=%d %v", status, revision)
	}
	// Every section still needs content.
	empty := edited[:strings.Index(edited, "## Writing Style")] + "## Writing Style\n"
	status, revision = replace(second, empty)
	if apiError, _ := revision["error"].(map[string]any); status != http.StatusBadRequest || apiError["code"] != string(personalprofile.ModuleEmpty) {
		t.Fatalf("empty section=%d %v", status, revision)
	}
}
