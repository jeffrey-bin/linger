package integration_test

import (
	"context"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

// unsettlingWikiGenerator writes a candidate that leaves every added or
// modified source unwritten: as failed tasks, or with deferred, as tasks the
// generation's budget never started.
type unsettlingWikiGenerator struct{ deferred bool }

func (g unsettlingWikiGenerator) GenerateWikiCandidates(ctx context.Context, request document.WikiCandidateGenerationRequest) (document.WikiCandidateGenerationResult, error) {
	request, err := readWikiCandidateRequest(ctx, request)
	if err != nil {
		return document.WikiCandidateGenerationResult{}, err
	}
	result := successfulWikiCandidateResult(request)
	for _, source := range append(request.Changes.Added, request.Changes.Modified...) {
		reference := document.WikiCandidateSourceReference{
			DocumentID: source.DocumentID, DocumentVersionID: source.DocumentVersionID, Filename: source.Filename,
		}
		if g.deferred {
			result.Deferred = append(result.Deferred, reference)
		} else {
			result.Unsettled = append(result.Unsettled, reference)
		}
	}
	return result, nil
}

// A source the candidate left unwritten stays pending, so the next refresh
// takes it again; after its third try it settles, so it cannot hold the Wiki.
func TestUnifiedWikiKeepsUnsettledSourcesPendingUntilTheirLastTry(t *testing.T) {
	allowParallelIntegrationTest(t)
	options := document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 3}
	fixture := newUnifiedWikiDispatchCase(t, "unsettled-1", unsettlingWikiGenerator{}, options)
	state := func() (published, tries, followups int) {
		t.Helper()
		if err := fixture.pool.QueryRow(fixture.ctx, `SELECT
			(SELECT count(*) FROM document_wiki_published_sources
			   WHERE wiki_id='wiki_document_a' AND document_id='document_human_a'),
			(SELECT coalesce(max(tries),0) FROM document_wiki_unsettled_sources
			   WHERE wiki_id='wiki_document_a' AND document_id='document_human_a'),
			(SELECT count(*) FROM river_job WHERE kind=$1)`,
			document.WikiRefreshFollowupArgs{}.Kind()).Scan(&published, &tries, &followups); err != nil {
			t.Fatal(err)
		}
		return published, tries, followups
	}
	refreshID := fixture.admission.ID
	for try := 1; try <= 3; try++ {
		if try > 1 {
			admission, err := fixture.service.RequestWikiRefresh(fixture.ctx, document.RequestWikiRefreshInput{
				AccountID: "account_document_a", TenantID: "tenant_document_a",
				IdempotencyKey: "wiki-dispatch-unsettled-" + string(rune('0'+try)),
			})
			if err != nil || admission.Status != document.WikiRefreshAccepted {
				t.Fatalf("try %d: the pending source was not admitted again: %+v %v", try, admission, err)
			}
			refreshID = admission.ID
		}
		if worked, err := deliverWikiAttempt(t, fixture.pool, fixture.dispatcher, refreshID); !worked || err != nil {
			t.Fatalf("try %d: worked=%v err=%v", try, worked, err)
		}
		published, tries, followups := state()
		if try < 3 && (published != 0 || tries != try || followups != try) {
			t.Fatalf("try %d: published=%d tries=%d followups=%d", try, published, tries, followups)
		}
		if try == 3 && (published != 1 || tries != 0) {
			t.Fatalf("last try: published=%d tries=%d", published, tries)
		}
	}
	admission, err := fixture.service.RequestWikiRefresh(fixture.ctx, document.RequestWikiRefreshInput{
		AccountID: "account_document_a", TenantID: "tenant_document_a", IdempotencyKey: "wiki-dispatch-unsettled-done",
	})
	if err != nil || admission.Status != document.WikiRefreshAlreadyLatest {
		t.Fatalf("after settling: %+v %v", admission, err)
	}
}

// A source the budget left unwritten stays pending and spends no try: it is
// never settled unwritten, however many refreshes defer it. A refresh that
// published nothing else queues no follow-up for it.
func TestUnifiedWikiKeepsDeferredSourcesPendingWithoutSpendingTries(t *testing.T) {
	allowParallelIntegrationTest(t)
	options := document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 3}
	fixture := newUnifiedWikiDispatchCase(t, "deferred-1", unsettlingWikiGenerator{deferred: true}, options)
	refreshID := fixture.admission.ID
	for try := 1; try <= 4; try++ {
		if try > 1 {
			admission, err := fixture.service.RequestWikiRefresh(fixture.ctx, document.RequestWikiRefreshInput{
				AccountID: "account_document_a", TenantID: "tenant_document_a",
				IdempotencyKey: "wiki-dispatch-deferred-" + string(rune('0'+try)),
			})
			if err != nil || admission.Status != document.WikiRefreshAccepted {
				t.Fatalf("try %d: the deferred source was not admitted again: %+v %v", try, admission, err)
			}
			refreshID = admission.ID
		}
		if worked, err := deliverWikiAttempt(t, fixture.pool, fixture.dispatcher, refreshID); !worked || err != nil {
			t.Fatalf("try %d: worked=%v err=%v", try, worked, err)
		}
		var published, counted, followups int
		if err := fixture.pool.QueryRow(fixture.ctx, `SELECT
			(SELECT count(*) FROM document_wiki_published_sources
			   WHERE wiki_id='wiki_document_a' AND document_id='document_human_a'),
			(SELECT count(*) FROM document_wiki_unsettled_sources WHERE wiki_id='wiki_document_a'),
			(SELECT count(*) FROM river_job WHERE kind=$1)`,
			document.WikiRefreshFollowupArgs{}.Kind()).Scan(&published, &counted, &followups); err != nil {
			t.Fatal(err)
		}
		if published != 0 || counted != 0 || followups != 0 {
			t.Fatalf("try %d: published=%d counted=%d followups=%d", try, published, counted, followups)
		}
	}
}
