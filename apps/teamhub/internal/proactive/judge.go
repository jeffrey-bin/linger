package proactive

import (
	"context"
	"errors"
	"time"

	"github.com/simplexai-labs/linger/contracts-go/nodeservicesinternal"
)

// AgentEventJudge adapts the Agent Service's event rules call to an EventJudge.
func AgentEventJudge(call func(context.Context, nodeservicesinternal.ProactiveEventJudgeRequest) (nodeservicesinternal.ProactiveEventJudgement, error)) EventJudge {
	return func(ctx context.Context, request EventJudgeRequest) (string, error) {
		var body nodeservicesinternal.ProactiveEventJudgeRequest
		body.Specific = request.Specific
		body.OpenItems = make([]struct {
			Content string     `json:"content"`
			DueAt   *time.Time `json:"dueAt,omitempty"`
		}, 0, len(request.OpenItems))
		for _, item := range request.OpenItems {
			body.OpenItems = append(body.OpenItems, struct {
				Content string     `json:"content"`
				DueAt   *time.Time `json:"dueAt,omitempty"`
			}{Content: item.Content, DueAt: item.DueAt})
		}
		judgement, err := call(ctx, body)
		if err != nil {
			return "", err
		}
		if judgement.Instructions == "" {
			return "", errors.New("proactive event rules are empty")
		}
		return judgement.Instructions, nil
	}
}
