package roomagent

import (
	"context"
	"encoding/json"
	"strings"

	api "github.com/simplexai-labs/linger/contracts-go/nodeservicesinternal"
)

// LocalComputerTools calls the owner's registered Computer without a model turn.
type LocalComputerTools interface {
	CallLocalComputerTool(context.Context, api.LocalComputerToolCall) (map[string]any, error)
}

// LocalBrowserTool executes a browser tool on the current owner Computer.
type LocalBrowserTool interface {
	CallLocalBrowserTool(context.Context, LocalBrowserToolCall) (LocalBrowserToolResult, error)
}

// LocalBrowserToolCall carries service-authorized identity and browser arguments.
type LocalBrowserToolCall struct {
	TenantID, OwnerActorID, ComputerID, AgentID, ToolSessionID, ToolName string
	Arguments                                                            map[string]any
}

// LocalBrowserToolResult contains the browser tool text and execution status.
type LocalBrowserToolResult struct {
	Text    string
	IsError bool
}

// LocalComputerToolError preserves an unavailable or uncertain tool outcome.
type LocalComputerToolError struct{ Code, Message string }

func (e *LocalComputerToolError) Error() string { return e.Code + ": " + e.Message }

// CallLocalComputerTool dispatches directly to the Computer without creating a model Run.
func (g *HTTPGateway) CallLocalComputerTool(ctx context.Context, call api.LocalComputerToolCall) (map[string]any, error) {
	response, err := g.browserClient.CallLocalComputerToolWithResponse(ctx, call)
	if err != nil {
		return nil, &LocalComputerToolError{Code: "outcome_unknown", Message: "The Computer may have performed the operation. Check its effect before retrying."}
	}
	if response.JSON200 == nil {
		return nil, &LocalComputerToolError{Code: "computer_unavailable", Message: "The Computer could not accept this tool call."}
	}
	if status, ok := response.JSON200.Result["status"].(string); ok && status != "ok" {
		return nil, &LocalComputerToolError{Code: status, Message: "Check the Computer and current operation state before continuing."}
	}
	return response.JSON200.Result, nil
}

// CallLocalBrowserTool adapts native browser content for the Live tool response.
func (g *HTTPGateway) CallLocalBrowserTool(ctx context.Context, call LocalBrowserToolCall) (LocalBrowserToolResult, error) {
	result, err := g.CallLocalComputerTool(ctx, api.LocalComputerToolCall{TenantId: call.TenantID, OwnerActorId: call.OwnerActorID, ComputerId: call.ComputerID, AgentId: call.AgentID, ToolSessionId: call.ToolSessionID, Server: api.Browser, ToolName: call.ToolName, Arguments: call.Arguments})
	if err != nil {
		return LocalBrowserToolResult{}, err
	}
	data, err := json.Marshal(result)
	if err != nil {
		return LocalBrowserToolResult{}, err
	}
	var content struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		IsError bool `json:"isError"`
	}
	if err = json.Unmarshal(data, &content); err != nil {
		return LocalBrowserToolResult{}, err
	}
	texts := []string{}
	for _, block := range content.Content {
		if block.Type == "text" {
			texts = append(texts, block.Text)
		}
	}
	return LocalBrowserToolResult{Text: strings.Join(texts, "\n"), IsError: content.IsError}, nil
}
