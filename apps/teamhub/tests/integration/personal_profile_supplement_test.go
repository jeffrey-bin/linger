package integration_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/account"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/personalprofile"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
)

type recordingProfileGenerator struct {
	mu       sync.Mutex
	requests []personalprofile.GenerationRequest
	facts    []string
	err      error
}

func (g *recordingProfileGenerator) Generate(_ context.Context, request personalprofile.GenerationRequest) (personalprofile.GenerationResult, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.requests = append(g.requests, request)
	if g.err != nil {
		return personalprofile.GenerationResult{}, g.err
	}
	fact := "Generated from files."
	if len(g.facts) > 0 {
		fact = g.facts[0]
		if len(g.facts) > 1 {
			g.facts = g.facts[1:]
		}
	}
	return personalprofile.GenerationResult{
		Profile: testProfileDocument("Alice", fact),
		Account: account.Fields{Name: "Alice Generated", Bio: "Writes software.", Organization: "Acme Labs"},
	}, nil
}

type fakeNotionProvider struct {
	// Provider panics on the apps this fake does not serve.
	externalsource.Provider
	botID     string
	workspace string
	resource  composio.NotionResource
	markdown  string
}

func (p *fakeNotionProvider) GetConnectionStatus(context.Context, string) (composio.ConnectionStatus, error) {
	return composio.ConnectionActive, nil
}

func (p *fakeNotionProvider) IdentifyNotion(context.Context, string) (composio.NotionIdentity, error) {
	return composio.NotionIdentity{BotID: p.botID, WorkspaceName: p.workspace}, nil
}

func (p *fakeNotionProvider) ListNotionResources(context.Context, string, string, int) (composio.NotionResourcePage, error) {
	return composio.NotionResourcePage{Resources: []composio.NotionResource{p.resource}}, nil
}

func (p *fakeNotionProvider) GetNotionPage(_ context.Context, _ string, resource composio.NotionResource) (composio.NotionSnapshot, error) {
	return composio.NotionSnapshot{Resource: resource, Title: resource.Title, Markdown: p.markdown}, nil
}

func (p *fakeNotionProvider) GetNotionDatabase(context.Context, string, composio.NotionResource) (composio.NotionSnapshot, error) {
	return composio.NotionSnapshot{}, errors.New("database not used")
}

// An offline Computer and a model call still pending in the Agent Service
// both snooze the generation without spending an attempt.
func TestPersonalProfileWaitsForTheModelWithoutSpendingAnAttempt(t *testing.T) {
	allowParallelIntegrationTest(t)
	for _, test := range []struct {
		err  error
		code string
	}{
		{roomagent.ErrModelCallComputerOffline, "COMPUTER_OFFLINE_WAIT"},
		{roomagent.ErrModelCallPending, "MODEL_CALL_PENDING_WAIT"},
	} {
		t.Run(test.code, func(t *testing.T) {
			personalProfileWaitsForTheModel(t, test.err, test.code)
		})
	}
}

func personalProfileWaitsForTheModel(t *testing.T, waitErr error, wantCode string) {
	ctx := context.Background()
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	generator := &recordingProfileGenerator{err: errors.Join(personalprofile.ErrGeneratorUnavailable, waitErr)}
	application, err := newTestApp(ctx, config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.ArtifactStorageRoot = t.TempDir()
		c.ArtifactMaxBytes = 2 << 20
	}), skipping(app.SkillInstall), skipping(app.SkillPackageProbe),
		withPersonalProfileGenerator(generator), skipping(app.PersonalProfileJobs))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}
	alice := env.login("alice", alicePassword)
	httpStatus, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/personal-profile-generations", map[string]any{
		"sources": []map[string]any{{"kind": "external_ai_summary", "summary": "I prefer concise written plans."}},
	}, "offline-profile-summary")
	if httpStatus != http.StatusCreated {
		t.Fatalf("create generation status=%d body=%s", httpStatus, body)
	}
	created := decodePersonalProfileGeneration(t, body)
	if err = runJobsOnce(ctx, pool, application.AddPersonalProfileWorkers, "personal_profile.generation"); err != nil {
		t.Fatal(err)
	}
	var status, code, jobState string
	var errorCount int
	if err = pool.QueryRow(ctx, `
		SELECT generation.status,coalesce(generation.last_error_code,''),job.state,coalesce(array_length(job.errors,1),0)
		FROM personal_profile_generations generation
		JOIN river_job job ON job.kind='personal_profile.generation' AND job.args->>'generation_id'=generation.id
		WHERE generation.id=$1`, created.ID).Scan(&status, &code, &jobState, &errorCount); err != nil {
		t.Fatal(err)
	}
	if status != "queued" || code != wantCode || jobState != "scheduled" || errorCount != 0 {
		t.Fatalf("waiting for the model must snooze the generation: status=%s code=%s job=%s errors=%d", status, code, jobState, errorCount)
	}
}

