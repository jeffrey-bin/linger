package integration_test

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

func TestDocumentHistoryPairsRevisionsByPersistedSequence(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	databaseURL := newIntegrationDatabase(t)
	config, err := pgx.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	db := stdlib.OpenDB(*config)
	t.Cleanup(func() { _ = db.Close() })
	insertUnifiedDocumentIdentityFixture(t, ctx, db)
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(ctx, `
		INSERT INTO document_revisions(
			id,tenant_id,document_id,persisted_seq,state_vector,full_state_fingerprint,
			state_bytes,state_bytes_sha256,asset_manifest,created_by_actor_id,
			history_trigger,history_contributor_ids,history_recorded_at
		) VALUES
			('revision_history_order_1','tenant_document_a','document_human_a',1,'\x01',repeat('d',64),
			 '\x01',repeat('1',64),'[]'::jsonb,'actor_human_a',
			 'manual',ARRAY['actor_human_a'],clock_timestamp()),
			('revision_history_order_2','tenant_document_a','document_human_a',2,'\x02',repeat('e',64),
			 '\x02',repeat('2',64),'[]'::jsonb,'actor_human_a',
			 'manual',ARRAY['actor_human_a'],clock_timestamp()-interval '1 hour');
		UPDATE document_revisions SET history_trigger='manual',history_contributor_ids=ARRAY['actor_human_a'],
			history_recorded_at=clock_timestamp()-interval '2 hours'
		WHERE id='revision_human_a'
	`); err != nil {
		t.Fatal(err)
	}
	service := document.New(pool)
	first, err := service.ListHistory(ctx, document.ListHistoryInput{
		AccountID: "account_document_a", DocumentID: "document_human_a", Limit: 2,
	})
	if err != nil || len(first.Items) != 2 || first.Items[0].PersistedSeq != 2 || first.Items[1].PersistedSeq != 1 ||
		!first.HasMore || first.NextCursor == "" {
		t.Fatalf("History first page=%#v error=%v want sequences [2 1] and cursor", first, err)
	}
	second, err := service.ListHistory(ctx, document.ListHistoryInput{
		AccountID: "account_document_a", DocumentID: "document_human_a", Cursor: first.NextCursor, Limit: 2,
	})
	if err != nil || len(second.Items) != 1 || second.Items[0].PersistedSeq != 0 {
		t.Fatalf("History second page=%#v error=%v want sequence [0]", second, err)
	}
}
