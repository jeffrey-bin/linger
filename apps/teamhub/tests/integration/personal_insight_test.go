package integration_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/emailevidence"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/personalinsight"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/personalprofile"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
)

type recordingPersonalInsightGenerator struct {
	mu    sync.Mutex
	calls int
}

func (g *recordingPersonalInsightGenerator) GenerateEvidence(_ context.Context, _, subjectID string, evidence []personalinsight.GroundingEvidence) (personalinsight.GenerationResult, error) {
	g.mu.Lock()
	g.calls++
	g.mu.Unlock()
	result := personalinsight.ValidateEvidenceDrafts(subjectID, evidence, []personalinsight.InsightDraft{{
		Dimension: "Communication style",
		Basis:     personalinsight.InsightBasisExplicit,
		Statement: "You prefer written decisions before a team commits to a plan.",
		EvidenceIDs: []string{
			evidence[0].Source.EvidenceID,
		},
	}})
	result.Model = "test-person-model"
	return result, nil
}

func TestPersonalInsightLifecycleFromProfileTriggerToPrivateDeletion(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	profileGenerator := &recordingProfileGenerator{}
	insightGenerator := &recordingPersonalInsightGenerator{}
	application, err := newIntegrationApp(ctx, config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.ArtifactStorageRoot = t.TempDir()
		c.ArtifactMaxBytes = 2 << 20
	}), withPersonalProfileGenerator(profileGenerator), withPersonalInsightGenerator(insightGenerator),
		skipping(app.PersonalProfileJobs), skipping(app.PersonalInsightJobs))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}
	alice := env.login("alice", alicePassword)

	status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/personal-profile-generations", map[string]any{
		"sources": []map[string]any{{"kind": "external_ai_summary", "summary": "I write backend systems."}},
	}, "personal-insight-profile-generation")
	if status != http.StatusCreated {
		t.Fatalf("create Profile generation status=%d body=%s", status, body)
	}
	var profileGeneration struct {
		ID string `json:"id"`
	}
	decode(t, body, &profileGeneration)
	if err = runJobsOnce(ctx, pool, application.AddPersonalProfileWorkers, "personal_profile.generation"); err != nil {
		t.Fatal(err)
	}
	var queuedStatus, insightDocuments string
	if err = pool.QueryRow(ctx, `SELECT insight_status,insight_documents::text FROM personal_profile_generations WHERE id=$1`, profileGeneration.ID).Scan(&queuedStatus, &insightDocuments); err != nil {
		t.Fatal(err)
	}
	if queuedStatus != "queued" {
		t.Fatalf("Personal Insight status=%s want queued", queuedStatus)
	}
	if insightDocuments != "[]" {
		t.Fatalf("an external AI summary became Insight evidence: %s", insightDocuments)
	}
	if err = runJobsOnce(ctx, pool, application.AddPersonalInsightWorkers, "personal_insight.generation"); err != nil {
		t.Fatal(err)
	}
	insightGenerator.mu.Lock()
	if insightGenerator.calls != 0 {
		t.Fatalf("generator called %d times without eligible evidence", insightGenerator.calls)
	}
	insightGenerator.mu.Unlock()

	const insightGenerationID = "personal_profile_generation_insight_gmail"
	if _, err = pool.Exec(ctx, `
		INSERT INTO personal_profile_generations(
			id,tenant_id,owner_actor_id,status,decision_status,prompt_version,completed_at
		) VALUES($1,$2,$3,'succeeded','confirmed',$4,now())`,
		insightGenerationID, acmeTenant, "actor_acme_alice", personalprofile.PromptVersion); err != nil {
		t.Fatal(err)
	}
	gmailMessages, err := json.Marshal([]emailevidence.MessageInput{{
		ThreadID: "thread-insight", MessageID: "self", Direction: emailevidence.DirectionOutbound,
		Body: "I prefer written decisions. private-evidence-sentinel",
	}})
	if err != nil {
		t.Fatal(err)
	}
	gmailDocument := personalprofile.InsightDocument{Provider: "gmail", Filename: "insight/thread-insight.json", Content: string(gmailMessages)}
	insightService := personalinsight.New(pool, insightGenerator)
	enqueuePersonalInsight(t, pool, insightService, insightGenerationID, gmailDocument)
	if err = runJobsOnce(ctx, pool, application.AddPersonalInsightWorkers, "personal_insight.generation"); err != nil {
		t.Fatal(err)
	}

	status, _, body = env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/personal-insights", nil, "")
	if status != http.StatusOK {
		t.Fatalf("list Personal Insights status=%d body=%s", status, body)
	}
	if strings.Contains(string(body), "evidence") || strings.Contains(string(body), "test-person-model") || strings.Contains(string(body), "private-evidence-sentinel") || strings.Contains(string(body), "basis") {
		t.Fatalf("Personal Insight API leaked internal provenance: %s", body)
	}
	var listed struct {
		Items []struct {
			ID        string `json:"id"`
			Dimension string `json:"dimension"`
			Statement string `json:"statement"`
		} `json:"items"`
		LatestGeneration struct {
			Status string `json:"status"`
		} `json:"latest_generation"`
	}
	decode(t, body, &listed)
	if len(listed.Items) != 1 || listed.Items[0].Dimension != "Communication style" || !strings.HasPrefix(listed.Items[0].Statement, "You prefer") || listed.LatestGeneration.Status != "succeeded" {
		t.Fatalf("unexpected Personal Insight response: %+v", listed)
	}
	var storedEvidence string
	if err = pool.QueryRow(ctx, `SELECT evidence::text FROM personal_insights WHERE id=$1`, listed.Items[0].ID).Scan(&storedEvidence); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(storedEvidence, "private-evidence-sentinel") {
		t.Fatalf("stored evidence omitted bounded excerpt: %s", storedEvidence)
	}
	var storedModel, sourceGeneration string
	var settledDocuments *string
	if err = pool.QueryRow(ctx, `
		SELECT insight.model,insight.source_generation_id,generation.insight_documents::text
		FROM personal_insights insight
		JOIN personal_profile_generations generation ON generation.id=insight.source_generation_id
		WHERE insight.id=$1`, listed.Items[0].ID).Scan(&storedModel, &sourceGeneration, &settledDocuments); err != nil || storedModel != "test-person-model" || sourceGeneration != insightGenerationID {
		t.Fatalf("the answering model and Profile generation must be recorded: model=%q generation=%q err=%v", storedModel, sourceGeneration, err)
	}
	if settledDocuments != nil {
		t.Fatalf("a settled Insight step kept its mail evidence: %s", *settledDocuments)
	}

	status, _, body = env.request(alice, http.MethodDelete, "/v0/tenants/"+acmeTenant+"/personal-insights/"+listed.Items[0].ID, nil, "")
	if status != http.StatusNoContent {
		t.Fatalf("delete Personal Insight status=%d body=%s", status, body)
	}
	if err = pool.QueryRow(ctx, `SELECT evidence::text FROM personal_insights WHERE id=$1`, listed.Items[0].ID).Scan(&storedEvidence); err != nil || storedEvidence != "[]" {
		t.Fatalf("dismissed evidence=%q err=%v", storedEvidence, err)
	}
	status, _, body = env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/personal-insights", nil, "")
	if status != http.StatusOK || !strings.Contains(string(body), `"items":[]`) {
		t.Fatalf("list after delete status=%d body=%s", status, body)
	}

	const replayGenerationID = "personal_profile_generation_insight_replay"
	if _, err = pool.Exec(ctx, `
		INSERT INTO personal_profile_generations(
			id,tenant_id,owner_actor_id,status,decision_status,prompt_version,completed_at
		) VALUES($1,$2,$3,'succeeded','confirmed',$4,now())`,
		replayGenerationID, acmeTenant, "actor_acme_alice", personalprofile.PromptVersion); err != nil {
		t.Fatal(err)
	}
	enqueuePersonalInsight(t, pool, insightService, replayGenerationID, gmailDocument)
	if err = runJobsOnce(ctx, pool, application.AddPersonalInsightWorkers, "personal_insight.generation"); err != nil {
		t.Fatal(err)
	}
	status, _, body = env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/personal-insights", nil, "")
	if status != http.StatusOK || !strings.Contains(string(body), `"items":[]`) {
		t.Fatalf("dismissed Insight regenerated status=%d body=%s", status, body)
	}
}

