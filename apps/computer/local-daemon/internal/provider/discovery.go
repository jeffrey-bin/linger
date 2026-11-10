package provider

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/redact"
	localworkspace "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/workspace"
)

type RuntimeDiagnostic struct {
	Type              string           `json:"type"`
	Status            string           `json:"status"`
	Protocol          string           `json:"protocol"`
	CheckedAt         time.Time        `json:"checked_at"`
	Version           string           `json:"version,omitempty"`
	Models            []RuntimeModel   `json:"models"`
	ModelCatalogError string           `json:"model_catalog_error,omitempty"`
	Error             *DiagnosticError `json:"error,omitempty"`
	ExecutablePath    string           `json:"-"`
	EntryPath         string           `json:"-"`
	ExecutionPath     string           `json:"-"`
	// Internal provenance: only an authentication probe failure may be
	// retried without rerunning version and protocol discovery.
	authProbeFailed bool
}

type RuntimeModel struct {
	ID                     string   `json:"id"`
	Label                  string   `json:"label"`
	AllowedReasoningEffort []string `json:"allowed_reasoning_effort"`
	DefaultReasoningEffort string   `json:"default_reasoning_effort,omitempty"`
	// ContextWindow is the model's context length in tokens, as
	// newGetModelLink resolves it; zero when unknown.
	ContextWindow int `json:"context_window,omitempty"`
	// Link is how the Runtime reaches the model, linkAPI or linkSubscription.
	Link string `json:"link,omitempty"`
	// IsDefault marks the model the Runtime runs when none is selected.
	IsDefault bool `json:"is_default,omitempty"`
	// resolved is the concrete model an alias runs, which a gateway lists.
	resolved string
}

type DiagnosticError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type DiscoveryResult struct {
	Diagnostics   []RuntimeDiagnostic
	Installations map[string]RuntimeDiagnostic
}

type DiscoveryOptions struct {
	RuntimeHomeRoot string
	ConfiguredPaths map[string]string
	Environment     map[string]string
	Timeout         time.Duration
	// Runtimes limits discovery to these types; empty diagnoses every Runtime.
	Runtimes []string
}

type runtimeDefinition struct {
	Type, Command, Protocol string
}

var runtimeDefinitions = []runtimeDefinition{
	{"codex", "codex", "app-server"},
	{"claude", "claude", "stream-json"},
	{"pi", "pi", "rpc"},
}

// ValidateRuntimeSelection accepts an omitted scope or a nonempty unique supported subset.
func ValidateRuntimeSelection(types []string) error {
	if types == nil {
		return nil
	}
	if len(types) == 0 {
		return errors.New("Runtime selection must not be empty")
	}
	seen := make(map[string]bool, len(types))
	for _, kind := range types {
		supported := false
		for _, definition := range runtimeDefinitions {
			supported = supported || definition.Type == kind
		}
		if !supported || seen[kind] {
			return errors.New("Runtime selection must contain unique supported types")
		}
		seen[kind] = true
	}
	return nil
}

func Discover(ctx context.Context, options DiscoveryOptions) (DiscoveryResult, error) {
	options.Environment = terminalEnvironment(ctx, platformEnvironment(options.Environment))
	return discoverResolved(ctx, options), nil
}

func discoverResolved(ctx context.Context, options DiscoveryOptions) DiscoveryResult {
	budget := options.Timeout
	if budget <= 0 {
		budget = 15 * time.Second
		if runtime.GOOS == "windows" || runtime.GOOS == "linux" {
			budget = 30 * time.Second
		}
	}
	definitions := runtimeDefinitions
	if len(options.Runtimes) > 0 {
		definitions = slices.DeleteFunc(slices.Clone(runtimeDefinitions), func(definition runtimeDefinition) bool {
			return !slices.Contains(options.Runtimes, definition.Type)
		})
	}
	observations := make([]RuntimeDiagnostic, len(definitions))
	var workers sync.WaitGroup
	for index, definition := range definitions {
		workers.Go(func() {
			observations[index] = diagnose(ctx, definition.Type, definition.Command, definition.Protocol, options, budget)
		})
	}
	workers.Wait()
	return DiscoveryResult{Diagnostics: observations, Installations: installationsFromDiagnostics(observations)}
}

