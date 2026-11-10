package native

import (
	"context"
	"reflect"
	"strings"
	"testing"
)

func TestInvocationCopiesLeadingArguments(t *testing.T) {
	leading := []string{"launch", "fixture-profile"}
	invocation := NewInvocation("/bin/fixture", leading)
	leading[0] = "mutated"
	returned := invocation.Args("first")
	returned[1] = "mutated"
	if got := invocation.Args("input"); !reflect.DeepEqual(got, []string{"launch", "fixture-profile", "input"}) {
		t.Fatalf("Args = %q", got)
	}
	if invocation.Env != nil {
		t.Fatal("new invocation must inherit the host environment")
	}
}

func TestInvocationEnvironmentIsSortedAndLiteral(t *testing.T) {
	env := map[string]string{"TOKEN": "literal-value", "EMPTY": ""}
	invocation := NewInvocation("/bin/fixture", nil).WithEnvironment(env)
	env["TOKEN"] = "mutated"
	env["LATE"] = "x"
	if !reflect.DeepEqual(invocation.Env, []string{"EMPTY=", "TOKEN=literal-value"}) {
		t.Fatalf("Env = %q", invocation.Env)
	}
	for _, empty := range []map[string]string{{}, nil} {
		got := NewInvocation("/bin/fixture", nil).WithEnvironment(empty)
		if got.Env == nil || len(got.Env) != 0 {
			t.Fatalf("empty map Env = %#v", got.Env)
		}
		if cmd := ownedCommand(context.Background(), got); cmd.Env == nil || len(cmd.Env) != 0 {
			t.Fatalf("child Env = %#v, want non-nil empty", cmd.Env)
		}
	}
}

func TestOpenSupportsExactlyThreeKinds(t *testing.T) {
	for _, kind := range []string{"claude", "codex", "pi"} {
		if !Supports(kind) {
			t.Fatalf("Supports(%q) = false", kind)
		}
		runtime, err := Open(kind, Profile{})
		if err != nil || runtime == nil {
			t.Fatalf("Open(%q) = %v, %v", kind, runtime, err)
		}
	}
	for _, kind := range []string{"hermes", "opencode", "unrecognized", "Claude"} {
		if Supports(kind) {
			t.Fatalf("Supports(%q) = true", kind)
		}
		_, err := Open(kind, Profile{})
		if err == nil || !strings.Contains(err.Error(), kind) || !strings.Contains(err.Error(), "unsupported") {
			t.Fatalf("Open(%q) error = %v", kind, err)
		}
	}
}

func TestChildEnvironmentUsesOnlyProfileEnv(t *testing.T) {
	for _, key := range []string{"LINGER_GATEWAY_TOKEN", "MIRROR_AGENT_SERVICE_TOKEN", "LINGER_SECRET_SEED", "UNRELATED_AMBIENT_SECRET"} {
		t.Setenv(key, "daemon-secret")
	}
	if got := childEnvironment(map[string]string{"PATH": "/usr/bin"}); !reflect.DeepEqual(got, []string{"PATH=/usr/bin"}) {
		t.Fatalf("environment = %q", got)
	}
	got := childEnvironment(map[string]string{
		"claudecode": "1", "CLAUDE_CODE_ENTRYPOINT": "cli", "CLAUDE_CODE_EXECPATH": "x", "Claude_Code_Session_ID": "s",
		"CLAUDE_CODE_SSE_PORT": "1", "CLAUDECODE_ANYTHING": "y", "CLAUDE_CONFIG_DIR": "/keep",
	})
	if !reflect.DeepEqual(got, []string{"CLAUDE_CONFIG_DIR=/keep"}) {
		t.Fatalf("filtered environment = %q", got)
	}
}

// No MCP set is the empty Daemon-owned set, never the CLI's own servers.
func TestMCPNamespace(t *testing.T) {
	for _, raw := range []string{"", "  ", "null", " null\n"} {
		if got := string(mcpNamespace([]byte(raw))); got != `{"mcpServers":{}}` {
			t.Fatalf("%q = %s", raw, got)
		}
	}
	if got := string(mcpNamespace([]byte(`{"mcpServers":{"a":{}}}`))); got != `{"mcpServers":{"a":{}}}` {
		t.Fatalf("set = %s", got)
	}
}
