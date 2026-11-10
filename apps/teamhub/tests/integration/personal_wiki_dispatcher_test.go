package integration_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river/rivertype"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/contracts-go/nodeservicesinternal"
)

type unifiedWikiDispatchCase struct {
	ctx        context.Context
	db         *sql.DB
	pool       *pgxpool.Pool
	objectRoot string
	objects    artifactstore.ObjectStore
	service    *document.Service
	admission  document.WikiRefreshResult
	dispatcher *document.WikiRefreshDispatcher
}

// The failed transaction rolls back ordinary rows, so both the call count and
// injection witness use nontransactional sequences. nth=2 fails after an earlier
// uncommitted row; the caller must also assert no partial or duplicate results.
func injectSQLStateAt(t *testing.T, db *sql.DB, table string, nth int, sqlstate string) func() {
	t.Helper()
	calls := pgx.Identifier{table + "_fault_calls"}.Sanitize()
	fired := pgx.Identifier{table + "_fault_fired"}.Sanitize()
	trigger := pgx.Identifier{table + "_inject_fault"}.Sanitize()
	if _, err := db.ExecContext(t.Context(), fmt.Sprintf(`
		CREATE SEQUENCE %s; CREATE SEQUENCE %s;
		CREATE FUNCTION %s() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
		  IF nextval('%s')=%d THEN
		    PERFORM nextval('%s');
		    RAISE EXCEPTION 'injected transaction fault' USING ERRCODE='%s';
		  END IF; RETURN NEW; END $$;
		CREATE TRIGGER %s BEFORE INSERT ON %s FOR EACH ROW EXECUTE FUNCTION %s()`,
		calls, fired, trigger, calls, nth, fired, sqlstate, trigger,
		pgx.Identifier{table}.Sanitize(), trigger)); err != nil {
		t.Fatal(err)
	}
	return func() {
		t.Helper()
		var injected bool
		var attempts int
		if err := db.QueryRowContext(t.Context(), fmt.Sprintf(`SELECT
			(SELECT is_called AND last_value=1 FROM %s),
			(SELECT last_value FROM %s)`, fired, calls)).Scan(&injected, &attempts); err != nil {
			t.Errorf("%s SQLSTATE=%s injection witness: %v", table, sqlstate, err)
			return
		}
		t.Logf("%s SQLSTATE=%s nth=%d injected=%t insert_calls=%d", table, sqlstate, nth, injected, attempts)
		if !injected {
			t.Errorf("%s did not exercise SQLSTATE=%s after %d inserts (calls=%d)", table, sqlstate, nth, attempts)
		}
	}
}

type blockingUnifiedWikiGenerator struct {
	started chan document.WikiCandidateGenerationRequest
	release chan struct{}
	fail    error
}

func (g *blockingUnifiedWikiGenerator) GenerateWikiCandidates(ctx context.Context, request document.WikiCandidateGenerationRequest) (document.WikiCandidateGenerationResult, error) {
	request, err := readWikiCandidateRequest(ctx, request)
	if err != nil {
		return document.WikiCandidateGenerationResult{}, err
	}
	g.started <- request
	select {
	case <-ctx.Done():
		return document.WikiCandidateGenerationResult{}, ctx.Err()
	case <-g.release:
	}
	if g.fail != nil {
		return document.WikiCandidateGenerationResult{}, g.fail
	}
	return successfulWikiCandidateResult(request), nil
}

type retryingUnifiedWikiGenerator struct {
	mu       sync.Mutex
	attempts int
}

func (g *retryingUnifiedWikiGenerator) GenerateWikiCandidates(_ context.Context, request document.WikiCandidateGenerationRequest) (document.WikiCandidateGenerationResult, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.attempts++
	if g.attempts == 1 {
		return document.WikiCandidateGenerationResult{}, errors.New("candidate service unavailable")
	}
	return successfulWikiCandidateResult(request), nil
}

func successfulWikiCandidateResult(request document.WikiCandidateGenerationRequest) document.WikiCandidateGenerationResult {
	return document.WikiCandidateGenerationResult{
		RefreshID: request.RefreshID,
		Pages:     []document.WikiPageCandidate{{PageKey: "index.md", Markdown: []byte("# Index\n")}},
	}
}

