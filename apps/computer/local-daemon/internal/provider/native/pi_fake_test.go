package native

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// The test binary doubles as a fake Pi when piFakeEnv is set. It is
// dispatched from init so the shared TestMain stays untouched.
const (
	piFakeEnv       = "NATIVE_PI_FAKE"
	piFakeRecordEnv = "PI_FAKE_RECORD"
	piFakeArgvEnv   = "PI_FAKE_ARGV"
	piFakeChildEnv  = "PI_FAKE_CHILD_PID"
	piFakeLogEnv    = "PI_FAKE_COMMANDS"
)

func init() {
	switch mode := os.Getenv(piFakeEnv); mode {
	case "":
	case "sleep":
		time.Sleep(time.Minute)
		os.Exit(0)
	case "catalog":
		os.Exit(piFakeCatalog())
	case "resident":
		os.Exit(piResidentFake(os.Args[1:]))
	default:
		os.Exit(piFake(mode, os.Args[1:]))
	}
}

type piFakeProcess struct {
	mode       string
	sessionDir string
	sessionID  string
	out        sync.Mutex
	cleared    bool
}

func (f *piFakeProcess) send(value any) {
	encoded, _ := json.Marshal(value)
	f.out.Lock()
	defer f.out.Unlock()
	_, _ = os.Stdout.Write(append(encoded, '\n'))
}

func (f *piFakeProcess) reply(id, command string, data any) {
	f.send(map[string]any{"type": "response", "id": id, "command": command, "success": true, "data": data})
}

func (f *piFakeProcess) assistantEnd(text, stopReason, errorMessage string) {
	f.send(map[string]any{"type": "message_end", "message": map[string]any{
		"role": "assistant", "model": "fixture/model", "stopReason": stopReason, "errorMessage": errorMessage,
		"content": []any{map[string]any{"type": "text", "text": text}},
		"usage":   map[string]any{"input": 2, "output": 3, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 5},
	}})
}

func (f *piFakeProcess) finish() {
	cwd, _ := os.Getwd()
	header, _ := json.Marshal(map[string]any{"type": "session", "id": f.sessionID, "cwd": cwd})
	_ = os.WriteFile(filepath.Join(f.sessionDir, "fixture_"+f.sessionID+".jsonl"), append(header, '\n'), 0o600)
	f.send(map[string]any{"type": "message_start", "message": map[string]any{"role": "assistant"}})
	f.send(map[string]any{"type": "message_update", "assistantMessageEvent": map[string]any{"type": "text_delta", "delta": "done"}})
	f.assistantEnd("done", "stop", "")
	f.send(map[string]any{"type": "agent_end"})
	f.send(map[string]any{"type": "agent_settled", "aborted": false})
}

func (f *piFakeProcess) tool(id, name string, isError bool) {
	f.send(map[string]any{"type": "tool_execution_start", "toolName": name, "toolCallId": id, "args": map[string]any{"command": "ls"}})
	f.send(map[string]any{"type": "tool_execution_end", "toolName": name, "toolCallId": id, "result": "output of " + id, "isError": isError})
}

func piFake(mode string, args []string) int {
	f := &piFakeProcess{mode: mode}
	for i := 0; i+1 < len(args); i++ {
		switch args[i] {
		case "--session-dir":
			f.sessionDir = args[i+1]
		case "--session-id":
			f.sessionID = args[i+1]
		}
	}
	if f.sessionDir == "" || f.sessionID == "" {
		return 21
	}
	if path := os.Getenv(piFakeArgvEnv); path != "" {
		_ = os.WriteFile(path, []byte(strings.Join(args, "\n")), 0o600)
	}
	reader := bufio.NewReader(os.Stdin)
	for {
		line, err := reader.ReadBytes('\n')
		if err == io.EOF {
			return 0
		}
		if err != nil {
			return 23
		}
		var command struct {
			ID      string `json:"id"`
			Type    string `json:"type"`
			Message string `json:"message"`
		}
		if json.Unmarshal(line, &command) != nil {
			return 22
		}
		if path := os.Getenv(piFakeLogEnv); path != "" {
			if log, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600); err == nil {
				_, _ = log.WriteString(command.Type + "\n")
				_ = log.Close()
			}
		}
		if code := f.handle(command.ID, command.Type, command.Message); code >= 0 {
			return code
		}
	}
}

