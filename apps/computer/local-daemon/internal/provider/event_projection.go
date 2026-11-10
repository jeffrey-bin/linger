package provider

import (
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/redact"
)

type eventProjection struct {
	operationID string
	tools       map[string]string
	// quiet holds tool calls that stay in history without a Room activity.
	quiet         map[string]bool
	thinking      bool
	thinkingTitle string
	// reasoning collects thinking a Runtime streams without titles until a
	// title can be read from it; titled marks that one was.
	reasoning string
	titled    bool
}

// project maps a provider Message to wire events. Thinking follows the Cloud
// Codex projection: repeats are dropped, and the first tool call, tool result,
// or reply after thinking restores working so the Room does not keep a stale
// title. Thinking without a title gets one from its text, the way Codex
// titles its reasoning summaries.
func (projection *eventProjection) project(message native.Event) []any {
	if message.Kind == native.EventModelResponse {
		if message.Response == nil {
			return nil
		}
		return []any{modelResponded(*message.Response, message.ObservedAt)}
	}
	if message.Kind == native.EventReasoning {
		if message.Title == "" && message.Body != "" && !projection.titled {
			projection.reasoning += message.Body
			if title, ok := native.ReasoningTitle(projection.reasoning, false); ok {
				message.Title, projection.titled, projection.reasoning = title, true, ""
			}
		}
		if projection.thinking && (message.Title == "" || message.Title == projection.thinkingTitle) {
			return nil
		}
		projection.thinking, projection.thinkingTitle = true, message.Title
		return []any{normalizeMessage(message, projection.operationID)}
	}
	events := projection.projectActivity(message)
	if len(events) == 0 {
		return events
	}
	// Thinking that ends before a title was delimited is titled whole.
	var lead []any
	pending := projection.reasoning
	projection.reasoning, projection.titled = "", false
	if title, _ := native.ReasoningTitle(pending, true); title != "" && title != projection.thinkingTitle {
		projection.thinking, projection.thinkingTitle = true, title
		lead = append(lead, map[string]any{"type": "status.changed", "status": "thinking", "title": redact.Text(title)})
	}
	if projection.thinking {
		switch events[0].(map[string]any)["type"] {
		case "tool.called", "tool.returned", "message.delta":
			projection.thinking, projection.thinkingTitle = false, ""
			lead = append(lead, map[string]any{"type": "status.changed", "status": "working"})
		case "status.changed":
			projection.thinking, projection.thinkingTitle = false, ""
		}
	}
	return append(lead, events...)
}

func (projection *eventProjection) projectActivity(message native.Event) []any {
	if message.Kind == native.EventToolProgress {
		if _, active := projection.tools[message.InvocationID]; !active || projection.quiet[message.InvocationID] {
			return nil
		}
		return []any{map[string]any{"type": "activity.updated", "activity_id": stableEventID("activity", projection.operationID+"\x00"+message.InvocationID), "detail": message.Body}}
	}
	if message.Kind == native.EventLog || message.Kind == native.EventError {
		return nil
	}
	if message.Kind == native.EventPlan {
		event := map[string]any{"type": "plan.updated", "steps": message.Input["steps"]}
		if explanation, ok := message.Input["explanation"]; ok {
			event["explanation"] = explanation
		}
		return []any{event}
	}
	if message.Kind == native.EventToolOutput && message.ToolName == "" {
		message.ToolName = projection.tools[message.InvocationID]
	}
	event := normalizeMessage(message, projection.operationID).(map[string]any)
	if event["type"] == "message.delta" {
		remaining := strings.ToValidUTF8(event["delta"].(string), "\ufffd")
		events := make([]any, 0)
		for len(remaining) > 64*1024 {
			boundary := 64 * 1024
			for !utf8.RuneStart(remaining[boundary]) {
				boundary--
			}
			chunk := map[string]any{"type": "message.delta", "message_id": event["message_id"], "delta": remaining[:boundary]}
			if observedAt, ok := event["observed_at_unix_ms"]; ok {
				chunk["observed_at_unix_ms"] = observedAt
			}
			events = append(events, chunk)
			remaining = remaining[boundary:]
		}
		event["delta"] = remaining
		return append(events, event)
	}
	if message.Kind == native.EventToolCall {
		if projection.tools == nil {
			projection.tools = make(map[string]string)
		}
		callID := event["call_id"].(string)
		projection.tools[callID] = event["tool_name"].(string)
		kind, input, status := activityPresentation(message)
		if kind == native.ActivityNone {
			if projection.quiet == nil {
				projection.quiet = make(map[string]bool)
			}
			projection.quiet[callID] = true
			return []any{event}
		}
		activity := map[string]any{"type": "activity.started", "activity_id": stableEventID("activity", projection.operationID+"\x00"+callID), "kind": kind, "title": event["tool_name"]}
		if content := activityInput(input, status); len(content) > 0 {
			activity["content"] = content
		}
		return []any{event, activity}
	}
	if message.Kind == native.EventToolOutput {
		callID := event["call_id"].(string)
		if projection.quiet[callID] {
			delete(projection.tools, callID)
			delete(projection.quiet, callID)
			return []any{event}
		}
		if _, started := projection.tools[callID]; started {
			delete(projection.tools, callID)
			outcome := "succeeded"
			if event["is_error"] == true {
				outcome = "failed"
			}
			return []any{event, map[string]any{"type": "activity.finished", "activity_id": stableEventID("activity", projection.operationID+"\x00"+callID), "outcome": outcome}}
		}
	}
	return []any{event}
}

// gatewayID is the Runner Gateway Id format; a native identifier outside it
// is left out of a model record rather than failing the event.
var gatewayID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

// modelResponded is the wire record of one model request.
func modelResponded(response native.ModelResponse, respondedAt time.Time) map[string]any {
	usage := map[string]any{
		"input": max(response.Usage.Input, 0), "cache_read": max(response.Usage.CacheRead, 0),
		"cache_write": max(response.Usage.CacheWrite, 0), "output": max(response.Usage.Output, 0),
	}
	if response.Usage.Reasoning > 0 {
		usage["reasoning"] = response.Usage.Reasoning
	}
	event := map[string]any{
		"type": "model.responded", "granularity": response.Granularity, "usage": usage,
		"responded_at_unix_ms": respondedAt.UnixMilli(), "started_at_unix_ms": response.StartedAt.UnixMilli(),
	}
	if !response.FirstItemAt.IsZero() {
		event["first_item_at_unix_ms"] = response.FirstItemAt.UnixMilli()
	}
	if model := strings.TrimSpace(response.Model); model != "" && len(model) <= 200 {
		event["model"] = model
	}
	if gatewayID.MatchString(response.MessageID) {
		event["message_id"] = response.MessageID
	}
	if gatewayID.MatchString(response.Agent) {
		agent := map[string]any{"id": response.Agent}
		if gatewayID.MatchString(response.ParentCallID) {
			agent["parent_call_id"] = response.ParentCallID
		}
		event["agent"] = agent
	}
	return event
}