func newUnifiedWikiDispatchCase(t *testing.T, suffix string, generator document.WikiCandidateGenerator, options document.WikiRefreshDispatchOptions, sourceOwners ...string) *unifiedWikiDispatchCase {
	t.Helper()
	f := newUnifiedWikiDispatchFixture(t, sourceOwners...)
	readyDocumentTexts(t, f.pool, f.objects, nil)
	admission, err := f.service.RequestWikiRefresh(f.ctx, document.RequestWikiRefreshInput{
		AccountID: "account_document_a", TenantID: "tenant_document_a", IdempotencyKey: "wiki-dispatch-" + suffix,
	})
	if err != nil || admission.Status != document.WikiRefreshAccepted {
		t.Fatalf("admission=%+v error=%v", admission, err)
	}
	f.admission = admission
	f.dispatcher, err = document.NewWikiRefreshDispatcher(f.pool, f.objects, generator, f.service, options)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func newUnifiedWikiDispatchFixture(t *testing.T, sourceOwners ...string) *unifiedWikiDispatchCase {
	t.Helper()
	ctx := context.Background()
	db, pool := newUnifiedWikiFixture(t, "")
	objectRoot := t.TempDir()
	objects, err := artifactstore.NewLocalStore(objectRoot, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	content := []byte("frozen Wiki source bytes")
	digest := sha256.Sum256(content)
	object, _, err := objects.PutIfAbsent(ctx, "object_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", bytes.NewReader(content), int64(len(content)), digest)
	if err != nil {
		t.Fatal(err)
	}
	seedWikiDispatchSource(t, ctx, db, object, digest)
	if len(sourceOwners) > 0 && sourceOwners[0] == "agent" {
		if _, err := db.ExecContext(ctx, `INSERT INTO documents(
			id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,
			creator_actor_kind,status
		) VALUES(
			'document_wiki_agent_source','tenant_document_a','Agent source','binary',
			'actor_agent_a','agent','actor_agent_a','agent','active'
		)`); err != nil {
			t.Fatal(err)
		}
		if _, err := db.ExecContext(ctx, `INSERT INTO document_versions(
			id,tenant_id,document_id,version_number,filename,representation_format,
			media_type,size_bytes,sha256,content_object_id,source,created_by_actor_id
		) VALUES(
			'version_wiki_agent_source','tenant_document_a','document_wiki_agent_source',1,
			'agent-source.txt','plain_text','text/plain',$1,$2,$3,
			'ordinary_upload','actor_agent_a'
		)`, object.Size, hex.EncodeToString(digest[:]), object.Key); err != nil {
			t.Fatal(err)
		}
		if _, err := db.ExecContext(ctx, `UPDATE documents SET current_version_id='version_wiki_agent_source'
			WHERE id='document_wiki_agent_source'`); err != nil {
			t.Fatal(err)
		}
		if _, err := db.ExecContext(ctx, `INSERT INTO document_context_bindings(
			id,tenant_id,document_id,binding_kind,wiki_id,status
		) VALUES(
			'binding_wiki_agent_source','tenant_document_a','document_wiki_agent_source',
			'wiki_source','wiki_document_a','active'
		)`); err != nil {
			t.Fatal(err)
		}
	}
	if len(sourceOwners) > 0 && sourceOwners[0] == "replaceable" {
		if _, err := db.ExecContext(ctx, `INSERT INTO documents(
			id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,
			creator_actor_kind,status
		) VALUES(
			'document_wiki_replaceable_source','tenant_document_a','Replaceable source','plain_text',
			'actor_human_a','human','actor_human_a','human','active'
		)`); err != nil {
			t.Fatal(err)
		}
		if _, err := db.ExecContext(ctx, `INSERT INTO document_versions(
			id,tenant_id,document_id,version_number,filename,representation_format,
			media_type,size_bytes,sha256,content_object_id,source,created_by_actor_id
		) VALUES(
			'version_wiki_replaceable_source','tenant_document_a','document_wiki_replaceable_source',1,
			'replaceable.txt','plain_text','text/plain',$1,$2,$3,
			'ordinary_upload','actor_human_a'
		)`, object.Size, hex.EncodeToString(digest[:]), object.Key); err != nil {
			t.Fatal(err)
		}
		if _, err := db.ExecContext(ctx, `UPDATE documents SET current_version_id='version_wiki_replaceable_source'
			WHERE id='document_wiki_replaceable_source'`); err != nil {
			t.Fatal(err)
		}
		if _, err := db.ExecContext(ctx, `INSERT INTO document_context_bindings(
			id,tenant_id,document_id,binding_kind,wiki_id,status
		) VALUES(
			'binding_wiki_replaceable_source','tenant_document_a','document_wiki_replaceable_source',
			'wiki_source','wiki_document_a','active'
		)`); err != nil {
			t.Fatal(err)
		}
	}
	service := document.NewWithObjectStore(pool, objects)
	return &unifiedWikiDispatchCase{ctx: ctx, db: db, pool: pool, objectRoot: objectRoot, objects: objects, service: service}
}

// An update writes a Version only for the pages it changes: a page repeated
// unchanged keeps its Version. Settlement leaves no staging rows behind.
func TestUnifiedWikiUpdateWritesVersionsOnlyForChangedPages(t *testing.T) {
	allowParallelIntegrationTest(t)
	generator := &recordingWikiCandidateGenerator{response: document.WikiCandidateGenerationResult{Pages: []document.WikiPageCandidate{
		{PageKey: "index.md", Markdown: []byte("# Index\n")},
		{PageKey: "topic.md", Markdown: []byte("# Topic\n")},
	}}}
	options := document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 1}
	fixture := newUnifiedWikiDispatchCase(t, "changedpages", generator, options, "replaceable")
	dispatcher, err := document.NewWikiRefreshDispatcher(fixture.pool, fixture.objects, generator, fixture.service, options)
	if err != nil {
		t.Fatal(err)
	}
	pageVersions := func() map[string]string {
		t.Helper()
		rows, err := fixture.pool.Query(fixture.ctx, `SELECT page.page_key,document.current_version_id
			FROM document_wiki_pages page JOIN documents document ON document.id=page.document_id
			WHERE page.wiki_id='wiki_document_a'`)
		if err != nil {
			t.Fatal(err)
		}
		versions := make(map[string]string)
		for rows.Next() {
			var pageKey, versionID string
			if err := rows.Scan(&pageKey, &versionID); err != nil {
				t.Fatal(err)
			}
			versions[pageKey] = versionID
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		return versions
	}
	if worked, err := deliverWikiAttempt(t, fixture.pool, dispatcher, fixture.admission.ID); err != nil || !worked {
		t.Fatalf("initial publication worked=%v err=%v", worked, err)
	}
	initial := pageVersions()
	replaceUnifiedWikiDispatchSource(t, fixture, "updated source")
	generator.response.Pages = []document.WikiPageCandidate{
		{PageKey: "index.md", Markdown: []byte("# Index\n")},
		{PageKey: "topic.md", Markdown: []byte("# Topic updated\n")},
	}
	readyDocumentTexts(t, fixture.pool, fixture.objects, nil)
	update, err := fixture.service.RequestWikiRefresh(fixture.ctx, document.RequestWikiRefreshInput{
		AccountID: "account_document_a", TenantID: "tenant_document_a", IdempotencyKey: "changed-pages-update",
	})
	if err != nil || update.Status != document.WikiRefreshAccepted {
		t.Fatalf("update admission=%+v err=%v", update, err)
	}
	if worked, err := deliverWikiAttempt(t, fixture.pool, dispatcher, update.ID); err != nil || !worked {
		t.Fatalf("update worked=%v err=%v", worked, err)
	}
	updated := pageVersions()
	if len(updated) != 2 || updated["index.md"] != initial["index.md"] || updated["topic.md"] == initial["topic.md"] {
		t.Fatalf("page versions initial=%v updated=%v", initial, updated)
	}
	// The generator's base pages are the published pages' current Markdown.
	calls := generator.callsSnapshot()
	if len(calls) != 2 || len(calls[1].BasePages) != 2 || string(calls[1].BasePages[1].Content) != "# Topic\n" {
		t.Fatalf("update base pages=%+v", calls)
	}
	var staging int
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT count(*) FROM document_wiki_refresh_sources`).Scan(&staging); err != nil || staging != 0 {
		t.Fatalf("staging rows after settlement=%d err=%v", staging, err)
	}
}

func TestUnifiedWikiRefreshAdmissionReturnsBeforeAsynchronousDispatchCompletes(t *testing.T) {
	allowParallelIntegrationTest(t)
	generator := &blockingUnifiedWikiGenerator{started: make(chan document.WikiCandidateGenerationRequest, 1), release: make(chan struct{})}
	fixture := newUnifiedWikiDispatchCase(t, "async", generator, document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 3})
	result := make(chan error, 1)
	go func() {
		delivered, err := deliverWikiAttempt(t, fixture.pool, fixture.dispatcher, fixture.admission.ID)
		if err == nil && !delivered {
			err = errors.New("dispatcher did not claim admitted refresh")
		}
		result <- err
	}()
	request := <-generator.started
	if fixture.admission.ID == "" || request.RefreshID != fixture.admission.ID {
		t.Fatalf("admission=%+v request=%+v", fixture.admission, request)
	}
	var status string
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT status FROM document_wiki_refreshes WHERE id=$1`, fixture.admission.ID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "staging" {
		t.Fatalf("status while candidate generation blocked=%q", status)
	}
	close(generator.release)
	if err := <-result; err != nil {
		t.Fatal(err)
	}
}

func TestUnifiedWikiDispatcherRetriesAndRecoversWithNewInstance(t *testing.T) {
	allowParallelIntegrationTest(t)
	generator := &retryingUnifiedWikiGenerator{}
	fixture := newUnifiedWikiDispatchCase(t, "restartretry", generator, document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 3})
	worked, firstDeliveryErr := deliverWikiAttempt(t, fixture.pool, fixture.dispatcher, fixture.admission.ID)
	if firstDeliveryErr == nil || !worked {
		t.Fatalf("first delivery worked=%v err=%v", worked, firstDeliveryErr)
	}
	var status string
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT status FROM document_wiki_refreshes WHERE id=$1`, fixture.admission.ID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "staging" || wikiDispatchJobAttempt(t, fixture.pool, fixture.admission.ID) != 1 {
		t.Fatalf("first_delivery_error=%v status=%s attempts=%d", firstDeliveryErr, status, wikiDispatchJobAttempt(t, fixture.pool, fixture.admission.ID))
	}
	restarted, err := document.NewWikiRefreshDispatcher(fixture.pool, fixture.objects, generator, fixture.service, document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 3})
	if err != nil {
		t.Fatal(err)
	}
	if worked, err := deliverWikiAttempt(t, fixture.pool, restarted, fixture.admission.ID); err != nil || !worked {
		t.Fatalf("restarted delivery worked=%v err=%v", worked, err)
	}
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT status FROM document_wiki_refreshes WHERE id=$1`, fixture.admission.ID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "settled" || wikiDispatchJobAttempt(t, fixture.pool, fixture.admission.ID) != 2 {
		t.Fatalf("status=%s attempts=%d", status, wikiDispatchJobAttempt(t, fixture.pool, fixture.admission.ID))
	}
}

// A source that changes after admission waits for the next refresh:
// settlement queues no follow-up for it.
func TestUnifiedWikiRefreshFreezesCurrentVersionAndTheNextRefreshTakesTheChange(t *testing.T) {
	allowParallelIntegrationTest(t)
	generator := &recordingWikiCandidateGenerator{response: document.WikiCandidateGenerationResult{
		Pages: []document.WikiPageCandidate{{PageKey: "index.md", Markdown: []byte("# Index\n")}},
	}}
	fixture := newUnifiedWikiDispatchCase(t, "changedfollowup", generator, document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 3}, "replaceable")
	secondVersionID := replaceUnifiedWikiDispatchSource(t, fixture, "changed Wiki source bytes")
	if worked, err := deliverWikiAttempt(t, fixture.pool, fixture.dispatcher, fixture.admission.ID); err != nil || !worked {
		t.Fatalf("first delivery worked=%v err=%v", worked, err)
	}
	firstCalls := generator.callsSnapshot()
	if len(firstCalls) != 1 || !hasWikiCandidateSourceVersion(firstCalls[0],
		"document_wiki_replaceable_source", "version_wiki_replaceable_source") {
		t.Fatalf("first frozen calls=%+v", firstCalls)
	}
	if followups := countWikiRefreshFollowups(t, fixture.db, fixture.admission.ID); followups != 0 {
		t.Fatalf("settlement queued %d follow-ups for a source changed after admission", followups)
	}
	readyDocumentTexts(t, fixture.pool, fixture.objects, nil)
	second, err := fixture.service.RequestWikiRefresh(fixture.ctx, document.RequestWikiRefreshInput{
		AccountID: "account_document_a", TenantID: "tenant_document_a", IdempotencyKey: "wiki-dispatch-changed-followup-2",
	})
	if err != nil || second.Status != document.WikiRefreshAccepted || second.ID == fixture.admission.ID {
		t.Fatalf("follow-up=%+v error=%v", second, err)
	}
	if worked, err := deliverWikiAttempt(t, fixture.pool, fixture.dispatcher, second.ID); err != nil || !worked {
		t.Fatalf("follow-up delivery worked=%v err=%v", worked, err)
	}
	secondCalls := generator.callsSnapshot()
	if len(secondCalls) != 2 || !hasWikiCandidateSourceVersion(secondCalls[1],
		"document_wiki_replaceable_source", secondVersionID) {
		t.Fatalf("follow-up frozen calls=%+v", secondCalls)
	}
}

