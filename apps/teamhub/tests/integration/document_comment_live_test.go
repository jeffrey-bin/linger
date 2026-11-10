//go:build integration_process && integration_live

package integration_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"testing"
	"time"
)

// Explicit live-provider proof, excluded from the default and process gates.
// TeamHub/Postgres, Agent Service main, Codex and CLI are real; only Document
// Runtime materialization/export uses the existing deterministic adapter.
func TestDocumentConsecutiveCommentsLiveAgent(t *testing.T) {
	model := os.Getenv("COMMENT_LIVE_MODEL")
	if model == "" {
		t.Skip("set COMMENT_LIVE_MODEL and configure Codex authentication for explicit live proof")
	}
	agentPort := reserveTCPPort(t)
	env, alice := newRoomDocumentRealtimeEnvWithRuntimeOptions(t, 0, 0, 0, roomDocumentRuntimeTestOptions{
		revisionExport: true, jobPollInterval: 10 * time.Millisecond,
	})
	if _, err := env.pool.Exec(t.Context(), `UPDATE agent_registrations SET runtime_model=$1,
		instructions='For each document comment notification, read that thread with teamhub comments get and reply exactly once with teamhub comments reply. Answer its question concisely. Do not edit the document.',
		configuration_revision=configuration_revision+1 WHERE agent_management_id=$2`, model, acmeOfficialAgentManagementID); err != nil {
		t.Fatal(err)
	}
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Live comments "+suffix, "live-comments-room-"+suffix)
	doc := createRoomDocumentForCommentRefs(t, env, alice, roomID, "Consecutive comment proof", "live-comments-doc-"+suffix)
	var threads []roomDocumentCommentThreadResponse
	var threadIDs, runIDs []string
	createComment := func(index int) {
		t.Helper()
		code, _, payload := env.request(alice, http.MethodPost, "/v0/documents/"+doc.ID+"/comment-threads", map[string]any{
			"current_context": map[string]any{"binding_kind": "room", "context_id": roomID},
			"anchor":          map[string]any{"quoted_text": "selected text", "block_id": fmt.Sprintf("block_live_%d", index), "context_before": "", "context_after": ""},
			"initial_comment": map[string]any{"segments": []map[string]any{
				{"type": "reference", "content": "@official", "actor_id": "actor_acme_official"},
				{"type": "text", "content": fmt.Sprintf(" This is comment %d, please reply: what is %d plus 1?", index+1, index+1)},
			}},
			"durable_head": durableHeadPayload(doc.DurableHead.PersistedSeq, doc.DurableHead.StateHash, doc.DurableHead.StateHashVersion),
		}, fmt.Sprintf("live-comment-%s-%d", suffix, index))
		if code != http.StatusCreated {
			t.Fatalf("create comment %d: %d %s", index+1, code, payload)
		}
		var thread roomDocumentCommentThreadResponse
		decode(t, payload, &thread)
		threads = append(threads, thread)
		threadIDs = append(threadIDs, thread.ID)
		runIDs = append(runIDs, waitForDocumentCommentRun(t, env, thread.Comments[0].ID))
	}
	attachComments := func() {
		t.Helper()
		slices.Sort(threadIDs)
		batchID := fmt.Sprintf("live-comments-batch-%s-%d", suffix, len(threads))
		credential := openRoomDocumentSessionForCommentRefs(t, env, alice, doc.ID, batchID)
		if check := validateCommentThreadRefs(t, env, doc.ID, threadIDs); check != "available" {
			t.Fatalf("validate anchors: %s", check)
		}
		doc.DurableHead.StateHash = appendCommentThreadRefs(t, env, doc.ID, credential.claims(t).ActorID,
			batchID, doc.DurableHead.PersistedSeq, threadIDs)
		doc.DurableHead.PersistedSeq++
	}
	createComment(0)
	attachComments()
	waitForDocumentCommentRunQueued(t, env, runIDs[0], "active")
	evidenceDir := os.Getenv("COMMENT_LIVE_EVIDENCE_DIR")
	if evidenceDir == "" {
		evidenceDir = t.TempDir()
	}
	if err := os.MkdirAll(evidenceDir, 0700); err != nil {
		t.Fatal(err)
	}
	logFile, err := os.OpenFile(filepath.Join(evidenceDir, "agent-service.log"), os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer logFile.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Minute)
	defer cancel()
	command := exec.CommandContext(ctx, "node", "--import", "tsx", "apps/node-services/src/main.ts")
	command.Dir = repositoryPath()
	command.Env = append(os.Environ(), "NODE_ENV=test", "TEAMHUB_BASE_URL="+env.server.URL, "NODE_SERVICES_ROLES=agent",
		"AGENT_HOME="+t.TempDir(), "NODE_SERVICES_HTTP_ADDRESS=127.0.0.1:"+strconv.Itoa(agentPort),
		"LINGER_SECRET_SEED="+integrationSecretSeed,
		"AGENT_LOG_LEVEL=info",
	)
	command.Stdout, command.Stderr = logFile, logFile
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	defer func() {
		_ = command.Process.Signal(os.Interrupt)
		select {
		case <-done:
		case <-time.After(15 * time.Second):
			cancel()
			<-done
		}
	}()
	t.Logf("TeamHub=%s Agent=http://127.0.0.1:%d; document=%s; append comments 2/3 while comment 1 is running; evidence=%s", env.server.URL, agentPort, doc.ID, evidenceDir)
	for {
		var runStatus string
		if err := env.pool.QueryRow(t.Context(), `SELECT status FROM agent_local_runs WHERE run_id=$1`, runIDs[0]).Scan(&runStatus); err != nil {
			t.Fatal(err)
		}
		if runStatus == "running" {
			break
		}
		if runStatus != "queued" {
			t.Fatalf("first Run ended before comments could overlap: %s", runStatus)
		}
		select {
		case <-ctx.Done():
			t.Fatalf("first Run did not start; inspect %s", logFile.Name())
		case <-time.After(100 * time.Millisecond):
		}
	}
	createComment(1)
	createComment(2)
	attachComments()
	for _, runID := range runIDs[1:] {
		waitForDocumentCommentRunQueued(t, env, runID, "active")
	}
	t.Log("comments 2 and 3 accepted while the same Document Context is executing comment 1")
	for {
		var completed, failed int
		err := env.pool.QueryRow(t.Context(), `SELECT count(*) FILTER (WHERE r.status='succeeded'),count(*) FILTER (WHERE r.status IN ('failed','cancelled'))
			FROM agent_local_runs r JOIN agent_execution_contexts c ON c.context_key=r.context_key
			WHERE c.context_kind='document' AND c.document_id=$1`, doc.ID).Scan(&completed, &failed)
		if err != nil {
			t.Fatal(err)
		}
		if failed > 0 {
			t.Fatalf("Agent failed %d runs; inspect %s", failed, logFile.Name())
		}
		if completed == len(threads) {
			break
		}
		select {
		case err := <-done:
			done <- err
			t.Fatalf("Agent exited before replies: %v; inspect %s", err, logFile.Name())
		case <-ctx.Done():
			t.Fatalf("only %d/%d completed; inspect %s", completed, len(threads), logFile.Name())
		case <-time.After(250 * time.Millisecond):
		}
	}
	var evidence []json.RawMessage
	for index, thread := range threads {
		code, _, payload := env.request(alice, http.MethodGet, "/v0/document-comment-threads/"+thread.ID, nil, "")
		if code != http.StatusOK {
			t.Fatalf("read thread: %d %s", code, payload)
		}
		var visible struct {
			Comments []struct {
				Body            string `json:"body"`
				ParentCommentID string `json:"parent_comment_id"`
				Author          struct {
					ID string `json:"id"`
				} `json:"author"`
			} `json:"comments"`
		}
		decode(t, payload, &visible)
		if len(visible.Comments) != 2 || visible.Comments[1].Author.ID != "actor_acme_official" || visible.Comments[1].Body == "" || visible.Comments[1].ParentCommentID != thread.Comments[0].ID {
			t.Fatalf("comment %d did not get exactly one Agent reply: %s", index+1, payload)
		}
		var attempts int
		if err := env.pool.QueryRow(t.Context(), `SELECT attempt_count FROM agent_local_runs WHERE run_id=$1`, runIDs[index]).Scan(&attempts); err != nil || attempts != 1 {
			t.Fatalf("comment %d attempts=%d err=%v", index+1, attempts, err)
		}
		t.Logf("comment %d: succeeded, attempts=1, one persisted reply: %s", index+1, visible.Comments[1].Body)
		evidence = append(evidence, json.RawMessage(payload))
	}
	if got := countRows(t, env, `SELECT count(*) FROM room_members WHERE room_id=$1 AND actor_id='actor_acme_official'`, roomID); got != 0 {
		t.Fatalf("Agent unexpectedly joined Room: %d", got)
	}
	encoded, err := json.MarshalIndent(evidence, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(evidenceDir, "persisted-replies.json"), encoded, 0600); err != nil {
		t.Fatal(err)
	}
}

func reserveTCPPort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	return port
}
