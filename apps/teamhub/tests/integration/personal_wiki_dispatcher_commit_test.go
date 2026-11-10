package integration_test

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

// Drop only the publication transaction's COMMIT, either before the server
// receives it or after its CommandComplete arrives. Other SQL uses real PG.
type wikiCommitDisconnect struct {
	net.Conn
	pending      []byte
	armed        atomic.Bool
	beforeCommit bool
	disconnect   func() error
}

func (c *wikiCommitDisconnect) Write(message []byte) (int, error) {
	if bytes.Contains(message, []byte("SET status='settled'")) || bytes.Contains(message, []byte("SET status='conflicted'")) {
		c.armed.Store(true)
	}
	if c.armed.Load() && c.beforeCommit && bytes.Contains(message, []byte("commit\x00")) {
		_ = c.Conn.Close()
		return 0, errors.Join(io.ErrUnexpectedEOF, c.disconnect())
	}
	return c.Conn.Write(message)
}

func (c *wikiCommitDisconnect) Read(target []byte) (int, error) {
	if len(c.pending) == 0 {
		header := make([]byte, 5)
		if _, err := io.ReadFull(c.Conn, header); err != nil {
			return 0, err
		}
		body := make([]byte, int(binary.BigEndian.Uint32(header[1:]))-4)
		if _, err := io.ReadFull(c.Conn, body); err != nil {
			return 0, err
		}
		if c.armed.Load() && header[0] == 'C' && string(body) == "COMMIT\x00" {
			_ = c.Conn.Close()
			return 0, errors.Join(io.ErrUnexpectedEOF, c.disconnect())
		}
		c.pending = append(header, body...)
	}
	n := copy(target, c.pending)
	c.pending = c.pending[n:]
	return n, nil
}

func TestUnifiedWikiDispatcherReconcilesCommitAcknowledgement(t *testing.T) {
	allowParallelIntegrationTest(t)
	for _, scenario := range []struct {
		name                                   string
		beforeCommit, conflicted, laterAttempt bool
	}{
		{name: "settled despite lost acknowledgement and cancellation"},
		{name: "conflicted despite lost acknowledgement", conflicted: true},
		{name: "uncommitted publication remains retryable", beforeCommit: true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			generator := &recordingWikiCandidateGenerator{response: document.WikiCandidateGenerationResult{
				Pages: []document.WikiPageCandidate{{PageKey: "index.md", Markdown: []byte("# Index\n")}},
			}}
			options := document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 3}
			fixture := newUnifiedWikiDispatchCase(t, "commitack", generator, options)
			_, cancel := context.WithCancel(fixture.ctx)
			defer cancel()
			injected := make(chan error, 1)
			config := fixture.pool.Config()
			dial := config.ConnConfig.DialFunc
			config.ConnConfig.DialFunc = func(callctx context.Context, network, address string) (net.Conn, error) {
				conn, err := dial(callctx, network, address)
				if err != nil {
					return nil, err
				}
				return &wikiCommitDisconnect{Conn: conn, beforeCommit: scenario.beforeCommit, disconnect: func() error {
					var faultErr error
					cancel()
					injected <- faultErr
					return faultErr
				}}, nil
			}
			faultPool, err := pgxpool.NewWithConfig(fixture.ctx, config)
			if err != nil {
				t.Fatal(err)
			}
			defer faultPool.Close()
			if scenario.conflicted {
				// Another publication lands while this refresh generates.
				generator.beforeReturn = func(context.Context, document.WikiCandidateGenerationRequest) error {
					_, err := fixture.pool.Exec(fixture.ctx, `UPDATE personal_wikis
						SET current_revision_id='wiki_revision_concurrent',published_at=clock_timestamp()
						WHERE id='wiki_document_a'`)
					return err
				}
			}
			service := document.NewWithObjectStore(faultPool, fixture.objects)
			dispatcher, err := document.NewWikiRefreshDispatcher(faultPool, fixture.objects, generator, service, options)
			if err != nil {
				t.Fatal(err)
			}
			worked, deliveryErr := deliverWikiAttempt(t, fixture.pool, dispatcher, fixture.admission.ID)
			select {
			case err := <-injected:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(5 * time.Second):
				t.Fatalf("publication COMMIT fault was not exercised: worked=%v err=%v", worked, deliveryErr)
			}
			var state string
			var revisions int
			if err := fixture.pool.QueryRow(fixture.ctx, `SELECT status,
				(SELECT count(*) FROM personal_wikis WHERE id=refresh.wiki_id
				   AND current_revision_id=refresh.result_wiki_revision_id)
				FROM document_wiki_refreshes refresh WHERE id=$1`, fixture.admission.ID).Scan(&state, &revisions); err != nil {
				t.Fatal(err)
			}
			attempts := wikiDispatchJobAttempt(t, fixture.pool, fixture.admission.ID)
			wantState, wantRevisions, wantAttempts := "settled", 1, 1
			if scenario.conflicted {
				wantState, wantRevisions = "conflicted", 0
			}
			if scenario.beforeCommit {
				wantState, wantRevisions = "staging", 0
			}
			if state != wantState || attempts != wantAttempts || revisions != wantRevisions {
				t.Fatalf("state=%s attempts=%d revisions=%d", state, attempts, revisions)
			}
			if !worked || (deliveryErr != nil) != scenario.beforeCommit {
				t.Fatalf("worked=%v err=%v", worked, deliveryErr)
			}
			if scenario.beforeCommit {
				if worked, err := deliverWikiAttempt(t, fixture.pool, fixture.dispatcher, fixture.admission.ID); err != nil || !worked {
					t.Fatalf("retry worked=%v err=%v", worked, err)
				}
				if err := fixture.pool.QueryRow(fixture.ctx, `SELECT count(*) FROM personal_wikis
					WHERE id='wiki_document_a' AND current_revision_id IS NOT NULL`).Scan(&revisions); err != nil || revisions != 1 {
					t.Fatalf("retry revisions=%d err=%v", revisions, err)
				}
			}
			// An uncommitted publication generates again; a committed one never does.
			wantCalls := 1
			if scenario.beforeCommit {
				wantCalls = 2
			}
			if len(generator.callsSnapshot()) != wantCalls {
				t.Fatalf("generator called %d times", len(generator.callsSnapshot()))
			}
		})
	}
}
