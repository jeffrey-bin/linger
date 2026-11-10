package integration_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/riverqueue/river"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/reminder"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func TestRoomRemindersCreatePauseAndFire(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newWorkItemAgentEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := env.createRoom(alice, acmeTenant, "Reminders "+suffix, "reminders-room-"+suffix)
	if status, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); status != http.StatusOK {
		t.Fatalf("add Agent: %d %s", status, body)
	}
	t.Run("weekly selection persistence and competing schedulers", func(t *testing.T) {
		days := []string{"monday", "tuesday", "wednesday", "thursday", "friday"}
		cadence := map[string]any{"kind": "weekly", "timezone": "Asia/Shanghai", "hour": 21, "minute": 0, "weekdays": days}
		payload := map[string]any{"name": "Weekdays", "instruction": "Time to leave.", "cadence": cadence}
		code, _, raw := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/routines", payload, "weekly-"+suffix)
		if code != http.StatusCreated {
			t.Fatalf("weekly create: %d %s", code, raw)
		}
		var weekly reminder.Reminder
		decode(t, raw, &weekly)
		if !slices.Equal(weekly.Cadence.Weekdays, days) {
			t.Fatalf("weekly response: %s", raw)
		}
		var saved []string
		if err := env.pool.QueryRow(t.Context(), `SELECT weekdays FROM room_reminders WHERE id=$1`, weekly.ID).Scan(&saved); err != nil || !slices.Equal(saved, days) {
			t.Fatalf("saved=%v err=%v", saved, err)
		}
		// The form sends all selected weekdays and can save the rename.
		code, _, raw = env.request(alice, http.MethodPatch, "/v0/routines/"+weekly.ID, map[string]any{"expected_revision": weekly.Revision, "name": "Renamed by refreshed browser", "cadence": cadence}, "refreshed-weekly-"+suffix)
		if code != http.StatusOK {
			t.Fatalf("refreshed edit: %d %s", code, raw)
		}
		previousRevision := weekly.Revision
		decode(t, raw, &weekly)
		if weekly.Name != "Renamed by refreshed browser" || weekly.Revision != previousRevision+1 || !slices.Equal(weekly.Cadence.Weekdays, days) {
			t.Fatalf("refreshed edit lost name or days: %s", raw)
		}
		for _, enabled := range []bool{false, true} {
			code, _, raw = env.request(alice, http.MethodPatch, "/v0/routines/"+weekly.ID, map[string]any{"expected_revision": weekly.Revision, "enabled": enabled}, "toggle-weekly-"+strconv.FormatBool(enabled)+suffix)
			if code != http.StatusOK {
				t.Fatalf("toggle: %d %s", code, raw)
			}
			decode(t, raw, &weekly)
			if !slices.Equal(weekly.Cadence.Weekdays, days) {
				t.Fatalf("toggle lost days: %s", raw)
			}
		}
		if _, err := env.pool.Exec(t.Context(), `UPDATE room_reminders SET next_run_at=now()-interval '10 days' WHERE id=$1`, weekly.ID); err != nil {
			t.Fatal(err)
		}
		// Two jobs for one occurrence, as a lost enqueue or a copied row could
		// leave, must deliver it once: the second finds the Reminder advanced.
		duplicateReminderOccurrenceJob(t, env, weekly.ID)
		fires := 0
		for _, result := range runReminderWorker(t, env) {
			if result.ReminderID != weekly.ID {
				continue
			}
			fires++
			if !result.NextRunAt.After(time.Now()) {
				t.Fatalf("fire=%+v", result)
			}
		}
		if fires != 1 {
			t.Fatalf("duplicate occurrence fires=%d", fires)
		}
		for _, result := range runReminderWorker(t, env) {
			if result.ReminderID == weekly.ID {
				t.Fatalf("restarted worker repeated fire: %+v", result)
			}
		}
		if _, err := env.pool.Exec(t.Context(), `DELETE FROM room_reminders WHERE id=$1`, weekly.ID); err != nil {
			t.Fatal(err)
		}
	})
	hours := 1
	status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/routines", map[string]any{
		"name":             "Standup",
		"instruction":      "Standup time",
		"mention_actor_id": "actor_acme_official",
		"cadence":          map[string]any{"kind": "every_n_hours", "timezone": "UTC", "interval_hours": hours},
	}, "create-routine-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("create: %d %s", status, body)
	}
	var created struct {
		ID       string `json:"id"`
		Revision int64  `json:"revision"`
		Enabled  bool   `json:"enabled"`
	}
	decode(t, body, &created)
	if !created.Enabled || created.ID == "" {
		t.Fatalf("created: %+v", created)
	}
	status, _, body = env.request(alice, http.MethodGet, "/v0/rooms/"+roomID+"/routines", nil, "")
	if status != http.StatusOK || !strings.Contains(string(body), created.ID) || !strings.Contains(string(body), "Standup time") {
		t.Fatalf("list: %d %s", status, body)
	}
	status, _, body = env.request(alice, http.MethodPatch, "/v0/routines/"+created.ID, map[string]any{
		"expected_revision": created.Revision, "enabled": false,
	}, "pause-reminder-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("pause: %d %s", status, body)
	}
	decode(t, body, &created)
	status, _, body = env.request(alice, http.MethodPatch, "/v0/routines/"+created.ID, map[string]any{
		"expected_revision": created.Revision, "enabled": true,
	}, "resume-reminder-"+suffix)
	if status != http.StatusOK {
		t.Fatalf("resume: %d %s", status, body)
	}
	decode(t, body, &created)
	fired := fireReminderOccurrence(t, env, created.ID)
	if fired.MentionDropped {
		t.Fatal("fire dropped the Agent mention")
	}
	var mentions int
	if err := env.pool.QueryRow(t.Context(), `SELECT cardinality(mentioned_actor_ids) FROM messages WHERE id=$1`, fired.MessageID).Scan(&mentions); err != nil {
		t.Fatal(err)
	}
	if mentions != 1 {
		t.Fatalf("mentions=%d", mentions)
	}
	var messageKind string
	if err := env.pool.QueryRow(t.Context(), `SELECT message_kind FROM messages WHERE id=$1`, fired.MessageID).Scan(&messageKind); err != nil {
		t.Fatal(err)
	}
	if messageKind != "agent_runtime" {
		t.Fatalf("Agent-targeted Routine message kind=%s", messageKind)
	}
	var firedName string
	if err := env.pool.QueryRow(t.Context(), `SELECT payload->>'routine_name' FROM room_events
		WHERE room_id=$1 AND event_type='routine.changed' AND resource_id=$2
		AND payload->>'change_kind'='fired' ORDER BY room_seq DESC LIMIT 1`, roomID, created.ID).Scan(&firedName); err != nil || firedName != "Standup" {
		t.Fatalf("fired Routine name=%q err=%v", firedName, err)
	}
	status, _, body = env.request(alice, http.MethodGet, "/v0/rooms/"+roomID+"/messages?limit=50", nil, "")
	if status != http.StatusOK || strings.Contains(string(body), fired.MessageID) {
		t.Fatalf("Agent-targeted Routine instruction leaked into Human chat: %d %s", status, body)
	}
	responseID := replyToFiredRoutine(t, env, roomID, fired.MessageID, suffix)
	status, _, body = env.request(alice, http.MethodGet, "/v0/rooms/"+roomID+"/messages?limit=50", nil, "")
	if status != http.StatusOK || !strings.Contains(string(body), `"routine_name":"Standup"`) {
		t.Fatalf("Routine reply label missing from Room Messages: %d %s", status, body)
	}
	status, _, body = env.request(alice, http.MethodGet, "/v0/rooms/"+roomID+"/messages/"+responseID, nil, "")
	if status != http.StatusOK || !strings.Contains(string(body), `"routine_name":"Standup"`) {
		t.Fatalf("Routine reply label missing from Message: %d %s", status, body)
	}
	if got := messageAuthor(t, env, fired.MessageID); got != "actor_acme_alice" {
		t.Fatalf("human routine author=%s", got)
	}
	status, _, body = env.request(alice, http.MethodDelete, "/v0/rooms/"+roomID+"/members/actor_acme_official", nil, "")
	if status != http.StatusOK && status != http.StatusNoContent {
		t.Fatalf("remove Agent: %d %s", status, body)
	}
	fired = fireReminderOccurrence(t, env, created.ID)
	if !fired.MentionDropped {
		t.Fatalf("fire without member dropped=%v", fired.MentionDropped)
	}
	if err := env.pool.QueryRow(t.Context(), `SELECT cardinality(mentioned_actor_ids) FROM messages WHERE id=$1`, fired.MessageID).Scan(&mentions); err != nil {
		t.Fatal(err)
	}
	if mentions != 0 {
		t.Fatalf("stripped mentions=%d", mentions)
	}
	status, _, body = env.request(alice, http.MethodGet, "/v0/rooms/"+roomID+"/messages?limit=50", nil, "")
	if status != http.StatusOK || !strings.Contains(string(body), fired.MessageID) {
		t.Fatalf("Routine without an Agent target should remain visible: %d %s", status, body)
	}
	if _, err := env.pool.Exec(t.Context(), `DELETE FROM room_reminders WHERE id=$1`, created.ID); err != nil {
		t.Fatal(err)
	}
	status, _, body = env.request(alice, http.MethodGet, "/v0/rooms/"+roomID+"/messages/"+responseID, nil, "")
	if status != http.StatusOK || !strings.Contains(string(body), `"routine_name":"Standup"`) {
		t.Fatalf("Routine reply lost its snapshotted name after deletion: %d %s", status, body)
	}
}

