package integration_test

import (
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func readPersonalWikiHTTPStatus(t *testing.T, env *testEnv, client *http.Client) httpapi.PersonalWiki {
	t.Helper()
	status, _, body := env.request(client, http.MethodGet,
		"/v0/tenants/"+acmeTenant+"/personal-wiki", nil, "")
	if status != http.StatusOK {
		t.Fatalf("Wiki status read=%d body=%s", status, body)
	}
	var wiki httpapi.PersonalWiki
	decode(t, body, &wiki)
	return wiki
}

func assertPersonalWikiRefreshState(t *testing.T, fixture *unifiedWikiDispatchCase, state string) document.PersonalWiki {
	t.Helper()
	wiki, err := document.New(fixture.pool).GetPersonalWiki(
		fixture.ctx, "account_document_a", "tenant_document_a")
	if err != nil || wiki.State != state {
		t.Fatalf("Wiki state=%q want=%q err=%v", wiki.State, state, err)
	}
	return wiki
}

func TestUnifiedWikiRefreshQueuesNewGenerationAfterTerminalFailure(t *testing.T) {
	allowParallelIntegrationTest(t)
	generator := &recordingWikiCandidateGenerator{response: document.WikiCandidateGenerationResult{
		Pages: []document.WikiPageCandidate{{PageKey: "index.md", Markdown: []byte("# Published\n")}},
	}}
	fixture := newUnifiedWikiDispatchCase(t, "refreshstatus", generator,
		document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 1}, "replaceable")
	if worked, err := deliverWikiAttempt(t, fixture.pool, fixture.dispatcher, fixture.admission.ID); err != nil || !worked {
		t.Fatalf("initial publication worked=%v err=%v", worked, err)
	}
	published := assertPersonalWikiRefreshState(t, fixture, "idle")
	if published.CurrentRevisionID == "" {
		t.Fatal("initial publication has no safe Revision")
	}
	secondVersionID := replaceUnifiedWikiDispatchSource(t, fixture, "updated source")
	generator.fail = errors.New("candidate service unavailable")
	for _, key := range []string{"first-failure", "second-failure", "recovery"} {
		readyDocumentTexts(t, fixture.pool, fixture.objects, nil)
		admission, err := fixture.service.RequestWikiRefresh(fixture.ctx, document.RequestWikiRefreshInput{
			AccountID: "account_document_a", TenantID: "tenant_document_a", IdempotencyKey: key,
		})
		if err != nil || admission.Status != document.WikiRefreshAccepted || admission.ID == fixture.admission.ID {
			t.Fatalf("admission=%+v err=%v", admission, err)
		}
		var frozenVersion string
		if err := fixture.pool.QueryRow(fixture.ctx, `SELECT frozen_document_version_id
			FROM document_wiki_refresh_sources WHERE refresh_id=$1 AND document_id='document_wiki_replaceable_source'`, admission.ID).Scan(&frozenVersion); err != nil {
			t.Fatal(err)
		}
		if frozenVersion != secondVersionID {
			t.Fatalf("follow-up frozen version=%q want=%q", frozenVersion, secondVersionID)
		}
		assertPersonalWikiRefreshState(t, fixture, "refreshing")
		if key == "recovery" {
			generator.fail = nil
			if worked, err := deliverWikiAttempt(t, fixture.pool, fixture.dispatcher, admission.ID); err != nil || !worked {
				t.Fatalf("recovery worked=%v err=%v", worked, err)
			}
			current := assertPersonalWikiRefreshState(t, fixture, "idle")
			if current.CurrentRevisionID == published.CurrentRevisionID || current.PublishedGeneration <= published.PublishedGeneration {
				t.Fatal("recovery did not publish a new safe Revision")
			}
			continue
		}
		// MaxAttempts is 1, so this attempt is final: it fails the refresh and returns nil.
		if worked, err := deliverWikiAttempt(t, fixture.pool, fixture.dispatcher, admission.ID); err != nil || !worked {
			t.Fatalf("failed delivery worked=%v err=%v", worked, err)
		}
		// Each failure names its own refresh, so a client can tell it from
		// the previous one.
		failed := assertPersonalWikiRefreshState(t, fixture, "failed")
		if failed.CurrentRevisionID != published.CurrentRevisionID || failed.PublishedGeneration != published.PublishedGeneration {
			t.Fatalf("failed refresh changed safe publication: before=%+v after=%+v", published, failed)
		}
		if failed.LatestRefreshID != admission.ID {
			t.Fatalf("failed latest refresh=%q want=%q", failed.LatestRefreshID, admission.ID)
		}
	}
}

// A refresh conflicts when the Wiki moved off its base Revision. Settlement
// queues a follow-up, so the public state stays refreshing instead of showing
// a failure the server is already retrying; once the follow-up is done without
// a newer refresh, the conflict reads as failed.
func TestUnifiedWikiConflictWithQueuedFollowupStaysRefreshing(t *testing.T) {
	allowParallelIntegrationTest(t)
	generator := &recordingWikiCandidateGenerator{response: document.WikiCandidateGenerationResult{
		Pages: []document.WikiPageCandidate{{PageKey: "index.md", Markdown: []byte("# Published\n")}},
	}}
	fixture := newUnifiedWikiDispatchCase(t, "conflictstatus", generator,
		document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 1}, "replaceable")
	if worked, err := deliverWikiAttempt(t, fixture.pool, fixture.dispatcher, fixture.admission.ID); err != nil || !worked {
		t.Fatalf("initial publication worked=%v err=%v", worked, err)
	}
	replaceUnifiedWikiDispatchSource(t, fixture, "updated source")
	readyDocumentTexts(t, fixture.pool, fixture.objects, nil)
	admission, err := fixture.service.RequestWikiRefresh(fixture.ctx, document.RequestWikiRefreshInput{
		AccountID: "account_document_a", TenantID: "tenant_document_a", IdempotencyKey: "conflicting-refresh",
	})
	if err != nil || admission.Status != document.WikiRefreshAccepted {
		t.Fatalf("admission=%+v err=%v", admission, err)
	}
	if _, err := fixture.pool.Exec(fixture.ctx, `UPDATE personal_wikis SET current_revision_id=NULL,published_at=NULL WHERE id='wiki_document_a'`); err != nil {
		t.Fatal(err)
	}
	if worked, err := deliverWikiAttempt(t, fixture.pool, fixture.dispatcher, admission.ID); err != nil || !worked {
		t.Fatalf("conflicting delivery worked=%v err=%v", worked, err)
	}
	var status string
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT status FROM document_wiki_refreshes WHERE id=$1`, admission.ID).Scan(&status); err != nil || status != "conflicted" {
		t.Fatalf("refresh status=%q err=%v", status, err)
	}
	assertPersonalWikiRefreshState(t, fixture, "refreshing")
	if _, err := fixture.pool.Exec(fixture.ctx, `UPDATE river_job SET state='completed',finalized_at=clock_timestamp()
		WHERE kind='document.wiki_refresh_followup' AND args->>'refresh_id'=$1`, admission.ID); err != nil {
		t.Fatal(err)
	}
	assertPersonalWikiRefreshState(t, fixture, "failed")
}
