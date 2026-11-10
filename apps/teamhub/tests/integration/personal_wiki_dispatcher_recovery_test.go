package integration_test

import (
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
)

type recoveringWikiGraphUpdater struct {
	mu       sync.Mutex
	calls    int
	failures int
}

func (u *recoveringWikiGraphUpdater) UpdatePublishedWiki(context.Context, string, string, string) error {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.calls++
	if u.calls <= u.failures {
		return errors.New("Memory graph temporarily unavailable")
	}
	return nil
}

func (u *recoveringWikiGraphUpdater) callCount() int {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.calls
}

func TestUnifiedWikiPublicationQueuesGraphUpdateAndRiverRetriesIt(t *testing.T) {
	allowParallelIntegrationTest(t)
	updater := &recoveringWikiGraphUpdater{failures: 1}
	generator := &recordingWikiCandidateGenerator{response: document.WikiCandidateGenerationResult{
		Pages: []document.WikiPageCandidate{{PageKey: "index.md", Markdown: []byte("# Index\n")}},
	}}
	fixture := newUnifiedWikiDispatchCase(t, "durablegraphupdate", generator, document.WikiRefreshDispatchOptions{
		GenerationTimeout: time.Hour, MaxAttempts: 3,
	})

	if worked, err := deliverWikiAttempt(t, fixture.pool, fixture.dispatcher, fixture.admission.ID); err != nil || !worked {
		t.Fatalf("Wiki publication worked=%v err=%v", worked, err)
	}
	if updater.callCount() != 0 {
		t.Fatalf("graph update ran inline with publication: calls=%d", updater.callCount())
	}
	var refreshStatus, jobState string
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT refresh.status,
		(SELECT job.state FROM river_job job
		 WHERE job.kind='document.personal_wiki_graph_update'
		   AND job.args->>'wiki_revision_id'=refresh.result_wiki_revision_id)
		FROM document_wiki_refreshes refresh WHERE refresh.id=$1`, fixture.admission.ID).Scan(&refreshStatus, &jobState); err != nil {
		t.Fatal(err)
	}
	if refreshStatus != "settled" || jobState != "available" {
		t.Fatalf("refresh=%s graph_job=%s", refreshStatus, jobState)
	}

	startDocumentJobsForTest(t, fixture.pool, fixture.service, updater)
	if !waitForDocumentJobState(t, fixture.pool, fixture.admission.ID, "completed") {
		t.Fatalf("graph update job did not complete; calls=%d", updater.callCount())
	}
	if updater.callCount() != 2 {
		t.Fatalf("graph update calls=%d, want one failed attempt and one retry", updater.callCount())
	}
}

// waitForDocumentJobState waits for the Personal Wiki graph job of a refresh.
func waitForDocumentJobState(t *testing.T, pool *pgxpool.Pool, refreshID, state string) bool {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		var current string
		if err := pool.QueryRow(t.Context(), `SELECT job.state FROM river_job job
			JOIN document_wiki_refreshes refresh ON job.args->>'wiki_revision_id'=refresh.result_wiki_revision_id
			WHERE job.kind='document.personal_wiki_graph_update' AND refresh.id=$1`, refreshID).Scan(&current); err != nil {
			t.Fatal(err)
		}
		if current == state {
			return true
		}
		time.Sleep(50 * time.Millisecond)
	}
	return false
}

func TestUnifiedWikiDispatcherUsesCanonicalAgentAndBeneficiaryForFirstRevision(t *testing.T) {
	allowParallelIntegrationTest(t)
	generator := &recordingWikiCandidateGenerator{response: document.WikiCandidateGenerationResult{
		Pages: []document.WikiPageCandidate{{PageKey: "index.md", Markdown: []byte("# Index\n")}},
	}}
	fixture := newUnifiedWikiDispatchCase(t, "firstrevision", generator, document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 3})
	if worked, err := deliverWikiAttempt(t, fixture.pool, fixture.dispatcher, fixture.admission.ID); err != nil || !worked {
		t.Fatalf("delivery worked=%v err=%v", worked, err)
	}
	calls := generator.callsSnapshot()
	if len(calls) != 1 || calls[0].GeneratorAgentActorID != "actor_agent_a" {
		t.Fatalf("candidate calls=%+v", calls)
	}
	var revisionID, currentRevisionID string
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT refresh.result_wiki_revision_id,wiki.current_revision_id
		FROM document_wiki_refreshes refresh JOIN personal_wikis wiki ON wiki.id=refresh.wiki_id
		WHERE refresh.id=$1`, fixture.admission.ID).Scan(&revisionID, &currentRevisionID); err != nil {
		t.Fatal(err)
	}
	if revisionID == "" || currentRevisionID != revisionID {
		t.Fatalf("result revision=%q current=%q", revisionID, currentRevisionID)
	}
}

