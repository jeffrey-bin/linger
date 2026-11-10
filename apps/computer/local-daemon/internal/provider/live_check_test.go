package provider

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestDiscoverLiveChecksOnlySelectedReadyRuntime(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX script")
	}
	for _, test := range []struct {
		name, exec string
		passed     bool
		reply      string
		message    string
	}{
		{name: "reply", exec: `echo OK`, passed: true, reply: "OK"},
		{name: "failure", exec: `echo "starting" >&2; echo "401 Unauthorized" >&2; exit 1`, message: "401 Unauthorized"},
		{name: "empty", exec: `exit 0`, message: "Runtime exited without a reply"},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			codex := filepath.Join(root, "codex")
			script := `#!/bin/sh
case "$1 $2" in
  "--version ") echo "codex-cli 0.100.0" ;;
  "exec --skip-git-repo-check")
    [ "$8" = "Reply with exactly: OK" ] || exit 2
    ` + test.exec + ` ;;
  "app-server --disable")
    read line
    echo '{"jsonrpc":"2.0","id":1,"result":{"userAgent":"codex-test"}}'
    if read initialized && read account; then
  case "$account" in
    *'"method":"model/list"'*)
      echo '{"id":2,"result":{"data":[{"id":"fixture-model","model":"fixture-model","displayName":"Fixture model","isDefault":true,"supportedReasoningEfforts":[]}]}}'
      exit 0 ;;
  esac
      echo '{"id":2,"result":{"account":{"type":"chatgpt"},"requiresOpenaiAuth":true}}'
    fi
    ;;
  *) exit 2 ;;
esac
`
			if err := os.WriteFile(codex, []byte(script), 0o700); err != nil {
				t.Fatal(err)
			}
			result, checks := DiscoverLive(context.Background(), DiscoveryOptions{
				ConfiguredPaths: map[string]string{"codex": codex},
				Environment:     map[string]string{"PATH": root, "HOME": root},
				Runtimes:        []string{"codex"},
			}, 10*time.Second)
			if len(result.Diagnostics) != 1 || result.Diagnostics[0].Type != "codex" || result.Diagnostics[0].Status != "ready" {
				t.Fatalf("diagnostics = %+v", result.Diagnostics)
			}
			check, ok := checks["codex"]
			if !ok || check.Passed != test.passed || check.Reply != test.reply || check.Message != test.message {
				t.Fatalf("live check = %+v", check)
			}
		})
	}
}
