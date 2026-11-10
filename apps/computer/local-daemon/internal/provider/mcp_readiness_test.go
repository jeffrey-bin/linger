package provider

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

func TestExecutorPrepareMCPDoesNotStartProviderTurn(t *testing.T) {
	messages := make(chan native.Event)
	close(messages)
	results := make(chan native.Outcome, 1)
	results <- native.Outcome{Status: "completed", SessionID: "thread-test"}
	close(results)
	captured := make(chan native.RunSpec, 1)
	executor := Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) {
		return fakeBackend{session: &native.Run{Events: messages, Outcome: results}, onExecute: func(options native.RunSpec) { captured <- options }}, nil
	}}
	_, err := executor.PrepareMCP(context.Background(), OperationSpec{
		OperationKind: "run.start", Provider: "codex", ExecutablePath: "/bin/runtime", WorkingDirectory: t.TempDir(),
		ResumeSessionID: "thread-test",
		MCPConfig:       json.RawMessage(`{"mcpServers":{"linger_teamhub_collaboration":{"type":"http","url":"http://127.0.0.1:12345/mcp"}}}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	options := <-captured
	if !options.PrepareOnly || !options.WarmMCP {
		t.Fatalf("prepare options = %+v, want session-only exact MCP readiness", options)
	}
	if options.ExposeTurnStarted {
		t.Fatal("MCP preparation exposed a provider turn")
	}
}

func TestExecutorPreservesExternalMCPWithoutRequiringInternalProductMCP(t *testing.T) {
	for _, runtimeType := range []string{"codex", "claude"} {
		t.Run(runtimeType, func(t *testing.T) {
			messages := make(chan native.Event)
			close(messages)
			results := make(chan native.Outcome, 1)
			results <- native.Outcome{Status: "completed", SessionID: "thread-test"}
			close(results)
			captured := make(chan native.RunSpec, 1)
			executor := Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) {
				return fakeBackend{session: &native.Run{Events: messages, Outcome: results}, onExecute: func(options native.RunSpec) { captured <- options }}, nil
			}}
			execution, err := executor.Start(context.Background(), OperationSpec{
				Provider: runtimeType, ExecutablePath: "/bin/runtime", WorkingDirectory: t.TempDir(),
				MCPConfig: json.RawMessage(`{"mcpServers":{"linger_teamhub_collaboration":{"type":"http","url":"http://127.0.0.1:12345/mcp"},"linger_lev8":{"type":"http","url":"http://127.0.0.1:12346/mcp"}}}`),
			}, func(context.Context, protocol.Event) error { return nil })
			if err != nil {
				t.Fatal(err)
			}
			options := <-captured
			var config struct {
				Servers map[string]map[string]any `json:"mcpServers"`
			}
			if err := json.Unmarshal(options.MCPServers, &config); err != nil {
				t.Fatal(err)
			}
			server := config.Servers["linger_teamhub_collaboration"]
			optional := config.Servers["linger_lev8"]
			if server["required"] != nil || server["startup_timeout_sec"] != nil || optional["required"] != nil || optional["startup_timeout_sec"] != nil {
				t.Fatal("Executor added an implicit internal MCP startup requirement")
			}
			<-execution.Result
		})
	}
}

// A reviewed Run adopts its prepared thread without a reload only when both
// bind the same MCP config and the same PermissionRequest hook.
func TestExecutorPrepareMCPMatchesReviewedRunConfig(t *testing.T) {
	root := t.TempDir()
	capture := func(prepare, reviewed bool) native.RunSpec {
		messages := make(chan native.Event)
		close(messages)
		results := make(chan native.Outcome, 1)
		results <- native.Outcome{Status: "completed", SessionID: "thread-test"}
		close(results)
		captured := make(chan native.RunSpec, 1)
		executor := Executor{RuntimeHomeRoot: root + "/homes", NewBackend: func(string, native.Profile) (native.Runtime, error) {
			return fakeBackend{session: &native.Run{Events: messages, Outcome: results}, onExecute: func(options native.RunSpec) { captured <- options }}, nil
		}}
		spec := OperationSpec{
			OperationKind: "run.start", Provider: "codex", ExecutablePath: "/bin/runtime", WorkingDirectory: t.TempDir(),
			ResumeSessionID: "thread-test", PermissionReview: reviewed, CodexVersion: "codex-cli 0.163.0",
			TenantID: "tenant", OwnerActorID: "owner", AgentID: "agent", ScopeID: "scope",
			Environment: map[string]string{"HOME": root, "CODEX_HOME": root + "/source"},
			MCPConfig:   json.RawMessage(`{"mcpServers":{"computer":{"type":"http","url":"http://127.0.0.1:12345/mcp"}}}`),
		}
		if prepare {
			if _, err := executor.PrepareMCP(context.Background(), spec); err != nil {
				t.Fatal(err)
			}
		} else {
			execution, err := executor.Start(context.Background(), spec, func(context.Context, protocol.Event) error { return nil })
			if err != nil {
				t.Fatal(err)
			}
			<-execution.Result
		}
		return <-captured
	}
	if plain := capture(true, false); plain.CodexPermissionHook != nil || strings.Contains(string(plain.MCPServers), "prompt") {
		t.Fatalf("an unreviewed prepare installed review: %s", plain.MCPServers)
	}
	prepared, run := capture(true, true), capture(false, true)
	if string(prepared.MCPServers) != string(run.MCPServers) {
		t.Fatalf("prepared MCP config %s differs from the reviewed Run's %s", prepared.MCPServers, run.MCPServers)
	}
	if prepared.CodexPermissionHook == nil || run.CodexPermissionHook == nil {
		t.Fatal("prepared thread would be reused without the reviewed Run's hook")
	}
}
