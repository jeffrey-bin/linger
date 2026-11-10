package native

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/redact"
)

const codexPatchBodyLimit = 64 << 10

type codexItem struct {
	ID               string          `json:"id"`
	Type             string          `json:"type"`
	Text             string          `json:"text"`
	Phase            *string         `json:"phase"`
	Command          json.RawMessage `json:"command"`
	AggregatedOutput *string         `json:"aggregatedOutput"`
	Status           string          `json:"status"`
	ExitCode         *float64        `json:"exitCode"`
	Changes          []struct {
		Path string `json:"path"`
		Kind struct {
			Type     string  `json:"type"`
			MovePath *string `json:"move_path"`
		} `json:"kind"`
		Diff json.RawMessage `json:"diff"`
	} `json:"changes"`
	Server      string          `json:"server"`
	Tool        string          `json:"tool"`
	Arguments   json.RawMessage `json:"arguments"`
	DurationMs  *float64        `json:"durationMs"`
	DurationMs2 *float64        `json:"duration_ms"`
	Error       *struct {
		Message *string `json:"message"`
	} `json:"error"`
	Summary        []string        `json:"summary"`
	CommandActions json.RawMessage `json:"commandActions"`
	Query          json.RawMessage `json:"query"`
	Action         json.RawMessage `json:"action"`
	// ClientID is the client id of a userMessage, echoing a steer's.
	ClientID *string `json:"clientId"`
	// ReceiverThreadIDs and Model describe a collabAgentToolCall.
	ReceiverThreadIDs []string `json:"receiverThreadIds"`
	Model             string   `json:"model"`
}

// codexChild is a sub-agent thread and the collab call that spawned it.
type codexChild struct {
	parentCallID, model string
}

type codexNotification struct {
	ThreadID    string   `json:"threadId"`
	TurnID      string   `json:"turnId"`
	EmittedAtMs *float64 `json:"emittedAtMs"`
	Turn        struct {
		ID     string `json:"id"`
		Status string `json:"status"`
		Error  *struct {
			Message        string          `json:"message"`
			CodexErrorInfo json.RawMessage `json:"codexErrorInfo"`
		} `json:"error"`
		Usage json.RawMessage `json:"usage"`
	} `json:"turn"`
	Item         codexItem `json:"item"`
	ItemID       string    `json:"itemId"`
	SummaryIndex int       `json:"summaryIndex"`
	Delta        string    `json:"delta"`
	WillRetry    bool      `json:"willRetry"`
	Message      string    `json:"message"`
	Error        *struct {
		Message        string          `json:"message"`
		CodexErrorInfo json.RawMessage `json:"codexErrorInfo"`
	} `json:"error"`
	Plan []struct {
		Step   string `json:"step"`
		Status string `json:"status"`
	} `json:"plan"`
	Explanation *string         `json:"explanation"`
	TokenUsage  json.RawMessage `json:"tokenUsage"`
}

func (p *codexProcess) currentOp() *codexOperation {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.op
}

func (p *codexProcess) boundThread() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.threadID
}

// dispatchNotice filters a notification through the thread filter and
// the Operation's gate, then feeds the cleanup tracker and projection.
func (p *codexProcess) dispatchNotice(method string, params json.RawMessage) {
	op := p.currentOp()
	if op == nil {
		return
	}
	op.observed.Add(1)
	trimmed := bytes.TrimSpace(params)
	if len(trimmed) == 0 || trimmed[0] != '{' || strings.HasPrefix(method, "codex/event") {
		return
	}
	var n codexNotification
	if json.Unmarshal(trimmed, &n) != nil {
		return
	}
	if bound := p.boundThread(); n.ThreadID != "" && bound != "" && n.ThreadID != bound {
		op.childNotice(method, &n)
		return
	}
	turnID := n.TurnID
	if method == "turn/started" || method == "turn/completed" {
		turnID = n.Turn.ID
	}
	if !op.admit(method, turnID, n.TurnID) {
		// A usage report outside the turn still moves the thread's total, so a
		// repeat of it inside the turn is not taken for a new request.
		if method == "thread/tokenUsage/updated" {
			if sum, ok := codexUsageTotal(n.TokenUsage); ok {
				p.advanceTotal(n.ThreadID, sum)
			}
		}
		return
	}
	p.trackNotification(method, n.ThreadID, turnID, n.Item)
	op.project(method, &n)
}

