//go:build integration_process

package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
)

// Disconnect an established wake stream after startup. Only the periodic
// waiting-Run scan can discover the Run the later Human message queued:
// reconnections fail while the same Agent process remains running.
func TestDirectInboxAgentProcessReconcilesWhileInboxSSEUnavailable(t *testing.T) {
	buildTeamHubCLIForProcess(t)
	var outage atomic.Bool
	var opened, ended, rejected atomic.Int64
	disconnect := make(chan struct{})
	env, alice, computer := newDirectInboxProcessEnv(t, func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			if request.URL.Path != "/v0/agent-runtime/wakes" {
				next.ServeHTTP(writer, request)
				return
			}
			if outage.Load() {
				rejected.Add(1)
				http.Error(writer, "fixture Inbox SSE transport unavailable", http.StatusServiceUnavailable)
				return
			}
			opened.Add(1)
			streamContext, cancel := context.WithCancel(request.Context())
			defer cancel()
			go func() {
				select {
				case <-disconnect:
					cancel()
				case <-streamContext.Done():
				}
			}()
			next.ServeHTTP(writer, request.WithContext(streamContext))
			ended.Add(1)
		})
	})
	direct := requestDirectRoom(alice, env.server.URL, "actor_acme_official")
	if direct.err != nil || (direct.status != http.StatusCreated && direct.status != http.StatusOK) {
		t.Fatalf("create Direct Room: %d %v %s", direct.status, direct.err, direct.body)
	}
	roomID := direct.roomID
	stop, fixtureRoot := startDirectInboxRecordedProcess(t, computer, env)
	t.Cleanup(stop)
	const contextQuery = `SELECT context.context_key,epoch.epoch FROM agent_execution_contexts context CROSS JOIN agent_service_epochs epoch
		WHERE context.room_id=$1 AND context.agent_actor_id='actor_acme_official' AND context.context_kind='meta'`
	waitDirectInboxProcess(t, "startup opens the wake stream beside the Room's Context", func() bool {
		return opened.Load() == 1 && countRows(t, env, `SELECT count(*) FROM (`+contextQuery+`) live`, roomID) == 1
	})
	// Identify the Agent process by the epoch it opened.
	var contextKey, startedEpoch string
	if err := env.pool.QueryRow(t.Context(), contextQuery, roomID).Scan(&contextKey, &startedEpoch); err != nil || startedEpoch == "" {
		t.Fatalf("initial Agent did not open an epoch: %v", err)
	}
	outage.Store(true)
	close(disconnect)
	waitDirectInboxProcess(t, "established Inbox SSE ends and reconnect is rejected", func() bool {
		return ended.Load() == 1 && rejected.Load() > 0
	})
	if countRows(t, env, `SELECT count(*) FROM agent_runtime_inputs WHERE context_key=$1`, contextKey) != 0 {
		t.Fatal("startup produced an input before the Human request")
	}
	const requestText = "direct-process-periodic-reconcile-current-body"
	submittedAt := time.Now()
	code, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/messages", map[string]any{
		"raw_message": requestText + " @Official",
		"segments": []map[string]any{{"type": "text", "content": requestText + " "},
			{"type": "reference", "content": "@Official", "target": "actor_acme_official", "target_type": "agent"}},
	}, "direct-periodic-process-request")
	if code != http.StatusCreated {
		t.Fatalf("submit Human request during SSE outage: %d %s", code, body)
	}
	var message struct{ ID string }
	decode(t, body, &message)
	// The scan runs every 30 to 60 seconds.
	deadline := time.Now().Add(90 * time.Second)
	for !processFixtureContains(t, fixtureRoot, requestText) || countRows(t, env, `SELECT count(*) FROM agent_local_runs run JOIN agent_runtime_inputs input ON input.local_run_id=run.run_id WHERE input.context_key=$1 AND run.status='succeeded' AND input.payload->'invocationMessageIds' ? $2`, contextKey, message.ID) != 1 {
		if time.Now().After(deadline) {
			t.Fatalf("periodic scan did not execute Human request: streams=%d/%d rejected=%d inputs=%d", opened.Load(), ended.Load(), rejected.Load(), countRows(t, env, `SELECT count(*) FROM agent_runtime_inputs WHERE context_key=$1`, contextKey))
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Logf("periodic scan recovered after %s; wake stream rejected %d reconnects", time.Since(submittedAt).Round(time.Millisecond), rejected.Load())
	var inputID, runID, currentEpoch string
	if err := env.pool.QueryRow(t.Context(), `SELECT input_id,local_run_id FROM agent_runtime_inputs WHERE context_key=$1 AND payload->'invocationMessageIds' ? $2`, contextKey, message.ID).Scan(&inputID, &runID); err != nil {
		t.Fatal(err)
	}
	assertDirectInboxProcessReceipt(t, env, contextKey, inputID, runID, "succeeded", 1)
	if err := env.pool.QueryRow(t.Context(), `SELECT epoch FROM agent_service_epochs`).Scan(&currentEpoch); err != nil {
		t.Fatal(err)
	}
	if opened.Load() != 1 || ended.Load() != 1 || rejected.Load() < 2 || currentEpoch != startedEpoch {
		t.Fatalf("fallback invariant failed: streams=%d/%d rejected=%d sameAgent=%t", opened.Load(), ended.Load(), rejected.Load(), currentEpoch == startedEpoch)
	}
}

// The first Agent OS process cannot claim work while the callback transport is
// unavailable. The replacement must execute the same already-handled input and
// queued Run from PostgreSQL, rather than admit the Human message again.
func TestDirectInboxAgentProcessRecoversCanonicalQueuedInput(t *testing.T) {
	buildTeamHubCLIForProcess(t)
	var unavailable atomic.Bool
	var blockedClaims atomic.Int64
	unavailable.Store(true)
	env, alice, computer := newDirectInboxProcessEnv(t, func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			if request.URL.Path == "/v0/agent-runtime/runs/claim" && unavailable.Load() {
				blockedClaims.Add(1)
				http.Error(writer, "fixture claim transport unavailable", http.StatusServiceUnavailable)
				return
			}
			next.ServeHTTP(writer, request)
		})
	})
	direct := requestDirectRoom(alice, env.server.URL, "actor_acme_official")
	if direct.err != nil || (direct.status != http.StatusCreated && direct.status != http.StatusOK) {
		t.Fatalf("create Direct Room: %d %v %s", direct.status, direct.err, direct.body)
	}
	roomID := direct.roomID
	const contextID = "process_native_durable_context"
	const wrongID = "process_native_unselected_context"
	insertHistoryFixture(t, env, roomID, contextID, "conversation", "Durable selected context")
	insertHistoryFixture(t, env, roomID, wrongID, "conversation", "Unselected context")
	const requestText = "direct-process-native-persisted-input"
	code, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/messages", map[string]any{
		"raw_message": requestText + " @Official", "context_message_ids": []string{contextID},
		"segments": []map[string]any{{"type": "text", "content": requestText + " "},
			{"type": "reference", "content": "@Official", "target": "actor_acme_official", "target_type": "agent"}},
	}, "direct-native-process-request")
	if code != http.StatusCreated {
		t.Fatalf("submit Human request: %d %s", code, body)
	}
	var submitted struct{ ID string }
	decode(t, body, &submitted)
	service := agentruntimestate.New(env.pool)
	ensured, err := service.EnsureContext(t.Context(), agentruntimestate.EnsureContextInput{Ref: agentruntimestate.ContextRef{Kind: "meta", AgentID: acmeOfficialAgentManagementID, RoomID: roomID}, TargetResidency: "active"})
	if err != nil {
		t.Fatal(err)
	}
	startRuntimeEpoch(t, service, "native-process-fixture")
	// A Context created after the Message still receives it once.
	requeueCommittedRoomMessage(t, env.pool, submitted.ID)
	queued := queuedRuntimeInbox(t, env.pool, ensured.Context.ContextKey, submitted.ID)
	if queued.RunID == "" {
		t.Fatalf("Human request queued no Run: %+v", queued)
	}
	var durable []byte
	var durableHash []byte
	if err := env.pool.QueryRow(t.Context(), `SELECT payload,payload_hash FROM agent_runtime_inputs WHERE context_key=$1 AND input_id=$2 AND status='handled'`, ensured.Context.ContextKey, queued.InputID).Scan(&durable, &durableHash); err != nil {
		t.Fatal(err)
	}
	var persisted struct {
		Accepted struct {
			CursorEncoding string `json:"cursorEncoding"`
			Messages       []struct {
				ID                string   `json:"id"`
				Body              string   `json:"body"`
				ContextMessageIDs []string `json:"contextMessageIds"`
			} `json:"messages"`
		} `json:"acceptedNotification"`
	}
	if err := json.Unmarshal(durable, &persisted); err != nil {
		t.Fatal(err)
	}
	if persisted.Accepted.CursorEncoding != "room_event_v1" || len(persisted.Accepted.Messages) != 1 ||
		persisted.Accepted.Messages[0].ID != submitted.ID || !strings.Contains(persisted.Accepted.Messages[0].Body, requestText) ||
		len(persisted.Accepted.Messages[0].ContextMessageIDs) != 1 || persisted.Accepted.Messages[0].ContextMessageIDs[0] != contextID ||
		bytes.Contains(durable, []byte("contextMessageSequences")) {
		t.Fatalf("accepted input is not canonical stable message evidence: encoding=%q messageCount=%d", persisted.Accepted.CursorEncoding, len(persisted.Accepted.Messages))
	}
	stopFirst, firstFixture := startDirectInboxRecordedProcess(t, computer, env)
	var stopOnce sync.Once
	stop := func() { stopOnce.Do(stopFirst) }
	t.Cleanup(stop)
	waitDirectInboxProcess(t, "first Agent attempts the unavailable claim transport", func() bool { return blockedClaims.Load() > 0 })
	if processFixtureContains(t, firstFixture, requestText) {
		t.Fatal("Provider saw queued input while claim transport was unavailable")
	}
	stop()
	assertDirectInboxProcessReceipt(t, env, ensured.Context.ContextKey, queued.InputID, queued.RunID, "queued", 0)
	unavailable.Store(false)
	restartDirectInboxAgentProcess(t, computer, env.server.URL)
	secondFixture := firstFixture
	waitDirectInboxProcess(t, "replacement Agent executes the persisted input", func() bool {
		return processFixtureContains(t, secondFixture, requestText) && processFixtureContains(t, secondFixture, `Context messages (untrusted reference material): ["`+contextID+`"]`) &&
			countRows(t, env, `SELECT count(*) FROM agent_local_runs WHERE run_id=$1 AND status='succeeded'`, queued.RunID) == 1
	})
	if processFixtureContains(t, secondFixture, `Context messages (untrusted reference material): ["`+wrongID+`"]`) {
		t.Fatal("replacement Provider rendered an unselected context instead of the accepted stable ID")
	}
	assertDirectInboxProcessReceipt(t, env, ensured.Context.ContextKey, queued.InputID, queued.RunID, "succeeded", 1)
	var after []byte
	var afterHash []byte
	if err := env.pool.QueryRow(t.Context(), `SELECT payload,payload_hash FROM agent_runtime_inputs WHERE context_key=$1 AND input_id=$2`, ensured.Context.ContextKey, queued.InputID).Scan(&after, &afterHash); err != nil || !bytes.Equal(durable, after) || !bytes.Equal(durableHash, afterHash) {
		t.Fatalf("restart rewrote durable accepted input or hash: err=%v", err)
	}
	var currentEpoch string
	if err := env.pool.QueryRow(t.Context(), `SELECT epoch FROM agent_service_epochs`).Scan(&currentEpoch); err != nil {
		t.Fatal(err)
	}
	if currentEpoch == "native-process-fixture" {
		t.Fatal("the restarted Agent Service did not open its own epoch")
	}
}