func TestPersonalProfileSupplementPublishesExternalAISummaryWithoutWikiSource(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	generator := &recordingProfileGenerator{facts: []string{"Prefers concise written plans."}}
	application, err := newTestApp(ctx, config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.ArtifactStorageRoot = t.TempDir()
		c.ArtifactMaxBytes = 2 << 20
	}), skipping(app.SkillInstall), skipping(app.SkillPackageProbe),
		withPersonalProfileGenerator(generator), skipping(app.PersonalProfileJobs))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}
	alice := env.login("alice", alicePassword)
	documentVersionsBefore := countDocumentVersions(t, ctx, pool)
	const summary = "external-ai-private-sentinel: I prefer concise written plans."

	httpStatus, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/personal-profile-generations", map[string]any{
		"sources": []map[string]any{{"kind": "external_ai_summary", "summary": "  " + summary + "  "}},
	}, "external-ai-profile-summary")
	if httpStatus != http.StatusCreated {
		t.Fatalf("create generation status=%d body=%s", httpStatus, body)
	}
	if strings.Contains(string(body), summary) {
		t.Fatalf("generation response exposed external AI summary: %s", body)
	}
	created := decodePersonalProfileGeneration(t, body)
	var storedSummary string
	if err = pool.QueryRow(ctx, `SELECT source.value->>'external_ai_summary' FROM personal_profile_generations generation
		CROSS JOIN LATERAL jsonb_array_elements(generation.sources) source(value)
		WHERE generation.id=$1 AND source.value->>'kind'='external_ai_summary'`, created.ID).Scan(&storedSummary); err != nil {
		t.Fatal(err)
	}
	if storedSummary != summary {
		t.Fatalf("stored summary=%q", storedSummary)
	}

	if err = runJobsOnce(ctx, pool, application.AddPersonalProfileWorkers, "personal_profile.generation"); err != nil {
		t.Fatal(err)
	}
	generator.mu.Lock()
	if len(generator.requests) != 1 || len(generator.requests[0].Documents) != 1 || generator.requests[0].Documents[0].Provider != "external_ai_summary" || generator.requests[0].Documents[0].Content != summary {
		t.Fatalf("generator requests=%+v", generator.requests)
	}
	generator.mu.Unlock()

	body = personalProfileGenerationJSON(t, env, alice, created.ID)
	if strings.Contains(string(body), summary) {
		t.Fatalf("generation exposed external AI summary: %s", body)
	}
	var ready struct {
		Status         string `json:"status"`
		DecisionStatus string `json:"decision_status"`
		Sources        []struct {
			Kind string `json:"kind"`
		} `json:"sources"`
	}
	decode(t, body, &ready)
	if ready.Status != "succeeded" || ready.DecisionStatus != "confirmed" || len(ready.Sources) != 1 || ready.Sources[0].Kind != "external_ai_summary" {
		t.Fatalf("ready generation=%+v", ready)
	}
	var terminalSourceSummary *string
	if err = pool.QueryRow(ctx, `SELECT source.value->>'external_ai_summary' FROM personal_profile_generations generation
		CROSS JOIN LATERAL jsonb_array_elements(generation.sources) source(value)
		WHERE generation.id=$1 AND source.value->>'kind'='external_ai_summary'`, created.ID).Scan(&terminalSourceSummary); err != nil {
		t.Fatal(err)
	}
	if terminalSourceSummary != nil {
		t.Fatalf("terminal generation retained source summary: %q", *terminalSourceSummary)
	}
	if got := countDocumentVersions(t, ctx, pool); got != documentVersionsBefore {
		t.Fatalf("Document versions=%d want=%d", got, documentVersionsBefore)
	}
	assertCurrentProfileMarkdown(t, env, alice, "Prefers concise written plans")
}