// admit applies the notification gate.
func (op *codexOperation) admit(method, turnID, errorTurnID string) bool {
	op.mu.Lock()
	defer op.mu.Unlock()
	if !op.gateArmed || op.gateClosed {
		return false
	}
	switch method {
	case "turn/started":
		if op.gateTurn != "" || turnID == "" {
			return false
		}
		op.gateTurn = turnID
		return true
	case "error":
		return errorTurnID == "" || op.gateTurn == "" || errorTurnID == op.gateTurn
	}
	if op.gateTurn == "" {
		return false
	}
	if method == "turn/completed" {
		if turnID != op.gateTurn {
			return false
		}
		op.gateClosed = true
		return true
	}
	return turnID == "" || turnID == op.gateTurn
}

// childNotice keeps only the model requests of a sub-agent thread this turn
// spawned; its items belong to the sub-agent, not to the Run.
func (op *codexOperation) childNotice(method string, n *codexNotification) {
	op.mu.Lock()
	child, known := op.children[n.ThreadID]
	live := op.gateArmed && !op.gateClosed
	op.mu.Unlock()
	if !known || !live {
		return
	}
	switch {
	case method == "thread/tokenUsage/updated":
		op.observeTokenUsage(n.ThreadID, child, n.TokenUsage)
	case codexModelOutput(method, n.Item.Type):
		op.requests.item(n.ThreadID, time.Now())
	case method == "item/started" && codexToolItem(n.Item.Type):
		op.requests.call(n.ThreadID)
	case method == "item/completed" && codexToolItem(n.Item.Type):
		op.requests.ready(n.ThreadID, time.Now())
	}
}

// codexModelOutput reports a notification that shows model output. A tool
// item starts when its execution starts, which can follow the response (for
// example after an approval), so only reasoning, messages and plans count.
func codexModelOutput(method, itemType string) bool {
	switch method {
	case "item/reasoning/summaryTextDelta", "item/reasoning/textDelta", "item/agentMessage/delta":
		return true
	case "item/started", "item/completed":
		return itemType == "agentMessage" || itemType == "reasoning" || itemType == "plan"
	}
	return false
}

// codexToolItem reports an item whose completion is a tool result the next
// model request waits for.
func codexToolItem(itemType string) bool {
	switch itemType {
	case "agentMessage", "reasoning", "userMessage", "hookPrompt", "plan", "contextCompaction":
		return false
	}
	return true
}

// spawned records the sub-agent threads a spawn call created so their model
// requests are attributed to it. Other collab calls name existing agents.
func (op *codexOperation) spawned(item *codexItem) {
	if item.Tool != "spawnAgent" {
		return
	}
	now := time.Now()
	for _, thread := range item.ReceiverThreadIDs {
		op.mu.Lock()
		_, known := op.children[thread]
		if !known && thread != "" {
			op.children[thread] = codexChild{parentCallID: item.ID, model: item.Model}
		}
		op.mu.Unlock()
		if !known && thread != "" {
			op.requests.begin(thread, now)
		}
	}
}

func (op *codexOperation) project(method string, n *codexNotification) {
	if codexModelOutput(method, n.Item.Type) {
		op.requests.item("", time.Now())
	}
	switch method {
	case "turn/started":
		op.turnStarted(n)
	case "turn/completed":
		op.turnFinished(n)
	case "thread/tokenUsage/updated":
		op.observeTokenUsage(n.ThreadID, codexChild{}, n.TokenUsage)
	case "error":
		op.errorNotification(n)
	case "turn/plan/updated":
		steps := make([]any, 0, len(n.Plan))
		for _, step := range n.Plan {
			steps = append(steps, map[string]any{"content": step.Step, "status": codexStatus(step.Status)})
		}
		input := map[string]any{"steps": steps}
		if n.Explanation != nil {
			input["explanation"] = *n.Explanation
		}
		op.emit(Event{Kind: EventPlan, Input: input})
	case "item/reasoning/summaryTextDelta":
		op.activityNote(method + ":reasoning:" + n.ItemID)
		if title, ok := op.titles.feed(n.ItemID, n.SummaryIndex, n.Delta); ok && title != "" {
			op.emit(Event{Kind: EventReasoning, ID: n.ItemID, Title: title})
		}
	case "item/reasoning/textDelta":
		op.activityNote(method + ":reasoning:" + n.ItemID)
		op.emit(Event{Kind: EventReasoning, ID: n.ItemID})
	case "item/started", "item/completed":
		op.item(method, &n.Item)
	}
}

