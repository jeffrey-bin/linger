//go:build integration_process

package integration_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type localProcessComputerOwner struct {
	pool              *pgxpool.Pool
	tenantID, actorID string
	// session is the owner's signed-in client; it enrolls the Computer.
	session *http.Client
}

// Keep the Agent port bound while httptest allocates the TeamHub listener.
// A closed ephemeral reservation can otherwise become TeamHub's own port.
func holdBusinessFixtureAgentPort(t *testing.T) (int, func()) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var once sync.Once
	release := func() {
		once.Do(func() {
			if err := listener.Close(); err != nil {
				t.Errorf("release reserved Agent port: %v", err)
			}
		})
	}
	t.Cleanup(release)
	return listener.Addr().(*net.TCPAddr).Port, release
}

// localBusinessProcessFixture is one isolated Local Computer. Its credential,
// Daemon state, native homes and workspace outlive Agent Service and Daemon
// restarts.
type localBusinessProcessFixture struct {
	root, computerID, daemon string
	port                     int
	owner                    localProcessComputerOwner
	stops                    []func() bool
	agentOutput              *processFixtureOutput
	daemonOutput             *processFixtureOutput
}

func processFixtureOutputTail(output *processFixtureOutput, max int) string {
	if output == nil {
		return ""
	}
	s := output.String()
	if max <= 0 {
		return s
	}
	runes := []rune(s)
	if len(runes) > max {
		return string(runes[len(runes)-max:])
	}
	return s
}

func (fixture *localBusinessProcessFixture) stopAll() bool {
	stopped := true
	for _, stop := range fixture.stops {
		if !stop() {
			stopped = false
		}
	}
	return stopped
}

// newLocalProcessComputer builds the real Local Daemon that serves computerID
// for the owner, with Agent Service listening on port as its Gateway.
func newLocalProcessComputer(t *testing.T, port int, owner localProcessComputerOwner, computerID, grantID string) *localBusinessProcessFixture {
	t.Helper()
	root := t.TempDir()
	fixture := &localBusinessProcessFixture{
		root: root, computerID: computerID, daemon: filepath.Join(root, "bin", "linger-computer-daemon"),
		port: port, owner: owner,
	}
	seedProcessFixtureComputer(t, owner, computerID, grantID)
	for _, dir := range []string{"daemon-home", "daemon-state", "workspace", "bin", "cli"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(node, filepath.Join(root, "bin", "node")); err != nil {
		t.Fatal(err)
	}
	// Match the installed release layout. The real daemon discovers only its
	// sibling CLI directory and still injects the per-Context managed config.
	writeProcessFixture(t, filepath.Join(root, "cli", "teamhub"), "#!/bin/sh\nexec "+shellQuoteProcess(node)+" "+shellQuoteProcess(filepath.Join(repositoryPath(), "apps/teamhub-cli/dist/teamhub.js"))+" \"$@\"\n", 0o700)
	writeProcessFixtureJSON(t, filepath.Join(root, "computer.json"), map[string]any{
		"runner_id": computerID, "display_name": "Isolated business-process Computer",
		"gateway":         map[string]string{"url": fmt.Sprintf("ws://127.0.0.1:%d/v1/runner-gateway", port), "token_file": filepath.Join(root, "runner-token")},
		"state_directory": filepath.Join(root, "daemon-state"), "runtime_paths": map[string]string{"codex": filepath.Join(root, "bin", "codex")},
		"workspace_grants": []map[string]string{{"grant_id": grantID, "tenant_id": owner.tenantID, "scope": "owner", "mode": "workspace-write", "root_path": filepath.Join(root, "workspace")}},
	})
	buildContext, cancel := context.WithTimeout(t.Context(), 90*time.Second)
	defer cancel()
	// Stamp the release version like the installed bundle. A "dev" identity
	// opts out of durable Codex sessions and therefore Room Context preparation.
	var manifest struct{ Version string }
	if raw, err := os.ReadFile(filepath.Join(repositoryPath(), "apps/computer/package.json")); err != nil || json.Unmarshal(raw, &manifest) != nil || manifest.Version == "" {
		t.Fatalf("read Local Computer release version: %v", err)
	}
	build := exec.CommandContext(buildContext, filepath.Join(runtime.GOROOT(), "bin", "go"), "build", "-ldflags",
		"-X github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport.ReleaseVersion="+manifest.Version, "-o", fixture.daemon, "./cmd/linger-computer-daemon")
	build.Dir = filepath.Join(repositoryPath(), "apps/computer/local-daemon")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build real Local Daemon: %v\n%s", err, output)
	}
	t.Cleanup(func() {
		if !fixture.stopAll() {
			t.Log("retain read-only fixture directories while process cleanup is unconfirmed")
			return
		}
		// Native Skill projections are read-only. Unprotect only directories
		// owned by this private fixture after both processes have stopped.
		if err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if entry.IsDir() {
				return os.Chmod(path, 0o700)
			}
			return nil
		}); err != nil {
			t.Errorf("unprotect Local Daemon fixture: %v", err)
		}
	})
	return fixture
}

