package native

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
)

var (
	codexLoadedPoll        = 10 * time.Millisecond
	errCodexMemoryEnabled  = errors.New("Codex native memory must be disabled before starting a managed thread; disable memories and memory_tool in the selected profile or update Codex")
	errCodexIncompleteList = errors.New("incomplete loaded-thread list")
)

// bind starts, resumes or keeps the thread this Operation runs on and
// returns the binding mode.
func (op *codexOperation) bind(ctx context.Context, fingerprint string) (string, error) {
	proc := op.proc
	proc.mu.Lock()
	loaded, storedFingerprint, storedHash, prepared := proc.threadID, proc.fingerprint, proc.mcpHash, proc.preparedThread
	proc.mu.Unlock()
	sameInputs := op.reused && loaded != "" && storedFingerprint != "" && storedFingerprint == fingerprint
	// A Context's first Run asks for no thread; it adopts the empty thread a
	// prepare started for the same inputs, which is already named and loaded.
	adopt := sameInputs && op.spec.ResumeID == "" && prepared && !op.spec.PrepareOnly
	if sameInputs && (op.spec.ResumeID == loaded || adopt) {
		mode := "reused"
		if adopt {
			mode = "adopted"
		}
		if op.mcpHash != storedHash {
			if err := op.reloadMCP(ctx); err != nil {
				return "", err
			}
			if !adopt {
				mode = "mcp_refreshed"
			}
		}
		proc.mu.Lock()
		proc.preparedThread = proc.preparedThread && op.spec.PrepareOnly
		proc.mu.Unlock()
		op.mu.Lock()
		op.resumed = true
		op.mu.Unlock()
		op.logger.Info("codex thread binding", "phase", mode, "thread_id", loaded)
		return mode, nil
	}
	if err := op.checkMemoryPolicy(ctx); err != nil {
		return "", err
	}
	if loaded != "" {
		if err := op.unload(ctx, loaded); err != nil {
			return "", err
		}
		proc.mu.Lock()
		proc.threadID, proc.fingerprint = "", ""
		proc.mu.Unlock()
	}
	if err := op.openThread(ctx); err != nil {
		return "", err
	}
	if loaded != "" {
		if err := op.reloadMCP(ctx); err != nil {
			return "", err
		}
	}
	if loaded != "" {
		op.spec.Readiness.rebound()
	}
	op.logger.Info("codex thread binding", "phase", "rebound", "thread_id", proc.boundThread())
	return "rebound", nil
}

func (op *codexOperation) reloadMCP(ctx context.Context) error {
	if _, _, err := op.proc.transport.call(ctx, "config/mcpServer/reload", map[string]any{}, op.budget("config/mcpServer/reload"), nil); err != nil {
		return fmt.Errorf("codex config/mcpServer/reload failed: %w", err)
	}
	return nil
}

// checkMemoryPolicy proves native memory is off for this Dir before any
// thread mutation. User profiles are never rewritten.
func (op *codexOperation) checkMemoryPolicy(ctx context.Context) error {
	result, _, err := op.proc.transport.call(ctx, "config/read", map[string]any{"cwd": op.spec.Dir, "includeLayers": false}, op.budget("config/read"), nil)
	if err != nil {
		return fmt.Errorf("verify Codex native memory policy: %w", err)
	}
	if !codexMemoryDisabled(result) {
		return errCodexMemoryEnabled
	}
	return nil
}

func codexMemoryDisabled(result json.RawMessage) bool {
	var document struct {
		Config map[string]json.RawMessage `json:"config"`
	}
	if json.Unmarshal(result, &document) != nil || document.Config == nil {
		return false
	}
	var features map[string]json.RawMessage
	if json.Unmarshal(document.Config["features"], &features) != nil || features == nil {
		return false
	}
	isFalse := func(raw json.RawMessage) bool { return strings.TrimSpace(string(raw)) == "false" }
	if !isFalse(features["memories"]) || !isFalse(features["memory_tool"]) {
		return false
	}
	rawProfile, present := document.Config["profile"]
	if !present || strings.TrimSpace(string(rawProfile)) == "null" {
		return true
	}
	var name string
	if json.Unmarshal(rawProfile, &name) != nil || name == "" {
		return false
	}
	var profiles map[string]json.RawMessage
	if json.Unmarshal(document.Config["profiles"], &profiles) != nil {
		return false
	}
	var profile map[string]json.RawMessage
	if json.Unmarshal(profiles[name], &profile) != nil || profile == nil {
		return false
	}
	rawFeatures, has := profile["features"]
	if !has {
		return true
	}
	var profileFeatures map[string]json.RawMessage
	if json.Unmarshal(rawFeatures, &profileFeatures) != nil || profileFeatures == nil {
		return false
	}
	for _, key := range []string{"memories", "memory_tool"} {
		if value, set := profileFeatures[key]; set && !isFalse(value) {
			return false
		}
	}
	return true
}

