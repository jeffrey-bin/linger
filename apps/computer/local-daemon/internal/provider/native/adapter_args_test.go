package native

import (
	"bytes"
	"log/slog"
	"reflect"
	"strings"
	"testing"
)

func TestFilterAdapterArgs(t *testing.T) {
	reserved := map[string]flagArity{"--model": flagTakesValue, "--verbose": flagStandalone, "--resume": flagOptionalValue}
	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, nil))
	got := filterAdapterArgs(logger,
		reserved,
		[]string{"--model", "secret-model", "--keep='quoted value'", `"positional"`, "--verbose", "next", "--model"},
		[]string{"--resume", "--flag", "--resume", "session-id", `--model="inline"`, "--resume=x", "tail"},
	)
	want := []string{"--keep=quoted value", "positional", "next", "--flag", "tail"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("filtered = %q", got)
	}
	if strings.Contains(logs.String(), "secret-model") || strings.Contains(logs.String(), "session-id") {
		t.Fatalf("log leaked a value: %s", logs.String())
	}
	if strings.Count(logs.String(), "runtime option is adapter-owned") != 7 {
		t.Fatalf("logs = %s", logs.String())
	}
}