func TestUnifiedWikiDispatcherRejectsCandidateResultForUnknownRefresh(t *testing.T) {
	allowParallelIntegrationTest(t)
	generator := &recordingWikiCandidateGenerator{response: document.WikiCandidateGenerationResult{
		RefreshID: "document_wiki_refresh_unknown",
		Pages:     []document.WikiPageCandidate{{PageKey: "index.md", Markdown: []byte("# Index\n")}},
	}}
	fixture := newUnifiedWikiDispatchCase(t, "unknownresult", generator, document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 3})
	if worked, err := deliverWikiAttempt(t, fixture.pool, fixture.dispatcher, fixture.admission.ID); err == nil || !worked {
		t.Fatalf("delivery worked=%v err=%v", worked, err)
	}
	var status, errorCode string
	var revisions int
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT status,coalesce(dispatch_last_error_code,''),
		(SELECT count(*) FROM personal_wikis WHERE id=refresh.wiki_id AND current_revision_id IS NOT NULL)
		FROM document_wiki_refreshes refresh WHERE id=$1`, fixture.admission.ID).Scan(&status, &errorCode, &revisions); err != nil {
		t.Fatal(err)
	}
	if status != "staging" || errorCode != "candidate_unavailable" || revisions != 0 {
		t.Fatalf("status=%s code=%s revisions=%d", status, errorCode, revisions)
	}
}

// failingFirstPutObjectStore fails its first page write, as an unavailable
// object store does.
type failingFirstPutObjectStore struct {
	artifactstore.ObjectStore
	failed *bool
}

func (s failingFirstPutObjectStore) PutIfAbsent(ctx context.Context, key string, source io.Reader, size int64, digest [sha256.Size]byte) (artifactstore.Object, bool, error) {
	if !*s.failed {
		*s.failed = true
		return artifactstore.Object{}, false, errors.New("object store unavailable")
	}
	return s.ObjectStore.PutIfAbsent(ctx, key, source, size, digest)
}

// A settlement that cannot store its pages is retried; the retry generates
// the candidate set again, since nothing was frozen before publication.
func TestUnifiedWikiDispatcherRetriesSettlementThatCannotStorePages(t *testing.T) {
	allowParallelIntegrationTest(t)
	generator := &recordingWikiCandidateGenerator{response: document.WikiCandidateGenerationResult{
		Pages: []document.WikiPageCandidate{{PageKey: "index.md", Markdown: []byte("# Index\n")}},
	}}
	fixture := newUnifiedWikiDispatchCase(t, "storeretry", generator,
		document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 3})
	failed := false
	fixture.service = document.NewWithObjectStore(fixture.pool, failingFirstPutObjectStore{ObjectStore: fixture.objects, failed: &failed})
	dispatcher, err := document.NewWikiRefreshDispatcher(fixture.pool, fixture.objects, generator, fixture.service,
		document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 3})
	if err != nil {
		t.Fatal(err)
	}
	if worked, err := deliverWikiAttempt(t, fixture.pool, dispatcher, fixture.admission.ID); err == nil || !worked {
		t.Fatalf("first delivery worked=%v err=%v", worked, err)
	}
	var status, errorCode string
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT status,coalesce(dispatch_last_error_code,'')
		FROM document_wiki_refreshes WHERE id=$1`, fixture.admission.ID).Scan(&status, &errorCode); err != nil {
		t.Fatal(err)
	}
	if status != "staging" || errorCode != "settlement_unavailable" {
		t.Fatalf("status=%s code=%s", status, errorCode)
	}
	if worked, err := deliverWikiAttempt(t, fixture.pool, dispatcher, fixture.admission.ID); err != nil || !worked {
		t.Fatalf("retry delivery worked=%v err=%v", worked, err)
	}
	if calls := generator.callsSnapshot(); len(calls) != 2 {
		t.Fatalf("generator calls=%d", len(calls))
	}
	assertPersonalWikiRefreshState(t, fixture, "idle")
}

func TestUnifiedWikiDispatcherFailsFinalAttemptAndStops(t *testing.T) {
	allowParallelIntegrationTest(t)
	generator := &recordingWikiCandidateGenerator{fail: errors.New("candidate service unavailable")}
	fixture := newUnifiedWikiDispatchCase(t, "finalattempt", generator, document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 1})
	if worked, err := deliverWikiAttempt(t, fixture.pool, fixture.dispatcher, fixture.admission.ID); err != nil || !worked {
		t.Fatalf("delivery worked=%v err=%v", worked, err)
	}
	var status, errorCode string
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT status,coalesce(dispatch_last_error_code,'') FROM document_wiki_refreshes WHERE id=$1`, fixture.admission.ID).Scan(&status, &errorCode); err != nil {
		t.Fatal(err)
	}
	if status != "failed" || errorCode != "candidate_unavailable" {
		t.Fatalf("status=%s code=%s ", status, errorCode)
	}
	if worked, err := deliverWikiAttempt(t, fixture.pool, fixture.dispatcher, fixture.admission.ID); err != nil || worked {
		t.Fatalf("second delivery worked=%v err=%v", worked, err)
	}
}

func insertWikiRefreshFollowupForTest(t *testing.T, pool *pgxpool.Pool, refreshID string) {
	t.Helper()
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(t.Context()) }()
	if err := jobs.InsertTx(t.Context(), tx, document.WikiRefreshFollowupArgs{RefreshID: refreshID}, nil); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
}
