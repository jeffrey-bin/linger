package integration_test

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/realtime"
)

func TestAgentInboxRecipientsMatchReceiveAuthority(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRuntimeStateTestEnv(t)
	const parent = "room_wake_parent"
	const thread = "room_wake_thread"
	insertRuntimeRoomMembership(t, env.pool, parent)
	insertRuntimeRoomMembershipForAgent(t, env.pool, thread, "actor_acme_alice")
	for _, statement := range []string{
		`INSERT INTO messages(id,tenant_id,room_id,author_actor_id,body,segments) VALUES('wake-root','tenant_acme','room_wake_parent','actor_acme_alice','Root','[{"type":"text","content":"Root"}]')`,
		`UPDATE rooms SET parent_room_id='room_wake_parent',root_message_id='wake-root' WHERE id='room_wake_thread' AND tenant_id='tenant_acme'`,
		`INSERT INTO room_member_states(room_id,actor_id,thread_opened_at) VALUES('room_wake_thread','actor_acme_official',now()) ON CONFLICT (room_id,actor_id) DO UPDATE SET thread_opened_at=excluded.thread_opened_at`,
	} {
		if _, err := env.pool.Exec(t.Context(), statement); err != nil {
			t.Fatal(err)
		}
	}
	perRoomKey := `["meta","` + testRuntimeAgentID + `","room","` + parent + `"]`
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO agent_execution_contexts(context_key,tenant_id,agent_actor_id,agent_management_id,context_kind,target_residency,room_id,membership_epoch_id) SELECT $1,tenant_id,actor_id,$2,'meta','suspended',room_id,membership_epoch_id FROM active_room_members WHERE room_id=$3 AND actor_id='actor_acme_official'`, perRoomKey, testRuntimeAgentID, parent); err != nil {
		t.Fatal(err)
	}
	const task = "task_wake_authority"
	insertDirectInboxTask(t, env, task, true, true)
	if _, err := env.service.EnsureContext(t.Context(), agentruntimestate.EnsureContextInput{Ref: agentruntimestate.ContextRef{Kind: "alter_ego", AgentID: testRuntimeAgentID, TaskID: task}, TargetResidency: "suspended"}); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO task_meta_callbacks(task_id,tenant_id,generation,coordinator_actor_id,coordinator_context_key) VALUES($1,'tenant_acme',1,'actor_acme_official',$2)`, task, env.contextKey); err != nil {
		t.Fatal(err)
	}
	type recipient struct{ ContextKey, InboxID string }
	recipients := func(t *testing.T, pool *pgxpool.Pool, rawInbox string) []recipient {
		t.Helper()
		rows, err := pool.Query(t.Context(), `SELECT context_key,inbox_id FROM agent_inbox_recipients($1)`, rawInbox)
		if err != nil {
			t.Fatal(err)
		}
		got, err := pgx.CollectRows(rows, pgx.RowToStructByPos[recipient])
		if err != nil {
			t.Fatal(err)
		}
		return got
	}
	assertAuthority := func(rawInbox string, inboxes ...string) []recipient {
		t.Helper()
		started := time.Now()
		got := recipients(t, env.pool, rawInbox)
		t.Logf("resolve %s elapsed=%s recipients=%d", rawInbox, time.Since(started), len(got))
		actual := []string{}
		for _, recipient := range got {
			actual = append(actual, recipient.ContextKey+":"+recipient.InboxID)
		}
		expected := []string{}
		for _, inbox := range inboxes {
			// Only Meta Contexts take Inbox Runs; an AlterEgo hears its Task
			// through the Task worker.
			rows, err := env.pool.Query(t.Context(), `SELECT context_key FROM agent_execution_contexts WHERE context_kind='meta' AND agent_context_can_receive_inbox(context_key,$1)`, inbox)
			if err != nil {
				t.Fatal(err)
			}
			for rows.Next() {
				var key string
				if err := rows.Scan(&key); err != nil {
					t.Fatal(err)
				}
				expected = append(expected, key+":"+inbox)
			}
			if err := rows.Err(); err != nil {
				t.Fatal(err)
			}
			rows.Close()
		}
		slices.Sort(expected)
		slices.Sort(actual)
		if !slices.Equal(actual, expected) {
			t.Fatalf("%s recipients=%v predicate=%v", rawInbox, actual, expected)
		}
		return got
	}
	assertAuthority("room:"+parent, "room:"+parent)
	assertAuthority("room:"+thread, "thread:"+thread)
	assertAuthority("room:"+testRuntimeInboxRoom, "task:"+task)
	// The Task worker delivers the private Meta stream itself; no Message
	// transaction queues it.
	if got := recipients(t, env.pool, "meta:actor_acme_official:"+task); len(got) != 0 {
		t.Fatalf("private recipients=%v", got)
	}
	assertAuthority("taskmeta:"+task, "taskmeta:"+task)
	assertAuthority("room:unknown")
	// A Room may be both a Thread and a Task Work Room. Neither interpretation
	// can suppress the other authorized receive path.
	if _, err := env.pool.Exec(t.Context(), `UPDATE work_item_room_links SET room_id=$2 WHERE work_item_id=$1 AND link_type='work'`, task, thread); err != nil {
		t.Fatal(err)
	}
	assertAuthority("room:"+thread, "thread:"+thread, "task:"+task)
	if _, err := env.pool.Exec(t.Context(), `DELETE FROM room_members WHERE room_id=$1 AND actor_id='actor_acme_official'`, parent); err != nil {
		t.Fatal(err)
	}
	assertAuthority("room:"+thread, "thread:"+thread, "task:"+task)
	// Immutable generation without a coordinator above proves the union; a
	// separate coordinator-bound fixture proves only its selected Context wins.
	bound := newRuntimeStateTestEnv(t)
	insertDirectInboxTask(t, bound, "task_wake_bound", true)
	selected := recipients(t, bound.pool, "room:"+testRuntimeInboxRoom)
	if len(selected) != 1 || selected[0].ContextKey != bound.contextKey {
		t.Fatalf("coordinator recipients=%v", selected)
	}
	if _, err := bound.pool.Exec(t.Context(), `INSERT INTO task_meta_callbacks(task_id,tenant_id,generation,coordinator_actor_id,coordinator_context_key) VALUES('task_wake_bound','tenant_acme',1,'actor_acme_official',$1)`, bound.contextKey); err != nil {
		t.Fatal(err)
	}
	selected = recipients(t, bound.pool, "taskmeta:task_wake_bound")
	if len(selected) != 1 || selected[0].ContextKey != bound.contextKey {
		t.Fatalf("callback recipients=%v", selected)
	}
}

