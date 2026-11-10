package native

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"
)

// piEventFrame is the union of the fields the adapter reads from a
// non-response stdout frame. Loosely typed fields stay raw so one odd
// field never hides the rest of the frame.
type piEventFrame struct {
	Type                  string          `json:"type"`
	Message               json.RawMessage `json:"message"`
	AssistantMessageEvent *struct {
		Type  string `json:"type"`
		Delta string `json:"delta"`
	} `json:"assistantMessageEvent"`
	ToolName   string          `json:"toolName"`
	ToolCallID string          `json:"toolCallId"`
	Args       json.RawMessage `json:"args"`
	Result     json.RawMessage `json:"result"`
	IsError    bool            `json:"isError"`
	Success    bool            `json:"success"`
	FinalError json.RawMessage `json:"finalError"`
	Aborted    bool            `json:"aborted"`
}

type piWireMessage struct {
	Role         string `json:"role"`
	Model        string `json:"model"`
	StopReason   string `json:"stopReason"`
	ErrorMessage string `json:"errorMessage"`
	Usage        *struct {
		Input      float64 `json:"input"`
		Output     float64 `json:"output"`
		CacheRead  float64 `json:"cacheRead"`
		CacheWrite float64 `json:"cacheWrite"`
	} `json:"usage"`
	Content json.RawMessage `json:"content"`
}

func (t *piTurn) apply(event piEventFrame, observed time.Time) {
	switch event.Type {
	case "agent_start":
		t.mu.Lock()
		t.active = true
		first := !t.running
		t.running = true
		t.mu.Unlock()
		if first {
			now := time.Now()
			t.requests.begin("", now)
			reused := t.reused
			t.timing("pi.agent_start", "process_reused", reused)
			t.emit(Event{Kind: EventStatus, Status: "running", TurnID: t.id, SessionID: t.proc.sessionID, ProcessReused: &reused, SentAt: now})
		}
	case "agent_end":
		t.mu.Lock()
		t.active = false
		t.mu.Unlock()
	case "agent_settled":
		t.mu.Lock()
		t.active = false
		t.settleAborted = event.Aborted
		t.mu.Unlock()
		t.settledOnce.Do(func() { close(t.settled) })
	case "message_start":
		// A steered user message is an input of the next request.
		if message := piMessageOf(event); message.Role == "user" {
			t.requests.ready("", observed)
			t.consumeSteer(piUserText(message.Content))
		}
		if piMessageOf(event).Role == "assistant" {
			t.mu.Lock()
			t.textID = "pi-text-" + piRandomHex(12)
			t.filter = piMarkupFilter{}
			t.mu.Unlock()
		}
	case "message_update":
		t.requests.item("", observed)
		t.applyDelta(event, observed)
	case "message_end":
		t.applyMessageEnd(piMessageOf(event), observed)
	case "tool_execution_start":
		var input map[string]any
		if json.Unmarshal(event.Args, &input) != nil {
			input = nil
		}
		t.emit(Event{Kind: EventToolCall, ObservedAt: observed, ToolName: event.ToolName, InvocationID: piInvocationID(event.ToolCallID), Input: input, ActivityKind: activityForNamedTool(event.ToolName, piToolActivities)})
	case "tool_execution_end":
		t.requests.ready("", observed)
		status := "completed"
		if event.IsError {
			status = "failed"
		}
		t.emit(Event{Kind: EventToolOutput, ObservedAt: observed, Status: status, ToolName: event.ToolName, InvocationID: piInvocationID(event.ToolCallID), Output: piText(event.Result)})
	case "auto_retry_end":
		if !event.Success {
			t.noteFailure(piText(event.FinalError))
		}
	case "auto_compaction_end":
		result := strings.TrimSpace(string(event.Result))
		if !event.Aborted && result != "" && result != "null" {
			t.mu.Lock()
			t.compactions++
			t.mu.Unlock()
		}
	case "error":
		t.noteFailure(piText(event.Message))
	}
}

