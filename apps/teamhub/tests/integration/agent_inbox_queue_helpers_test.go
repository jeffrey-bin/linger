package integration_test

import (
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// createAgentMentionRequest writes a Message that mentions the official Agent
// through the message core, so it commits like a person's request.
func createAgentMentionRequest(t *testing.T, pool *pgxpool.Pool, roomID, authorID string) string {
	t.Helper()
	ctx := t.Context()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	q := store.New(tx)
	author, err := q.GetActor(ctx, store.GetActorParams{ID: authorID, TenantID: "tenant_acme"})
	if err != nil {
		t.Fatal(err)
	}
	content, err := messagecreation.Normalize([]messagecreation.Segment{
		{Type: "text", Content: "Please publish the site "},
		{Type: "reference", Content: "@Agent", Target: "actor_acme_official", TargetType: "agent"},
	})
	if err != nil {
		t.Fatal(err)
	}
	created, err := messagecreation.Create(ctx, q, messagecreation.Draft{
		TenantID: "tenant_acme", RoomID: roomID, Author: author, Content: content,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return created.Message.ID
}

// countRuntimeInputs counts the inputs any Context received from messageID.
func countRuntimeInputs(t *testing.T, pool *pgxpool.Pool, messageID string) int {
	t.Helper()
	var count int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM agent_runtime_inputs WHERE source_message_id=$1`, messageID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

// insertDirectInboxTask links a Task to the test Room with the official Agent
// as participant; bound links its Work Room, withoutCoordinator leaves the
// generation without a coordinator Context.
func insertDirectInboxTask(t *testing.T, env runtimeStateTestEnv, taskID string, bound bool, withoutCoordinator ...bool) {
	t.Helper()
	tx, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	_, err = tx.Exec(t.Context(), `INSERT INTO work_items(id,tenant_id,number,kind,title,created_by_actor_id,updated_by_actor_id,state,task_execution_generation,task_execution_status,task_execution_revision,task_desired_control,task_control_revision,task_control_settled_revision,task_execution_updated_at,task_next_reconcile_at,task_lease_generation) VALUES($1,'tenant_acme',98765,'task','direct task','actor_acme_alice','actor_acme_alice','in_progress',1,'idle',1,'run',0,0,now(),now(),0)`, taskID)
	if err != nil {
		t.Fatal(err)
	}
	coordinatorKey := env.contextKey
	if len(withoutCoordinator) > 0 && withoutCoordinator[0] {
		coordinatorKey = ""
	}
	_, err = tx.Exec(t.Context(), `INSERT INTO task_execution_generations(task_id,tenant_id,generation,result_agent_actor_id,spec,spec_hash,coordinator_actor_id,coordinator_context_key) VALUES($1,'tenant_acme',1,'actor_acme_official','{}',decode(repeat('00',32),'hex'),CASE WHEN $2::text='' THEN NULL ELSE 'actor_acme_official' END,NULLIF($2::text,''))`, taskID, coordinatorKey)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(t.Context(), `INSERT INTO task_execution_participants(task_id,tenant_id,generation,actor_id,agent_management_id,execution_context_ref) VALUES($1,'tenant_acme',1,'actor_acme_official',$2,jsonb_build_object('kind','alter_ego','agentId',$2::text,'taskId',$1::text))`, taskID, testRuntimeAgentID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(t.Context(), `INSERT INTO task_meta_inboxes(task_id,tenant_id,agent_actor_id) VALUES($1,'tenant_acme','actor_acme_official')`, taskID); err != nil {
		t.Fatal(err)
	}
	if bound {
		if _, err = tx.Exec(t.Context(), `INSERT INTO work_item_room_links(work_item_id,tenant_id,link_type,room_id,linked_by_actor_id) VALUES($1,'tenant_acme','work',$2,'actor_acme_alice')`, taskID, testRuntimeInboxRoom); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
}

// requeueCommittedRoomMessage applies a committed Room Message again to every
// Context that may receive it. A Context created after the Message missed its
// transaction; each Message still enters a Context only once.
func requeueCommittedRoomMessage(t *testing.T, pool *pgxpool.Pool, messageID string) {
	t.Helper()
	if _, err := pool.Exec(t.Context(), `SELECT queue_agent_inbox_message(message.tenant_id,'room:'||message.room_id,message.id,message.room_seq)
		FROM messages message WHERE message.id=$1`, messageID); err != nil {
		t.Fatalf("queue committed Message %s: %v", messageID, err)
	}
}

// createThreadRoomFixture makes threadID a Thread of parentRoomID rooted at rootID.
func createThreadRoomFixture(t *testing.T, db store.DBTX, parentRoomID, threadID, rootID string) {
	t.Helper()
	if _, err := db.Exec(t.Context(), `INSERT INTO rooms(id,tenant_id,name,created_by_actor_id) VALUES($1,'tenant_acme','Thread fixture','actor_acme_alice')`, threadID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(t.Context(), `UPDATE rooms SET parent_room_id=$2,root_message_id=$3
 WHERE id=$1 AND tenant_id='tenant_acme'`, threadID, parentRoomID, rootID); err != nil {
		t.Fatal(err)
	}
}
