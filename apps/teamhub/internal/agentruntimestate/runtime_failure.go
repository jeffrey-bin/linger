package agentruntimestate

import (
	"encoding/json"
	"regexp"
)

// PublicRuntimeFailure contains metadata only; native provider text stays private.
type PublicRuntimeFailure struct {
	Code           string `json:"code"`
	RuntimeType    string `json:"runtime_type,omitempty"`
	RuntimeVersion string `json:"runtime_version,omitempty"`
}

var runtimeVersionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$`)

func terminalRuntimeFailure(raw json.RawMessage) (*PublicRuntimeFailure, error) {
	var terminal struct {
		Type    string          `json:"type"`
		Failure json.RawMessage `json:"failure"`
	}
	if json.Unmarshal(raw, &terminal) != nil {
		return nil, ErrInvalid
	}
	if len(terminal.Failure) == 0 || string(terminal.Failure) == "null" {
		return nil, nil
	}
	var failure PublicRuntimeFailure
	if terminal.Type != "failed" || strictJSON(terminal.Failure, &failure) != nil {
		return nil, ErrInvalid
	}
	switch failure.Code {
	case "session_not_found", "protocol_incompatible", "authentication_required", "network_error", "rate_limited",
		"model_unavailable", "model_not_offered", "context_too_long", "model_service_error", "timeout", "execution_failed",
		"execution_outcome_unknown", "reply_undelivered", "interrupted", "computer_unavailable",
		"cleanup_unconfirmed", "response_too_large", "unclassified":
	default:
		return nil, ErrInvalid
	}
	// A failure observed without a selected Runtime names none.
	switch failure.RuntimeType {
	case "", "codex", "claude", "pi":
	default:
		return nil, ErrInvalid
	}
	if failure.RuntimeVersion != "" && (len(failure.RuntimeVersion) > 80 || !runtimeVersionPattern.MatchString(failure.RuntimeVersion)) {
		return nil, ErrInvalid
	}
	return &failure, nil
}