func (t *piTurn) noteFailure(message string) {
	if message == "" {
		message = "Pi reported an error"
	}
	t.mu.Lock()
	t.failure = message
	t.mu.Unlock()
}

func (t *piTurn) applyDelta(event piEventFrame, observed time.Time) {
	update := event.AssistantMessageEvent
	if update == nil {
		return
	}
	switch update.Type {
	case "text_delta":
		t.mu.Lock()
		if t.textID == "" {
			t.textID = "pi-text-" + piRandomHex(12)
		}
		visible, id := t.filter.push(update.Delta), t.textID
		t.mu.Unlock()
		if visible != "" {
			t.emit(Event{Kind: EventText, ObservedAt: observed, ID: id, Body: visible})
		}
	case "thinking_delta":
		t.emit(Event{Kind: EventReasoning, ObservedAt: observed, Body: update.Delta})
	}
}

func (t *piTurn) applyMessageEnd(message piWireMessage, observed time.Time) {
	if message.Role != "assistant" {
		return
	}
	t.mu.Lock()
	rest, id := t.filter.flush(), t.textID
	if id == "" && rest != "" {
		id = "pi-text-" + piRandomHex(12)
	}
	t.textID = ""
	t.sawAssistant = true
	t.output = piFilterMarkup(piMessageText(message.Content))
	t.failure = ""
	if message.StopReason == "error" || message.StopReason == "aborted" {
		t.failure = message.ErrorMessage
		if t.failure == "" {
			t.failure = "Pi assistant message stopped: " + message.StopReason
		}
	}
	response := ModelResponse{Model: message.Model}
	if usage := message.Usage; usage != nil {
		count := TokenCount{Input: int64(usage.Input), Output: int64(usage.Output), CacheRead: int64(usage.CacheRead), CacheWrite: int64(usage.CacheWrite)}
		response.Usage = count
		t.lastUsage = map[string]TokenCount{message.Model: count}
		total := t.usage[message.Model]
		total.Input += count.Input
		total.Output += count.Output
		total.CacheRead += count.CacheRead
		total.CacheWrite += count.CacheWrite
		t.usage[message.Model] = total
	}
	t.mu.Unlock()
	if rest != "" {
		t.emit(Event{Kind: EventText, ObservedAt: observed, ID: id, Body: rest})
	}
	response = t.requests.respond(response, observed)
	t.emit(Event{Kind: EventModelResponse, ObservedAt: observed, Response: &response})
}

func piMessageOf(event piEventFrame) piWireMessage {
	var message piWireMessage
	_ = json.Unmarshal(event.Message, &message)
	return message
}

func piMessageText(content json.RawMessage) string {
	var parts []json.RawMessage
	if json.Unmarshal(content, &parts) != nil {
		return ""
	}
	var text strings.Builder
	for _, raw := range parts {
		var part struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal(raw, &part) == nil && part.Type == "text" {
			text.WriteString(part.Text)
		}
	}
	return text.String()
}

// piToolActivities classifies Pi's built-in tools; MCP tools follow their
// server and anything else is a generic tool.
var piToolActivities = map[string]string{
	"read":  ActivityRead,
	"edit":  ActivityFileChange,
	"write": ActivityFileChange,
	"grep":  ActivitySearch,
	"find":  ActivitySearch,
	"ls":    ActivitySearch,
	"bash":  ActivityCommand,
}

// piInvocationID hashes the whole native call id, so composite ids that
// share a prefix stay distinct and the result fits the Gateway format.
func piInvocationID(native string) string {
	sum := sha256.Sum256([]byte(native))
	return "pi-call-" + hex.EncodeToString(sum[:])
}

// piUserText is a user message's text, given as a string or as text parts.
func piUserText(content json.RawMessage) string {
	var text string
	if json.Unmarshal(content, &text) == nil {
		return text
	}
	return piMessageText(content)
}
