package integration_test

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/reminder"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func TestAgentTemplateRoutinesCopyAndRecover(t *testing.T) {
	allowParallelIntegrationTest(t)
	for _, local := range []bool{false, true} {
		t.Run(map[bool]string{false: "install", true: "interrupted install recovery"}[local], func(t *testing.T) {
			management := &recordingAgentManagement{}
			env, alice := newAgentRegistrationEnv(t, management)
			agentsPath := "/v0/tenants/" + acmeTenant + "/agents"
			code, _, raw := env.request(alice, http.MethodPost, agentsPath, map[string]any{"name": "Source", "instructions": "Source instructions.", "visibility_scope": "workspace", "runtime": fixtureRuntime("gpt-5")}, "source-agent-template")
			if code != 201 {
				t.Fatalf("source: %d %s", code, raw)
			}
			var source httpapi.TenantAgent
			decode(t, raw, &source)
			openDM := func(client *http.Client) string {
				code, _, raw := env.request(client, http.MethodPost, "/v0/tenants/"+acmeTenant+"/direct-rooms", map[string]any{"peer_actor_id": source.Actor.Id}, "")
				if code != 200 && code != 201 {
					t.Fatalf("open DM: %d %s", code, raw)
				}
				var room httpapi.Room
				decode(t, raw, &room)
				return room.Id
			}
			sourceRoom := openDM(alice)
			createRoutine := func(room, name string, cadence map[string]any, enabled, mention bool) reminder.Reminder {
				input := map[string]any{"name": name, "instruction": "Original instruction " + name, "cadence": cadence, "enabled": enabled}
				if mention {
					input["mention_actor_id"] = source.Actor.Id
				}
				code, _, raw := env.request(alice, http.MethodPost, "/v0/rooms/"+room+"/routines", input, "routine-"+strings.ReplaceAll(name, " ", "-"))
				if code != 201 {
					t.Fatalf("routine: %d %s", code, raw)
				}
				var value reminder.Reminder
				decode(t, raw, &value)
				return value
			}
			daily := map[string]any{"kind": "daily", "timezone": "Asia/Shanghai", "hour": 9, "minute": 5}
			originals := []reminder.Reminder{
				createRoutine(sourceRoom, "Daily", daily, true, true),
				createRoutine(sourceRoom, "Paused", map[string]any{"kind": "weekly", "timezone": "America/Los_Angeles", "hour": 8, "minute": 44, "weekdays": []string{"monday", "friday"}}, false, false),
				createRoutine(sourceRoom, "Interval", map[string]any{"kind": "every_n_hours", "timezone": "UTC", "interval_hours": 2}, true, true),
			}
			if _, err := env.pool.Exec(t.Context(), `UPDATE room_reminders SET created_by_actor_id=$1 WHERE id=$2`, source.Actor.Id, originals[2].ID); err != nil {
				t.Fatal(err)
			}
			// One-shot Routines, queued or done, and a listener stay out of the
			// template: their time is stale and the listener's connection is the
			// source's own.
			once := map[string]any{"kind": "once", "timezone": "UTC", "run_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}
			createRoutine(sourceRoom, "Queued once", once, true, true)
			done := createRoutine(sourceRoom, "Done once", once, true, true)
			if _, err := env.pool.Exec(t.Context(), `UPDATE room_reminders SET enabled=false, next_run_at=NULL WHERE id=$1`, done.ID); err != nil {
				t.Fatal(err)
			}
			if _, err := env.pool.Exec(t.Context(), `INSERT INTO room_reminders(id,tenant_id,room_id,created_by_actor_id,name,instruction,mention_actor_id,timezone,enabled,"trigger")
				VALUES('routine_source_listener',$1,$2,$3,'Inbox listener','New mail is judged first.',$3,'UTC',true,'[{"type":"outlook","account":"connection_source"}]')`, acmeTenant, sourceRoom, source.Actor.Id); err != nil {
				t.Fatal(err)
			}
			group := env.createRoom(alice, acmeTenant, "Group", "source-group")
			createRoutine(group, "Group only", daily, true, false)
			publishPath := "/v0/tenants/" + acmeTenant + "/agent-templates"
			publish := map[string]any{"name": "Routine template", "instructions": "Template instructions.", "source_agent_actor_id": source.Actor.Id}
			code, _, raw = env.request(alice, http.MethodPost, publishPath, publish, "publish-routine-template")
			if code != 201 {
				t.Fatalf("publish: %d %s", code, raw)
			}
			var template httpapi.AgentTemplate
			decode(t, raw, &template)
			if len(template.Routines) != 3 {
				t.Fatalf("source scope: %+v", template.Routines)
			}
			// Mutating the live source never changes the published snapshot.
			if _, err := env.pool.Exec(t.Context(), `UPDATE room_reminders SET instruction='Changed source' WHERE room_id=$1`, sourceRoom); err != nil {
				t.Fatal(err)
			}
			consumer, tenantID := alice, acmeTenant
			payload := map[string]any{"template_id": template.TemplateId, "name": "Installed", "instructions": "Template instructions.", "description": "Preserve retry request", "avatar_key": "orb-teal", "runtime": fixtureRuntime("gpt-5")}
			if local {
				// Fail in the middle of batch import: the Agent, its Room, events
				// and earlier copies all roll back with the creation transaction.
				if _, err := env.pool.Exec(t.Context(), `ALTER TABLE room_reminders ADD CONSTRAINT test_import_failure CHECK (name<>'Interval' OR template_agent_actor_id IS NULL)`); err != nil {
					t.Fatal(err)
				}
			}
			path := "/v0/tenants/" + tenantID + "/agents"
			before := time.Now()
			code, _, raw = env.request(consumer, http.MethodPost, path, payload, "install-routine-template")
			var installed httpapi.TenantAgent
			if local {
				if code != 500 {
					t.Fatalf("interrupted import: %d %s", code, raw)
				}
				if countRows(t, env, `SELECT count(*) FROM agent_registrations WHERE tenant_id=$1 AND instructions=$2`, tenantID, payload["instructions"]) != 0 ||
					countRows(t, env, `SELECT count(*) FROM actors WHERE tenant_id=$1 AND display_name='Installed'`, tenantID) != 0 {
					t.Fatal("partial installation leaked")
				}
				if _, err := env.pool.Exec(t.Context(), `ALTER TABLE room_reminders DROP CONSTRAINT test_import_failure`); err != nil {
					t.Fatal(err)
				}
				code, _, raw = env.request(consumer, http.MethodPost, path, payload, "install-routine-template")
			}
			if code != 201 {
				t.Fatalf("install: %d %s", code, raw)
			}
			decode(t, raw, &installed)
			var roomID, humanID string
			if err := env.pool.QueryRow(t.Context(), `SELECT id,direct_human_actor_id FROM rooms WHERE direct_agent_actor_id=$1`, installed.Actor.Id).Scan(&roomID, &humanID); err != nil {
				t.Fatal(err)
			}
			code, _, raw = env.request(consumer, http.MethodGet, "/v0/rooms/"+roomID+"/routines", nil, "")
			if code != 200 {
				t.Fatalf("list copies: %d %s", code, raw)
			}
			var page struct {
				Items []reminder.Reminder `json:"items"`
			}
			decode(t, raw, &page)
			if len(page.Items) != 3 {
				t.Fatalf("copies: %s", raw)
			}
			var dailyCopy, pausedCopy reminder.Reminder
			for _, copy := range page.Items {
				if copy.RoomID != roomID || copy.Instruction != "Original instruction "+copy.Name || copy.Revision != 1 {
					t.Fatalf("copy content: %+v", copy)
				}
				for _, original := range originals {
					if copy.ID == original.ID {
						t.Fatal("source ID reused")
					}
				}
				if copy.Name == "Paused" {
					pausedCopy = copy
					if copy.Enabled || copy.NextRunAt != nil || copy.MentionActorID != nil || copy.Cadence.Timezone != "America/Los_Angeles" || len(copy.Cadence.Weekdays) != 2 {
						t.Fatalf("paused: %+v", copy)
					}
				} else {
					if !copy.Enabled || copy.NextRunAt == nil || !copy.NextRunAt.After(before) || copy.MentionActorID == nil || *copy.MentionActorID != installed.Actor.Id {
						t.Fatalf("active schedule: %+v", copy)
					}
				}
				wantCreator := humanID
				if copy.Name == "Interval" {
					wantCreator = installed.Actor.Id
				}
				if copy.CreatedByActorID != wantCreator {
					t.Fatalf("creator: %+v", copy)
				}
				if copy.Name == "Daily" {
					dailyCopy = copy
				}
			}
			// A successful replay must not overwrite edited or deleted copies.
			code, _, raw = env.request(consumer, http.MethodPatch, "/v0/routines/"+dailyCopy.ID, map[string]any{"expected_revision": dailyCopy.Revision, "name": "Edited copy"}, "edit-copy")
			if code != 200 {
				t.Fatalf("edit: %d %s", code, raw)
			}
			code, _, raw = env.request(consumer, http.MethodPost, path, payload, "install-routine-template")
			if code != 201 {
				t.Fatalf("replay: %d %s", code, raw)
			}
			if countRows(t, env, `SELECT count(*) FROM room_reminders WHERE template_agent_actor_id=$1`, installed.Actor.Id) != 3 || countRows(t, env, `SELECT count(*) FROM room_reminders WHERE id=$1 AND name='Edited copy'`, dailyCopy.ID) != 1 {
				t.Fatal("replay changed copies")
			}
			// Hold deletion after its pause scan. An enable request can still
			// read the old active registration, but must wait on the paused
			// copy and lose its revision check after deletion commits.
			deleting, err := env.pool.Begin(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			defer deleting.Rollback(context.Background())
			queries := store.New(deleting)
			if n, err := queries.RevokeAgentRegistration(t.Context(), store.RevokeAgentRegistrationParams{ActorID: installed.Actor.Id, TenantID: tenantID}); err != nil || n != 1 {
				t.Fatalf("revoke Agent: %d %v", n, err)
			}
			if err := reminder.PauseTemplateRoutinesInTx(t.Context(), queries, installed.Actor.Id, humanID); err != nil {
				t.Fatal(err)
			}
			enableDone := make(chan asyncHTTPResult, 1)
			if err := startAsyncJSONRequest(enableDone, "enable", consumer, http.MethodPatch, env.server.URL+"/v0/routines/"+pausedCopy.ID, "enable-during-deletion", map[string]any{"expected_revision": pausedCopy.Revision, "enabled": true}); err != nil {
				t.Fatal(err)
			}
			waitForBlockedQuery(t, env, "LockRoomReminder")
			if err := deleting.Commit(t.Context()); err != nil {
				t.Fatal(err)
			}
			select {
			case result := <-enableDone:
				if result.err != nil || result.status != http.StatusConflict {
					t.Fatalf("enable raced deletion: %+v", result)
				}
			case <-time.After(30 * time.Second):
				t.Fatal("enable did not finish after deletion committed")
			}
			code, _, raw = env.request(consumer, http.MethodDelete, path+"/"+installed.Actor.Id, nil, "")
			if code != 204 {
				t.Fatalf("deletion replay: %d %s", code, raw)
			}
			if countRows(t, env, `SELECT count(*) FROM room_reminders WHERE template_agent_actor_id=$1 AND (enabled OR next_run_at IS NOT NULL)`, installed.Actor.Id) != 0 {
				t.Fatal("deleting Agent still schedules copies")
			}
			if countRows(t, env, `SELECT count(*) FROM rooms WHERE id=$1 AND deleted_at IS NULL`, roomID) != 1 {
				t.Fatal("history was removed")
			}
			var accountID string
			if err := env.pool.QueryRow(t.Context(), `SELECT account_id FROM actors WHERE id=$1`, humanID).Scan(&accountID); err != nil {
				t.Fatal(err)
			}
			if _, err := reminder.New(env.pool).RunNow(t.Context(), reminder.HumanCaller(accountID), dailyCopy.ID, "run-deleting", []byte("run")); !errors.Is(err, reminder.ErrTemplateAgentUnavailable) {
				t.Fatalf("deleted Agent run: %v", err)
			}
		})
	}
}

// A template copy skips the occurrence while its Agent is not active, so its
// schedule goes on instead of retrying forever. Running or enabling it says
// the Agent is unavailable.
func TestTemplateRoutineSkipsAnInactiveAgent(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newWorkItemAgentEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := env.createRoom(alice, acmeTenant, "Template copy "+suffix, "template-copy-"+suffix)
	copyID := insertDueAgentRoutine(t, env, roomID, "actor_acme_alice", "", "template-copy-"+suffix)
	agentStatus := func(status string) {
		t.Helper()
		if _, err := env.pool.Exec(t.Context(), `UPDATE agent_registrations SET status=$1 WHERE actor_id='actor_acme_official' AND tenant_id=$2`, status, acmeTenant); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := env.pool.Exec(t.Context(), `UPDATE room_reminders SET template_agent_actor_id='actor_acme_official', template_routine_key='copy' WHERE id=$1`, copyID); err != nil {
		t.Fatal(err)
	}
	agentStatus("revoked")
	// The repair sweep enqueues the overdue occurrence and the worker runs it.
	for _, result := range runReminderWorker(t, env) {
		if result.ReminderID == copyID {
			t.Fatalf("copy fired for a revoked Agent: %+v", result)
		}
	}
	if countRows(t, env, `SELECT count(*) FROM room_reminders WHERE id=$1 AND next_run_at>now()`, copyID) != 1 ||
		countRows(t, env, `SELECT count(*) FROM river_job WHERE kind='reminder.fire' AND args->>'reminder_id'=$1 AND state='scheduled'`, copyID) != 1 {
		t.Fatal("skipped occurrence did not move the copy to its next one")
	}
	if countRows(t, env, `SELECT count(*) FROM messages WHERE room_id=$1 AND body LIKE '%template-copy-%'`, roomID) != 0 {
		t.Fatal("a skipped occurrence posted a message")
	}
	var revision int64
	if err := env.pool.QueryRow(t.Context(), `UPDATE room_reminders SET enabled=false, next_run_at=NULL, revision=revision+1 WHERE id=$1 RETURNING revision`, copyID).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	code, _, raw := env.request(alice, http.MethodPost, "/v0/routines/"+copyID+"/run", nil, "run-revoked-"+suffix)
	if code != http.StatusConflict || !strings.Contains(string(raw), "ROUTINE_AGENT_UNAVAILABLE") {
		t.Fatalf("run for a revoked Agent: %d %s", code, raw)
	}
	code, _, raw = env.request(alice, http.MethodPatch, "/v0/routines/"+copyID, map[string]any{"expected_revision": revision, "enabled": true}, "enable-revoked-"+suffix)
	if code != http.StatusConflict || !strings.Contains(string(raw), "ROUTINE_AGENT_UNAVAILABLE") {
		t.Fatalf("enable for a revoked Agent: %d %s", code, raw)
	}
}