func (op *codexOperation) turnStarted(n *codexNotification) {
	now := time.Now()
	op.mu.Lock()
	op.turnID = n.Turn.ID
	op.itemsDone = map[string]bool{}
	op.steerable = true
	op.mu.Unlock()
	thread := op.proc.boundThread()
	if n.EmittedAtMs != nil && *n.EmittedAtMs >= 0 {
		op.logger.Info("codex turn/started emitted", "thread_id", thread, "turn_id", n.Turn.ID, "emitted_at_unix_ms", int64(*n.EmittedAtMs))
	}
	recordTiming(op.logger, now, "codex turn/started received", "thread_id", thread, "turn_id", n.Turn.ID)
	op.requests.begin("", now)
	reused := op.reused
	op.emit(Event{Kind: EventStatus, Status: "running", SessionID: thread, TurnID: n.Turn.ID, ProcessReused: &reused, SentAt: now})
}

func (op *codexOperation) turnFinished(n *codexNotification) {
	op.mu.Lock()
	if op.terminalSeen {
		op.mu.Unlock()
		return
	}
	op.terminalSeen = true
	op.steerable = false
	status := n.Turn.Status
	if status == "failed" {
		message := "Codex turn failed"
		var diagnostics RuntimeFailureDiagnostics
		if n.Turn.Error != nil {
			if n.Turn.Error.Message != "" {
				message = n.Turn.Error.Message
			}
			diagnostics = codexErrorDiagnostics(n.Turn.Error.CodexErrorInfo)
		}
		op.setTurnErrorLocked(message, "", diagnostics)
	}
	if usage, ok := codexLiveUsage(n.Turn.Usage); ok {
		op.liveUsage, op.lastUsage = &usage, &usage
	}
	switch status {
	case "cancelled", "canceled", "aborted", "interrupted":
		op.terminalAborted = true
	}
	op.mu.Unlock()
	recordTiming(op.logger, time.Now(), timingCodexTurnCompleted, "thread_id", op.proc.boundThread(), "turn_id", n.Turn.ID, "status", status)
	op.activityNote("turn/completed")
	close(op.terminal)
}

func (op *codexOperation) errorNotification(n *codexNotification) {
	message := n.Message
	var info json.RawMessage
	if n.Error != nil {
		if n.Error.Message != "" {
			message = n.Error.Message
		}
		info = n.Error.CodexErrorInfo
	}
	op.logger.Warn("codex error notification", "message", sanitizeDiagnostic(message), "will_retry", n.WillRetry)
	if n.WillRetry {
		op.activityNote("error:retry")
		return
	}
	if message == "" {
		message = "Codex reported a terminal protocol error"
	}
	op.recordTurnFailure(message, "", codexErrorDiagnostics(info))
	op.activityNote("error:terminal")
}