func diagnose(ctx context.Context, kind, executable, protocol string, options DiscoveryOptions, budget time.Duration) RuntimeDiagnostic {
	observation := RuntimeDiagnostic{Type: kind, Protocol: protocol, CheckedAt: time.Now().UTC(), Models: []RuntimeModel{}}
	reject := func(status, code, message string) RuntimeDiagnostic {
		observation.Status = status
		observation.Error = &DiagnosticError{Code: code, Message: message}
		return observation
	}
	entry, err := resolveExecutableEntry(ctx, kind, executable, options)
	if err != nil {
		return reject("not_installed", "RUNTIME_NOT_INSTALLED", "Runtime executable not found")
	}
	canonical, err := canonicalExecutable(entry)
	if err != nil {
		return reject("not_installed", "RUNTIME_NOT_INSTALLED", "Runtime executable not found")
	}
	observation.EntryPath, observation.ExecutablePath = entry, canonical
	observation.ExecutionPath = options.Environment["PATH"]
	command := native.NewInvocation(canonical, nil).WithEnvironment(options.Environment)
	version, err := discoverRuntimeVersion(ctx, command, budget)
	if err != nil {
		return reject("error", "RUNTIME_DIAGNOSTIC_FAILED", "Runtime version probe failed")
	}
	observation.Version = version
	if err := native.RequireVersion(kind, version); err != nil {
		var old *native.VersionTooOldError
		if errors.As(err, &old) {
			return reject("incompatible", "RUNTIME_INCOMPATIBLE", err.Error())
		}
		return reject("error", "RUNTIME_DIAGNOSTIC_FAILED", "Runtime version could not be verified")
	}
	// A cold --version process may exhaust its attempt under startup load.
	// Protocol/authentication still receive their own bounded phase afterward.
	probe, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	environment := options.Environment
	if kind == "codex" {
		// Discovery lists models, so its home reuses a Context's catalog
		// instead of fetching it on every refresh.
		prepared, release, err := localworkspace.CodexProbeEnvironment(probe, environment, version, codexProbeModelsCache(options.RuntimeHomeRoot))
		if err != nil {
			return reject("error", "RUNTIME_DIAGNOSTIC_FAILED", "Codex diagnostic home could not be prepared")
		}
		defer release()
		environment = prepared
	}
	outcome := probeRuntime(probe, kind, canonical, environment, budget, version, options.RuntimeHomeRoot)
	observation.Status = outcome.Status
	observation.authProbeFailed = outcome.protocolVerified && outcome.Status == "error" && outcome.Code == "RUNTIME_DIAGNOSTIC_FAILED"
	if outcome.Status != "ready" {
		observation.Error = &DiagnosticError{Code: outcome.Code, Message: outcome.Message}
	}
	// Catalogs use live protocol exchanges. Preserve a failed protocol/auth
	// probe instead of replacing it with a second failure from model discovery.
	// Logged-out Claude must not receive an initialize request.
	catalogAllowed := outcome.Status == "ready" || ((kind == "codex" || kind == "pi") && outcome.Status == "authentication_required")
	if catalogAllowed {
		catalogCtx, stop := context.WithTimeout(ctx, budget)
		observation.Models, observation.ModelCatalogError = discoverRuntimeModels(catalogCtx, kind, canonical, environment)
		if observation.ModelCatalogError == "" {
			getModelLink := newGetModelLink(catalogCtx, kind, environment)
			for i := range observation.Models {
				link := getModelLink(observation.Models[i])
				observation.Models[i].Link, observation.Models[i].ContextWindow = link.link, link.window
			}
		}
		stop()
		if observation.ModelCatalogError != "" {
			observation.Models = []RuntimeModel{}
			observation.authProbeFailed = false
			return reject("error", "RUNTIME_DIAGNOSTIC_FAILED", observation.ModelCatalogError)
		}
	}

	return observation
}

// discoverRuntimeVersion retries a timed-out cold start once, after ProbeVersion
// has reaped its owned process tree. Each attempt has a fresh budget; the caller
// context bounds the entire discovery. Execution and cleanup errors are final.
func discoverRuntimeVersion(ctx context.Context, command native.Invocation, budget time.Duration) (string, error) {
	for attempt := 0; ; attempt++ {
		probe, cancel := context.WithTimeout(ctx, budget)
		version, err := native.ProbeVersion(probe, command)
		cancel()
		if err == nil || attempt == 1 || ctx.Err() != nil || !versionProbeTimedOut(err) {
			return version, err
		}
	}
}

func versionProbeTimedOut(err error) bool {
	// Do not retry a timeout joined with a process-tree cleanup failure.
	// Unwrap follows ordinary error wrappers but stops at joined errors.
	for err != nil {
		if err == context.DeadlineExceeded { //nolint:errorlint // joined cleanup errors must not classify as a retryable timeout
			return true
		}
		err = errors.Unwrap(err)
	}
	return false
}

func discoverRuntimeModels(ctx context.Context, kind, executable string, environment map[string]string) ([]RuntimeModel, string) {
	catalog, err := native.DiscoverModels(ctx, kind, native.NewInvocation(executable, nil).WithEnvironment(environment))
	if err == nil {
		models := normalizeRuntimeModels(catalog.Models)
		if len(models) > 0 || len(catalog.Models) == 0 {
			return models, ""
		}
		err = errors.New("Runtime model catalog has no usable entries")
	}
	return []RuntimeModel{}, boundedModelCatalogError(err)
}