// start runs Agent Service, enrolls the Computer on its first start, and then
// runs the real Local Daemon with codexScript as its Codex, and waits until the
// Daemon has registered that Runtime. Business turns run only in the real
// Computer process. The returned function stops Agent Service; the Daemon
// stops with the fixture.
func (fixture *localBusinessProcessFixture) start(t *testing.T, teamHubURL, codexScript string) func() {
	t.Helper()
	// Discovery is the real native version/auth/catalog path. Only its model
	// answers and the subsequent app-server protocol are deterministic fixtures.
	prelude := `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'codex-cli 0.150.1'; exit 0; fi
if [ "$1" = "debug" ]; then
  echo '{"models":[{"slug":"openai/gpt-6-astra","display_name":"GPT-6 Astra","default_reasoning_level":"medium","supported_reasoning_levels":[{"effort":"medium"}]},{"slug":"gpt-5","default_reasoning_level":"medium","supported_reasoning_levels":[{"effort":"medium"}]}]}'
  exit 0
fi
`
	writeProcessFixture(t, filepath.Join(fixture.root, "bin", "codex"), prelude+strings.TrimPrefix(codexScript, "#!/bin/sh\n"), 0o700)
	stopAgent := startLocalFixtureAgentProcess(t, fixture, teamHubURL)
	if _, err := os.Stat(filepath.Join(fixture.root, "runner-token")); errors.Is(err, fs.ErrNotExist) {
		fixture.enroll(t, teamHubURL)
	} else if err != nil {
		t.Fatal(err)
	}
	daemon := exec.Command(fixture.daemon, "--config", filepath.Join(fixture.root, "computer.json"))
	daemon.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	daemon.Env = []string{"PATH=" + filepath.Join(fixture.root, "bin") + ":/usr/bin:/bin", "HOME=" + filepath.Join(fixture.root, "daemon-home"), "LINGER_DAEMON_LAUNCH_NONCE=isolated-business-process"}
	output, exited, stopDaemon := startBusinessFixtureProcess(t, daemon, "Local Daemon")
	fixture.daemonOutput = output
	fixture.stops = append(fixture.stops, stopDaemon)
	deadline := time.Now().Add(30 * time.Second)
	for {
		var ready bool
		err := fixture.owner.pool.QueryRow(t.Context(), `SELECT status='online' AND daemon_id IS NOT NULL AND runtime_inventory ? 'codex' FROM local_computers WHERE computer_id=$1`, fixture.computerID).Scan(&ready)
		if err == nil && ready {
			break
		}
		select {
		case exit := <-exited:
			t.Fatalf("Local Daemon exited before registration: %v\n%s", exit, output.String())
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("Local Daemon did not register: %v\ndaemon output (tail):\n%s\nagent output (tail):\n%s", err, processFixtureOutputTail(output, 16<<10), processFixtureOutputTail(fixture.agentOutput, 16<<10))
		}
		time.Sleep(25 * time.Millisecond)
	}
	return func() { stopAgent() }
}

