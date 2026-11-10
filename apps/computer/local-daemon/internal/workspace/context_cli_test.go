package workspace

import (
	"slices"
	"strings"
	"testing"

	"github.com/pelletier/go-toml/v2"
)

func TestCodexContextCLIArgsExposePersistentProfileWithoutBusinessCredential(t *testing.T) {
	env := map[string]string{"TEAMHUB_CONFIG": "/private/runtime/teamhub/config.json", "TEAMHUB_PROFILE": "runtime", "PATH": "/trusted/cli:/bin", "UPSTREAM_TOKEN": "private-service-token", "TEAMHUB_TOKEN": "business"}
	args := CodexContextCLIArgs(env)
	want := []string{
		"-c", `shell_environment_policy.set.TEAMHUB_CONFIG="/private/runtime/teamhub/config.json"`,
		"-c", `shell_environment_policy.set.TEAMHUB_PROFILE="runtime"`,
		"-c", `shell_environment_policy.set.PATH="/trusted/cli:/bin"`,
	}
	if !slices.Equal(args, want) {
		t.Fatalf("args = %q, want %q", args, want)
	}
	if strings.Contains(strings.Join(args, " "), "private-service-token") || strings.Contains(strings.Join(args, " "), "business") {
		t.Fatalf("credential leaked into argv: %q", args)
	}
}

func TestCodexContextCLIArgsOmitWithoutProfile(t *testing.T) {
	for _, env := range []map[string]string{nil, {"PATH": "/bin", "TEAMHUB_PROFILE": "runtime"}} {
		if args := CodexContextCLIArgs(env); args != nil {
			t.Fatalf("args = %q, want none", args)
		}
	}
}

func TestCodexContextCLIArgsEscapeSpecialCharacters(t *testing.T) {
	value := "/p ath/\"quoted\"=a\\b\nline\t'single' é"
	args := CodexContextCLIArgs(map[string]string{"TEAMHUB_CONFIG": value})
	if len(args) != 2 || strings.ContainsAny(args[1], "\n\t") {
		t.Fatalf("argv must be a single line: %q", args)
	}
	// Codex parses the part after the first `=` as a TOML value.
	_, literal, _ := strings.Cut(args[1], "=")
	var parsed struct {
		V string `toml:"v"`
	}
	if err := toml.Unmarshal([]byte("v = "+literal), &parsed); err != nil || parsed.V != value {
		t.Fatalf("round trip = %q, %v, want %q", parsed.V, err, value)
	}
}