func normalizeRuntimeModels(catalog []native.ModelOption) []RuntimeModel {
	result := make([]RuntimeModel, 0, min(100, len(catalog)))
	seen := make(map[string]bool)
	for _, entry := range catalog {
		id := strings.TrimSpace(entry.ID)
		if id == "" || len([]rune(id)) > 160 || seen[id] {
			continue
		}
		seen[id] = true
		label := strings.TrimSpace(entry.Label)
		if label == "" {
			label = id
		}
		model := RuntimeModel{ID: id, Label: truncateRunes(label, 160), AllowedReasoningEffort: []string{}, IsDefault: entry.Default, resolved: strings.TrimSpace(entry.Resolved)}
		if entry.ContextWindow > 0 && entry.ContextWindow <= maxModelContextWindow {
			model.ContextWindow = entry.ContextWindow
		}
		if entry.Effort != nil {
			for _, effort := range entry.Effort.Options {
				if validRuntimeReasoningEffort(effort.Value) && !slices.Contains(model.AllowedReasoningEffort, effort.Value) {
					model.AllowedReasoningEffort = append(model.AllowedReasoningEffort, effort.Value)
				}
			}
			if slices.Contains(model.AllowedReasoningEffort, entry.Effort.Default) {
				model.DefaultReasoningEffort = entry.Effort.Default
			}
		}
		result = append(result, model)
		if len(result) == 100 {
			break
		}
	}
	return result
}
func validRuntimeReasoningEffort(value string) bool {
	return slices.Contains([]string{"none", "low", "medium", "high", "xhigh", "max", "ultra"}, value)
}
func truncateRunes(value string, limit int) string {
	characters := []rune(value)
	return string(characters[:min(len(characters), max(limit, 0))])
}
func boundedModelCatalogError(err error) string {
	if err == nil || strings.TrimSpace(err.Error()) == "" {
		return "Runtime model discovery failed"
	}
	return truncateRunes(redact.Text(strings.TrimSpace(err.Error())), 240)
}

func resolveExecutableEntry(ctx context.Context, kind, name string, options DiscoveryOptions) (string, error) {
	if selected := options.ConfiguredPaths[kind]; selected != "" {
		return selected, nil
	}
	path := options.Environment["PATH"]
	if path == "" {
		path = os.Getenv("PATH")
	}
	for _, directory := range executableDirectories(path, options.Environment) {
		if !filepath.IsAbs(directory) {
			continue
		}
		for _, filename := range executableNames(name) {
			candidate := filepath.Join(directory, filename)
			if _, err := canonicalExecutable(candidate); err == nil {
				return candidate, nil
			}
		}
	}
	if bundle := applicationBundles[kind]; bundle != "" && runtime.GOOS == "darwin" {
		for _, parent := range []string{"/", options.Environment["HOME"]} {
			candidate := filepath.Join(parent, "Applications", bundle, "Contents", "Resources", name)
			if _, err := canonicalExecutable(candidate); err == nil {
				return candidate, nil
			}
		}
	}
	return "", os.ErrNotExist
}

// macOS desktop apps ship their CLI inside the bundle, outside PATH.
var applicationBundles = map[string]string{"codex": "Codex.app", "claude": "Claude.app"}

func canonicalExecutable(path string) (string, error) {
	if !filepath.IsAbs(path) {
		return "", os.ErrNotExist
	}
	resolved, err := resolveFinalPath(path)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || runtime.GOOS != "windows" && info.Mode().Perm()&0111 == 0 {
		return "", os.ErrNotExist
	}
	return resolved, nil
}
func ValidateRuntimeExecutable(entry, expected string) error {
	resolved, err := canonicalExecutable(entry)
	if err != nil {
		return errors.New("Runtime executable entry is unavailable; waiting for full Runtime discovery")
	}
	if resolved != expected {
		return errors.New("Runtime executable entry changed; waiting for full Runtime discovery")
	}
	return nil
}
func environmentList(environment map[string]string) []string {
	entries := make([]string, 0, len(environment))
	for key, value := range environment {
		entries = append(entries, key+"="+value)
	}
	slices.Sort(entries)
	return entries
}
func DiagnosticsJSON(observations []RuntimeDiagnostic) (json.RawMessage, error) {
	wire := slices.Clone(observations)
	for i := range wire {
		line, _, _ := strings.Cut(strings.TrimSpace(wire[i].Version), "\n")
		line, _, _ = strings.Cut(line, "\r")
		wire[i].Version = truncateRunes(redact.Text(strings.TrimSpace(line)), 120)
	}
	return json.Marshal(wire)
}

// codexProbeModelsCache is the peers a diagnostic home seeds its models cache
// from: the Context homes under runtimeHomeRoot and the source home.
func codexProbeModelsCache(runtimeHomeRoot string) *localworkspace.CodexModelsCachePeers {
	peers := &localworkspace.CodexModelsCachePeers{}
	if runtimeHomeRoot != "" {
		peers.Roots = []string{localworkspace.CodexRuntimeHomesDir(runtimeHomeRoot)}
	}
	return peers
}
