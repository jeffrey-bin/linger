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

type userProfileGenerator func(context.Context, personalprofile.GenerationRequest) (personalprofile.GenerationResult, error)

func (f userProfileGenerator) Generate(ctx context.Context, request personalprofile.GenerationRequest) (personalprofile.GenerationResult, error) {
	return f(ctx, request)
}

// testProfileDocument is a valid Profile document; extra facts become
// Preferences points so a fixture generator can show what it merged.
func testProfileDocument(name string, facts ...string) personalprofile.Document {
	module := func(overview string) personalprofile.Module { return personalprofile.Module{Overview: overview} }
	doc := personalprofile.Document{
		Name: name, Background: personalprofile.Background{Overview: name + " coordinates design reviews."},
		CommunicationStyle: module("Direct."), WorkingStyle: module("Plans first."),
		Preferences: module("Async updates."), WritingStyle: module("Short sentences."),
	}
	for _, fact := range facts {
		doc.Preferences.Points = append(doc.Preferences.Points, personalprofile.Point{Title: "Source", Text: fact})
	}
	return doc
}

func testProfileJSON(t *testing.T, doc personalprofile.Document) string {
	t.Helper()
	encoded, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func TestAddSourceMergesCanonicalProfileWithoutLostUpdates(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := t.Context()
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	winner := testProfileDocument("Alice", "Concurrent private Soul")
	var requests []personalprofile.GenerationRequest
	fail, race := false, false
	generator := userProfileGenerator(func(_ context.Context, request personalprofile.GenerationRequest) (personalprofile.GenerationResult, error) {
		requests = append(requests, request)
		if fail {
			return personalprofile.GenerationResult{Error: "fixture failure"}, nil
		}
		if race {
			race = false
			// An accepted source publishes after this inference read its baseline.
			_, raceErr := pool.Exec(ctx, `INSERT INTO personal_profile_generations(id,tenant_id,owner_actor_id,prompt_version,status) VALUES('soul_race','tenant_acme','actor_acme_alice','fixture','succeeded')`)
			if raceErr == nil {
				_, raceErr = pool.Exec(ctx, `INSERT INTO personal_profile_revisions(id,tenant_id,owner_actor_id,prompt_version,markdown,profile,source_profile_generation_id) VALUES('soul_winner','tenant_acme','actor_acme_alice','fixture','Concurrent private Soul',$1,'soul_race')`, testProfileJSON(t, winner))
			}
			if raceErr == nil {
				_, raceErr = pool.Exec(ctx, `UPDATE personal_profile_currents SET revision_id='soul_winner' WHERE tenant_id='tenant_acme' AND owner_actor_id='actor_acme_alice'`)
			}
			if raceErr != nil {
				t.Fatal(raceErr)
			}
		}
		doc := testProfileDocument("Alice")
		if request.BaselineProfile != "" {
			if err := json.Unmarshal([]byte(request.BaselineProfile), &doc); err != nil {
				t.Fatal(err)
			}
		}
		doc.Preferences.Points = append(doc.Preferences.Points, personalprofile.Point{Title: "Source", Text: request.Documents[len(request.Documents)-1].Content})
		return personalprofile.GenerationResult{Profile: doc}, nil
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
	versionsBefore := countDocumentVersions(t, ctx, pool)
	addSource := func(content string) string {
		t.Helper()
		status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/tenant_acme/personal-profile-generations", map[string]any{
			"sources": []map[string]any{{"kind": "external_ai_summary", "summary": content}},
		}, content)
		if status != http.StatusCreated {
			t.Fatalf("create status=%d body=%s", status, body)
		}
		return decodePersonalProfileGeneration(t, body).ID
	}
	run := func() {
		t.Helper()
		if runErr := runJobsOnce(ctx, pool, application.AddPersonalProfileWorkers, "personal_profile.generation"); runErr != nil {
			t.Fatal(runErr)
		}
	}
	current := func() string {
		t.Helper()
		var markdown string
		if err := pool.QueryRow(ctx, `SELECT r.markdown FROM personal_profile_currents c JOIN personal_profile_revisions r ON r.id=c.revision_id WHERE c.tenant_id='tenant_acme' AND c.owner_actor_id='actor_acme_alice'`).Scan(&markdown); err != nil {
			t.Fatal(err)
		}
		return markdown
	}
	addSource("first-source")
	run()
	first := current()
	addSource("second-source")
	run()
	second := current()
	if len(requests) != 2 || requests[0].BaselineProfile != "" || !strings.Contains(requests[1].BaselineProfile, `"text":"first-source"`) || !strings.Contains(first, "first-source") || !strings.Contains(second, "first-source") || !strings.Contains(second, "second-source") {
		t.Fatalf("private source merge or public separation failed: requests=%+v", requests)
	}
	fail = true
	addSource("failed-source")
	run()
	if got := current(); got != second {
		t.Fatal("failed inference changed current profiles")
	}
	fail, race = false, true
	id := addSource("concurrent-source")
	run()
	// The stale inference is rejected and rebased onto the winner; River runs the
	// short snooze within the same drain, so the retry merges instead of overwriting.
	var status string
	var snoozes int
	if err = pool.QueryRow(ctx, `SELECT status FROM personal_profile_generations WHERE id=$1`, id).Scan(&status); err != nil || status != "succeeded" {
		t.Fatalf("retry status=%s err=%v", status, err)
	}
	if err = pool.QueryRow(ctx, `SELECT coalesce((metadata->>'snoozes')::int,0) FROM river_job WHERE kind='personal_profile.generation' AND args->>'generation_id'=$1`, id).Scan(&snoozes); err != nil || snoozes != 1 {
		t.Fatalf("stale inference rebase snoozes=%d err=%v", snoozes, err)
	}
	if requests[len(requests)-1].BaselineProfile != testProfileJSON(t, winner) {
		t.Fatal("retry did not reload the winning private baseline")
	}
	if got := current(); !strings.Contains(got, "Concurrent private Soul") || !strings.Contains(got, "concurrent-source") {
		t.Fatalf("stale inference overwrote winner or published half an update: %q", got)
	}
	if got := countDocumentVersions(t, ctx, pool); got != versionsBefore {
		t.Fatalf("Profile generation published Document versions: %d -> %d", versionsBefore, got)
	}
	var revisions int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM personal_profile_revisions`).Scan(&revisions); err != nil || revisions != 4 {
		t.Fatalf("unexpected orphan Soul revisions=%d err=%v", revisions, err)
	}
}

func TestProfileNoChangePreservesCurrentRevisionAndDoesNotArchiveSources(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := t.Context()
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	generator := userProfileGenerator(func(_ context.Context, r personalprofile.GenerationRequest) (personalprofile.GenerationResult, error) {
		doc := testProfileDocument("Avery")
		if r.BaselineProfile != "" {
			if err := json.Unmarshal([]byte(r.BaselineProfile), &doc); err != nil {
				t.Fatal(err)
			}
		}
		return personalprofile.GenerationResult{Profile: doc}, nil
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
	for _, source := range []string{"initial-raw-profile-source", "unchanged-raw-profile-source"} {
		status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/tenant_acme/personal-profile-generations", map[string]any{"sources": []map[string]any{{"kind": "external_ai_summary", "summary": source}}}, source)
		if status != http.StatusCreated {
			t.Fatalf("create=%d %s", status, body)
		}
		if err = runJobsOnce(ctx, pool, application.AddPersonalProfileWorkers, "personal_profile.generation"); err != nil {
			t.Fatal(err)
		}
	}
	var count int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM personal_profile_revisions`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("unchanged result created revision: %d %v", count, err)
	}
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM personal_profile_generations WHERE insight_documents::text LIKE '%raw-profile-source%'`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("raw Profile evidence archived: %d %v", count, err)
	}
}

func TestUnifiedProfileIsTheAgentIdentityProfile(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := t.Context()
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err = pool.Exec(ctx, `INSERT INTO personal_profile_revisions(id,tenant_id,owner_actor_id,prompt_version,markdown,profile) VALUES('profile_only','tenant_acme','actor_acme_alice','user-profile-v1','Canonical private profile','{}'); INSERT INTO personal_profile_currents(tenant_id,owner_actor_id,revision_id) VALUES('tenant_acme','actor_acme_alice','profile_only')`); err != nil {
		t.Fatal(err)
	}
	var exists bool
	if err = pool.QueryRow(ctx, `SELECT to_regclass('representation_profile_revisions') IS NOT NULL`).Scan(&exists); err != nil || exists {
		t.Fatalf("second profile authority still exists: %v %v", exists, err)
	}
	// The same generated registration query used by Agent identity reads the single pointer.
	var markdown string
	if err = pool.QueryRow(ctx, `SELECT revision.markdown FROM personal_profile_currents current JOIN personal_profile_revisions revision ON revision.id=current.revision_id WHERE current.tenant_id='tenant_acme' AND current.owner_actor_id='actor_acme_alice'`).Scan(&markdown); err != nil || markdown != "Canonical private profile" {
		t.Fatalf("canonical profile=%q err=%v", markdown, err)
	}
}