// enroll gets the Daemon's Runner credential as the owner does from the Web
// Computers page: a PKCE enrollment that renews the seeded Computer, exchanged
// once. Agent Service may still be loading its Computers right after startup;
// TeamHub answers a replay of the same exchange, so it is retried.
func (fixture *localBusinessProcessFixture) enroll(t *testing.T, teamHubURL string) {
	t.Helper()
	const redirectURI = "http://127.0.0.1:9/callback"
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		t.Fatal(err)
	}
	verifier := base64.RawURLEncoding.EncodeToString(secret)
	challenge := sha256.Sum256([]byte(verifier))
	status, body := postProcessFixtureJSON(t, fixture.owner.session, teamHubURL+"/v0/tenants/"+fixture.owner.tenantID+"/local-computer-enrollments", map[string]any{
		"computer_id": fixture.computerID, "display_name": "Isolated business-process Computer",
		"redirect_uri": redirectURI, "code_challenge": base64.RawURLEncoding.EncodeToString(challenge[:]),
	})
	var authorization struct {
		EnrollmentID      string `json:"enrollment_id"`
		AuthorizationCode string `json:"authorization_code"`
	}
	if status != http.StatusCreated || json.Unmarshal(body, &authorization) != nil {
		t.Fatalf("create Local Computer enrollment: %d %s\nagent output (tail):\n%s", status, body, processFixtureOutputTail(fixture.agentOutput, 16<<10))
	}
	exchange := map[string]string{"authorization_code": authorization.AuthorizationCode, "code_verifier": verifier, "redirect_uri": redirectURI}
	client := &http.Client{Timeout: 30 * time.Second}
	deadline := time.Now().Add(30 * time.Second)
	for {
		status, body = postProcessFixtureJSON(t, client, teamHubURL+"/v0/local-computer-enrollments/"+authorization.EnrollmentID+"/exchange", exchange)
		if status == http.StatusOK {
			break
		}
		if status < http.StatusInternalServerError || time.Now().After(deadline) {
			t.Fatalf("exchange Local Computer enrollment: %d %s\nagent output (tail):\n%s", status, body, processFixtureOutputTail(fixture.agentOutput, 16<<10))
		}
		time.Sleep(100 * time.Millisecond)
	}
	var bundle struct {
		ComputerID   string `json:"computer_id"`
		GatewayToken string `json:"gateway_token"`
	}
	if err := json.Unmarshal(body, &bundle); err != nil || bundle.ComputerID != fixture.computerID || bundle.GatewayToken == "" {
		t.Fatalf("Local Computer credential bundle is invalid (err=%v, computer=%q)", err, bundle.ComputerID)
	}
	writeProcessFixture(t, filepath.Join(fixture.root, "runner-token"), bundle.GatewayToken, 0o600)
}

func postProcessFixtureJSON(t *testing.T, client *http.Client, url string, payload any) (int, []byte) {
	t.Helper()
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	response, err := client.Post(url, "application/json", bytes.NewReader(encoded))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, body
}

