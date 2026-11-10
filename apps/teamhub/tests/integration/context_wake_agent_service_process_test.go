//go:build integration_process

package integration_test

import (
	"bytes"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Both the Room Context and its first Thread are created after the service has
// connected. No initial topology snapshot can discover either of them; the
// run.queued hint of each Message's transaction does.
func TestAgentServiceDiscoversNewRoomContextAndThreadFromWake(t *testing.T) {
	buildTeamHubCLIForProcess(t)
	var connections atomic.Int64
	var phaseMu sync.Mutex
	var requestedAt, wakeAt, claimAt time.Time
	measuring := false
	env, alice, computer := newDirectInboxProcessEnv(t, func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			if request.URL.Path == "/v0/agent-runtime/wakes" {
				connections.Add(1)
				writer = &contextWakeTimingWriter{ResponseWriter: writer, observe: func(data []byte) {
					if !bytes.Contains(data, []byte("event: run.queued")) {
						return
					}
					phaseMu.Lock()
					if measuring && wakeAt.IsZero() {
						wakeAt = time.Now()
					}
					phaseMu.Unlock()
				}}
			}
			next.ServeHTTP(writer, request)
			if request.URL.Path == "/v0/agent-runtime/runs/claim" {
				phaseMu.Lock()
				if measuring && !wakeAt.IsZero() && claimAt.IsZero() {
					claimAt = time.Now()
				}
				phaseMu.Unlock()
			}
		})
	})
	stop, fixtureRoot := startDirectInboxRecordedProcess(t, computer, env)
	t.Cleanup(stop)
	waitDirectInboxProcess(t, "Agent establishes its wake stream", func() bool { return connections.Load() > 0 })
	direct := requestDirectRoom(alice, env.server.URL, "actor_acme_official")
	if direct.err != nil || (direct.status != http.StatusCreated && direct.status != http.StatusOK) {
		t.Fatalf("create Direct Room status=%d err=%v body=%s", direct.status, direct.err, direct.body)
	}
	roomID := direct.roomID
	parentRequest := "live-new-context-request"
	parentID := postContextWakeMention(t, env, alice, roomID, parentRequest)
	waitDirectInboxProcess(t, "new Context receives and completes its Room input", func() bool {
		return processFixtureContains(t, fixtureRoot, parentRequest) && countRows(t, env, `SELECT count(*) FROM agent_local_runs run JOIN agent_runtime_inputs input ON input.local_run_id=run.run_id WHERE run.status='succeeded' AND input.payload->'invocationMessageIds' ? $1`, parentID) == 1
	})
	rootID := seedAgentMessage(t, env, roomID, "actor_acme_official", "Agent root for a new Thread")
	thread := requestMessageThread(t, env, alice, roomID, rootID, "live-first-thread")
	if thread.status != http.StatusCreated {
		t.Fatalf("Human creates Thread on Agent root status=%d body=%s", thread.status, thread.body)
	}
	const threadRequest = "live-first-thread-context-wake-request"
	phaseMu.Lock()
	measuring = true
	requestedAt = time.Now()
	phaseMu.Unlock()
	messageID := postContextWakeMention(t, env, alice, thread.room.ID, threadRequest)
	committedAt := time.Now()
	deadline := committedAt.Add(5 * time.Second)
	for !processFixtureContains(t, fixtureRoot, threadRequest) {
		if time.Now().After(deadline) {
			t.Fatal("first Thread input did not reach the Provider within five seconds of HTTP commit acknowledgement")
		}
		time.Sleep(10 * time.Millisecond)
	}
	providerAt := time.Now()
	waitDirectInboxProcess(t, "first Thread has one durable completed input", func() bool {
		return countRows(t, env, `SELECT count(*) FROM agent_local_runs run JOIN agent_runtime_inputs input ON input.local_run_id=run.run_id WHERE input.source_inbox_id=$1 AND run.status='succeeded' AND input.payload->'invocationMessageIds' ? $2`, "thread:"+thread.room.ID, messageID) == 1
	})
	phaseMu.Lock()
	defer phaseMu.Unlock()
	if wakeAt.IsZero() || claimAt.IsZero() {
		t.Fatalf("first Thread input arrived without its observed run.queued wake (%s) and claim (%s)", wakeAt, claimAt)
	}
	t.Logf("first Thread observed phases from message request: wake=%s claim=%s provider=%s; commit acknowledgement to Provider=%s", wakeAt.Sub(requestedAt), claimAt.Sub(requestedAt), providerAt.Sub(requestedAt), providerAt.Sub(committedAt))
}

func postContextWakeMention(t *testing.T, env *testEnv, client *http.Client, roomID, text string) string {
	t.Helper()
	status, _, body := env.request(client, http.MethodPost, "/v0/rooms/"+roomID+"/messages", map[string]any{
		"raw_message": text + " @Official",
		"segments":    []map[string]any{{"type": "text", "content": text + " "}, {"type": "reference", "content": "@Official", "target": "actor_acme_official", "target_type": "agent"}},
	}, text)
	if status != http.StatusCreated {
		t.Fatalf("create Context wake message status=%d body=%s", status, body)
	}
	var message struct{ ID string }
	decode(t, body, &message)
	return message.ID
}

type contextWakeTimingWriter struct {
	http.ResponseWriter
	observe func([]byte)
}

func (writer *contextWakeTimingWriter) Write(data []byte) (int, error) {
	writer.observe(data)
	return writer.ResponseWriter.Write(data)
}

func (writer *contextWakeTimingWriter) Flush() {
	writer.ResponseWriter.(http.Flusher).Flush()
}
