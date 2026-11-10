package documents_test

import (
	"context"
	"testing"
	"time"

	documentfixture "github.com/simplexai-labs/linger/apps/teamhub/tests/integration/documents/fixture"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

func TestUnifiedDocumentCollaborationCredentialCarriesThePermissionCount(t *testing.T) {
	ctx := context.Background()
	db, pool := newUnifiedDocumentDatabase(t, documentfixture.IdentitySQL)
	if _, err := db.ExecContext(ctx, `
		INSERT INTO document_bodies(document_id,seq,state,state_vector,asset_ids,thread_ids,last_editor_ids) SELECT draft.document_id,draft.persisted_seq::bigint,revision.state_bytes,draft.state_vector::bytea,ARRAY(SELECT asset->>'asset_id' FROM jsonb_array_elements(revision.asset_manifest) asset ORDER BY 1),revision.thread_manifest,ARRAY[draft.last_content_actor_id]::text[] FROM (VALUES (
			'document_human_a','tenant_document_a',0,'\x00',repeat('c',64),
			'revision_human_a','actor_human_a'
		)) AS draft(document_id,tenant_id,persisted_seq,state_vector,full_state_fingerprint,current_revision_id,last_content_actor_id) JOIN document_revisions revision ON revision.id=draft.current_revision_id;
		INSERT INTO document_assets(
			id,tenant_id,document_id,filename,media_type,sha256,size_bytes,content_object_id,status
		) VALUES(
			'document_asset_available','tenant_document_a','document_human_a','asset.txt','text/plain',
			repeat('f',64),4,'document_asset_object_available','available'
		)
	`); err != nil {
		t.Fatal(err)
	}
	service := document.New(pool)
	credential, err := service.IssueCollaborationCredential(ctx, document.IssueCollaborationCredentialInput{
		AccountID: "account_document_a", DocumentID: "document_human_a",
		ExpiresAt: time.Now().Add(time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	claims := documentfixture.ConnectionTokenClaims(t, credential.CollaborationCredential)
	if credential.DocumentID != "document_human_a" || claims.DocumentID != "document_human_a" ||
		claims.ActorID != "actor_human_a" || claims.Mode != "write" || claims.PermissionCount != 0 ||
		claims.SessionID == "" || claims.ExpiresAtMillis != credential.ExpiresAt.UnixMilli() {
		t.Fatalf("unexpected collaboration credential: %+v claims=%+v", credential, claims)
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO rooms(id,tenant_id,name,created_by_actor_id)
		VALUES('room_collaboration_cached_access','tenant_document_a','Cached access','actor_agent_a');
		INSERT INTO room_members(room_id,tenant_id,actor_id,role,added_by_actor_id)
		VALUES('room_collaboration_cached_access','tenant_document_a','actor_human_a','member','actor_agent_a');
		INSERT INTO documents(
			id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,
			creator_actor_kind,status
		) VALUES(
			'document_cached_room_access','tenant_document_a','Cached Room access','blocknote',
			'actor_agent_a','agent','actor_agent_a','agent','active'
		);
		INSERT INTO document_revisions(
			id,tenant_id,document_id,persisted_seq,state_vector,full_state_fingerprint,
			state_bytes,state_bytes_sha256,asset_manifest,created_by_actor_id
		) VALUES(
			'revision_cached_room_access','tenant_document_a','document_cached_room_access',0,
			'\x00',repeat('9',64),'\x00',repeat('9',64),'[]'::jsonb,'actor_agent_a'
		);
		INSERT INTO document_bodies(document_id,seq,state,state_vector,asset_ids,thread_ids,last_editor_ids) SELECT draft.document_id,draft.persisted_seq::bigint,revision.state_bytes,draft.state_vector::bytea,ARRAY(SELECT asset->>'asset_id' FROM jsonb_array_elements(revision.asset_manifest) asset ORDER BY 1),revision.thread_manifest,ARRAY[draft.last_content_actor_id]::text[] FROM (VALUES (
			'document_cached_room_access','tenant_document_a',0,'\x00',repeat('9',64),
			'revision_cached_room_access','actor_agent_a'
		)) AS draft(document_id,tenant_id,persisted_seq,state_vector,full_state_fingerprint,current_revision_id,last_content_actor_id) JOIN document_revisions revision ON revision.id=draft.current_revision_id;
		INSERT INTO document_context_bindings(
			id,tenant_id,document_id,binding_kind,room_id,status
		) VALUES(
			'binding_cached_room_access','tenant_document_a','document_cached_room_access','room',
			'room_collaboration_cached_access','active'
		);
		DELETE FROM room_members
		WHERE room_id='room_collaboration_cached_access' AND actor_id='actor_human_a'
	`); err != nil {
		t.Fatal(err)
	}
	if _, err := service.IssueCollaborationCredential(ctx, document.IssueCollaborationCredentialInput{
		AccountID: "account_document_a", DocumentID: "document_cached_room_access",
		ExpiresAt: time.Now().Add(time.Hour),
	}); err != nil {
		// The single Human reads every Document, so leaving the Room that
		// shared this one does not withhold its credential.
		t.Fatalf("removed Room member credential error=%v", err)
	}
	// A permission change increments the count, so the Runtime refuses the
	// token signed before it. The Asset the race retired is available again,
	// so the current Revision opens.
	if _, err := db.ExecContext(ctx, `UPDATE document_assets SET status='available',updated_at=clock_timestamp()
		WHERE id='document_asset_available'`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE document_permission_counts SET permission_count=permission_count+1 WHERE document_id='document_human_a'`); err != nil {
		t.Fatal(err)
	}
	var permissionCount int64
	if err := db.QueryRowContext(ctx, `SELECT permission_count FROM document_permission_counts WHERE document_id='document_human_a'`).Scan(&permissionCount); err != nil {
		t.Fatal(err)
	}
	if permissionCount == claims.PermissionCount {
		t.Fatalf("permission count %d did not move past the token's %d", permissionCount, claims.PermissionCount)
	}
}
