package integration_test

import (
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
)

// TestAgentInboxMessageDisposition pins the one decision the batch read, the
// acceptance recheck, reply obligations and active Runs share.
func TestAgentInboxMessageDisposition(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRuntimeStateTestEnv(t)
	const taskID = "task_disposition"
	insertDirectInboxTask(t, env, taskID, false)
	alter, err := env.service.EnsureContext(t.Context(), agentruntimestate.EnsureContextInput{TargetResidency: "suspended",
		Ref: agentruntimestate.ContextRef{Kind: "alter_ego", AgentID: testRuntimeAgentID, TaskID: taskID},
	})
	if err != nil {
		t.Fatal(err)
	}
	const mention = `[{"type":"reference","target_type":"agent","target":"actor_acme_official","content":"@A"}]`
	if _, err := env.pool.Exec(t.Context(), `
INSERT INTO rooms(id,tenant_id,name,created_by_actor_id) VALUES('room_disposition_thread','tenant_acme','Disposition thread','actor_acme_alice');
INSERT INTO messages(id,tenant_id,room_id,author_actor_id,body,segments,message_kind,card_context_message_id)
SELECT id,'tenant_acme',room,author,'body','[{"type":"text","content":"body"}]',kind,card FROM (VALUES
 ('d-plain','room_runtime_inbox','actor_acme_alice','conversation',NULL),
 ('d-mention','room_runtime_inbox','actor_acme_alice','conversation',NULL),
 ('d-own','room_runtime_inbox','actor_acme_official','conversation',NULL),
 ('d-canceled','room_runtime_inbox','actor_acme_alice','conversation',NULL),
 ('d-notice','room_runtime_inbox','actor_acme_alice','task_terminal_notice',NULL),
 ('d-card-native','room_runtime_inbox','actor_acme_official','conversation',NULL),
 ('d-card-other','room_runtime_inbox','actor_acme_official','conversation',NULL),
 ('d-card-human','room_runtime_inbox','actor_acme_official','conversation',NULL)) seed(id,room,author,kind,card);
INSERT INTO messages(id,tenant_id,room_id,author_actor_id,body,segments,message_kind,card_context_message_id)
SELECT id,'tenant_acme','room_runtime_inbox','actor_acme_alice','decision','[{"type":"text","content":"decision"}]','agent_runtime',card FROM (VALUES
 ('d-runtime-unmentioned','d-card-native'),('d-native','d-card-native'),('d-native-other','d-card-other'),
 ('d-human-decision','d-card-human')) seed(id,card);
UPDATE rooms SET parent_room_id='room_runtime_inbox',root_message_id='d-plain'
 WHERE id='room_disposition_thread' AND tenant_id='tenant_acme';
INSERT INTO messages(id,tenant_id,room_id,author_actor_id,body,segments) VALUES
 ('d-thread-plain','tenant_acme','room_disposition_thread','actor_acme_alice','body','[{"type":"text","content":"body"}]'),
 ('d-thread-mention','tenant_acme','room_disposition_thread','actor_acme_alice','body','[{"type":"text","content":"body"}]');
INSERT INTO room_events(event_id,tenant_id,room_id,room_seq,event_type,actor_id,resource_id,payload)
SELECT message.id||'-created',message.tenant_id,message.room_id,
 room.next_room_seq+row_number() OVER (PARTITION BY message.room_id ORDER BY message.id),'message.created',message.author_actor_id,message.id,'{}'
FROM messages message JOIN rooms room ON room.id=message.room_id WHERE message.id LIKE 'd-%';
UPDATE rooms room SET next_room_seq=(SELECT max(event.room_seq) FROM room_events event WHERE event.room_id=room.id)
WHERE room.id IN ('room_runtime_inbox','room_disposition_thread');
UPDATE messages message SET room_seq=event.room_seq,mentioned_actor_ids=ARRAY['actor_acme_official']
FROM room_events event
WHERE event.resource_id=message.id AND event.room_id=message.room_id
 AND event.event_type='message.created' AND event.resource_id IN ('d-mention','d-canceled','d-notice','d-native','d-native-other','d-human-decision','d-thread-mention');
INSERT INTO room_agent_message_cancellations(tenant_id,room_id,agent_actor_id,message_id)
 VALUES('tenant_acme','room_runtime_inbox','actor_acme_official','d-canceled');
INSERT INTO message_cards(message_id,tenant_id,room_id,decision_owner_actor_id,card_type,intent)
SELECT id,'tenant_acme','room_runtime_inbox','actor_acme_alice','personal_notice','decision_requested'
FROM unnest(ARRAY['d-card-native','d-card-other','d-card-human']) id;
INSERT INTO decisions(id,tenant_id,room_id,message_id,kind,requested_by_actor_id,decider_actor_id,request,view)
SELECT 'decision-'||card,'tenant_acme','room_runtime_inbox',card,'question','actor_acme_official','actor_acme_alice',request,
 '{"prompt":"question","questions":[{"id":"q1","prompt":"Which?","input":"radio","options":[{"id":"o1","label":"Yes"}]}]}' FROM (VALUES
 ('d-card-native',jsonb_build_object('runtime',jsonb_build_object('kind','native_question','context_key',$1::text))),
 ('d-card-other',jsonb_build_object('runtime',jsonb_build_object('kind','native_question','context_key','another-context'))),
 ('d-card-human','{}'::jsonb)) seed(card,request);
INSERT INTO task_meta_messages(id,tenant_id,task_id,agent_actor_id,meta_seq,author_actor_id,body,segments)
 VALUES('d-meta','tenant_acme',$2,'actor_acme_official',1,'actor_acme_official','meta','`+mention+`');
INSERT INTO task_meta_callbacks(task_id,tenant_id,generation,coordinator_actor_id,coordinator_context_key)
 VALUES($2,'tenant_acme',1,'actor_acme_official',$1);
INSERT INTO task_meta_callback_messages(id,task_id,tenant_id,generation,meta_seq,author_actor_id,body,segments,non_actionable) VALUES
 ('d-callback',$2,'tenant_acme',1,1,'actor_acme_alice','callback','`+mention+`',false),
 ('d-callback-own',$2,'tenant_acme',1,2,'actor_acme_official','callback','[]',false),
 ('d-callback-quiet',$2,'tenant_acme',1,3,'actor_acme_alice','callback','[]',true);`,
		pgx.QueryExecModeSimpleProtocol, env.contextKey, taskID); err != nil {
		t.Fatal(err)
	}
	type dispositionCase struct {
		name, context, inbox, message, want string
		mentioned                           bool
	}
	room, thread := "room:"+testRuntimeInboxRoom, "thread:room_disposition_thread"
	check := func(t *testing.T, cases []dispositionCase) {
		t.Helper()
		for _, c := range cases {
			var context, inbox *string
			if c.context != "" {
				context = &c.context
			}
			if c.inbox != "" {
				inbox = &c.inbox
			}
			var got string
			var mentioned bool
			if err := env.pool.QueryRow(t.Context(), `SELECT disposition,mentioned FROM agent_inbox_message_disposition('tenant_acme','actor_acme_official',$1,$2,$3)`,
				context, inbox, c.message).Scan(&got, &mentioned); err != nil {
				t.Fatalf("%s: %v", c.name, err)
			}
			if got != c.want || mentioned != c.mentioned {
				t.Errorf("%s: disposition=%s mentioned=%v, want %s %v", c.name, got, mentioned, c.want, c.mentioned)
			}
		}
	}
	check(t, []dispositionCase{
		{"general Agent skips an unmentioned Room message", env.contextKey, room, "d-plain", "skip", false},
		{"a mention notifies", env.contextKey, room, "d-mention", "notify", true},
		{"the Agent's own message is skipped", env.contextKey, room, "d-own", "skip", false},
		{"a Stop for this Agent ignores its mention", env.contextKey, room, "d-canceled", "ignore", true},
		{"a Task notice is not Agent input", env.contextKey, room, "d-notice", "ignore", true},
		{"an unmentioned Runtime decision is not this Agent's", env.contextKey, room, "d-runtime-unmentioned", "ignore", false},
		{"a native answer for this Context", env.contextKey, room, "d-native", "runtime_response", true},
		{"a native answer for another Context", env.contextKey, room, "d-native-other", "ignore", true},
		{"a native answer without a Context", "", "", "d-native", "ignore", true},
		{"an answer to a card without a Runtime request, such as ask-user, mentions the Agent", env.contextKey, room, "d-human-decision", "notify", true},
		{"a mention without a Context", "", "", "d-mention", "notify", true},
		{"an unmentioned Thread message", env.contextKey, thread, "d-thread-plain", "skip", false},
		{"a Thread mention", env.contextKey, thread, "d-thread-mention", "notify", true},
		{"private Meta reaches the alter ego", alter.Context.ContextKey, "meta:actor_acme_official:" + taskID, "d-meta", "notify", true},
		{"private Meta never reaches a Room Context", env.contextKey, "meta:actor_acme_official:" + taskID, "d-meta", "skip", true},
		{"a Task callback notifies its coordinator", env.contextKey, "taskmeta:" + taskID, "d-callback", "notify", true},
		{"an AlterEgo report under the shared identity notifies its coordinator", env.contextKey, "taskmeta:" + taskID, "d-callback-own", "notify", false},
		{"a non-actionable callback is ignored", env.contextKey, "taskmeta:" + taskID, "d-callback-quiet", "ignore", false},
	})
	// A private stream decides only its own Messages.
	var rows int
	if err := env.pool.QueryRow(t.Context(), `SELECT count(*) FROM agent_inbox_message_disposition('tenant_acme','actor_acme_official',$1,$2,'d-mention')`, env.contextKey, "taskmeta:"+taskID).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("a Room message read through a private stream rows=%d err=%v", rows, err)
	}

	// The option, not the Agent type, decides hearing every message: a General
	// Agent with it on hears as Another Me does.
	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_registrations SET receives_all_messages=true WHERE actor_id='actor_acme_official'`); err != nil {
		t.Fatal(err)
	}
	check(t, []dispositionCase{
		{"a General Agent receiving every message hears an unmentioned Room message", env.contextKey, room, "d-plain", "notify", false},
		{"a General Agent receiving every message still skips its own message", env.contextKey, room, "d-own", "skip", false},
		{"a General Agent receiving every message skips an unmentioned Thread message", env.contextKey, thread, "d-thread-plain", "skip", false},
	})

	// AnotherMe hears every Room and Task message, but a Thread still wakes
	// only the Agents it mentions.
	useAllActionableRuntimeAgent(t, env)
	check(t, []dispositionCase{
		{"AnotherMe hears an unmentioned Room message", env.contextKey, room, "d-plain", "notify", false},
		{"AnotherMe still skips its own message", env.contextKey, room, "d-own", "skip", false},
		{"AnotherMe skips an unmentioned Thread message", env.contextKey, thread, "d-thread-plain", "skip", false},
		{"AnotherMe hears a Thread mention", env.contextKey, thread, "d-thread-mention", "notify", true},
		{"AnotherMe hears a mention", env.contextKey, room, "d-mention", "notify", true},
	})
}
