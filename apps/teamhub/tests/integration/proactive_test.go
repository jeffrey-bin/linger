package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/proactive"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/reminder"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// TestProactiveRecordsOnlyAnotherMesWakeAnswers records the first Message
// AnotherMe sends in a Run that a delivered proactive wake started, with the
// wake's source, as its Human's output. A Run started by the Human, such as one
// returning a late result after the wake, is never recorded, and neither is a
// wake steered into such a Run.
func TestProactiveRecordsOnlyAnotherMesWakeAnswers(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, pool := newConnectedAnotherMeEnv(t, nil)
	roomID := anotherMeRoomID(t, pool, "actor_acme_alice")
	var managementID, agentID string
	if err := pool.QueryRow(t.Context(), `SELECT agent_management_id, actor_id FROM agent_registrations
		WHERE represented_human_actor_id='actor_acme_alice' AND agent_type='anotherme'`).Scan(&managementID, &agentID); err != nil {
		t.Fatal(err)
	}
	ensured, err := agentruntimestate.New(pool).EnsureContext(t.Context(), agentruntimestate.EnsureContextInput{TargetResidency: "active",
		Ref: agentruntimestate.ContextRef{Kind: "meta", AgentID: managementID, RoomID: roomID},
	})
	if err != nil {
		t.Fatal(err)
	}
	sequence := int64(0)
	// run makes a Run whose inputs carry these Room Messages, as an accepted
	// Room Inbox notification does.
	run := func(runID, relation string, messageIDs ...string) string {
		t.Helper()
		if _, err := pool.Exec(t.Context(), `INSERT INTO agent_local_runs(run_id,context_key,status)
			VALUES($1,$2,'queued') ON CONFLICT (run_id) DO NOTHING`, runID, ensured.Context.ContextKey); err != nil {
			t.Fatal(err)
		}
		sequence++
		payload, _ := json.Marshal(map[string]any{
			"invocationMessageIds": messageIDs,
			"acceptedNotification": map[string]any{"cursorEncoding": "room_event_v1"},
		})
		inputID := runID + "-" + relation
		if _, err := pool.Exec(t.Context(), `INSERT INTO agent_runtime_inputs(context_key,input_id,input_sequence,payload,payload_hash,source_kind,source_inbox_id,status,local_run_id)
			VALUES($1,$2,$3,$4,decode(repeat('a',64),'hex'),'inbox',$5,'handled',$6)`,
			ensured.Context.ContextKey, inputID, 1000+sequence, payload, "room:"+roomID, runID); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(t.Context(), `INSERT INTO agent_local_run_inputs(run_id,context_key,input_id,relation,ordinal)
			VALUES($1,$2,$3,$4,0)`, runID, ensured.Context.ContextKey, inputID, relation); err != nil {
			t.Fatal(err)
		}
		return runID
	}
	assertQuietClock := func(messageID string) {
		t.Helper()
		var at time.Time
		if err := pool.QueryRow(t.Context(), `SELECT created_at FROM messages WHERE id=$1`, messageID).Scan(&at); err != nil {
			t.Fatal(err)
		}
		if err := proactive.New(pool, nil, nil).QueueWake(t.Context(), managementID, roomID, "[Proactive review] clock probe"); err != nil {
			t.Fatal(err)
		}
		if wait, err := reminder.Deliver(t.Context(), pool, pendingWakeID(t, pool, roomID), at.Add(time.Minute), reminder.Window); err != nil || wait != 2*time.Minute {
			t.Fatalf("quiet clock must follow ordinary reply %s: wait=%v err=%v", messageID, wait, err)
		}
	}
	outputs := func(messageID, source string) int {
		return countRows(t, env, `SELECT count(*) FROM proactive_outputs
			WHERE message_id=$1 AND owner_actor_id='actor_acme_alice' AND room_id=$2 AND source=$3`, messageID, roomID, source)
	}
	asked := postRecordedReply(t, pool, "actor_acme_alice", roomID, "check flights for me", "")
	humanRun := run("human-run", "initial", asked)
	if err := proactive.New(pool, nil, nil).QueueWake(t.Context(), managementID, roomID, "[Proactive review] submit the report"); err != nil {
		t.Fatal(err)
	}
	if wait, err := reminder.Deliver(t.Context(), pool, pendingWakeID(t, pool, roomID), time.Now().Add(reminder.Window+time.Minute), reminder.Window); err != nil || wait != 0 {
		t.Fatalf("wake not delivered: wait=%v err=%v", wait, err)
	}
	var wakeMessageID string
	if err := pool.QueryRow(t.Context(), `SELECT message_id FROM proactive_pending_wakes WHERE room_id=$1 AND source='review'`, roomID).Scan(&wakeMessageID); err != nil {
		t.Fatal(err)
	}
	late := postRecordedReply(t, pool, agentID, roomID, "Found it: Tuesday 8:00 ¥680", humanRun)
	assertQuietClock(late)
	if countRows(t, env, `SELECT count(*) FROM proactive_outputs WHERE message_id=$1`, late) != 0 {
		t.Fatal("a late result of the Human's own Run was recorded as a wake answer")
	}
	run("human-run", "steer", wakeMessageID)
	steered := postRecordedReply(t, pool, agentID, roomID, "by the way", humanRun)
	assertQuietClock(steered)
	if countRows(t, env, `SELECT count(*) FROM proactive_outputs WHERE message_id=$1`, steered) != 0 {
		t.Fatal("a wake steered into the Human's Run made it proactive")
	}
	wakeRun := run("wake-run", "initial", wakeMessageID)
	answer := postRecordedReply(t, pool, agentID, roomID, "Reminder: submit the report tomorrow", wakeRun)
	again := postRecordedReply(t, pool, agentID, roomID, "one more thing", wakeRun)
	assertQuietClock(steered)
	if outputs(answer, "review") != 1 || outputs(again, "review") != 0 {
		t.Fatal("the wake Run's first Message was not its only output")
	}
	human := postRecordedReply(t, pool, "actor_acme_alice", roomID, "got it", wakeRun)
	if countRows(t, env, `SELECT count(*) FROM proactive_outputs WHERE message_id=$1`, human) != 0 {
		t.Fatal("the Human's own message was recorded")
	}
	assertQuietClock(human)
	run(wakeRun, "steer", human)
	followup := postRecordedReply(t, pool, agentID, roomID, "answering your followup", wakeRun)
	assertQuietClock(followup)
	mixedRun := run("mixed-run", "initial", asked, wakeMessageID)
	mixed := postRecordedReply(t, pool, agentID, roomID, "answering accumulated messages", mixedRun)
	assertQuietClock(mixed)
	if outputs(mixed, "review") != 0 {
		t.Fatal("a mixed Human/wake initial input was recorded as proactive")
	}
	interruptedRun := run("interrupted-wake-run", "initial", wakeMessageID)
	run(interruptedRun, "steer", human)
	interrupted := postRecordedReply(t, pool, agentID, roomID, "answering the Human before any reminder", interruptedRun)
	if outputs(interrupted, "review") != 0 {
		t.Fatal("a Human-steered wake Run was recorded as proactive")
	}
	unattributed := postRecordedReply(t, pool, agentID, roomID, "ordinary reply without a Run claim", "")
	assertQuietClock(unattributed)
}