// unload unsubscribes the loaded thread and, when supported, waits until
// the app-server no longer lists it.
func (op *codexOperation) unload(ctx context.Context, threadID string) error {
	budget := op.budget("thread/unsubscribe")
	confirm := codexSupportsImmediateUnload(op.proc.version, op.proc.home)
	unloadCtx, cancel := context.WithTimeoutCause(ctx, budget, &codexHandshakeTimeout{method: "thread/unsubscribe", budget: budget})
	defer cancel()
	op.markSetup("thread/unsubscribe")
	if _, _, err := op.proc.transport.call(unloadCtx, "thread/unsubscribe", map[string]any{"threadId": threadID}, 0, nil); err != nil {
		return fmt.Errorf("codex thread/unsubscribe failed: %w", err)
	}
	if !confirm {
		return nil
	}
	for {
		result, _, err := op.proc.transport.call(unloadCtx, "thread/loaded/list", map[string]any{}, 0, nil)
		if err != nil {
			if unloadCtx.Err() != nil {
				return fmt.Errorf("confirm Codex thread unload: %w", context.Cause(unloadCtx))
			}
			return fmt.Errorf("confirm Codex thread unload: %w", err)
		}
		var list struct {
			Data       *[]string `json:"data"`
			NextCursor *string   `json:"nextCursor"`
		}
		if json.Unmarshal(result, &list) != nil || list.Data == nil || (list.NextCursor != nil && *list.NextCursor != "") {
			return fmt.Errorf("confirm Codex thread unload: %w", errCodexIncompleteList)
		}
		if !slices.Contains(*list.Data, threadID) {
			return nil
		}
		select {
		case <-unloadCtx.Done():
			return fmt.Errorf("confirm Codex thread unload: %w", context.Cause(unloadCtx))
		case <-time.After(codexLoadedPoll):
		}
	}
}

func (op *codexOperation) markSetup(method string) {
	op.mu.Lock()
	op.setupMethod, op.setupSentAt = method, time.Now()
	op.mu.Unlock()
}

// openThread starts a new thread, or resumes exactly ResumeID.
func (op *codexOperation) openThread(ctx context.Context) error {
	spec := op.spec
	method := "thread/start"
	if spec.ResumeID != "" {
		method = "thread/resume"
	}
	params := map[string]any{
		"cwd":                   spec.Dir,
		"baseInstructions":      codexOptional(spec.BaseInstructions),
		"developerInstructions": codexOptional(codexDeveloperInstructions(spec)),
	}
	if spec.Model != "" {
		params["model"] = spec.Model
	}
	if method == "thread/start" {
		params["experimentalRawEvents"] = false
		params["persistExtendedHistory"] = true
		if spec.PrepareOnly {
			params["historyMode"] = "legacy"
		}
	} else {
		params["threadId"] = spec.ResumeID
	}
	config := map[string]any{}
	if spec.Effort != "" {
		config["model_reasoning_effort"] = spec.Effort
	}
	if limit := toolOutputTokenLimit(spec.ContextWindow); limit < toolOutputTokens && stableCodexAtLeast(op.proc.version, codexToolOutputLimitVersion) {
		config["tool_output_token_limit"] = limit
	}
	if hook := spec.CodexPermissionHook; hook != nil {
		params["approvalPolicy"], params["approvalsReviewer"] = "untrusted", "user"
		config["bypass_hook_trust"] = true
		config["hooks"] = hook.Config
	}
	if len(config) > 0 {
		params["config"] = config
	}
	phase := strings.ReplaceAll(method, "/", "_")
	op.logger.Info("codex lifecycle", "phase", phase+"_sent", "method", method, "pid", op.proc.pid, "attempt", op.attempt)
	op.markSetup(method)
	spec.Readiness.session(method == "thread/resume")
	sent := time.Now()
	result, _, err := op.proc.transport.call(ctx, method, params, op.budget(method), nil)
	var thread struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
		Model string `json:"model"`
	}
	if err == nil {
		_ = json.Unmarshal(result, &thread)
	}
	if method == "thread/resume" {
		op.recordResume(ctx, sent, err == nil && thread.Thread.ID == spec.ResumeID)
		// Codex answers a resume it cannot serve with a JSON-RPC error;
		// transport, timeout, and child-exit failures say nothing about the
		// thread.
		var refused *codexRPCError
		if errors.As(err, &refused) {
			op.mu.Lock()
			op.failureCode = "session_not_found"
			op.mu.Unlock()
		}
	}
	switch {
	case err != nil:
		return fmt.Errorf("codex %s failed: %w", method, err)
	case thread.Thread.ID == "":
		return fmt.Errorf("codex %s omitted thread identity", method)
	case method == "thread/resume" && thread.Thread.ID != spec.ResumeID:
		return errors.New("Codex restored a different session")
	}
	op.logger.Info("codex lifecycle", "phase", phase+"_response", "method", method, "pid", op.proc.pid, "attempt", op.attempt, "latency_ms", time.Since(sent).Milliseconds())
	op.proc.mu.Lock()
	op.proc.threadID, op.proc.threadModel = thread.Thread.ID, thread.Model
	op.proc.preparedThread = method == "thread/start" && spec.PrepareOnly
	op.proc.mu.Unlock()
	if method != "thread/start" {
		return nil
	}
	op.mu.Lock()
	op.newThread = true
	op.mu.Unlock()
	if spec.PrepareOnly {
		return op.namePreparedThread(ctx, thread.Thread.ID)
	}
	return nil
}

