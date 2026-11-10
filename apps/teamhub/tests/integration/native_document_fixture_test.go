package integration_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

const nativeConcurrencyDocumentID = "document_native_concurrency"

func newNativeDocumentConcurrencyDatabase(t *testing.T) (context.Context, string) {
	t.Helper()
	ctx := context.Background()
	databaseURL := newIntegrationDatabase(t)
	config, err := pgx.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	db := stdlib.OpenDB(*config)
	t.Cleanup(func() { _ = db.Close() })
	insertUnifiedDocumentIdentityFixture(t, ctx, db)
	state := []byte("native concurrency state")
	stateHash := sha256.Sum256(state)
	if _, err := db.ExecContext(ctx, `INSERT INTO documents(
			id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,
			creator_actor_kind,status
		) VALUES($1,'tenant_document_a','Concurrent native Document','blocknote',
			'actor_human_a','human','actor_human_a','human','active')`, nativeConcurrencyDocumentID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO document_revisions(
			id,tenant_id,document_id,persisted_seq,state_vector,full_state_fingerprint,
			state_bytes,state_bytes_sha256,asset_manifest,thread_manifest,created_by_actor_id
		) VALUES(
			'revision_native_concurrency','tenant_document_a',$1,0,'\x00',$2,
			$3,$2,'[]'::jsonb,ARRAY[]::text[],'actor_human_a'
		)`, nativeConcurrencyDocumentID, hex.EncodeToString(stateHash[:]), state); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO document_bodies(document_id,seq,state,state_vector,asset_ids,thread_ids,last_editor_ids) SELECT draft.document_id,draft.persisted_seq::bigint,revision.state_bytes,draft.state_vector::bytea,ARRAY(SELECT asset->>'asset_id' FROM jsonb_array_elements(revision.asset_manifest) asset ORDER BY 1),revision.thread_manifest,ARRAY[draft.last_content_actor_id]::text[] FROM (VALUES ($1,'tenant_document_a',0,'\x00',$2,
			'revision_native_concurrency','actor_human_a')) AS draft(document_id,tenant_id,persisted_seq,state_vector,full_state_fingerprint,current_revision_id,last_content_actor_id) JOIN document_revisions revision ON revision.id=draft.current_revision_id`,
		nativeConcurrencyDocumentID, hex.EncodeToString(stateHash[:])); err != nil {
		t.Fatal(err)
	}
	return ctx, databaseURL
}
