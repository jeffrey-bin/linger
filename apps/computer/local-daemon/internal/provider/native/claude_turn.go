package native

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"sync"
	"time"
)

const claudeEventBuffer = 256

// claudeTurn is one Run on a process: its events, its Outcome, and what the
// reader learned from the frames of this turn.
type claudeTurn struct {
	proc      *claudeProcess
	spec      RunSpec
	prompt    string
	logger    *slog.Logger
	version   string
	callerCtx context.Context
	runCtx    context.Context
	runCancel context.CancelFunc
	events    chan Event
	outcome   chan Outcome
	reused    bool
	startedAt time.Time
	fence     releaseFence

	submitDone chan struct{}
	submitErr  error
	inputErr   error

	// endedFlag is guarded by proc.mu so that ending and unbinding are atomic
	// with respect to the turn watcher.
	endedFlag bool
	ended     chan struct{}

	reviewMu sync.Mutex
	reviews  map[string]context.CancelFunc

	// Reader-owned state.
	terminal            *claudeFrame
	terminalAfterCancel bool
	observedSession     string
	fallback            string
	defaultFailureFor   string
	usage               map[string]TokenCount
	lastUsage           map[string]TokenCount
	// pending holds each agent's model message whose frames are still
	// arriving; the main agent is "" and a sub-agent is its parent tool call.
	pending     map[string]*claudePendingResponse
	requests    *modelRequestClock
	compactions int64
	preTokens   *int64
	background  bool
	initSeen    bool
	// apiError is the last synthetic API-error code an assistant frame
	// carried in this turn.
	apiError string
	counts   claudeCounts

	// compaction is a /compact turn on a parked process. It carries no Run's
	// tool policy, and its result has no terminal_reason.
	compaction bool
}

type claudeCounts struct {
	frames, invalid, assistant, toolCalls, unreadable int
}

func claudeNewTurn(callerCtx, runCtx context.Context, proc *claudeProcess, runCancel context.CancelFunc, prompt string, spec RunSpec, profile Profile, reused bool) *claudeTurn {
	return &claudeTurn{
		proc: proc, spec: spec, prompt: prompt, logger: profile.Logger, version: profile.ToolVersion,
		callerCtx: callerCtx, runCtx: runCtx, runCancel: runCancel,
		events: make(chan Event, claudeEventBuffer), outcome: make(chan Outcome, 1),
		reused: reused, startedAt: time.Now(), submitDone: make(chan struct{}),
		ended: make(chan struct{}), reviews: map[string]context.CancelFunc{},
		usage: map[string]TokenCount{}, lastUsage: map[string]TokenCount{},
		pending: map[string]*claudePendingResponse{}, requests: newModelRequestClock(GranularityBlock),
	}
}

// claudePendingResponse is a model message streamed one frame per content
// block, each frame repeating the message's usage so far.
type claudePendingResponse struct {
	id, model string
	usage     *TokenCount
	observed  time.Time
}

// claudeSyntheticModel names assistant messages the CLI writes itself, such
// as API error notices; they are not model requests.
const claudeSyntheticModel = "<synthetic>"

// noteMessage records a frame of an agent's model message. A frame of a new
// message completes the previous one.
func (t *claudeTurn) noteMessage(agent string, message claudeMessage, observed time.Time) {
	if pending := t.pending[agent]; pending != nil && pending.id != message.ID {
		t.flushResponse(agent)
	}
	if message.Model == claudeSyntheticModel {
		return
	}
	if len(message.Content) > 0 {
		t.requests.item(agent, observed)
	}
	pending := t.pending[agent]
	if pending == nil {
		pending = &claudePendingResponse{id: message.ID}
		t.pending[agent] = pending
	}
	pending.observed = observed
	if message.Model != "" {
		pending.model = message.Model
	}
	if message.Usage != nil {
		count := message.Usage.count()
		pending.usage = &count
	}
}

// flushResponse reports an agent's completed model message once, at its last
// frame, and adds its usage to the turn.
func (t *claudeTurn) flushResponse(agent string) {
	pending := t.pending[agent]
	if pending == nil {
		return
	}
	delete(t.pending, agent)
	response := ModelResponse{Model: pending.model, MessageID: pending.id}
	if pending.usage != nil {
		response.Usage = *pending.usage
		if pending.model != "" {
			total := t.usage[pending.model]
			total.Input += response.Usage.Input
			total.Output += response.Usage.Output
			total.CacheRead += response.Usage.CacheRead
			total.CacheWrite += response.Usage.CacheWrite
			t.usage[pending.model] = total
			if agent == "" {
				t.lastUsage[pending.model] = response.Usage
			}
		}
	}
	if agent != "" {
		response.Agent, response.ParentCallID = agent, agent
	}
	response = t.requests.respond(response, pending.observed)
	t.emit(Event{Kind: EventModelResponse, ObservedAt: pending.observed, Response: &response})
}

