package integration_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

type recordingWikiCandidateGenerator struct {
	beforeReturn func(context.Context, document.WikiCandidateGenerationRequest) error
	mu           sync.Mutex
	calls        []document.WikiCandidateGenerationRequest
	fail         error
	response     document.WikiCandidateGenerationResult
}

type wikiDocumentPageResponse struct {
	Items []struct {
		ID   string `json:"id"`
		From []struct {
			Kind    string `json:"binding_kind"`
			PageKey string `json:"page_key"`
		} `json:"from"`
	} `json:"items"`
	Page struct {
		NextCursor string `json:"next_cursor"`
		HasMore    bool   `json:"has_more"`
	} `json:"page"`
}

func (g *recordingWikiCandidateGenerator) GenerateWikiCandidates(
	ctx context.Context,
	request document.WikiCandidateGenerationRequest,
) (document.WikiCandidateGenerationResult, error) {
	request, err := readWikiCandidateRequest(ctx, request)
	if err != nil {
		return document.WikiCandidateGenerationResult{}, err
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	g.calls = append(g.calls, request)
	if g.beforeReturn != nil {
		if err := g.beforeReturn(ctx, request); err != nil {
			return document.WikiCandidateGenerationResult{}, err
		}
	}
	if g.fail != nil {
		return document.WikiCandidateGenerationResult{}, g.fail
	}
	response := g.response
	if response.RefreshID == "" {
		response.RefreshID = request.RefreshID
	}
	return response, nil
}

// readWikiCandidateRequest loads every frozen body into the request, as the
// HTTP generator does while it streams them.
func readWikiCandidateRequest(ctx context.Context, request document.WikiCandidateGenerationRequest) (document.WikiCandidateGenerationRequest, error) {
	request.BasePages = slices.Clone(request.BasePages)
	for index := range request.BasePages {
		content, err := request.BasePages[index].ReadContent(ctx)
		if err != nil {
			return request, err
		}
		request.BasePages[index].Content = content
	}
	for _, sources := range []*[]document.WikiCandidateSource{&request.Changes.Added, &request.Changes.Modified} {
		*sources = slices.Clone(*sources)
		for index := range *sources {
			content, err := (*sources)[index].ReadContent(ctx)
			if err != nil {
				return request, err
			}
			(*sources)[index].Content = content
		}
	}
	return request, nil
}

func (g *recordingWikiCandidateGenerator) callsSnapshot() []document.WikiCandidateGenerationRequest {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]document.WikiCandidateGenerationRequest(nil), g.calls...)
}

func TestUnifiedDocumentWikiQueryUsesExactRevisionDerivedVersions(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool := newUnifiedDocumentActionsFixture(t)
	objects, err := artifactstore.NewLocalStore(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	sourceContent := []byte("frozen Wiki query source")
	sourceDigest := sha256.Sum256(sourceContent)
	sourceObject, _, err := objects.PutIfAbsent(ctx,
		"object_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", bytes.NewReader(sourceContent),
		int64(len(sourceContent)), sourceDigest)
	if err != nil {
		t.Fatal(err)
	}
	seedWikiDispatchSource(t, ctx, db, sourceObject, sourceDigest)
	service := document.NewWithObjectStore(pool, objects)
	readyDocumentTexts(t, pool, objects, nil)
	admission, err := service.RequestWikiRefresh(ctx, document.RequestWikiRefreshInput{
		AccountID: "account_document_a", TenantID: "tenant_document_a",
		IdempotencyKey: "wiki-query-documents",
	})
	if err != nil || admission.Status != document.WikiRefreshAccepted {
		t.Fatalf("admission=%+v error=%v", admission, err)
	}
	pages := []document.WikiPageCandidate{
		{PageKey: "index.md", Markdown: []byte("# Index\n")},
		{PageKey: "topics/query.md", Markdown: []byte("# Query\n")},
	}
	generator := &recordingWikiCandidateGenerator{response: document.WikiCandidateGenerationResult{
		RefreshID: admission.ID,
		Pages:     pages,
	}}
	dispatcher, err := document.NewWikiRefreshDispatcher(pool, objects, generator, service,
		document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 3})
	if err != nil {
		t.Fatal(err)
	}
	if delivered, deliverErr := deliverWikiAttempt(t, pool, dispatcher, admission.ID); deliverErr != nil || !delivered {
		t.Fatalf("delivered=%t error=%v", delivered, deliverErr)
	}

	snapshot, err := service.GetCurrentWikiDocumentRevision(ctx, "actor_human_a")
	if err != nil || snapshot.ID == "" || len(snapshot.Pages) != len(pages) {
		t.Fatalf("snapshot=%+v error=%v", snapshot, err)
	}
	for index, page := range snapshot.Pages {
		if page.PageKey != pages[index].PageKey || page.DocumentID == "" ||
			page.DocumentVersionID == "" ||
			page.MediaType != "text/markdown" || page.SHA256 == "" || page.SizeBytes < 1 {
			t.Fatalf("page[%d]=%+v", index, page)
		}
		content, openErr := service.OpenWikiDocumentVersion(ctx, "actor_human_a", snapshot.ID,
			page.DocumentID, page.DocumentVersionID)
		if openErr != nil {
			t.Fatalf("open page[%d]: %v", index, openErr)
		}
		actual, readErr := io.ReadAll(content)
		_ = content.Close()
		if readErr != nil || !bytes.Equal(actual, pages[index].Markdown) {
			t.Fatalf("page[%d] bytes=%q read=%v", index, actual, readErr)
		}
		// A page is a read-only Markdown file whose current Version is the page.
		var currentVersion, format, source string
		var sourceRevision sql.NullString
		if err := db.QueryRowContext(ctx, `SELECT document.current_version_id,document.format,
			version.source,version.source_revision_id
			FROM documents document JOIN document_versions version ON version.id=$2
			WHERE document.id=$1`, page.DocumentID, page.DocumentVersionID).Scan(
			&currentVersion, &format, &source, &sourceRevision); err != nil {
			t.Fatal(err)
		}
		if currentVersion != page.DocumentVersionID || format != "markdown" ||
			source != "wiki_page" || sourceRevision.Valid {
			t.Fatalf("page[%d] current=%s format=%s source=%s revision=%v",
				index, currentVersion, format, source, sourceRevision)
		}
	}
	first := snapshot.Pages[0]
	var before int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM document_versions`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if _, err := service.GetCurrentWikiDocumentRevision(ctx, "actor_agent_a"); !errors.Is(err, document.ErrNotFound) {
		t.Fatalf("Agent query error=%v", err)
	}
	for _, coordinates := range []struct{ wikiRevisionID, documentID, versionID string }{
		{wikiRevisionID: "stale_wiki_revision", documentID: first.DocumentID, versionID: first.DocumentVersionID},
		{wikiRevisionID: snapshot.ID, documentID: "wrong_document", versionID: first.DocumentVersionID},
		{wikiRevisionID: snapshot.ID, documentID: first.DocumentID, versionID: "wrong_version"},
	} {
		if _, err := service.OpenWikiDocumentVersion(ctx, "actor_human_a",
			coordinates.wikiRevisionID, coordinates.documentID, coordinates.versionID); !errors.Is(err, document.ErrNotFound) {
			t.Fatalf("coordinates=%+v error=%v", coordinates, err)
		}
	}
	var after int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM document_versions`).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if after != before {
		t.Fatalf("failed Wiki queries changed Version count: before=%d after=%d", before, after)
	}
	// Memory waits on wiki_state; a terminal latest refresh must surface as
	// failed unless a queued follow-up will still regenerate.
	if snapshot.State == "failed" {
		t.Fatalf("published refresh reported failure: %s", snapshot.State)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO document_wiki_refreshes(id,tenant_id,wiki_id,generator_agent_actor_id,base_wiki_revision_id,status)
		VALUES('refresh_query_failed','tenant_document_a','wiki_document_a','actor_agent_a',$1,'staging')`, snapshot.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE document_wiki_refreshes SET status='failed',outcome='failed' WHERE id='refresh_query_failed'`); err != nil {
		t.Fatal(err)
	}
	if failed, err := service.GetCurrentWikiDocumentRevision(ctx, "actor_human_a"); err != nil || failed.State != "failed" || failed.ID != snapshot.ID {
		t.Fatalf("terminal refresh state=%s revision=%s error=%v", failed.State, failed.ID, err)
	}
	insertWikiRefreshFollowupForTest(t, pool, "refresh_query_failed")
	if pending, err := service.GetCurrentWikiDocumentRevision(ctx, "actor_human_a"); err != nil || pending.State != "refreshing" {
		t.Fatalf("follow-up pending state=%s error=%v", pending.State, err)
	}
}

