package native

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/pelletier/go-toml/v2"
)

func TestCodexAppServerArgsGates(t *testing.T) {
	tail := []string{"--config", "features.memories=false", "--config", "features.memory_tool=false", "--config", "features.apps=false", "--config", "features.image_generation=false", "--config", "project_root_markers=[]", "--config", "skills.bundled.enabled=false"}
	cases := map[string][]string{
		"0.100.0":           {"app-server", "--disable", "plugins", "--listen", "stdio://", "x"},
		"codex-cli 0.128.0": {"app-server", "--disable", "plugins", "--disable", "goals", "--listen", "stdio://", "x"},
		"0.150.1":           {"app-server", "--disable", "plugins", "--disable", "goals", "--listen", "stdio://", "--config", "tool_output_token_limit=12000", "x"},
		"garbage":           {"app-server", "--disable", "plugins", "--listen", "stdio://", "x"},
	}
	for version, want := range cases {
		if got := CodexAppServerArgs(version, "x"); !slices.Equal(got, append(want, tail...)) {
			t.Fatalf("%s: %q", version, got)
		}
	}
}

func TestCodexImmediateUnloadCapability(t *testing.T) {
	for _, version := range []string{"0.155.1", "codex-cli 0.155.1", "0.156.0"} {
		if !codexSupportsImmediateUnload(version, "/home") {
			t.Fatalf("%s should support unload", version)
		}
	}
	for _, version := range []string{"0.150.1", "0.155.0", "0.155.1-alpha", "unknown 0.155.1", ""} {
		if codexSupportsImmediateUnload(version, "/home") {
			t.Fatalf("%s should not support unload", version)
		}
	}
	if codexSupportsImmediateUnload("0.156.0", "") {
		t.Fatal("no home must disable unload")
	}
	spec := RunSpec{AgentArgs: []string{"-c", "thread_unload_delay_secs=60"}}
	args := codexExecutionArgs(Profile{CodexToolVersion: "0.155.1"}, spec, "/home", slog.New(slog.DiscardHandler))
	if !slices.Equal(args[len(args)-2:], []string{"-c", "thread_unload_delay_secs=0"}) || !slices.Contains(args, "thread_unload_delay_secs=60") {
		t.Fatalf("args = %q", args)
	}
	args = codexExecutionArgs(Profile{CodexToolVersion: "0.150.1"}, spec, "/home", slog.New(slog.DiscardHandler))
	if slices.Contains(args, "thread_unload_delay_secs=0") {
		t.Fatalf("unsupported version got unload: %q", args)
	}
}

func TestCodexPermissionHookVersions(t *testing.T) {
	for version, want := range map[string]bool{"codex-cli 0.163.0": true, "0.170.2": true, "0.162.9": false, "0.150.1": false, "0.163.0-alpha.1": false, "": false, "unknown": false} {
		if CodexSupportsPermissionHook(version) != want {
			t.Fatalf("%q", version)
		}
	}
}

func TestCodexOverrideFiltering(t *testing.T) {
	logger := slog.New(slog.DiscardHandler)
	got := NormalizeCodexLaunchArgs(
		[]string{"-c=mcp_servers.a.command=\"x\"", "-cmcp_servers.b.url=\"y\"", "--listen", "ws://x", "--model", "kept"},
		[]string{"--config", `profiles."work".'mcp_servers'.c.command="z"`, "-c", "model=\"m\""},
		logger)
	if !slices.Equal(got, []string{"--model", "kept", "-c", `model="m"`}) {
		t.Fatalf("normalized = %q", got)
	}
	spec := RunSpec{
		ComputerArgs: []string{"-c", `profiles."a.b".shell_environment_policy.set.X="1"`, "--enable=goals,safe_feature,memories"},
		AgentArgs:    []string{"-c", "profiles.work.features={apps=true}", "--disable", "apps", "-c", "features.other=true"},
	}
	args := codexExecutionArgs(Profile{CodexConfigArgs: []string{"-c", "sandbox_mode=\"x\""}}, spec, "/home", logger)
	joined := strings.Join(args, " ")
	if strings.Contains(joined, "shell_environment_policy") || !strings.Contains(joined, "--enable=safe_feature ") ||
		strings.Contains(joined, "apps=true") || strings.Contains(joined, "--disable apps") || !strings.Contains(joined, "features.other=true") {
		t.Fatalf("args = %q", args)
	}
	if i := slices.Index(args, "sandbox_mode=\"x\""); i < 0 || args[i-1] != "-c" || i > slices.Index(args, "features.other=true") {
		t.Fatalf("config args must come first: %q", args)
	}
	if path, ok := codexOverridePath(`'a=b'.c=1`); !ok || !slices.Equal(path, []string{"a=b", "c"}) {
		t.Fatalf("quoted key = %v %t", path, ok)
	}
	if _, ok := codexOverridePath(`not a key=1`); ok {
		t.Fatal("invalid key parsed")
	}
}

