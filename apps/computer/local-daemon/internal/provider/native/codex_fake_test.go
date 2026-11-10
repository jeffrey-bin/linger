package native

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// The test binary doubles as a fake Codex app-server when this variable is
// set. It is dispatched from init, before TestMain.
const codexFakeKey = "CODEX_FAKE_APP_SERVER"

func init() {
	switch {
	case os.Getenv("CODEX_FAKE_SLEEPER") != "":
		time.Sleep(time.Minute)
		os.Exit(0)
	case os.Getenv(codexFakeKey) != "":
		os.Exit(codexFakeMain(os.Args[1:]))
	}
}

// codexFakeTurn scripts one turn of the fake.
type codexFakeTurn struct {
	Items  []map[string]any `json:"items,omitempty"`
	Status string           `json:"status,omitempty"`
	Error  string           `json:"error,omitempty"`
	// ErrorInfo is the failed turn error's codexErrorInfo.
	ErrorInfo json.RawMessage `json:"errorInfo,omitempty"`
	Usage     map[string]any  `json:"usage,omitempty"`
	Stall     bool            `json:"stall,omitempty"`
	Exit      bool            `json:"exit,omitempty"`
	Child     bool            `json:"child,omitempty"`
	Rollout   []string        `json:"rollout,omitempty"`
	Reject    bool            `json:"reject,omitempty"`
	Config    string          `json:"config,omitempty"`
	NoAckID   bool            `json:"noAckId,omitempty"`
	// Die ends the leader during the turn: "SIGTERM" or an exit code.
	Die string `json:"die,omitempty"`
	// Gate holds the turn open until the file named by FAKE_GATE exists. The
	// fake writes FAKE_GATE+".started" first.
	Gate bool `json:"gate,omitempty"`
	// DelayMs holds turn/completed back for this long.
	DelayMs int `json:"delayMs,omitempty"`
}

type codexFakeServer struct {
	mu      sync.Mutex
	out     *bufio.Writer
	modes   map[string]bool
	turns   []codexFakeTurn
	count   int
	thread  string
	current string
	pages   int
}

func codexFakeMain(args []string) int {
	if len(args) == 1 && args[0] == "--version" {
		version := os.Getenv("FAKE_VERSION")
		if version == "" {
			version = "0.100.0"
		}
		fmt.Println("codex-cli " + version)
		return 0
	}
	if path := os.Getenv("FAKE_LAUNCHES"); path != "" {
		appendFile(path, "x")
	}
	if path := os.Getenv("FAKE_ARGV"); path != "" {
		appendFile(path, strings.Join(args, "\x00")+"\n")
	}
	server := &codexFakeServer{out: bufio.NewWriter(os.Stdout), modes: map[string]bool{}, thread: "thread-1"}
	for _, mode := range strings.Split(os.Getenv("FAKE_MODES"), ",") {
		server.modes[mode] = true
	}
	_ = json.Unmarshal([]byte(os.Getenv("FAKE_TURNS")), &server.turns)
	if receipt := os.Getenv("FAKE_GRANDCHILD"); receipt != "" {
		child := exec.Command(os.Args[0])
		child.Env = []string{"CODEX_FAKE_SLEEPER=1"}
		if server.modes["child_holds_stdout"] {
			child.Stdout = os.Stdout
		}
		if child.Start() == nil {
			appendFile(receipt, fmt.Sprintf("%d %d\n", os.Getpid(), child.Process.Pid))
		}
	}
	if text := os.Getenv("FAKE_STDERR"); text != "" {
		fmt.Fprintln(os.Stderr, text)
	}
	reader := bufio.NewReaderSize(os.Stdin, 1<<20)
	for {
		line, err := reader.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			if path := os.Getenv("FAKE_LOG"); path != "" {
				appendFile(path, string(line))
			}
			if code, exit := server.handle(line); exit {
				return code
			}
		}
		if err != nil {
			return 0
		}
	}
}

func appendFile(path, text string) {
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	_, _ = file.WriteString(text)
	_ = file.Close()
}

func (s *codexFakeServer) send(message map[string]any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	message["jsonrpc"] = "2.0"
	encoded, _ := json.Marshal(message)
	_, _ = s.out.Write(append(encoded, '\n'))
	_ = s.out.Flush()
}

func (s *codexFakeServer) result(id json.RawMessage, result any) {
	s.send(map[string]any{"id": id, "result": result})
}

func (s *codexFakeServer) reject(id json.RawMessage, code int, message string) {
	s.send(map[string]any{"id": id, "error": map[string]any{"code": code, "message": message}})
}