func TestUnifiedDocumentWikiDispatcherUsesExactFrozenVersionsAndFailsClosed(t *testing.T) {
	allowParallelIntegrationTest(t)
	t.Run("a publication hands Memory only its revision", func(t *testing.T) {
		generator := &recordingWikiCandidateGenerator{response: document.WikiCandidateGenerationResult{Pages: []document.WikiPageCandidate{{PageKey: "index.md", Markdown: []byte("# Wiki\n")}, {PageKey: "topics/source.md", Markdown: []byte("# Source\n")}}}}
		f := newUnifiedWikiDispatchCase(t, "graph-update", generator, document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 3})
		var count int
		if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM river_job WHERE kind='document.personal_wiki_graph_update'`).Scan(&count); err != nil || count != 0 {
			t.Fatalf("graph update preceded publication: %d %v", count, err)
		}
		if _, err := deliverWikiAttempt(t, f.pool, f.dispatcher, f.admission.ID); err != nil {
			t.Fatal(err)
		}
		var args map[string]any
		var encoded []byte
		if err := f.db.QueryRowContext(f.ctx, `SELECT args FROM river_job WHERE kind='document.personal_wiki_graph_update'`).Scan(&encoded); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(encoded, &args); err != nil {
			t.Fatal(err)
		}
		if len(args) != 4 || args["owner_actor_id"] != "actor_human_a" || args["tenant_id"] != "tenant_document_a" ||
			args["wiki_id"] != "wiki_document_a" || args["wiki_revision_id"] == "" {
			t.Fatalf("graph update args=%v", args)
		}
		// A failed refresh hands Memory nothing.
		generator.fail = document.ErrWikiCandidateTerminal
		if err := storeIndexedWikiSession(f.ctx, f.db, "failed-source", "Next source"); err != nil {
			t.Fatal(err)
		}
		failed, err := f.service.RequestMemoryWikiRefresh(f.ctx, document.RequestMemoryWikiRefreshInput{
			TenantID: "tenant_document_a", OwnerActorID: "actor_human_a", Date: "2026-11-04",
		})
		if err != nil || failed.Refresh.Status != document.WikiRefreshAccepted {
			t.Fatalf("refresh=%+v err=%v", failed.Refresh, err)
		}
		if worked, err := deliverWikiAttempt(t, f.pool, f.dispatcher, failed.Refresh.ID); err != nil || !worked {
			t.Fatalf("a terminal generation rejection fails the refresh without a retry: worked=%v err=%v", worked, err)
		}
		if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM river_job WHERE kind='document.personal_wiki_graph_update'`).Scan(&count); err != nil || count != 1 {
			t.Fatalf("failed generation enqueued a graph update: %d %v", count, err)
		}
	})
	t.Run("skips an oversized source without refusing the refresh", func(t *testing.T) {
		f := newUnifiedWikiDispatchCase(t, "oversize", &recordingWikiCandidateGenerator{}, document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 3})
		if _, err := f.db.ExecContext(f.ctx, `UPDATE document_wiki_refreshes SET status='failed' WHERE id=$1;`, f.admission.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := f.db.ExecContext(f.ctx, `INSERT INTO document_versions(id,tenant_id,document_id,version_number,filename,representation_format,media_type,size_bytes,sha256,content_object_id,source,created_by_actor_id,base_version_id)
        SELECT 'version_wiki_oversize',tenant_id,document_id,version_number+1,filename,representation_format,media_type,52428801,sha256,content_object_id,'replacement_upload',created_by_actor_id,id FROM document_versions WHERE id='version_wiki_dispatch_source';
        UPDATE documents SET current_version_id='version_wiki_oversize' WHERE id='document_human_a'`); err != nil {
			t.Fatal(err)
		}
		readyDocumentTexts(t, f.pool, f.objects, nil)
		// Its only source is now too large, so nothing is left to refresh.
		result, err := f.service.RequestWikiRefresh(f.ctx, document.RequestWikiRefreshInput{AccountID: "account_document_a", TenantID: "tenant_document_a", IdempotencyKey: "oversize-retry"})
		if err != nil || result.Status != document.WikiRefreshNoSources {
			t.Fatalf("oversized source refresh=%+v err=%v", result, err)
		}
		var count int
		if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM document_wiki_refreshes`).Scan(&count); err != nil || count != 1 {
			t.Fatalf("oversize source admitted: %d %v", count, err)
		}
		if reasons := wikiVerdictReasons(t, f.db, "tenant_document_a"); len(reasons) != 1 || reasons["document_human_a"] != "too_large" {
			t.Fatalf("whitelist reasons=%+v", reasons)
		}
	})
	for _, changed := range []bool{false, true} {
		name := "failed generation without new source"
		if changed {
			name = "failed generation with new source"
		}
		t.Run(name, func(t *testing.T) {
			generator := &recordingWikiCandidateGenerator{fail: document.ErrWikiCandidateTerminal}
			f := newUnifiedWikiDispatchCase(t, "failure-followup", generator,
				document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 3})
			// A request while the refresh runs only marks it: the transaction
			// that finishes the refresh enqueues the follow-up.
			coalesced, err := f.service.RequestWikiRefresh(f.ctx, document.RequestWikiRefreshInput{
				AccountID: "account_document_a", TenantID: "tenant_document_a", IdempotencyKey: "wiki-dispatch-failure-followup-2",
			})
			if err != nil || coalesced.Status != document.WikiRefreshInProgress || coalesced.ID != f.admission.ID {
				t.Fatalf("coalesced request=%+v err=%v", coalesced, err)
			}
			var followups int
			if err := f.pool.QueryRow(f.ctx, `SELECT count(*) FROM river_job
				WHERE kind='document.wiki_refresh_followup'`).Scan(&followups); err != nil || followups != 0 {
				t.Fatalf("follow-up before the refresh finished=%d err=%v", followups, err)
			}
			if changed {
				body := []byte("New source after freeze")
				digest := sha256.Sum256(body)
				object, _, err := f.objects.PutIfAbsent(f.ctx, "object_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
					bytes.NewReader(body), int64(len(body)), digest)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := f.pool.Exec(f.ctx, `INSERT INTO document_versions(
					id,tenant_id,document_id,version_number,filename,representation_format,
					media_type,size_bytes,sha256,content_object_id,source,created_by_actor_id,base_version_id
				) SELECT 'version_followup_changed',tenant_id,document_id,version_number+1,
					filename,representation_format,media_type,$1,$2,$3,'replacement_upload',created_by_actor_id,id
					FROM document_versions WHERE id='version_wiki_dispatch_source';
					UPDATE documents SET current_version_id='version_followup_changed' WHERE id='document_human_a'`,
					pgx.QueryExecModeSimpleProtocol, object.Size, hex.EncodeToString(digest[:]), object.Key); err != nil {
					t.Fatal(err)
				}
			}
			if worked, err := deliverWikiAttempt(t, f.pool, f.dispatcher, f.admission.ID); !worked || err != nil {
				t.Fatalf("terminal delivery=%v err=%v", worked, err)
			}
			// A new service can drain solely from the committed failure + River follow-up.
			readyDocumentTexts(t, f.pool, f.objects, nil)
			resumedService := document.NewWithObjectStore(f.pool, f.objects)
			if err := drainDocumentJobs(f.ctx, f.pool, resumedService, nil); err != nil {
				t.Fatalf("wake drain: %v", err)
			}
			var active, pending int
			if err := f.db.QueryRowContext(f.ctx, `SELECT (SELECT count(*) FROM document_wiki_refreshes WHERE status='staging'),(SELECT count(*) FROM river_job WHERE kind='document.wiki_refresh_followup' AND args->>'refresh_id'=$1 AND state IN ('available','pending','retryable','running','scheduled'))`, f.admission.ID).Scan(&active, &pending); err != nil {
				t.Fatal(err)
			}
			want := 0
			if changed {
				want = 1
			}
			if active != want || pending != 0 {
				t.Fatalf("active=%d want=%d pending=%d", active, want, pending)
			}
			if len(generator.callsSnapshot()) != 1 {
				t.Fatalf("followup drain generated again: %d calls", len(generator.callsSnapshot()))
			}
			if changed {
				var frozenVersion string
				if err := f.db.QueryRowContext(f.ctx, `SELECT source.frozen_document_version_id
					FROM document_wiki_refreshes refresh JOIN document_wiki_refresh_sources source ON source.refresh_id=refresh.id
					WHERE refresh.status='staging' AND source.document_id='document_human_a'`).Scan(&frozenVersion); err != nil || frozenVersion != "version_followup_changed" {
					t.Fatalf("followup froze version=%s error=%v", frozenVersion, err)
				}
			}
		})
	}
	t.Run("settles exact frozen bytes through settlement SQLSTATE retries", func(t *testing.T) {
		ctx := context.Background()
		db, pool := newUnifiedWikiFixture(t, "")
		objects, err := artifactstore.NewLocalStore(t.TempDir(), 1<<20)
		if err != nil {
			t.Fatal(err)
		}
		content := []byte("frozen Wiki source bytes")
		digest := sha256.Sum256(content)
		object, _, err := objects.PutIfAbsent(ctx,
			"object_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", bytes.NewReader(content),
			int64(len(content)), digest)
		if err != nil {
			t.Fatal(err)
		}
		seedWikiDispatchSource(t, ctx, db, object, digest)
		service := document.NewWithObjectStore(pool, objects)
		readyDocumentTexts(t, pool, objects, nil)
		admission, err := service.RequestWikiRefresh(ctx, document.RequestWikiRefreshInput{
			AccountID: "account_document_a", TenantID: "tenant_document_a",
			IdempotencyKey: "wiki-dispatch-success",
		})
		if err != nil || admission.Status != document.WikiRefreshAccepted {
			t.Fatalf("admission=%+v error=%v", admission, err)
		}
		generator := &recordingWikiCandidateGenerator{response: document.WikiCandidateGenerationResult{
			RefreshID: admission.ID,
			Pages: []document.WikiPageCandidate{
				{PageKey: "index.md", Markdown: []byte("# Index\n")},
				{PageKey: "topics/source.md", Markdown: []byte("# Source\n")},
			},
		}}
		dispatcher, err := document.NewWikiRefreshDispatcher(pool, objects, generator, service,
			document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 1})
		if err != nil {
			t.Fatal(err)
		}
		// The settlement transaction fails twice with a retryable SQLSTATE, after
		// earlier uncommitted writes, and its retry publishes once without another
		// generator call.
		assertPageFault := injectSQLStateAt(t, db, "document_wiki_pages", 1, "40P01")
		assertSourceFault := injectSQLStateAt(t, db, "document_wiki_published_sources", 1, "40001")

		delivered, err := deliverWikiAttempt(t, pool, dispatcher, admission.ID)
		assertPageFault()
		assertSourceFault()
		if err != nil || !delivered || len(generator.calls) != 1 {
			t.Fatalf("delivered=%t calls=%d error=%v", delivered, len(generator.calls), err)
		}
		request := generator.calls[0]
		if request.RefreshID != admission.ID || request.TenantID != "tenant_document_a" ||
			request.GeneratorAgentActorID != "actor_agent_a" ||
			len(request.Changes.Added) != 1 || len(request.Changes.Modified) != 0 {
			t.Fatalf("candidate request=%+v", request)
		}
		source := request.Changes.Added[0]
		if source.DocumentID != "document_human_a" ||
			source.DocumentVersionID != "version_wiki_dispatch_source" ||
			source.Filename != "source.txt" || !bytes.Equal(source.Content, content) ||
			source.SizeBytes != int64(len(content)) || source.SHA256 != hex.EncodeToString(digest[:]) {
			t.Fatalf("frozen source=%+v", source)
		}
		// Settlement keeps one copy: the page Documents and the published
		// sources. The refresh's frozen sources go in the settling transaction.
		var status, resultRevisionID, currentRevisionID string
		var staging, pages, publishedSources int
		if err := db.QueryRowContext(ctx, `SELECT status,coalesce(result_wiki_revision_id,''),
			(SELECT count(*) FROM document_wiki_refresh_sources WHERE refresh_id=$1),
			(SELECT count(*) FROM document_context_bindings WHERE wiki_id='wiki_document_a'
			   AND binding_kind='wiki_page' AND status='active'),
			(SELECT count(*) FROM document_wiki_published_sources WHERE wiki_id='wiki_document_a'),
			(SELECT coalesce(current_revision_id,'') FROM personal_wikis WHERE id='wiki_document_a')
			FROM document_wiki_refreshes refresh WHERE id=$1`, admission.ID).Scan(
			&status, &resultRevisionID, &staging, &pages, &publishedSources, &currentRevisionID); err != nil {
			t.Fatal(err)
		}
		if status != "settled" || resultRevisionID == "" || currentRevisionID != resultRevisionID ||
			wikiDispatchJobAttempt(t, pool, admission.ID) != 1 ||
			staging != 0 || pages != 2 || publishedSources != 1 {
			t.Fatalf("status=%s result=%s current=%s staging=%d pages=%d sources=%d",
				status, resultRevisionID, currentRevisionID, staging, pages, publishedSources)
		}
		again, err := deliverWikiAttempt(t, pool, dispatcher, admission.ID)
		if err != nil || again || len(generator.calls) != 1 {
			t.Fatalf("replay delivered=%t calls=%d error=%v", again, len(generator.calls), err)
		}
	})

	type failureCase struct {
		key       string
		name      string
		generator error
		wantCode  string
		terminal  bool
	}
	verifyFailure := func(t *testing.T, testCase failureCase) {
		t.Helper()
		f := newUnifiedWikiDispatchFixture(t)
		ctx := f.ctx
		readyDocumentTexts(t, f.pool, f.objects, nil)
		admission, err := f.service.RequestWikiRefresh(ctx, document.RequestWikiRefreshInput{
			AccountID: "account_document_a", TenantID: "tenant_document_a", IdempotencyKey: "wiki-dispatch-" + testCase.key,
		})
		if err != nil || admission.Status != document.WikiRefreshAccepted {
			t.Fatalf("admission=%+v error=%v", admission, err)
		}
		generator := &recordingWikiCandidateGenerator{fail: testCase.generator}
		dispatcher, err := document.NewWikiRefreshDispatcher(f.pool, f.objects, generator, f.service,
			document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 3})
		if err != nil {
			t.Fatal(err)
		}
		delivered, deliverErr := deliverWikiAttempt(t, f.pool, dispatcher, admission.ID)
		// A transient failure returns an error for River's retry. A terminal rejection
		// finishes the job with nil and leaves the refresh failed.
		if !delivered || (deliverErr != nil) == testCase.terminal {
			t.Fatalf("delivered=%t error=%v terminal=%t", delivered, deliverErr, testCase.terminal)
		}
		// A failed refresh keeps only its frozen sources, for its follow-up.
		var status, errorCode string
		var sources, revisions int
		if err := f.db.QueryRowContext(ctx, `SELECT status,coalesce(dispatch_last_error_code,''),
			(SELECT count(*) FROM document_wiki_refresh_sources WHERE refresh_id=$1),
			(SELECT count(*) FROM personal_wikis WHERE id='wiki_document_a' AND current_revision_id IS NOT NULL)
			FROM document_wiki_refreshes WHERE id=$1`, admission.ID).Scan(
			&status, &errorCode, &sources, &revisions); err != nil {
			t.Fatal(err)
		}
		wantStatus := "staging"
		if testCase.terminal {
			wantStatus = "failed"
		}
		if status != wantStatus || wikiDispatchJobAttempt(t, f.pool, admission.ID) != 1 || errorCode != testCase.wantCode ||
			sources != 1 || revisions != 0 {
			t.Fatalf("status=%s code=%s sources=%d revisions=%d error=%v",
				status, errorCode, sources, revisions, deliverErr)
		}
		// Only a transient failure may be attempted again; a terminal rejection
		// must not re-initialize.
		deliveredAgain, err := deliverWikiAttempt(t, f.pool, dispatcher, admission.ID)
		if testCase.terminal {
			if deliveredAgain || err != nil || len(generator.callsSnapshot()) != 1 {
				t.Fatalf("terminal refresh retried: delivered=%t calls=%d err=%v", deliveredAgain, len(generator.callsSnapshot()), err)
			}
			// The next admission supersedes the failed refresh's follow-up, so
			// its frozen sources go then.
			next, err := f.service.RequestWikiRefresh(ctx, document.RequestWikiRefreshInput{
				AccountID: "account_document_a", TenantID: "tenant_document_a", IdempotencyKey: "wiki-dispatch-next-" + testCase.key,
			})
			var failedSources, nextSources int
			if err == nil {
				err = f.db.QueryRowContext(ctx, `SELECT
					(SELECT count(*) FROM document_wiki_refresh_sources WHERE refresh_id=$1),
					(SELECT count(*) FROM document_wiki_refresh_sources WHERE refresh_id=$2)`,
					admission.ID, next.ID).Scan(&failedSources, &nextSources)
			}
			if err != nil || next.Status != document.WikiRefreshAccepted || failedSources != 0 || nextSources != 1 {
				t.Fatalf("next admission=%+v sources failed=%d next=%d error=%v", next, failedSources, nextSources, err)
			}
		} else if !deliveredAgain || err == nil {
			t.Fatalf("transient failure did not retry: delivered=%t err=%v", deliveredAgain, err)
		}
	}
	for _, testCase := range []failureCase{
		{key: "invalid-frozen-input", name: "invalid frozen input", generator: document.ErrWikiCandidateInvalidRequest, wantCode: "candidate_invalid", terminal: true},
		{key: "candidate-transport-failure", name: "candidate transport failure", generator: errors.New("LLM Wiki unavailable"), wantCode: "candidate_unavailable"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			verifyFailure(t, testCase)
		})
	}
}

func seedWikiDispatchSource(
	t *testing.T,
	ctx context.Context,
	db interface {
		ExecContext(context.Context, string, ...any) (sql.Result, error)
	},
	object artifactstore.Object,
	digest [sha256.Size]byte,
) {
	t.Helper()
	if _, err := db.ExecContext(ctx, `UPDATE agent_registrations
		SET agent_type='anotherme',receives_all_messages=true,represented_human_actor_id='actor_human_a'
		WHERE actor_id='actor_agent_a'`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `WITH source_version AS (
		INSERT INTO document_versions(
			id,tenant_id,document_id,version_number,filename,representation_format,
			media_type,size_bytes,sha256,content_object_id,source,created_by_actor_id
		) VALUES(
			'version_wiki_dispatch_source','tenant_document_a','document_human_a',1,
			'source.txt','plain_text','text/plain',$1,$2,$3,
			'ordinary_upload','actor_human_a'
		) RETURNING id,tenant_id,document_id
	), source_binding AS (
		INSERT INTO document_context_bindings(
			id,tenant_id,document_id,binding_kind,wiki_id,status
		) SELECT 'binding_wiki_dispatch_source',tenant_id,document_id,
			'wiki_source','wiki_document_a','active' FROM source_version
		RETURNING document_id
	) UPDATE documents SET format='txt',current_version_id=(SELECT id FROM source_version)
		WHERE id=(SELECT document_id FROM source_binding)`, object.Size, hex.EncodeToString(digest[:]), object.Key); err != nil {
		t.Fatal(err)
	}
}

func TestUnifiedDocumentWikiRefreshPublicAdmissionIsUnifiedAndFailClosed(t *testing.T) {
	allowParallelIntegrationTest(t)
	t.Run("My pages latest snapshots and unsupported sources", verifyMyPagesWikiSources)
	t.Run("batch over the candidate request budget", verifyWikiRefreshRequestBudget)
	t.Run("batch over the changed source limit", verifyWikiRefreshSourceCountLimit)
	t.Run("Memory's nightly request responses", func(t *testing.T) {
		// Each outcome needs its own Wiki, and the deployment has one Human, so
		// every case runs in its own app and database.
		t.Run("accepted and in progress", func(t *testing.T) {
			env, alice := newRoomDocumentRealtimeEnv(t)
			suffix := strings.ReplaceAll(time.Now().UTC().Format("150405.000000000"), ".", "")
			wikiID, _, _ := seedUnifiedWikiPublicAdmission(t, env, alice, suffix, true)

			status, accepted, body := requestNightlyWikiRefresh(t, env, "2026-11-03")
			if status != http.StatusAccepted || accepted.Status != "accepted" ||
				accepted.WikiID != wikiID || accepted.RefreshID == "" {
				t.Fatalf("accepted status=%d body=%s", status, body)
			}
			progressStatus, progress, progressBody := requestNightlyWikiRefresh(t, env, "2026-11-04")
			if progressStatus != http.StatusAccepted || progress.Status != "in_progress" ||
				progress.WikiID != wikiID || progress.RefreshID != accepted.RefreshID {
				t.Fatalf("in-progress status=%d response=%s", progressStatus, progressBody)
			}
			if got := countRows(t, env, `SELECT count(*) FROM document_wiki_refreshes WHERE wiki_id=$1`, wikiID); got != 1 {
				t.Fatalf("canonical refresh rows=%d want=1", got)
			}
		})

		t.Run("already latest", func(t *testing.T) {
			env, alice := newRoomDocumentRealtimeEnv(t)
			suffix := strings.ReplaceAll(time.Now().UTC().Format("150405.000000000"), ".", "")
			wikiID, documentID, versionID := seedUnifiedWikiPublicAdmissionSourceForOwner(t, env, alice, suffix, true,
				acmeTenant, "actor_acme_alice", "wiki-source.txt", "plain_text", "text/plain", []byte("frozen Wiki source"))
			revisionID := "wiki_revision_already_latest_" + suffix
			if _, err := env.pool.Exec(t.Context(), `INSERT INTO document_wiki_published_sources(
				wiki_id,tenant_id,document_id,document_version_id
			) VALUES($1,$2,$3,$4)`, wikiID, acmeTenant, documentID, versionID); err != nil {
				t.Fatal(err)
			}
			if _, err := env.pool.Exec(t.Context(), `UPDATE personal_wikis
				SET current_revision_id=$1,published_at=clock_timestamp() WHERE id=$2`, revisionID, wikiID); err != nil {
				t.Fatal(err)
			}

			status, latest, body := requestNightlyWikiRefresh(t, env, "2026-11-04")
			if status != http.StatusOK || latest.Status != "already_latest" || latest.WikiID != wikiID ||
				latest.RefreshID != "" {
				t.Fatalf("already-latest status=%d response=%s", status, body)
			}
			if got := countRows(t, env, `SELECT count(*) FROM document_wiki_refreshes WHERE wiki_id=$1`, wikiID); got != 0 {
				t.Fatalf("already-latest refresh rows=%d want=0", got)
			}
		})

		t.Run("missing active Another Me", func(t *testing.T) {
			env, alice := newRoomDocumentRealtimeEnv(t)
			suffix := strings.ReplaceAll(time.Now().UTC().Format("150405.000000000"), ".", "")
			wikiID, _, _ := seedUnifiedWikiPublicAdmissionSourceForOwner(t, env, alice, suffix, false,
				acmeTenant, "actor_acme_alice", "wiki-source.txt", "plain_text", "text/plain", []byte("frozen Wiki source"))
			beforeRefreshes := countRows(t, env, `SELECT count(*) FROM document_wiki_refreshes`)
			beforeKeys := countRows(t, env, `SELECT count(*) FROM command_replays`)
			status, _, body := requestNightlyWikiRefresh(t, env, "2026-11-04")
			if status != http.StatusNotFound {
				t.Fatalf("missing Another Me status=%d body=%s", status, body)
			}
			if got := countRows(t, env, `SELECT count(*) FROM document_wiki_refreshes`); got != beforeRefreshes {
				t.Fatalf("failed admission refresh rows=%d want=%d", got, beforeRefreshes)
			}
			if got := countRows(t, env, `SELECT count(*) FROM command_replays`); got != beforeKeys {
				t.Fatalf("failed admission idempotency rows=%d want=%d", got, beforeKeys)
			}
			if got := countRows(t, env, `SELECT count(*) FROM document_wiki_refreshes WHERE wiki_id=$1`, wikiID); got != 0 {
				t.Fatalf("failed admission Wiki refresh rows=%d", got)
			}
			// Only the missing delegate changes: the same request for the same
			// night admits a refresh once Another Me exists.
			generatorID := seedUnifiedWikiAnotherMe(t, env, suffix, acmeTenant, "actor_acme_alice")
			status, accepted, body := requestNightlyWikiRefresh(t, env, "2026-11-04")
			if status != http.StatusAccepted || accepted.Status != "accepted" ||
				accepted.WikiID != wikiID || accepted.RefreshID == "" {
				t.Fatalf("admission after adding Another Me status=%d body=%s", status, body)
			}
			if got := countRows(t, env, `SELECT count(*) FROM document_wiki_refreshes
				WHERE id=$1 AND wiki_id=$2 AND tenant_id=$3 AND generator_agent_actor_id=$4`,
				accepted.RefreshID, wikiID, acmeTenant, generatorID); got != 1 {
				t.Fatalf("admitted refresh for the owner's Another Me rows=%d want=1", got)
			}
		})
	})
}

func TestUnifiedDocumentWikiRefreshRunsEndToEndThroughTheAppWorker(t *testing.T) {
	allowParallelIntegrationTest(t)
	generator := &recordingWikiCandidateGenerator{response: document.WikiCandidateGenerationResult{
		Pages: []document.WikiPageCandidate{
			{PageKey: "index.md", Markdown: []byte("# Personal Wiki\n")},
			{PageKey: "topics/teamhub.md", Markdown: []byte("# TeamHub\n")},
		},
	}}
	env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(
		t, 0, 0, 0,
		roomDocumentRuntimeTestOptions{wikiCandidateGenerator: generator},
	)
	suffix := strings.ReplaceAll(time.Now().UTC().Format("150405.000000000"), ".", "")
	wikiID, sourceDocumentID, sourceVersionID := seedUnifiedWikiPublicAdmission(
		t, env, alice, suffix, true,
	)

	status, accepted, body := requestNightlyWikiRefresh(t, env, "2026-11-04")
	if status != http.StatusAccepted || accepted.Status != "accepted" || accepted.RefreshID == "" {
		t.Fatalf("refresh status=%d body=%s", status, body)
	}

	deadline := time.Now().Add(5 * time.Second)
	var refreshStatus, wikiRevisionID string
	for time.Now().Before(deadline) {
		if err := env.pool.QueryRow(t.Context(), `SELECT status,coalesce(result_wiki_revision_id,'')
			FROM document_wiki_refreshes WHERE id=$1`, accepted.RefreshID).Scan(
			&refreshStatus, &wikiRevisionID); err != nil {
			t.Fatal(err)
		}
		if refreshStatus == "settled" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if refreshStatus != "settled" || wikiRevisionID == "" {
		t.Fatalf("refresh status=%s revision=%s", refreshStatus, wikiRevisionID)
	}
	calls := generator.callsSnapshot()
	if len(calls) != 1 || calls[0].RefreshID != accepted.RefreshID || len(calls[0].Changes.Added) != 1 ||
		calls[0].Changes.Added[0].DocumentID != sourceDocumentID ||
		calls[0].Changes.Added[0].DocumentVersionID != sourceVersionID ||
		string(calls[0].Changes.Added[0].Content) != "frozen Wiki source" {
		t.Fatalf("candidate calls=%+v", calls)
	}
	var currentRevisionID string
	var pageDocuments int
	if err := env.pool.QueryRow(t.Context(), `SELECT
		(SELECT current_revision_id FROM personal_wikis WHERE id=$1),
		(SELECT count(*) FROM documents document
		 JOIN document_context_bindings binding
		   ON binding.document_id=document.id AND binding.tenant_id=document.tenant_id
		 WHERE binding.wiki_id=$1 AND binding.binding_kind='wiki_page'
		   AND binding.role='viewer' AND document.owner_actor_kind='agent'
		   AND document.format='markdown' AND document.current_version_id IS NOT NULL)
	`, wikiID).Scan(&currentRevisionID, &pageDocuments); err != nil {
		t.Fatal(err)
	}
	if currentRevisionID != wikiRevisionID || pageDocuments != 2 {
		t.Fatalf("current=%s pages=%d", currentRevisionID, pageDocuments)
	}

	requestWiki := func(actorID, token string) (int, []byte) {
		t.Helper()
		request, err := http.NewRequest(http.MethodGet,
			env.server.URL+"/v0/personal-wikis/"+url.PathEscape(actorID)+"/document-revision", nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer "+token)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		content, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		return response.StatusCode, content
	}
	queryStatus, queryBody := requestWiki("actor_acme_alice", teamHubInternalToken)
	var snapshot struct {
		WikiRevisionID string `json:"wiki_revision_id"`
		Pages          []struct {
			PageKey           string `json:"page_key"`
			DocumentID        string `json:"document_id"`
			DocumentVersionID string `json:"document_version_id"`
			SHA256            string `json:"sha256"`
		} `json:"pages"`
	}
	decode(t, queryBody, &snapshot)
	if queryStatus != http.StatusOK || snapshot.WikiRevisionID != wikiRevisionID ||
		len(snapshot.Pages) != 2 || snapshot.Pages[0].DocumentID == "" ||
		snapshot.Pages[0].DocumentVersionID == "" {
		t.Fatalf("query status=%d body=%s", queryStatus, queryBody)
	}
	firstPage := snapshot.Pages[0]
	downloadURL := env.server.URL + "/v0/personal-wikis/actor_acme_alice/document-revisions/" +
		url.PathEscape(snapshot.WikiRevisionID) + "/documents/" + url.PathEscape(firstPage.DocumentID) +
		"/versions/" + url.PathEscape(firstPage.DocumentVersionID) + "/content"
	downloadRequest, err := http.NewRequest(http.MethodGet, downloadURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	downloadRequest.Header.Set("Authorization", "Bearer "+teamHubInternalToken)
	downloadResponse, err := http.DefaultClient.Do(downloadRequest)
	if err != nil {
		t.Fatal(err)
	}
	downloadBody, err := io.ReadAll(downloadResponse.Body)
	_ = downloadResponse.Body.Close()
	if err != nil || downloadResponse.StatusCode != http.StatusOK ||
		string(downloadBody) != "# Personal Wiki\n" ||
		downloadResponse.Header.Get("ETag") != `"`+firstPage.SHA256+`"` {
		t.Fatalf("download status=%d etag=%q body=%q error=%v", downloadResponse.StatusCode,
			downloadResponse.Header.Get("ETag"), downloadBody, err)
	}
	if status, body := requestWiki("actor_acme_alice", "wrong-token"); status != http.StatusUnauthorized || !bytes.Contains(body, []byte("UNAUTHENTICATED")) {
		t.Fatalf("wrong token status=%d body=%s", status, body)
	}
	if status, body := requestWiki(calls[0].GeneratorAgentActorID, teamHubInternalToken); status != http.StatusNotFound || !bytes.Contains(body, []byte("NOT_FOUND")) {
		t.Fatalf("Agent query status=%d body=%s", status, body)
	}
}

func TestUnifiedDocumentWikiListsTheHumansUnifiedDocuments(t *testing.T) {
	allowParallelIntegrationTest(t)
	generator := &recordingWikiCandidateGenerator{response: document.WikiCandidateGenerationResult{
		Pages: []document.WikiPageCandidate{
			{PageKey: "index.md", Markdown: []byte("# Personal Wiki\n")},
			{PageKey: "topics/teamhub.md", Markdown: []byte("# TeamHub\n")},
		},
	}}
	env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(
		t, 0, 0, 0,
		roomDocumentRuntimeTestOptions{wikiCandidateGenerator: generator},
	)
	suffix := strings.ReplaceAll(time.Now().UTC().Format("150405.000000000"), ".", "")
	path := "/v0/tenants/" + acmeTenant + "/personal-wiki/documents"

	var wikiRoots int
	if err := env.pool.QueryRow(t.Context(), `SELECT count(*) FROM personal_wikis WHERE tenant_id=$1`, acmeTenant).Scan(&wikiRoots); err != nil {
		t.Fatal(err)
	}
	if wikiRoots != 0 {
		t.Fatalf("fresh Tenant Wiki roots=%d want=0", wikiRoots)
	}
	status, _, body := env.request(alice, http.MethodGet, path+"?limit=1", nil, "")
	var empty wikiDocumentPageResponse
	decode(t, body, &empty)
	if status != http.StatusOK || len(empty.Items) != 0 || empty.Page.HasMore || empty.Page.NextCursor != "" {
		t.Fatalf("empty list status=%d body=%s", status, body)
	}
	if err := env.pool.QueryRow(t.Context(), `SELECT count(*) FROM personal_wikis WHERE tenant_id=$1`, acmeTenant).Scan(&wikiRoots); err != nil {
		t.Fatal(err)
	}
	if wikiRoots != 0 {
		t.Fatalf("reading the Wiki list created %d roots", wikiRoots)
	}

	_, sourceDocumentID, _ := seedUnifiedWikiPublicAdmission(t, env, alice, suffix, true)
	status, accepted, body := requestNightlyWikiRefresh(t, env, "2026-11-04")
	if status != http.StatusAccepted || accepted.RefreshID == "" {
		t.Fatalf("refresh status=%d body=%s", status, body)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var refreshStatus string
		if err := env.pool.QueryRow(t.Context(), `SELECT status FROM document_wiki_refreshes WHERE id=$1`,
			accepted.RefreshID).Scan(&refreshStatus); err != nil {
			t.Fatal(err)
		}
		if refreshStatus == "settled" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	status, _, body = env.request(alice, http.MethodGet, path+"?limit=1", nil, "")
	var first wikiDocumentPageResponse
	decode(t, body, &first)
	if status != http.StatusOK || len(first.Items) != 1 || !first.Page.HasMore || first.Page.NextCursor == "" {
		t.Fatalf("first Wiki Document page status=%d body=%s", status, body)
	}
	status, _, body = env.request(alice, http.MethodGet,
		path+"?limit=10&cursor="+url.QueryEscape(first.Page.NextCursor), nil, "")
	var second wikiDocumentPageResponse
	decode(t, body, &second)
	if status != http.StatusOK || len(second.Items) != 2 || second.Page.HasMore || second.Page.NextCursor != "" {
		t.Fatalf("second Wiki Document page status=%d body=%s", status, body)
	}
	seen := map[string]string{}
	pageKeys := map[string]bool{}
	for _, item := range append(first.Items, second.Items...) {
		for _, source := range item.From {
			if source.Kind == "wiki_source" || source.Kind == "wiki_page" {
				seen[item.ID] = source.Kind
			}
			if source.Kind == "wiki_page" {
				pageKeys[source.PageKey] = true
			}
		}
	}
	if seen[sourceDocumentID] != "wiki_source" {
		t.Fatalf("source Document identity missing: source=%s seen=%v", sourceDocumentID, seen)
	}
	pageCount := 0
	for _, kind := range seen {
		if kind == "wiki_page" {
			pageCount++
		}
	}
	if pageCount != 2 || len(seen) != 3 {
		t.Fatalf("Wiki Document roles=%v", seen)
	}
	if !pageKeys["index.md"] || !pageKeys["topics/teamhub.md"] || len(pageKeys) != 2 {
		t.Fatalf("Wiki page keys=%v", pageKeys)
	}
}

func seedUnifiedWikiPublicAdmission(
	t *testing.T,
	env *testEnv,
	alice *http.Client,
	suffix string,
	withAnotherMe bool,
) (string, string, string) {
	t.Helper()
	return seedUnifiedWikiPublicAdmissionSource(t, env, alice, suffix, withAnotherMe,
		"wiki-source.txt", "plain_text", "text/plain", []byte("frozen Wiki source"))
}

func seedUnifiedWikiPublicAdmissionSource(
	t *testing.T,
	env *testEnv,
	alice *http.Client,
	suffix string,
	withAnotherMe bool,
	filename, representationFormat, mediaType string,
	content []byte,
) (string, string, string) {
	t.Helper()
	return seedUnifiedWikiPublicAdmissionSourceForOwner(t, env, alice, suffix, withAnotherMe,
		acmeTenant, "actor_acme_alice", filename, representationFormat, mediaType, content)
}

func seedUnifiedWikiPublicAdmissionSourceForOwner(
	t *testing.T,
	env *testEnv,
	owner *http.Client,
	suffix string,
	withAnotherMe bool,
	tenantID, ownerActorID string,
	filename, representationFormat, mediaType string,
	content []byte,
) (string, string, string) {
	t.Helper()
	if withAnotherMe {
		seedUnifiedWikiAnotherMe(t, env, suffix, tenantID, ownerActorID)
	}
	// The first source upload creates the Wiki root.
	fields := map[string]string{
		"filename": filename, "representation_format": representationFormat, "media_type": mediaType,
	}
	status, _, uploadBody := requestUnifiedDocumentMultipart(t, env, owner,
		"/v0/tenants/"+tenantID+"/personal-wiki/documents/uploads",
		"wiki-unified-source-"+suffix, fields, filename, content)
	var uploaded struct {
		ID             string `json:"id"`
		CurrentVersion *struct {
			ID string `json:"id"`
		} `json:"current_version"`
	}
	decode(t, uploadBody, &uploaded)
	if status != http.StatusCreated || uploaded.ID == "" || uploaded.CurrentVersion == nil {
		t.Fatalf("upload Wiki source status=%d body=%s", status, uploadBody)
	}
	status, _, wikiBody := env.request(owner, http.MethodGet,
		"/v0/tenants/"+tenantID+"/personal-wiki", nil, "")
	var wiki struct {
		ID string `json:"id"`
	}
	decode(t, wikiBody, &wiki)
	if status != http.StatusOK || wiki.ID == "" {
		t.Fatalf("Wiki after the first source status=%d body=%s", status, wikiBody)
	}
	return wiki.ID, uploaded.ID, uploaded.CurrentVersion.ID
}

func seedUnifiedWikiAnotherMe(t *testing.T, env *testEnv, suffix, tenantID, ownerActorID string) string {
	t.Helper()
	agentID := "actor_wiki_another_me_" + suffix
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO actors(
		id,tenant_id,kind,display_name,handle
	) VALUES($1,$2,'agent','Wiki Another Me',$3)`, agentID, tenantID,
		"@wiki-another-me-"+suffix); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO agent_registrations(
			actor_id,tenant_id,agent_management_id,status,description,instructions,
			runtime_model,created_by_actor_id,visibility_scope,agent_type,
			represented_human_actor_id,
			computer_id,local_runtime_type,workspace_grant_id
		) VALUES($1,$2,$3,'active','Private delegate','Generate the owner Wiki',
			'openai/gpt-5.4',$4,'sponsor','anotherme',$4,'computer_fixture','codex','grant_files')
	`, agentID, tenantID, "management_wiki_another_me_"+suffix, ownerActorID); err != nil {
		t.Fatal(err)
	}
	return agentID
}

// memoryWikiRefreshResponse is TeamHub's answer to Memory's Wiki refresh
// request.
type memoryWikiRefreshResponse struct {
	Status    string `json:"refresh_status"`
	WikiID    string `json:"wiki_id"`
	RefreshID string `json:"refresh_id"`
}

// requestNightlyWikiRefresh sends Memory's nightly Wiki refresh request for
// Alice through TeamHub's internal API. The date scopes the refresh intent,
// so a request for another night is evaluated again.
func requestNightlyWikiRefresh(t *testing.T, env *testEnv, date string) (int, memoryWikiRefreshResponse, []byte) {
	t.Helper()
	return requestMemoryWikiRefreshHTTP(t, env, "actor_acme_alice", map[string]any{"tenant_id": acmeTenant, "date": date})
}

// requestMemoryWikiRefreshHTTP posts one Memory Wiki refresh request body for
// the actor with the Memory service credential.
func requestMemoryWikiRefreshHTTP(t *testing.T, env *testEnv, actorID string, payload map[string]any) (int, memoryWikiRefreshResponse, []byte) {
	t.Helper()
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost,
		env.server.URL+"/v0/personal-wikis/"+url.PathEscape(actorID)+"/memory-refresh", bytes.NewReader(encoded))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+teamHubInternalToken)
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	var result memoryWikiRefreshResponse
	if response.StatusCode == http.StatusOK || response.StatusCode == http.StatusAccepted {
		decode(t, body, &result)
	}
	return response.StatusCode, result, body
}

// seedWikiPageDocument stores one published Wiki page as the read-only
// Markdown file Document settlement creates.
func seedWikiPageDocument(
	t *testing.T,
	ctx context.Context,
	db interface {
		ExecContext(context.Context, string, ...any) (sql.Result, error)
	},
	objects artifactstore.ObjectStore,
	documentID, pageKey, markdown string,
) {
	t.Helper()
	digest := sha256.Sum256([]byte(markdown))
	object, _, err := objects.PutIfAbsent(ctx, "object_"+hex.EncodeToString(digest[:16]),
		bytes.NewReader([]byte(markdown)), int64(len(markdown)), digest)
	if err != nil {
		t.Fatal(err)
	}
	versionID := documentID + "_v1"
	for _, statement := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO documents(
			id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,
			creator_actor_kind,status
		) VALUES($1,'tenant_document_a',$2,'markdown','actor_agent_a','agent','actor_agent_a','agent','active')`,
			[]any{documentID, pageKey}},
		{`INSERT INTO document_versions(
			id,tenant_id,document_id,version_number,filename,representation_format,
			media_type,size_bytes,sha256,content_object_id,source,created_by_actor_id
		) VALUES($1,'tenant_document_a',$2,1,$3,'markdown','text/markdown',$4,$5,$6,'wiki_page','actor_agent_a')`,
			[]any{versionID, documentID, pageKey[strings.LastIndex(pageKey, "/")+1:], object.Size,
				hex.EncodeToString(digest[:]), object.Key}},
		{`UPDATE documents SET current_version_id=$2 WHERE id=$1`, []any{documentID, versionID}},
		{`INSERT INTO document_context_bindings(
			id,tenant_id,document_id,binding_kind,wiki_id,status,role
		) VALUES($2,'tenant_document_a',$1,'wiki_page','wiki_document_a','active','viewer')`,
			[]any{documentID, "binding_" + documentID}},
		{`INSERT INTO document_wiki_pages(wiki_id,tenant_id,page_key,document_id)
		VALUES('wiki_document_a','tenant_document_a',$2,$1)`, []any{documentID, pageKey}},
	} {
		if _, err := db.ExecContext(ctx, statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
}

func TestUnifiedDocumentWikiRefreshSettlesUpdatedNewAndRetainedPagesAtomically(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool := newUnifiedDocumentActionsFixture(t)
	objects, err := artifactstore.NewLocalStore(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	sourceContent := []byte("settlement source")
	sourceDigest := sha256.Sum256(sourceContent)
	sourceObject, _, err := objects.PutIfAbsent(ctx,
		"object_cccccccccccccccccccccccccccccccc", bytes.NewReader(sourceContent),
		int64(len(sourceContent)), sourceDigest)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO document_versions(
		id,tenant_id,document_id,version_number,filename,representation_format,
		media_type,size_bytes,sha256,content_object_id,source,created_by_actor_id
	) VALUES(
		'version_wiki_settle_source','tenant_document_a','document_human_a',1,
		'source.txt','plain_text','text/plain',$1,$2,$3,'ordinary_upload','actor_human_a'
	)`, sourceObject.Size, hex.EncodeToString(sourceDigest[:]), sourceObject.Key); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
		UPDATE agent_registrations
		SET agent_type='anotherme',receives_all_messages=true,represented_human_actor_id='actor_human_a'
		WHERE actor_id='actor_agent_a';
		UPDATE documents SET format='txt',current_version_id='version_wiki_settle_source'
		WHERE id='document_human_a';
		INSERT INTO document_context_bindings(
			id,tenant_id,document_id,binding_kind,wiki_id,status
		) VALUES(
			'binding_wiki_settle_source','tenant_document_a','document_human_a',
			'wiki_source','wiki_document_a','active'
		)`); err != nil {
		t.Fatal(err)
	}
	seedWikiPageDocument(t, ctx, db, objects, "document_wiki_existing", "guide/existing.md", "# Existing")
	seedWikiPageDocument(t, ctx, db, objects, "document_wiki_same", "guide/same.md", "# Same")
	seedWikiPageDocument(t, ctx, db, objects, "document_wiki_retained", "guide/retained.md", "# Retained")
	service := document.NewWithObjectStore(pool, objects)
	readyDocumentTexts(t, pool, objects, nil)
	admission, err := service.RequestWikiRefresh(ctx, document.RequestWikiRefreshInput{
		AccountID: "account_document_a", TenantID: "tenant_document_a",
		IdempotencyKey: "wiki-settle-admission",
	})
	if err != nil || admission.Status != document.WikiRefreshAccepted {
		t.Fatalf("admission=%+v error=%v", admission, err)
	}
	generator := &recordingWikiCandidateGenerator{response: document.WikiCandidateGenerationResult{Pages: []document.WikiPageCandidate{
		{PageKey: "guide/existing.md", Markdown: []byte("# Existing updated")},
		{PageKey: "guide/existing-quality.md", Markdown: []byte("# New")}, // Locale and byte order differ.
		{PageKey: "guide/same.md", Markdown: []byte("# Same")},
	}}}
	dispatcher, err := document.NewWikiRefreshDispatcher(pool, objects, generator, service,
		document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 3})
	if err != nil {
		t.Fatal(err)
	}
	if worked, err := deliverWikiAttempt(t, pool, dispatcher, admission.ID); err != nil || !worked {
		t.Fatalf("settlement worked=%v error=%v", worked, err)
	}
	// A redelivered job, as after a lost acknowledgement, does not generate
	// again.
	if _, err := pool.Exec(ctx, `UPDATE river_job SET state='available',finalized_at=NULL
		WHERE kind='document.wiki_refresh_dispatch' AND args->>'refresh_id'=$1`, admission.ID); err != nil {
		t.Fatal(err)
	}
	if worked, err := deliverWikiAttempt(t, pool, dispatcher, admission.ID); err != nil || !worked ||
		len(generator.callsSnapshot()) != 1 {
		t.Fatalf("redelivery worked=%v calls=%d error=%v", worked, len(generator.callsSnapshot()), err)
	}
	var settledRevisionID string
	if err := pool.QueryRow(ctx, `SELECT coalesce(result_wiki_revision_id,'')
		FROM document_wiki_refreshes WHERE id=$1`, admission.ID).Scan(&settledRevisionID); err != nil || settledRevisionID == "" {
		t.Fatalf("settled revision=%q error=%v", settledRevisionID, err)
	}

	var refreshStatus, currentWikiRevision string
	var activePages, publishedSources, newDocuments int
	var retainedBindings, retainedMappings int
	var existingVersions, sameVersions, newVersions int
	if err := db.QueryRowContext(ctx, `SELECT
		(SELECT status FROM document_wiki_refreshes WHERE id=$1),
		(SELECT current_revision_id FROM personal_wikis WHERE id='wiki_document_a'),
		(SELECT count(*) FROM document_context_bindings
		 WHERE wiki_id='wiki_document_a' AND binding_kind='wiki_page' AND status='active'),
		(SELECT count(*) FROM document_wiki_published_sources WHERE wiki_id='wiki_document_a'),
		(SELECT count(*) FROM documents WHERE title='Existing quality' AND owner_actor_id='actor_agent_a'
		   AND format='markdown'),
		(SELECT count(*) FROM document_context_bindings
		 WHERE document_id='document_wiki_retained' AND binding_kind='wiki_page' AND status='active'),
		(SELECT count(*) FROM document_wiki_pages
		 WHERE wiki_id='wiki_document_a' AND page_key='guide/retained.md'
		   AND document_id='document_wiki_retained'),
		(SELECT count(*) FROM document_versions WHERE document_id='document_wiki_existing'),
		(SELECT count(*) FROM document_versions WHERE document_id='document_wiki_same'),
		(SELECT count(*) FROM document_versions version
		 JOIN document_wiki_pages page ON page.document_id=version.document_id
		 WHERE page.wiki_id='wiki_document_a' AND page.page_key='guide/existing-quality.md')
	`, admission.ID).Scan(
		&refreshStatus, &currentWikiRevision, &activePages, &publishedSources,
		&newDocuments, &retainedBindings, &retainedMappings,
		&existingVersions, &sameVersions, &newVersions,
	); err != nil {
		t.Fatal(err)
	}
	if refreshStatus != "settled" || currentWikiRevision != settledRevisionID ||
		activePages != 3 || publishedSources != 1 || newDocuments != 1 ||
		retainedBindings != 0 || retainedMappings != 1 ||
		existingVersions != 2 || sameVersions != 1 || newVersions != 1 {
		t.Fatalf("settlement facts status=%s current=%s pages=%d sources=%d new=%d retained=%d/%d versions=%d/%d/%d",
			refreshStatus, currentWikiRevision, activePages, publishedSources, newDocuments,
			retainedBindings, retainedMappings, existingVersions, sameVersions, newVersions)
	}
	// The changed page's current Version holds the new Markdown.
	snapshot, err := service.GetCurrentWikiDocumentRevision(ctx, "actor_human_a")
	if err != nil || snapshot.ID != settledRevisionID || len(snapshot.Pages) != 3 {
		t.Fatalf("snapshot=%+v error=%v", snapshot, err)
	}
	for _, page := range snapshot.Pages {
		if page.PageKey != "guide/existing.md" {
			continue
		}
		content, err := service.OpenWikiDocumentVersion(ctx, "actor_human_a", snapshot.ID,
			page.DocumentID, page.DocumentVersionID)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(content)
		_ = content.Close()
		if err != nil || string(body) != "# Existing updated" {
			t.Fatalf("updated page body=%q error=%v", body, err)
		}
	}
	latest, err := service.RequestWikiRefresh(ctx, document.RequestWikiRefreshInput{
		AccountID: "account_document_a", TenantID: "tenant_document_a", IdempotencyKey: "after-page-retirement",
	})
	if err != nil || latest.Status != document.WikiRefreshAlreadyLatest {
		t.Fatalf("omitted content page caused phantom refresh: result=%+v err=%v", latest, err)
	}
}

