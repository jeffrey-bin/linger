package integration_test

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
)

type paginatedMailProvider struct {
	*fakeGmailProvider
	pageMu     sync.Mutex
	total      int
	read       int
	start, end time.Time
	// failures makes the next page reads fail with a transient provider 502.
	failures int
	failed   int
}

const automatedMailMarker = "Weekly newsletter digest automated-marker"

func (p *paginatedMailProvider) FetchMailImportPage(_ context.Context, _, provider string, options composio.MailImportPageOptions) (composio.MailImportPage, error) {
	p.pageMu.Lock()
	defer p.pageMu.Unlock()
	if p.start.IsZero() {
		p.start, p.end = options.Start, options.End
	}
	if p.start != options.Start || p.end != options.End || p.start != composio.MailImportStart(p.end) {
		return composio.MailImportPage{}, fmt.Errorf("mail window changed")
	}
	if p.failed < p.failures {
		p.failed++
		return composio.MailImportPage{}, composio.RemoteStatusError("read mail import message", http.StatusBadGateway)
	}
	offset := 0
	if options.Cursor != "" {
		offset, _ = strconv.Atoi(options.Cursor)
	}
	count := min(options.Limit, p.total-offset)
	page := composio.MailImportPage{Read: count}
	for i := offset; i < offset+count; i++ {
		if i == 0 {
			// renderImportedMail marks automated mail and keeps its full text.
			page.Documents = append(page.Documents, composio.AppDocument{RemoteID: "message:0", Filename: provider + "-0.md", Markdown: []byte(automatedMailMarker), ProfileMarkdown: []byte(automatedMailMarker), Automated: true})
			continue
		}
		page.Documents = append(page.Documents, composio.AppDocument{RemoteID: fmt.Sprintf("message:%d", i), Filename: fmt.Sprintf("%s-%d.md", provider, i), Markdown: []byte("I work on backend systems at Acme."), ProfileMarkdown: []byte("I work on backend systems at Acme.")})
	}
	if offset+count < p.total {
		page.NextCursor = strconv.Itoa(offset + count)
	}
	p.read += count
	return page, nil
}