func (op *codexOperation) recordResume(ctx context.Context, sent time.Time, success bool) {
	result := "error"
	switch {
	case ctx.Err() != nil:
		result = "canceled"
	case success:
		result = "success"
	}
	measurement := &NativeResumeMeasurement{DurationMs: time.Since(sent).Milliseconds(), Result: result}
	op.mu.Lock()
	op.nativeResume = measurement
	op.mu.Unlock()
	op.logger.Info("agent_runtime_measurement", "execution_backend", "local", "task_id", op.taskID,
		"thread_id", op.spec.ResumeID, "stage", "native_resume", "result", result,
		"duration_ms", measurement.DurationMs, "recovery_scenario", "unknown")
}

// namePreparedThread names a prepared thread before the prepare returns.
// An empty prepared checkpoint is resumable after the process exits only
// once its name is flushed, so a failure is fatal.
func (op *codexOperation) namePreparedThread(ctx context.Context, threadID string) error {
	name := strings.TrimSpace(op.spec.Title)
	if name == "" {
		name = "Linger session"
	}
	if err := op.titleThread(ctx, threadID, name, false); err != nil {
		return fmt.Errorf("persist empty Codex session: %w", err)
	}
	return nil
}

// nameThreadAfterTurnStart names a thread this Operation started, once
// turn/start is acknowledged: the app-server stalls while it persists a
// name that arrives before the first turn. The turn never waits for it and
// its result never changes the Outcome. ctx is the Operation's context.
func (op *codexOperation) nameThreadAfterTurnStart(ctx context.Context, threadID string) {
	name := strings.TrimSpace(op.spec.Title)
	op.mu.Lock()
	newThread := op.newThread
	op.mu.Unlock()
	if name == "" || !newThread {
		return
	}
	go func() {
		if err := op.titleThread(ctx, threadID, name, true); err != nil {
			op.logger.Warn("Codex session title unavailable", "thread_id", threadID, "error", sanitizeDiagnostic(err.Error()))
		}
	}()
}

// titleThread sends thread/name/set and logs its result. bestEffort keeps
// the shared stdin open when ctx ends during a blocked write.
func (op *codexOperation) titleThread(ctx context.Context, threadID, name string, bestEffort bool) error {
	const method = "thread/name/set"
	sent := time.Now()
	_, _, err := op.proc.transport.call(ctx, method, map[string]any{"threadId": threadID, "name": name}, op.budget(method), &codexCallHooks{bestEffort: bestEffort})
	phase := "thread_name_set_response"
	if err != nil {
		phase = "thread_name_set_failure"
	}
	op.logger.Info("codex lifecycle", "phase", phase, "method", method, "thread_id", threadID, "completed", err == nil, "latency_ms", time.Since(sent).Milliseconds())
	return err
}

// awaitMCPReady waits for the Operation-bound readiness observer. It never
// queries the app-server.
func (op *codexOperation) awaitMCPReady(ctx context.Context) error {
	if op.spec.MCPReady == nil {
		return errors.New("Codex MCP preparation has no Operation-bound readiness observer")
	}
	budget := op.budget("mcp/readiness")
	readyCtx, cancel := context.WithTimeoutCause(ctx, budget, &codexHandshakeTimeout{method: "mcp/readiness", budget: budget})
	defer cancel()
	op.logger.Info("codex mcp readiness", "phase", "resident_wait_start")
	started := time.Now()
	err := op.spec.MCPReady(readyCtx)
	outcome := "ready"
	switch {
	case err == nil:
	case readyCtx.Err() != nil:
		outcome = "canceled"
		if errors.Is(readyCtx.Err(), context.DeadlineExceeded) {
			outcome = "deadline_exceeded"
		}
		err = fmt.Errorf("wait for exact Codex MCP readiness: %w", context.Cause(readyCtx))
	default:
		outcome = "failed"
		err = fmt.Errorf("Codex MCP server failed before its exact tool catalog became ready: %w", err)
	}
	op.logger.Info("codex mcp readiness", "phase", "resident_wait_finish", "outcome", outcome, "duration_ms", time.Since(started).Milliseconds())
	return err
}

func codexOptional(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}
