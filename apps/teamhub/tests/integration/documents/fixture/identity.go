package fixture

import (
	"context"
	"database/sql"
	"strings"
	"testing"
)

const IdentitySQL = `
		INSERT INTO accounts(id,email,password_hash) VALUES('account_document_a','document-a@example.com','x');
		INSERT INTO actors(id,tenant_id,kind,display_name,account_id,handle) VALUES
			('actor_human_a','tenant_document_a','human','Human A','account_document_a',NULL),
			('actor_agent_a','tenant_document_a','agent','Agent A',NULL,'agent-document-a');
		INSERT INTO agent_registrations(
			actor_id,tenant_id,agent_management_id,status,instructions,runtime_model,created_by_actor_id,
			computer_id,local_runtime_type,workspace_grant_id
		) VALUES(
			'actor_agent_a','tenant_document_a','agent_document_a','active',
			'Document integration Agent.','test-model','actor_human_a',
			'computer_fixture','codex','grant_files'
		);
		INSERT INTO documents(
			id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,
			creator_actor_kind,status
		) VALUES(
			'document_human_a','tenant_document_a','Human document','blocknote',
			'actor_human_a','human','actor_human_a','human','active'
		);
		INSERT INTO document_revisions(
			id,tenant_id,document_id,persisted_seq,state_vector,full_state_fingerprint,
			state_bytes,state_bytes_sha256,asset_manifest,created_by_actor_id
		) VALUES(
			'revision_human_a','tenant_document_a','document_human_a',0,'\x00',repeat('c',64),
			'\x00','6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d',
			'[]'::jsonb,'actor_human_a'
		);
`

// InsertIdentity seeds the current schema or a historical one in a migration
// test. Before the personal cloud retirement, a registration also named its
// placement type; before email became the only login identifier, an Account
// also required a username.
func InsertIdentity(t *testing.T, ctx context.Context, db *sql.DB) {
	t.Helper()
	var historical, usernameAccounts bool
	if err := db.QueryRowContext(ctx, `SELECT
		EXISTS (SELECT 1 FROM information_schema.columns
			WHERE table_schema='public' AND table_name='agent_registrations' AND column_name='placement_type'),
		EXISTS (SELECT 1 FROM information_schema.columns
			WHERE table_schema='public' AND table_name='accounts' AND column_name='username')`).Scan(&historical, &usernameAccounts); err != nil {
		t.Fatal(err)
	}
	identity := IdentitySQL
	if usernameAccounts {
		identity = strings.Replace(identity, "INSERT INTO accounts(id,email,", "INSERT INTO accounts(id,username,email,", 1)
		identity = strings.Replace(identity, "('account_document_a',", "('account_document_a','document-a',", 1)
		if strings.Count(identity, "'document-a',") != 1 {
			t.Fatal("historical identity fixture lost its usernames")
		}
	}
	if historical {
		identity = strings.Replace(identity, "created_by_actor_id,\n\t\t\tcomputer_id", "created_by_actor_id,\n\t\t\tplacement_type,computer_id", 1)
		identity = strings.Replace(identity, "'actor_human_a',\n\t\t\t'computer_fixture'", "'actor_human_a',\n\t\t\t'local','computer_fixture'", 1)
		if strings.Count(identity, "placement_type") != 1 || strings.Count(identity, "'local'") != 1 {
			t.Fatal("historical identity fixture lost its placement type")
		}
	}
	if _, err := db.ExecContext(ctx, identity); err != nil {
		t.Fatal(err)
	}
}

const ContextSQL = `
		INSERT INTO rooms(id,tenant_id,name,created_by_actor_id) VALUES
			('room_document_a','tenant_document_a','Room A','actor_human_a');
		INSERT INTO work_items(
			id,tenant_id,number,kind,title,created_by_actor_id,updated_by_actor_id
		) VALUES(
			'work_item_document_a','tenant_document_a',101,'issue','Document Work Item',
			'actor_human_a','actor_human_a'
		);
		INSERT INTO personal_wikis(id,tenant_id,owner_actor_id)
		VALUES('wiki_document_a','tenant_document_a','actor_human_a');
`

func InsertContext(t *testing.T, ctx context.Context, db *sql.DB) {
	t.Helper()
	if _, err := db.ExecContext(ctx, ContextSQL); err != nil {
		t.Fatal(err)
	}
}

func InsertOrdinaryVersion(t *testing.T, ctx context.Context, db *sql.DB, id string, versionNumber int) {
	t.Helper()
	if _, err := db.ExecContext(ctx, `
		INSERT INTO document_versions(
			id,tenant_id,document_id,version_number,filename,representation_format,media_type,
			size_bytes,sha256,content_object_id,source,created_by_actor_id
		) VALUES($1,'tenant_document_a','document_human_a',$2,'upload.txt','plain_text','text/plain',
			1,repeat('a',64),$1 || '_object','ordinary_upload','actor_human_a')
	`, id, versionNumber); err != nil {
		t.Fatal(err)
	}
}