func TestCodexManagedProjection(t *testing.T) {
	home := t.TempDir()
	config := filepath.Join(home, "config.toml")
	if err := os.WriteFile(config, []byte("model = \"keep\"\n[mcp_servers.old]\ncommand = \"old\"\n[profiles.work]\nmodel = \"p\"\n[profiles.work.mcp_servers.x]\ncommand = \"x\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	raw := json.RawMessage(`{"mcpServers":{"remote":{"type":"HTTP","url":"http://127.0.0.1:1/mcp","headers":{"Authorization":"Bearer t"},"tools":["a"]},"local":{"command":"bin","args":["-v"],"env":{"N":1.5}}}}`)
	if err := codexProjectMCP(home, raw); err != nil {
		t.Fatal(err)
	}
	first, _ := os.ReadFile(config)
	var parsed map[string]any
	if err := toml.Unmarshal(first, &parsed); err != nil {
		t.Fatal(err)
	}
	servers := parsed["mcp_servers"].(map[string]any)
	remote := servers["remote"].(map[string]any)
	if parsed["model"] != "keep" || servers["old"] != nil || remote["type"] != nil || remote["tools"] != nil || remote["headers"] != nil ||
		remote["http_headers"].(map[string]any)["Authorization"] != "Bearer t" || remote["experimental_use_rmcp_client"] != true {
		t.Fatalf("projected = %s", first)
	}
	if work := parsed["profiles"].(map[string]any)["work"].(map[string]any); work["mcp_servers"] != nil || work["model"] != "p" {
		t.Fatalf("profile = %v", work)
	}
	if info, _ := os.Stat(config); !privateModeMatches(info, 0o600) {
		t.Fatalf("mode = %v", info.Mode())
	}
	if err := codexProjectMCP(home, raw); err != nil {
		t.Fatal(err)
	}
	if again, _ := os.ReadFile(config); string(again) != string(first) {
		t.Fatal("projection is not byte-stable")
	}
	if err := codexProjectMCP(home, json.RawMessage(`{}`)); err != nil {
		t.Fatal(err)
	}
	if cleared, _ := os.ReadFile(config); strings.Contains(string(cleared), "Bearer") || strings.Contains(string(cleared), "remote") {
		t.Fatalf("{} kept servers: %s", cleared)
	}
	before, _ := os.ReadFile(config)
	if err := codexProjectMCP(home, nil); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{`[]`, `{"mcpServers":null}`, `{"mcpServers":{"a.b":{}}}`, `{"mcpServers":{"a":null}}`} {
		if err := codexProjectMCP(home, json.RawMessage(bad)); err == nil {
			t.Fatalf("%s accepted", bad)
		}
	}
	if after, _ := os.ReadFile(config); string(after) != string(before) {
		t.Fatal("absent or rejected config changed the file")
	}
	if err := os.WriteFile(config, []byte("not = = toml"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := codexProjectMCP(home, raw); err == nil || !strings.HasPrefix(err.Error(), "decode Codex configuration: ") {
		t.Fatalf("malformed TOML = %v", err)
	}
	if data, _ := os.ReadFile(config); string(data) != "not = = toml" {
		t.Fatal("malformed config overwritten")
	}
	target := filepath.Join(t.TempDir(), "outside.toml")
	_ = os.WriteFile(target, []byte("x = 1\n"), 0o600)
	_ = os.Remove(config)
	if symlinkOrSkip(t, target, config) {
		if err := codexProjectMCP(home, raw); err == nil {
			t.Fatal("symlinked config accepted")
		}
		if data, _ := os.ReadFile(target); string(data) != "x = 1\n" {
			t.Fatal("symlink target modified")
		}
	}
	if err := codexProjectMCP("", raw); !errors.Is(err, errCodexMissingHome) {
		t.Fatalf("missing home = %v", err)
	}
}

func TestCodexMemoryPolicy(t *testing.T) {
	allowed := []string{
		`{"config":{"features":{"memories":false,"memory_tool":false}}}`,
		`{"config":{"features":{"memories":false,"memory_tool":false},"profile":null}}`,
		`{"config":{"features":{"memories":false,"memory_tool":false},"profiles":{"x":{"features":{"memories":true}}}}}`,
		`{"config":{"features":{"memories":false,"memory_tool":false},"profile":"p","profiles":{"p":{}}}}`,
		`{"config":{"features":{"memories":false,"memory_tool":false},"profile":"p","profiles":{"p":{"features":{"memories":false,"memory_tool":false}}}}}`,
		`{"config":{"features":{"memories":false,"memory_tool":false},"profile":"p","profiles":{"p":{"features":{"memories":false}}}}}`,
	}
	rejected := []string{
		`not json`, `{}`, `{"config":{}}`, `{"config":{"features":{"memories":false}}}`,
		`{"config":{"features":{"memories":true,"memory_tool":false}}}`,
		`{"config":{"features":{"memories":"false","memory_tool":false}}}`,
		`{"config":{"features":{"memories":false,"memory_tool":false},"profile":3}}`,
		`{"config":{"features":{"memories":false,"memory_tool":false},"profile":""}}`,
		`{"config":{"features":{"memories":false,"memory_tool":false},"profile":"p","profiles":{}}}`,
		`{"config":{"features":{"memories":false,"memory_tool":false},"profile":"p","profiles":{"p":{"features":null}}}}`,
		`{"config":{"features":{"memories":false,"memory_tool":false},"profile":"p","profiles":{"p":{"features":{"memory_tool":true}}}}}`,
		`{"config":{"features":{"memories":false,"memory_tool":false},"profile":"p","profiles":{"p":{"features":{"memories":"false"}}}}}`,
	}
	for _, raw := range allowed {
		if !codexMemoryDisabled(json.RawMessage(raw)) {
			t.Fatalf("rejected %s", raw)
		}
	}
	for _, raw := range rejected {
		if codexMemoryDisabled(json.RawMessage(raw)) {
			t.Fatalf("allowed %s", raw)
		}
	}
}

func TestCodexReasoningTitles(t *testing.T) {
	var titles codexReasoningTitles
	if _, ok := titles.feed("r", 0, "**Inspecting"); ok {
		t.Fatal("incomplete title resolved")
	}
	if title, ok := titles.feed("r", 0, " runtime status**\n\nPRIVATE body"); !ok || title != "Inspecting runtime status" {
		t.Fatalf("title = %q", title)
	}
	if _, ok := titles.feed("r", 0, " more"); ok {
		t.Fatal("resolved part emitted again")
	}
	long := strings.Repeat("x", 250)
	for text, want := range map[string]string{
		"Reviewing the request\nDetails":      "Reviewing the request",
		"### **Preparing tests**\nDetails":    "Preparing tests",
		"\ufeff\u00a0Checking\u3000files\r\n": "Checking files",
		"- Planning\u2003steps\r\nmore":       "Planning steps",
		long:                                  long,
		"**\ufeff**":                          "",
	} {
		if got, _ := ReasoningTitle(text, true); got != want {
			t.Fatalf("%q -> %q, want %q", text, got, want)
		}
	}
	if _, ok := ReasoningTitle("no newline yet", false); ok {
		t.Fatal("incomplete line resolved")
	}
}

func codexWriteRollout(t *testing.T, home, dir, name string, lines ...string) string {
	t.Helper()
	path := filepath.Join(home, "sessions", dir, name)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestCodexRolloutScan(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", t.TempDir())
	codexWriteRollout(t, home, "2026/10/29", "named-thread-a.jsonl", `{"type":"session_meta","payload":{"id":"other"}}`,
		`{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":999}}}}`)
	codexWriteRollout(t, home, "2026/10/29", "rollout.jsonl", `{"type":"session_meta","payload":{"id":"thread-a"}}`,
		`{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":30,"cached_input_tokens":10,"output_tokens":7}}}}`)
	real := codexWriteRollout(t, home, "x", "target.jsonl", `{"type":"session_meta","payload":{"id":"thread-b"}}`)
	symlinkOrSkip(t, real, filepath.Join(home, "sessions", "link.jsonl"))
	rollout, ok := codexScanRollout(home, "thread-a", time.Time{}, false)
	if !ok || rollout.usage.receipt() != (TokenCount{Input: 20, CacheRead: 10, Output: 7}) {
		t.Fatalf("rollout = %+v %t", rollout, ok)
	}
	if path := codexFindRollout(home, "thread-b"); path != real {
		t.Fatalf("symlink considered: %s", path)
	}

	start := time.Now().UTC()
	stamp := func(offset time.Duration) string { return start.Add(offset).Format(time.RFC3339Nano) }
	resumed := t.TempDir()
	codexWriteRollout(t, resumed, "a", "r.jsonl", `{"type":"session_meta","payload":{"id":"t"}}`,
		`{"timestamp":"`+stamp(-time.Minute)+`","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":20,"output_tokens":10}}}}`,
		`{"timestamp":"`+stamp(0)+`","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":140,"cached_input_tokens":30,"output_tokens":30}}}}`,
		`{"timestamp":"`+stamp(time.Minute)+`","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"cached_input_tokens":2,"output_tokens":3},"last_token_usage":{"input_tokens":10,"cached_input_tokens":2,"output_tokens":3}}}}`)
	rollout, ok = codexScanRollout(resumed, "t", start, true)
	if !ok || rollout.usage.receipt() != (TokenCount{Input: 38, CacheRead: 12, Output: 23}) || rollout.last.receipt().Input != 8 {
		t.Fatalf("resumed = %+v", rollout)
	}

	oversized := t.TempDir()
	path := codexWriteRollout(t, oversized, "a", "r.jsonl", `{"type":"session_meta","payload":{"id":"t"}}`,
		`{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":5}}}}`)
	file, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	_, _ = file.WriteString(strings.Repeat("x", 33<<20) + "\n")
	_ = file.Close()
	if _, ok := codexScanRollout(oversized, "t", time.Time{}, false); ok {
		t.Fatal("oversized line produced a receipt")
	}
}

// codexPipeTransport wires a transport to in-memory pipes.
func codexPipeTransport(t *testing.T) (*codexTransport, *io.PipeReader, *io.PipeWriter) {
	t.Helper()
	requestsR, requestsW := io.Pipe()
	repliesR, repliesW := io.Pipe()
	transport := newCodexTransport(requestsW)
	go transport.readLoop(repliesR)
	t.Cleanup(func() { _ = repliesW.Close(); _ = requestsR.Close() })
	return transport, requestsR, repliesW
}

func TestCodexTransportCorrelation(t *testing.T) {
	transport, requests, replies := codexPipeTransport(t)
	results := make(chan string, 2)
	for _, method := range []string{"a", "b"} {
		go func() {
			result, _, err := transport.call(context.Background(), method, map[string]any{}, 0, nil)
			if err != nil {
				results <- "error"
				return
			}
			results <- method + "=" + string(result)
		}()
	}
	decoder := json.NewDecoder(requests)
	ids := map[string]int{}
	for range 2 {
		var request struct {
			ID     int    `json:"id"`
			Method string `json:"method"`
		}
		if err := decoder.Decode(&request); err != nil {
			t.Fatal(err)
		}
		ids[request.Method] = request.ID
	}
	_, _ = io.WriteString(replies, `{"id":`+jsonNumber(ids["b"])+`,"result":"B"}`+"\n"+`{"id":`+jsonNumber(ids["a"])+`,"result":"A"}`+"\n"+`{"id":`+jsonNumber(ids["a"])+`,"result":"dup"}`+"\n")
	got := []string{<-results, <-results}
	slices.Sort(got)
	if !slices.Equal(got, []string{`a="A"`, `b="B"`}) || transport.inflight() != 0 {
		t.Fatalf("results = %v pending = %d", got, transport.inflight())
	}
	// Process death wakes a pending request with the process error.
	errs := make(chan error, 1)
	go func() {
		_, _, err := transport.call(context.Background(), "c", nil, 0, nil)
		errs <- err
	}()
	var discard map[string]any
	_ = decoder.Decode(&discard)
	for range 3 {
		go transport.fail(errCodexChildGone)
	}
	if err := <-errs; !errors.Is(err, errCodexChildGone) {
		t.Fatalf("death = %v", err)
	}
}

func jsonNumber(n int) string {
	encoded, _ := json.Marshal(n)
	return string(encoded)
}

func TestCodexTransportBlockedWriteTimesOut(t *testing.T) {
	// Nobody reads requests, so the write blocks.
	transport, _, _ := codexPipeTransport(t)
	started := time.Now()
	_, _, err := transport.call(context.Background(), "initialize", map[string]any{}, 40*time.Millisecond, nil)
	if !codexIsHandshakeTimeout(err) || !errors.Is(err, context.DeadlineExceeded) || err.Error() != "codex app-server handshake timeout: initialize exceeded 40ms" || time.Since(started) > time.Second {
		t.Fatalf("err = %v after %s", err, time.Since(started))
	}
}

func TestCodexLateTurnStartAckFeedsCleanup(t *testing.T) {
	transport, requests, replies := codexPipeTransport(t)
	proc := &codexProcess{transport: transport}
	proc.trackTurnStart("thread-1")
	ctx, cancel := context.WithCancel(context.Background())
	errs := make(chan error, 1)
	go func() {
		_, _, err := transport.call(ctx, "turn/start", map[string]any{}, 0, &codexCallHooks{observe: proc.trackTurnAck})
		errs <- err
	}()
	decoder := json.NewDecoder(requests)
	var request struct {
		ID int `json:"id"`
	}
	if err := decoder.Decode(&request); err != nil {
		t.Fatal(err)
	}
	// The request is delivered; cancel only after the writer has reported it,
	// so the cancellation cannot be mistaken for a blocked write.
	for deadline := time.Now().Add(time.Second); len(transport.writeSlot) != 0; time.Sleep(time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("turn/start write did not finish")
		}
	}
	cancel()
	if err := <-errs; !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	_, _ = io.WriteString(replies, `{"id":`+jsonNumber(request.ID)+`,"result":{"turn":{"id":"turn-late"}}}`+"\n")
	deadline := time.Now().Add(time.Second)
	for proc.trackerSnapshot().turnID != "turn-late" {
		if time.Now().After(deadline) {
			t.Fatal("late ack not recorded")
		}
		time.Sleep(5 * time.Millisecond)
	}
	previous := codexCleanupBudget.set(200 * time.Millisecond)
	defer codexCleanupBudget.set(previous)
	cleanup := make(chan error, 1)
	go func() { cleanup <- proc.cleanupTurn() }()
	var interrupt struct {
		Method string         `json:"method"`
		Params map[string]any `json:"params"`
	}
	if err := decoder.Decode(&interrupt); err != nil || interrupt.Method != "turn/interrupt" || interrupt.Params["turnId"] != "turn-late" {
		t.Fatalf("interrupt = %+v, %v", interrupt, err)
	}
	if err := <-cleanup; err == nil {
		t.Fatal("cleanup without an answer must stay unconfirmed")
	}
}

func TestCodexCleanupTerminatesOnlyCurrentTurnTerminals(t *testing.T) {
	transport, requests, replies := codexPipeTransport(t)
	proc := &codexProcess{transport: transport}
	proc.trackTurnStart("thread-1")
	proc.trackTurnAck(codexReply{result: json.RawMessage(`{"turn":{"id":"turn-2"}}`)})
	proc.trackNotification("item/started", "thread-1", "turn-2", codexItem{ID: "cmd-a", Type: "commandExecution"})
	proc.trackNotification("item/started", "thread-1", "turn-1", codexItem{ID: "cmd-old", Type: "commandExecution"})
	cleanup := make(chan error, 1)
	go func() { cleanup <- proc.cleanupTurn() }()
	decoder := json.NewDecoder(requests)
	var terminated []string
	lists := 0
	for {
		var request struct {
			ID     int            `json:"id"`
			Method string         `json:"method"`
			Params map[string]any `json:"params"`
		}
		if err := decoder.Decode(&request); err != nil {
			t.Fatal(err)
		}
		reply := func(result string) {
			_, _ = io.WriteString(replies, `{"id":`+jsonNumber(request.ID)+`,"result":`+result+`}`+"\n")
		}
		switch request.Method {
		case "turn/interrupt":
			reply(`{}`)
			// An item that started while the interrupt raced still counts.
			proc.trackNotification("item/started", "thread-1", "turn-2", codexItem{ID: "cmd-b", Type: "commandExecution"})
			proc.trackNotification("turn/completed", "thread-1", "turn-2", codexItem{})
		case "thread/backgroundTerminals/list":
			lists++
			switch {
			case len(terminated) >= 2:
				reply(`{"data":[{"itemId":"cmd-old","processId":"p-old"}],"nextCursor":null}`)
				if err := <-cleanup; err != nil || !slices.Equal(terminated, []string{"p-a", "p-b"}) {
					t.Fatalf("cleanup = %v terminated = %v", err, terminated)
				}
				return
			case request.Params["cursor"] == nil:
				reply(`{"data":[{"itemId":"cmd-a","processId":"p-a"},{"itemId":"cmd-old","processId":"p-old"}],"nextCursor":"c1"}`)
			default:
				reply(`{"data":[{"itemId":"cmd-b","processId":"p-b"}],"nextCursor":null}`)
			}
		case "thread/backgroundTerminals/terminate":
			terminated = append(terminated, request.Params["processId"].(string))
			reply(`{}`)
		}
		if lists > 10 {
			t.Fatal("cleanup did not finish")
		}
	}
}

func TestCodexUnsentRequestLeavesNothingPending(t *testing.T) {
	transport, _, _ := codexPipeTransport(t)
	// Another write holds the slot, so a cancelled call cannot start its own.
	transport.writeSlot <- struct{}{}
	defer func() { <-transport.writeSlot }()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	hooks := &codexCallHooks{observe: func(codexReply) {}}
	_, _, err := transport.call(ctx, "turn/start", map[string]any{}, 0, hooks)
	if !codexUnsent(err) || !errors.Is(err, context.Canceled) || transport.inflight() != 0 {
		t.Fatalf("err = %v unsent = %v pending = %d", err, codexUnsent(err), transport.inflight())
	}
}

func TestCodexToolOutputTokenLimitFollowsContextWindow(t *testing.T) {
	for window, want := range map[int]int{0: 12000, -1: 12000, 32768: 4000, 64896: 4056, 131072: 8192, 192000: 12000, 1048576: 12000} {
		if got := toolOutputTokenLimit(window); got != want {
			t.Fatalf("window %d: limit %d, want %d", window, got, want)
		}
	}
	spec := RunSpec{Dir: "/work", Model: "local", ContextWindow: 64896}
	small := codexBindingFingerprint("/home", "", spec)
	spec.ContextWindow = 272000
	if large := codexBindingFingerprint("/home", "", spec); large == small {
		t.Fatal("a different tool output limit must rebind the thread")
	}
	spec.ContextWindow = 0
	if unknown := codexBindingFingerprint("/home", "", spec); unknown != codexBindingFingerprint("/home", "", RunSpec{Dir: "/work", Model: "local", ContextWindow: 400000}) {
		t.Fatal("windows that keep the global limit must keep the thread")
	}
}
