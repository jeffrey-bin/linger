package integration_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/proactive"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/reminder"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

type listenerGrantFixture struct {
	env                  *testEnv
	pool                 *pgxpool.Pool
	room, agent, binding string
	grant                reminder.GrantReference
}

func newListenerGrantFixture(t *testing.T, serve http.HandlerFunc, judge proactive.EventJudge) listenerGrantFixture {
	t.Helper()
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v3.1/toolkits" {
			_, _ = w.Write([]byte(`{"items":[{"slug":"gmail","name":"Gmail","composio_managed_auth_schemes":["OAUTH2"]}]}`))
			return
		}
		if r.URL.Path != "/api/v3.1/tools/execute/proxy" {
			http.NotFound(w, r)
			return
		}
		serve(w, r)
	}))
	t.Cleanup(provider.Close)
	env, pool := newConnectedAnotherMeEnv(t, func(cfg *config.Config) {
		cfg.ExternalApps.ComposioAPIKey, cfg.ExternalApps.ComposioBaseURL = "test-key", provider.URL
		cfg.ExternalApps.ComposioEnvironmentKey = "test"
	}, withProactiveEventJudge(judge))
	f := listenerGrantFixture{env: env, pool: pool, room: anotherMeRoomID(t, pool, "actor_acme_alice"), binding: "lstr_" + strings.Repeat("e", 32)}
	if err := pool.QueryRow(t.Context(), `SELECT actor_id FROM agent_registrations WHERE represented_human_actor_id='actor_acme_alice' AND agent_type='anotherme'`).Scan(&f.agent); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`INSERT INTO external_connection_upstreams(upstream_id,account_id,user_id,toolkit_slug,auth_config_id) VALUES('ca_revoke','account_alice','linger:test:account:account_alice','gmail','ac_gmail')`,
		`INSERT INTO external_connections(id,account_id,provider,upstream_connection_id,status,revision,remote_principal_key,identity_label,toolkit_slug,auth_config_id,auto_reminders) VALUES('connection_revoke','account_alice','gmail','ca_revoke','active',1,'gmail:alice@example.com','alice@example.com','gmail','ac_gmail',false)`,
	} {
		if _, err := pool.Exec(t.Context(), statement); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(t.Context(), `INSERT INTO external_connection_agent_grants(id,connection_id,tenant_id,agent_actor_id,represented_human_actor_id,status) VALUES('grant_revoke','connection_revoke','tenant_acme',$1,'actor_acme_alice','active')`, f.agent); err != nil {
		t.Fatal(err)
	}
	f.grant = reminder.GrantReference{ID: "grant_revoke", Revision: 1, ConnectionID: "connection_revoke", AgentActorID: f.agent, TenantID: acmeTenant}
	trigger, _ := json.Marshal([]reminder.ListenerSpec{{Type: reminder.ListenerGmail, Account: f.grant.ConnectionID}})
	if _, err := pool.Exec(t.Context(), `INSERT INTO room_reminders(id,tenant_id,room_id,created_by_actor_id,name,instruction,mention_actor_id,timezone,enabled,"trigger",template_agent_actor_id,template_routine_key)
 VALUES('routine_revoke','tenant_acme',$1,$2,'Grant check','Check connected app events',$2,'UTC',true,$3,$2,$4)`, f.room, f.agent, trigger, proactive.ListenerRoutineKey+":"+f.grant.ConnectionID); err != nil {
		t.Fatal(err)
	}
	cursor, _ := json.Marshal(map[string]any{"v": "100", "grant": f.grant})
	if _, err := pool.Exec(t.Context(), `INSERT INTO room_routine_listeners(id,tenant_id,room_id,routine_id,ordinal,kind,connection_id,poll_cursor,poll_next_at,poll_interval_seconds)
 VALUES($1,'tenant_acme',$2,'routine_revoke',0,'gmail','connection_revoke',$3,now()+interval '1 day',600)`, f.binding, f.room, string(cursor)); err != nil {
		t.Fatal(err)
	}
	postConversation(t, pool, "actor_acme_alice", f.room, "Keep pending wakes quiet during this test")
	return f
}

func (f listenerGrantFixture) setGranted(t *testing.T, granted bool) {
	t.Helper()
	alice := f.env.login("alice", alicePassword)
	status, _, body := f.env.request(alice, http.MethodPut, "/v0/external-connections/"+f.grant.ConnectionID+"/agent-grants/"+f.agent, map[string]any{"granted": granted}, "")
	if status != http.StatusOK {
		t.Fatalf("grant=%t status=%d body=%s", granted, status, body)
	}
}

