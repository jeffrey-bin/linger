package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
)

func TestAgentRoomRoutineMCP(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newAgentRoutineEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := env.createRoom(alice, acmeTenant, "Agent routines "+suffix, "agent-routines-"+suffix)
	if status, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); status != http.StatusOK {
		t.Fatalf("add Agent: %d %s", status, body)
	}
	issued, err := agentcredential.New(env.pool).IssueManaged(t.Context(), acmeOfficialAgentManagementID, "routine CLI")
	if err != nil {
		t.Fatal(err)
	}
	token := issued.AccessToken
	base := map[string]any{}

	bad := cloneRoutineMap(base)
	bad["invocation_id"] = routineInvocation("01")
	bad["name"] = "Morning"
	bad["instruction"] = "Say hello."
	bad["schedule"] = map[string]any{"kind": "daily", "time": "9:00", "timezone": "Asia/Shanghai"}
	status, body := postAgentInRoom(t, env, token, roomID, "/api/agent/v1/routines", bad)
	if status != http.StatusBadRequest || !strings.Contains(string(body), "invalid_request") {
		t.Fatalf("bad clock: %d %s", status, body)
	}

	mixed := cloneRoutineMap(base)
	mixed["invocation_id"] = routineInvocation("02")
	mixed["name"] = "Interval"
	mixed["instruction"] = "Ping."
	mixed["schedule"] = map[string]any{"kind": "every_n_hours", "interval_hours": 4, "timezone": "UTC"}
	status, body = postAgentInRoom(t, env, token, roomID, "/api/agent/v1/routines", mixed)
	if status != http.StatusBadRequest {
		t.Fatalf("mixed interval: %d %s", status, body)
	}

	unknown := cloneRoutineMap(base)
	unknown["invocation_id"] = routineInvocation("03")
	unknown["name"] = "Someone else"
	unknown["instruction"] = "Wake a stranger."
	unknown["mention_actor_id"] = "actor_acme_alice"
	unknown["schedule"] = map[string]any{"kind": "daily", "time": "09:00", "timezone": "Asia/Shanghai"}
	status, body = postAgentInRoom(t, env, token, roomID, "/api/agent/v1/routines", unknown)
	if status != http.StatusBadRequest || !strings.Contains(string(body), "mention_unavailable") {
		t.Fatalf("human mention: %d %s", status, body)
	}

	create := cloneRoutineMap(base)
	create["invocation_id"] = routineInvocation("04")
	create["name"] = "Morning note"
	create["instruction"] = "Write the daily note."
	create["mention_actor_id"] = "self"
	create["schedule"] = map[string]any{"kind": "weekly", "weekdays": []string{"friday", "monday", "tuesday", "wednesday", "thursday"}, "time": "09:00", "timezone": "Asia/Shanghai"}
	status, body = postAgentInRoom(t, env, token, roomID, "/api/agent/v1/routines", create)
	if status != http.StatusOK {
		t.Fatalf("create: %d %s", status, body)
	}
	var created struct {
		Routine struct {
			ID             string `json:"id"`
			MentionActorID string `json:"mention_actor_id"`
			Enabled        bool   `json:"enabled"`
			Schedule       struct {
				Kind     string   `json:"kind"`
				Weekdays []string `json:"weekdays"`
				Time     string   `json:"time"`
				Timezone string   `json:"timezone"`
			} `json:"schedule"`
		} `json:"routine"`
	}
	decode(t, body, &created)
	if !created.Routine.Enabled || created.Routine.MentionActorID != "actor_acme_official" || created.Routine.Schedule.Time != "09:00" || created.Routine.Schedule.Timezone != "Asia/Shanghai" {
		t.Fatalf("created routine: %s", body)
	}
	if !slices.Equal(created.Routine.Schedule.Weekdays, []string{"monday", "tuesday", "wednesday", "thursday", "friday"}) {
		t.Fatalf("CLI lost weekdays: %s", body)
	}
	var savedDays []string
	if err := env.pool.QueryRow(t.Context(), `SELECT weekdays FROM room_reminders WHERE id=$1`, created.Routine.ID).Scan(&savedDays); err != nil || !slices.Equal(savedDays, created.Routine.Schedule.Weekdays) {
		t.Fatalf("CLI persistence: %v %v", savedDays, err)
	}
	status, replay := postAgentInRoom(t, env, token, roomID, "/api/agent/v1/routines", create)
	if status != http.StatusOK || !strings.Contains(string(replay), created.Routine.ID) {
		t.Fatalf("replay: %d %s", status, replay)
	}
	var replayed struct {
		Routine struct {
			ID string `json:"id"`
		} `json:"routine"`
	}
	decode(t, replay, &replayed)
	if replayed.Routine.ID != created.Routine.ID {
		t.Fatalf("replay id=%s want=%s", replayed.Routine.ID, created.Routine.ID)
	}
	if count := countRows(t, env, `SELECT count(*) FROM room_reminders WHERE room_id=$1`, roomID); count != 1 {
		t.Fatalf("rows after replay=%d", count)
	}

	listBody := cloneRoutineMap(base)
	listBody["invocation_id"] = routineInvocation("05")
	status, body = postAgentInRoom(t, env, token, roomID, "/api/agent/v1/routines/query", listBody)
	if status != http.StatusOK || !strings.Contains(string(body), "Morning note") {
		t.Fatalf("list: %d %s", status, body)
	}

	pause := cloneRoutineMap(base)
	pause["invocation_id"] = routineInvocation("06")
	pause["routine_id"] = created.Routine.ID
	status, body = postAgentInRoom(t, env, token, roomID, "/api/agent/v1/routines/pause", pause)
	if status != http.StatusOK || !strings.Contains(string(body), `"enabled":false`) {
		t.Fatalf("pause: %d %s", status, body)
	}

	enable := cloneRoutineMap(base)
	enable["invocation_id"] = routineInvocation("07")
	enable["routine_id"] = created.Routine.ID
	status, body = postAgentInRoom(t, env, token, roomID, "/api/agent/v1/routines/enable", enable)
	if status != http.StatusOK || !strings.Contains(string(body), `"enabled":true`) {
		t.Fatalf("enable: %d %s", status, body)
	}

	run := cloneRoutineMap(base)
	run["invocation_id"] = routineInvocation("08")
	run["routine_id"] = created.Routine.ID
	status, body = postAgentInRoom(t, env, token, roomID, "/api/agent/v1/routines/run", run)
	if status != http.StatusOK {
		t.Fatalf("run: %d %s", status, body)
	}
	// The Agent's self-mentioning Routine wakes it on behalf of the Room's one
	// Human, so the fired Message is the Human's and mentions the Agent.
	var messages int
	if err := env.pool.QueryRow(t.Context(), `SELECT count(*) FROM messages WHERE room_id=$1 AND author_actor_id='actor_acme_alice' AND message_kind='agent_runtime'`, roomID).Scan(&messages); err != nil {
		t.Fatal(err)
	}
	if messages != 1 {
		t.Fatalf("messages=%d", messages)
	}

	deleteBody := cloneRoutineMap(base)
	deleteBody["invocation_id"] = routineInvocation("09")
	deleteBody["routine_id"] = created.Routine.ID
	status, body = postAgentInRoom(t, env, token, roomID, "/api/agent/v1/routines/deletion", deleteBody)
	if status != http.StatusOK || !strings.Contains(string(body), `"deleted":true`) {
		t.Fatalf("delete: %d %s", status, body)
	}
	if count := countRows(t, env, `SELECT count(*) FROM room_reminders WHERE room_id=$1`, roomID); count != 0 {
		t.Fatalf("rows after delete=%d", count)
	}
	// Only the fired self-mention wakes the Agent; creating, pausing and
	// deleting the Routine start no Run.
	if count := countRows(t, env, `SELECT count(*) FROM agent_local_runs`); count != 1 {
		t.Fatalf("Routine commands created %d Runs, want the fired one", count)
	}
}