// postRecordedReply stores a conversation message and runs the wake-answer
// recording an Agent's send_message runs in the same transaction, for the
// Run named by runID.
func postRecordedReply(t *testing.T, pool *pgxpool.Pool, actorID, roomID, body, runID string) string {
	t.Helper()
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(t.Context()) }()
	queries := store.New(pool).WithTx(tx)
	author, err := queries.GetActor(t.Context(), store.GetActorParams{ID: actorID, TenantID: acmeTenant})
	if err != nil {
		t.Fatal(err)
	}
	content, err := messagecreation.Normalize([]messagecreation.Segment{{Type: "text", Content: body}})
	if err != nil {
		t.Fatal(err)
	}
	created, err := messagecreation.Create(t.Context(), queries, messagecreation.Draft{
		TenantID: acmeTenant, RoomID: roomID, Author: author, Content: content, TrustedRunID: runID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := proactive.RecordWakeAnswer(t.Context(), queries, acmeTenant, roomID, created.Message.ID, runID, author); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	return created.Message.ID
}

// TestProactiveRoutinesEventsAndListeners covers the proactive triggers for
// one Human: a one-shot Routine fires once with
// its source label into the quiet-wake queue and is then done; an event queues
// a reminder wake for their AnotherMe, is not judged twice in one state, is
// judged again in a new state, queues only a quiet tracking wake at night
// unless urgent, and never touches another Human.
func TestProactiveRoutinesEventsAndListeners(t *testing.T) {
	allowParallelIntegrationTest(t)
	var judgedMu sync.Mutex
	var judged []string
	notify := func(_ context.Context, request proactive.EventJudgeRequest) (string, error) {
		state, _ := json.Marshal(request)
		judgedMu.Lock()
		judged = append(judged, string(state))
		judgedMu.Unlock()
		return "[Proactive event: decide yourself]", nil
	}
	gmail, mailbox := fakeComposioGmail(t)
	env, pool := newConnectedAnotherMeEnv(t, func(cfg *config.Config) {
		cfg.ExternalApps.ComposioAPIKey, cfg.ExternalApps.ComposioBaseURL = "test-key", gmail.URL
		cfg.ExternalApps.ComposioEnvironmentKey = "test"
	}, withProactiveEventJudge(notify))
	roomID := anotherMeRoomID(t, pool, "actor_acme_alice")
	var agentID string
	if err := pool.QueryRow(t.Context(), `SELECT actor_id FROM agent_registrations WHERE represented_human_actor_id='actor_acme_alice' AND agent_type='anotherme'`).Scan(&agentID); err != nil {
		t.Fatal(err)
	}
	waitUntil := func(what string, ok func() bool) {
		deadline := time.Now().Add(15 * time.Second)
		for !ok() {
			if time.Now().After(deadline) {
				t.Fatal(what)
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
	if countRows(t, env, `SELECT count(*) FROM room_reminders WHERE room_id=$1`, roomID) != 0 {
		t.Fatal("provisioning installed a Routine of its own")
	}

	if _, err := pool.Exec(t.Context(), `INSERT INTO room_reminders (id, tenant_id, room_id, created_by_actor_id, name, instruction, mention_actor_id, cadence_kind, timezone, run_at, enabled, next_run_at)
		VALUES ('routine_flight_check', $1, $2, $3, 'Flight · check 1', 'Planned check (proactive-response).', $3, 'once', 'Asia/Shanghai', now()-interval '3 minutes', true, now()-interval '3 minutes')`, acmeTenant, roomID, agentID); err != nil {
		t.Fatal(err)
	}
	// A scheduled fire in the AnotherMe Room joins the quiet-wake queue; the
	// app's own River workers may fire it first.
	firedMessages := func() int {
		runReminderWorker(t, env)
		return countRows(t, env, `SELECT count(*) FROM proactive_pending_wakes WHERE room_id=$1 AND fired_routine_id='routine_flight_check'`, roomID)
	}
	if firedMessages() != 1 || countRows(t, env, `SELECT count(*) FROM room_reminders WHERE id='routine_flight_check' AND NOT enabled AND next_run_at IS NULL`) != 1 {
		t.Fatal("the one-shot Routine did not fire once with its origin and finish")
	}
	if firedMessages() != 1 {
		t.Fatal("a finished one-shot Routine fired again")
	}

	// A Routine serving a finished Tracking Item moves on without waking AnotherMe.
	if _, err := pool.Exec(t.Context(), `INSERT INTO memory_index.tracking_items(id,tenant_id,owner_actor_id,kind,content,source_ref,status,source_timezone)
		VALUES('ti_0000000000000000000000000000000d',$1,'actor_acme_alice','todo','submit the expense claim','message:one','done','UTC')`, acmeTenant); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `INSERT INTO room_reminders (id, tenant_id, room_id, created_by_actor_id, name, instruction, mention_actor_id, cadence_kind, timezone, run_at, enabled, next_run_at, tracking_item_id, tracking_purpose)
		VALUES ('routine_done_item', $1, $2, $3, 'Expense · reminder', 'remind to submit the expense claim', $3, 'once', 'Asia/Shanghai', now()-interval '3 minutes', true, now()-interval '3 minutes', 'ti_0000000000000000000000000000000d', 'deadline reminder')`, acmeTenant, roomID, agentID); err != nil {
		t.Fatal(err)
	}
	runReminderWorker(t, env)
	if countRows(t, env, `SELECT count(*) FROM room_reminders WHERE id='routine_done_item' AND NOT enabled AND next_run_at IS NULL`) != 1 ||
		countRows(t, env, `SELECT count(*) FROM proactive_pending_wakes WHERE room_id=$1 AND body LIKE '%Expense · reminder%'`, roomID)+
			countRows(t, env, `SELECT count(*) FROM messages WHERE room_id=$1 AND body LIKE '%Expense · reminder%'`, roomID) != 0 {
		t.Fatal("a Routine of a done Tracking Item woke AnotherMe")
	}

	if _, err := pool.Exec(t.Context(), `INSERT INTO memory_index.tracking_items(id,tenant_id,owner_actor_id,kind,content,due_at,source_ref,source_timezone)
		VALUES('ti_00000000000000000000000000000009',$1,'actor_acme_alice','question','waiting for Lisa to reply to the quote',NULL,'evidence/2026-10-21/sessions/s1.md','UTC')`, acmeTenant); err != nil {
		t.Fatal(err)
	}
	var statements []string
	for _, provider := range []string{"gmail", "outlook", "google_calendar", "slack", "notion"} {
		statements = append(statements,
			`INSERT INTO external_connection_upstreams(upstream_id,account_id,user_id,toolkit_slug,auth_config_id)
                VALUES('ca_alice_`+provider+`','account_alice','linger:test:account:account_alice','`+provider+`','ac_`+provider+`')`,
			`INSERT INTO external_connections(id,account_id,provider,upstream_connection_id,status,revision,remote_principal_key,identity_label,toolkit_slug,auth_config_id,auto_reminders)
                VALUES('connection_alice_`+provider+`','account_alice','`+provider+`','ca_alice_`+provider+`','active',1,'`+provider+`:alice@example.com','alice@example.com','`+provider+`','ac_`+provider+`',false)`,
			`INSERT INTO external_connection_agent_grants(id,connection_id,tenant_id,agent_actor_id,represented_human_actor_id,status)
                VALUES('grant_alice_`+provider+`','connection_alice_`+provider+`','`+acmeTenant+`','`+agentID+`','actor_acme_alice','active')`)
	}
	for _, statement := range statements {
		if _, err := pool.Exec(t.Context(), statement); err != nil {
			t.Fatal(err)
		}
	}
	grant := reminder.GrantReference{ID: "grant_alice_gmail", Revision: 1, ConnectionID: "connection_alice_gmail", AgentActorID: agentID, TenantID: acmeTenant}
	var states []string
	judge := func(_ context.Context, request proactive.EventJudgeRequest) (string, error) {
		state, _ := json.Marshal(request)
		states = append(states, string(state))
		return "[Proactive event: decide yourself]", nil
	}
	at := func(hour int) func() time.Time {
		return func() time.Time { return time.Date(2026, 10, 21, hour-8, 0, 0, 0, time.UTC) } // Beijing hour
	}
	day := proactive.New(pool, judge, nil).WithClock(at(10))
	night := proactive.New(pool, judge, nil).WithClock(at(23))
	mail := proactive.Event{Grant: &grant, TenantID: acmeTenant, OwnerActorID: "actor_acme_alice", Source: "gmail", ExternalID: "thread_1", State: "reply_1", Kind: "new_mail", Summary: "Lisa replied: agrees to sign next week"}
	// AnotherMe judges each event itself with the rules the Agent Service
	// renders; quiet hours leave it only tracking.
	wakes := func() int {
		return countRows(t, env, `SELECT count(*) FROM proactive_pending_wakes WHERE room_id=$1 AND author_actor_id='actor_acme_alice' AND body LIKE '[Proactive event: decide yourself]%<event>%' AND body NOT LIKE '%do not tell them now%'`, roomID)
	}
	tracks := func() int {
		return countRows(t, env, `SELECT count(*) FROM proactive_pending_wakes WHERE room_id=$1 AND author_actor_id='actor_acme_alice' AND body LIKE '[Proactive event: decide yourself]%do not tell them now%<event>%delayed%'`, roomID)
	}
	if outcome, err := day.HandleEvent(t.Context(), mail); err != nil || outcome.Skipped != "" || wakes() != 1 || !strings.Contains(states[0], "waiting for Lisa to reply to the quote") {
		t.Fatalf("first event=%+v err=%v wakes=%d", outcome, err, wakes())
	}
	if outcome, err := day.HandleEvent(t.Context(), mail); err != nil || outcome.Skipped != "already_judged" || wakes() != 1 {
		t.Fatalf("same state=%+v err=%v", outcome, err)
	}
	mail.State = "reply_2"
	if _, err := day.HandleEvent(t.Context(), mail); err != nil || wakes() != 2 {
		t.Fatalf("new state err=%v wakes=%d", err, wakes())
	}
	late := proactive.Event{Grant: &grant, TenantID: acmeTenant, OwnerActorID: "actor_acme_alice", Source: "flight", ExternalID: "CA1234", State: "delay_40m", Kind: "delay", Summary: "CA1234 delayed 40 minutes"}
	if outcome, err := night.HandleEvent(t.Context(), late); err != nil || outcome.Skipped != "gated_to_tracking" || wakes() != 2 || tracks() != 1 {
		t.Fatalf("night event=%+v err=%v", outcome, err)
	}
	late.State, late.Urgent = "cancelled", true
	if _, err := night.HandleEvent(t.Context(), late); err != nil || wakes() != 3 {
		t.Fatalf("urgent night event err=%v wakes=%d", err, wakes())
	}
	// The app's own River worker takes an enqueued event to a wake (urgent, so
	// wall-clock quiet hours do not matter).
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	gate := proactive.Event{Grant: &grant, TenantID: acmeTenant, OwnerActorID: "actor_acme_alice", Source: "flight", ExternalID: "CA1234", State: "gate_change", Kind: "gate_change", Summary: "CA1234 gate changed to C12", Urgent: true}
	if err := proactive.EnqueueEventTx(t.Context(), tx, gate); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	waitUntil("enqueued event did not wake AnotherMe", func() bool { return wakes() == 4 })

	// Apps: each listenable app the Human grants to its AnotherMe gets its own
	// listener Routine, polled every 10 minutes; Notion is not listenable. New
	// Gmail mail is judged as a proactive event with his Tracking Items, and the
	// same mail is judged once.
	if _, err := pool.Exec(t.Context(), `UPDATE external_connections SET auto_reminders=true WHERE account_id='account_alice'`); err != nil {
		t.Fatal(err)
	}
	appListeners := func() int {
		return countRows(t, env, `SELECT count(*) FROM room_routine_listeners l JOIN room_reminders r ON r.id=l.routine_id
			WHERE r.room_id=$1 AND r.template_routine_key=$2 || ':' || l.connection_id AND r.mention_actor_id=$3 AND l.poll_interval_seconds=600`,
			roomID, proactive.ListenerRoutineKey, agentID)
	}
	// The install sweep runs every 10 minutes, so the test runs it itself.
	if err := proactive.New(pool, nil, nil).SweepListeners(t.Context()); err != nil {
		t.Fatal(err)
	}
	waitUntil("app listeners not installed", func() bool { return appListeners() == 4 })
	if countRows(t, env, `SELECT count(*) FROM room_routine_listeners WHERE connection_id='connection_alice_notion'`) != 0 {
		t.Fatal("Notion got a listener")
	}
	// Only Gmail is polled below; the other bindings go so their polls against
	// the Gmail-only fake stay out of the way.
	if _, err := pool.Exec(t.Context(), `DELETE FROM room_routine_listeners WHERE connection_id<>'connection_alice_gmail'`); err != nil {
		t.Fatal(err)
	}
	var bindingID string
	if err := pool.QueryRow(t.Context(), `SELECT id FROM room_routine_listeners WHERE connection_id='connection_alice_gmail'`).Scan(&bindingID); err != nil {
		t.Fatal(err)
	}
	pollsFinished := func() {
		waitUntil("listener poll did not finish", func() bool {
			return countRows(t, env, `SELECT count(*) FROM river_job WHERE kind='listener.poll' AND finalized_at IS NULL`) == 0
		})
	}
	// runPoll waits for the job, so the next poll is not merged into it.
	runPoll := func() {
		tx, err := pool.Begin(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		if err := jobs.InsertTx(t.Context(), tx, reminder.PollArgs{BindingID: bindingID}, nil); err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(t.Context()); err != nil {
			t.Fatal(err)
		}
		pollsFinished()
	}
	poll := func() {
		var before time.Time
		if err := pool.QueryRow(t.Context(), `SELECT updated_at FROM room_routine_listeners WHERE id=$1`, bindingID).Scan(&before); err != nil {
			t.Fatal(err)
		}
		runPoll()
		if countRows(t, env, `SELECT count(*) FROM room_routine_listeners WHERE id=$1 AND updated_at>$2`, bindingID, before) != 1 {
			t.Fatal("the listener poll did not move its binding")
		}
	}
	judgedMail := func() int {
		judgedMu.Lock()
		for _, state := range judged {
			if !strings.Contains(state, "waiting for Lisa to reply to the quote") {
				t.Error("event judged without the open Tracking Item")
			}
		}
		judgedMu.Unlock()
		return countRows(t, env, `SELECT count(*) FROM proactive_potential_items WHERE owner_actor_id='actor_acme_alice' AND content LIKE '%Subject: Quote confirmation%'`)
	}
	poll() // bootstrap: position only, no history
	mailbox.arrived.Store(true)
	poll()
	waitUntil("new mail was not judged", func() bool { return judgedMail() == 1 })
	if countRows(t, env, `SELECT count(*) FROM room_routine_listeners WHERE id=$1 AND poll_cursor::jsonb->>'v'='100' AND poll_cursor::jsonb->>'page_token'='page2'`, bindingID) != 1 {
		t.Fatal("first page did not persist continuation with the event")
	}
	poll() // continue from the persisted page, not from the mailbox tip
	waitUntil("second page was not judged", func() bool { return judgedMail() == 2 })
	if countRows(t, env, `SELECT count(*) FROM room_routine_listeners WHERE id=$1 AND poll_cursor::jsonb->>'v'='102' AND NOT (poll_cursor::jsonb ? 'page_token')`, bindingID) != 1 {
		t.Fatal("last page did not advance history checkpoint")
	}
	poll()
	if judgedMail() != 2 {
		t.Fatal("completed history was judged twice")
	}

	// A provider outage must not prevent draining events already saved with the
	// cursor. Verify the 25-event batch and its continuation on real transactions.
	mailbox.failing.Store(true)
	pending := make([]reminder.ListenerEvent, 26)
	for i := range pending {
		pending[i] = reminder.ListenerEvent{Source: "gmail", EventID: fmt.Sprintf("pending_%d", i), MessageID: fmt.Sprintf("pending_%d", i), ThreadID: "pending_thread", Subject: "Quote confirmation", Snippet: "Please reply today.", LabelIDs: []string{"INBOX"}}
	}
	saved, _ := json.Marshal(map[string]any{"v": "102", "pending": pending})
	if _, err := pool.Exec(t.Context(), `UPDATE room_routine_listeners SET poll_cursor=(poll_cursor::jsonb || $2::jsonb)::text WHERE id=$1`, bindingID, string(saved)); err != nil {
		t.Fatal(err)
	}
	poll()
	waitUntil("saved first batch was not judged during provider outage", func() bool { return judgedMail() == 27 })
	if countRows(t, env, `SELECT count(*) FROM room_routine_listeners WHERE id=$1 AND jsonb_array_length(poll_cursor::jsonb->'pending')=1 AND poll_cursor::jsonb->>'v'='102'`, bindingID) != 1 {
		t.Fatal("pending batch and checkpoint not committed together")
	}
	poll()
	waitUntil("saved remainder was not judged during provider outage", func() bool { return judgedMail() == 28 })
	if countRows(t, env, `SELECT count(*) FROM room_routine_listeners WHERE id=$1 AND NOT (poll_cursor::jsonb ? 'pending')`, bindingID) != 1 {
		t.Fatal("pending backlog not drained")
	}

	// A failed read only backs the listener off; it keeps its Routine.
	mailbox.failing.Store(true)
	poll()
	if countRows(t, env, `SELECT count(*) FROM room_routine_listeners WHERE id=$1 AND poll_next_at>now()+interval '10 minutes'`, bindingID) != 1 {
		t.Fatal("a failed poll did not back off")
	}
	mailbox.failing.Store(false)

	// An app listener can only be paused and resumed: deleted, it would be
	// installed again; it goes when the app is no longer granted.
	var routineID string
	var revision int64
	if err := pool.QueryRow(t.Context(), `SELECT r.id, r.revision FROM room_routine_listeners l JOIN room_reminders r ON r.id=l.routine_id WHERE l.id=$1`, bindingID).Scan(&routineID, &revision); err != nil {
		t.Fatal(err)
	}
	alice := env.login("alice", alicePassword)
	for _, attempt := range []struct {
		method, path string
		body         any
	}{
		{http.MethodDelete, "/v0/routines/" + routineID + "?expected_revision=" + strconv.FormatInt(revision, 10), nil},
		{http.MethodPatch, "/v0/routines/" + routineID, map[string]any{"expected_revision": revision, "name": "Renamed"}},
		{http.MethodPost, "/v0/routines/" + routineID + "/run", nil},
	} {
		code, _, raw := env.request(alice, attempt.method, attempt.path, attempt.body, "listener-"+attempt.method)
		if code != http.StatusConflict || !strings.Contains(string(raw), "ROUTINE_APP_LISTENER") {
			t.Fatalf("%s an app listener: %d %s", attempt.method, code, raw)
		}
	}
	for _, enabled := range []bool{false, true} {
		code, _, raw := env.request(alice, http.MethodPatch, "/v0/routines/"+routineID, map[string]any{"expected_revision": revision, "enabled": enabled}, "listener-enabled-"+strconv.FormatBool(enabled))
		if code != http.StatusOK || !strings.Contains(string(raw), `"listener":{"app":"gmail"}`) || strings.Contains(string(raw), `"cadence"`) {
			t.Fatalf("toggle an app listener: %d %s", code, raw)
		}
		revision++
	}
	code, _, raw := env.request(alice, http.MethodPatch, "/v0/routines/"+routineID, map[string]any{"expected_revision": revision - 1, "enabled": true}, "")
	if code != http.StatusConflict {
		t.Fatalf("repeat an app listener toggle: %d %s", code, raw)
	}
	// sweep waits out an earlier sweep first: River drops an insert while an
	// equivalent job is unfinished, and a sweep counts as unfinished until its
	// completion is recorded, which can lag its committed work under load.
	sweep := func() {
		waitUntil("an earlier listener sweep did not finish", func() bool {
			return countRows(t, env, `SELECT count(*) FROM river_job WHERE kind='listener.sweep' AND finalized_at IS NULL`) == 0
		})
		tx, err := pool.Begin(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		if err := jobs.InsertTx(t.Context(), tx, reminder.SweepArgs{}, nil); err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(t.Context()); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(t.Context(), `UPDATE external_connection_agent_grants SET status='revoked', revoked_at=now() WHERE id='grant_alice_gmail'`); err != nil {
		t.Fatal(err)
	}
	// A revoked app is not read again, even before a sweep deletes its listener.
	pollsFinished()
	reads := mailbox.reads.Load()
	runPoll()
	if mailbox.reads.Load() != reads {
		t.Fatal("a poll read an app that was no longer granted")
	}
	sweep()
	waitUntil("the listener of a revoked app was not deleted", func() bool {
		return countRows(t, env, `SELECT count(*) FROM room_reminders WHERE id=$1`, routineID) == 0
	})
	if countRows(t, env, `SELECT count(*) FROM room_events WHERE room_id=$1 AND resource_id=$2 AND event_type='routine.changed' AND payload->>'change_kind'='deleted'`, roomID, routineID) != 1 {
		t.Fatal("the deleted listener left no Room event")
	}
	if _, err := pool.Exec(t.Context(), `UPDATE external_connection_agent_grants SET status='active', revoked_at=NULL WHERE id='grant_alice_gmail'`); err != nil {
		t.Fatal(err)
	}
	if err := proactive.New(pool, nil, nil).SweepListeners(t.Context()); err != nil {
		t.Fatal(err)
	}
	waitUntil("a granted app again got no listener", func() bool {
		return countRows(t, env, `SELECT count(*) FROM room_routine_listeners WHERE connection_id='connection_alice_gmail'`) == 1
	})
	if _, err := pool.Exec(t.Context(), `UPDATE external_connections SET status='expired' WHERE id='connection_alice_gmail'`); err != nil {
		t.Fatal(err)
	}
	sweep()
	waitUntil("the listener of a disconnected app was not deleted", func() bool {
		return countRows(t, env, `SELECT count(*) FROM room_routine_listeners WHERE connection_id='connection_alice_gmail'`) == 0
	})
}

// TestProactiveAutoRemindersSwitchRemovesAndRestoresTheListener turns a
// connection's auto reminders off and on: off deletes its listener Routine and
// keeps the sweep from reinstalling it, on installs it again at once, and only
// the connection's own Account can switch it.
func TestProactiveAutoRemindersSwitchRemovesAndRestoresTheListener(t *testing.T) {
	allowParallelIntegrationTest(t)
	gmail, _ := fakeComposioGmail(t)
	env, pool := newConnectedAnotherMeEnv(t, func(cfg *config.Config) {
		cfg.ExternalApps.ComposioAPIKey, cfg.ExternalApps.ComposioBaseURL = "test-key", gmail.URL
		cfg.ExternalApps.ComposioEnvironmentKey = "test"
	})
	roomID := anotherMeRoomID(t, pool, "actor_acme_alice")
	var agentID string
	if err := pool.QueryRow(t.Context(), `SELECT actor_id FROM agent_registrations WHERE represented_human_actor_id='actor_acme_alice' AND agent_type='anotherme'`).Scan(&agentID); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`INSERT INTO external_connection_upstreams(upstream_id,account_id,user_id,toolkit_slug,auth_config_id)
            VALUES('ca_alice_auto','account_alice','linger:test:account:account_alice','gmail','ac_gmail')`,
		`INSERT INTO external_connections(id,account_id,provider,upstream_connection_id,status,revision,remote_principal_key,identity_label,toolkit_slug,auth_config_id)
			VALUES('connection_alice_auto','account_alice','gmail','ca_alice_auto','active',1,'gmail:alice@example.com','alice@example.com','gmail','ac_gmail')`,
		`INSERT INTO external_connection_agent_grants(id,connection_id,tenant_id,agent_actor_id,represented_human_actor_id,status)
			VALUES('grant_alice_auto','connection_alice_auto','` + acmeTenant + `','` + agentID + `','actor_acme_alice','active')`,
	} {
		if _, err := pool.Exec(t.Context(), statement); err != nil {
			t.Fatal(err)
		}
	}
	listeners := func() int {
		return countRows(t, env, `SELECT count(*) FROM room_routine_listeners l JOIN room_reminders r ON r.id=l.routine_id
			WHERE r.room_id=$1 AND r.template_routine_key=$2 AND l.connection_id='connection_alice_auto'`,
			roomID, proactive.ListenerRoutineKey+":connection_alice_auto")
	}
	sweepFinds := func() int {
		rows, err := store.New(pool).ListAnotherMeConnectionsWithoutListener(t.Context(), store.ListAnotherMeConnectionsWithoutListenerParams{
			Providers: proactive.ListenerProviders(), RoutineKeyPrefix: proactive.ListenerRoutineKey + ":",
		})
		if err != nil {
			t.Fatal(err)
		}
		found := 0
		for _, row := range rows {
			if row.ConnectionID == "connection_alice_auto" {
				found++
			}
		}
		return found
	}
	if sweepFinds() == 0 && listeners() != 1 {
		t.Fatal("the sweep does not see a new connection, which defaults to auto reminders on")
	}
	alice := env.login("alice", alicePassword)
	path := "/v0/external-connections/connection_alice_auto/auto-reminders"
	set := func(enabled bool) map[string]any {
		status, _, body := env.request(alice, http.MethodPut, path, map[string]bool{"enabled": enabled}, "")
		if status != http.StatusOK {
			t.Fatalf("set auto reminders %v status=%d body=%s", enabled, status, body)
		}
		var connection map[string]any
		if err := json.Unmarshal(body, &connection); err != nil {
			t.Fatal(err)
		}
		return connection
	}
	if connection := set(true); connection["auto_reminders"] != true || listeners() != 1 {
		t.Fatalf("turning on did not install the listener: %v listeners=%d", connection, listeners())
	}
	if set(true); listeners() != 1 {
		t.Fatal("turning on again installed a second listener")
	}
	if connection := set(false); connection["auto_reminders"] != false || listeners() != 0 || sweepFinds() != 0 {
		t.Fatalf("turning off left a listener or a sweep target: %v listeners=%d", connection, listeners())
	}
	if countRows(t, env, `SELECT count(*) FROM room_events WHERE room_id=$1 AND event_type='routine.changed' AND payload->>'change_kind'='deleted'`, roomID) != 1 {
		t.Fatal("deleting the listener Routine recorded no Room event")
	}
	if connection := set(true); connection["auto_reminders"] != true || listeners() != 1 {
		t.Fatalf("turning on again did not reinstall the listener: %v listeners=%d", connection, listeners())
	}

	// The Human's AnotherMe uses the same switch through the Agent API.
	var managementID string
	if err := pool.QueryRow(t.Context(), `SELECT agent_management_id FROM agent_registrations WHERE actor_id=$1`, agentID).Scan(&managementID); err != nil {
		t.Fatal(err)
	}
	issued, err := agentcredential.New(pool).IssueManaged(t.Context(), managementID, "Auto reminders")
	if err != nil {
		t.Fatal(err)
	}
	agentPost := func(route string, input any) (int, map[string]any) {
		encoded, _ := json.Marshal(input)
		req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, env.server.URL+"/api/agent/v1/apps/auto-reminders/"+route, bytes.NewReader(encoded))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+issued.AccessToken)
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var body map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&body)
		return resp.StatusCode, body
	}
	status, listed := agentPost("list", map[string]any{})
	if items, _ := listed["connections"].([]any); status != http.StatusOK || len(items) != 1 || items[0].(map[string]any)["connection_id"] != "connection_alice_auto" || items[0].(map[string]any)["enabled"] != true {
		t.Fatalf("Agent list status=%d body=%v", status, listed)
	}
	if status, body := agentPost("set", map[string]any{"connection_id": "connection_alice_auto", "enabled": false}); status != http.StatusOK || body["enabled"] != false || listeners() != 0 {
		t.Fatalf("Agent turning off: status=%d body=%v listeners=%d", status, body, listeners())
	}
	if status, body := agentPost("set", map[string]any{"connection_id": "connection_alice_auto", "enabled": true}); status != http.StatusOK || body["enabled"] != true || listeners() != 1 {
		t.Fatalf("Agent turning on: status=%d body=%v listeners=%d", status, body, listeners())
	}
}

// TestProactiveListenerSweepAndSwitchInstallWithoutDeadlock races the sweep's
// install of a connection's listener against the Human turning its auto
// reminders on: both lock the connection before inserting the Routine, so
// neither fails and exactly one listener remains. A sweep that read the
// connection before the Human turned it off installs nothing.
func TestProactiveListenerSweepAndSwitchInstallWithoutDeadlock(t *testing.T) {
	allowParallelIntegrationTest(t)
	gmail, _ := fakeComposioGmail(t)
	env, pool := newConnectedAnotherMeEnv(t, func(cfg *config.Config) {
		cfg.ExternalApps.ComposioAPIKey, cfg.ExternalApps.ComposioBaseURL = "test-key", gmail.URL
		cfg.ExternalApps.ComposioEnvironmentKey = "test"
	})
	roomID := anotherMeRoomID(t, pool, "actor_acme_alice")
	var agentID string
	if err := pool.QueryRow(t.Context(), `SELECT actor_id FROM agent_registrations WHERE represented_human_actor_id='actor_acme_alice' AND agent_type='anotherme'`).Scan(&agentID); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`INSERT INTO external_connection_upstreams(upstream_id,account_id,user_id,toolkit_slug,auth_config_id)
            VALUES('ca_alice_race','account_alice','linger:test:account:account_alice','gmail','ac_gmail')`,
		`INSERT INTO external_connections(id,account_id,provider,upstream_connection_id,status,revision,remote_principal_key,identity_label,toolkit_slug,auth_config_id)
			VALUES('connection_alice_race','account_alice','gmail','ca_alice_race','active',1,'gmail:alice@example.com','alice@example.com','gmail','ac_gmail')`,
		`INSERT INTO external_connection_agent_grants(id,connection_id,tenant_id,agent_actor_id,represented_human_actor_id,status)
			VALUES('grant_alice_race','connection_alice_race','` + acmeTenant + `','` + agentID + `','actor_acme_alice','active')`,
	} {
		if _, err := pool.Exec(t.Context(), statement); err != nil {
			t.Fatal(err)
		}
	}
	key := proactive.ListenerRoutineKey + ":connection_alice_race"
	row := store.ListAnotherMeConnectionsWithoutListenerRow{
		TenantID: acmeTenant, RepresentedHumanActorID: "actor_acme_alice", AgentActorID: agentID, RoomID: roomID,
		ConnectionID: "connection_alice_race", Provider: "gmail", IdentityLabel: pgtype.Text{String: "alice@example.com", Valid: true},
	}
	alice := env.login("alice", alicePassword)
	for range 40 {
		if _, err := pool.Exec(t.Context(), `DELETE FROM room_reminders WHERE template_routine_key=$1`, key); err != nil {
			t.Fatal(err)
		}
		var wg sync.WaitGroup
		var status int
		var body []byte
		wg.Go(func() {
			status, _, body = env.request(alice, http.MethodPut, "/v0/external-connections/connection_alice_race/auto-reminders", map[string]bool{"enabled": true}, "")
		})
		var sweepErr error
		wg.Go(func() { sweepErr = proactive.SweepInstallListener(t.Context(), pool, row) })
		wg.Wait()
		if status != http.StatusOK || sweepErr != nil {
			t.Fatalf("switch racing the sweep: status=%d body=%s sweep=%v", status, body, sweepErr)
		}
		if countRows(t, env, `SELECT count(*) FROM room_reminders WHERE template_routine_key=$1`, key) != 1 {
			t.Fatal("the race left no single listener Routine")
		}
	}

	// The sweep read the connection as missing a listener, then the Human
	// turned auto reminders off before the sweep installed it.
	if _, err := pool.Exec(t.Context(), `DELETE FROM room_reminders WHERE template_routine_key=$1`, key); err != nil {
		t.Fatal(err)
	}
	missing, err := store.New(pool).ListAnotherMeConnectionsWithoutListener(t.Context(), store.ListAnotherMeConnectionsWithoutListenerParams{
		Providers: proactive.ListenerProviders(), ConnectionID: pgtype.Text{String: "connection_alice_race", Valid: true},
		RoutineKeyPrefix: proactive.ListenerRoutineKey + ":",
	})
	if err != nil || len(missing) != 1 {
		t.Fatalf("sweep read=%v err=%v", missing, err)
	}
	if status, _, body := env.request(alice, http.MethodPut, "/v0/external-connections/connection_alice_race/auto-reminders", map[string]bool{"enabled": false}, ""); status != http.StatusOK {
		t.Fatalf("turning off: status=%d body=%s", status, body)
	}
	if err := proactive.SweepInstallListener(t.Context(), pool, missing[0]); err != nil {
		t.Fatal(err)
	}
	if countRows(t, env, `SELECT count(*) FROM room_reminders WHERE template_routine_key=$1`, key) != 0 {
		t.Fatal("a sweep read before the switch turned off reinstalled the listener")
	}
}

type fakeGmailMailbox struct {
	// arrived adds one new inbox message; failing fails every read.
	arrived, failing atomic.Bool
	reads            atomic.Int64
}

// fakeComposioGmail answers the Composio proxy for one Gmail mailbox.
func fakeComposioGmail(t *testing.T) (*httptest.Server, *fakeGmailMailbox) {
	t.Helper()
	mailbox := &fakeGmailMailbox{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mailbox.reads.Add(1)
		var request struct {
			Endpoint   string                         `json:"endpoint"`
			Parameters []struct{ Name, Value string } `json:"parameters"`
		}
		_ = json.NewDecoder(r.Body).Decode(&request)
		params := map[string]string{}
		for _, parameter := range request.Parameters {
			params[parameter.Name] = parameter.Value
		}
		data := map[string]any(nil)
		switch {
		case r.URL.Path != "/api/v3.1/tools/execute/proxy":
		case request.Endpoint == "/gmail/v1/users/me/profile":
			data = map[string]any{"emailAddress": "alice@example.com", "historyId": "100"}
		case request.Endpoint == "/gmail/v1/users/me/history":
			data = map[string]any{"historyId": "100"}
			if mailbox.arrived.Load() {
				data = map[string]any{"historyId": "102"}
				if params["startHistoryId"] != "102" {
					ids, next := []string{"deleted", "m1"}, "page2"
					if params["pageToken"] == "page2" {
						ids, next = []string{"m2"}, ""
					}
					added := []any{}
					for _, id := range ids {
						added = append(added, map[string]any{"message": map[string]any{"id": id}})
					}
					data = map[string]any{"historyId": "102", "nextPageToken": next, "history": []any{map[string]any{"messagesAdded": added}}}
				}
			}
		case request.Endpoint == "/gmail/v1/users/me/messages/m1" || request.Endpoint == "/gmail/v1/users/me/messages/m2":
			data = map[string]any{"id": strings.TrimPrefix(request.Endpoint, "/gmail/v1/users/me/messages/"), "threadId": "t1", "snippet": "agrees to sign next week", "labelIds": []string{"INBOX"},
				"payload": map[string]any{"headers": []any{
					map[string]any{"name": "From", "value": "Lisa <lisa@example.com>"},
					map[string]any{"name": "Subject", "value": "Quote confirmation"},
				}}}
		}
		status := http.StatusOK
		if data == nil {
			status = http.StatusNotFound
		}
		if mailbox.failing.Load() {
			status, data = http.StatusInternalServerError, nil
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": status, "data": data})
	}))
	t.Cleanup(server.Close)
	return server, mailbox
}