// placeAgent saves the Agent's runtime unchanged, as its Sponsor does in Agent
// settings. That explicit rebind is how an Agent without a Runtime Assignment
// is placed again. Place before Room state exists: an Agent with queued work
// cannot be edited.
func (fixture *localBusinessProcessFixture) placeAgent(t *testing.T, env *testEnv, sponsor *http.Client, actorID string) {
	t.Helper()
	var tenantID, managementID, model, computerID, runtimeType, grantID string
	var effort *string
	var revision int64
	if err := env.pool.QueryRow(t.Context(), `SELECT tenant_id,agent_management_id,runtime_model,runtime_reasoning_effort,computer_id,local_runtime_type,workspace_grant_id,configuration_revision
	FROM agent_registrations WHERE actor_id=$1`, actorID).Scan(&tenantID, &managementID, &model, &effort, &computerID, &runtimeType, &grantID, &revision); err != nil {
		t.Fatal(err)
	}
	runtimeConfig := map[string]any{"model": model, "placement": map[string]any{
		"type": "local", "computer_id": computerID, "runtime_type": runtimeType, "workspace_grant_id": grantID,
	}}
	if effort != nil {
		runtimeConfig["reasoning_effort"] = *effort
	}
	code, _, body := env.request(sponsor, http.MethodPatch, "/v0/tenants/"+tenantID+"/agents/"+actorID,
		map[string]any{"expected_configuration_revision": revision, "runtime": runtimeConfig}, "process-fixture-place-"+actorID)
	if code != http.StatusOK {
		t.Fatalf("place %s: %d %s\nagent output (tail):\n%s", actorID, code, body, processFixtureOutputTail(fixture.agentOutput, 16<<10))
	}
	if countRows(t, env, `SELECT count(*) FROM agent_registrations WHERE agent_management_id=$1 AND computer_id=$2 AND local_runtime_type=$3`,
		managementID, fixture.computerID, runtimeType) != 1 {
		t.Fatalf("placing %s did not place it on %s", actorID, fixture.computerID)
	}
}

// seedProcessFixtureComputer records the owner's Computer, offline unless an
// earlier seed recorded it. Readiness waits for the Gateway's own observation
// of the Daemon and its Runtime; the real Gateway reports full diagnostics.
func seedProcessFixtureComputer(t *testing.T, owner localProcessComputerOwner, computerID, grantID string) {
	t.Helper()
	if _, err := owner.pool.Exec(t.Context(), `INSERT INTO local_computers(computer_id,display_name,status,owner_tenant_id,owner_actor_id,runtime_inventory,workspace_grants,runtime_diagnostics)
	VALUES($1,'Fixture Computer','offline',$2,$4,'["codex"]',
	jsonb_build_array(jsonb_build_object('grant_id',$3::text,'tenant_id',$2::text,'scope','owner','mode','workspace-write')),'[]')
	ON CONFLICT(computer_id) DO NOTHING`, computerID, owner.tenantID, grantID, owner.actorID); err != nil {
		t.Fatal(err)
	}
}

func startLocalFixtureAgent(t *testing.T, fixture *localBusinessProcessFixture, teamHubURL string) func() {
	stop := startLocalFixtureAgentProcess(t, fixture, teamHubURL)
	return func() { stop() }
}

