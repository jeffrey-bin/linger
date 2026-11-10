package native

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sync"
	"time"
)

// The resident fake Pi serves many prompts on one process. The prompt
// message picks the turn's behavior. It logs "<pid> spawn",
// "<pid> prompt:<msg>" and "<pid> steer:<msg>" to piResidentLogEnv.
const (
	piResidentLogEnv      = "PI_RESIDENT_LOG"
	piResidentExitHangEnv = "PI_RESIDENT_EXIT_HANG"
)

type piResidentFakeState struct {
	*piFakeProcess
	mu        sync.Mutex
	pending   int
	streaming bool
}

func (f *piResidentFakeState) log(line string) {
	path := os.Getenv(piResidentLogEnv)
	if path == "" {
		return
	}
	if file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600); err == nil {
		_, _ = fmt.Fprintf(file, "%d %s\n", os.Getpid(), line)
		_ = file.Close()
	}
}

func piResidentFake(args []string) int {
	f := &piResidentFakeState{piFakeProcess: &piFakeProcess{}}
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
		_ = os.WriteFile(path, []byte(joinLines(args)), 0o600)
	}
	f.log("spawn")
	reader := bufio.NewReader(os.Stdin)
	for {
		line, err := reader.ReadBytes('\n')
		if err == io.EOF {
			if os.Getenv(piResidentExitHangEnv) != "" {
				time.Sleep(time.Hour)
			}
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
		if code := f.handle(command.ID, command.Type, command.Message); code >= 0 {
			return code
		}
	}
}

func joinLines(args []string) string {
	out := ""
	for i, arg := range args {
		if i > 0 {
			out += "\n"
		}
		out += arg
	}
	return out
}

func (f *piResidentFakeState) handle(id, kind, message string) int {
	switch kind {
	case "get_state":
		f.mu.Lock()
		state := map[string]any{"sessionId": f.sessionID, "isStreaming": f.streaming, "isCompacting": false, "pendingMessageCount": f.pending}
		f.mu.Unlock()
		f.reply(id, kind, state)
	case "prompt":
		f.log("prompt:" + message)
		f.cleared = false
		f.reply(id, kind, map[string]any{"disposition": "started"})
		f.send(map[string]any{"type": "agent_start"})
		f.act(message)
	case "steer":
		f.log("steer:" + message)
		f.reply(id, kind, map[string]any{"disposition": "queued"})
		user := map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": message}}}
		f.send(map[string]any{"type": "message_start", "message": user})
		f.send(map[string]any{"type": "message_end", "message": user})
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

func (f *piResidentFakeState) act(message string) {
	switch message {
	case "hold":
	case "settle_later":
		go func() {
			time.Sleep(500 * time.Millisecond)
			f.finish()
		}()
	case "fail":
		f.assistantEnd("", "error", "fixture failure")
		f.send(map[string]any{"type": "agent_end"})
		f.send(map[string]any{"type": "agent_settled", "aborted": false})
	case "no_assistant":
		f.send(map[string]any{"type": "agent_end"})
		f.send(map[string]any{"type": "agent_settled", "aborted": false})
	case "aborted":
		f.send(map[string]any{"type": "agent_settled", "aborted": true})
	case "pending":
		f.mu.Lock()
		f.pending = 1
		f.mu.Unlock()
		f.finish()
	case "streaming":
		f.mu.Lock()
		f.streaming = true
		f.mu.Unlock()
		f.finish()
	case "tools":
		for _, name := range []string{"read", "edit", "write", "grep", "bash", "mcp__browser__navigate", "mcp__computer__run_actions", "notebook"} {
			f.tool("call_"+name, name, false)
		}
		f.finish()
	default:
		f.finish()
	}
}