func TestProactivePlanWakeCarriesTheHumansRules(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, pool := newConnectedAnotherMeEnv(t, nil)
	roomID := anotherMeRoomID(t, pool, "actor_acme_alice")
	if _, err := pool.Exec(t.Context(), `INSERT INTO proactive_guidelines (tenant_id, owner_actor_id, version, specific, clues)
		VALUES ($1, 'actor_acme_alice', 1, '["Never remind me about groceries"]'::jsonb, '[]'::jsonb)`, acmeTenant); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `INSERT INTO memory_index.tracking_items(id,tenant_id,owner_actor_id,kind,content,source_ref,source_timezone)
		VALUES('ti_0000000000000000000000000000000a',$1,'actor_acme_alice','todo','Buy milk','evidence/2026-11-06/sessions/pocket-note.md','UTC')`, acmeTenant); err != nil {
		t.Fatal(err)
	}
	service := proactive.New(pool, nil, nil)
	if err := service.QueuePlanWake(t.Context(), proactive.Owner{TenantID: acmeTenant, ActorID: "actor_acme_alice"}, []string{"ti_0000000000000000000000000000000a"}); err != nil {
		t.Fatal(err)
	}
	// AnotherMe plans the item under the Human's own rules.
	if countRows(t, env, `SELECT count(*) FROM proactive_pending_wakes WHERE room_id=$1 AND source='plan'
		AND body LIKE '[Proactive plan:%<part-1>%- Never remind me about groceries%</part-1>%<items>%ti_0000000000000000000000000000000a (todo) Buy milk%</items>%'`, roomID) != 1 {
		t.Fatal("the plan wake did not carry the Human's rules and items")
	}
}