func (s *codexFakeServer) handle(line []byte) (int, bool) {
	var request struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params map[string]any  `json:"params"`
	}
	if json.Unmarshal(line, &request) != nil || request.ID == nil || request.Method == "" {
		return 0, false
	}
	if os.Getenv("FAKE_STALL") == request.Method {
		time.Sleep(time.Minute)
	}
	switch request.Method {
	case "initialize":
		if s.modes["init_exit17"] {
			fmt.Fprintln(os.Stderr, "secret token sk-live-1234567890abcdef1234567890")
			return 17, true
		}
		if s.modes["write_system_skills"] {
			// Codex installs its own system Skills into a new home at start.
			dir := filepath.Join(os.Getenv("CODEX_HOME"), "skills", ".system", "imagegen")
			_ = os.MkdirAll(dir, 0o700)
			_ = os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("system"), 0o600)
		}
		s.result(request.ID, map[string]any{"userAgent": "fake"})
	case "config/read":
		if raw := os.Getenv("FAKE_CONFIG_READ"); raw != "" {
			s.send(map[string]any{"id": request.ID, "result": json.RawMessage(raw)})
			return 0, false
		}
		s.result(request.ID, map[string]any{"config": map[string]any{"features": map[string]any{"memories": false, "memory_tool": false}}})
	case "thread/start":
		if path := os.Getenv("FAKE_TRUST_APPEND"); path != "" {
			appendFile(path, "\n[projects.\"/trusted\"]\ntrust_level = \"trusted\"\n")
		}
		s.result(request.ID, map[string]any{"thread": map[string]any{"id": s.thread}})
	case "thread/resume":
		switch {
		case s.modes["reject_resume"]:
			s.reject(request.ID, -32600, "no rollout found for thread id "+request.Params["threadId"].(string))
		case s.modes["other_thread"]:
			s.result(request.ID, map[string]any{"thread": map[string]any{"id": "thread-other"}})
		default:
			s.thread, _ = request.Params["threadId"].(string)
			s.result(request.ID, map[string]any{"thread": map[string]any{"id": s.thread}})
		}
	case "thread/name/set":
		switch {
		case s.modes["reject_name"]:
			s.reject(request.ID, -32603, "name failed")
		case s.modes["name_hang"]:
		case s.modes["name_slow"]:
			go func(id json.RawMessage) {
				time.Sleep(2 * time.Second)
				s.result(id, map[string]any{})
			}(request.ID)
		default:
			s.result(request.ID, map[string]any{})
		}
	case "turn/start":
		return s.turn(request.ID, false)
	case "thread/compact/start":
		// Codex answers {} and runs the compaction as a turn of its own.
		return s.turn(request.ID, true)
	case "turn/steer":
		return s.steer(request.ID, request.Params)
	case "turn/interrupt":
		s.result(request.ID, map[string]any{})
		s.send(map[string]any{"method": "turn/completed", "params": map[string]any{"threadId": s.thread, "turn": map[string]any{"id": s.current, "status": "interrupted"}}})
	case "thread/backgroundTerminals/list":
		raw := os.Getenv("FAKE_TERMINALS")
		if raw == "" {
			raw = `{"data":[]}`
		}
		s.send(map[string]any{"id": request.ID, "result": json.RawMessage(raw)})
	case "thread/loaded/list":
		s.result(request.ID, map[string]any{"data": []string{}, "nextCursor": nil})
	case "model/list":
		var pages []json.RawMessage
		_ = json.Unmarshal([]byte(os.Getenv("FAKE_MODEL_PAGES")), &pages)
		if s.pages >= len(pages) {
			s.reject(request.ID, -32603, "no page")
			return 0, false
		}
		s.send(map[string]any{"id": request.ID, "result": pages[s.pages]})
		s.pages++
	case "config/mcpServer/reload":
		if s.modes["reject_reload"] {
			s.reject(request.ID, -32603, "reload failed")
			return 0, false
		}
		s.result(request.ID, map[string]any{})
	default:
		s.result(request.ID, map[string]any{})
	}
	return 0, false
}