func TestUnifiedWikiHTTPDispatcherStreamsFrozenSourcesAndBasePages(t *testing.T) {
	allowParallelIntegrationTest(t)
	calls := make(chan nodeservicesinternal.WikiRefreshCandidateGenerationRequest, 2)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var payload nodeservicesinternal.WikiRefreshCandidateGenerationRequest
		decoder := json.NewDecoder(request.Body)
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&payload); err != nil {
			t.Error(err)
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		calls <- payload
		content := []byte("# Index\n")
		digest := sha256.Sum256(content)
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(nodeservicesinternal.WikiRefreshCandidateGenerationResult{WikiRefreshId: payload.WikiRefreshId, Pages: []nodeservicesinternal.WikiRefreshCandidatePage{{PageKey: "index.md", MarkdownContent: content, MarkdownSha256: hex.EncodeToString(digest[:])}}})
	}))
	defer server.Close()
	generator, err := document.NewHTTPWikiCandidateGenerator(server.URL, "test-token", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	fixture := newUnifiedWikiDispatchCase(t, "streamhttp", generator, document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 3}, "replaceable")
	newVersion := replaceUnifiedWikiDispatchSource(t, fixture, "changed Wiki source bytes")
	if worked, err := deliverWikiAttempt(t, fixture.pool, fixture.dispatcher, fixture.admission.ID); err != nil || !worked {
		t.Fatalf("initialize: worked=%v err=%v", worked, err)
	}
	first := <-calls
	if first.Mode != "initialize" {
		t.Fatalf("first mode=%s", first.Mode)
	}
	found := false
	for _, source := range first.Changes.Added {
		if source.DocumentId == "document_wiki_replaceable_source" {
			found = true
			if source.DocumentVersionId != "version_wiki_replaceable_source" || strings.Contains(string(source.Content), "changed") {
				t.Fatal("source changed after admission was not frozen")
			}
		}
	}
	if !found {
		t.Fatal("frozen source not sent")
	}
	readyDocumentTexts(t, fixture.pool, fixture.objects, nil)
	refresh, err := fixture.service.RequestWikiRefresh(fixture.ctx, document.RequestWikiRefreshInput{AccountID: "account_document_a", TenantID: "tenant_document_a", IdempotencyKey: "wiki-stream-update"})
	if err != nil || refresh.Status != document.WikiRefreshAccepted {
		t.Fatalf("update admission: %+v %v", refresh, err)
	}
	if worked, err := deliverWikiAttempt(t, fixture.pool, fixture.dispatcher, refresh.ID); err != nil || !worked {
		t.Fatalf("update: worked=%v err=%v", worked, err)
	}
	second := <-calls
	if second.Mode != "update" || len(second.BasePages) != 1 || string(second.BasePages[0].MarkdownContent) != "# Index\n" || len(second.Changes.Modified) != 1 || len(second.Changes.Added) != 0 {
		t.Fatalf("update lost frozen delta/baseline: %+v", second)
	}
	if second.Changes.Modified[0].DocumentVersionId != newVersion || string(second.Changes.Modified[0].Content) != "changed Wiki source bytes" {
		t.Fatal("update did not stream admitted source version")
	}
	var state string
	if err := fixture.pool.QueryRow(t.Context(), `SELECT status FROM document_wiki_refreshes WHERE id=$1`, refresh.ID).Scan(&state); err != nil || state != "settled" {
		t.Fatalf("update settlement=%s err=%v", state, err)
	}
}