// flushResponses completes every agent's message, the main agent's first.
func (t *claudeTurn) flushResponses() {
	t.flushResponse("")
	for agent := range t.pending {
		t.flushResponse(agent)
	}
}

func (t *claudeTurn) run() *Run {
	return &Run{Events: t.events, Outcome: t.outcome, Steer: t.steer}
}

// endLocked marks the turn ended; the caller holds proc.mu.
func (t *claudeTurn) endLocked() {
	if !t.endedFlag {
		t.endedFlag = true
		close(t.ended)
	}
}

// watch cancels the process when the run context ends before the turn.
func (t *claudeTurn) watch() {
	select {
	case <-t.runCtx.Done():
		t.proc.mu.Lock()
		ended := t.endedFlag
		t.proc.mu.Unlock()
		if !ended {
			t.proc.cancel()
		}
	case <-t.ended:
	}
}

// emit delivers with backpressure. Once the run context ends, an event that
// does not fit is dropped instead of blocking.
func (t *claudeTurn) emit(event Event) {
	select {
	case t.events <- event:
		return
	default:
	}
	select {
	case t.events <- event:
	case <-t.runCtx.Done():
	}
}

type claudeTokenTally struct {
	InputTokens              int64 `json:"input_tokens"`
	OutputTokens             int64 `json:"output_tokens"`
	CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
	CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
}

func (u claudeTokenTally) count() TokenCount {
	return TokenCount{Input: u.InputTokens, Output: u.OutputTokens, CacheRead: u.CacheReadInputTokens, CacheWrite: u.CacheCreationInputTokens}
}

type claudePerModelTokens struct {
	InputTokens              int64 `json:"inputTokens"`
	OutputTokens             int64 `json:"outputTokens"`
	CacheReadInputTokens     int64 `json:"cacheReadInputTokens"`
	CacheCreationInputTokens int64 `json:"cacheCreationInputTokens"`
}

type claudeFrame struct {
	Type               string                          `json:"type"`
	Subtype            string                          `json:"subtype"`
	SessionID          string                          `json:"session_id"`
	UUID               string                          `json:"uuid"`
	ParentToolUseID    string                          `json:"parent_tool_use_id"`
	UserMessageUUID    string                          `json:"user_message_uuid"`
	IsReplay           bool                            `json:"isReplay"`
	Timestamp          string                          `json:"timestamp"`
	Message            json.RawMessage                 `json:"message"`
	RequestID          string                          `json:"request_id"`
	Request            json.RawMessage                 `json:"request"`
	Response           json.RawMessage                 `json:"response"`
	Result             string                          `json:"result"`
	TerminalReason     string                          `json:"terminal_reason"`
	IsError            bool                            `json:"is_error"`
	Errors             []json.RawMessage               `json:"errors"`
	APIErrorStatus     float64                         `json:"api_error_status"`
	Model              string                          `json:"model"`
	Usage              *claudeTokenTally               `json:"usage"`
	ModelUsage         map[string]claudePerModelTokens `json:"modelUsage"`
	Log                *claudeLog                      `json:"log"`
	ToolUseID          string                          `json:"tool_use_id"`
	ElapsedTimeSeconds float64                         `json:"elapsed_time_seconds"`
	CompactMetadata    *claudeCompactMetadata          `json:"compact_metadata"`
	// Error stays raw because only assistant frames define it as a string;
	// another frame type giving it a different shape must still decode.
	Error json.RawMessage `json:"error"`
}

// claudeCompactMetadata describes a compact_boundary frame.
type claudeCompactMetadata struct {
	PreTokens *int64 `json:"pre_tokens"`
}

type claudeLog struct {
	Level   string `json:"level"`
	Message string `json:"message"`
}

type claudeMessage struct {
	ID      string            `json:"id"`
	Role    string            `json:"role"`
	Model   string            `json:"model"`
	Content []claudeBlock     `json:"content"`
	Usage   *claudeTokenTally `json:"usage"`
}

type claudeBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Input     json.RawMessage `json:"input"`
	ToolUseID string          `json:"tool_use_id"`
	Content   json.RawMessage `json:"content"`
	IsError   bool            `json:"is_error"`
}