// handle returns an exit code, or -1 to keep reading.
func (f *piFakeProcess) handle(id, kind, message string) int {
	switch kind {
	case "get_state":
		f.reply(id, kind, map[string]any{"sessionId": f.sessionID})
		switch f.mode {
		case "pressure":
			noise := map[string]any{"type": "noise", "pad": strings.Repeat("x", 38)}
			for range 8000 {
				f.send(noise)
			}
		case "blocked":
			time.Sleep(time.Minute)
			return 0
		}
	case "prompt":
		if path := os.Getenv(piFakeRecordEnv); path != "" {
			_ = os.WriteFile(path, []byte(message), 0o600)
		}
		if f.mode == "handled" {
			f.reply(id, kind, map[string]any{"disposition": "handled"})
			return -1
		}
		f.reply(id, kind, map[string]any{"disposition": "started"})
		if f.mode == "exit-early" {
			return 0
		}
		f.send(map[string]any{"type": "agent_start"})
		return f.act()
	case "steer":
		if f.mode == "steer-race" {
			f.send(map[string]any{"type": "agent_end"})
		}
		f.reply(id, kind, map[string]any{"disposition": "queued"})
		if f.mode == "steer" {
			// Pi shows a steered message as a user message before the next reply.
			user := map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": message}}}
			f.send(map[string]any{"type": "message_start", "message": user})
			f.send(map[string]any{"type": "message_end", "message": user})
		}
		f.finish()
	case "clear_queue":
		f.cleared = true
		f.reply(id, kind, nil)
	case "abort":
		if !f.cleared {
			return 24
		}
		f.send(map[string]any{"type": "agent_settled", "aborted": true})
		f.reply(id, kind, nil)
	default:
		return 25
	}
	return -1
}

func (f *piFakeProcess) act() int {
	switch f.mode {
	case "steer", "steer-race", "steer-unconsumed":
	case "retry":
		f.assistantEnd("", "error", "retryable")
		f.send(map[string]any{"type": "agent_end"})
		f.send(map[string]any{"type": "auto_retry_start"})
		f.send(map[string]any{"type": "agent_start"})
		f.send(map[string]any{"type": "auto_retry_end", "success": true})
		f.finish()
	case "cancel":
		program, _ := os.Executable()
		child := exec.Command(program)
		child.Env = []string{piFakeEnv + "=sleep"}
		if err := child.Start(); err != nil {
			return 26
		}
		_ = os.WriteFile(os.Getenv(piFakeChildEnv), []byte(fmt.Sprintf("%d\n", child.Process.Pid)), 0o600)
	case "tool-failure":
		f.tool("call_bash", "bash", true)
		f.finish()
	case "requests":
		f.send(map[string]any{"type": "message_start", "message": map[string]any{"role": "assistant"}})
		f.send(map[string]any{"type": "message_update", "assistantMessageEvent": map[string]any{"type": "thinking_delta", "delta": "plan"}})
		f.send(map[string]any{"type": "message_end", "message": map[string]any{
			"role": "assistant", "model": "fixture/model", "stopReason": "toolUse",
			"content": []any{map[string]any{"type": "toolCall", "id": "call_ls", "name": "bash"}},
			"usage":   map[string]any{"input": 4, "output": 1, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 5},
		}})
		f.tool("call_ls", "bash", false)
		f.finish()
	case "composite":
		f.tool("call_shared|fc_first", "read", false)
		f.tool("call_shared|fc_second", "read", false)
		f.finish()
	default:
		f.finish()
	}
	return -1
}

// piFakeCatalog answers each catalog request with an unrelated rejected
// reply first, then the real one.
func piFakeCatalog() int {
	reader := bufio.NewScanner(os.Stdin)
	for reader.Scan() {
		var request struct{ ID, Type string }
		if json.Unmarshal(reader.Bytes(), &request) != nil {
			return 22
		}
		fmt.Printf(`{"type":"response","id":"unrelated-%s","command":%q,"success":false,"error":"no"}`+"\n", request.ID, request.Type)
		fmt.Println(`{"type":"noise"}`)
		switch request.ID {
		case "linger-state":
			fmt.Println(`{"type":"response","id":"linger-state","command":"get_state","success":true,"data":{"model":{"provider":"fixture","id":"reasoner"},"thinkingLevel":"high"}}`)
		case "linger-models":
			fmt.Println(`{"type":"response","id":"linger-models","command":"get_available_models","success":true,"data":{"models":[` +
				`{"provider":"fixture","id":"reasoner","reasoning":true,"thinkingLevelMap":{"minimal":null,"max":"maximum"}},` +
				`{"provider":" fixture ","id":"fast","reasoning":false},` +
				`{"provider":"fixture","id":"reasoner","reasoning":false},` +
				`{"provider":"","id":"orphan","reasoning":true}]}}`)
		default:
			return 25
		}
	}
	return 0
}