func (op *codexOperation) item(method string, item *codexItem) {
	itemType := item.Type
	if itemType == "" {
		itemType = "unknown"
	}
	note := method + ":" + itemType
	if item.ID != "" {
		note += ":" + item.ID
	}
	op.activityNote(note)
	started := method == "item/started"
	if item.Type == "collabAgentToolCall" {
		op.spawned(item)
	}
	if codexToolItem(item.Type) {
		if started {
			op.requests.call("")
		} else {
			op.requests.ready("", time.Now())
		}
	}
	if !started {
		op.mu.Lock()
		if item.ID != "" && op.itemsDone[item.ID] {
			op.mu.Unlock()
			return
		}
		if item.ID != "" {
			op.itemsDone[item.ID] = true
		}
		op.mu.Unlock()
	}
	switch item.Type {
	case "userMessage":
		if item.ClientID != nil {
			op.consumeSteer(*item.ClientID)
		}
	case "contextCompaction":
		if !started {
			op.mu.Lock()
			op.compactions++
			op.mu.Unlock()
		}
	case "reasoning":
		if !started {
			if title := op.titles.complete(item.ID, item.Summary); title != "" {
				op.emit(Event{Kind: EventReasoning, ID: item.ID, Title: title})
			}
		}
	case "agentMessage":
		if started || item.Text == "" {
			return
		}
		op.emit(Event{Kind: EventText, ID: item.ID, Body: item.Text})
		if item.Phase == nil || *item.Phase == "final_answer" {
			op.mu.Lock()
			op.answer = item.Text
			op.mu.Unlock()
		}
	case "commandExecution":
		if started {
			var command any
			_ = json.Unmarshal(item.Command, &command)
			input := map[string]any{"command": command}
			kind := codexCommandActivity(item.CommandActions, input)
			op.emit(Event{Kind: EventToolCall, ToolName: "exec_command", InvocationID: item.ID, Input: input, ActivityKind: kind})
			return
		}
		status := codexStatus(item.Status)
		if item.ExitCode != nil && *item.ExitCode != 0 {
			status = "failed"
		}
		output := ""
		if item.AggregatedOutput != nil {
			output = *item.AggregatedOutput
		}
		op.emit(Event{Kind: EventToolOutput, ToolName: "exec_command", InvocationID: item.ID, Output: output, Status: status})
	case "fileChange":
		if started {
			op.emit(Event{Kind: EventToolCall, ToolName: "patch_apply", InvocationID: item.ID, Input: codexFileChangeArgs(item), ActivityKind: ActivityFileChange})
			return
		}
		status := codexStatus(item.Status)
		op.emit(Event{Kind: EventToolOutput, ToolName: "patch_apply", InvocationID: item.ID, Status: status,
			Output: fmt.Sprintf("%s: %d file changes", status, len(item.Changes)), ActivityKind: ActivityFileChange})
	case "webSearch":
		input, kind := codexWebSearchInput(item)
		if started {
			op.emit(Event{Kind: EventToolCall, ToolName: "web_search", InvocationID: item.ID, Input: input, ActivityKind: kind})
			return
		}
		op.emit(Event{Kind: EventToolOutput, ToolName: "web_search", InvocationID: item.ID, Output: codexJSONString(item.Query),
			Status: codexStatus(item.Status), ActivityKind: kind})
	case "mcpToolCall", "dynamicToolCall":
		name := item.Tool
		if name == "" {
			name = "mcp_tool"
		}
		kind := activityForMCPServer(item.Server)
		if started {
			var arguments any
			_ = json.Unmarshal(item.Arguments, &arguments)
			op.emit(Event{Kind: EventToolCall, ToolName: name, InvocationID: item.ID,
				Input: redact.InputMap(map[string]any{"server": item.Server, "arguments": arguments}), ActivityKind: kind})
			return
		}
		status := codexStatus(item.Status)
		if status == "" {
			status = "completed"
		}
		output := status
		duration := item.DurationMs
		if duration == nil {
			duration = item.DurationMs2
		}
		if duration != nil && *duration > 0 {
			output += fmt.Sprintf("\nduration: %d ms", int64(*duration))
		}
		if item.Error != nil && item.Error.Message != nil {
			output += "\nerror: " + sanitizeDiagnostic(*item.Error.Message)
		}
		op.emit(Event{Kind: EventToolOutput, ToolName: name, InvocationID: item.ID, Output: output, Status: status, ActivityKind: kind})
	}
}

func codexStatus(status string) string {
	if status == "inProgress" {
		return "in_progress"
	}
	return status
}