func (t *claudeTurn) dispatchFrame(line []byte, observed time.Time) {
	if len(bytes.TrimSpace(line)) == 0 {
		return
	}
	t.counts.frames++
	var frame claudeFrame
	if json.Unmarshal(line, &frame) != nil {
		t.counts.invalid++
		return
	}
	switch frame.Type {
	case "assistant":
		var apiError string
		if json.Unmarshal(frame.Error, &apiError) == nil && apiError != "" {
			t.apiError = apiError
		}
		t.onAssistantFrame(frame, observed)
	case "user":
		t.onUserFrame(frame, observed)
	case "system":
		if !frame.IsReplay && frame.Subtype == "compact_boundary" {
			t.compactions++
			if frame.CompactMetadata != nil {
				t.preTokens = frame.CompactMetadata.PreTokens
			}
		}
		if frame.SessionID != "" {
			t.observedSession = frame.SessionID
		}
		if frame.Subtype == "init" {
			t.initSeen = true
			if start, ok := t.proc.conv.beginAtInit(); ok {
				t.reportTurnStarted(start, frame, observed)
			}
		}
		t.emit(Event{Kind: EventStatus, Status: "running", SessionID: t.observedSession})
	case "result":
		t.handleResult(frame, observed)
	case "control_cancel_request":
		t.cancelReview(frame.RequestID)
	case "control_response":
		t.proc.conv.handleResponse(frame.Response)
	case "control_request":
		t.authorize(frame)
	case "tool_progress":
		if frame.ParentToolUseID == "" {
			elapsed := time.Duration(frame.ElapsedTimeSeconds * float64(time.Second)).Round(time.Millisecond)
			t.emit(Event{Kind: EventToolProgress, InvocationID: frame.ToolUseID, Body: elapsed.String()})
		}
	case "log":
		if frame.Log != nil {
			t.emit(Event{Kind: EventLog, Level: frame.Log.Level, Body: frame.Log.Message})
		}
	}
}

func (t *claudeTurn) onAssistantFrame(frame claudeFrame, observed time.Time) {
	current := t.proc.conv.current()
	if frame.UserMessageUUID != "" && frame.UserMessageUUID != current {
		return
	}
	if frame.ParentToolUseID != "" {
		var message claudeMessage
		if json.Unmarshal(frame.Message, &message) == nil {
			t.noteMessage(frame.ParentToolUseID, message, observed)
		}
		return
	}
	t.counts.assistant++
	var message claudeMessage
	if json.Unmarshal(frame.Message, &message) != nil {
		t.counts.unreadable++
		t.fallback, t.defaultFailureFor = "", ""
		return
	}
	t.noteMessage("", message, observed)
	var text strings.Builder
	hasText, hasTool, understood := false, false, true
	for _, block := range message.Content {
		switch block.Type {
		case "text":
			if block.Text != "" {
				hasText = true
				text.WriteString(block.Text)
				t.emit(Event{Kind: EventText, ID: message.ID, ModelMessageID: message.ID, Body: block.Text, ObservedAt: observed})
			}
		case "thinking":
			if block.Text != "" {
				t.emit(Event{Kind: EventReasoning, ModelMessageID: message.ID, Body: block.Text, ObservedAt: observed})
			}
		case "tool_use":
			hasTool = true
			t.counts.toolCalls++
			// A sub-agent this call starts makes its first request from here.
			t.requests.begin(block.ID, observed)
			input, _ := claudeObject(block.Input)
			t.emit(Event{
				Kind: EventToolCall, ToolName: block.Name, InvocationID: block.ID, Input: input,
				ModelMessageID: message.ID, ObservedAt: observed, ActivityKind: activityForNamedTool(block.Name, claudeActivityKinds),
				ActivityTitle: claudeActivityTitle(block.Name, input),
			})
			if block.Name == claudeTodoTool {
				if steps, ok := claudeTodoSteps(input); ok {
					t.emit(Event{Kind: EventPlan, Input: map[string]any{"steps": steps}})
				}
			}
		default:
			understood = false
		}
	}
	if !understood {
		t.counts.unreadable++
	}
	switch {
	case hasTool || !understood:
		t.fallback, t.defaultFailureFor = "", ""
	case hasText:
		t.fallback, t.defaultFailureFor = text.String(), current
	}
}