func TestAgentContextChangedWakeUsesCommitAndIgnoresClaimRelease(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRuntimeStateTestEnv(t)
	t.Run("a committed Message publishes one run.queued hint for its Context", func(t *testing.T) {
		useAllActionableRuntimeAgent(t, env)
		broker := realtime.NewBroker(4)
		listener, err := realtime.NewListener(env.pool.Config().ConnString(), broker, nil)
		if err != nil {
			t.Fatal(err)
		}
		if err := listener.Start(t.Context()); err != nil {
			t.Fatal(err)
		}
		defer listener.Close()
		subscription := broker.Subscribe(realtime.AgentInboxWakeTopic)
		defer subscription.Close()
		next := func(want bool) {
			t.Helper()
			for {
				select {
				case got := <-subscription.Events():
					if got.Kind != realtime.RunQueuedKind {
						continue
					}
					if !want || got.ContextKey != env.contextKey {
						t.Fatalf("unexpected run hint %+v", got)
					}
					return
				case <-time.After(300 * time.Millisecond):
					if want {
						t.Fatal("missing committed run.queued hint")
					}
					return
				}
			}
		}
		appendAndCommit := func(messageID string, rollback bool) {
			t.Helper()
			tx, err := env.pool.Begin(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(t.Context())
			appendWakeMessage(t, tx, testRuntimeInboxRoom, messageID)
			// The queue runs at commit, so nothing is visible before it.
			next(false)
			if rollback {
				err = tx.Rollback(t.Context())
			} else {
				err = tx.Commit(t.Context())
			}
			if err != nil {
				t.Fatal(err)
			}
		}
		appendAndCommit("broker-rollback", true)
		next(false)
		appendAndCommit("broker-committed", false)
		next(true)
		next(false)
		if got := countRuntimeInputs(t, env.pool, "broker-rollback"); got != 0 {
			t.Fatalf("rolled back Message queued %d inputs", got)
		}
	})
	const insertedRoom = "room_wake_inserted_context"
	insertRuntimeRoomMembership(t, env.pool, insertedRoom)
	var databaseURL string = env.pool.Config().ConnString()
	listener, err := pgx.Connect(t.Context(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close(context.Background())
	if _, err := listener.Exec(t.Context(), "LISTEN "+pgx.Identifier{realtime.ChannelName}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	changed := func(want bool) {
		t.Helper()
		ctx, cancel := context.WithTimeout(t.Context(), 80*time.Millisecond)
		defer cancel()
		for {
			notification, err := listener.WaitForNotification(ctx)
			if errors.Is(err, context.DeadlineExceeded) {
				if want {
					t.Fatal("missing Context change")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			decoded, err := realtime.DecodeNotification([]byte(notification.Payload))
			if err != nil {
				t.Fatal(err)
			}
			if decoded.Kind != "context.changed" {
				continue
			}
			if !want || decoded.ResourceID != env.contextKey {
				t.Fatalf("unexpected Context wake=%+v", decoded)
			}
			return
		}
	}
	tx, err := env.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `UPDATE agent_execution_contexts SET state_revision=state_revision+1 WHERE context_key=$1`, env.contextKey); err != nil {
		t.Fatal(err)
	}
	changed(false)
	if err := tx.Rollback(t.Context()); err != nil {
		t.Fatal(err)
	}
	changed(false)
	for _, statement := range []string{
		`UPDATE agent_execution_contexts SET state_revision=state_revision+1 WHERE context_key=$1`,
		`UPDATE agent_execution_contexts SET target_residency='suspended',state_revision=state_revision+1 WHERE context_key=$1`,
		`UPDATE agent_execution_contexts SET terminal_reason='context_deleted',terminated_at=now() WHERE context_key=$1`,
	} {
		if _, err := env.pool.Exec(t.Context(), statement, env.contextKey); err != nil {
			t.Fatal(err)
		}
		changed(true)
	}
	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_execution_contexts SET target_residency=target_residency,state_revision=state_revision WHERE context_key=$1`, env.contextKey); err != nil {
		t.Fatal(err)
	}
	changed(false)
	// INSERT must emit independently of a state_revision update.
	nextKey := `["meta","` + testRuntimeAgentID + `","room","` + insertedRoom + `"]`
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO agent_execution_contexts(context_key,tenant_id,agent_actor_id,agent_management_id,context_kind,target_residency,room_id,membership_epoch_id) SELECT $1,tenant_id,actor_id,$2,'meta','suspended',room_id,membership_epoch_id FROM active_room_members WHERE room_id=$3 AND actor_id='actor_acme_official'`, nextKey, testRuntimeAgentID, insertedRoom); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	for {
		notification, err := listener.WaitForNotification(ctx)
		if err != nil {
			t.Fatal(err)
		}
		decoded, err := realtime.DecodeNotification([]byte(notification.Payload))
		if err != nil {
			t.Fatal(err)
		}
		if decoded.Kind == "context.changed" {
			if !strings.Contains(decoded.ResourceID, insertedRoom) {
				t.Fatalf("insert change=%v", decoded)
			}
			break
		}
	}
}

// appendWakeMessage appends one Room Message and its Room event inside tx,
// the rows that fire the Room Inbox wake.
func appendWakeMessage(t *testing.T, tx pgx.Tx, roomID, messageID string) {
	t.Helper()
	var sequence int64
	if err := tx.QueryRow(t.Context(), `UPDATE rooms SET next_room_seq=next_room_seq+1 WHERE id=$1 RETURNING next_room_seq`, roomID).Scan(&sequence); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `INSERT INTO messages(id,tenant_id,room_id,author_actor_id,body,segments,message_kind)
		VALUES($1,'tenant_acme',$2,'actor_acme_alice','hi','[{"type":"text","content":"hi"}]','conversation')`, messageID, roomID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `INSERT INTO room_events(event_id,tenant_id,room_id,room_seq,event_type,actor_id,resource_id,payload)
		VALUES($1,'tenant_acme',$2,$3,'message.created','actor_acme_alice',$4,'{}')`, messageID+"-event", roomID, sequence, messageID); err != nil {
		t.Fatal(err)
	}
}