func startLocalFixtureAgentProcess(t *testing.T, fixture *localBusinessProcessFixture, teamHubURL string) func() bool {
	t.Helper()
	root, port := fixture.root, fixture.port
	command := exec.Command("node", "--import", "tsx", "apps/node-services/src/main.ts")
	command.Dir = repositoryPath()
	command.Env = append(withoutEnv(os.Environ(), "CODEX_HOME", "CODEX_CLI_PATH", "TEAMHUB_CLI_BASE_URL", "NODE_SERVICES_ROLES",
		"AGENT_RUNNER_PUBLIC_GATEWAY_URL", "AWS_PROFILE", "AWS_REGION", "AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_EC2"),
		"NODE_SERVICES_ROLES=agent", "NODE_SERVICES_HTTP_ADDRESS=127.0.0.1:"+strconv.Itoa(port), "LINGER_SECRET_SEED="+integrationSecretSeed,
		"AGENT_HOME="+root, "AGENT_LOG_LEVEL=info", "NODE_ENV=test", "TEAMHUB_BASE_URL="+teamHubURL,
		fmt.Sprintf("AGENT_RUNNER_PUBLIC_GATEWAY_URL=ws://127.0.0.1:%d/v1/runner-gateway", port), "AWS_ENDPOINT_URL_EC2=http://127.0.0.1:1", "AWS_EC2_METADATA_DISABLED=true")
	output, exited, stop := startBusinessFixtureProcess(t, command, "Agent Service")
	fixture.agentOutput = output
	fixture.stops = append(fixture.stops, stop)
	t.Cleanup(func() { stop() })
	client := &http.Client{Timeout: time.Second}
	deadline := time.Now().Add(30 * time.Second)
	var lastRequestErr error
	var lastStatus int
	// os/exec pumps a non-*os.File Writer in real time via io.Copy.
	// The listen line is printed after bootstrapAgentManager returns
	// (apps/node-services/src/agent/main.ts), and /startupz answers ok once
	// every selected role has started. The reserved port can be taken by
	// another process between release and this child's bind, so require
	// HTTP ok plus this process's ownedAddress, then confirm the process is
	// still alive.
	ownedAddress := fmt.Sprintf("AgentManager API: http://127.0.0.1:%d\n", port)
	for {
		select {
		case exit := <-exited:
			t.Fatalf("Agent exited before readiness: %v\n%s", exit, processFixtureOutputTail(output, 16<<10))
		default:
		}
		response, requestErr := client.Get(fmt.Sprintf("http://127.0.0.1:%d/startupz", port))
		lastRequestErr = requestErr
		if requestErr == nil {
			var readiness struct {
				Status string `json:"status"`
			}
			decodeErr := json.NewDecoder(io.LimitReader(response.Body, 1024)).Decode(&readiness)
			lastStatus = response.StatusCode
			_ = response.Body.Close()
			if response.StatusCode == http.StatusOK && decodeErr == nil && readiness.Status == "ok" {
				snapshot := output.String()
				if strings.Contains(snapshot, ownedAddress) {
					select {
					case exit := <-exited:
						t.Fatalf("Agent exited before readiness: %v\n%s", exit, processFixtureOutputTail(output, 16<<10))
					default:
					}
					break
				}
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("Agent startup timed out status=%d err=%v ownedAddress=%t\n%s", lastStatus, lastRequestErr, strings.Contains(output.String(), ownedAddress), processFixtureOutputTail(output, 16<<10))
		}
		time.Sleep(25 * time.Millisecond)
	}
	return stop
}

type processFixtureOutput struct {
	sync.Mutex
	bytes.Buffer
}

func (b *processFixtureOutput) Write(p []byte) (int, error) {
	b.Lock()
	defer b.Unlock()
	return b.Buffer.Write(p)
}
func (b *processFixtureOutput) String() string { b.Lock(); defer b.Unlock(); return b.Buffer.String() }

func startBusinessFixtureProcess(t *testing.T, command *exec.Cmd, label string) (*processFixtureOutput, <-chan error, func() bool) {
	t.Helper()
	output := &processFixtureOutput{}
	command.Stdout, command.Stderr = output, output
	command.WaitDelay = time.Second
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan error, 1)
	go func() { exited <- command.Wait(); close(exited) }()
	var once sync.Once
	stopped := false
	stop := func() bool {
		once.Do(func() {
			owned := make(map[int]businessFixtureProcess)
			inspected := false
			if processes, err := readBusinessFixtureProcesses(); err != nil {
				t.Errorf("inspect %s descendants: %v", label, err)
			} else if root, ok := processes[command.Process.Pid]; ok {
				owned[root.pid] = root
				retainBusinessFixtureDescendants(processes, owned)
				inspected = true
			} else {
				t.Errorf("%s exited before descendant cleanup ownership was captured", label)
			}
			_ = command.Process.Signal(os.Interrupt)
			finished, forced := false, false
			var exitErr error
			select {
			case exitErr = <-exited:
				finished = true
			case <-time.After(5 * time.Second):
				stopBusinessFixtureDescendants(t, label, command.Process.Pid, owned)
				forced = true
				_ = command.Process.Kill()
				select {
				case exitErr = <-exited:
					finished = true
				case <-time.After(2 * time.Second):
					t.Errorf("%s did not exit after forced cleanup", label)
				}
			}
			stopBusinessFixtureDescendants(t, label, command.Process.Pid, owned)
			stopped = confirmBusinessFixtureDescendantsStopped(t, label, command.Process.Pid, owned) && finished && inspected
			var exit *exec.ExitError
			expectedSignal := false
			if errors.As(exitErr, &exit) {
				status, ok := exit.Sys().(syscall.WaitStatus)
				expectedSignal = ok && status.Signaled() && (status.Signal() == syscall.SIGINT || forced && status.Signal() == syscall.SIGKILL)
			}
			if exitErr != nil && !expectedSignal {
				t.Errorf("%s shutdown: %v", label, exitErr)
			}
			if t.Failed() {
				t.Logf("%s output:\n%s", label, output.String())
			}
		})
		return stopped
	}
	return output, exited, stop
}

