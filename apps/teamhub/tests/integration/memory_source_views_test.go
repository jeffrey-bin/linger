package integration_test

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
)

// Memory reads TeamHub only through memory_source, so these views
// own the subject definition, Room membership and recorder-only rules.
func TestMemorySourceViewsCarryMemoryAuthorization(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	databaseURL := newIntegrationDatabaseWithoutSkills(t)
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
	if _, err = pool.Exec(ctx, `
		INSERT INTO accounts(id,email,password_hash) VALUES('account_memory_c','memory-c@example.com','x');
		INSERT INTO actors(id,tenant_id,kind,display_name,account_id,handle) VALUES
			('actor_me_a','tenant_document_a','agent','Another Me A',NULL,'memory-me-a'),
			('actor_human_c','tenant_document_a','human','Human C','account_memory_c',NULL),
			('actor_me_c','tenant_document_a','agent','Another Me C',NULL,'memory-me-c');
		INSERT INTO agent_registrations(
			actor_id,tenant_id,agent_management_id,status,instructions,runtime_model,
			created_by_actor_id,agent_type,represented_human_actor_id,
			computer_id,local_runtime_type,workspace_grant_id
		) VALUES
			('actor_me_a','tenant_document_a','management_me_a','active','Remember A.','test-model','actor_human_a','anotherme','actor_human_a','computer_fixture','codex','grant_files'),
			('actor_me_c','tenant_document_a','management_me_c','revoked','Remember C.','test-model','actor_human_c','anotherme','actor_human_c','computer_fixture','codex','grant_files');
		INSERT INTO rooms(id,tenant_id,name,created_by_actor_id) VALUES
			('room_memory_a','tenant_document_a','Memory A','actor_human_a'),
			('room_memory_agent','tenant_document_a','Memory Agent','actor_human_c'),
			('room_memory_other','tenant_document_a','Memory Other','actor_human_c'),
			('room_memory_deleted','tenant_document_a','Memory Deleted','actor_human_a');
		INSERT INTO room_members(room_id,tenant_id,actor_id,role,added_by_actor_id) VALUES
			('room_memory_a','tenant_document_a','actor_human_a','owner','actor_human_a'),
			('room_memory_agent','tenant_document_a','actor_human_c','owner','actor_human_c'),
			('room_memory_agent','tenant_document_a','actor_me_a','member','actor_human_c'),
			('room_memory_other','tenant_document_a','actor_human_c','owner','actor_human_c'),
			('room_memory_deleted','tenant_document_a','actor_human_a','owner','actor_human_a');
		UPDATE rooms SET deletion_started_at=now(),deletion_started_by_actor_id='actor_human_a',
			deleted_at=now(),deleted_by_actor_id='actor_human_a'
		WHERE id='room_memory_deleted';
		INSERT INTO messages(id,tenant_id,room_id,author_actor_id,body,segments) VALUES
			('message_memory_a','tenant_document_a','room_memory_a','actor_human_a','Hello',
			 '[{"type":"text","text":"Hello"}]');
		INSERT INTO documents(
			id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,creator_actor_kind,status
		) SELECT id,'tenant_document_a',id,'markdown',owner,'human',owner,'human','active'
		FROM (VALUES('document_memory_audio_a','actor_human_a'),('document_memory_transcript_a','actor_human_a'),
			('document_memory_audio_c','actor_human_c'),('document_memory_transcript_c','actor_human_c'),
			('document_memory_page','actor_human_a')) document(id,owner);
		INSERT INTO document_versions(
			id,tenant_id,document_id,version_number,filename,representation_format,media_type,
			size_bytes,sha256,content_object_id,source,created_by_actor_id
		) SELECT 'version_' || id,'tenant_document_a',id,1,'source.md','markdown','text/markdown',
			1,repeat('a',64),'object_' || id,'ordinary_upload','actor_human_a'
		FROM (VALUES('document_memory_audio_a'),('document_memory_transcript_a'),('document_memory_audio_c'),
			('document_memory_transcript_c'),('document_memory_page')) document(id);
		UPDATE documents SET current_version_id='version_document_memory_page' WHERE id='document_memory_page';
		INSERT INTO document_bodies(document_id,seq,state,state_vector,asset_ids,thread_ids,last_editor_ids) SELECT draft.document_id,draft.persisted_seq::bigint,revision.state_bytes,draft.state_vector::bytea,ARRAY(SELECT asset->>'asset_id' FROM jsonb_array_elements(revision.asset_manifest) asset ORDER BY 1),revision.thread_manifest,ARRAY[draft.last_content_actor_id]::text[] FROM (VALUES ('document_human_a','tenant_document_a',0,'\x00',repeat('c',64),'revision_human_a','actor_human_a')) AS draft(document_id,tenant_id,persisted_seq,state_vector,full_state_fingerprint,current_revision_id,last_content_actor_id) JOIN document_revisions revision ON revision.id=draft.current_revision_id;
		INSERT INTO document_texts(document_id,tenant_id,source_kind,source_id,status,markdown,markdown_sha256,search_text)
		VALUES('document_human_a','tenant_document_a','native_body','0','ready','# Native',repeat('b',64),'Native'),
			('document_memory_page','tenant_document_a','file_version','version_document_memory_page','ready','# Page',repeat('d',64),'Page')
		ON CONFLICT (document_id) DO UPDATE SET source_kind=EXCLUDED.source_kind,source_id=EXCLUDED.source_id,
			status=EXCLUDED.status,markdown=EXCLUDED.markdown,markdown_sha256=EXCLUDED.markdown_sha256,
			search_text=EXCLUDED.search_text;
		INSERT INTO document_placements(id,tenant_id,scope_kind,owner_human_actor_id,parent_id,node_kind,name,document_id,sort_key) VALUES
			('placement_memory_folder','tenant_document_a','personal','actor_human_a',NULL,'folder','Notes',NULL,'a'),
			('placement_memory_page','tenant_document_a','personal','actor_human_a','placement_memory_folder','document',NULL,'document_memory_page','b'),
			('placement_memory_native','tenant_document_a','personal','actor_human_a','placement_memory_folder','document',NULL,'document_human_a','c');
		INSERT INTO voice_sessions(
			id,tenant_id,room_id,created_by_actor_id,status,purpose,provider_room_name,
			participant_identity,closed_at
		) VALUES
			('voice_memory_a','tenant_document_a','room_memory_a','actor_human_a','closed','hardware_control','memory-a','memory-a',now()),
			('voice_memory_c','tenant_document_a','room_memory_agent','actor_human_c','closed','hardware_control','memory-c','memory-c',now());
		INSERT INTO capture_sessions(
			id,tenant_id,room_id,created_by_actor_id,status,voice_session_id,
			document_id,document_version_id,transcript_document_id,transcript_document_version_id,
			transcript_start_offset_ms,transcript_end_offset_ms,requested_transcript_start_offset_ms
		) VALUES
			('capture_memory_a','tenant_document_a','room_memory_a','actor_human_a','finalized','voice_memory_a',
			 'document_memory_audio_a','version_document_memory_audio_a','document_memory_transcript_a','version_document_memory_transcript_a',0,1000,0),
			('capture_memory_c','tenant_document_a','room_memory_agent','actor_human_c','finalized','voice_memory_c',
			 'document_memory_audio_c','version_document_memory_audio_c','document_memory_transcript_c','version_document_memory_transcript_c',0,1000,0);
		INSERT INTO voice_capture_questions(id,capture_session_id,kind,question,answer,answered,cutoff_offset_ms,sources,task_title) VALUES
			('question_memory_a','capture_memory_a','task','A only','',false,1000,'[]','Draft A'),
			('question_memory_c','capture_memory_c','answer','C only','C answer',true,1000,'[]','');
		INSERT INTO pocket_notes(tenant_id,owner_actor_id,note_date,body,hidden_at) VALUES
			('tenant_document_a','actor_human_a','2026-09-15','Pocket A',NULL),
			('tenant_document_a','actor_human_a','2026-09-14','Deleted pocket',now());
		UPDATE capture_sessions SET hidden_at=now() WHERE id='capture_memory_c';
	`); err != nil {
		t.Fatal(err)
	}

	// Only the active Another Me is a subject; a revoked one is not.
	assertMemorySourceRows(t, pool, `
		SELECT agent_management_id,human_is_tenant_member
		FROM memory_source.another_me_subjects WHERE tenant_id='tenant_document_a'`,
		[][]any{{"management_me_a", true}})
	// Membership of the Human or its Another Me admits a Room; deletion removes it.
	assertMemorySourceRows(t, pool, `
		SELECT room_id,agent_is_member,represented_human_is_member FROM memory_source.subject_rooms
		WHERE agent_management_id='management_me_a' ORDER BY room_id`,
		[][]any{{"room_memory_a", false, true}, {"room_memory_agent", true, false}})
	assertMemorySourceRows(t, pool, `
		SELECT id,author_display_name,author_kind FROM memory_source.conversation_messages
		WHERE room_id='room_memory_a'`,
		[][]any{{"message_memory_a", "Human A", "human"}})
	// Private questions and task requests reach only the recorder's own Another Me.
	assertMemorySourceRows(t, pool, `
		SELECT capture_id,private_questions IS NOT NULL,private_changed_at IS NOT NULL
		FROM memory_source.subject_recordings WHERE agent_management_id='management_me_a' ORDER BY capture_id`,
		[][]any{{"capture_memory_a", true, true}, {"capture_memory_c", false, false}})
	assertMemorySourceRows(t, pool, `
		SELECT private_questions->0->>'kind',private_questions->0->>'task_sent'
		FROM memory_source.subject_recordings WHERE agent_management_id='management_me_a' AND capture_id='capture_memory_a'`,
		[][]any{{"task", "false"}})
	assertMemorySourceRows(t, pool, `
		SELECT id FROM memory_source.finalized_meetings
		WHERE tenant_id='tenant_document_a'
		  AND memory_source.human_can_read_document('actor_human_a',tenant_id,recording_document_id)
		  AND memory_source.human_can_read_document('actor_human_a',tenant_id,transcript_document_id)
		ORDER BY id`,
		[][]any{{"capture_memory_a"}, {"capture_memory_c"}})
	assertMemorySourceRows(t, pool, `
		SELECT memory_source.human_can_read_document('actor_me_a','tenant_document_a','document_memory_page')`,
		[][]any{{false}})
	// Every page is read through its normalized text: a native page by its
	// body sequence, a file by its Version.
	assertMemorySourceRows(t, pool, `
		SELECT folder_path,origin_kind,document_id,text_source_kind,text_source_id,filename,markdown_sha256
		FROM memory_source.personal_documents('tenant_document_a','actor_human_a')`,
		[][]any{
			{"Notes", "my_pages", "document_human_a", "native_body", "0", "Human document", strings.Repeat("b", 64)},
			{"Notes", "my_pages", "document_memory_page", "file_version", "version_document_memory_page", "source.md", strings.Repeat("d", 64)},
		})
	assertMemorySourceRows(t, pool, `
		SELECT document_id,markdown
		FROM memory_source.personal_document_markdown('tenant_document_a','actor_human_a',
			ARRAY['document_memory_page','document_unknown'])`,
		[][]any{{"document_memory_page", "# Page"}})
	// A deleted Pocket Note day reads as missing.
	assertMemorySourceRows(t, pool, `
		SELECT body FROM memory_source.pocket_notes WHERE owner_actor_id='actor_human_a'`,
		[][]any{{"Pocket A"}})
	// A hidden meeting is hidden for the Space's Human.
	assertMemorySourceRows(t, pool, `
		SELECT capture_session_id FROM memory_source.hidden_meetings
		WHERE tenant_id='tenant_document_a'`,
		[][]any{{"capture_memory_c"}})

	// Proactive learning reads an output with the reply after it, records a
	// guideline and clears what it consumed.
	if _, err = pool.Exec(ctx, `
		INSERT INTO messages(id,tenant_id,room_id,author_actor_id,body,segments,created_at)
			VALUES('message_memory_reply','tenant_document_a','room_memory_a','actor_human_a','Thanks',
			'[{"type":"text","text":"Thanks"}]',now()+interval '1 second');
		INSERT INTO proactive_outputs(message_id,tenant_id,owner_actor_id,room_id,source,local_run_id)
			VALUES('message_memory_a','tenant_document_a','actor_human_a','room_memory_a','event','run_memory_a');
		INSERT INTO proactive_potential_items(id,tenant_id,owner_actor_id,content,source,source_key,reminded) VALUES
			('ppi_00000000000000000000000000000001','tenant_document_a','actor_human_a','Reply to Bob','tracking_item','item-a',false),
			('ppi_00000000000000000000000000000002','tenant_document_a','actor_human_a','Meeting at 3','event','calendar-a',true);
		SELECT memory_source.record_proactive_guideline('tenant_document_a','actor_human_a',2,'[]','[]','note');
	`); err != nil {
		t.Fatal(err)
	}
	assertMemorySourceRows(t, pool, `
		SELECT message_id,source,output_body,position,author,body
		FROM memory_source.proactive_exchanges('tenant_document_a','actor_human_a',now()+interval '1 hour')`,
		[][]any{{"message_memory_a", "event", "Hello", int32(1), "Human A", "Thanks"}})
	assertMemorySourceRows(t, pool, `
		SELECT version FROM memory_source.proactive_guidelines WHERE owner_actor_id='actor_human_a'`,
		[][]any{{int32(2)}})
	if _, err = pool.Exec(ctx, `
		SELECT memory_source.clear_proactive_learning('tenant_document_a','actor_human_a',now()+interval '1 hour')`); err != nil {
		t.Fatal(err)
	}
	assertMemorySourceRows(t, pool, `SELECT count(*) FROM proactive_outputs`, [][]any{{int64(0)}})
	// Every potential-list source is consumed, including the events TeamHub
	// judges itself.
	assertMemorySourceRows(t, pool, `SELECT count(*) FROM proactive_potential_items`, [][]any{{int64(0)}})
}

func assertMemorySourceRows(t *testing.T, pool *pgxpool.Pool, query string, want [][]any) {
	t.Helper()
	rows, err := pool.Query(context.Background(), query)
	if err != nil {
		t.Fatal(err)
	}
	got, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) ([]any, error) { return row.Values() })
	if err != nil {
		t.Fatal(err)
	}
	if len(got) == 0 {
		got = [][]any{}
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%s\n got=%v\nwant=%v", query, got, want)
	}
}