// A one-shot follow-up the replying Agent scheduled for itself is not labelled;
// Human, recurring Agent, and template Routines keep their label.
func TestRoutineReplyLabelSkipsAgentSelfScheduledFollowUp(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newWorkItemAgentEnv(t)
	service := reminder.New(env.pool)
	hours := 1
	runAt := time.Now().Add(time.Hour)
	once := reminder.Cadence{Kind: "once", Timezone: "UTC", RunAt: &runAt}
	recurring := reminder.Cadence{Kind: "every_n_hours", Timezone: "UTC", IntervalHours: &hours}
	agent := "actor_acme_official"
	cases := []struct {
		name    string
		labeled bool
		create  func(t *testing.T, roomID, suffix string) string
		after   func(t *testing.T, roomID, routineID string)
	}{
		{name: "self once deleted", create: func(t *testing.T, roomID, suffix string) string {
			return createAgentRoutine(t, service, roomID, suffix, once)
		}, after: func(t *testing.T, roomID, routineID string) {
			authority := reminder.Authority{TenantID: acmeTenant, RoomID: roomID, ActorID: agent}
			if _, err := service.Delete(t.Context(), reminder.AgentCaller(authority), routineID, "delete-"+routineID, requestHash(routineID), 0); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "self once kept", create: func(t *testing.T, roomID, suffix string) string {
			return createAgentRoutine(t, service, roomID, suffix, once)
		}},
		{name: "agent recurring", labeled: true, create: func(t *testing.T, roomID, suffix string) string {
			return createAgentRoutine(t, service, roomID, suffix, recurring)
		}},
		{name: "human once", labeled: true, create: func(t *testing.T, roomID, suffix string) string {
			status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/routines", map[string]any{
				"name": "Follow up", "instruction": "Follow up", "mention_actor_id": agent,
				"cadence": map[string]any{"kind": "once", "timezone": "UTC", "run_at": runAt.Format(time.RFC3339)},
			}, "human-"+suffix)
			if status != http.StatusCreated {
				t.Fatalf("create: %d %s", status, body)
			}
			var created reminder.Reminder
			decode(t, body, &created)
			return created.ID
		}},
		{name: "template", labeled: true, create: func(t *testing.T, roomID, suffix string) string {
			role := "agent"
			tx, err := env.pool.Begin(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(t.Context())
			if err := reminder.InstallTemplateInTx(t.Context(), tx, store.New(tx), reminder.Authority{TenantID: acmeTenant, RoomID: roomID, ActorID: "actor_acme_alice"}, agent, []reminder.TemplateRoutine{{
				Key: "follow-up-" + suffix, Name: "Follow up", Instruction: "Follow up", Cadence: recurring, Enabled: true, CreatedByRole: "agent", MentionRole: &role,
			}}); err != nil {
				t.Fatal(err)
			}
			if err := tx.Commit(t.Context()); err != nil {
				t.Fatal(err)
			}
			var id string
			if err := env.pool.QueryRow(t.Context(), `SELECT id FROM room_reminders WHERE room_id=$1`, roomID).Scan(&id); err != nil {
				t.Fatal(err)
			}
			return id
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
			roomID := env.createRoom(alice, acmeTenant, "Routine label "+suffix, "routine-label-"+suffix)
			if status, body := putRoomMember(t, env, alice, roomID, agent, "member"); status != http.StatusOK {
				t.Fatalf("add Agent: %d %s", status, body)
			}
			routineID := tc.create(t, roomID, suffix)
			fired := fireReminderOccurrence(t, env, routineID)
			if fired.MentionDropped {
				t.Fatal("fire dropped the Agent mention")
			}
			responseID := replyToFiredRoutine(t, env, roomID, fired.MessageID, suffix)
			if tc.after != nil {
				tc.after(t, roomID, routineID)
			}
			status, _, body := env.request(alice, http.MethodGet, "/v0/rooms/"+roomID+"/messages/"+responseID, nil, "")
			if status != http.StatusOK || strings.Contains(string(body), `"routine_name":"Follow up"`) != tc.labeled {
				t.Fatalf("labeled=%v: %d %s", tc.labeled, status, body)
			}
		})
	}
}

