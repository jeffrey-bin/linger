package native

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// The test binary doubles as a fake Claude CLI. A child started with
// claudeFakeKey runs the named mode before TestMain.
const claudeFakeKey = "CLAUDE_FAKE_MODE"

func init() {
	if mode := os.Getenv(claudeFakeKey); mode != "" {
		os.Exit(claudeFakeMain(mode))
	}
}

// claudeFakeProfile runs this test binary as fake mode with exactly env.
func claudeFakeProfile(t *testing.T, mode string, env map[string]string) Profile {
	t.Helper()
	program, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	full := map[string]string{claudeFakeKey: mode}
	for key, value := range env {
		full[key] = value
	}
	return Profile{Program: program, Env: full, Logger: claudeQuietLogger()}
}

type claudeFake struct {
	in      *bufio.Reader
	out     *bufio.Writer
	dir     string
	session string
	turns   int
}

func (f *claudeFake) emit(frame any) {
	var line []byte
	switch typed := frame.(type) {
	case string:
		line = []byte(typed)
	case json.RawMessage:
		line = typed
	default:
		line, _ = json.Marshal(typed)
	}
	_, _ = f.out.Write(line)
	_ = f.out.WriteByte('\n')
	_ = f.out.Flush()
}

func (f *claudeFake) record(name, text string) {
	if f.dir == "" {
		return
	}
	file, err := os.OpenFile(filepath.Join(f.dir, name), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer file.Close()
	_, _ = fmt.Fprintln(file, text)
}

type claudeFakeFrame struct {
	Type      string          `json:"type"`
	RequestID string          `json:"request_id"`
	UUID      string          `json:"uuid"`
	Request   json.RawMessage `json:"request"`
	Message   struct {
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
	} `json:"message"`
}

func (f *claudeFake) next() (claudeFakeFrame, string, bool) {
	line, err := f.in.ReadString('\n')
	if err != nil && line == "" {
		return claudeFakeFrame{}, "", false
	}
	var frame claudeFakeFrame
	_ = json.Unmarshal([]byte(line), &frame)
	return frame, strings.TrimSpace(line), true
}

func (f *claudeFake) answer(frame claudeFakeFrame, subtype string) {
	f.emit(map[string]any{"type": "control_response", "response": map[string]any{"subtype": subtype, "request_id": frame.RequestID, "response": map[string]any{}}})
}

func (f *claudeFake) frames() {
	var frames []json.RawMessage
	_ = json.Unmarshal([]byte(os.Getenv("CLAUDE_FAKE_FRAMES")), &frames)
	for _, frame := range frames {
		f.emit(frame)
	}
}

// claudeFakeChild starts a member of this process group that ignores TERM.
func claudeFakeChild() int {
	program, _ := os.Executable()
	cmd := exec.Command(program)
	cmd.Env = []string{claudeFakeKey + "=sleeper"}
	if err := cmd.Start(); err != nil {
		return 0
	}
	return cmd.Process.Pid
}

func claudeFakeMain(mode string) int {
	f := &claudeFake{
		in: bufio.NewReaderSize(os.Stdin, 1<<20), out: bufio.NewWriter(os.Stdout),
		dir: os.Getenv("CLAUDE_FAKE_DIR"), session: os.Getenv("CLAUDE_FAKE_SESSION"),
	}
	f.record("argv", strings.Join(os.Args[1:], "\n"))
	switch mode {
	case "sleeper":
		signal.Ignore(syscall.SIGTERM)
		time.Sleep(time.Minute)
		return 0
	case "early-exit":
		fmt.Fprintln(os.Stderr, "fatal: token=fake-secret-value-123456")
		return 23
	case "burst":
		for i := range 150 {
			f.emit(map[string]any{"type": "log", "log": map[string]any{"level": "info", "message": fmt.Sprintf("%d %s", i, strings.Repeat("x", 4096))}})
		}
		return f.serveFrames()
	case "frames":
		return f.serveFrames()
	case "reject-init":
		for {
			frame, _, ok := f.next()
			if !ok {
				return 0
			}
			if frame.Type == "control_request" {
				f.answer(frame, "error")
			}
		}
	case "signal":
		return f.signalled()
	case "resident":
		return f.resident()
	}
	return 2
}

func (f *claudeFake) serveFrames() int {
	for {
		frame, line, ok := f.next()
		if !ok {
			return 0
		}
		switch frame.Type {
		case "control_request":
			f.record("init", line)
			f.answer(frame, "success")
		case "user":
			f.frames()
			if code := os.Getenv("CLAUDE_FAKE_EXIT"); code != "" {
				var value int
				_, _ = fmt.Sscan(code, &value)
				return value
			}
			if os.Getenv("CLAUDE_FAKE_SEGV") != "" {
				// Go turns SIGSEGV into a crash exit, so let a shell with the
				// same pid die by the signal.
				_ = syscall.Exec("/bin/sh", []string{"sh", "-c", "kill -SEGV $$"}, nil)
				return 30
			}
			if os.Getenv("CLAUDE_FAKE_SLEEP") != "" {
				time.Sleep(30 * time.Second)
			}
			return 0
		default:
			return 22
		}
	}
}

// signalled answers initialize, reads the input, and then waits for TERM
// under the policy in CLAUDE_FAKE_POLICY.
func (f *claudeFake) signalled() int {
	policy := os.Getenv("CLAUDE_FAKE_POLICY")
	terms := make(chan os.Signal, 1)
	switch policy {
	case "ignore":
		signal.Ignore(syscall.SIGTERM)
	default:
		signal.Notify(terms, syscall.SIGTERM)
	}
	child := 0
	if policy == "child" || policy == "ignore" || policy == "report" {
		child = claudeFakeChild()
	}
	f.record("pids", fmt.Sprintf("%d %d", os.Getpid(), child))
	frame, _, ok := f.next()
	if !ok {
		return 4
	}
	initSubtype := os.Getenv("CLAUDE_FAKE_INIT")
	if initSubtype == "" {
		initSubtype = "success"
	}
	f.answer(frame, initSubtype)
	if initSubtype == "error" {
		for {
			time.Sleep(time.Second)
		}
	}
	if _, _, ok := f.next(); !ok {
		return 5
	}
	f.record("ready", "input")
	<-terms
	if policy == "report" {
		f.emit(`{"type":"result","subtype":"error","is_error":true,"result":"interrupted by caller"}`)
	}
	return 0
}

// resident serves many turns on one stdin, as the spec's resident fake.
func (f *claudeFake) resident() int {
	f.record("pids", fmt.Sprint(os.Getpid()))
	if path := claudeFakeMCPConfig(os.Args[1:]); path != "" {
		data, _ := os.ReadFile(path)
		_ = os.WriteFile(filepath.Join(f.dir, fmt.Sprintf("mcp-%d.json", os.Getpid())), data, 0o600)
	}
	slowTerm := os.Getenv("CLAUDE_FAKE_SLOW_TERM") != ""
	if slowTerm {
		terms := make(chan os.Signal, 1)
		signal.Notify(terms, syscall.SIGTERM)
		go func() {
			<-terms
			time.Sleep(500 * time.Millisecond)
			f.record("exits", fmt.Sprintf("%d %d", os.Getpid(), time.Now().UnixNano()))
			os.Exit(0)
		}()
	}
	f.record("starts", fmt.Sprintf("%d %d", os.Getpid(), time.Now().UnixNano()))
	f.record(fmt.Sprintf("argv-%d", os.Getpid()), strings.Join(os.Args[1:], "\n"))
	initMode := os.Getenv("CLAUDE_FAKE_INIT_MODE")
	systemInit := map[string]any{"type": "system", "subtype": "init", "session_id": f.session}
	for {
		frame, line, ok := f.next()
		if !ok {
			if slowTerm {
				select {}
			}
			return 0
		}
		if frame.Type == "control_request" {
			var request struct {
				Subtype string `json:"subtype"`
			}
			_ = json.Unmarshal(frame.Request, &request)
			switch request.Subtype {
			case "initialize":
				f.record("events", "init")
				if initMode == "early" {
					f.emit(systemInit)
				}
			case "interrupt":
				f.record("events", "interrupt")
			case "mcp_set_servers":
				f.record("mcp", fmt.Sprintf("mcp %d %s", os.Getpid(), line))
				var request struct {
					Servers map[string]json.RawMessage `json:"servers"`
				}
				_ = json.Unmarshal(frame.Request, &request)
				added := []string{}
				for name := range request.Servers {
					added = append(added, name)
				}
				change := map[string]any{"added": added, "removed": []string{}, "errors": map[string]any{}}
				if os.Getenv("CLAUDE_FAKE_MCP_ERROR") != "" {
					change = map[string]any{"added": []string{}, "removed": []string{}, "errors": map[string]any{"exp": "connection refused"}}
				}
				f.emit(map[string]any{"type": "control_response", "response": map[string]any{"subtype": "success", "request_id": frame.RequestID, "response": change}})
				continue
			}
			f.answer(frame, "success")
			continue
		}
		if frame.Type != "user" {
			continue
		}
		f.turns++
		prompt := ""
		for _, block := range frame.Message.Content {
			prompt += block.Text
		}
		f.record("events", fmt.Sprintf("user %d %s", os.Getpid(), frame.UUID))
		if initMode == "turn" {
			f.emit(systemInit)
		}
		if strings.Contains(prompt, "late") || strings.Contains(prompt, "slow") {
			time.Sleep(time.Second)
		}
		if strings.Contains(prompt, "noecho") {
			f.emit(map[string]any{"type": "result", "subtype": "error", "is_error": true, "terminal_reason": "completed",
				"result": "failed before echo", "session_id": f.session, "user_message_uuid": frame.UUID})
			continue
		}
		replay := map[string]any{"type": "user", "isReplay": true, "uuid": frame.UUID, "session_id": f.session}
		if strings.Contains(prompt, "stamp") {
			replay["timestamp"] = "2026-01-02T03:04:05.678Z"
		}
		f.emit(replay)
		if strings.Contains(prompt, "stderr") {
			fmt.Fprintf(os.Stderr, "stderr turn %d\n", f.turns)
		}
		if strings.Contains(prompt, "hang") {
			select {}
		}
		if strings.Contains(prompt, "hold") {
			continue
		}
		if strings.HasPrefix(prompt, "/compact") {
			// Claude 2.1.281: a boundary with pre_tokens, then a result
			// without terminal_reason. A short session gets no boundary.
			f.record("compacts", prompt)
			if !strings.Contains(prompt, "empty") {
				f.emit(map[string]any{"type": "system", "subtype": "compact_boundary", "session_id": f.session,
					"compact_metadata": map[string]any{"trigger": "manual", "pre_tokens": 44445}})
			}
			f.emit(map[string]any{"type": "result", "subtype": "success", "is_error": false, "result": "", "session_id": f.session})
			continue
		}
		if strings.Contains(prompt, "assist") {
			f.emit(map[string]any{"type": "assistant", "message": map[string]any{"id": "m1", "role": "assistant", "content": []any{
				map[string]any{"type": "text", "text": "looking"},
				map[string]any{"type": "tool_use", "id": "tool-1", "name": "Read", "input": map[string]any{"file_path": "x"}},
			}}})
		}
		if strings.Contains(prompt, "async") {
			f.emit(map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": []any{
				map[string]any{"type": "tool_result", "tool_use_id": "tool-1", "content": []any{map[string]any{"status": "async_launched"}}},
			}}})
		}
		if strings.Contains(prompt, "pause") {
			time.Sleep(time.Second)
		}
		reason := "completed"
		if strings.Contains(prompt, "reason") {
			reason = "max_turns"
		}
		f.emit(map[string]any{
			"type": "result", "subtype": "success", "is_error": strings.Contains(prompt, "error"),
			"terminal_reason": reason, "result": fmt.Sprintf("done %d", f.turns), "session_id": f.session,
			"user_message_uuid": frame.UUID,
			"modelUsage":        map[string]any{"m": map[string]any{"inputTokens": 10, "outputTokens": 5}},
		})
		if strings.Contains(prompt, "die") {
			return 0
		}
	}
}

func claudeFakeMCPConfig(args []string) string {
	for i, arg := range args {
		if arg == "--mcp-config" && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}