type waitingPersonalInsightGenerator struct {
	calls atomic.Int32
	err   error
}

func (g *waitingPersonalInsightGenerator) GenerateEvidence(context.Context, string, string, []personalinsight.GroundingEvidence) (personalinsight.GenerationResult, error) {
	g.calls.Add(1)
	return personalinsight.GenerationResult{}, errors.Join(personalinsight.ErrGeneratorUnavailable, g.err)
}

// An offline Computer and a model call still pending in the Agent Service
// both snooze the generation without spending an attempt.
func TestPersonalInsightWaitsForTheModelWithoutSpendingAnAttempt(t *testing.T) {
	allowParallelIntegrationTest(t)
	for _, test := range []struct {
		err  error
		code string
	}{
		{roomagent.ErrModelCallComputerOffline, "COMPUTER_OFFLINE_WAIT"},
		{roomagent.ErrModelCallPending, "MODEL_CALL_PENDING_WAIT"},
	} {
		t.Run(test.code, func(t *testing.T) {
			personalInsightWaitsForTheModel(t, test.err, test.code)
		})
	}
}

func personalInsightWaitsForTheModel(t *testing.T, waitErr error, wantCode string) {
	ctx := context.Background()
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	generator := &waitingPersonalInsightGenerator{err: waitErr}
	application, err := newIntegrationApp(ctx, config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.ArtifactStorageRoot = t.TempDir()
		c.ArtifactMaxBytes = 2 << 20
	}), withPersonalInsightGenerator(generator),
		skipping(app.PersonalProfileJobs), skipping(app.PersonalInsightJobs))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	const generationID = "personal_profile_generation_insight_offline"
	if _, err = pool.Exec(ctx, `
		INSERT INTO personal_profile_generations(
			id,tenant_id,owner_actor_id,status,decision_status,prompt_version,completed_at
		) VALUES($1,$2,$3,'succeeded','confirmed',$4,now())`,
		generationID, acmeTenant, "actor_acme_alice", personalprofile.PromptVersion); err != nil {
		t.Fatal(err)
	}
	messages, err := json.Marshal([]emailevidence.MessageInput{{
		ThreadID: "thread-offline", MessageID: "self", Direction: emailevidence.DirectionOutbound,
		Body: "I prefer written decisions.",
	}})
	if err != nil {
		t.Fatal(err)
	}
	enqueuePersonalInsight(t, pool, personalinsight.New(pool, generator), generationID,
		personalprofile.InsightDocument{Provider: "gmail", Filename: "insight/thread-offline.json", Content: string(messages)})
	if err = runJobsOnce(ctx, pool, application.AddPersonalInsightWorkers, "personal_insight.generation"); err != nil {
		t.Fatal(err)
	}
	if generator.calls.Load() != 1 {
		t.Fatalf("generator calls=%d want 1", generator.calls.Load())
	}
	var status, code, jobState string
	var errorCount int
	if err = pool.QueryRow(ctx, `
		SELECT generation.insight_status,coalesce(generation.insight_error_code,''),job.state,coalesce(array_length(job.errors,1),0)
		FROM personal_profile_generations generation
		JOIN river_job job ON job.kind='personal_insight.generation' AND job.args->>'generation_id'=generation.id
		WHERE generation.id=$1`, generationID).Scan(&status, &code, &jobState, &errorCount); err != nil {
		t.Fatal(err)
	}
	if status != "queued" || code != wantCode || jobState != "scheduled" || errorCount != 0 {
		t.Fatalf("waiting for the model must snooze the generation: status=%s code=%s job=%s errors=%d", status, code, jobState, errorCount)
	}
}

// enqueuePersonalInsight queues the Insight step of a succeeded Profile
// generation the way the Profile worker does when it publishes.
func enqueuePersonalInsight(t *testing.T, pool *pgxpool.Pool, service *personalinsight.Service, generationID string, documents ...personalprofile.InsightDocument) {
	t.Helper()
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err = service.Enqueue(ctx, tx, generationID, documents); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}
