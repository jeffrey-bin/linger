package provider

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
	localworkspace "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/workspace"
)

func probePiAuthentication(ctx context.Context, executable string, environment map[string]string, timeout time.Duration) runtimeProbeOutcome {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	failure := runtimeProbeOutcome{Status: "error", Code: "RUNTIME_DIAGNOSTIC_FAILED", Message: "Pi authentication could not be verified"}
	prepared, err := localworkspace.PiSourceEnvironment(environment)
	if err != nil {
		return failure
	}
	catalog, err := native.DiscoverPiModels(ctx, native.NewInvocation(executable, nil).WithEnvironment(prepared))
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			failure.Message = "Pi model catalog timed out"
		}
		if errors.Is(err, context.Canceled) || errors.Is(ctx.Err(), context.Canceled) {
			failure.Message = "Pi model catalog was canceled"
		}
		return failure
	}
	required := runtimeProbeOutcome{Status: "authentication_required", Code: "RUNTIME_AUTHENTICATION_REQUIRED", Message: "Configure a Pi API key or open pi and enter /login as the Computer user"}
	if len(catalog.Models) == 0 {
		return required
	}
	model := catalog.Models[0].ID
	for _, candidate := range catalog.Models {
		if candidate.Default {
			model = candidate.ID
			break
		}
	}
	stdout, _, runErr := runBoundedProbe(ctx, executable, []string{"auth", "check", "--model", model, "--json"}, prepared, "", timeout)
	if errors.Is(runErr, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
		failure.Message = "Pi authentication check timed out"
		return failure
	}
	if errors.Is(runErr, context.Canceled) || errors.Is(ctx.Err(), context.Canceled) {
		failure.Message = "Pi authentication check was canceled"
		return failure
	}
	var status struct {
		Status string `json:"status"`
	}
	if json.Unmarshal([]byte(strings.TrimSpace(stdout)), &status) != nil {
		return failure
	}
	switch status.Status {
	case "ready":
		if runErr == nil {
			return runtimeProbeOutcome{Status: "ready"}
		}
	case "not_ready", "invalid":
		return required
	}
	return failure
}