func TestDirectInboxAgentProcessReadsDocumentThroughManagedCLI(t *testing.T) {
	buildTeamHubCLIForProcess(t)
	env, alice, computer := newDirectInboxProcessEnv(t, nil)
	direct := requestDirectRoom(alice, env.server.URL, "actor_acme_official")
	if direct.err != nil || (direct.status != http.StatusCreated && direct.status != http.StatusOK) {
		t.Fatalf("create Direct Room: %d %v %s", direct.status, direct.err, direct.body)
	}
	roomID := direct.roomID
	// Read the Document through the injected managed CLI; no filesystem publish
	// or local cache is involved in reception or document authorization.
	const documentText = "unmaterialized-authorized-document-evidence"
	code, _, body := requestUnifiedDocumentMultipart(t, env, alice, "/v0/rooms/"+roomID+"/documents/uploads", "direct-unmaterialized-document",
		map[string]string{"filename": "unmaterialized.txt", "representation_format": "plain_text", "media_type": "text/plain"}, "unmaterialized.txt", []byte(documentText))
	if code != http.StatusCreated {
		t.Fatalf("upload document: %d %s", code, body)
	}
	var document struct{ ID string }
	decode(t, body, &document)
	if document.ID == "" {
		t.Fatalf("uploaded Document has no stable ID: %s", body)
	}
	const requestText = "direct-process-managed-cli-request"
	code, _, body = env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/messages", map[string]any{
		"raw_message": requestText + " @Official @unmaterialized.txt",
		"segments": []map[string]any{{"type": "text", "content": requestText + " "},
			{"type": "reference", "content": "@Official", "target": "actor_acme_official", "target_type": "agent"},
			{"type": "document", "content": " @unmaterialized.txt", "document_id": document.ID}},
	}, "direct-unmaterialized-process-request")
	if code != http.StatusCreated {
		t.Fatalf("submit Human request: %d %s", code, body)
	}
	var message struct{ ID string }
	decode(t, body, &message)
	stop, fixtureRoot := startDirectInboxManagedCLIProcess(t, computer, env, message.ID, document.ID)
	t.Cleanup(stop)
	waitDirectInboxProcess(t, "Document reference prompt reaches Provider", func() bool {
		return processFixtureContains(t, fixtureRoot, requestText)
	})
	if !processFixtureContains(t, fixtureRoot, "teamhub docs get <document_id>") || !processFixtureContains(t, fixtureRoot, document.ID) {
		t.Fatal("Provider did not receive a stable Document ID and CLI read command")
	}
	if processFixtureContains(t, fixtureRoot, "Current authorized materialized Document paths") {
		t.Fatal("Provider prompt depended on a materialized Document path")
	}
	before := historyCursorSnapshot(t, env)
	if err := os.WriteFile(filepath.Join(fixtureRoot, "cli-release"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	var evidence struct {
		MessageStatus      *int   `json:"message_status"`
		MessageBody        string `json:"message_body"`
		DocumentStatus     *int   `json:"document_status"`
		DocumentBody       string `json:"document_body"`
		ConfigPresent      bool   `json:"config_present"`
		AmbientTokenAbsent bool   `json:"ambient_token_absent"`
	}
	waitDirectInboxProcess(t, "Provider executes the injected managed CLI", func() bool {
		data, err := os.ReadFile(filepath.Join(fixtureRoot, "cli-result.json"))
		if os.IsNotExist(err) {
			return false
		}
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(data, &evidence); err != nil {
			t.Fatal(err)
		}
		return true
	})
	if evidence.MessageStatus == nil || *evidence.MessageStatus != 0 || evidence.DocumentStatus == nil || *evidence.DocumentStatus != 0 || !evidence.ConfigPresent || !evidence.AmbientTokenAbsent ||
		!strings.Contains(evidence.MessageBody, requestText) || !strings.Contains(evidence.DocumentBody, documentText) {
		t.Fatalf("managed Provider CLI did not read current authorized content: %+v", evidence)
	}
	assertHistoryCursors(t, env, before)
	if err := os.WriteFile(filepath.Join(fixtureRoot, "cli-finish"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	waitDirectInboxProcess(t, "CLI document-read Run succeeds", func() bool {
		return countRows(t, env, `SELECT count(*) FROM agent_local_runs run JOIN agent_runtime_inputs input ON input.local_run_id=run.run_id WHERE run.status='succeeded' AND input.payload->'invocationMessageIds' ? $1`, message.ID) == 1
	})
	if processFixtureContains(t, fixtureRoot, "messages.md") || processFixtureContains(t, fixtureRoot, "messages.json") {
		t.Fatal("Provider was instructed to depend on a projected message file")
	}
}

// Restart only Agent Service. The real Local Daemon, native home and workspace
// stay alive, so durable Run recovery cannot be satisfied by a new Host thread.
func restartDirectInboxAgentProcess(t *testing.T, computer *localBusinessProcessFixture, teamHubURL string) func() {
	t.Helper()
	return startLocalFixtureAgent(t, computer, teamHubURL)
}

func newDirectInboxProcessEnv(t *testing.T, wrap func(http.Handler) http.Handler) (*testEnv, *http.Client, *localBusinessProcessFixture) {
	t.Helper()
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(t.Context(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	seedRegisteredAgentComputers(t, pool)
	// The demo seed leaves reasoning unset; pin the model the Codex fixture serves.
	if _, err := pool.Exec(t.Context(), `UPDATE agent_registrations SET runtime_model='openai/gpt-6-astra',runtime_reasoning_effort='medium' WHERE actor_id='actor_acme_official'`); err != nil {
		t.Fatal(err)
	}
	artifactRoot := copyTemplateSkillObjects(t, pool)
	agentPort, releaseAgentPort := holdBusinessFixtureAgentPort(t)
	application, err := newIntegrationApp(t.Context(), config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.ArtifactStorageRoot = artifactRoot
		c.ArtifactMaxBytes = integrationSkillObjectMaxBytes
		c.NodeServicesURL = "http://127.0.0.1:" + strconv.Itoa(agentPort)
		c.TeamHubInternalToken = teamHubInternalToken
		c.NodeServicesInternalToken = nodeServicesInternalToken
		c.AgentRunTokenSecret = agentRunTokenSecret
		c.RunnerGatewayURL = "ws://127.0.0.1:" + strconv.Itoa(agentPort) + "/v1/runner-gateway"
		c.RunnerSigningKey = config.ServiceCredential(integrationSecretSeed, "runner-signing")
	}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	plain := application.Handler()
	wrapped := plain
	if wrap != nil {
		wrapped = wrap(plain)
	}
	// The test's transport wrapper sees only the processes the test starts.
	var placed atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if placed.Load() {
			wrapped.ServeHTTP(writer, request)
			return
		}
		plain.ServeHTTP(writer, request)
	}))
	releaseAgentPort()
	registerIntegrationServerCleanup(t, server)
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server, artifactRoot: artifactRoot}
	alice := env.login("alice", alicePassword)
	// The demo seed places the Agent on its Sponsor's Computer without a Runtime
	// Assignment. Serve that Computer and let the Sponsor place the Agent again,
	// then stop both processes: each test starts them against its own Room state.
	owner := localProcessComputerOwner{pool: pool, session: alice}
	var computerID, grantID string
	if err := pool.QueryRow(t.Context(), `SELECT tenant_id,created_by_actor_id,computer_id,workspace_grant_id FROM agent_registrations WHERE actor_id='actor_acme_official'`).Scan(&owner.tenantID, &owner.actorID, &computerID, &grantID); err != nil {
		t.Fatal(err)
	}
	computer := newLocalProcessComputer(t, agentPort, owner, computerID, grantID)
	computer.start(t, server.URL, "#!/bin/sh\nexec node "+shellQuoteProcess(filepath.Join(repositoryPath(), "scripts/test-fixtures/codex-app-server-fixture.mjs"))+" \"$@\" --empty-thread-history --persist-threads\n")
	computer.placeAgent(t, env, alice, "actor_acme_official")
	if !computer.stopAll() {
		t.Fatal("Local Computer processes did not stop after placement")
	}
	placed.Store(true)
	return env, alice, computer
}

func waitDirectInboxProcess(t *testing.T, outcome string, ready func() bool) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for !ready() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out: %s", outcome)
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func assertDirectInboxProcessReceipt(t *testing.T, env *testEnv, contextKey, inputID, runID, expectedStatus string, attempts int) {
	t.Helper()
	var inputCount, runCount, actualAttempts int
	var actualStatus string
	if err := env.pool.QueryRow(t.Context(), `SELECT count(*),count(DISTINCT local_run_id) FROM agent_runtime_inputs WHERE context_key=$1 AND input_id=$2 AND local_run_id=$3`, contextKey, inputID, runID).Scan(&inputCount, &runCount); err != nil {
		t.Fatal(err)
	}
	if err := env.pool.QueryRow(t.Context(), `SELECT status,attempt_count FROM agent_local_runs WHERE run_id=$1`, runID).Scan(&actualStatus, &actualAttempts); err != nil {
		t.Fatal(err)
	}
	if inputCount != 1 || runCount != 1 || actualStatus != expectedStatus || actualAttempts != attempts {
		t.Fatalf("persisted receipt: inputs=%d runs=%d status=%s attempts=%d", inputCount, runCount, actualStatus, actualAttempts)
	}
	if countRows(t, env, `SELECT count(*) FROM agent_runtime_inputs WHERE context_key=$1`, contextKey) != 1 || countRows(t, env, `SELECT count(*) FROM agent_local_runs WHERE context_key=$1`, contextKey) != 1 {
		t.Fatal("replacement Agent admitted duplicate input or Run")
	}
}

func startDirectInboxManagedCLIProcess(t *testing.T, computer *localBusinessProcessFixture, env *testEnv, messageID, documentID string) (func(), string) {
	t.Helper()
	fixtureRoot := t.TempDir()
	fixture, err := os.ReadFile(filepath.Join(repositoryPath(), "scripts/test-fixtures/codex-app-server-fixture.mjs"))
	if err != nil {
		t.Fatal(err)
	}
	fixture = bytes.Replace(fixture, []byte("cwd: process.cwd(),"), []byte("cwd: threadWorkspaces.get(id) ?? process.cwd(),"), 2)
	fixture = append([]byte("import { spawnSync } from 'node:child_process';\nconst commandEnvironments = new Map();\n"), fixture...)
	messageJSON, _ := json.Marshal(messageID)
	documentJSON, _ := json.Marshal(documentID)
	hook := `const request = JSON.parse(line);
if (request.method === "thread/start" || request.method === "thread/resume") {
  commandEnvironments.set(request.params.threadId ?? "thread-created", {
    ...process.env, ...request.params.config?.shell_environment_policy?.set,
  });
}
if (request.method === "turn/start") {
  writeFileSync(new URL("./turn-" + process.pid + ".jsonl", import.meta.url), line + "\n", {flag:"a"});
  if (!request.params.outputSchema) {
    while (!existsSync(new URL("./cli-release", import.meta.url))) await delay(10);
    const env = commandEnvironments.get(request.params.threadId);
    if (!env?.TEAMHUB_CONFIG) throw new Error("Provider has no injected CLI configuration");
    const cwd = threadWorkspaces.get(request.params.threadId) ?? process.cwd();
    const message = spawnSync("teamhub", ["message", "read", "--message-ids", MESSAGE_ID, "--json"], {
      env, cwd, encoding:"utf8", timeout:15000,
    });
    const target = path.join(env.TMPDIR, "direct-cli-document.txt");
    const document = spawnSync("teamhub", ["docs", "get", DOCUMENT_ID, "-o", target, "--json"], {
      env, cwd, encoding:"utf8", timeout:15000,
    });
    writeFileSync(new URL("./cli-result.json", import.meta.url), JSON.stringify({
      message_status:message.status, message_body:message.stdout+message.stderr,
      document_status:document.status, document_body:existsSync(target)?readFileSync(target,"utf8"):document.stdout+document.stderr,
      config_present:existsSync(env.TEAMHUB_CONFIG), ambient_token_absent:!env.TEAMHUB_TOKEN && !env.TEAMHUB_TOKEN_FILE,
    }));
    while (!existsSync(new URL("./cli-finish", import.meta.url))) await delay(10);
  }
}`
	hook = strings.ReplaceAll(strings.ReplaceAll(hook, "MESSAGE_ID", string(messageJSON)), "DOCUMENT_ID", string(documentJSON))
	fixture = bytes.Replace(fixture, []byte("const request = JSON.parse(line);"), []byte(hook), 1)
	fixturePath := filepath.Join(fixtureRoot, "codex.mjs")
	if err := os.WriteFile(fixturePath, fixture, 0o600); err != nil {
		t.Fatal(err)
	}
	stop := computer.start(t, env.server.URL, "#!/bin/sh\nexec node '"+fixturePath+"' \"$@\" --empty-thread-history --persist-threads\n")
	return stop, fixtureRoot
}

func startDirectInboxRecordedProcess(t *testing.T, computer *localBusinessProcessFixture, env *testEnv) (func(), string) {
	t.Helper()
	fixtureRoot := t.TempDir()
	fixture, err := os.ReadFile(filepath.Join(repositoryPath(), "scripts/test-fixtures/codex-app-server-fixture.mjs"))
	if err != nil {
		t.Fatal(err)
	}
	// Resume reports the requested thread workspace, as the real app-server
	// does, instead of the service process cwd retained by the basic fixture.
	fixture = bytes.Replace(fixture, []byte("cwd: process.cwd(),"), []byte("cwd: threadWorkspaces.get(id) ?? process.cwd(),"), 2)
	fixture = bytes.Replace(fixture, []byte("const request = JSON.parse(line);"), []byte(`const request = JSON.parse(line);
if (request.method === "turn/start") writeFileSync(new URL("./turn-" + process.pid + ".jsonl", import.meta.url), line + "\n", {flag:"a"});`), 1)
	fixturePath := filepath.Join(fixtureRoot, "codex.mjs")
	if err := os.WriteFile(fixturePath, fixture, 0o600); err != nil {
		t.Fatal(err)
	}
	stop := computer.start(t, env.server.URL, "#!/bin/sh\nexec node '"+fixturePath+"' \"$@\" --empty-thread-history --persist-threads\n")
	return stop, fixtureRoot
}