func (t *claudeTurn) onUserFrame(frame claudeFrame, observed time.Time) {
	if frame.IsReplay {
		if frame.ParentToolUseID == "" {
			t.handleReplay(frame, observed)
		}
		return
	}
	// A tool result completes the message that called the tool.
	t.flushResponse(frame.ParentToolUseID)
	t.requests.ready(frame.ParentToolUseID, observed)
	if frame.ParentToolUseID != "" {
		return
	}
	var message struct {
		Content []claudeBlock `json:"content"`
	}
	if json.Unmarshal(frame.Message, &message) != nil {
		return
	}
	for _, block := range message.Content {
		if block.Type != "tool_result" {
			continue
		}
		t.flushResponse(block.ToolUseID)
		status := "completed"
		if block.IsError {
			status = "failed"
		}
		t.emit(Event{Kind: EventToolOutput, InvocationID: block.ToolUseID, Output: string(block.Content), Status: status, ObservedAt: observed})
		var content any
		if json.Unmarshal(block.Content, &content) == nil && claudeAsyncLaunched(content) {
			t.background = true
		}
	}
}

// claudeAsyncLaunched finds status "async_launched" through arrays and
// content keys.
func claudeAsyncLaunched(value any) bool {
	switch typed := value.(type) {
	case []any:
		for _, item := range typed {
			if claudeAsyncLaunched(item) {
				return true
			}
		}
	case map[string]any:
		if typed["status"] == "async_launched" {
			return true
		}
		return claudeAsyncLaunched(typed["content"])
	}
	return false
}

func (t *claudeTurn) handleReplay(frame claudeFrame, observed time.Time) {
	if start, ok := t.proc.conv.confirmReplay(frame.UUID); ok {
		t.reportTurnStarted(start, frame, observed)
	}
}

// reportTurnStarted emits the single turn-started status of a Run, from the
// system/init or the echo that started the turn.
func (t *claudeTurn) reportTurnStarted(start claudeTurnStart, frame claudeFrame, observed time.Time) {
	t.requests.begin("", observed)
	if !t.spec.ExposeTurnStarted {
		return
	}
	session := frame.SessionID
	if session == "" {
		session = t.observedSession
	}
	if session == "" {
		session = t.spec.ResumeID
	}
	sentAt := observed
	if stamp, err := time.Parse(time.RFC3339Nano, frame.Timestamp); err == nil {
		sentAt = stamp
	} else if !start.writtenAt.IsZero() {
		sentAt = start.writtenAt
	}
	reused := t.reused
	t.emit(Event{Kind: EventStatus, Status: "running", TurnID: start.turnID, SessionID: session, ProcessReused: &reused, SentAt: sentAt})
}

func (t *claudeTurn) handleResult(frame claudeFrame, observed time.Time) {
	if !t.proc.conv.acceptResult(frame.ParentToolUseID, frame.UserMessageUUID) {
		return
	}
	t.flushResponses()
	t.terminal = &frame
	t.terminalAfterCancel = t.callerCtx.Err() != nil
	if frame.SessionID != "" {
		t.observedSession = frame.SessionID
	}
	if totals := claudeResultTotals(frame, t.spec.Model); len(totals) > 0 {
		t.usage = totals
	}
	code := "succeeded"
	if frame.IsError {
		code = "failed"
	}
	recordTiming(t.logger, observed, timingClaudeTurnResult, "session_id", t.observedSession, "turn_id", t.proc.conv.current(), "code", code)
	if !t.park() {
		t.proc.closeStdin()
	}
}

func claudeResultTotals(frame claudeFrame, fallbackModel string) map[string]TokenCount {
	totals := map[string]TokenCount{}
	for model, usage := range frame.ModelUsage {
		count := TokenCount{Input: usage.InputTokens, Output: usage.OutputTokens, CacheRead: usage.CacheReadInputTokens, CacheWrite: usage.CacheCreationInputTokens}
		if model == "" || count == (TokenCount{}) {
			continue
		}
		totals[model] = count
	}
	if len(totals) > 0 || frame.Usage == nil {
		return totals
	}
	model := frame.Model
	if model == "" {
		model = fallbackModel
	}
	if count := frame.Usage.count(); model != "" && (count.Input > 0 || count.Output > 0 || count.CacheRead > 0 || count.CacheWrite > 0) {
		totals[model] = count
	}
	return totals
}

func (t *claudeTurn) cancelReview(id string) {
	t.reviewMu.Lock()
	cancel := t.reviews[id]
	delete(t.reviews, id)
	t.reviewMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (t *claudeTurn) cancelReviews() {
	t.reviewMu.Lock()
	reviews := t.reviews
	t.reviews = map[string]context.CancelFunc{}
	t.reviewMu.Unlock()
	for _, cancel := range reviews {
		cancel()
	}
}

// deliver publishes the Outcome. Only the reader emits events, so closing
// the channel here cannot race a send.
func (t *claudeTurn) deliver(outcome Outcome) {
	t.cancelReviews()
	close(t.events)
	t.outcome <- outcome
	close(t.outcome)
	t.runCancel()
}
