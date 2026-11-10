package integration_test

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

// One TeamHub runs per database, so at start a dispatch attempt still marked
// running belonged to a stopped process; TeamHub makes it available before
// River starts instead of waiting out the generation timeout, without
// spending the attempt the restart interrupted.
func TestWikiDispatchStoppedMidAttemptResumesAtStart(t *testing.T) {
	allowParallelIntegrationTest(t)
	generator := &recordingWikiCandidateGenerator{response: document.WikiCandidateGenerationResult{
		Pages: []document.WikiPageCandidate{{PageKey: "index.md", Markdown: []byte("# Index\n")}},
	}}
	fixture := newUnifiedWikiDispatchCase(t, "stoppedattempt", generator,
		document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 3})
	if _, err := fixture.pool.Exec(fixture.ctx, `UPDATE river_job
		SET state='running',attempt=1,attempted_at=clock_timestamp()
		WHERE kind='document.wiki_refresh_dispatch' AND args->>'refresh_id'=$1`, fixture.admission.ID); err != nil {
		t.Fatal(err)
	}
	if worked, err := deliverWikiAttempt(t, fixture.pool, fixture.dispatcher, fixture.admission.ID); err != nil || worked {
		t.Fatalf("running attempt was delivered again worked=%v err=%v", worked, err)
	}
	// A Memory graph update shares the queue; River's rescuer owns it, so the
	// start leaves it running.
	var graphUpdateJobID int64
	if err := fixture.pool.QueryRow(fixture.ctx, `INSERT INTO river_job(kind, queue, args, max_attempts, state, attempt, attempted_at)
		VALUES ('document.personal_wiki_graph_update', 'personal_wiki', jsonb_build_object('id', $1::text), 20, 'running', 1, clock_timestamp())
		RETURNING id`, "graph-"+fixture.admission.ID).Scan(&graphUpdateJobID); err != nil {
		t.Fatal(err)
	}
	if err := document.ResumeInterruptedWikiDispatch(fixture.ctx, fixture.pool); err != nil {
		t.Fatal(err)
	}
	var graphUpdateState string
	if err := fixture.pool.QueryRow(fixture.ctx, `DELETE FROM river_job WHERE id=$1 RETURNING state`,
		graphUpdateJobID).Scan(&graphUpdateState); err != nil || graphUpdateState != "running" {
		t.Fatalf("graph update state after start=%q err=%v", graphUpdateState, err)
	}
	if worked, err := deliverWikiAttempt(t, fixture.pool, fixture.dispatcher, fixture.admission.ID); err != nil || !worked {
		t.Fatalf("resumed delivery worked=%v err=%v", worked, err)
	}
	var status string
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT status FROM document_wiki_refreshes WHERE id=$1`,
		fixture.admission.ID).Scan(&status); err != nil || status != "settled" {
		t.Fatalf("resumed refresh status=%q err=%v", status, err)
	}
	// The interrupted attempt was given back, so the restart spent none.
	if attempt := wikiDispatchJobAttempt(t, fixture.pool, fixture.admission.ID); attempt != 1 {
		t.Fatalf("resumed attempt=%d want=1", attempt)
	}
}

// Only settlement writes a Wiki page: neither its Human owner's Wiki binding
// nor the generator's ownership of the page Document grants write access.
func TestWikiPagesAreReadOnlyOutsideSettlement(t *testing.T) {
	allowParallelIntegrationTest(t)
	generator := &recordingWikiCandidateGenerator{response: document.WikiCandidateGenerationResult{
		Pages: []document.WikiPageCandidate{{PageKey: "index.md", Markdown: []byte("# Index\n")}},
	}}
	fixture := newUnifiedWikiDispatchCase(t, "readonlypages", generator,
		document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 3})
	if worked, err := deliverWikiAttempt(t, fixture.pool, fixture.dispatcher, fixture.admission.ID); err != nil || !worked {
		t.Fatalf("publication worked=%v err=%v", worked, err)
	}
	var pageID string
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT document_id FROM document_wiki_pages
		WHERE wiki_id='wiki_document_a' AND page_key='index.md'`).Scan(&pageID); err != nil {
		t.Fatal(err)
	}
	var humanRead, humanWrite, agentRead, agentWrite bool
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT
		(SELECT can_read FROM resolve_human_document_access_v2('account_document_a',$1)),
		(SELECT can_write FROM resolve_human_document_access_v2('account_document_a',$1)),
		(SELECT can_read FROM resolve_agent_document_access_v2('agent_document_a',$1)),
		(SELECT can_write FROM resolve_agent_document_access_v2('agent_document_a',$1))`, pageID).Scan(
		&humanRead, &humanWrite, &agentRead, &agentWrite); err != nil {
		t.Fatal(err)
	}
	if !humanRead || humanWrite || !agentRead || agentWrite {
		t.Fatalf("Wiki page access human read=%t write=%t agent read=%t write=%t",
			humanRead, humanWrite, agentRead, agentWrite)
	}
	expiresAt := time.Now().Add(time.Hour)
	if _, err := fixture.service.IssueCollaborationCredential(fixture.ctx, document.IssueCollaborationCredentialInput{
		AccountID: "account_document_a", DocumentID: pageID, ExpiresAt: expiresAt,
	}); !errors.Is(err, document.ErrNotFound) {
		t.Fatalf("write credential for a Wiki page err=%v", err)
	}
}

// Reading a Human's Wiki never writes: before any source exists there is no
// Wiki root, and the first source upload creates it.
func TestPersonalWikiReadsDoNotCreateTheRoot(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(t, 0, 0, 0, roomDocumentRuntimeTestOptions{})
	empty := readPersonalWikiHTTPStatus(t, env, alice)
	if empty.Id != nil || empty.State != "idle" || empty.PublishedGeneration != 0 || empty.LatestRefreshId != nil {
		t.Fatalf("Wiki before any source=%+v", empty)
	}
	status, _, body := env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/personal-wiki/documents", nil, "")
	var page struct {
		Items []any `json:"items"`
	}
	decode(t, body, &page)
	if status != http.StatusOK || len(page.Items) != 0 {
		t.Fatalf("Wiki Documents before any source status=%d body=%s", status, body)
	}
	if roots := countRows(t, env, `SELECT count(*) FROM personal_wikis WHERE owner_actor_id=$1`, empty.OwnerActorId); roots != 0 {
		t.Fatalf("reads created %d Wiki roots", roots)
	}
	uploadUnifiedWikiSourceWithKey(t, env, alice, "wiki-first-source-creates-root", "first.txt",
		"plain_text", "text/plain", []byte("first source"))
	created := readPersonalWikiHTTPStatus(t, env, alice)
	if created.Id == nil || created.State != "idle" {
		t.Fatalf("Wiki after the first source=%+v", created)
	}
}

func TestFirstWikiFailureReachesPublicationWaiter(t *testing.T) {
	allowParallelIntegrationTest(t)
	f := newUnifiedWikiDispatchCase(t, "firstfailure", &recordingWikiCandidateGenerator{}, document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 1})
	application, err := newTestApp(t.Context(), config.ForTest(func(c *config.Config) {
		c.DatabaseURL = f.pool.Config().ConnString()
		c.TeamHubInternalToken = teamHubInternalToken
		c.ArtifactStorageRoot = f.objectRoot
	}), skipping(app.SkillInstall), skipping(app.PersonalWikiJobs), skipping(app.JobQueue))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	read := func(actor string, want int, code string) {
		t.Helper()
		request := httptest.NewRequest(http.MethodGet, "/v0/personal-wikis/"+actor+"/document-revision", nil)
		request.Header.Set("Authorization", "Bearer "+teamHubInternalToken)
		response := httptest.NewRecorder()
		application.Handler().ServeHTTP(response, request)
		if response.Code != want || !strings.Contains(response.Body.String(), code) {
			t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
		}
	}
	read("actor_human_a", http.StatusNotFound, "NOT_FOUND")
	if _, err := f.pool.Exec(f.ctx, `UPDATE document_wiki_refreshes SET status='failed',outcome='failed' WHERE id=$1`, f.admission.ID); err != nil {
		t.Fatal(err)
	}
	read("actor_human_a", http.StatusConflict, "WIKI_GENERATION_FAILED")
	read("actor_missing", http.StatusNotFound, "NOT_FOUND")
	read("actor_agent_a", http.StatusNotFound, "NOT_FOUND")
	insertWikiRefreshFollowupForTest(t, f.pool, f.admission.ID)
	read("actor_human_a", http.StatusNotFound, "NOT_FOUND")
}
