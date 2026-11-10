package provider

import (
	"context"
	"errors"
	"maps"
	"reflect"
	"time"

	localworkspace "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/workspace"
)

type RuntimeMonitorOptions struct {
	Initial               DiscoveryResult
	Discovery             DiscoveryOptions
	RefreshInterval       time.Duration
	FullRefreshEveryTicks int
	OnChanged             func(DiscoveryResult) error
	OnError               func(error)
	Discover              func(context.Context, DiscoveryOptions) (DiscoveryResult, error)
	FullRefreshAllowed    func() bool
	// RuntimeBusy reports an active operation. A running operation proves its
	// Runtime works, so an inconclusive auth probe then keeps the ready state.
	RuntimeBusy func() bool
}

const transientRuntimeFailureThreshold = 2

func MonitorRuntimeDiagnostics(ctx context.Context, options RuntimeMonitorOptions) error {
	if options.RefreshInterval <= 0 || options.FullRefreshEveryTicks < 1 || options.OnChanged == nil {
		return errors.New("Runtime diagnostic monitor options are invalid")
	}
	current := options.Initial
	transientFailures := make(map[string]int)
	authenticationFailures := make(map[string]int)
	discover := options.Discover
	if discover == nil {
		discover = Discover
	}
	ticker := time.NewTicker(options.RefreshInterval)
	defer ticker.Stop()
	for tick := 1; ; tick++ {
		select {
		case <-ctx.Done():
			return context.Cause(ctx)
		case <-ticker.C:
		}
		var next DiscoveryResult
		var err error
		if (tick%options.FullRefreshEveryTicks == 0 || runtimeExecutablesChanged(current.Diagnostics)) &&
			(options.FullRefreshAllowed == nil || options.FullRefreshAllowed()) {
			next, err = discover(ctx, options.Discovery)
			if err == nil {
				for _, diagnostic := range next.Diagnostics {
					if diagnostic.Status == "ready" {
						delete(authenticationFailures, diagnostic.Type)
					}
				}
				next = retainReadyRuntimesDuringTransientFailures(current, next, transientFailures)
			}
		} else {
			next, err = refreshRuntimeAuthentication(ctx, current, options.Discovery, tick%options.FullRefreshEveryTicks == 0)
			if err == nil {
				if options.RuntimeBusy != nil && options.RuntimeBusy() {
					next = retainReadyRuntimesDuringInconclusiveProbes(current, next)
				}
				next = retainReadyRuntimesDuringTransientFailures(current, next, authenticationFailures)
			}
		}
		if err != nil {
			if options.OnError != nil {
				options.OnError(err)
				continue
			}
			return err
		}
		if sameRuntimeDiagnostics(current.Diagnostics, next.Diagnostics) {
			// Retain internal probe provenance even when the public status did not
			// change; only this provenance permits a safe auth-only recovery.
			current = next
			continue
		}
		if err := options.OnChanged(next); err != nil {
			if options.OnError != nil {
				options.OnError(err)
				continue
			}
			return err
		}
		current = next
	}
}

func retainReadyRuntimesDuringTransientFailures(current, next DiscoveryResult, failures map[string]int) DiscoveryResult {
	diagnostics := append([]RuntimeDiagnostic(nil), next.Diagnostics...)
	for index := range diagnostics {
		previous := findRuntimeDiagnostic(current.Diagnostics, diagnostics[index].Type)
		if previous == nil {
			continue
		}
		if previous.Status == "ready" && !runtimeExecutableChanged(*previous) && previous.ExecutablePath == diagnostics[index].ExecutablePath &&
			(diagnostics[index].Status == "incompatible" || diagnostics[index].Status == "error") &&
			(diagnostics[index].Type != "codex" || diagnostics[index].ModelCatalogError == "") {
			failures[diagnostics[index].Type]++
			if failures[diagnostics[index].Type] < transientRuntimeFailureThreshold {
				diagnostics[index] = *previous
				continue
			}
		} else {
			delete(failures, diagnostics[index].Type)
		}
	}
	return DiscoveryResult{Diagnostics: diagnostics, Installations: installationsFromDiagnostics(diagnostics)}
}

// retainReadyRuntimesDuringInconclusiveProbes keeps a ready Runtime ready
// when its auth probe neither succeeded nor reported a logout, which a busy
// machine causes by timing the probe out. A real logout still goes through.
func retainReadyRuntimesDuringInconclusiveProbes(current, next DiscoveryResult) DiscoveryResult {
	diagnostics := append([]RuntimeDiagnostic(nil), next.Diagnostics...)
	changed := false
	for index := range diagnostics {
		previous := findRuntimeDiagnostic(current.Diagnostics, diagnostics[index].Type)
		if previous == nil || previous.Status != "ready" || !diagnostics[index].authProbeFailed {
			continue
		}
		diagnostics[index] = *previous
		changed = true
	}
	if !changed {
		return next
	}
	return DiscoveryResult{Diagnostics: diagnostics, Installations: installationsFromDiagnostics(diagnostics)}
}

func findRuntimeDiagnostic(diagnostics []RuntimeDiagnostic, runtimeType string) *RuntimeDiagnostic {
	for index := range diagnostics {
		if diagnostics[index].Type == runtimeType {
			return &diagnostics[index]
		}
	}
	return nil
}

func RefreshRuntimeAuthentication(ctx context.Context, current DiscoveryResult, options DiscoveryOptions) (DiscoveryResult, error) {
	return refreshRuntimeAuthentication(ctx, current, options, false)
}

