package agentruntimestate

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"regexp"
	"sort"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

var runUsageModelPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$`)

type RunTokenCounts struct {
	Input      int64  `json:"input"`
	CacheRead  int64  `json:"cache_read"`
	CacheWrite int64  `json:"cache_write"`
	Output     int64  `json:"output"`
	Reasoning  *int64 `json:"reasoning,omitempty"`
}
type RunUsage struct {
	RunTokenCounts
	Model           string          `json:"model"`
	Provider        string          `json:"provider"`
	Last            *RunTokenCounts `json:"last,omitempty"`
	CompactionCount *int64          `json:"compaction_count,omitempty"`
}

func validTokenCounts(value RunTokenCounts) bool {
	for _, number := range []int64{value.Input, value.CacheRead, value.CacheWrite, value.Output} {
		if number < 0 || number > 9007199254740991 {
			return false
		}
	}
	return value.Reasoning == nil || (*value.Reasoning >= 0 && *value.Reasoning <= value.Output)
}

// recordRunUsage writes one Runner Operation's usage onto its Run and adds it
// to the totals once; the caller owns the transaction, so the
// Run's usage and the totals always commit together.
func recordRunUsage(ctx context.Context, queries *store.Queries, runID, operationID string, usages []RunUsage) error {
	raw, err := canonicalJSON(usages)
	if err != nil {
		return err
	}
	recorded, err := queries.RecordAgentLocalRunUsage(ctx, store.RecordAgentLocalRunUsageParams{
		OperationID: operationID, Usage: raw, RunID: runID,
	})
	if err != nil || recorded == 0 {
		return err
	}
	for _, usage := range usages {
		var reasoning, compactions int64
		if usage.Reasoning != nil {
			reasoning = *usage.Reasoning
		}
		if usage.CompactionCount != nil {
			compactions = *usage.CompactionCount
		}
		if err := queries.AddAgentUsageTotals(ctx, store.AddAgentUsageTotalsParams{Provider: usage.Provider, Model: usage.Model, InputTokens: usage.Input, CacheReadTokens: usage.CacheRead, CacheWriteTokens: usage.CacheWrite, OutputTokens: usage.Output, ReasoningTokens: reasoning, CompactionCount: compactions}); err != nil {
			return err
		}
	}
	return nil
}

const (
	runUsageRejectedMalformed    = "malformed"
	runUsageRejectedInvalidEntry = "invalid_entry"
)

type runUsageRejection struct {
	reason string
	model  string
}

// filterLocalRunUsage keeps valid entries from a terminal's usage array. Structural
// problems reject the whole array; invalid entries are skipped individually.
// The result depends only on the reported bytes, so a replay keeps the same subset.
func filterLocalRunUsage(raw json.RawMessage, runtimeType string) ([]RunUsage, []runUsageRejection) {
	malformed := []runUsageRejection{{reason: runUsageRejectedMalformed}}
	var usages []RunUsage
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&usages) != nil || len(usages) == 0 || len(usages) > 32 {
		return nil, malformed
	}
	expectedProvider := "unknown"
	switch runtimeType {
	case "codex":
		expectedProvider = "openai"
	case "claude":
		expectedProvider = "anthropic"
	}
	sort.Slice(usages, func(i, j int) bool { return usages[i].Model < usages[j].Model })
	for index := 1; index < len(usages); index++ {
		if usages[index-1].Model == usages[index].Model {
			return nil, malformed
		}
	}
	var valid []RunUsage
	var rejected []runUsageRejection
	for _, usage := range usages {
		if usage.Provider != expectedProvider || !runUsageModelPattern.MatchString(usage.Model) || !validTokenCounts(usage.RunTokenCounts) ||
			(usage.Last != nil && !validTokenCounts(*usage.Last)) || (usage.CompactionCount != nil && (*usage.CompactionCount < 0 || *usage.CompactionCount > 9007199254740991)) {
			rejected = append(rejected, runUsageRejection{reason: runUsageRejectedInvalidEntry, model: usage.Model})
			continue
		}
		valid = append(valid, usage)
	}
	return valid, rejected
}

// RecordRunOperationInput names a Runner Operation of a Run. Usage is the
// array its terminal reported; nil records the Operation as it starts.
type RecordRunOperationInput struct {
	ContextKey  string
	Epoch       string
	RunID       string
	OperationID string
	RuntimeType string
	Usage       json.RawMessage
}

// RecordRunOperation keeps one entry per Runner Operation on its Run, and
// lands a terminal's usage once. Invalid usage entries are logged and
// skipped; they never fail the write.
func (s *Service) RecordRunOperation(ctx context.Context, input RecordRunOperationInput) error {
	if !validText(input.RunID, 1, 256) || !validText(input.OperationID, 1, 256) || !IsSupportedLocalRuntimeType(input.RuntimeType) {
		return ErrInvalid
	}
	_, err := executeEpochTx(ctx, s, input.Epoch, func(ctx context.Context, _ pgx.Tx, queries *store.Queries) (bool, error) {
		run, err := queries.GetAgentLocalRun(ctx, store.GetAgentLocalRunParams{ContextKey: input.ContextKey, RunID: input.RunID})
		if isNoRows(err) {
			return false, ErrNotFound
		}
		if err != nil {
			return false, err
		}
		if run.Epoch.String != input.Epoch {
			return false, ErrFenced
		}
		if err := queries.RecordAgentLocalRunOperation(ctx, store.RecordAgentLocalRunOperationParams{
			OperationID: input.OperationID, RunID: input.RunID,
		}); err != nil {
			return false, err
		}
		if len(input.Usage) == 0 {
			return true, nil
		}
		usages, rejected := filterLocalRunUsage(input.Usage, input.RuntimeType)
		for _, rejection := range rejected {
			attrs := []any{"event", "agent_run_usage_rejected", "operation_id", input.OperationID, "run_id", input.RunID, "reason", rejection.reason}
			if rejection.model != "" {
				attrs = append(attrs, "model", rejection.model)
			}
			slog.WarnContext(ctx, "agent run usage rejected", attrs...)
		}
		if len(usages) == 0 {
			return true, nil
		}
		return true, recordRunUsage(ctx, queries, input.RunID, input.OperationID, usages)
	})
	return err
}
