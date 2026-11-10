//go:build integration_process

package integration_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

func TestDirectInboxAgentProcessAcceptsWithoutMessageFiles(t *testing.T) {
	buildTeamHubCLIForProcess(t)
	env, alice, computer := newDirectInboxProcessEnv(t, nil)
	pool, server := env.pool, env.server
	direct := requestDirectRoom(alice, server.URL, "actor_acme_official")
	if direct.err != nil || (direct.status != http.StatusCreated && direct.status != http.StatusOK) {
		t.Fatalf("create Direct Room: %d %v %s", direct.status, direct.err, direct.body)
	}
	roomID := direct.roomID
	// A long non-actionable prefix is scanned and committed without inputs.
	for index := range 105 {
		id := fmt.Sprintf("process_runtime_%03d", index)
		insertHistoryFixture(t, env, roomID, id, "agent_runtime", "Runtime history")
	}
	const requestText = "direct-inbox-process-human-request"
	code, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/messages", map[string]any{
		"raw_message": requestText + " @Official",
		"segments": []map[string]any{{"type": "text", "content": requestText + " "},
			{"type": "reference", "content": "@Official", "target": "actor_acme_official", "target_type": "agent"}},
	}, "direct-process-request")
	if code != http.StatusCreated {
		t.Fatalf("submit Human request: %d %s", code, body)
	}
	var submitted struct {
		ID string `json:"id"`
	}
	decode(t, body, &submitted)
	messageID := submitted.ID
	// A non-message tail must be scanned and committed without becoming input.
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	queries := store.New(tx)
	sequence, err := queries.AllocateRoomSeq(t.Context(), roomID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := queries.CreateRoomEvent(t.Context(), store.CreateRoomEventParams{EventID: "process_nonmessage_tail", TenantID: acmeTenant, RoomID: roomID, RoomSeq: sequence, EventType: "room.updated", ActorID: "actor_acme_alice", ResourceID: roomID, Payload: json.RawMessage(`{}`)}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}

	_, fixtureRoot := startAgentManagerProcessWithRecordedCodexFixture(t, computer, server.URL)
	deadline := time.Now().Add(30 * time.Second)
	var inputCount, runCount int
	var payload []byte
	for {
		if err := pool.QueryRow(t.Context(), `SELECT count(*),count(local_run_id),COALESCE(jsonb_agg(payload)::text,'[]') FROM agent_runtime_inputs WHERE source_inbox_id=$1 AND EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'acceptedNotification'->'messages') message WHERE message->>'id'=$2)`, "room:"+roomID, messageID).Scan(&inputCount, &runCount, &payload); err != nil {
			t.Fatal(err)
		}
		if inputCount == 1 && runCount == 1 && processFixtureContains(t, fixtureRoot, requestText) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("direct delivery did not reach provider: inputs=%d runs=%d payload=%s", inputCount, runCount, payload)
		}
		time.Sleep(25 * time.Millisecond)
	}
	if !bytes.Contains(payload, []byte(requestText)) || bytes.Contains(payload, []byte("Runtime history")) {
		t.Fatalf("durable input lost body or carried non-actionable history: %s", payload)
	}
	if countRows(t, env, `SELECT count(*) FROM agent_runtime_inputs WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'acceptedNotification'->'messages') message WHERE message->>'id' LIKE 'process_runtime_%')`) != 0 {
		t.Fatal("non-actionable history became Runtime inputs")
	}
	credential, err := agentcredential.New(pool).IssueManaged(t.Context(), acmeOfficialAgentManagementID, "process history")
	if err != nil {
		t.Fatal(err)
	}
	before := historyCursorSnapshot(t, env)
	command := exec.Command("node", "apps/teamhub-cli/dist/teamhub.js", "message", "read", "--message-ids", messageID, "--json")
	command.Dir = repositoryPath()
	command.Env = append(withoutEnv(os.Environ(), "TEAMHUB_CONFIG", "TEAMHUB_PROFILE", "TEAMHUB_TOKEN", "TEAMHUB_TOKEN_FILE", "TEAMHUB_URL"), "TEAMHUB_URL="+server.URL, "TEAMHUB_TOKEN="+credential.AccessToken)
	cliBody, err := command.CombinedOutput()
	if err != nil || !bytes.Contains(cliBody, []byte(requestText)) {
		t.Fatalf("standalone CLI history: err=%v body=%s", err, cliBody)
	}
	assertHistoryCursors(t, env, before)
}

func processFixtureContains(t *testing.T, root, needle string) bool {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(root, "turn-*.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	for _, filename := range files {
		content, err := os.ReadFile(filename)
		if err != nil {
			t.Fatal(err)
		}
		// Native Go JSON escapes HTML characters that the Host's JavaScript
		// encoder leaves literal. Inspect the actual decoded Provider input.
		// An append may still be in progress; only inspect complete JSON lines.
		for _, line := range bytes.SplitAfter(content, []byte("\n")) {
			if !bytes.HasSuffix(line, []byte("\n")) || len(bytes.TrimSpace(line)) == 0 {
				continue
			}
			if !json.Valid(line) {
				t.Fatal("recorded Provider request is not valid JSON")
			}
			decoder := json.NewDecoder(bytes.NewReader(line))
			for {
				token, err := decoder.Token()
				if err == io.EOF {
					break
				}
				if err != nil {
					t.Fatalf("decode recorded Provider request: %v", err)
				}
				if text, ok := token.(string); ok && strings.Contains(text, needle) {
					return true
				}
			}
		}
	}
	return false
}