func TestUnifiedDocumentWikiRefreshSettlementRejectsInactiveGenerator(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool := newUnifiedDocumentActionsFixture(t)
	objects, err := artifactstore.NewLocalStore(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	sourceContent := []byte("inactive generator source")
	sourceDigest := sha256.Sum256(sourceContent)
	sourceObject, _, err := objects.PutIfAbsent(ctx,
		"object_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", bytes.NewReader(sourceContent),
		int64(len(sourceContent)), sourceDigest)
	if err != nil {
		t.Fatal(err)
	}
	seedWikiFailureFixture(t, ctx, db, objects, sourceObject, sourceDigest)
	service := document.NewWithObjectStore(pool, objects)
	readyDocumentTexts(t, pool, objects, nil)
	admission, err := service.RequestWikiRefresh(ctx, document.RequestWikiRefreshInput{
		AccountID: "account_document_a", TenantID: "tenant_document_a",
		IdempotencyKey: "wiki-inactive-generator-admission",
	})
	if err != nil || admission.Status != document.WikiRefreshAccepted {
		t.Fatalf("admission=%+v error=%v", admission, err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE agent_registrations SET status='revoked'
		WHERE actor_id='actor_agent_a'`); err != nil {
		t.Fatal(err)
	}
	generator := &recordingWikiCandidateGenerator{response: document.WikiCandidateGenerationResult{Pages: []document.WikiPageCandidate{{
		PageKey: "guide/failure.md", Markdown: []byte("# Revoked generator"),
	}}}}
	dispatcher, err := document.NewWikiRefreshDispatcher(pool, objects, generator, service,
		document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 3})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := deliverWikiAttempt(t, pool, dispatcher, admission.ID); !errors.Is(err, document.ErrVersionConflict) {
		t.Fatalf("settlement by inactive generator error=%v want version conflict", err)
	}
	var refreshStatus, currentRevision string
	var pageVersions int
	if err := db.QueryRowContext(ctx, `SELECT
		(SELECT status FROM document_wiki_refreshes WHERE id=$1),
		(SELECT coalesce(current_revision_id,'') FROM personal_wikis WHERE id='wiki_document_a'),
		(SELECT count(*) FROM document_versions WHERE document_id='document_wiki_failure_page')
	`, admission.ID).Scan(&refreshStatus, &currentRevision, &pageVersions); err != nil {
		t.Fatal(err)
	}
	if refreshStatus != "staging" || currentRevision != "" || pageVersions != 1 {
		t.Fatalf("inactive generator settlement status=%s current=%q page versions=%d",
			refreshStatus, currentRevision, pageVersions)
	}
}

func TestUnifiedDocumentWikiRefreshConflictsWhenItsBaseChanges(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool := newUnifiedDocumentActionsFixture(t)
	objects, err := artifactstore.NewLocalStore(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	sourceContent := []byte("failure source")
	sourceDigest := sha256.Sum256(sourceContent)
	sourceObject, _, err := objects.PutIfAbsent(ctx,
		"object_dddddddddddddddddddddddddddddddd", bytes.NewReader(sourceContent),
		int64(len(sourceContent)), sourceDigest)
	if err != nil {
		t.Fatal(err)
	}
	seedWikiFailureFixture(t, ctx, db, objects, sourceObject, sourceDigest)
	service := document.NewWithObjectStore(pool, objects)
	readyDocumentTexts(t, pool, objects, nil)
	admission, err := service.RequestWikiRefresh(ctx, document.RequestWikiRefreshInput{
		AccountID: "account_document_a", TenantID: "tenant_document_a",
		IdempotencyKey: "wiki-conflict-admission",
	})
	if err != nil || admission.Status != document.WikiRefreshAccepted {
		t.Fatalf("admission=%+v error=%v", admission, err)
	}
	// Another publication lands while this refresh generates.
	generator := &recordingWikiCandidateGenerator{
		response: document.WikiCandidateGenerationResult{Pages: []document.WikiPageCandidate{{
			PageKey: "guide/failure.md", Markdown: []byte("# Candidate"),
		}}},
		beforeReturn: func(ctx context.Context, _ document.WikiCandidateGenerationRequest) error {
			_, err := db.ExecContext(ctx, `UPDATE personal_wikis
				SET current_revision_id='wiki_revision_other',published_at=clock_timestamp()
				WHERE id='wiki_document_a'`)
			return err
		},
	}
	dispatcher, err := document.NewWikiRefreshDispatcher(pool, objects, generator, service,
		document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 3})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := deliverWikiAttempt(t, pool, dispatcher, admission.ID); err != nil {
		t.Fatal(err)
	}
	var refreshStatus string
	var pageVersions, frozenSources int
	if err := db.QueryRowContext(ctx, `SELECT
		(SELECT status FROM document_wiki_refreshes WHERE id=$1),
		(SELECT count(*) FROM document_versions WHERE document_id='document_wiki_failure_page'),
		(SELECT count(*) FROM document_wiki_refresh_sources WHERE refresh_id=$1)
	`, admission.ID).Scan(&refreshStatus, &pageVersions, &frozenSources); err != nil {
		t.Fatal(err)
	}
	// The whole candidate set is dropped; nothing is written to a page.
	if refreshStatus != "conflicted" || pageVersions != 1 || frozenSources != 0 {
		t.Fatalf("conflict status=%s page versions=%d frozen=%d", refreshStatus, pageVersions, frozenSources)
	}
	// A conflict queues a follow-up refresh, so it still reads as refreshing.
	wiki, err := document.New(pool).GetPersonalWiki(ctx, "account_document_a", "tenant_document_a")
	if err != nil || wiki.State != "refreshing" {
		t.Fatalf("visible Wiki state=%q err=%v", wiki.State, err)
	}
}

func seedWikiFailureFixture(t *testing.T, ctx context.Context, db interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}, objects artifactstore.ObjectStore, object artifactstore.Object, digest [sha256.Size]byte) {
	t.Helper()
	if _, err := db.ExecContext(ctx, `INSERT INTO document_versions(
		id,tenant_id,document_id,version_number,filename,representation_format,
		media_type,size_bytes,sha256,content_object_id,source,created_by_actor_id
	) VALUES(
		'version_wiki_failure_source','tenant_document_a','document_human_a',1,
		'source.txt','plain_text','text/plain',$1,$2,$3,'ordinary_upload','actor_human_a'
	)`, object.Size, hex.EncodeToString(digest[:]), object.Key); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
		UPDATE agent_registrations
		SET agent_type='anotherme',receives_all_messages=true,represented_human_actor_id='actor_human_a'
		WHERE actor_id='actor_agent_a';
		UPDATE documents SET format='txt',current_version_id='version_wiki_failure_source'
		WHERE id='document_human_a';
		INSERT INTO document_context_bindings(
			id,tenant_id,document_id,binding_kind,wiki_id,status
		) VALUES(
			'binding_wiki_failure_source','tenant_document_a','document_human_a',
			'wiki_source','wiki_document_a','active')`); err != nil {
		t.Fatal(err)
	}
	seedWikiPageDocument(t, ctx, db, objects, "document_wiki_failure_page", "guide/failure.md", "# Failure")
}

// indexWikiSession stores one Room Session of actor_human_a's Another Me in
// the Memory index and requests the Wiki refresh Memory requests after
// indexing.
func indexWikiSession(ctx context.Context, db *sql.DB, service *document.Service, sessionKey, text string) (document.MemoryWikiRefreshResult, error) {
	if err := storeIndexedWikiSession(ctx, db, sessionKey, text); err != nil {
		return document.MemoryWikiRefreshResult{}, err
	}
	return service.RequestMemoryWikiRefresh(ctx, document.RequestMemoryWikiRefreshInput{
		TenantID: "tenant_document_a", OwnerActorID: "actor_human_a", Date: "2026-11-04",
	})
}

// storeIndexedWikiSession writes one Room Session the way Memory's index
// does: the source points at its only version.
func storeIndexedWikiSession(ctx context.Context, db *sql.DB, sessionKey, text string) error {
	sourceKey := sha256.Sum256([]byte(sessionKey))
	sourceID := "mis_" + hex.EncodeToString(sourceKey[:12])
	content := sha256.Sum256([]byte(text))
	digest := hex.EncodeToString(content[:])
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `INSERT INTO memory_index.sources(id,tenant_id,owner_id,agent_id,document_id,
			source_path,title,active_sha256,index_profile,source_kind,origin_kind,source_uri,source_version,metadata,room_id)
		SELECT $1,'tenant_document_a','actor_human_a',registration.agent_management_id,$2,
			'memory/evidence/2026-11-04/sessions/'||$4||'.md',$4,$3,'raw-test','room_message','room',
			'teamhub://rooms/room_document_a/messages',$3,'{"room_id":"room_document_a"}','room_document_a'
		FROM agent_registrations registration WHERE registration.actor_id='actor_agent_a'
		ON CONFLICT (id) DO UPDATE SET active_sha256=EXCLUDED.active_sha256,source_version=EXCLUDED.source_version`,
		sourceID, hex.EncodeToString(sourceKey[:]), digest, sessionKey); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO memory_index.source_versions(source_id,sha256,manifest,content,size_bytes)
		VALUES($1,$2,'{"date":"2026-11-04"}',$3,octet_length($3)) ON CONFLICT DO NOTHING`, sourceID, digest, text); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM memory_index.source_versions WHERE source_id=$1 AND sha256<>$2`, sourceID, digest); err != nil {
		return err
	}
	return tx.Commit()
}