func (s *codexFakeServer) turn(id json.RawMessage, compact bool) (int, bool) {
	s.count++
	script := codexFakeTurn{Status: "completed"}
	if len(s.turns) > 0 {
		script = s.turns[min(s.count, len(s.turns))-1]
	}
	if script.Reject {
		s.reject(id, -32602, "turn rejected")
		return 0, false
	}
	s.current = "turn-" + strconv.Itoa(s.count)
	ack := map[string]any{"turn": map[string]any{"id": s.current}}
	if script.NoAckID || compact {
		ack = map[string]any{}
	}
	s.result(id, ack)
	s.send(map[string]any{"method": "turn/started", "params": map[string]any{"threadId": s.thread, "turn": map[string]any{"id": s.current, "status": "inProgress"}}})
	for _, item := range script.Items {
		encoded, _ := json.Marshal(item)
		encoded = bytes.ReplaceAll(encoded, []byte("$THREAD"), []byte(s.thread))
		encoded = bytes.ReplaceAll(encoded, []byte("$TURN"), []byte(s.current))
		var message map[string]any
		_ = json.Unmarshal(encoded, &message)
		// A fake/pause item spaces the notifications in time.
		if message["method"] == "fake/pause" {
			milliseconds, _ := message["ms"].(float64)
			time.Sleep(time.Duration(milliseconds) * time.Millisecond)
			continue
		}
		s.send(message)
	}
	home := os.Getenv("CODEX_HOME")
	if len(script.Rollout) > 0 {
		dir := filepath.Join(home, "sessions", "2026", "10", "29")
		_ = os.MkdirAll(dir, 0o700)
		_ = os.WriteFile(filepath.Join(dir, "rollout-"+s.current+".jsonl"), []byte(strings.Join(script.Rollout, "\n")+"\n"), 0o600)
	}
	if script.Config != "" {
		_ = os.WriteFile(filepath.Join(home, "config.toml"), []byte(script.Config), 0o600)
	}
	switch script.Die {
	case "":
	case "SIGTERM":
		self, _ := os.FindProcess(os.Getpid())
		_ = self.Signal(syscall.SIGTERM)
		time.Sleep(time.Minute)
	default:
		code, _ := strconv.Atoi(script.Die)
		return code, true
	}
	if script.Stall {
		return 0, false
	}
	if gate := os.Getenv("FAKE_GATE"); script.Gate && gate != "" {
		appendFile(gate+".started", "x")
		for {
			if _, err := os.Stat(gate); err == nil {
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	time.Sleep(time.Duration(script.DelayMs) * time.Millisecond)
	turn := map[string]any{"id": s.current, "status": script.Status}
	if script.Error != "" {
		turn["error"] = map[string]any{"message": script.Error, "codexErrorInfo": script.ErrorInfo}
	}
	if script.Usage != nil {
		turn["usage"] = script.Usage
	}
	s.send(map[string]any{"method": "turn/completed", "params": map[string]any{"threadId": s.thread, "turn": turn}})
	if script.Exit {
		return 0, true
	}
	return 0, false
}

// steer answers turn/steer the way a mode says Codex consumed it: consumed
// echoes the input as a userMessage with its client id before the turn
// ends, unconsumed ends the turn without it, foreign shows only other
// threads' or other clients' messages, and reject refuses the steer.
func (s *codexFakeServer) steer(id json.RawMessage, params map[string]any) (int, bool) {
	if s.modes["steer_reject"] {
		s.reject(id, -32600, "no active turn to steer")
		return 0, false
	}
	s.result(id, map[string]any{"turnId": s.current})
	clientID, _ := params["clientUserMessageId"].(string)
	message := func(thread, client string) {
		item := map[string]any{"id": "user-" + client, "type": "userMessage", "clientId": client, "content": []any{}}
		for _, method := range []string{"item/started", "item/completed"} {
			s.send(map[string]any{"method": method, "params": map[string]any{"threadId": thread, "turnId": s.current, "item": item}})
		}
	}
	switch {
	case s.modes["steer_consumed"]:
		message(s.thread, clientID)
	case s.modes["steer_foreign"]:
		message(s.thread, "another-client")
		message("child-thread", clientID)
	case !s.modes["steer_unconsumed"]:
		return 0, false
	}
	s.send(map[string]any{"method": "turn/completed", "params": map[string]any{"threadId": s.thread, "turn": map[string]any{"id": s.current, "status": "completed"}}})
	return 0, false
}

// codexTestLog captures structured logs of one Operation.
type codexTestLog struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (l *codexTestLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.Write(p)
}

func (l *codexTestLog) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.String()
}

func (l *codexTestLog) logger() *slog.Logger {
	return slog.New(slog.NewJSONHandler(l, &slog.HandlerOptions{Level: slog.LevelDebug}))
}

// codexFake is one fake app-server installation with its own Codex home.
type codexFake struct {
	t        *testing.T
	root     string
	home     string
	dir      string
	log      string
	launches string
	env      map[string]string
	version  string
	program  string
	// skillDigest and configDigest are the delivered inputs the next
	// runtime() reports.
	skillDigest  string
	configDigest string
}

func newCodexFake(t *testing.T, turns []codexFakeTurn, env map[string]string) *codexFake {
	t.Helper()
	root := t.TempDir()
	program, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	f := &codexFake{t: t, root: root, home: filepath.Join(root, "home"), dir: filepath.Join(root, "work"),
		log: filepath.Join(root, "requests"), launches: filepath.Join(root, "launches"), program: program}
	for _, dir := range []string{f.home, f.dir} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	encoded, _ := json.Marshal(turns)
	f.env = map[string]string{codexFakeKey: "1", "CODEX_HOME": f.home, "FAKE_LOG": f.log, "FAKE_LAUNCHES": f.launches, "FAKE_TURNS": string(encoded)}
	for key, value := range env {
		f.env[key] = value
	}
	previousGrace := codexStopGrace.set(time.Second)
	withResidentCap(t, codexResidents, DefaultResidentCap)
	t.Cleanup(func() {
		codexStopGrace.set(previousGrace)
		codexForceUnconfirmed(nil)
		_, _ = StopCodexHomeForMaintenance(f.home)
	})
	return f
}

func (f *codexFake) runtime(logger *slog.Logger) Runtime {
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	rt, err := Open("codex", Profile{Program: f.program, Env: f.env, Logger: logger, CodexToolVersion: f.version, ComputerVersion: "test", TaskID: "task-" + f.t.Name(),
		ResidentSkillDigest: f.skillDigest, CodexConfigDigest: f.configDigest})
	if err != nil {
		f.t.Fatal(err)
	}
	return rt
}

// scopedRuntime opens the fake for one Context and Agent.
func (f *codexFake) scopedRuntime(logger *slog.Logger, contextKey, agentID string) Runtime {
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	rt, err := Open("codex", Profile{Program: f.program, Env: f.env, Logger: logger, ComputerVersion: "test",
		ContextKey: contextKey, AgentID: agentID})
	if err != nil {
		f.t.Fatal(err)
	}
	return rt
}

func (f *codexFake) spec() RunSpec { return RunSpec{Dir: f.dir, Budget: 20 * time.Second} }

func (f *codexFake) methods() []string {
	data, _ := os.ReadFile(f.log)
	var methods []string
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var request struct {
			Method string `json:"method"`
		}
		if json.Unmarshal([]byte(line), &request) == nil && request.Method != "" {
			methods = append(methods, request.Method)
		}
	}
	return methods
}

func (f *codexFake) requests(method string) []map[string]any {
	data, _ := os.ReadFile(f.log)
	var out []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var request map[string]any
		if json.Unmarshal([]byte(line), &request) == nil && request["method"] == method {
			out = append(out, request)
		}
	}
	return out
}

