package integration_test

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
)

// windowedMailProvider serves one admitted message, and counts one the
// whitelist kept out, for each mail window it is asked for, numbered by the
// window, so a snapshot and each later sync read distinct mail.
type windowedMailProvider struct {
	*fakeGmailProvider
	pageMu  sync.Mutex
	windows []composio.MailImportPageOptions
}

func (p *windowedMailProvider) FetchMailImportPage(_ context.Context, _, provider string, options composio.MailImportPageOptions) (composio.MailImportPage, error) {
	p.pageMu.Lock()
	defer p.pageMu.Unlock()
	p.windows = append(p.windows, options)
	window := len(p.windows)
	body := []byte(fmt.Sprintf("# Plan %d\n\nAlice will send the quarterly plan on Friday.\n", window))
	page := composio.MailImportPage{
		Read: 2,
		Documents: []composio.AppDocument{{
			RemoteID: fmt.Sprintf("message:human-%d", window), Filename: fmt.Sprintf("%s-human-%d.md", provider, window),
			Markdown: body, ProfileMarkdown: body,
		}},
	}
	if window > 1 {
		page.Documents = append(page.Documents, composio.AppDocument{RemoteID: "message:human-1", Filename: provider + "-human-1.md", Markdown: []byte("# Plan 1\n\nAlice will send the quarterly plan on Friday.\n")})
		page.Read++
	}
	return page, nil
}

func (p *windowedMailProvider) window(index int) (composio.MailImportPageOptions, bool) {
	p.pageMu.Lock()
	defer p.pageMu.Unlock()
	if index >= len(p.windows) {
		return composio.MailImportPageOptions{}, false
	}
	return p.windows[index], true
}