func TestUnifiedWikiRefreshAcceptsHumanAndSponsoredAgentOwnedSourcesAfterRestart(t *testing.T) {
	allowParallelIntegrationTest(t)
	for _, testCase := range []struct{ name, ownerID, ownerKind string }{
		{name: "human", ownerID: "actor_human_a", ownerKind: "human"},
		{name: "sponsored agent", ownerID: "actor_agent_a", ownerKind: "agent"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			generator := &recordingWikiCandidateGenerator{response: document.WikiCandidateGenerationResult{
				Pages: []document.WikiPageCandidate{{PageKey: "index.md", Markdown: []byte("# Index\n")}},
			}}
			owners := []string(nil)
			if testCase.ownerKind == "agent" {
				owners = []string{"agent"}
			}
			fixture := newUnifiedWikiDispatchCase(t, "restartowner"+testCase.ownerKind, generator, document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 3}, owners...)
			restartedService := document.NewWithObjectStore(fixture.pool, fixture.objects)
			restarted, err := document.NewWikiRefreshDispatcher(fixture.pool, fixture.objects, generator, restartedService, document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 3})
			if err != nil {
				t.Fatal(err)
			}
			if worked, err := deliverWikiAttempt(t, fixture.pool, restarted, fixture.admission.ID); err != nil || !worked {
				t.Fatalf("restarted delivery worked=%v err=%v", worked, err)
			}
			calls := generator.callsSnapshot()
			if len(calls) != 1 || !containsWikiSourceOwnedBy(calls[0], testCase.ownerID) {
				t.Fatalf("candidate calls=%+v", calls)
			}
		})
	}
}