type businessFixtureProcess struct {
	pid, parent    int
	started, state string
}

func readBusinessFixtureProcesses() (map[int]businessFixtureProcess, error) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "/bin/ps", "-axo", "pid=,ppid=,stat=,lstart=")
	command.Env = []string{"PATH=/usr/bin:/bin", "LC_ALL=C"}
	command.WaitDelay = time.Second
	output, err := command.Output()
	if err != nil {
		return nil, err
	}
	processes := make(map[int]businessFixtureProcess)
	for _, line := range strings.Split(string(output), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 8 {
			continue
		}
		pid, pidErr := strconv.Atoi(fields[0])
		parent, parentErr := strconv.Atoi(fields[1])
		if pidErr == nil && parentErr == nil {
			processes[pid] = businessFixtureProcess{pid, parent, strings.Join(fields[3:], " "), fields[2]}
		}
	}
	return processes, nil
}

func retainBusinessFixtureDescendants(processes, owned map[int]businessFixtureProcess) {
	// Native providers have their own process groups. Follow parentage while
	// the leader exists, and retain the observed start identity across reparenting.
	for changed := true; changed; {
		changed = false
		for pid, process := range processes {
			if previous, ok := owned[pid]; ok && previous.started == process.started {
				continue
			}
			parent, belongs := owned[process.parent]
			liveParent, live := processes[process.parent]
			if belongs && live && parent.started == liveParent.started {
				owned[pid] = process
				changed = true
			}
		}
	}
}

func stopBusinessFixtureDescendants(t *testing.T, label string, leader int, owned map[int]businessFixtureProcess) {
	t.Helper()
	for _, signal := range []syscall.Signal{syscall.SIGTERM, syscall.SIGKILL} {
		processes, err := readBusinessFixtureProcesses()
		if err != nil {
			t.Errorf("inspect %s descendants before cleanup: %v", label, err)
			return
		}
		retainBusinessFixtureDescendants(processes, owned)
		signaled := false
		for pid, original := range owned {
			current, alive := processes[pid]
			if pid == leader || !alive || current.started != original.started {
				continue
			}
			if err := syscall.Kill(pid, signal); err != nil && err != syscall.ESRCH {
				t.Errorf("stop %s descendant %d: %v", label, pid, err)
			}
			signaled = true
		}
		if signal == syscall.SIGTERM && signaled {
			time.Sleep(50 * time.Millisecond)
		}
	}
}

func confirmBusinessFixtureDescendantsStopped(t *testing.T, label string, leader int, owned map[int]businessFixtureProcess) bool {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		processes, err := readBusinessFixtureProcesses()
		if err != nil {
			t.Errorf("confirm %s descendant cleanup: %v", label, err)
			return false
		}
		retainBusinessFixtureDescendants(processes, owned)
		remaining := 0
		for pid, original := range owned {
			current, alive := processes[pid]
			if pid != leader && alive && current.started == original.started && !strings.HasPrefix(current.state, "Z") {
				remaining++
			}
		}
		if remaining == 0 {
			return true
		}
		if time.Now().After(deadline) {
			t.Errorf("%s retained %d live descendants after forced cleanup", label, remaining)
			return false
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func writeProcessFixture(t *testing.T, filename, value string, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(filename, []byte(value), mode); err != nil {
		t.Fatal(err)
	}
}
func writeProcessFixtureJSON(t *testing.T, filename string, value any) {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	writeProcessFixture(t, filename, string(encoded), 0o600)
}
func shellQuoteProcess(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}