// A full discovery cannot run during an active operation. Retry only previously
// verified executables whose authentication probe failed, at the slower full
// discovery cadence, so a transient error can recover without restarting.
func refreshRuntimeAuthentication(ctx context.Context, current DiscoveryResult, options DiscoveryOptions, retryFailed bool) (DiscoveryResult, error) {
	diagnostics := append([]RuntimeDiagnostic(nil), current.Diagnostics...)
	for index := range diagnostics {
		if err := ctx.Err(); err != nil {
			return DiscoveryResult{}, context.Cause(ctx)
		}
		diagnostic := diagnostics[index]
		if runtimeExecutableChanged(diagnostic) {
			// Active operations keep their process. Only full discovery can
			// validate a replacement executable, never an auth-only probe.
			continue
		}
		if (diagnostic.Type == "codex" || diagnostic.Type == "pi") && diagnostic.Status == "error" && diagnostic.ModelCatalogError != "" {
			continue
		}
		if diagnostic.ExecutablePath == "" || (diagnostic.Status != "ready" && diagnostic.Status != "authentication_required" &&
			!(retryFailed && diagnostic.Status == "error" && diagnostic.Version != "" && diagnostic.authProbeFailed && diagnostic.Error != nil && diagnostic.Error.Code == "RUNTIME_DIAGNOSTIC_FAILED")) {
			continue
		}
		policy := runtimeDetectionPolicies[diagnostic.Type]
		if !policy.authenticationRefresh || policy.authenticationProbe == nil {
			continue
		}
		environment := maps.Clone(options.Environment)
		if diagnostic.ExecutionPath != "" {
			if environment == nil {
				environment = make(map[string]string)
			}
			environment["PATH"] = diagnostic.ExecutionPath
		}
		outcome := refreshAuthenticationProbe(ctx, diagnostic, environment, options)
		diagnostic.Status = outcome.Status
		diagnostic.authProbeFailed = outcome.Status == "error" && outcome.Code == "RUNTIME_DIAGNOSTIC_FAILED"
		diagnostic.CheckedAt = time.Now().UTC()
		if outcome.Status == "ready" {
			diagnostic.Error = nil
		} else {
			diagnostic.Error = &DiagnosticError{Code: outcome.Code, Message: outcome.Message}
		}
		if diagnostic.Type == "pi" && diagnostic.Status == "ready" {
			catalogCtx, cancel := context.WithTimeout(ctx, boundedAuthTimeout(options.Timeout))
			diagnostic.Models, diagnostic.ModelCatalogError = discoverRuntimeModels(catalogCtx, "pi", diagnostic.ExecutablePath, environment)
			cancel()
			if diagnostic.ModelCatalogError != "" {
				diagnostic.Status, diagnostic.authProbeFailed = "error", false
				diagnostic.Error = &DiagnosticError{Code: "RUNTIME_DIAGNOSTIC_FAILED", Message: diagnostic.ModelCatalogError}
			}
		}
		diagnostics[index] = diagnostic
	}
	return DiscoveryResult{Diagnostics: diagnostics, Installations: installationsFromDiagnostics(diagnostics)}, nil
}

func refreshAuthenticationProbe(ctx context.Context, diagnostic RuntimeDiagnostic, environment map[string]string, options DiscoveryOptions) runtimeProbeOutcome {
	budget := boundedAuthTimeout(options.Timeout)
	if diagnostic.Type != "codex" {
		return probeRuntimeAuthentication(ctx, diagnostic.Type, diagnostic.ExecutablePath, environment, budget, diagnostic.Version, options.RuntimeHomeRoot)
	}
	probe, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	// An authentication probe lists no models, so its home needs no cache.
	prepared, release, err := localworkspace.CodexProbeEnvironment(probe, environment, diagnostic.Version, nil)
	if err != nil {
		return runtimeProbeOutcome{Status: "error", Code: "RUNTIME_DIAGNOSTIC_FAILED", Message: "Codex diagnostic home could not be prepared"}
	}
	defer release()
	return probeRuntimeAuthentication(probe, diagnostic.Type, diagnostic.ExecutablePath, prepared, budget, diagnostic.Version, options.RuntimeHomeRoot)
}

func runtimeExecutableChanged(diagnostic RuntimeDiagnostic) bool {
	return diagnostic.EntryPath != "" && diagnostic.ExecutablePath != "" &&
		ValidateRuntimeExecutable(diagnostic.EntryPath, diagnostic.ExecutablePath) != nil
}

func runtimeExecutablesChanged(diagnostics []RuntimeDiagnostic) bool {
	for _, diagnostic := range diagnostics {
		if (diagnostic.Status == "ready" || diagnostic.Status == "authentication_required") && runtimeExecutableChanged(diagnostic) {
			return true
		}
	}
	return false
}

func installationsFromDiagnostics(diagnostics []RuntimeDiagnostic) map[string]RuntimeDiagnostic {
	installations := make(map[string]RuntimeDiagnostic)
	for _, diagnostic := range diagnostics {
		if diagnostic.ExecutablePath != "" && (diagnostic.Status == "ready" || diagnostic.Status == "authentication_required") {
			installations[diagnostic.Type] = diagnostic
		}
	}
	return installations
}

func sameRuntimeDiagnostics(left, right []RuntimeDiagnostic) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index].Type != right[index].Type || left[index].Status != right[index].Status ||
			left[index].ModelCatalogError != right[index].ModelCatalogError || !reflect.DeepEqual(left[index].Models, right[index].Models) ||
			left[index].Protocol != right[index].Protocol || left[index].Version != right[index].Version ||
			left[index].EntryPath != right[index].EntryPath || left[index].ExecutionPath != right[index].ExecutionPath ||
			left[index].ExecutablePath != right[index].ExecutablePath || !sameDiagnosticError(left[index].Error, right[index].Error) {
			return false
		}
	}
	return true
}

func sameDiagnosticError(left, right *DiagnosticError) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return left.Code == right.Code && left.Message == right.Message
}