func createAgentRoutine(t *testing.T, service *reminder.Service, roomID, suffix string, cadence reminder.Cadence) string {
	t.Helper()
	agent := "actor_acme_official"
	authority := reminder.Authority{TenantID: acmeTenant, RoomID: roomID, ActorID: agent}
	created, err := service.Create(t.Context(), reminder.AgentCaller(authority), roomID, "create-"+suffix, requestHash(suffix), reminder.CreateInput{
		Name: "Follow up", Instruction: "Follow up", MentionActorID: &agent, Cadence: cadence,
	})
	if err != nil {
		t.Fatal(err)
	}
	return created.Value.ID
}

func requestHash(value string) []byte {
	sum := sha256.Sum256([]byte(value))
	return sum[:]
}

func TestAgentRoutineSelfMentionFiresAsHuman(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newWorkItemAgentEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)

	oneHuman := env.createRoom(alice, acmeTenant, "One human "+suffix, "routine-one-human-"+suffix)
	if status, body := putRoomMember(t, env, alice, oneHuman, "actor_acme_official", "member"); status != http.StatusOK {
		t.Fatalf("add Agent: %d %s", status, body)
	}
	oneSelfID := insertDueAgentRoutine(t, env, oneHuman, "actor_acme_official", "actor_acme_official", "self-one-"+suffix)
	fired := fireDueRoutine(t, env, oneSelfID)
	if fired.MentionDropped || messageAuthor(t, env, fired.MessageID) != "actor_acme_alice" {
		t.Fatalf("one-human fire dropped=%v author=%s", fired.MentionDropped, messageAuthor(t, env, fired.MessageID))
	}
	var kind string
	if err := env.pool.QueryRow(t.Context(), `SELECT message_kind FROM messages WHERE id=$1`, fired.MessageID).Scan(&kind); err != nil {
		t.Fatal(err)
	}
	if kind != "agent_runtime" {
		t.Fatalf("Agent-created self-mention Routine message kind=%s", kind)
	}

	plainID := insertDueAgentRoutine(t, env, oneHuman, "actor_acme_official", "", "plain-"+suffix)
	fired = fireDueRoutine(t, env, plainID)
	if fired.MentionDropped || messageAuthor(t, env, fired.MessageID) != "actor_acme_official" {
		t.Fatalf("plain fire dropped=%v author=%s", fired.MentionDropped, messageAuthor(t, env, fired.MessageID))
	}

	direct := env.createRoom(alice, acmeTenant, "Direct "+suffix, "routine-direct-"+suffix)
	if status, body := putRoomMember(t, env, alice, direct, "actor_acme_official", "member"); status != http.StatusOK {
		t.Fatalf("add Agent: %d %s", status, body)
	}
	if _, err := env.pool.Exec(t.Context(), `
UPDATE rooms SET direct_human_actor_id='actor_acme_alice',direct_agent_actor_id='actor_acme_official'
WHERE id=$1 AND tenant_id=$2`, direct, acmeTenant); err != nil {
		t.Fatal(err)
	}
	directID := insertDueAgentRoutine(t, env, direct, "actor_acme_official", "actor_acme_official", "self-direct-"+suffix)
	fired = fireDueRoutine(t, env, directID)
	if fired.MentionDropped || messageAuthor(t, env, fired.MessageID) != "actor_acme_alice" {
		t.Fatalf("direct fire dropped=%v author=%s", fired.MentionDropped, messageAuthor(t, env, fired.MessageID))
	}
}