func (f listenerGrantFixture) enqueue(t *testing.T, args river.JobArgs, opts *river.InsertOpts) int64 {
	t.Helper()
	tx, err := f.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	if err := jobs.InsertTx(t.Context(), tx, args, opts); err != nil {
		t.Fatal(err)
	}
	var id int64
	if err := tx.QueryRow(t.Context(), `SELECT max(id) FROM river_job WHERE kind=$1`, args.Kind()).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	return id
}

func (f listenerGrantFixture) waitJob(t *testing.T, id int64) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for countRows(t, f.env, `SELECT count(*) FROM river_job WHERE id=$1 AND finalized_at IS NOT NULL`, id) == 0 {
		if time.Now().After(deadline) {
			t.Fatalf("job %d did not finish", id)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestListenerRevocationStopsReadsAndPendingAcrossSources(t *testing.T) {
	allowParallelIntegrationTest(t)
	var reads, judgements atomic.Int32
	f := newListenerGrantFixture(t, func(w http.ResponseWriter, r *http.Request) {
		reads.Add(1)
		var request struct {
			Endpoint string `json:"endpoint"`
		}
		_ = json.NewDecoder(r.Body).Decode(&request)
		if request.Endpoint != "/gmail/v1/users/me/profile" {
			http.Error(w, "unexpected provider read", http.StatusInternalServerError)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": 200, "data": map[string]string{"historyId": "200", "emailAddress": "alice@example.com"}})
	}, func(context.Context, proactive.EventJudgeRequest) (string, error) {
		judgements.Add(1)
		return "[Proactive event: decide yourself]", nil
	})
	// The same connection granted to another Agent remains authorized.
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO external_connection_agent_grants(id,connection_id,tenant_id,agent_actor_id,represented_human_actor_id,status) VALUES('other_grant','connection_revoke','tenant_acme','actor_acme_official','actor_acme_alice','active')`); err != nil {
		t.Fatal(err)
	}
	f.setGranted(t, false)
	for _, source := range []string{reminder.ListenerGmail, reminder.ListenerOutlook, reminder.ListenerGCal, reminder.ListenerSlack} {
		t.Run(source, func(t *testing.T) {
			trigger, _ := json.Marshal([]reminder.ListenerSpec{{Type: source, Account: f.grant.ConnectionID, Channel: "*"}})
			pending := []reminder.ListenerEvent{{Source: source, EventID: "saved", MessageID: "saved", Subject: "must not wake", Text: "must not wake", Summary: "must not wake"}}
			cursor, _ := json.Marshal(map[string]any{"v": "100", "grant": f.grant, "pending": pending})
			if _, err := f.pool.Exec(t.Context(), `UPDATE room_reminders SET "trigger"=$1 WHERE id='routine_revoke'`, trigger); err != nil {
				t.Fatal(err)
			}
			if _, err := f.pool.Exec(t.Context(), `UPDATE room_routine_listeners SET kind=$2,poll_cursor=$3 WHERE id=$1`, f.binding, source, string(cursor)); err != nil {
				t.Fatal(err)
			}
			f.waitJob(t, f.enqueue(t, reminder.PollArgs{BindingID: f.binding}, nil))
		})
	}
	if reads.Load() != 0 || judgements.Load() != 0 || countRows(t, f.env, `SELECT count(*) FROM routine_event_deliveries WHERE routine_id='routine_revoke'`) != 0 {
		t.Fatalf("revocation leaked reads=%d judgements=%d", reads.Load(), judgements.Load())
	}
	other := reminder.GrantReference{ID: "other_grant", Revision: 1, ConnectionID: f.grant.ConnectionID, AgentActorID: "actor_acme_official", TenantID: acmeTenant}
	if err := other.Check(t.Context(), store.New(f.pool)); err != nil {
		t.Fatalf("unrelated grant revoked: %v", err)
	}
	// The next authorized poll starts afresh; the old saved event is not replayed.
	f.setGranted(t, true)
	trigger, _ := json.Marshal([]reminder.ListenerSpec{{Type: reminder.ListenerGmail, Account: f.grant.ConnectionID}})
	if _, err := f.pool.Exec(t.Context(), `UPDATE room_reminders SET "trigger"=$1 WHERE id='routine_revoke'`, trigger); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE room_routine_listeners SET kind='gmail' WHERE id=$1`, f.binding); err != nil {
		t.Fatal(err)
	}
	f.waitJob(t, f.enqueue(t, reminder.PollArgs{BindingID: f.binding}, nil))
	if reads.Load() != 1 || judgements.Load() != 0 || countRows(t, f.env, `SELECT count(*) FROM room_routine_listeners WHERE id=$1 AND poll_cursor::jsonb->>'v'='200' AND NOT (poll_cursor::jsonb ? 'pending')`, f.binding) != 1 {
		t.Fatal("regrant replayed the old backlog or failed to restart")
	}
}

func TestListenerRevocationDuringReadDropsResponse(t *testing.T) {
	allowParallelIntegrationTest(t)
	for _, phase := range []string{"history", "body"} {
		t.Run(phase, func(t *testing.T) {
			entered, release := make(chan struct{}), make(chan struct{})
			var once sync.Once
			t.Cleanup(func() { once.Do(func() { close(release) }) })
			var reads, judgements atomic.Int32
			f := newListenerGrantFixture(t, func(w http.ResponseWriter, r *http.Request) {
				var request struct {
					Endpoint string `json:"endpoint"`
				}
				_ = json.NewDecoder(r.Body).Decode(&request)
				reads.Add(1)
				history := strings.HasSuffix(request.Endpoint, "/history")
				if phase == "history" && history || phase == "body" && !history {
					close(entered)
					select {
					case <-release:
					case <-r.Context().Done():
						return
					}
				}
				var data any
				if history {
					data = map[string]any{"historyId": "101", "history": []any{map[string]any{"messagesAdded": []any{map[string]any{"message": map[string]string{"id": "new"}}}}}}
				} else {
					data = map[string]any{"id": "new", "threadId": "new", "payload": map[string]any{"mimeType": "text/plain", "body": map[string]string{"data": base64.RawURLEncoding.EncodeToString([]byte("Need a reply today"))}}}
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"status": 200, "data": data})
			}, func(context.Context, proactive.EventJudgeRequest) (string, error) {
				judgements.Add(1)
				return "[Proactive event: decide yourself]", nil
			})
			job := f.enqueue(t, reminder.PollArgs{BindingID: f.binding}, nil)
			select {
			case <-entered:
			case <-time.After(10 * time.Second):
				t.Fatal("provider read did not start")
			}
			f.setGranted(t, false) // Must finish while the already-admitted HTTP call is blocked.
			once.Do(func() { close(release) })
			f.waitJob(t, job)
			want := int32(1)
			if phase == "body" {
				want = 2
			}
			if reads.Load() != want || judgements.Load() != 0 || countRows(t, f.env, `SELECT count(*) FROM routine_event_deliveries WHERE routine_id='routine_revoke'`) != 0 {
				t.Fatalf("in-flight data escaped: reads=%d judgements=%d", reads.Load(), judgements.Load())
			}
		})
	}
}

func TestProactiveQueuedEventsAndWakesRespectGrantRevocation(t *testing.T) {
	allowParallelIntegrationTest(t)
	var judged atomic.Int32
	notify := func(context.Context, proactive.EventJudgeRequest) (string, error) {
		judged.Add(1)
		return "[Proactive event: decide yourself]", nil
	}
	f := newListenerGrantFixture(t, func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "unexpected", http.StatusInternalServerError)
	}, notify)
	event := proactive.Event{TenantID: acmeTenant, OwnerActorID: "actor_acme_alice", Source: "gmail", ExternalID: "queued", Kind: "new_mail", Summary: "authorized mail", Urgent: true, Grant: &f.grant}
	job := f.enqueue(t, proactive.EventArgs{Event: event}, &river.InsertOpts{ScheduledAt: time.Now().Add(time.Hour)})
	f.setGranted(t, false)
	if _, err := f.pool.Exec(t.Context(), `UPDATE river_job SET scheduled_at=now(),state='available' WHERE id=$1`, job); err != nil {
		t.Fatal(err)
	}
	f.waitJob(t, job)
	if judged.Load() != 0 {
		t.Fatal("revoked queued event reached judge")
	}
	// A writer that omitted the grant after the migration cannot bypass the worker.
	unscoped := event
	unscoped.ExternalID, unscoped.Grant = "unscoped_queue", nil
	f.waitJob(t, f.enqueue(t, proactive.EventArgs{Event: unscoped}, nil))
	if judged.Load() != 0 || countRows(t, f.env, `SELECT count(*) FROM proactive_pending_wakes WHERE room_id=$1 AND source='event'`, f.room) != 0 {
		t.Fatal("event without grant reached judge or wake queue")
	}
	f.setGranted(t, true)
	// Regrant cannot revive the old generation, even though it is active now.
	if out, err := proactive.New(f.pool, notify, nil).HandleEvent(t.Context(), event); err != nil || out.Skipped != "authorization_revoked" {
		t.Fatalf("old event revived: %+v %v", out, err)
	}
	if err := f.pool.QueryRow(t.Context(), `SELECT revision FROM external_connection_agent_grants WHERE id=$1`, f.grant.ID).Scan(&f.grant.Revision); err != nil {
		t.Fatal(err)
	}
	service := proactive.New(f.pool, notify, nil)
	event.ExternalID = "pending_wake"
	if _, err := service.HandleEvent(t.Context(), event); err != nil {
		t.Fatal(err)
	}
	first := pendingWakeID(t, f.pool, f.room)
	f.setGranted(t, false)
	f.setGranted(t, true)
	if _, err := reminder.Deliver(t.Context(), f.pool, first, time.Now().Add(48*time.Hour), time.Minute); err != nil {
		t.Fatal(err)
	}
	if countRows(t, f.env, `SELECT count(*) FROM proactive_pending_wakes WHERE id=$1`, first) != 0 || countRows(t, f.env, `SELECT count(*) FROM messages WHERE room_id=$1 AND body LIKE '%authorized mail%'`, f.room) != 0 {
		t.Fatal("revoked pending wake delivered")
	}
	// Revocation while the judge runs must also prevent insertion into the wake queue.
	if err := f.pool.QueryRow(t.Context(), `SELECT revision FROM external_connection_agent_grants WHERE id=$1`, f.grant.ID).Scan(&f.grant.Revision); err != nil {
		t.Fatal(err)
	}
	event.ExternalID = "during_judge"
	revokeJudge := func(context.Context, proactive.EventJudgeRequest) (string, error) {
		f.setGranted(t, false)
		return "[Proactive event: decide yourself]", nil
	}
	if out, err := proactive.New(f.pool, revokeJudge, nil).HandleEvent(t.Context(), event); err != nil || out.Skipped != "authorization_revoked" {
		t.Fatalf("judge result escaped revocation: %+v %v", out, err)
	}
	if countRows(t, f.env, `SELECT count(*) FROM proactive_pending_wakes WHERE room_id=$1 AND delivered_at IS NULL`, f.room) != 0 {
		t.Fatal("revoked judgement queued a wake")
	}
	// A grant-less event wake written after the migration is dropped; an ordinary
	// conversation wake in that same delivery batch must still be delivered.
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO proactive_pending_wakes(id,tenant_id,room_id,author_actor_id,agent_actor_id,body,source)
		VALUES('pwake_unscoped',$1,$2,'actor_acme_alice',$3,'unscoped event wake','event')`, acmeTenant, f.room, f.agent); err != nil {
		t.Fatal(err)
	}
	var management string
	if err := f.pool.QueryRow(t.Context(), `SELECT agent_management_id FROM agent_registrations WHERE actor_id=$1`, f.agent).Scan(&management); err != nil {
		t.Fatal(err)
	}
	if err := service.QueueWake(t.Context(), management, f.room, "unrelated conversation wake"); err != nil {
		t.Fatal(err)
	}
	if _, err := reminder.Deliver(t.Context(), f.pool, pendingWakeID(t, f.pool, f.room), time.Now().Add(48*time.Hour), time.Minute); err != nil {
		t.Fatal(err)
	}
	if countRows(t, f.env, `SELECT count(*) FROM proactive_pending_wakes WHERE id='pwake_unscoped'`) != 0 ||
		countRows(t, f.env, `SELECT count(*) FROM messages WHERE room_id=$1 AND body LIKE '%unscoped event wake%'`, f.room) != 0 {
		t.Fatal("event wake without grant was retained or delivered")
	}
	if countRows(t, f.env, `SELECT count(*) FROM messages WHERE room_id=$1 AND body LIKE '%unrelated conversation wake%'`, f.room) != 1 {
		t.Fatal("unrelated wake stopped")
	}
}