// A mailbox snapshot writes the mail the whitelist admits as Wiki sources;
// each night the mail received since then is read the same way, once per
// night.
func TestMailWhitelistAdmitsMailAndSyncsNightly(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := t.Context()
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(ctx, `UPDATE agent_registrations SET agent_type='anotherme',receives_all_messages=true,represented_human_actor_id='actor_acme_alice' WHERE actor_id='actor_acme_official'`); err != nil {
		t.Fatal(err)
	}
	provider := &windowedMailProvider{fakeGmailProvider: &fakeGmailProvider{status: composio.ConnectionActive}}
	cfg := config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.ArtifactStorageRoot = t.TempDir()
		c.ArtifactMaxBytes = 2 << 20
	})
	newFakeComposio(t).configure(&cfg)
	application, err := newIntegrationApp(ctx, cfg, withComposio(provider), starting(app.JobQueue))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)

	const connectionID = "gmail_whitelist"
	seedExternalConnection(t, ctx, pool, connectionID, "account_alice", "gmail", "active")
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err = jobs.InsertTx(ctx, tx, externalsource.MailConnectionArgs{AccountID: "account_alice", TenantID: acmeTenant, ConnectionID: connectionID}, nil); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	waitFor := func(what, query string, arguments ...any) {
		t.Helper()
		deadline := time.Now().Add(30 * time.Second)
		for {
			var done bool
			if err := pool.QueryRow(ctx, query, arguments...).Scan(&done); err != nil {
				t.Fatal(err)
			}
			if done {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("%s did not happen", what)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	waitFor("the snapshot", `SELECT EXISTS(SELECT 1 FROM external_connections WHERE id=$1 AND mail_import_status='completed')`, connectionID)
	snapshot, _ := provider.window(0)
	var syncedUntil time.Time
	if err := pool.QueryRow(ctx, `SELECT mail_synced_until FROM external_connections WHERE id=$1`, connectionID).Scan(&syncedUntil); err != nil || !syncedUntil.Equal(snapshot.End) {
		t.Fatalf("sync position=%s want the snapshot end %s err=%v", syncedUntil, snapshot.End, err)
	}
	assertMail := func(window int) {
		t.Helper()
		var sources int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM wiki_source_items WHERE source_key=$1`,
			fmt.Sprintf("mail:%s:message:human-%d", connectionID, window)).Scan(&sources); err != nil || sources != 1 {
			t.Fatalf("window %d admitted Wiki sources=%d err=%v", window, sources, err)
		}
	}
	assertMail(1)
	var firstVersion string
	const versionQuery = `SELECT document_version_id FROM wiki_source_items WHERE source_key='mail:gmail_whitelist:message:human-1'`
	if err = pool.QueryRow(ctx, versionQuery).Scan(&firstVersion); err != nil {
		t.Fatal(err)
	}

	// The nightly sweep reads on from the snapshot's end once a night has
	// passed; the snapshot ended two hours before this sync.
	if err := pool.QueryRow(ctx, `UPDATE external_connections SET mail_synced_until=mail_synced_until-interval '2 hours'
		WHERE id=$1 RETURNING mail_synced_until`, connectionID).Scan(&syncedUntil); err != nil {
		t.Fatal(err)
	}
	external := externalsource.New(pool, provider)
	night := time.Now().Add(48 * time.Hour)
	if err := external.EnqueueMailSyncs(ctx, night); err != nil {
		t.Fatal(err)
	}
	waitFor("the nightly sync", `SELECT EXISTS(SELECT 1 FROM external_connections WHERE id=$1 AND mail_synced_until>$2)`, connectionID, syncedUntil)
	nightly, ok := provider.window(1)
	if !ok || !nightly.Start.Equal(syncedUntil.Add(-time.Hour)) || !nightly.End.After(syncedUntil) {
		t.Fatalf("sync window=%+v after position %s", nightly, syncedUntil)
	}
	assertMail(2)
	var replayedVersion string
	if err = pool.QueryRow(ctx, versionQuery).Scan(&replayedVersion); err != nil || replayedVersion != firstVersion {
		t.Fatalf("unchanged overlap mail changed version: %s -> %s: %v", firstVersion, replayedVersion, err)
	}
	t.Log("Nightly overlap: existing message kept its version; new message became a distinct Wiki source")
	var snapshotDocuments int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM external_mail_import_documents WHERE connection_id=$1`, connectionID).Scan(&snapshotDocuments); err != nil || snapshotDocuments != 1 {
		t.Fatalf("the sync changed the Profile snapshot: %d err=%v", snapshotDocuments, err)
	}
	// The same night queues no second sync.
	if err := external.EnqueueMailSyncs(ctx, night); err != nil {
		t.Fatal(err)
	}
	var syncs int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM river_job WHERE kind='external.mail_sync'`).Scan(&syncs); err != nil || syncs != 1 {
		t.Fatalf("mail syncs queued=%d err=%v", syncs, err)
	}
}

// An overlap may read a published message twice without creating a nightly delta.
func TestNightlyWikiSkipsPublishedMailUntilItsVersionChanges(t *testing.T) {
	allowParallelIntegrationTest(t)
	generator := &recordingWikiCandidateGenerator{response: document.WikiCandidateGenerationResult{Pages: []document.WikiPageCandidate{{PageKey: "index.md", Markdown: []byte("# Index\n")}}}}
	f := newUnifiedWikiDispatchCase(t, "mail-overlap", generator, document.WikiRefreshDispatchOptions{GenerationTimeout: time.Minute, MaxAttempts: 3})
	publish := func(id string) {
		t.Helper()
		if worked, err := deliverWikiAttempt(t, f.pool, f.dispatcher, id); err != nil || !worked {
			t.Fatalf("publish: worked=%v err=%v", worked, err)
		}
	}
	publish(f.admission.ID)
	put := func(key, body string) document.UpsertWikiSourceResult {
		t.Helper()
		r, err := f.service.UpsertMailWikiSource(f.ctx, document.UpsertWikiSourceInput{TenantID: "tenant_document_a", OwnerActorID: "actor_human_a", SourceKey: "mail:sample:" + key, Filename: key + ".md", Content: []byte(body)})
		if err != nil {
			t.Fatal(err)
		}
		readyDocumentTexts(t, f.pool, f.objects, nil)
		return r
	}
	nightly := func(day string) document.WikiRefreshResult {
		t.Helper()
		r, err := f.service.RequestMemoryWikiRefresh(f.ctx, document.RequestMemoryWikiRefreshInput{TenantID: "tenant_document_a", OwnerActorID: "actor_human_a", Date: day})
		if err != nil {
			t.Fatal(err)
		}
		return r.Refresh
	}
	first := put("one", "Project notes")
	init := nightly("2026-11-02")
	if init.Status != document.WikiRefreshAccepted {
		t.Fatalf("initial mail: %+v", init)
	}
	publish(init.ID)
	duplicate := put("one", "Project notes")
	if duplicate.Changed || duplicate.VersionID != first.VersionID {
		t.Fatal("overlap changed the source version")
	}
	same := nightly("2026-11-03")
	if same.Status != document.WikiRefreshAlreadyLatest {
		t.Fatalf("unchanged mail: %+v", same)
	}
	put("two", "New meeting notes")
	next := nightly("2026-11-04")
	if next.Status != document.WikiRefreshAccepted || addedWikiSources(t, f.db, next.ID) != 1 {
		t.Fatalf("expected one new source: %+v", next)
	}
	publish(next.ID)
	edited := put("one", "Revised project notes")
	modified := nightly("2026-11-05")
	if edited.DocumentID != first.DocumentID || edited.VersionID == first.VersionID || modified.Status != document.WikiRefreshAccepted || addedWikiSources(t, f.db, modified.ID) != 0 || frozenWikiSources(t, f.db, modified.ID)[first.DocumentID] != edited.VersionID {
		t.Fatalf("edited mail did not refresh its existing source: %+v, %+v", edited, modified)
	}
	t.Log("published mail replay: already_latest; new mail: one added source; edited mail: new version of the existing source")
}