// insertDueAgentRoutine inserts an overdue Routine with no schedule job. The
// occurrence job is restored by the same repair sweep that serves production.
func insertDueAgentRoutine(t *testing.T, env *testEnv, roomID, createdBy, mention, name string) string {
	t.Helper()
	var mentionArg any
	if mention != "" {
		mentionArg = mention
	}
	id := "routine_" + name
	if _, err := env.pool.Exec(t.Context(), `
INSERT INTO room_reminders (
  id, tenant_id, room_id, created_by_actor_id, name, instruction, mention_actor_id,
  cadence_kind, timezone, interval_hours, enabled, next_run_at
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, 'every_n_hours', 'UTC', 1, true, now()-interval '3 minutes'
)`, id, acmeTenant, roomID, createdBy, name, name+" instruction", mentionArg); err != nil {
		t.Fatal(err)
	}
	return id
}

func fireDueRoutine(t *testing.T, env *testEnv, reminderID string) reminder.ScheduleResult {
	t.Helper()
	return fireReminderOccurrence(t, env, reminderID)
}

// markReminderOverdue makes the Reminder's current occurrence overdue enough for
// the repair sweep, the path that restores a lost occurrence job.
func markReminderOverdue(t *testing.T, env *testEnv, reminderID string) {
	t.Helper()
	if _, err := env.pool.Exec(t.Context(), `UPDATE room_reminders SET next_run_at=now()-interval '3 minutes' WHERE id=$1`, reminderID); err != nil {
		t.Fatal(err)
	}
}

// fireReminderOccurrence makes one Reminder overdue and drives the schedule
// worker until its occurrence is delivered. It fails unless exactly that
// occurrence delivered.
func fireReminderOccurrence(t *testing.T, env *testEnv, reminderID string) reminder.ScheduleResult {
	t.Helper()
	markReminderOverdue(t, env, reminderID)
	var found []reminder.ScheduleResult
	for _, result := range runReminderWorker(t, env) {
		if result.ReminderID == reminderID {
			found = append(found, result)
		}
	}
	if len(found) != 1 {
		t.Fatalf("fires for Reminder %s=%d want 1", reminderID, len(found))
	}
	return found[0]
}

// duplicateReminderOccurrenceJob copies the Reminder's current occurrence job
// with no uniqueness key, as a row restored outside River's insert path would.
func duplicateReminderOccurrenceJob(t *testing.T, env *testEnv, reminderID string) {
	t.Helper()
	if _, err := env.pool.Exec(t.Context(), `
INSERT INTO river_job(kind, queue, args, max_attempts, scheduled_at)
SELECT 'reminder.fire', 'schedule',
       jsonb_build_object('reminder_id', id, 'due_at', to_char(next_run_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
       10, now()
FROM room_reminders WHERE id=$1`, reminderID); err != nil {
		t.Fatal(err)
	}
}

// runReminderWorker restores overdue occurrence jobs, then processes every due
// reminder job on a River client. It returns the occurrences that delivered.
func runReminderWorker(t *testing.T, env *testEnv) []reminder.ScheduleResult {
	t.Helper()
	enqueueOverdueReminderJobs(t, env)
	return drainReminderJobs(t, env)
}

