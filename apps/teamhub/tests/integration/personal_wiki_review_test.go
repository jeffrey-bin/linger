package integration_test

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

func TestPersonalWikiCompilerProjectionUsesFrozenNormalizedContent(t *testing.T) {
	allowParallelIntegrationTest(t)
	generator := &recordingWikiCandidateGenerator{response: document.WikiCandidateGenerationResult{
		Pages: []document.WikiPageCandidate{{PageKey: "index.md", Markdown: []byte("# Index\n")}},
	}}
	env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(t, 0, 0, 0,
		roomDocumentRuntimeTestOptions{wikiCandidateGenerator: generator})
	suffix := strings.ReplaceAll(time.Now().UTC().Format("150405.000000000"), ".", "")
	_, sourceDocumentID, sourceVersionID := seedUnifiedWikiPublicAdmission(t, env, alice, suffix, true)
	status, accepted, body := requestNightlyWikiRefresh(t, env, "2026-11-04")
	if status != http.StatusAccepted || accepted.RefreshID == "" {
		t.Fatalf("refresh status=%d body=%s", status, body)
	}
	waitForUnifiedWikiRefreshSettlement(t, env, accepted.RefreshID)
	calls := generator.callsSnapshot()
	if len(calls) != 1 || len(calls[0].Changes.Added) != 1 ||
		calls[0].Changes.Added[0].DocumentID != sourceDocumentID ||
		calls[0].Changes.Added[0].DocumentVersionID != sourceVersionID ||
		string(calls[0].Changes.Added[0].Content) != "frozen Wiki source" {
		t.Fatalf("candidate exact source=%+v", calls)
	}
}

func TestPersonalWikiDeleteNodeReplaysAfterSoftDelete(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	status, _, body := env.request(alice, http.MethodGet,
		"/v0/tenants/"+acmeTenant+"/personal-wiki", nil, "")
	if status != http.StatusOK {
		t.Fatalf("ensure Wiki status=%d body=%s", status, body)
	}
	status, _, body = env.request(alice, http.MethodGet,
		"/v0/tenants/"+acmeTenant+"/personal-wiki/documents", nil, "")
	var page wikiDocumentPageResponse
	decode(t, body, &page)
	if status != http.StatusOK || len(page.Items) != 0 || page.Page.HasMore || page.Page.NextCursor != "" {
		t.Fatalf("empty Wiki list status=%d page=%+v body=%s", status, page, body)
	}
}

func TestPersonalWikiSameNameUploadsKeepDistinctDocumentIdentities(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	suffix := strings.ReplaceAll(time.Now().UTC().Format("150405.000000000"), ".", "")
	first := uploadUnifiedWikiSourceWithKey(t, env, alice, "wiki-collision-first-"+suffix,
		"same.md", "markdown", "text/markdown", []byte("# First\n"))
	second := uploadUnifiedWikiSourceWithKey(t, env, alice, "wiki-collision-second-"+suffix,
		"same.md", "markdown", "text/markdown", []byte("# Second\n"))
	if first.ID == second.ID {
		t.Fatalf("same-name uploads reused identity first=%+v second=%+v", first, second)
	}
	var drafts, versions int
	if err := env.pool.QueryRow(t.Context(), `SELECT
		(SELECT count(*) FROM document_bodies WHERE document_id=ANY($1)),
		(SELECT count(*) FROM document_versions WHERE document_id=ANY($1))`,
		[]string{first.ID, second.ID}).Scan(&drafts, &versions); err != nil {
		t.Fatal(err)
	}
	if drafts != 0 || versions != 2 {
		t.Fatalf("frozen collision aggregates drafts=%d versions=%d", drafts, versions)
	}
	status, _, body := env.request(alice, http.MethodGet,
		"/v0/tenants/"+acmeTenant+"/personal-wiki/documents", nil, "")
	if status != http.StatusOK || !strings.Contains(string(body), first.ID) ||
		!strings.Contains(string(body), second.ID) {
		t.Fatalf("same-name Documents missing status=%d body=%s", status, body)
	}
}

func TestPersonalWikiDeletedNormalizationDoesNotProjectFailure(t *testing.T) {
	allowParallelIntegrationTest(t)
	generator := &blockingUnifiedWikiGenerator{
		started: make(chan document.WikiCandidateGenerationRequest, 1),
		release: make(chan struct{}),
	}
	released := false
	t.Cleanup(func() {
		if !released {
			close(generator.release)
		}
	})
	env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(t, 0, 0, 0,
		roomDocumentRuntimeTestOptions{wikiCandidateGenerator: generator})
	suffix := strings.ReplaceAll(time.Now().UTC().Format("150405.000000000"), ".", "")
	_, activeDocumentID, _ := seedUnifiedWikiPublicAdmission(t, env, alice, suffix, true)
	suspended := uploadUnifiedWikiSourceWithKey(t, env, alice, "wiki-suspended-second-"+suffix,
		"suspended.txt", "plain_text", "text/plain", []byte("excluded source"))
	if _, err := env.pool.Exec(context.Background(), `UPDATE document_context_bindings
		SET status='suspended',access_epoch=access_epoch+1,updated_at=clock_timestamp()
		WHERE document_id=$1 AND binding_kind='wiki_source' AND status='active'`, suspended.ID); err != nil {
		t.Fatal(err)
	}
	status, accepted, body := requestNightlyWikiRefresh(t, env, "2026-11-04")
	if status != http.StatusAccepted {
		t.Fatalf("refresh status=%d body=%s", status, body)
	}
	var bindingStatus string
	var accessEpoch int64
	if err := env.pool.QueryRow(t.Context(), `SELECT status,access_epoch FROM document_context_bindings
		WHERE document_id=$1 AND binding_kind='wiki_source'`, suspended.ID).Scan(&bindingStatus, &accessEpoch); err != nil {
		t.Fatal(err)
	}
	if bindingStatus != "suspended" || accessEpoch != 2 {
		t.Fatalf("refresh changed excluded source binding: status=%s epoch=%d", bindingStatus, accessEpoch)
	}
	var request document.WikiCandidateGenerationRequest
	select {
	case request = <-generator.started:
	case <-time.After(5 * time.Second):
		t.Fatal("candidate request did not start")
	}
	if len(request.Changes.Added) != 1 || request.Changes.Added[0].DocumentID != activeDocumentID {
		t.Fatalf("suspended source entered candidate request: %+v", request.Changes.Added)
	}
	close(generator.release)
	released = true
	waitForUnifiedWikiRefreshSettlement(t, env, accepted.RefreshID)
}