func (f *codexFake) count(method string) int { return len(f.requests(method)) }

func (f *codexFake) launchCount() int {
	data, _ := os.ReadFile(f.launches)
	return len(data)
}

// codexDrain runs one Operation to its Outcome.
func codexDrain(t *testing.T, rt Runtime, prompt string, spec RunSpec) (Outcome, []Event) {
	t.Helper()
	run, err := rt.Start(context.Background(), prompt, spec)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	return codexCollect(t, run)
}

func codexCollect(t *testing.T, run *Run) (Outcome, []Event) {
	t.Helper()
	var events []Event
	deadline := time.After(40 * time.Second)
	for {
		select {
		case event, ok := <-run.Events:
			if !ok {
				select {
				case out := <-run.Outcome:
					return out, events
				case <-deadline:
					t.Fatal("no outcome")
				}
			}
			events = append(events, event)
		case <-deadline:
			t.Fatal("operation did not finish")
		}
	}
}

// codexForceUnconfirmed makes every exit confirmation fail while set.
func codexForceUnconfirmed(force *atomic.Bool) {
	codexOverrideMu.Lock()
	defer codexOverrideMu.Unlock()
	if force == nil {
		codexConfirmOverride.Store(nil)
		return
	}
	override := func(*codexProcess) bool { return !force.Load() }
	codexConfirmOverride.Store(&override)
}

var codexOverrideMu sync.Mutex

func codexAgentMessage(id, text string, phase any) map[string]any {
	item := map[string]any{"id": id, "type": "agentMessage", "text": text}
	if phase != nil {
		item["phase"] = phase
	}
	return map[string]any{"method": "item/completed", "params": map[string]any{"threadId": "$THREAD", "turnId": "$TURN", "item": item}}
}
