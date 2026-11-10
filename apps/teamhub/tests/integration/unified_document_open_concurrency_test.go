package integration_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

func TestDocumentOpenSurvivesConcurrentGetAndRevocation(t *testing.T) {
	allowParallelIntegrationTest(t)
	for _, format := range []string{"plain_text", "blocknote"} {
		t.Run(format, func(t *testing.T) {
			_, pool := newUnifiedDocumentFixture(t, `
				UPDATE documents SET format=$1 WHERE id='document_human_a';
				INSERT INTO document_bodies(document_id,seq,state,state_vector,asset_ids,thread_ids,last_editor_ids) SELECT draft.document_id,draft.persisted_seq::bigint,revision.state_bytes,draft.state_vector::bytea,ARRAY(SELECT asset->>'asset_id' FROM jsonb_array_elements(revision.asset_manifest) asset ORDER BY 1),revision.thread_manifest,ARRAY[draft.last_content_actor_id]::text[] FROM (SELECT 'document_human_a','tenant_document_a',0,'\x00',repeat('c',64),
				 'revision_human_a','actor_human_a' WHERE $1='blocknote') AS draft(document_id,tenant_id,persisted_seq,state_vector,full_state_fingerprint,current_revision_id,last_content_actor_id) JOIN document_revisions revision ON revision.id=draft.current_revision_id;
				CREATE FUNCTION pause_document_open_race() RETURNS trigger LANGUAGE plpgsql AS $$
				BEGIN
					PERFORM pg_advisory_xact_lock(1470139293);
					RETURN NEW;
				END $$;
				-- AFTER triggers run alphabetically; stop after the row exists but
				-- before the RI_ConstraintTrigger takes the Document KEY SHARE lock.
				CREATE TRIGGER "A_pause_recent_open_before_fk" AFTER INSERT ON document_recent_opens
				FOR EACH ROW EXECUTE FUNCTION pause_document_open_race();
			`, format)
			ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
			defer cancel()
			service := document.New(pool)
			barrier, err := pool.Acquire(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer barrier.Release()
			if _, err := barrier.Exec(ctx, `SELECT pg_advisory_lock(1470139293)`); err != nil {
				t.Fatal(err)
			}
			defer barrier.Exec(context.Background(), `SELECT pg_advisory_unlock(1470139293)`)
			barrierPID := int(barrier.Conn().PgConn().PID())
			waitForBlockedQuery := func(blockerPID int, queryPattern string) int {
				t.Helper()
				for {
					var waitingPID int
					if err := pool.QueryRow(ctx, `SELECT COALESCE((SELECT pid FROM pg_stat_activity
						WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))
						AND query LIKE $2 LIMIT 1),0)`, blockerPID, queryPattern).Scan(&waitingPID); err != nil {
						t.Fatal(err)
					}
					if waitingPID != 0 {
						return waitingPID
					}
					select {
					case <-ctx.Done():
						t.Fatal(ctx.Err())
					case <-time.After(10 * time.Millisecond):
					}
				}
			}
			getResult := make(chan error, 1)
			go func() {
				value, err := service.Get(ctx, "account_document_a", "document_human_a")
				if err == nil && (value.ID != "document_human_a" || !value.Capabilities.Read) {
					err = errors.New("Get lost the authorized Document")
				}
				getResult <- err
			}()
			getPID := waitForBlockedQuery(barrierPID, "%INSERT INTO document_recent_opens%")
			type openResult struct {
				value document.OpenResult
				err   error
			}
			openResults := make(chan openResult, 2)
			openDocument := func() {
				value, err := service.Open(ctx, document.IssueCollaborationCredentialInput{
					AccountID: "account_document_a", DocumentID: "document_human_a", ExpiresAt: time.Now().Add(time.Hour),
				})
				openResults <- openResult{value, err}
			}
			go openDocument()
			openPID := waitForBlockedQuery(getPID, "%INSERT INTO document_recent_opens%")
			go openDocument()
			// Open must still serialize another Open on the Document itself.
			waitForBlockedQuery(openPID, "%SELECT id FROM documents%")
			if _, err := barrier.Exec(ctx, `SELECT pg_advisory_unlock(1470139293)`); err != nil {
				t.Fatal(err)
			}
			getErr := <-getResult
			first, second := <-openResults, <-openResults
			if getErr != nil || first.err != nil || second.err != nil {
				t.Fatalf("concurrent authorized Get/Open failed: Get=%v Open1=%v Open2=%v", getErr, first.err, second.err)
			}
			for _, opened := range []document.OpenResult{first.value, second.value} {
				if opened.Document.ID != "document_human_a" || !opened.Document.Capabilities.Read ||
					(opened.Credential != nil) != (format == "blocknote") {
					t.Fatalf("Open returned invalid Document/session: %#v", opened)
				}
			}
			if format == "blocknote" && first.value.Credential.CollaborationCredential == second.value.Credential.CollaborationCredential {
				t.Fatal("concurrent viewers shared a connection token")
			}
			var count int
			if err := pool.QueryRow(ctx, `SELECT count(*) FROM document_recent_opens
				WHERE document_id='document_human_a'`).Scan(&count); err != nil || count != 1 {
				t.Fatalf("recent-open record count=%d error=%v", count, err)
			}

			// A current lifecycle write remains authoritative: Open must wait for
			// it and reject the now-inactive Document, without issuing a session.
			if _, err := pool.Exec(ctx, `CREATE TRIGGER pause_document_trash
				BEFORE UPDATE OF status ON documents FOR EACH ROW
				WHEN (NEW.status='trashed') EXECUTE FUNCTION pause_document_open_race()`); err != nil {
				t.Fatal(err)
			}
			if _, err := barrier.Exec(ctx, `SELECT pg_advisory_lock(1470139293)`); err != nil {
				t.Fatal(err)
			}
			trashResult := make(chan error, 1)
			go func() {
				trashResult <- service.Trash(ctx, document.TrashDocumentInput{
					AccountID: "account_document_a", DocumentID: "document_human_a",
				})
			}()
			revokerPID := waitForBlockedQuery(barrierPID, "%UPDATE documents%")
			go openDocument()
			waitForBlockedQuery(revokerPID, "%SELECT id FROM documents%")
			if _, err := barrier.Exec(ctx, `SELECT pg_advisory_unlock(1470139293)`); err != nil {
				t.Fatal(err)
			}
			if err := <-trashResult; err != nil {
				t.Fatal(err)
			}
			rejected := <-openResults
			if !errors.Is(rejected.err, document.ErrNotFound) || rejected.value.Credential != nil {
				t.Fatalf("Open admitted revoked Document: credential present=%t error=%v", rejected.value.Credential != nil, rejected.err)
			}
		})
	}
}