func TestPersonalWikiRefreshFailureCannotOverwriteConcurrentSuccess(t *testing.T) {
	allowParallelIntegrationTest(t)
	generator := &recordingWikiCandidateGenerator{fail: errors.New("candidate service unavailable")}
	fixture := newUnifiedWikiDispatchCase(t, "wiki_candidate_failure", generator,
		document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 1})
	worked, err := deliverWikiAttempt(t, fixture.pool, fixture.dispatcher, fixture.admission.ID)
	if !worked || err != nil {
		t.Fatalf("candidate failure worked=%v err=%v", worked, err)
	}
	var status, errorCode string
	var revisionCount int
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT refresh.status,
		coalesce(refresh.dispatch_last_error_code,''),
		(SELECT count(*) FROM personal_wikis wiki
		 WHERE wiki.id=refresh.wiki_id AND wiki.current_revision_id IS NOT NULL)
		FROM document_wiki_refreshes refresh WHERE refresh.id=$1`, fixture.admission.ID).Scan(
		&status, &errorCode, &revisionCount,
	); err != nil {
		t.Fatal(err)
	}
	if status != "failed" || errorCode != "candidate_unavailable" || revisionCount != 0 {
		t.Fatalf("failed refresh status=%s code=%s revisions=%d", status, errorCode, revisionCount)
	}
}

func TestPersonalWikiNormalizationLoserCannotOverwriteWinnerOrLeakBlob(t *testing.T) {
	allowParallelIntegrationTest(t)
	generator := &recordingWikiCandidateGenerator{response: document.WikiCandidateGenerationResult{
		RefreshID: "unknown-refresh",
		Pages:     []document.WikiPageCandidate{{PageKey: "index.md", Markdown: []byte("# Invalid\n")}},
	}}
	fixture := newUnifiedWikiDispatchCase(t, "wiki_unknown_result", generator,
		document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 1})
	worked, err := deliverWikiAttempt(t, fixture.pool, fixture.dispatcher, fixture.admission.ID)
	if !worked || err != nil {
		t.Fatalf("unknown candidate result worked=%v err=%v", worked, err)
	}
	var status, errorCode string
	var pages int
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT status,coalesce(dispatch_last_error_code,''),
		(SELECT count(*) FROM document_wiki_pages WHERE wiki_id=refresh.wiki_id)
		FROM document_wiki_refreshes refresh WHERE id=$1`, fixture.admission.ID).Scan(
		&status, &errorCode, &pages,
	); err != nil {
		t.Fatal(err)
	}
	if status != "failed" || errorCode != "candidate_unavailable" || pages != 0 {
		t.Fatalf("unknown result status=%s code=%s pages=%d", status, errorCode, pages)
	}
}

func TestPersonalWikiPublicationRecordsExactSources(t *testing.T) {
	allowParallelIntegrationTest(t)
	generator := &recordingWikiCandidateGenerator{response: document.WikiCandidateGenerationResult{
		Pages: []document.WikiPageCandidate{{PageKey: "index.md", Markdown: []byte("# Exact\n")}},
	}}
	fixture := newUnifiedWikiDispatchCase(t, "wiki_exact_mapping", generator,
		document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 3})
	worked, err := deliverWikiAttempt(t, fixture.pool, fixture.dispatcher, fixture.admission.ID)
	if err != nil || !worked {
		t.Fatalf("dispatch worked=%v err=%v", worked, err)
	}
	var wikiRevisionID, currentRevisionID string
	var sources, pages int
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT refresh.result_wiki_revision_id,
		wiki.current_revision_id,
		(SELECT count(*) FROM document_wiki_published_sources source
		 WHERE source.wiki_id=refresh.wiki_id),
		(SELECT count(*) FROM document_wiki_pages page WHERE page.wiki_id=refresh.wiki_id)
		FROM document_wiki_refreshes refresh
		JOIN personal_wikis wiki ON wiki.id=refresh.wiki_id
		WHERE refresh.id=$1`, fixture.admission.ID).Scan(
		&wikiRevisionID, &currentRevisionID, &sources, &pages,
	); err != nil {
		t.Fatal(err)
	}
	if wikiRevisionID == "" || currentRevisionID != wikiRevisionID || sources != 1 ||
		pages != 1 {
		t.Fatalf("exact mapping revision=%s current=%s sources=%d pages=%d",
			wikiRevisionID, currentRevisionID, sources, pages)
	}
}
