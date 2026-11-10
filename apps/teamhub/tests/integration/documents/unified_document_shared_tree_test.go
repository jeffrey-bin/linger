package documents_test

import (
	"context"
	"errors"
	"testing"

	documentfixture "github.com/simplexai-labs/linger/apps/teamhub/tests/integration/documents/fixture"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

// The Shared tree lists the Agent-owned Documents the Human reads through a
// Context; the Human's own Documents never appear there.
func TestUnifiedDocumentSharedTreeIsActorPrivateAndAccessFiltered(t *testing.T) {
	ctx := context.Background()
	db, pool := newUnifiedDocumentDatabase(t, documentfixture.IdentitySQL)
	documentfixture.InsertContext(t, ctx, db)
	if _, err := db.ExecContext(ctx, `
		-- The fixture Document is Human-owned; the guard forbids changing an
		-- owner, so the test lifts it only to hand the row to the Agent.
		ALTER TABLE documents DISABLE TRIGGER document_identity_guard;
		UPDATE documents SET owner_actor_id='actor_agent_a',owner_actor_kind='agent',
			creator_actor_id='actor_agent_a',creator_actor_kind='agent'
		WHERE id='document_human_a';
		ALTER TABLE documents ENABLE TRIGGER document_identity_guard;
		INSERT INTO room_members(room_id,tenant_id,actor_id,role,added_by_actor_id)
		VALUES('room_document_a','tenant_document_a','actor_human_a','owner','actor_human_a');
		INSERT INTO documents(
			id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,
			creator_actor_kind,status
		) VALUES(
			'document_wiki_page_a','tenant_document_a','Wiki page','blocknote',
			'actor_agent_a','agent','actor_agent_a','agent','active'
		);
		INSERT INTO document_revisions(
			id,tenant_id,document_id,persisted_seq,state_vector,full_state_fingerprint,
			state_bytes,state_bytes_sha256,asset_manifest,created_by_actor_id
		) VALUES(
			'revision_wiki_page_a','tenant_document_a','document_wiki_page_a',0,'\x00',repeat('d',64),
			'\x00','6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d',
			'[]'::jsonb,'actor_agent_a'
		);
		INSERT INTO document_bodies(document_id,seq,state,state_vector,asset_ids,thread_ids,last_editor_ids) SELECT draft.document_id,draft.persisted_seq::bigint,revision.state_bytes,draft.state_vector::bytea,ARRAY(SELECT asset->>'asset_id' FROM jsonb_array_elements(revision.asset_manifest) asset ORDER BY 1),revision.thread_manifest,ARRAY[draft.last_content_actor_id]::text[] FROM (VALUES (
			'document_wiki_page_a','tenant_document_a',0,'\x00',repeat('d',64),
			'revision_wiki_page_a','actor_agent_a','Wiki page'
		)) AS draft(document_id,tenant_id,persisted_seq,state_vector,full_state_fingerprint,current_revision_id,last_content_actor_id,title) JOIN document_revisions revision ON revision.id=draft.current_revision_id;
		INSERT INTO document_context_bindings(id,tenant_id,document_id,binding_kind,room_id,status)
		VALUES('binding_shared_tree','tenant_document_a','document_human_a','room','room_document_a','active')
	`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO document_context_bindings(id,tenant_id,document_id,binding_kind,wiki_id,status,role)
		VALUES('binding_wiki_page_shared_tree','tenant_document_a','document_wiki_page_a','wiki_page','wiki_document_a','active','manager')
	`); err != nil {
		t.Fatal(err)
	}
	service := document.New(pool)

	tree, err := service.GetSharedTree(ctx, "account_document_a", "tenant_document_a")
	if err != nil || len(tree) != 1 || tree[0].NodeKind != "document" || tree[0].DocumentID != "document_human_a" || tree[0].ParentID != nil ||
		tree[0].Document == nil || tree[0].Document.Title != "Human document" || !tree[0].Document.Capabilities.Read || !tree[0].Document.Capabilities.Write || !tree[0].Document.Capabilities.Manage || tree[0].Document.CanEditNativeContent {
		t.Fatalf("unorganized shared tree=%+v error=%v", tree, err)
	}
	sharedPage, err := service.List(ctx, document.ListInput{AccountID: "account_document_a", View: document.ViewShared, Limit: 100})
	if err != nil || len(sharedPage.Items) != 1 || sharedPage.Items[0].ID != "document_human_a" {
		t.Fatalf("shared Document list=%+v error=%v", sharedPage.Items, err)
	}
	wikiPage, err := service.Get(ctx, "account_document_a", "document_wiki_page_a")
	if err != nil || !wikiPage.Capabilities.Read || wikiPage.Capabilities.Write || wikiPage.Capabilities.Manage ||
		wikiPage.Capabilities.Delete || wikiPage.Capabilities.Duplicate || wikiPage.Capabilities.Export ||
		wikiPage.Capabilities.Comment || wikiPage.Capabilities.UseAsContext ||
		wikiPage.DraftCapability != "read" || wikiPage.CanEditNativeContent {
		t.Fatalf("Wiki page capabilities=%+v draft=%s native=%t error=%v",
			wikiPage.Capabilities, wikiPage.DraftCapability, wikiPage.CanEditNativeContent, err)
	}
	folder, err := service.CreateSharedFolder(ctx, document.SharedFolderInput{AccountID: "account_document_a", TenantID: "tenant_document_a", Name: "Projects"})
	if err != nil {
		t.Fatal(err)
	}
	child, err := service.CreateSharedFolder(ctx, document.SharedFolderInput{AccountID: "account_document_a", TenantID: "tenant_document_a", Name: "Child", ParentID: &folder.ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.UpdateSharedFolder(ctx, document.UpdateSharedFolderInput{AccountID: "account_document_a", TenantID: "tenant_document_a", FolderID: folder.ID, ParentID: &child.ID}); !errors.Is(err, document.ErrConflict) {
		t.Fatalf("indirect cycle error=%v", err)
	}
	if err := service.DeleteSharedFolder(ctx, document.DeleteSharedFolderInput{AccountID: "account_document_a", TenantID: "tenant_document_a", FolderID: folder.ID}); !errors.Is(err, document.ErrFolderNotEmpty) {
		t.Fatalf("nonempty folder delete error=%v", err)
	}
	child, err = service.UpdateSharedFolder(ctx, document.UpdateSharedFolderInput{AccountID: "account_document_a", TenantID: "tenant_document_a", FolderID: child.ID, Name: "Renamed child", MoveToRoot: true})
	if err != nil || child.Name != "Renamed child" || child.ParentID != nil {
		t.Fatalf("renamed child=%+v error=%v", child, err)
	}
	if err := service.DeleteSharedFolder(ctx, document.DeleteSharedFolderInput{AccountID: "account_document_a", TenantID: "tenant_document_a", FolderID: child.ID}); err != nil {
		t.Fatal(err)
	}
	mapping, err := service.MoveSharedDocument(ctx, document.MoveSharedDocumentInput{AccountID: "account_document_a", TenantID: "tenant_document_a", DocumentID: "document_human_a", ParentID: &folder.ID})
	if err != nil || mapping.ParentID == nil || *mapping.ParentID != folder.ID {
		t.Fatalf("mapping=%+v error=%v", mapping, err)
	}
	var ownerID string
	var placements, bindings int
	if err := db.QueryRowContext(ctx, `SELECT
		(SELECT owner_actor_id FROM documents WHERE id='document_human_a'),
		(SELECT count(*) FROM document_placements WHERE document_id='document_human_a' AND scope_kind='personal'),
		(SELECT count(*) FROM document_context_bindings WHERE document_id='document_human_a')
	`).Scan(&ownerID, &placements, &bindings); err != nil {
		t.Fatal(err)
	}
	if ownerID != "actor_agent_a" || placements != 0 || bindings != 1 {
		t.Fatalf("shared mapping changed authority owner=%s placements=%d bindings=%d", ownerID, placements, bindings)
	}
	tree, err = service.GetSharedTree(ctx, "account_document_a", "tenant_document_a")
	if err != nil || len(tree) != 2 || tree[1].ParentID == nil || *tree[1].ParentID != folder.ID {
		t.Fatalf("organized tree=%+v error=%v", tree, err)
	}

	// The single Human reads every Document, so suspending the Room binding
	// neither hides the Agent's Document nor drops its Shared placement.
	if _, err := db.ExecContext(ctx, `UPDATE document_context_bindings SET status='suspended',access_epoch=access_epoch+1 WHERE id='binding_shared_tree'`); err != nil {
		t.Fatal(err)
	}
	tree, err = service.GetSharedTree(ctx, "account_document_a", "tenant_document_a")
	if err != nil || len(tree) != 2 || tree[1].ParentID == nil || *tree[1].ParentID != folder.ID {
		t.Fatalf("suspended binding tree=%+v error=%v", tree, err)
	}
	var mappings int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM document_placements WHERE scope_kind='shared' AND owner_human_actor_id='actor_human_a' AND document_id='document_human_a'`).Scan(&mappings); err != nil {
		t.Fatal(err)
	}
	if mappings != 1 {
		t.Fatalf("retained mappings=%d", mappings)
	}
}