func TestUnifiedDocumentMemoryWikiRefreshFreezesIndexedSessions(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := t.Context()
	db, pool := newUnifiedDocumentActionsFixture(t)
	if _, err := db.ExecContext(ctx, `UPDATE agent_registrations SET agent_type='anotherme',receives_all_messages=true,represented_human_actor_id='actor_human_a' WHERE actor_id='actor_agent_a' AND tenant_id='tenant_document_a'; DELETE FROM personal_wikis WHERE tenant_id='tenant_document_a' AND owner_actor_id='actor_human_a'`); err != nil {
		t.Fatal(err)
	}
	objects, err := artifactstore.NewLocalStore(t.TempDir(), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	service := document.NewWithObjectStore(pool, objects)
	if _, err := indexWikiSession(ctx, db, service, "session-a", "# First\n"); err != nil {
		t.Fatal(err)
	}
	result, err := indexWikiSession(ctx, db, service, "session-b", "# Second\n")
	if err != nil || result.WikiID == "" || result.Refresh.Status != document.WikiRefreshInProgress {
		t.Fatalf("second Session joined the first refresh: %+v err=%v", result, err)
	}
	var count int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM document_wiki_refresh_sources
		WHERE refresh_id=$1 AND source_kind='session'`, result.Refresh.ID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("the first refresh froze its own Session: count=%d err=%v", count, err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE document_wiki_refreshes SET status='failed',outcome='failed' WHERE id=$1`, result.Refresh.ID); err != nil {
		t.Fatal(err)
	}
	next, err := service.RequestMemoryWikiRefresh(ctx, document.RequestMemoryWikiRefreshInput{
		TenantID: "tenant_document_a", OwnerActorID: "actor_human_a", Date: "2026-11-04",
	})
	if err != nil || next.Refresh.Status != document.WikiRefreshAccepted || next.Refresh.ID == result.Refresh.ID {
		t.Fatalf("both Sessions admit a new refresh: %+v err=%v", next, err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM document_wiki_refresh_sources
		WHERE refresh_id=$1 AND source_kind='session'`, next.Refresh.ID).Scan(&count); err != nil || count != 2 {
		t.Fatalf("refresh did not freeze both Sessions: count=%d err=%v", count, err)
	}
	replayed, err := service.RequestMemoryWikiRefresh(ctx, document.RequestMemoryWikiRefreshInput{
		TenantID: "tenant_document_a", OwnerActorID: "actor_human_a", Date: "2026-11-04",
	})
	if err != nil || replayed.Refresh.ID != next.Refresh.ID {
		t.Fatalf("the same Sessions replay their refresh: %+v err=%v", replayed, err)
	}
	if _, err := service.RequestMemoryWikiRefresh(ctx, document.RequestMemoryWikiRefreshInput{
		TenantID: "tenant_document_a", OwnerActorID: "actor_agent_a", Date: "2026-11-04",
	}); !errors.Is(err, document.ErrNotFound) {
		t.Fatalf("an Agent owns no Wiki: %v", err)
	}
}