func TestMailConnectionAutomaticallyImportsWikiWithoutProfile(t *testing.T) {
	allowParallelIntegrationTest(t)
	for _, providerName := range []string{"gmail", "outlook"} {
		t.Run(providerName, func(t *testing.T) {
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
			provider := &paginatedMailProvider{fakeGmailProvider: &fakeGmailProvider{status: composio.ConnectionActive}, total: 3001}
			generator := &recordingProfileGenerator{facts: []string{"Works at Acme."}}
			cfg := config.ForTest(func(c *config.Config) {
				c.DatabaseURL = databaseURL
				c.SessionTTL = time.Hour
				c.CookieName = "teamhub_session"
				c.ArtifactStorageRoot = t.TempDir()
				c.ArtifactMaxBytes = 2 << 20
			})
			// Mail jobs run only while a Composio key is configured.
			newFakeComposio(t).configure(&cfg)
			application, err := newIntegrationApp(ctx, cfg, withComposio(provider), withPersonalProfileGenerator(generator), starting(app.JobQueue))
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(application.Close)
			server := httptest.NewServer(application.Handler())
			registerIntegrationServerCleanup(t, server)
			env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}
			// Authorization goes through managed Composio; start from the job it queues.
			connectionID := providerName + "_auto"
			seedExternalConnection(t, ctx, pool, connectionID, "account_alice", providerName, "active")
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
			deadline := time.Now().Add(3 * time.Minute)
			finished := false
			for time.Now().Before(deadline) {
				var completed bool
				var docs int
				_ = pool.QueryRow(ctx, `SELECT coalesce((SELECT mail_import_status='completed' FROM external_connections WHERE id=$1),false), (SELECT count(*) FROM wiki_source_items WHERE source_key LIKE 'mail:'||$1||':%')`, connectionID).Scan(&completed, &docs)
				if completed && docs == 3000 {
					finished = true
					break
				}
				time.Sleep(20 * time.Millisecond)
			}
			if !finished {
				var status string
				_ = pool.QueryRow(ctx, `SELECT coalesce(mail_import_status,'')||':'||coalesce(mail_import_error_code,'') FROM external_connections WHERE id=$1`, connectionID).Scan(&status)
				t.Fatalf("mail import was not consumed; snapshot=%s", status)
			}
			var docs, snapshots int
			var snapshot string
			if err = pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM wiki_source_items WHERE source_key LIKE 'mail:'||$1||':%'), (SELECT count(*) FROM external_mail_import_documents WHERE connection_id=$1), (SELECT mail_import_status FROM external_connections WHERE id=$1)`, connectionID).Scan(&docs, &snapshots, &snapshot); err != nil {
				t.Fatal(err)
			}
			if docs != 3000 || snapshots != 3000 || snapshot != "completed" {
				t.Fatalf("docs=%d snapshots=%d snapshot=%s", docs, snapshots, snapshot)
			}
			// The completed snapshot queues one Wiki refresh instead of waiting
			// for the night.
			if got := countRows(t, env, `SELECT count(*) FROM river_job WHERE kind='document.mail_wiki_init' AND args->>'connection_id'=$1`, connectionID); got != 1 {
				t.Fatalf("completed mail snapshot queued %d Wiki refreshes", got)
			}
			// A mail import refreshes the Wiki only; Profiles come from explicit
			// generations or the personal-profile Skill.
			if got := countRows(t, env, `SELECT count(*) FROM personal_profile_generations WHERE tenant_id=$1`, acmeTenant); got != 0 {
				t.Fatalf("mail import created %d Profile generations", got)
			}
			// Automated mail reaches the Wiki.
			var automatedWiki int
			if err = pool.QueryRow(ctx, `SELECT count(*) FROM wiki_source_items WHERE source_key=$1`, "mail:"+connectionID+":message:0").Scan(&automatedWiki); err != nil || automatedWiki != 1 {
				t.Fatalf("automated mail Wiki sources=%d err=%v", automatedWiki, err)
			}
			generator.mu.Lock()
			if len(generator.requests) != 0 {
				t.Errorf("mail import called the Profile generator: %d", len(generator.requests))
			}
			generator.mu.Unlock()
			// All entry points reuse the completed snapshot, including concurrent replays.
			external := externalsource.New(pool, provider)
			var callers sync.WaitGroup
			for range 4 {
				callers.Add(1)
				go func() {
					defer callers.Done()
					if err := external.EnsureMailImport(ctx, "account_alice", acmeTenant, connectionID); err != nil {
						t.Error(err)
					}
				}()
			}
			callers.Wait()
			connection, err := external.GetConnection(ctx, "account_alice", connectionID)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = external.Disconnect(ctx, "account_alice", connectionID, connection.Revision); err != nil {
				t.Fatal(err)
			}
			if err = pool.QueryRow(ctx, `SELECT count(*) FROM external_mail_import_documents WHERE connection_id=$1`, connectionID).Scan(&snapshots); err != nil {
				t.Fatal(err)
			}
			if snapshots != 0 {
				t.Fatalf("disconnect retained %d mail evidence snapshots", snapshots)
			}

			provider.pageMu.Lock()
			defer provider.pageMu.Unlock()
			if provider.read != 3000 {
				t.Fatalf("mail read more than once: %d", provider.read)
			}
		})
	}
}

func TestMailImportRetriesTransientProviderFailures(t *testing.T) {
	allowParallelIntegrationTest(t)
	for _, test := range []struct {
		name        string
		failures    int
		maxAttempts int
		wantStatus  string
		wantCode    string
		wantStored  int
	}{
		{name: "recovers", failures: 1, wantStatus: "completed", wantStored: 3},
		{name: "last attempt fails the job", failures: 100, maxAttempts: 1, wantStatus: "failed", wantCode: "provider_unavailable"},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := t.Context()
			pool, err := pgxpool.New(ctx, newIntegrationDatabase(t))
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(pool.Close)
			accountID := aliceAccountID(t, ctx, pool)
			seedExternalConnection(t, ctx, pool, "connection_mail_retry", accountID, "gmail", "active")
			provider := &paginatedMailProvider{fakeGmailProvider: &fakeGmailProvider{status: composio.ConnectionActive}, total: 3, failures: test.failures}
			service := newFakeComposio(t).externalSources(t, pool, provider)
			logs := &lockedBuffer{}
			service.SetLogger(slog.New(slog.NewTextHandler(logs, nil)))
			if err = service.EnsureMailImport(ctx, accountID, "tenant_acme", "connection_mail_retry"); err != nil {
				t.Fatal(err)
			}
			if test.maxAttempts > 0 {
				if _, err = pool.Exec(ctx, `UPDATE river_job SET max_attempts=$1 WHERE kind='external.mail_import'`, test.maxAttempts); err != nil {
					t.Fatal(err)
				}
			}
			startExternalJobs(t, pool, service)
			var status, code string
			deadline := time.Now().Add(time.Minute)
			for time.Now().Before(deadline) {
				if err = pool.QueryRow(ctx, `SELECT mail_import_status,coalesce(mail_import_error_code,'') FROM external_connections WHERE id='connection_mail_retry'`).Scan(&status, &code); err != nil {
					t.Fatal(err)
				}
				if status == "completed" || status == "failed" {
					break
				}
				time.Sleep(20 * time.Millisecond)
			}
			var stored int
			if err = pool.QueryRow(ctx, `SELECT count(*) FROM external_mail_import_documents WHERE connection_id='connection_mail_retry'`).Scan(&stored); err != nil {
				t.Fatal(err)
			}
			if status != test.wantStatus || code != test.wantCode || stored != test.wantStored {
				t.Fatalf("status=%s code=%q stored=%d", status, code, stored)
			}
			for _, field := range []string{`msg="gmail provider call failed"`, "connection_id=connection_mail_retry", "operation=mail_import_page", "http_status=502", "retryable=true"} {
				if !strings.Contains(logs.String(), field) {
					t.Fatalf("Gmail failure log missing %q: %s", field, logs.String())
				}
			}
		})
	}
}

// A snapshot whose Connection stops being active at the same revision is
// dropped instead of staying running, and starts again once it is active.
func TestMailImportRestartsAfterItsConnectionWasInactive(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := t.Context()
	pool, err := pgxpool.New(ctx, newIntegrationDatabase(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	accountID := aliceAccountID(t, ctx, pool)
	seedExternalConnection(t, ctx, pool, "connection_mail_inactive", accountID, "gmail", "active")
	provider := &paginatedMailProvider{fakeGmailProvider: &fakeGmailProvider{status: composio.ConnectionActive}, total: 3}
	service := newFakeComposio(t).externalSources(t, pool, provider)
	if err = service.EnsureMailImport(ctx, accountID, "tenant_acme", "connection_mail_inactive"); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `UPDATE external_connections SET status='expired' WHERE id='connection_mail_inactive'`); err != nil {
		t.Fatal(err)
	}
	snapshot := func() string {
		t.Helper()
		var status string
		if err := pool.QueryRow(ctx, `SELECT coalesce(mail_import_status,'') FROM external_connections WHERE id='connection_mail_inactive'`).Scan(&status); err != nil {
			t.Fatal(err)
		}
		return status
	}
	stop := startExternalJobs(t, pool, service)
	deadline := time.Now().Add(30 * time.Second)
	for snapshot() != "" {
		if time.Now().After(deadline) {
			t.Fatalf("the snapshot of an inactive connection stayed %q", snapshot())
		}
		time.Sleep(20 * time.Millisecond)
	}
	stop()
	if _, err = pool.Exec(ctx, `UPDATE external_connections SET status='active' WHERE id='connection_mail_inactive'`); err != nil {
		t.Fatal(err)
	}
	result, err := service.ReadMailImport(ctx, accountID, "tenant_acme", "connection_mail_inactive")
	if err != nil || result.Status != "running" || snapshot() != "running" {
		t.Fatalf("the snapshot did not start again: result=%+v err=%v snapshot=%q", result, err, snapshot())
	}
}

// lockedBuffer collects logs written by River workers and read by the test.
type lockedBuffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.String()
}