func TestPersonalProfileSupplementUsesFrozenBaseline(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	generator := &recordingProfileGenerator{facts: []string{"Writes software.", "Writes software in Shanghai."}}
	application, err := newTestApp(ctx, config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.ArtifactStorageRoot = t.TempDir()
		c.ArtifactMaxBytes = 2 << 20
	}), skipping(app.SkillInstall), skipping(app.SkillPackageProbe),
		withPersonalProfileGenerator(generator), skipping(app.PersonalProfileJobs))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}
	alice := env.login("alice", alicePassword)

	status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/personal-profile-generations", map[string]any{
		"sources": []map[string]any{{"kind": "connection", "connection_id": "external_connection_missing"}},
	}, "profile-supplement-connection")
	if status != http.StatusNotFound {
		t.Fatalf("missing connection source status=%d body=%s", status, body)
	}

	status, _, body = env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/personal-profile-generations", map[string]any{
		"sources": []map[string]any{{"kind": "external_ai_summary", "summary": "I write backend systems."}},
	}, "profile-generation-1")
	if status != http.StatusCreated {
		t.Fatalf("create generation status=%d body=%s", status, body)
	}
	created := decodePersonalProfileGeneration(t, body)
	if created.Status != "queued" {
		t.Fatalf("created status=%s", created.Status)
	}
	if err = runJobsOnce(ctx, pool, application.AddPersonalProfileWorkers, "personal_profile.generation"); err != nil {
		t.Fatal(err)
	}
	var ready struct {
		Status                string  `json:"status"`
		DecisionStatus        string  `json:"decision_status"`
		CandidateRevisionID   *string `json:"candidate_revision_id"`
		BaseProfileRevisionID *string `json:"base_profile_revision_id"`
	}
	decode(t, personalProfileGenerationJSON(t, env, alice, created.ID), &ready)
	if ready.Status != "succeeded" || ready.DecisionStatus != "confirmed" || ready.CandidateRevisionID == nil || ready.BaseProfileRevisionID != nil {
		t.Fatalf("ready generation %+v", ready)
	}
	generator.mu.Lock()
	if len(generator.requests) != 1 || generator.requests[0].BaselineProfile != "" || len(generator.requests[0].Documents) != 1 {
		t.Fatalf("first generation requests=%+v", generator.requests)
	}
	generator.mu.Unlock()
	assertCurrentProfileMarkdown(t, env, alice, "Writes software")
	assertAccountProfile(t, env, alice, "Alice Generated", "Writes software.", "Acme Labs", false)

	status, _, body = env.request(alice, http.MethodPatch, "/v0/tenants/"+acmeTenant+"/account-profile", map[string]any{
		"name": "Alice Hand", "bio": "",
	}, "")
	if status != http.StatusOK {
		t.Fatalf("patch account status=%d body=%s", status, body)
	}
	assertAccountProfile(t, env, alice, "Alice Hand", "", "Acme Labs", true)

	status, _, body = env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/personal-profile-generations", map[string]any{
		"sources": []map[string]any{{"kind": "external_ai_summary", "summary": "Now based in Shanghai."}},
	}, "profile-generation-2")
	if status != http.StatusCreated {
		t.Fatalf("second create status=%d body=%s", status, body)
	}
	second := decodePersonalProfileGeneration(t, body)
	if err = runJobsOnce(ctx, pool, application.AddPersonalProfileWorkers, "personal_profile.generation"); err != nil {
		t.Fatal(err)
	}
	generator.mu.Lock()
	if len(generator.requests) != 2 || !strings.Contains(generator.requests[1].BaselineProfile, `"text":"Writes software."`) || !strings.Contains(generator.requests[1].Documents[0].Content, "Shanghai") {
		t.Fatalf("second generation did not receive frozen baseline: requests=%+v", generator.requests)
	}
	generator.mu.Unlock()
	status, _, body = env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/personal-profile", nil, "")
	if status != http.StatusOK {
		t.Fatalf("personal profile status=%d body=%s", status, body)
	}
	var profile struct {
		Current *struct {
			ID                        string  `json:"id"`
			SourceJourneyID           *string `json:"source_journey_id"`
			SourceProfileGenerationID *string `json:"source_profile_generation_id"`
			Markdown                  string  `json:"markdown"`
			Profile                   struct {
				Name        string `json:"name"`
				Preferences struct {
					Points []struct {
						Text string `json:"text"`
					} `json:"points"`
				} `json:"preferences"`
			} `json:"profile"`
		} `json:"current"`
	}
	decode(t, body, &profile)
	if profile.Current == nil || !strings.Contains(profile.Current.Markdown, "Shanghai") || profile.Current.Profile.Name != "Alice" ||
		len(profile.Current.Profile.Preferences.Points) != 1 || profile.Current.Profile.Preferences.Points[0].Text != "Writes software in Shanghai." || profile.Current.SourceJourneyID != nil ||
		profile.Current.SourceProfileGenerationID == nil || *profile.Current.SourceProfileGenerationID != second.ID {
		t.Fatalf("current profile %+v", profile)
	}
	var currentCount int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM personal_profile_currents WHERE tenant_id=$1`, acmeTenant).Scan(&currentCount); err != nil {
		t.Fatal(err)
	}
	if currentCount != 1 {
		t.Fatalf("current profile count=%d", currentCount)
	}
	assertAccountProfile(t, env, alice, "Alice Hand", "", "Acme Labs", true)
}

func TestPersonalProfileSupplementImportsGmailAndPublishes(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	generator := &recordingProfileGenerator{facts: []string{"Reads mail."}}
	gmail := &fakeGmailProvider{
		status:        composio.ConnectionActive,
		identityEmail: "alice@example.test",
		mail: []composio.AppDocument{{
			RemoteID: "thread_profile", Filename: "mail.md", Markdown: []byte("I ship backend systems at Acme."),
		}, {RemoteID: "message:over-budget", Filename: "long.md", Markdown: []byte(strings.Repeat("x", 144001)), ProfileMarkdown: []byte("Short authored excerpt from rejected mail")}},
	}
	composioFake := newFakeComposio(t)
	cfg := config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.ArtifactStorageRoot = t.TempDir()
		c.ArtifactMaxBytes = 2 << 20
	})
	composioFake.configure(&cfg)
	application, err := newTestApp(ctx, cfg, skipping(app.SkillInstall), skipping(app.SkillPackageProbe),
		withPersonalProfileGenerator(generator), skipping(app.PersonalProfileJobs),
		withComposio(gmail), skipping(app.PersonalWikiJobs))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}
	alice := env.login("alice", alicePassword)
	seedExternalConnection(t, ctx, pool, "external_connection_gmail_profile", "account_alice", "gmail", "active")
	composioFake.seedAccount(t, pool, "external_connection_gmail_profile-upstream", "account_alice", "gmail", composio.ConnectionActive)

	objects, err := artifactstore.NewLocalStore(cfg.ArtifactStorageRoot, 2<<20)
	if err != nil {
		t.Fatal(err)
	}
	for run := 0; run < 2; run++ {
		status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/personal-profile-generations", map[string]any{
			"sources": []map[string]any{{"kind": "connection", "connection_id": "external_connection_gmail_profile"}},
		}, fmt.Sprintf("profile-generation-gmail-%d", run))
		if status != http.StatusCreated {
			t.Fatalf("gmail generation status=%d body=%s", status, body)
		}
		var created struct {
			ID string `json:"id"`
		}
		decode(t, body, &created)
		// The generation waits for the background mailbox import, then retries.
		deadline := time.Now().Add(30 * time.Second)
		for {
			if _, err = pool.Exec(ctx, `UPDATE river_job SET scheduled_at=now() WHERE kind='personal_profile.generation' AND state='scheduled'`); err != nil {
				t.Fatal(err)
			}
			readyDocumentTexts(t, pool, objects, nil)
			if err = runJobsOnce(ctx, pool, application.AddPersonalProfileWorkers, "personal_profile.generation"); err != nil {
				t.Fatal(err)
			}
			body = personalProfileGenerationJSON(t, env, alice, created.ID)
			var generation struct {
				Status string `json:"status"`
			}
			decode(t, body, &generation)
			if generation.Status == "succeeded" {
				break
			}
			if generation.Status == "failed" {
				t.Fatalf("gmail generation %+v body=%s", generation, body)
			}
			if time.Now().After(deadline) {
				t.Fatalf("gmail generation did not succeed: %s", body)
			}
			time.Sleep(20 * time.Millisecond)
		}
		generator.mu.Lock()
		if len(generator.requests) != run+1 || len(generator.requests[run].Documents) != 1 || !strings.Contains(generator.requests[run].Documents[0].Content, "Acme") || (generator.requests[run].BaselineProfile != "") != (run == 1) {
			t.Fatalf("gmail generator requests=%+v", generator.requests)
		}
		generator.mu.Unlock()
		assertCurrentProfileMarkdown(t, env, alice, "Reads mail")
	}
	var admitted, rejected int
	if err = pool.QueryRow(ctx, `SELECT count(*) FILTER (WHERE reason IS NULL), count(*) FILTER (WHERE reason='too_large') FROM wiki_document_verdicts WHERE source='gmail'`).Scan(&admitted, &rejected); err != nil || admitted != 1 || rejected != 1 {
		t.Fatalf("Wiki verdicts: accepted=%d rejected=%d err=%v", admitted, rejected, err)
	}
	t.Log("Wiki verdicts: one accepted, one too_large; both Profile model calls received only the accepted mail")
	t.Run("empty Calendar reports no import content", assertPersonalProfileEmptyCalendarReportsNoImportContent)
}

func assertPersonalProfileEmptyCalendarReportsNoImportContent(t *testing.T) {
	ctx := context.Background()
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	generator := &recordingProfileGenerator{facts: []string{"Should not be generated."}}
	cfg := config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.ArtifactStorageRoot = t.TempDir()
		c.ArtifactMaxBytes = 2 << 20
	})
	newFakeComposio(t).configure(&cfg)
	application, err := newTestApp(ctx, cfg, withComposio(emptyGoogleCalendarProvider{}),
		skipping(app.SkillInstall), skipping(app.SkillPackageProbe),
		withPersonalProfileGenerator(generator), skipping(app.PersonalProfileJobs))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}
	alice := env.login("alice", alicePassword)
	if _, err = pool.Exec(ctx, `INSERT INTO external_connections(id,account_id,provider,upstream_connection_id,status,revision,remote_principal_key,identity_label,next_status_check_at) VALUES('external_connection_empty_calendar_profile','account_alice','google_calendar','empty-calendar-profile-upstream','active',1,'google_calendar:primary@example.test','Alice',now()+interval '1 hour')`); err != nil {
		t.Fatal(err)
	}

	httpStatus, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/personal-profile-generations", map[string]any{
		"sources": []map[string]any{{
			"kind": "connection", "connection_id": "external_connection_empty_calendar_profile",
			"selections": []map[string]any{{"remote_id": "team@example.test", "name": "Team", "kind": "google_calendar", "is_private": false}},
		}},
	}, "empty-calendar-profile")
	if httpStatus != http.StatusCreated {
		t.Fatalf("create empty Calendar generation status=%d body=%s", httpStatus, body)
	}
	created := decodePersonalProfileGeneration(t, body)
	if err = runJobsOnce(ctx, pool, application.AddPersonalProfileWorkers, "personal_profile.generation"); err != nil {
		t.Fatal(err)
	}

	body = personalProfileGenerationJSON(t, env, alice, created.ID)
	var generation struct {
		Status        string `json:"status"`
		LastErrorCode string `json:"last_error_code"`
		Sources       []struct {
			Provider string `json:"provider"`
		} `json:"sources"`
	}
	decode(t, body, &generation)
	if generation.Status != "failed" || generation.LastErrorCode != "NO_IMPORT_CONTENT" || len(generation.Sources) != 1 || generation.Sources[0].Provider != "google_calendar" {
		t.Fatalf("empty Calendar generation=%+v body=%s", generation, body)
	}
	generator.mu.Lock()
	defer generator.mu.Unlock()
	if len(generator.requests) != 0 {
		t.Fatalf("empty Calendar called profile generator: %+v", generator.requests)
	}
}

func TestPersonalProfileInputVersionStaysAfterSuccessAndFailure(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	generator := &recordingProfileGenerator{facts: []string{"Keeps uploaded files."}}
	storageRoot := t.TempDir()
	application, err := newTestApp(ctx, config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.ArtifactStorageRoot = storageRoot
		c.ArtifactMaxBytes = 2 << 20
	}), skipping(app.SkillInstall), skipping(app.SkillPackageProbe),
		withPersonalProfileGenerator(generator), skipping(app.PersonalProfileJobs),
		skipping(app.PersonalWikiJobs), skipping(app.JobQueue))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}
	alice := env.login("alice", alicePassword)
	documentVersionsBefore := countDocumentVersions(t, ctx, pool)

	objects, err := artifactstore.NewLocalStore(storageRoot, 2<<20)
	if err != nil {
		t.Fatal(err)
	}
	kept := []byte("# Resume\n\nI write backend systems.")
	keptID := mustUploadWikiProfileFile(t, env, alice, "resume.md", "text/markdown", kept, "wiki-profile-kept")
	status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/personal-profile-generations", map[string]any{
		"sources": []map[string]any{{"kind": "input_version", "input_version_id": keptID}},
	}, "wiki-profile-generation-success")
	if status != http.StatusCreated {
		t.Fatalf("create input_version generation status=%d body=%s", status, body)
	}
	created := decodePersonalProfileGeneration(t, body)
	readyDocumentTexts(t, pool, objects, nil)
	if err = runJobsOnce(ctx, pool, application.AddPersonalProfileWorkers, "personal_profile.generation"); err != nil {
		t.Fatal(err)
	}
	body = personalProfileGenerationJSON(t, env, alice, created.ID)
	var ready struct {
		Status  string `json:"status"`
		Sources []struct {
			Kind           string `json:"kind"`
			InputVersionID string `json:"input_version_id"`
			FileDeleted    *bool  `json:"file_deleted"`
		} `json:"sources"`
	}
	decode(t, body, &ready)
	if ready.Status != "succeeded" ||
		len(ready.Sources) != 1 || ready.Sources[0].Kind != "input_version" || ready.Sources[0].InputVersionID != keptID ||
		ready.Sources[0].FileDeleted == nil || *ready.Sources[0].FileDeleted {
		t.Fatalf("ready input_version generation %+v", ready)
	}
	generator.mu.Lock()
	if len(generator.requests) != 1 || len(generator.requests[0].Documents) != 1 || !strings.Contains(generator.requests[0].Documents[0].Content, "I write backend systems") {
		t.Fatalf("wiki file generator requests=%+v", generator.requests)
	}
	generator.mu.Unlock()
	assertCurrentProfileMarkdown(t, env, alice, "Keeps uploaded files")
	assertWikiInputVersionContent(t, env, alice, keptID, kept)

	failed := []byte("# Draft\n\nThis wiki file must survive a failed generation.")
	failedID := mustUploadWikiProfileFile(t, env, alice, "failed.md", "text/markdown", failed, "wiki-profile-failed")
	generator.mu.Lock()
	generator.err = errors.New("forced generator failure")
	generator.mu.Unlock()
	status, _, body = env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/personal-profile-generations", map[string]any{
		"sources": []map[string]any{{"kind": "input_version", "input_version_id": failedID}},
	}, "wiki-profile-generation-failed")
	if status != http.StatusCreated {
		t.Fatalf("failed input_version create status=%d body=%s", status, body)
	}
	created = decodePersonalProfileGeneration(t, body)
	readyDocumentTexts(t, pool, objects, nil)
	if err = runJobsOnce(ctx, pool, application.AddPersonalProfileWorkers, "personal_profile.generation"); err != nil {
		t.Fatal(err)
	}
	body = personalProfileGenerationJSON(t, env, alice, created.ID)
	var failedGeneration struct {
		Status string `json:"status"`
	}
	decode(t, body, &failedGeneration)
	if failedGeneration.Status != "failed" {
		t.Fatalf("failed generation status=%s body=%s", failedGeneration.Status, body)
	}
	assertWikiInputVersionContent(t, env, alice, failedID, failed)
	assertCurrentProfileMarkdown(t, env, alice, "Keeps uploaded files")
	// This document would fit after Profile truncation, but the full line is rejected.
	blockedID := mustUploadWikiProfileFile(t, env, alice, "oversized.md", "text/markdown", []byte(strings.Repeat("a", 144001)), "wiki-profile-line-limit")
	readyDocumentTexts(t, pool, objects, nil)
	status, _, body = env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/personal-profile-generations", map[string]any{"sources": []map[string]any{{"kind": "input_version", "input_version_id": blockedID}}}, "profile-generation-no-admitted-file")
	if status != http.StatusCreated {
		t.Fatalf("queue rejected input: %d %s", status, body)
	}
	created = decodePersonalProfileGeneration(t, body)
	if err = runJobsOnce(ctx, pool, application.AddPersonalProfileWorkers, "personal_profile.generation"); err != nil {
		t.Fatal(err)
	}
	var rejected struct {
		Status        string
		LastErrorCode string `json:"last_error_code"`
	}
	decode(t, personalProfileGenerationJSON(t, env, alice, created.ID), &rejected)
	if rejected.Status != "failed" || rejected.LastErrorCode != "NO_IMPORT_CONTENT" {
		t.Fatalf("rejected file: %+v", rejected)
	}
	generator.mu.Lock()
	if len(generator.requests) != 2 {
		t.Fatalf("rejected file reached the generator, calls=%d", len(generator.requests))
	}
	generator.mu.Unlock()
	assertCurrentProfileMarkdown(t, env, alice, "Keeps uploaded files")
	if got := countDocumentVersions(t, ctx, pool); got != documentVersionsBefore+3 {
		t.Fatalf("profile generation changed uploaded Document versions: before=%d after=%d want=%d", documentVersionsBefore, got, documentVersionsBefore+3)
	}
}

func TestPersonalProfileNotionImportPublishesWithoutWikiInput(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	generator := &recordingProfileGenerator{facts: []string{"Reads shared pages."}}
	notion := &fakeNotionProvider{
		botID:     "bot-profile-test",
		workspace: "Acme Labs",
		resource: composio.NotionResource{
			ID: "page-about", Title: "About me", Kind: "notion_page", URL: "https://www.notion.so/About",
		},
		markdown: "I build agents at Acme.",
	}
	composioFake := newFakeComposio(t)
	cfg := config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.ArtifactStorageRoot = t.TempDir()
		c.ArtifactMaxBytes = 2 << 20
	})
	composioFake.configure(&cfg)
	application, err := newTestApp(ctx, cfg, skipping(app.SkillInstall), skipping(app.SkillPackageProbe),
		withPersonalProfileGenerator(generator), skipping(app.PersonalProfileJobs),
		skipping(app.PersonalWikiJobs), withComposio(notion), starting(app.JobQueue))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}
	alice := env.login("alice", alicePassword)
	seedNotionProfileConnection(t, ctx, pool, "external_connection_notion_profile", notion.botID)
	composioFake.seedAccount(t, pool, "external_connection_notion_profile-upstream", "account_alice", "notion", composio.ConnectionActive)
	documentVersionsBefore := countDocumentVersions(t, ctx, pool)

	status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/personal-profile-generations", map[string]any{
		"sources": []map[string]any{{
			"kind": "connection", "connection_id": "external_connection_notion_profile",
			"selections": []map[string]any{{
				"remote_id": "page-about", "name": "About me", "kind": "notion_page", "is_private": false,
			}},
		}},
	}, "wiki-profile-generation-notion")
	if status != http.StatusCreated {
		t.Fatalf("notion generation status=%d body=%s", status, body)
	}
	created := decodePersonalProfileGeneration(t, body)
	deadline := time.Now().Add(5 * time.Second)
	for {
		if err = runJobsOnce(ctx, pool, application.AddPersonalProfileWorkers, "personal_profile.generation"); err != nil {
			t.Fatal(err)
		}
		body = personalProfileGenerationJSON(t, env, alice, created.ID)
		var generation struct {
			Status string `json:"status"`
		}
		decode(t, body, &generation)
		if generation.Status == "succeeded" {
			break
		}
		if generation.Status == "failed" {
			t.Fatalf("notion generation %+v body=%s", generation, body)
		}
		if time.Now().After(deadline) {
			t.Fatalf("notion generation did not succeed: %s", body)
		}
		time.Sleep(20 * time.Millisecond)
	}
	generator.mu.Lock()
	if len(generator.requests) != 1 || len(generator.requests[0].Documents) == 0 ||
		!strings.Contains(generator.requests[0].Documents[0].Content, "I build agents at Acme") ||
		!strings.Contains(generator.requests[0].Documents[0].Content, "Provenance: notion_page") {
		t.Fatalf("notion generator requests=%+v", generator.requests)
	}
	generator.mu.Unlock()
	assertCurrentProfileMarkdown(t, env, alice, "Reads shared pages")
	if got := countDocumentVersions(t, ctx, pool); got != documentVersionsBefore {
		t.Fatalf("notion persisted Document versions=%d want=%d", got, documentVersionsBefore)
	}
}

func TestAccountProfileImages(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	application, err := newTestApp(ctx, config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.ArtifactStorageRoot = t.TempDir()
		c.ArtifactMaxBytes = 2 << 20
	}), skipping(app.SkillInstall), skipping(app.SkillPackageProbe),
		skipping(app.PersonalProfileJobs))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}
	assertAccountProfileImages(t, env, env.login("alice", alicePassword))
}

func assertCurrentProfileMarkdown(t *testing.T, env *testEnv, client *http.Client, want string) {
	t.Helper()
	status, _, body := env.request(client, http.MethodGet, "/v0/tenants/"+acmeTenant+"/personal-profile", nil, "")
	if status != http.StatusOK {
		t.Fatalf("personal profile status=%d body=%s", status, body)
	}
	var profile struct {
		Current *struct {
			Markdown string `json:"markdown"`
		} `json:"current"`
	}
	decode(t, body, &profile)
	if profile.Current == nil || !strings.Contains(profile.Current.Markdown, want) {
		t.Fatalf("current profile %+v want %q", profile, want)
	}
}

func assertAccountProfile(t *testing.T, env *testEnv, client *http.Client, name, bio, organization string, nameManaged bool) {
	t.Helper()
	status, _, body := env.request(client, http.MethodGet, "/v0/tenants/"+acmeTenant+"/account-profile", nil, "")
	if status != http.StatusOK {
		t.Fatalf("account profile status=%d body=%s", status, body)
	}
	var profile struct {
		Name            string `json:"name"`
		Bio             string `json:"bio"`
		Organization    string `json:"organization"`
		NameUserManaged bool   `json:"name_user_managed"`
	}
	decode(t, body, &profile)
	if profile.Name != name || profile.Bio != bio || profile.Organization != organization || profile.NameUserManaged != nameManaged {
		t.Fatalf("account profile %+v want name=%q bio=%q org=%q managed=%v", profile, name, bio, organization, nameManaged)
	}
}

func mustUploadWikiProfileFile(t *testing.T, env *testEnv, client *http.Client, filename, mediaType string, content []byte, key string) string {
	t.Helper()
	status, _, body := requestUnifiedDocumentMultipart(
		t, env, client, "/v0/tenants/"+acmeTenant+"/documents/uploads", key,
		map[string]string{
			"filename": filename, "representation_format": "binary", "media_type": mediaType,
		}, filename, content,
	)
	if status != http.StatusCreated {
		t.Fatalf("upload profile Document status=%d body=%s", status, body)
	}
	var document struct {
		CurrentVersion *struct {
			ID string `json:"id"`
		} `json:"current_version"`
	}
	decode(t, body, &document)
	if document.CurrentVersion == nil || document.CurrentVersion.ID == "" {
		t.Fatalf("profile Document Version missing id: %s", body)
	}
	return document.CurrentVersion.ID
}

func assertWikiInputVersionContent(t *testing.T, env *testEnv, client *http.Client, versionID string, want []byte) {
	t.Helper()
	status, _, body := env.request(client, http.MethodGet, "/v0/document-versions/"+versionID+"/content", nil, "")
	if status != http.StatusOK || !bytes.Equal(body, want) {
		t.Fatalf("wiki input version %s status=%d body=%q want=%q", versionID, status, body, want)
	}
}

func countDocumentVersions(t *testing.T, ctx context.Context, pool *pgxpool.Pool) int {
	t.Helper()
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM document_versions`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func seedNotionProfileConnection(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id, botID string) {
	t.Helper()
	if _, err := pool.Exec(ctx, `INSERT INTO external_connections(id,account_id,provider,upstream_connection_id,status,identity_label,remote_principal_key) VALUES($1,'account_alice','notion',$1||'-upstream','active','Acme Labs','notion:'||$2)`, id, botID); err != nil {
		t.Fatal(err)
	}
}

