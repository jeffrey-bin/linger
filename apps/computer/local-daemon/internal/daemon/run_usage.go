package daemon

import (
	"encoding/json"
	"regexp"
	"sort"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

// Matches the TeamHub model pattern; it also rejects placeholders such as "<synthetic>".
var reportedModelPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$`)

func reportedTokenCounts(usage native.TokenCount, reasoning bool) map[string]any {
	value := map[string]any{"input": usage.Input, "cache_read": usage.CacheRead, "cache_write": usage.CacheWrite, "output": usage.Output}
	if reasoning && usage.Reasoning > 0 && usage.Reasoning <= usage.Output {
		value["reasoning"] = usage.Reasoning
	}
	return value
}
func reportedRunUsage(spec provider.OperationSpec, result provider.Result) []map[string]any {
	if spec.OperationKind != "run.start" {
		return nil
	}
	providerName := "unknown"
	switch spec.Provider {
	case "codex":
		providerName = "openai"
	case "claude":
		providerName = "anthropic"

	}
	models := make([]string, 0, len(result.Usage))
	for model := range result.Usage {
		models = append(models, model)
	}
	sort.Strings(models)
	usage := make([]map[string]any, 0, len(models))
	for _, model := range models {
		counts := result.Usage[model]
		if !reportedModelPattern.MatchString(model) || counts.Input == 0 && counts.CacheRead == 0 && counts.CacheWrite == 0 && counts.Output == 0 {
			continue
		}
		value := reportedTokenCounts(counts, spec.Provider == "codex")
		value["model"], value["provider"] = model, providerName
		if last, ok := result.LastUsage[model]; ok {
			value["last"] = reportedTokenCounts(last, spec.Provider == "codex")
		}
		if result.CompactionCount != nil {
			count := int64(0)
			if len(usage) == 0 {
				count = *result.CompactionCount
			}
			value["compaction_count"] = count
		}
		usage = append(usage, value)
	}
	if len(usage) == 0 {
		return nil
	}
	return usage
}
func terminalWithUsage(payload map[string]any, spec provider.OperationSpec, result provider.Result) json.RawMessage {
	if usage := reportedRunUsage(spec, result); len(usage) > 0 {
		payload["usage"] = usage
	}
	if spec.OperationKind == "run.start" && spec.PrepareNativeResume != nil {
		payload["prepare_native_resume"] = spec.PrepareNativeResume
	}
	if spec.OperationKind == "run.start" && result.NativeResume != nil {
		payload["native_resume"] = result.NativeResume
	}
	return mustJSON(payload)
}