func newAgentRoutineEnv(t *testing.T) (*testEnv, *http.Client) {
	t.Helper()
	artifactRoot := integrationArtifactRoot(t)
	databaseURL := newIntegrationDatabase(t)
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	application, err := newIntegrationApp(ctx, config.ForTest(func(c *config.Config) {
		c.ArtifactStorageRoot = artifactRoot
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.TeamHubInternalToken = teamHubInternalToken
		c.NodeServicesInternalToken = nodeServicesInternalToken
		c.AgentRunTokenSecret = agentRunTokenSecret
	}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}
	return env, env.login("alice", alicePassword)
}

func postAgentInRoom(t *testing.T, env *testEnv, token, roomID, path string, payload any) (int, []byte) {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, env.server.URL+path, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	if roomID != "" {
		request.Header.Set("X-TeamHub-Context-Kind", "room")
		request.Header.Set("X-TeamHub-Context-Id", roomID)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, raw
}

func routineInvocation(suffix string) string {
	return "agent-invocation-sha256:" + strings.Repeat("a", 62) + suffix
}

func cloneRoutineMap(source map[string]any) map[string]any {
	clone := make(map[string]any, len(source)+4)
	for key, value := range source {
		clone[key] = value
	}
	return clone
}

// TestAgentOnceRoutine drives the Agent HTTP surface for one-shot checks: a
// one-shot check is created and listed with its time, and a past time and the
// pending one-shot limit are refused.
func TestAgentOnceRoutine(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newAgentRoutineEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := env.createRoom(alice, acmeTenant, "Once "+suffix, "once-"+suffix)
	if status, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); status != http.StatusOK {
		t.Fatalf("add Agent: %d %s", status, body)
	}
	issued, err := agentcredential.New(env.pool).IssueManaged(t.Context(), acmeOfficialAgentManagementID, "once CLI")
	if err != nil {
		t.Fatal(err)
	}
	once := func(id, at string) (int, []byte) {
		return postAgentInRoom(t, env, issued.AccessToken, roomID, "/api/agent/v1/routines", map[string]any{
			"invocation_id": routineInvocation(id), "name": "Flight check " + id, "instruction": "Check the flight.",
			"mention_actor_id": "self", "schedule": map[string]any{"kind": "once", "run_at": at, "timezone": "Asia/Shanghai"},
		})
	}
	runAt := time.Now().Add(3 * time.Hour).UTC().Truncate(time.Second)
	if status, body := once("10", runAt.Format(time.RFC3339)); status != http.StatusOK || !strings.Contains(string(body), `"kind":"once"`) {
		t.Fatalf("create once: %d %s", status, body)
	}
	if countRows(t, env, `SELECT count(*) FROM room_reminders WHERE room_id=$1 AND cadence_kind='once' AND run_at=$2 AND next_run_at=$2 AND enabled`, roomID, runAt) != 1 {
		t.Fatal("the one-shot Routine was not stored to run at its time")
	}
	status, body := postAgentInRoom(t, env, issued.AccessToken, roomID, "/api/agent/v1/routines/query", map[string]any{"invocation_id": routineInvocation("13")})
	if status != http.StatusOK || !strings.Contains(string(body), runAt.Format("2006-01-02T15:04:05")) {
		t.Fatalf("list once: %d %s", status, body)
	}
	if status, body := once("11", time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)); status != http.StatusBadRequest {
		t.Fatalf("past one-shot: %d %s", status, body)
	}
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO room_reminders (id, tenant_id, room_id, created_by_actor_id, name, instruction, cadence_kind, timezone, run_at, enabled, next_run_at)
		SELECT 'routine_pending_'||n, $1, $2, 'actor_acme_official', 'Pending '||n, 'x', 'once', 'UTC', now()+interval '1 day', true, now()+interval '1 day'
		FROM generate_series(1,19) n`, acmeTenant, roomID); err != nil {
		t.Fatal(err)
	}
	if status, body := once("12", runAt.Format(time.RFC3339)); status != http.StatusConflict || !strings.Contains(string(body), "routine_once_limit") {
		t.Fatalf("pending one-shot limit: %d %s", status, body)
	}
}