func TestUnifiedWikiRefreshAcrossServiceInstancesCreatesOneDurableActiveRefresh(t *testing.T) {
	allowParallelIntegrationTest(t)
	fixture := newUnifiedWikiDispatchCase(t, "replicas", &recordingWikiCandidateGenerator{}, document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 3})
	secondService := document.New(fixture.pool)
	second, err := secondService.RequestWikiRefresh(fixture.ctx, document.RequestWikiRefreshInput{
		AccountID: "account_document_a", TenantID: "tenant_document_a", IdempotencyKey: "wiki-dispatch-replicas-second",
	})
	if err != nil || second.Status != document.WikiRefreshInProgress || second.ID != fixture.admission.ID {
		t.Fatalf("second admission=%+v error=%v", second, err)
	}
	var active int
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT count(*) FROM document_wiki_refreshes WHERE wiki_id=$1 AND status='staging'`, fixture.admission.WikiID).Scan(&active); err != nil {
		t.Fatal(err)
	}
	if active != 1 {
		t.Fatalf("active refreshes=%d", active)
	}
}

func replaceUnifiedWikiDispatchSource(t *testing.T, fixture *unifiedWikiDispatchCase, content string) string {
	t.Helper()
	result, err := fixture.service.UploadVersion(fixture.ctx, document.UploadDocumentVersionInput{
		AccountID: "account_document_a", DocumentID: "document_wiki_replaceable_source",
		ExpectedCurrentVersionID: "version_wiki_replaceable_source",
		IdempotencyKey:           "wiki-source-replacement",
		Filename:                 "source.txt",
		RepresentationFormat:     "plain_text",
		MediaType:                "text/plain",
		Content:                  bytes.NewBufferString(content),
	})
	if err != nil {
		t.Fatal(err)
	}
	return result.Version.ID
}

func hasWikiCandidateSourceVersion(request document.WikiCandidateGenerationRequest, documentID, versionID string) bool {
	for _, source := range slices.Concat(request.Changes.Added, request.Changes.Modified) {
		if source.DocumentID == documentID && source.DocumentVersionID == versionID {
			return true
		}
	}
	return false
}

func containsWikiSourceOwnedBy(request document.WikiCandidateGenerationRequest, ownerActorID string) bool {
	for _, source := range request.Changes.Added {
		switch ownerActorID {
		case "actor_human_a":
			if source.DocumentID == "document_human_a" {
				return true
			}
		case "actor_agent_a":
			if source.DocumentID == "document_wiki_agent_source" {
				return true
			}
		}
	}
	return false
}

// Entering staging enqueues the dispatch job in the same transaction, on the
// personal_wiki queue, with the River attempt budget.
func TestWikiRefreshStagingEnqueuesDispatchJob(t *testing.T) {
	allowParallelIntegrationTest(t)
	generator := &recordingWikiCandidateGenerator{response: document.WikiCandidateGenerationResult{
		Pages: []document.WikiPageCandidate{{PageKey: "index.md", Markdown: []byte("# Index\n")}},
	}}
	fixture := newUnifiedWikiDispatchCase(t, "stagingjob", generator, document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 5})
	var jobs, maxAttempts int
	var queue string
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT count(*),coalesce(max(queue),''),coalesce(max(max_attempts),0)
		FROM river_job WHERE kind='document.wiki_refresh_dispatch' AND args->>'refresh_id'=$1`, fixture.admission.ID).Scan(&jobs, &queue, &maxAttempts); err != nil {
		t.Fatal(err)
	}
	if jobs != 1 || queue != "personal_wiki" || maxAttempts != 10 {
		t.Fatalf("dispatch jobs=%d queue=%s max_attempts=%d", jobs, queue, maxAttempts)
	}
}