// codexFileChangeArgs builds the redacted, size-capped patch preview.
func codexFileChangeArgs(item *codexItem) map[string]any {
	var changes []any
	originalBytes := 0
	for _, change := range item.Changes {
		if change.Path == "" {
			continue
		}
		entry := map[string]any{"path": change.Path, "kind": change.Kind.Type}
		if change.Kind.MovePath != nil {
			entry["move_path"] = *change.Kind.MovePath
		}
		var diff string
		if json.Unmarshal(change.Diff, &diff) == nil {
			originalBytes += len(diff)
			switch change.Kind.Type {
			case "add", "delete":
				entry["content"] = diff
			default:
				if change.Kind.MovePath != nil {
					diff = strings.TrimSuffix(diff, "\n\nMoved to: "+*change.Kind.MovePath)
				}
				entry["diff"] = diff
			}
		}
		changes = append(changes, entry)
	}
	if len(changes) == 0 {
		return nil
	}
	input := redact.InputMap(map[string]any{"changes": changes})
	remaining := codexPatchBodyLimit
	truncated := false
	redacted, _ := input["changes"].([]any)
	for _, raw := range redacted {
		entry, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		for _, key := range []string{"content", "diff"} {
			body, ok := entry[key].(string)
			if !ok {
				continue
			}
			if len(body) <= remaining {
				remaining -= len(body)
				continue
			}
			cut := remaining
			for cut > 0 && !utf8.RuneStart(body[cut]) {
				cut--
			}
			entry[key] = body[:cut]
			entry["truncated"] = true
			remaining = 0
			truncated = true
		}
	}
	if truncated {
		input["truncated"] = true
		input["original_bytes"] = originalBytes
	}
	return input
}

// answerServerCall answers app-server requests. The reader goroutine
// never blocks here: replies go through the bounded queue.
func (p *codexProcess) answerServerCall(id json.RawMessage, method string, params json.RawMessage) {
	op := p.currentOp()
	reviewed := op != nil && op.reviewed
	switch method {
	case "item/commandExecution/requestApproval", "execCommandApproval", "item/fileChange/requestApproval", "applyPatchApproval":
		decision := "accept"
		if reviewed {
			decision = "decline"
		}
		p.transport.reply(id, map[string]any{"decision": decision}, nil)
		return
	case "item/permissions/requestApproval":
		granted := map[string]any{}
		if !reviewed {
			var request struct {
				Permissions map[string]json.RawMessage `json:"permissions"`
			}
			_ = json.Unmarshal(params, &request)
			for _, key := range []string{"network", "fileSystem"} {
				if value, ok := request.Permissions[key]; ok && !bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
					granted[key] = value
				}
			}
		}
		p.transport.reply(id, map[string]any{"permissions": granted, "scope": "turn"}, nil)
		return
	case "mcpServer/elicitation/request":
		action := "accept"
		if reviewed {
			action = "decline"
		}
		p.transport.reply(id, map[string]any{"action": action, "content": nil, "_meta": nil}, nil)
		return
	case "item/tool/requestUserInput":
		if op != nil && op.bridge != nil {
			op.question(id, params)
			return
		}
		// Without a bridge nobody can answer; the turn goes on and the
		// question travels in the final reply instead.
		p.transport.reply(id, nil, &codexRPCError{Code: -32601, Message: codexUnansweredQuestionMessage})
		return
	}
	text := "unsupported codex app-server request: " + method
	p.transport.reply(id, nil, &codexRPCError{Code: -32601, Message: text})
	if op != nil {
		op.recordTurnFailure(text, "protocol_incompatible", RuntimeFailureDiagnostics{})
	}
}

// question posts native questions through the human interaction bridge.
func (op *codexOperation) question(id json.RawMessage, params json.RawMessage) {
	var request struct {
		TurnID    string          `json:"turnId"`
		Questions []codexQuestion `json:"questions"`
	}
	_ = json.Unmarshal(params, &request)
	form, ok := codexQuestionRequest(request.Questions)
	if !ok {
		op.proc.transport.reply(id, nil, &codexRPCError{Code: codexSecretQuestionCode, Message: codexSecretQuestionMessage})
		return
	}
	respond := func(payload json.RawMessage) error {
		op.mu.Lock()
		live := op.steerable && (request.TurnID == "" || request.TurnID == op.turnID)
		op.mu.Unlock()
		if !live {
			return questionTurnEnded()
		}
		answers, err := codexQuestionAnswers(request.Questions, payload)
		if err != nil {
			return err
		}
		op.proc.transport.reply(id, answers, nil)
		return nil
	}
	if err := op.bridge.Request(codexQuestionRequestID(id), form, respond); err != nil {
		op.recordTurnFailure(err.Error(), "", RuntimeFailureDiagnostics{})
		op.proc.transport.reply(id, nil, &codexRPCError{Code: codexQuestionRefusedCode, Message: err.Error()})
	}
}