func enqueueOverdueReminderJobs(t *testing.T, env *testEnv) {
	t.Helper()
	if err := reminder.New(env.pool).EnqueueOverdueOccurrences(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func drainReminderJobs(t *testing.T, env *testEnv) []reminder.ScheduleResult {
	t.Helper()
	var mu sync.Mutex
	var delivered []reminder.ScheduleResult
	workers := river.NewWorkers()
	reminder.AddJobWorkers(workers, reminder.New(env.pool), func(result reminder.ScheduleResult) {
		mu.Lock()
		defer mu.Unlock()
		delivered = append(delivered, result)
	}, slog.Default())
	client, err := jobs.NewClient(env.pool, jobs.Options{Workers: workers, PollInterval: riverTestPollInterval, TestOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Start(t.Context()); err != nil {
		t.Fatal(err)
	}
	defer func() {
		stopCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = client.Stop(stopCtx)
	}()
	deadline := time.Now().Add(15 * time.Second)
	// The slack covers the River client and the database clocks disagreeing by a
	// few milliseconds; a Routine's next occurrence is at least an hour away.
	for countRows(t, env, `SELECT count(*) FROM river_job
		WHERE kind='reminder.fire' AND state IN ('available','scheduled','running','retryable') AND scheduled_at<=now()+interval '5 seconds'`) > 0 {
		if time.Now().After(deadline) {
			t.Fatal("Reminder jobs did not drain")
		}
		time.Sleep(20 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	return slices.Clone(delivered)
}

func messageAuthor(t *testing.T, env *testEnv, messageID string) string {
	t.Helper()
	var author string
	if err := env.pool.QueryRow(t.Context(), `SELECT author_actor_id FROM messages WHERE id=$1`, messageID).Scan(&author); err != nil {
		t.Fatal(err)
	}
	return author
}

// replyToFiredRoutine claims the Local Run a fired Routine's Agent instruction
// queued and commits the Agent's reply through the CLI endpoint.
func replyToFiredRoutine(t *testing.T, env *testEnv, roomID, firedMessageID, suffix string) string {
	t.Helper()
	runtime := agentruntimestate.New(env.pool)
	ensured, err := runtime.EnsureContext(t.Context(), agentruntimestate.EnsureContextInput{Ref: agentruntimestate.ContextRef{
		Kind: "meta", AgentID: acmeOfficialAgentManagementID, RoomID: roomID,
	}, TargetResidency: "active",
	})
	if err != nil {
		t.Fatal(err)
	}
	startRuntimeEpoch(t, runtime, "routine-label-test")
	fence := "routine-label-test"
	inputID := "routine-input-" + suffix
	inboxID := "room:" + roomID
	requeueCommittedRoomMessage(t, env.pool, firedMessageID)
	runID := queuedRuntimeInbox(t, env.pool, ensured.Context.ContextKey, firedMessageID).RunID
	if runID == "" {
		t.Fatal("targeted Routine instruction queued no Run")
	}
	if _, err := runtime.ClaimLocalRun(t.Context(), agentruntimestate.ClaimLocalRunInput{ClaimID: "claim-" + inputID, ContextKey: ensured.Context.ContextKey, Epoch: fence}); err != nil {
		t.Fatal(err)
	}
	if _, err := runtime.OpenRuntimeStatus(t.Context(), agentruntimestate.OpenStatusInput{ContextKey: ensured.Context.ContextKey, Epoch: fence, LocalRunID: runID, InitialSourceIDs: []string{inboxID}}); err != nil {
		t.Fatal(err)
	}
	credential, err := agentcredential.New(env.pool).IssueManaged(t.Context(), acmeOfficialAgentManagementID, "Routine CLI reply")
	if err != nil {
		t.Fatal(err)
	}
	return sendRoutineCLIReply(t, env, credential.AccessToken, roomID, runID)
}

// Exercise the exact multipart HTTP endpoint used by teamhub message send.
func sendRoutineCLIReply(t *testing.T, env *testEnv, token, roomID, runID string) string {
	t.Helper()
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	metadata, _ := json.Marshal(map[string]any{
		"invocation_id": "agent-invocation-sha256:" + hex.EncodeToString(requestHash(runID)),
		"inbox_id":      "room:" + roomID,
		"segments":      []map[string]string{{"type": "text", "content": "Routine reply"}}, "uploads": []any{},
	})
	if err := writer.WriteField("metadata", string(metadata)); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, env.server.URL+"/api/agent/v1/messages/commit", &buffer)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	// The Room's Meta CLI sends its configured Room Context.
	req.Header.Set("X-TeamHub-Context-Kind", "room")
	req.Header.Set("X-TeamHub-Context-Id", roomID)
	req.Header.Set("X-TeamHub-Run-Id", runID)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("CLI commit: %d %s err=%v", resp.StatusCode, body, err)
	}
	var result struct {
		MessageID string `json:"message_id"`
	}
	decode(t, body, &result)
	return result.MessageID
}

func TestReminderOccurrenceJobsAreStaleAfterEditOrDelete(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newWorkItemAgentEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := env.createRoom(alice, acmeTenant, "Stale "+suffix, "reminder-stale-"+suffix)
	create := func(name string) reminder.Reminder {
		t.Helper()
		code, _, raw := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/routines", map[string]any{
			"name": name, "instruction": name + " instruction",
			"cadence": map[string]any{"kind": "every_n_hours", "timezone": "UTC", "interval_hours": 1},
		}, "create-"+name+suffix)
		if code != http.StatusCreated {
			t.Fatalf("create %s: %d %s", name, code, raw)
		}
		var created reminder.Reminder
		decode(t, raw, &created)
		return created
	}
	edited := create("Edited")
	code, _, raw := env.request(alice, http.MethodPatch, "/v0/routines/"+edited.ID, map[string]any{
		"expected_revision": edited.Revision,
		"cadence":           map[string]any{"kind": "every_n_hours", "timezone": "UTC", "interval_hours": 2},
	}, "edit-"+suffix)
	if code != http.StatusOK {
		t.Fatalf("edit: %d %s", code, raw)
	}
	deleted := create("Deleted")
	if _, err := env.pool.Exec(t.Context(), `DELETE FROM room_reminders WHERE id=$1`, deleted.ID); err != nil {
		t.Fatal(err)
	}
	// Make the superseded and deleted occurrence jobs due. Their due times no
	// longer match the Reminder, so they must not deliver. The edited Reminder's
	// current job stays scheduled.
	if _, err := env.pool.Exec(t.Context(), `UPDATE river_job job SET scheduled_at=now()-interval '1 minute'
		WHERE job.kind='reminder.fire' AND job.state='scheduled' AND job.args->>'reminder_id' IN ($1,$2)
		  AND (job.args->>'due_at')::timestamptz IS DISTINCT FROM (
		    SELECT reminder.next_run_at FROM room_reminders reminder WHERE reminder.id=job.args->>'reminder_id')`, edited.ID, deleted.ID); err != nil {
		t.Fatal(err)
	}
	for _, result := range runReminderWorker(t, env) {
		if result.ReminderID == edited.ID || result.ReminderID == deleted.ID {
			t.Fatalf("stale occurrence delivered: %+v", result)
		}
	}
	if got := countRows(t, env, `SELECT count(*) FROM river_job WHERE kind='reminder.fire' AND args->>'reminder_id'=$1 AND state='completed'`, deleted.ID); got != 1 {
		t.Fatalf("stale job for deleted Reminder completed=%d want 1", got)
	}
}

// Routine writes lock the Routine before comparing revisions and recheck the
// caller inside the write: a patch to one-shot respects the pending limit, a
// Human removed from the Room is refused, a repeated delete finds no Routine, a patch
// waiting on a fire keeps the fire's schedule, and a deleted Tracking Item
// takes its Routines with a recorded deletion.
func TestRoutineWritesLockAndRecheck(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newWorkItemAgentEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := env.createRoom(alice, acmeTenant, "Routine writes "+suffix, "routine-writes-"+suffix)
	hourly := map[string]any{"kind": "every_n_hours", "timezone": "UTC", "interval_hours": 1}
	create := func(t *testing.T, name string) reminder.Reminder {
		t.Helper()
		code, _, raw := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/routines", map[string]any{"name": name, "instruction": name, "cadence": hourly}, "create-"+name+"-"+suffix)
		if code != http.StatusCreated {
			t.Fatalf("create %s: %d %s", name, code, raw)
		}
		var created reminder.Reminder
		decode(t, raw, &created)
		return created
	}

	t.Run("patch to one-shot respects the pending limit", func(t *testing.T) {
		routine := create(t, "to-once")
		if _, err := env.pool.Exec(t.Context(), `INSERT INTO room_reminders (id, tenant_id, room_id, created_by_actor_id, name, instruction, cadence_kind, timezone, run_at, enabled, next_run_at)
			SELECT 'routine_pending_'||n, $1, $2, 'actor_acme_alice', 'Pending '||n, 'Pending', 'once', 'UTC', now()+interval '1 day', true, now()+interval '1 day'
			FROM generate_series(1, 20) n`, acmeTenant, roomID); err != nil {
			t.Fatal(err)
		}
		defer func() {
			if _, err := env.pool.Exec(t.Context(), `DELETE FROM room_reminders WHERE id LIKE 'routine_pending_%'`); err != nil {
				t.Fatal(err)
			}
		}()
		once := map[string]any{"kind": "once", "timezone": "UTC", "run_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}
		code, _, raw := env.request(alice, http.MethodPatch, "/v0/routines/"+routine.ID, map[string]any{"expected_revision": routine.Revision, "cadence": once}, "to-once-"+suffix)
		if code != http.StatusConflict || !strings.Contains(string(raw), "REMINDER_LIMIT_REACHED") {
			t.Fatalf("patch past the one-shot limit: %d %s", code, raw)
		}
	})

	t.Run("a repeated delete finds no Routine", func(t *testing.T) {
		routine := create(t, "deleted")
		path := "/v0/routines/" + routine.ID + "?expected_revision=" + strconv.FormatInt(routine.Revision, 10)
		for attempt, want := range []int{http.StatusNoContent, http.StatusNotFound} {
			code, _, raw := env.request(alice, http.MethodDelete, path, nil, "")
			if code != want {
				t.Fatalf("delete attempt %d: %d %s", attempt, code, raw)
			}
		}
	})

	t.Run("a patch waiting on a fire keeps the fire's schedule", func(t *testing.T) {
		routine := create(t, "racing")
		tx, err := env.pool.Begin(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(t.Context()) }()
		// The fire holds the Routine while it moves the schedule on.
		var advanced time.Time
		if err := tx.QueryRow(t.Context(), `UPDATE room_reminders SET next_run_at=next_run_at+interval '1 hour' WHERE id=$1 RETURNING next_run_at`, routine.ID).Scan(&advanced); err != nil {
			t.Fatal(err)
		}
		body, err := json.Marshal(map[string]any{"expected_revision": routine.Revision, "name": "Renamed while firing"})
		if err != nil {
			t.Fatal(err)
		}
		type response struct {
			code int
			body []byte
			err  error
		}
		done := make(chan response, 1)
		go func() {
			request, err := http.NewRequest(http.MethodPatch, env.server.URL+"/v0/routines/"+routine.ID, bytes.NewReader(body))
			if err != nil {
				done <- response{err: err}
				return
			}
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Idempotency-Key", "racing-"+suffix)
			reply, err := alice.Do(request)
			if err != nil {
				done <- response{err: err}
				return
			}
			defer reply.Body.Close()
			raw, err := io.ReadAll(reply.Body)
			done <- response{code: reply.StatusCode, body: raw, err: err}
		}()
		deadline := time.Now().Add(15 * time.Second)
		for countRows(t, env, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`) == 0 {
			if time.Now().After(deadline) {
				t.Fatal("the patch never waited for the fire")
			}
			time.Sleep(20 * time.Millisecond)
		}
		if err := tx.Commit(t.Context()); err != nil {
			t.Fatal(err)
		}
		got := <-done
		if got.err != nil || got.code != http.StatusOK {
			t.Fatalf("patch: %d %s %v", got.code, got.body, got.err)
		}
		var patched reminder.Reminder
		decode(t, got.body, &patched)
		if patched.NextRunAt == nil || !patched.NextRunAt.Equal(advanced) {
			t.Fatalf("patch wrote back a stale schedule: next=%v fired to %v", patched.NextRunAt, advanced)
		}
	})

	t.Run("a deleted Tracking Item takes its Routines with a recorded deletion", func(t *testing.T) {
		items := reminder.NewTrackingService(env.pool)
		owner := reminder.TrackingOwner{TenantID: acmeTenant, ActorID: "actor_acme_alice"}
		fields := func(content string) reminder.TrackingFields {
			return reminder.TrackingFields{Kind: "todo", Content: content, SourceRef: "message:one", SourceDate: "2026-10-27", SourceTimezone: "UTC"}
		}
		created, err := items.Apply(t.Context(), owner, reminder.TrackingChanges{Create: []reminder.TrackingCreate{
			{TrackingFields: fields("Deleted item"), IdempotencyKey: "deleted-" + suffix},
			{TrackingFields: fields("Pruned item"), IdempotencyKey: "pruned-" + suffix},
		}})
		if err != nil {
			t.Fatal(err)
		}
		deletedItem, prunedItem := created.Items[0], created.Items[1]
		linked := func(name, itemID string) string {
			id := insertDueAgentRoutine(t, env, roomID, "actor_acme_alice", "", name+"-"+suffix)
			if _, err := env.pool.Exec(t.Context(), `UPDATE room_reminders SET enabled=false, next_run_at=NULL, tracking_item_id=$2, tracking_purpose='Remind' WHERE id=$1`, id, itemID); err != nil {
				t.Fatal(err)
			}
			return id
		}
		deletedRoutine, prunedRoutine := linked("item-deleted", deletedItem.ID), linked("item-pruned", prunedItem.ID)
		recorded := func(routineID string) bool {
			return countRows(t, env, `SELECT count(*) FROM room_events WHERE room_id=$1 AND resource_id=$2 AND event_type='routine.changed'
				AND payload->>'change_kind'='deleted'`, roomID, routineID) == 1 &&
				countRows(t, env, `SELECT count(*) FROM room_reminders WHERE id=$1`, routineID) == 0
		}
		result, err := items.Apply(t.Context(), owner, reminder.TrackingChanges{Delete: []reminder.TrackingVersion{{ID: deletedItem.ID, ExpectedRevision: deletedItem.Revision}}})
		if err != nil || !recorded(deletedRoutine) {
			t.Fatalf("deleted item: %+v %v", result, err)
		}
		if _, err := items.Done(t.Context(), owner, reminder.TrackingVersion{ID: prunedItem.ID, ExpectedRevision: prunedItem.Revision}); err != nil {
			t.Fatal(err)
		}
		result, err = items.Apply(t.Context(), owner, reminder.TrackingChanges{Prune: true})
		if err != nil || !slices.Contains(result.Deleted, prunedItem.ID) || !recorded(prunedRoutine) {
			t.Fatalf("pruned item: %+v %v", result, err)
		}
	})
}

func TestFailingReminderOccurrenceIsSkippedOnLastAttempt(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newWorkItemAgentEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := env.createRoom(alice, acmeTenant, "Failing "+suffix, "reminder-failing-"+suffix)
	failing := insertDueAgentRoutine(t, env, roomID, "actor_acme_alice", "", "fail-marker-"+suffix)
	healthy := insertDueAgentRoutine(t, env, roomID, "actor_acme_alice", "", "healthy-"+suffix)
	// Reject the failing Reminder's delivery message in the database, so every
	// attempt for it errors while the healthy Reminder still delivers.
	if _, err := env.pool.Exec(t.Context(), `
CREATE FUNCTION reject_marked_reminder_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'reminder delivery rejected'; END $$;
CREATE TRIGGER reject_marked_reminder_delivery BEFORE INSERT ON messages FOR EACH ROW
WHEN (NEW.segments::text LIKE '%fail-marker%') EXECUTE FUNCTION reject_marked_reminder_delivery();`); err != nil {
		t.Fatal(err)
	}
	markReminderOverdue(t, env, failing)
	markReminderOverdue(t, env, healthy)
	enqueueOverdueReminderJobs(t, env)
	// River increments attempt when it fetches a job. Starting at 9 makes this
	// the tenth and last attempt without waiting out retry backoff.
	if _, err := env.pool.Exec(t.Context(), `UPDATE river_job SET attempt=9
		WHERE kind='reminder.fire' AND args->>'reminder_id'=$1`, failing); err != nil {
		t.Fatal(err)
	}
	delivered := drainReminderJobs(t, env)
	if len(delivered) != 1 || delivered[0].ReminderID != healthy {
		t.Fatalf("delivered=%+v want only the healthy Reminder", delivered)
	}
	if got := countRows(t, env, `SELECT count(*) FROM room_reminders WHERE id=$1 AND next_run_at>now()`, failing); got != 1 {
		t.Fatalf("failing Reminder was not advanced past its skipped occurrence: %d", got)
	}
	if got := countRows(t, env, `SELECT count(*) FROM river_job WHERE kind='reminder.fire' AND args->>'reminder_id'=$1 AND state='scheduled'`, failing); got != 1 {
		t.Fatalf("next occurrence job for failing Reminder=%d want 1", got)
	}
}

// A schedule repair sweep that runs while an occurrence waits for its delivery
// retry must not enqueue a second job for it. River's scheduler discards a due
// retry whose uniqueness key another unfinished job holds, so the occurrence
// would restart at attempt 1, never reach its last attempt, and never be
// skipped; the Reminder would stop firing.
func TestReminderRepairSweepKeepsOccurrenceRetry(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newWorkItemAgentEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := env.createRoom(alice, acmeTenant, "Retrying "+suffix, "reminder-retrying-"+suffix)
	failing := insertDueAgentRoutine(t, env, roomID, "actor_acme_alice", "", "retry-marker-"+suffix)
	if _, err := env.pool.Exec(t.Context(), `
CREATE FUNCTION reject_retry_marker_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'reminder delivery rejected'; END $$;
CREATE TRIGGER reject_retry_marker_delivery BEFORE INSERT ON messages FOR EACH ROW
WHEN (NEW.segments::text LIKE '%retry-marker%') EXECUTE FUNCTION reject_retry_marker_delivery();`); err != nil {
		t.Fatal(err)
	}
	markReminderOverdue(t, env, failing)
	enqueueOverdueReminderJobs(t, env)
	// River backs off by the number of recorded errors, so with eight on record
	// the ninth attempt fails and waits hours for the tenth.
	if _, err := env.pool.Exec(t.Context(), `UPDATE river_job SET attempt=8,
		errors=array_fill(jsonb_build_object('at', now(), 'attempt', 1, 'error', 'earlier failure'), ARRAY[8])
		WHERE kind='reminder.fire' AND args->>'reminder_id'=$1`, failing); err != nil {
		t.Fatal(err)
	}
	if delivered := drainReminderJobs(t, env); len(delivered) != 0 {
		t.Fatalf("delivered=%+v want none", delivered)
	}
	occurrenceJobs := `SELECT count(*) FROM river_job WHERE kind='reminder.fire' AND args->>'reminder_id'=$1
		AND state IN ('available','pending','running','scheduled','retryable')`
	if got := countRows(t, env, occurrenceJobs+` AND state='retryable' AND attempt=9`, failing); got != 1 {
		t.Fatalf("retrying occurrence jobs=%d want 1", got)
	}

	enqueueOverdueReminderJobs(t, env)
	if got := countRows(t, env, occurrenceJobs, failing); got != 1 {
		t.Fatalf("repair sweep left %d jobs for the retrying occurrence, want only its retry", got)
	}

	if _, err := env.pool.Exec(t.Context(), `UPDATE river_job SET scheduled_at=now()
		WHERE kind='reminder.fire' AND args->>'reminder_id'=$1 AND state='retryable'`, failing); err != nil {
		t.Fatal(err)
	}
	drainReminderJobs(t, env)
	if got := countRows(t, env, `SELECT count(*) FROM river_job WHERE kind='reminder.fire' AND args->>'reminder_id'=$1
		AND metadata ? 'unique_key_conflict'`, failing); got != 0 {
		t.Fatalf("River discarded %d retries of the occurrence for a uniqueness conflict", got)
	}
	if got := countRows(t, env, `SELECT count(*) FROM room_reminders WHERE id=$1 AND next_run_at>now()`, failing); got != 1 {
		t.Fatalf("Reminder was not advanced past its skipped occurrence: %d", got)
	}
	if got := countRows(t, env, occurrenceJobs+` AND state='scheduled'`, failing); got != 1 {
		t.Fatalf("next occurrence jobs=%d want 1", got)
	}
}