// A duplicate run after settlement must not commit again: the second attempt
// observes the settled refresh and returns without a second revision.
func TestWikiDuplicateDispatchSettlesOnce(t *testing.T) {
	allowParallelIntegrationTest(t)
	generator := &recordingWikiCandidateGenerator{response: document.WikiCandidateGenerationResult{
		Pages: []document.WikiPageCandidate{{PageKey: "index.md", Markdown: []byte("# Index\n")}},
	}}
	fixture := newUnifiedWikiDispatchCase(t, "duplicate", generator, document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 5})
	if worked, err := deliverWikiAttempt(t, fixture.pool, fixture.dispatcher, fixture.admission.ID); err != nil || !worked {
		t.Fatalf("first delivery worked=%v err=%v", worked, err)
	}
	if err := fixture.dispatcher.WorkRefresh(fixture.ctx, fixture.admission.ID, 2); err != nil {
		t.Fatalf("duplicate attempt after settlement: %v", err)
	}
	var status string
	var revisions int
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT (SELECT status FROM document_wiki_refreshes WHERE id=$1),
		(SELECT count(*) FROM personal_wikis WHERE current_revision_id IS NOT NULL)`, fixture.admission.ID).Scan(&status, &revisions); err != nil {
		t.Fatal(err)
	}
	if status != "settled" || revisions != 1 || len(generator.callsSnapshot()) != 1 {
		t.Fatalf("status=%s revisions=%d generator calls=%d", status, revisions, len(generator.callsSnapshot()))
	}
}

// A deploy starts the new TeamHub while the old one still runs an attempt, and
// the new one resumes that attempt. The second attempt must wait instead of
// generating beside the first, and its wait must not spend an attempt.
func TestWikiDispatchAttemptWaitsWhileAnotherRunsTheRefresh(t *testing.T) {
	allowParallelIntegrationTest(t)
	started := make(chan struct{})
	release := make(chan struct{})
	generator := &recordingWikiCandidateGenerator{
		response: document.WikiCandidateGenerationResult{
			Pages: []document.WikiPageCandidate{{PageKey: "index.md", Markdown: []byte("# Index\n")}},
		},
		beforeReturn: func(context.Context, document.WikiCandidateGenerationRequest) error {
			close(started)
			<-release
			return nil
		},
	}
	fixture := newUnifiedWikiDispatchCase(t, "overlap", generator, document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 5})
	first := make(chan error, 1)
	go func() { first <- fixture.dispatcher.WorkRefresh(fixture.ctx, fixture.admission.ID, 1) }()
	select {
	case <-started:
	case <-time.After(10 * time.Second):
		t.Fatal("the first attempt did not reach generation")
	}
	second := make(chan error, 1)
	go func() { second <- fixture.dispatcher.WorkRefresh(fixture.ctx, fixture.admission.ID, 2) }()
	var snooze *rivertype.JobSnoozeError
	select {
	case err := <-second:
		if !errors.As(err, &snooze) {
			close(release)
			t.Fatalf("overlapping attempt err=%v, want a snooze", err)
		}
	case <-time.After(10 * time.Second):
		close(release)
		t.Fatal("the overlapping attempt generated beside the first instead of waiting")
	}
	close(release)
	if err := <-first; err != nil {
		t.Fatal(err)
	}
	var status string
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT status FROM document_wiki_refreshes WHERE id=$1`, fixture.admission.ID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "settled" || len(generator.callsSnapshot()) != 1 {
		t.Fatalf("status=%s generator calls=%d", status, len(generator.callsSnapshot()))
	}
	// Once the first attempt let go, a later attempt runs instead of waiting.
	if err := fixture.dispatcher.WorkRefresh(fixture.ctx, fixture.admission.ID, 3); err != nil {
		t.Fatalf("attempt after the first finished: %v", err)
	}
}