// personalProfileGenerationJSON reads one generation through the list route,
// the only generation read the client uses.
func personalProfileGenerationJSON(t *testing.T, env *testEnv, client *http.Client, id string) []byte {
	t.Helper()
	status, _, body := env.request(client, http.MethodGet, "/v0/tenants/"+acmeTenant+"/personal-profile-generations", nil, "")
	if status != http.StatusOK {
		t.Fatalf("list generations status=%d body=%s", status, body)
	}
	var list struct {
		Items []json.RawMessage `json:"items"`
	}
	decode(t, body, &list)
	for _, item := range list.Items {
		var listed struct {
			ID string `json:"id"`
		}
		decode(t, item, &listed)
		if listed.ID == id {
			return item
		}
	}
	t.Fatalf("generation %s is not listed: %s", id, body)
	return nil
}

func decodePersonalProfileGeneration(t *testing.T, body []byte) struct {
	ID     string `json:"id"`
	Status string `json:"status"`
} {
	t.Helper()
	var created struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	decode(t, body, &created)
	if created.ID == "" {
		t.Fatalf("generation missing id: %s", body)
	}
	return created
}

func assertAccountProfileImages(t *testing.T, env *testEnv, alice *http.Client) {
	t.Helper()
	var imageBytes bytes.Buffer
	if err := png.Encode(&imageBytes, image.NewRGBA(image.Rect(0, 0, 4, 4))); err != nil {
		t.Fatal(err)
	}
	photo := "data:image/png;base64," + base64.StdEncoding.EncodeToString(imageBytes.Bytes())
	endpoint := "/v0/tenants/" + acmeTenant + "/account-profile"
	status, _, body := env.request(alice, http.MethodPatch, endpoint, map[string]any{"avatar_image": photo, "background_image": photo, "name": "Alice Photo"}, "")
	if status != http.StatusOK {
		t.Fatalf("patch status=%d body=%s", status, body)
	}
	status, _, body = env.request(alice, http.MethodGet, endpoint, nil, "")
	var profile map[string]any
	if err := json.Unmarshal(body, &profile); err != nil {
		t.Fatal(err)
	}
	if status != http.StatusOK || profile["avatar_image"] != photo || profile["background_image"] != photo || profile["name"] != "Alice Photo" {
		t.Fatal("saved images/name did not round trip")
	}
	status, _, _ = env.request(alice, http.MethodPatch, endpoint, map[string]any{"avatar_image": "data:image/png;base64,bm90LWltYWdl"}, "")
	if status != http.StatusBadRequest {
		t.Fatalf("invalid image status=%d", status)
	}
	status, _, body = env.request(alice, http.MethodPatch, endpoint, map[string]any{"avatar_image": ""}, "")
	if err := json.Unmarshal(body, &profile); err != nil {
		t.Fatal(err)
	}
	if status != http.StatusOK || profile["avatar_image"] != "" || profile["background_image"] != photo {
		t.Fatal("clear changed background")
	}
}
