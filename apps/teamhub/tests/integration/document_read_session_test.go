package integration_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	documentfixture "github.com/simplexai-labs/linger/apps/teamhub/tests/integration/documents/fixture"
)

func TestDocumentReadSessionHydratesWithoutMutationAuthority(t *testing.T) {
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
	insertUnifiedDocumentContextFixture(t, ctx, db)
	if _, err := db.ExecContext(ctx, `
INSERT INTO documents(id,tenant_id,title,format,native_representation_format,owner_actor_id,owner_actor_kind,creator_actor_id,creator_actor_kind,status) VALUES('document_readonly_native','tenant_document_a','Readonly native','blocknote','markdown','actor_agent_a','agent','actor_agent_a','agent','active');
	INSERT INTO document_revisions(id,tenant_id,document_id,persisted_seq,state_vector,full_state_fingerprint,state_status,state_bytes,state_bytes_sha256,asset_manifest,created_by_actor_id) VALUES('revision_readonly_native','tenant_document_a','document_readonly_native',0,'\x00',repeat('c',64),'available','\x01','4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a','[]','actor_agent_a');
	INSERT INTO document_bodies(document_id,seq,state,state_vector,asset_ids,thread_ids,last_editor_ids) SELECT draft.document_id,draft.persisted_seq::bigint,revision.state_bytes,draft.state_vector::bytea,ARRAY(SELECT asset->>'asset_id' FROM jsonb_array_elements(revision.asset_manifest) asset ORDER BY 1),revision.thread_manifest,ARRAY[draft.last_content_actor_id]::text[] FROM (VALUES ('document_readonly_native','tenant_document_a',0,'\x00',repeat('c',64),'revision_readonly_native','actor_agent_a')) AS draft(document_id,tenant_id,persisted_seq,state_vector,full_state_fingerprint,current_revision_id,last_content_actor_id) JOIN document_revisions revision ON revision.id=draft.current_revision_id;
	INSERT INTO document_context_bindings(id,tenant_id,document_id,binding_kind,wiki_id,status,role) VALUES('binding_readonly_native','tenant_document_a','document_readonly_native','wiki_page','wiki_document_a','active','manager')`); err != nil {
		t.Fatal(err)
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	service := document.New(pool)
	// The single Human may change every Document except a published Wiki page,
	// which it only reads.
	value, err := service.Get(ctx, "account_document_a", "document_readonly_native")
	if err != nil || !value.Capabilities.Read || value.Capabilities.Write || value.DraftCapability != "read" {
		t.Fatalf("readonly native=%#v err=%v", value, err)
	}
	if _, err := service.IssueCollaborationCredential(ctx, document.IssueCollaborationCredentialInput{AccountID: "account_document_a", DocumentID: "document_readonly_native", ExpiresAt: time.Now().Add(time.Hour)}); !errors.Is(err, document.ErrNotFound) {
		t.Fatalf("write credential error=%v", err)
	}
	_, err = service.IssueReadCollaborationCredential(ctx, document.IssueCollaborationCredentialInput{AccountID: "account_document_a", DocumentID: "document_readonly_native", ExpiresAt: time.Now().Add(time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	combined, err := service.Open(ctx, document.IssueCollaborationCredentialInput{AccountID: "account_document_a", DocumentID: "document_readonly_native", ExpiresAt: time.Now().Add(time.Hour)})
	if err != nil || combined.Document.DraftCapability != "read" || combined.Credential == nil {
		t.Fatalf("combined read open capability=%s credential present=%t err=%v", combined.Document.DraftCapability, combined.Credential != nil, err)
	}
	// A read credential's token asks the Runtime for a read-only connection.
	claims := documentfixture.ConnectionTokenClaims(t, combined.Credential.CollaborationCredential)
	if claims.Mode != "read" || claims.ActorID != "actor_human_a" || claims.DocumentID != "document_readonly_native" {
		t.Fatalf("read token claims=%+v", claims)
	}
	var permissionCount int64
	if err := db.QueryRowContext(ctx, `SELECT permission_count FROM document_permission_counts WHERE document_id='document_readonly_native'`).Scan(&permissionCount); err != nil || permissionCount != claims.PermissionCount {
		t.Fatalf("permission count=%d token=%d err=%v", permissionCount, claims.PermissionCount, err)
	}
	var revisions, drafts int
	if err := db.QueryRowContext(ctx, `SELECT (SELECT count(*) FROM document_revisions WHERE document_id='document_readonly_native'),(SELECT count(*) FROM document_bodies WHERE document_id='document_readonly_native')`).Scan(&revisions, &drafts); err != nil {
		t.Fatal(err)
	}
	if revisions != 1 || drafts != 1 {
		t.Fatalf("mutation rows=%d/%d", revisions, drafts)
	}
}