// The final attempt records the failure, so the refresh is failed rather than
// left staging. Later attempts from a rescued job are then no-ops and cannot
// revive it.
func TestWikiDispatchFailsRefreshAfterFinalAttempt(t *testing.T) {
	allowParallelIntegrationTest(t)
	generator := &retryingUnifiedWikiGenerator{}
	fixture := newUnifiedWikiDispatchCase(t, "finalattempt", generator, document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 1})
	if err := fixture.dispatcher.WorkRefresh(fixture.ctx, fixture.admission.ID, 1); err != nil {
		t.Fatalf("final attempt must finish without error: %v", err)
	}
	var status string
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT status FROM document_wiki_refreshes WHERE id=$1`, fixture.admission.ID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "failed" {
		t.Fatalf("status=%s after the final attempt", status)
	}
	if err := fixture.dispatcher.WorkRefresh(fixture.ctx, fixture.admission.ID, 2); err != nil {
		t.Fatalf("a spare attempt on a failed refresh: %v", err)
	}
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT status FROM document_wiki_refreshes WHERE id=$1`, fixture.admission.ID).Scan(&status); err != nil || status != "failed" {
		t.Fatalf("spare attempt revived the refresh: status=%s err=%v", status, err)
	}
}

func TestWikiRefreshPreviewIsScopedAndRetiredAtPublication(t *testing.T) {
	allowParallelIntegrationTest(t)
	release := make(chan struct{})
	var finish sync.Once
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input nodeservicesinternal.WikiRefreshCandidateGenerationRequest
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			t.Error(err)
			return
		}
		if r.Header.Get("Accept") != "application/x-ndjson" {
			t.Error("preview stream was not requested")
		}
		w.Header().Set("Content-Type", "application/x-ndjson")
		out := json.NewEncoder(w)
		for range 2 {
			_ = out.Encode(map[string]any{"kind": "preview", "pages": map[string]string{"topics/launch.md": "# Launch"}})
		}
		w.(http.Flusher).Flush()
		<-release
		body := []byte("# Final index")
		digest := sha256.Sum256(body)
		_ = out.Encode(map[string]any{"kind": "final", "status": 200, "body": nodeservicesinternal.WikiRefreshCandidateGenerationResult{
			WikiRefreshId: input.WikiRefreshId, Pages: []nodeservicesinternal.WikiRefreshCandidatePage{{PageKey: "index.md", MarkdownContent: body, MarkdownSha256: hex.EncodeToString(digest[:])}},
		}})
	}))
	defer server.Close()
	defer finish.Do(func() { close(release) })
	generator, err := document.NewHTTPWikiCandidateGenerator(server.URL, "test-token", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	f := newUnifiedWikiDispatchCase(t, "preview", generator, document.WikiRefreshDispatchOptions{GenerationTimeout: time.Minute, MaxAttempts: 1})
	done := make(chan error, 1)
	go func() { done <- f.dispatcher.WorkRefresh(f.ctx, f.admission.ID, 1) }()
	status := func() document.PersonalWiki {
		w, err := f.service.GetPersonalWiki(f.ctx, "account_document_a", "tenant_document_a")
		if err != nil {
			t.Fatal(err)
		}
		return w
	}
	read := func(w document.PersonalWiki, id string) map[string]string {
		pages, err := f.service.PersonalWikiPreview(f.ctx, w, id)
		if err != nil {
			t.Fatal(err)
		}
		return pages
	}
	w := status()
	for until := time.Now().Add(10 * time.Second); w.PreviewRevision == 0 && time.Now().Before(until); w = status() {
		time.Sleep(10 * time.Millisecond)
	}
	if w.PreviewRevision != 1 || w.PublishedGeneration != 0 || read(w, f.admission.ID)["topics/launch.md"] != "# Launch" {
		t.Fatal("expected only the staged preview")
	}
	if len(read(w, "different-refresh")) > 0 {
		t.Fatal("another refresh read this preview")
	}
	other := w
	other.ID = "different-wiki"
	if len(read(other, f.admission.ID)) > 0 {
		t.Fatal("another Wiki read this preview")
	}
	finish.Do(func() { close(release) })
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	published := status()
	if published.PublishedGeneration != 1 || published.PreviewRevision != 0 || len(read(w, f.admission.ID)) != 0 {
		t.Fatal("publication did not retire the preview")
	}
}
