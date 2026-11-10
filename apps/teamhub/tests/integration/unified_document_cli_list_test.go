package integration_test

import (
	"context"
	"database/sql"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

// An Agent reads, writes and manages every Document of its Space's Human;
// a share only asks it to look, so the Agent is told and lists the Document
// as shared with it.
func TestAgentListsEveryDocumentAndSeesWhatWasSharedWithIt(t *testing.T) {
	allowParallelIntegrationTest(t)
	ctx := context.Background()
	db, pool, objects := newUnifiedDocumentSemanticMutationFixture(t)
	service := document.NewWithObjectStore(pool, objects)
	linkUnifiedDocumentTaskOriginRoom(t, ctx, db)
	if _, err := db.ExecContext(ctx, `
INSERT INTO documents(
  id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,
  creator_actor_kind,status
) VALUES
  ('document_library_personal','tenant_document_a','Personal candidate','markdown',
   'actor_human_a','human','actor_human_a','human','active'),
  ('document_library_other','tenant_document_a','Other candidate','markdown',
   'actor_human_a','human','actor_human_a','human','active');
INSERT INTO document_versions(
  id,tenant_id,document_id,version_number,filename,representation_format,media_type,
  size_bytes,sha256,content_object_id,source,created_by_actor_id
) VALUES
  ('version_library_personal','tenant_document_a','document_library_personal',1,
   'personal.md','markdown','text/markdown',1,repeat('a',64),'object_library_personal',
   'ordinary_upload','actor_human_a'),
  ('version_library_other','tenant_document_a','document_library_other',1,
   'other.md','markdown','text/markdown',1,repeat('b',64),'object_library_other',
   'ordinary_upload','actor_human_a');
UPDATE documents SET current_version_id=CASE id
  WHEN 'document_library_personal' THEN 'version_library_personal'
  WHEN 'document_library_other' THEN 'version_library_other' END
WHERE id IN ('document_library_personal','document_library_other');
INSERT INTO rooms(id,tenant_id,name,created_by_actor_id,direct_human_actor_id,direct_agent_actor_id)
 VALUES('room_document_direct','tenant_document_a','Agent A','actor_human_a','actor_human_a','actor_agent_a');
INSERT INTO room_members(room_id,tenant_id,actor_id,role,added_by_actor_id) VALUES
 ('room_document_direct','tenant_document_a','actor_human_a','owner','actor_human_a'),
 ('room_document_direct','tenant_document_a','actor_agent_a','member','actor_human_a');
INSERT INTO agent_execution_contexts(
  context_key,tenant_id,agent_actor_id,agent_management_id,context_kind,
  room_id,room_kind,membership_epoch_id,target_residency)
SELECT '["meta","agent_document_a","room","room_document_direct"]','tenant_document_a',
  member.actor_id,'agent_document_a','meta',member.room_id,'direct',member.membership_epoch_id,'suspended'
FROM room_members member
WHERE member.room_id='room_document_direct' AND member.actor_id='actor_agent_a'`); err != nil {
		t.Fatal(err)
	}
	find := func(files []document.AgentFileEntry, id string) (document.AgentFileEntry, bool) {
		for _, file := range files {
			if file.DocumentID == id {
				return file, true
			}
		}
		return document.AgentFileEntry{}, false
	}

	files, err := service.ListAgentFiles(ctx, "tenant_document_a", "agent_document_a", "", 100, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"document_library_personal", "document_library_other"} {
		if file, found := find(files, id); !found || file.Role != "owner" || !file.Editable || file.SharedWithMe {
			t.Fatalf("%s=%+v found=%t", id, file, found)
		}
	}
	shared, err := service.ListAgentFiles(ctx, "tenant_document_a", "agent_document_a", "", 100, true)
	if err != nil || len(shared) != 0 {
		t.Fatalf("shared before any share=%+v err=%v", shared, err)
	}

	if _, err := service.CreateDirectCollaborator(ctx, document.CreateDirectCollaboratorInput{
		AccountID: "account_document_a", DocumentID: "document_library_personal",
		TargetActorID: "actor_agent_a", Role: "viewer",
	}); err != nil {
		t.Fatal(err)
	}
	shared, err = service.ListAgentFiles(ctx, "tenant_document_a", "agent_document_a", "", 100, true)
	if err != nil || len(shared) != 1 || shared[0].DocumentID != "document_library_personal" ||
		!shared[0].SharedWithMe || shared[0].Role != "owner" || !shared[0].Editable {
		t.Fatalf("shared after share=%+v err=%v", shared, err)
	}
	var kind, body string
	var mentioned bool
	if err := db.QueryRowContext(ctx, `SELECT message_kind,body,'actor_agent_a'=ANY(mentioned_actor_ids)
		FROM messages WHERE room_id='room_document_direct' ORDER BY created_at DESC LIMIT 1`).
		Scan(&kind, &body, &mentioned); err != nil {
		t.Fatal(err)
	}
	if kind != "agent_runtime" || !mentioned || !strings.Contains(body, "document_library_personal") {
		t.Fatalf("share notice kind=%s mentioned=%t body=%q", kind, mentioned, body)
	}
	var queued int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM agent_runtime_inputs input
		JOIN messages message ON message.id=input.source_message_id
		WHERE message.room_id='room_document_direct' AND message.message_kind='agent_runtime'`).Scan(&queued); err != nil {
		t.Fatal(err)
	}
	if queued != 1 {
		t.Fatalf("share notice queued %d Agent inputs, want 1", queued)
	}
}

func linkUnifiedDocumentTaskOriginRoom(t *testing.T, ctx context.Context, db *sql.DB) {
	t.Helper()
	if _, err := db.ExecContext(ctx, `
INSERT INTO rooms(id,tenant_id,name,created_by_actor_id)
 VALUES('room_document_task_origin','tenant_document_a','Task origin','actor_human_a');
INSERT INTO room_members(room_id,tenant_id,actor_id,role,added_by_actor_id) VALUES
 ('room_document_task_origin','tenant_document_a','actor_human_a','owner','actor_human_a'),
 ('room_document_task_origin','tenant_document_a','actor_agent_a','member','actor_human_a');
INSERT INTO work_item_room_links(work_item_id,tenant_id,link_type,room_id,linked_by_actor_id)
 VALUES('work_item_document_a','tenant_document_a','origin','room_document_task_origin','actor_human_a')`); err != nil {
		t.Fatal(err)
	}
}
