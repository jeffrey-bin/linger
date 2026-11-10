package provider

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestDiscoverUsesConfiguredExecutableAndReportsAllRuntimes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX script")
	}
	root := t.TempDir()
	codex := filepath.Join(root, "codex")
	script := `#!/bin/sh
case "$1 $2" in
  "--version ") echo "codex-cli 0.100.0" ;;
  "app-server --disable")
    [ "$3 $4 $5" = "plugins --listen stdio://" ] || exit 2
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
	result, err := Discover(context.Background(), DiscoveryOptions{ConfiguredPaths: map[string]string{"codex": codex}, Environment: map[string]string{"PATH": root, "HOME": t.TempDir()}})
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := filepath.EvalSymlinks(codex)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Diagnostics) != 3 || result.Diagnostics[0].Status != "ready" || result.Installations["codex"].ExecutablePath != canonical {
		t.Fatalf("result=%+v", result)
	}
}

func TestDiscoverFindsCLIsInsideMacApplicationBundles(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("application bundles are a macOS install location")
	}
	home := t.TempDir()
	options := DiscoveryOptions{Environment: map[string]string{"HOME": home, "PATH": filepath.Join(home, "empty")}}
	for kind, bundle := range map[string]string{"codex": "Codex.app", "claude": "Claude.app"} {
		if _, err := canonicalExecutable(filepath.Join("/Applications", bundle, "Contents", "Resources", kind)); err == nil {
			t.Skipf("this machine has /Applications/%s installed", bundle)
		}
		if _, err := resolveExecutableEntry(context.Background(), kind, kind, options); err == nil {
			t.Fatalf("%s found without an installed bundle", kind)
		}
		executable := filepath.Join(home, "Applications", bundle, "Contents", "Resources", kind)
		if err := os.MkdirAll(filepath.Dir(executable), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(executable, []byte("#!/bin/sh\n"), 0o700); err != nil {
			t.Fatal(err)
		}
		if entry, err := resolveExecutableEntry(context.Background(), kind, kind, options); err != nil || entry != executable {
			t.Fatalf("%s entry = %q, %v; want %q", kind, entry, err, executable)
		}
	}
}

func TestDiscoverPublishesRuntimeModelCatalog(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX script")
	}
	root := t.TempDir()
	codex := filepath.Join(root, "codex")
	script := `#!/bin/sh
case "$1 $2" in
  "--version ") echo "codex-cli 0.144.1" ;;
  "app-server --disable")
    [ "$3 $4 $5 $6 $7" = "plugins --disable goals --listen stdio://" ] || exit 2
    read line
    echo '{"jsonrpc":"2.0","id":1,"result":{"userAgent":"codex-test"}}'
    if read initialized && read account; then
  case "$account" in
    *'"method":"model/list"'*)
      echo '{"models":[{"slug":"gpt-runtime","context_window":272000}]}' > "$CODEX_HOME/models_cache.json"
      echo '{"id":2,"result":{"data":[{"id":"gpt-runtime","model":"gpt-runtime","displayName":"GPT Runtime","isDefault":true,"defaultReasoningEffort":"high","supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"high"},{"reasoningEffort":"future"}]}]}}'
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
	result, err := Discover(context.Background(), DiscoveryOptions{
		ConfiguredPaths: map[string]string{"codex": codex},
		Environment:     map[string]string{"PATH": root, "HOME": root},
		Timeout:         5 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	diagnostic := result.Diagnostics[0]
	if len(diagnostic.Models) != 1 || diagnostic.Models[0].ID != "gpt-runtime" ||
		diagnostic.Models[0].DefaultReasoningEffort != "high" ||
		len(diagnostic.Models[0].AllowedReasoningEffort) != 2 ||
		!diagnostic.Models[0].IsDefault || diagnostic.Models[0].Link != linkSubscription ||
		diagnostic.Models[0].ContextWindow != 272000 {
		t.Fatalf("Codex diagnostic = %+v", diagnostic)
	}
}

// The CLI fixture resolves its configured model source and serves it through
// model/list; discovery must leave configuration interpretation to the CLI.
const fakeCodexCatalogPath = `catalog="${CODEX_HOME:-$HOME/.codex}/catalog.json"
if [ -f "$CODEX_HOME/config.toml" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      'model_catalog_json = '*)
        catalog=${line#*= }
        catalog=${catalog#\"}; catalog=${catalog%\"}
        catalog=${catalog#\'}; catalog=${catalog%\'} ;;
    esac
  done < "$CODEX_HOME/config.toml"
  case "$catalog" in
    /*) ;;
    '~/'*) catalog="$HOME/${catalog#\~/}" ;;
    *) catalog="$CODEX_HOME/$catalog" ;;
  esac
fi
`

const fakeCodexModelCatalog = fakeCodexCatalogPath + `read initialize
echo '{"id":1,"result":{"userAgent":"test"}}'
read initialized
read request
case "$request" in
 *'"method":"model/list"'*)
  if [ ! -f "$catalog" ]; then echo '{"id":2,"error":{"code":-32000,"message":"catalog unavailable"}}'; exit 0; fi
  printf '{"id":2,"result":'
  while IFS= read -r line || [ -n "$line" ]; do printf '%s' "$line"; done < "$catalog"
  echo '}' ;;
 *) echo '{"id":2,"result":{"account":null,"requiresOpenaiAuth":false}}' ;;
esac
`

func TestDiscoverRejectsInvalidConfiguredCatalogAndRecovers(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX script")
	}
	root := t.TempDir()
	t.Setenv("CODEX_HOME", root)
	codex := filepath.Join(root, "codex")
	script := `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'codex-cli 0.144.1'; exit 0; fi
` + fakeCodexModelCatalog
	if err := os.WriteFile(codex, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "config.toml"), []byte("model_catalog_json = \"catalog.json\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	options := DiscoveryOptions{ConfiguredPaths: map[string]string{"codex": codex}, Environment: map[string]string{"PATH": root, "HOME": root, "CODEX_HOME": root}, Timeout: 10 * time.Second}
	result, err := Discover(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	diagnostic := result.Diagnostics[0]
	if diagnostic.Status != "error" || diagnostic.Error == nil || diagnostic.Error.Code != "RUNTIME_DIAGNOSTIC_FAILED" || len(diagnostic.Models) != 0 {
		t.Fatalf("missing Provider catalog allowed creation: %+v", diagnostic)
	}
	refreshed, err := RefreshRuntimeAuthentication(context.Background(), result, options)
	if err != nil || refreshed.Diagnostics[0].Status != "error" || len(refreshed.Diagnostics[0].Models) != 0 {
		t.Fatalf("authentication refresh reopened invalid catalog: result=%+v err=%v", refreshed, err)
	}
	if err := os.WriteFile(filepath.Join(root, "catalog.json"), []byte(`{"data":[{"id":"deepseek-v4.1-flash","supportedReasoningEfforts":[{"reasoningEffort":"max"}],"defaultReasoningEffort":"max"}],"nextCursor":null}`), 0o600); err != nil {
		t.Fatal(err)
	}
	refreshed, err = refreshRuntimeAuthentication(context.Background(), result, options, true)
	if err != nil || refreshed.Diagnostics[0].Status != "error" || len(refreshed.Diagnostics[0].Models) != 0 {
		t.Fatalf("authentication retry reopened catalog before full discovery: result=%+v err=%v", refreshed, err)
	}
	result, err = Discover(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	diagnostic = result.Diagnostics[0]
	if diagnostic.Status != "ready" || diagnostic.Error != nil || len(diagnostic.Models) != 1 || diagnostic.Models[0].ID != "deepseek-v4.1-flash" || len(diagnostic.Models[0].AllowedReasoningEffort) != 1 || diagnostic.Models[0].AllowedReasoningEffort[0] != "max" {
		t.Fatalf("repaired Provider catalog did not recover exact allowed model: %+v", diagnostic)
	}
}

func TestDiscoverUsesCodexRuntimeEnvironmentForModelCatalog(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX script")
	}
	ambient := t.TempDir()
	t.Setenv("CODEX_HOME", ambient)
	t.Setenv("HOME", ambient)
	if err := os.WriteFile(filepath.Join(ambient, "config.toml"), []byte("model_catalog_json = \"catalog.json\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ambient, "catalog.json"), []byte(`{"data":[{"id":"grok-4.7"}],"nextCursor":null}`), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"CODEX_HOME", "HOME", "tilde"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			home := root
			environment := map[string]string{"PATH": root, "HOME": root, "EXPECTED_HOME": root, "AMBIENT_CODEX_HOME": ambient}
			if mode == "HOME" {
				home = filepath.Join(root, ".codex")
			} else {
				environment["CODEX_HOME"] = home
			}
			environment["EXPECTED_CODEX_HOME"] = environment["CODEX_HOME"]
			if err := os.MkdirAll(home, 0o700); err != nil {
				t.Fatal(err)
			}
			catalogReference := "catalog.json"
			if mode == "tilde" {
				catalogReference = "~/catalog.json"
			}
			if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte("model_catalog_json = \""+catalogReference+"\"\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			catalogPath := filepath.Join(home, "catalog.json")
			if err := os.WriteFile(catalogPath, []byte(`{"data":[{"id":"deepseek-v4.1-flash","supportedReasoningEfforts":[{"reasoningEffort":"max"}],"defaultReasoningEffort":"max"}],"nextCursor":null}`), 0o600); err != nil {
				t.Fatal(err)
			}
			codex := filepath.Join(root, "codex")
			script := `#!/bin/sh
[ "$HOME" = "$EXPECTED_HOME" ] && [ "$CODEX_HOME" != "$AMBIENT_CODEX_HOME" ] || exit 2
if [ "$1" = "--version" ]; then echo 'codex-cli 0.144.1'; exit 0; fi
[ "$CODEX_HOME" != "$EXPECTED_CODEX_HOME" ] || exit 2
` + fakeCodexModelCatalog
			if err := os.WriteFile(codex, []byte(script), 0o700); err != nil {
				t.Fatal(err)
			}
			options := DiscoveryOptions{ConfiguredPaths: map[string]string{"codex": codex}, Environment: environment, Timeout: 10 * time.Second}
			result, err := Discover(context.Background(), options)
			if err != nil {
				t.Fatal(err)
			}
			diagnostic := result.Diagnostics[0]
			if diagnostic.Status != "ready" || len(diagnostic.Models) != 1 || diagnostic.Models[0].ID != "deepseek-v4.1-flash" {
				t.Fatalf("Runtime catalog was replaced by the ambient Provider catalog: %+v", diagnostic)
			}
			if err := os.Remove(catalogPath); err != nil {
				t.Fatal(err)
			}
			result, err = Discover(context.Background(), options)
			if err != nil {
				t.Fatal(err)
			}
			diagnostic = result.Diagnostics[0]
			if diagnostic.Status != "error" || diagnostic.Error == nil || diagnostic.Error.Code != "RUNTIME_DIAGNOSTIC_FAILED" || len(diagnostic.Models) != 0 {
				t.Fatalf("Missing Runtime catalog reopened the ambient Provider catalog: %+v", diagnostic)
			}
		})
	}
}

func TestDiscoverRejectsUnknownCodexVersion(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX script")
	}
	for _, versionProbe := range []string{"exit 1", "echo unknown-version"} {
		t.Run(versionProbe, func(t *testing.T) {
			codex := filepath.Join(t.TempDir(), "codex")
			if err := os.WriteFile(codex, []byte("#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then "+versionProbe+"; exit; fi\ntouch \"$0.started\"\nexit 1\n"), 0o700); err != nil {
				t.Fatal(err)
			}
			diagnostic := diagnose(t.Context(), "codex", "codex", "app-server", DiscoveryOptions{ConfiguredPaths: map[string]string{"codex": codex}}, time.Second)
			if diagnostic.Status != "error" || diagnostic.Error == nil || diagnostic.Error.Code != "RUNTIME_DIAGNOSTIC_FAILED" {
				t.Fatalf("unknown version must fail admission: %+v", diagnostic)
			}
			if len(installationsFromDiagnostics([]RuntimeDiagnostic{diagnostic})) != 0 {
				t.Fatal("unknown version entered executable installations")
			}
			if _, err := os.Stat(codex + ".started"); !os.IsNotExist(err) {
				t.Fatalf("app-server started before version verification: %v", err)
			}
		})
	}
}

func TestDiscoverRejectsBelowMinimumRuntime(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX script")
	}
	root := t.TempDir()
	codex := filepath.Join(root, "codex")
	if err := os.WriteFile(codex, []byte("#!/bin/sh\necho codex-cli 0.99.0\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	result, err := Discover(context.Background(), DiscoveryOptions{ConfiguredPaths: map[string]string{"codex": codex}, Environment: map[string]string{"PATH": root, "HOME": root}})
	if err != nil {
		t.Fatal(err)
	}
	if result.Diagnostics[0].Status != "incompatible" {
		t.Fatalf("diagnostic=%+v", result.Diagnostics[0])
	}
}

func TestDiscoverReportsCodexAuthenticationRequiredAfterProtocolHandshake(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX script")
	}
	root := t.TempDir()
	codex := filepath.Join(root, "codex")
	script := `#!/bin/sh
case "$1 $2" in
  "--version ") echo "codex-cli 0.100.0" ;;
  "app-server --disable")
    [ "$3 $4 $5" = "plugins --listen stdio://" ] || exit 2
    read line
    echo '{"jsonrpc":"2.0","id":1,"result":{"userAgent":"codex-test"}}'
    if read initialized && read account; then
  case "$account" in
    *'"method":"model/list"'*)
      echo '{"id":2,"result":{"data":[{"id":"fixture-model","model":"fixture-model","displayName":"Fixture model","isDefault":true,"supportedReasoningEfforts":[]}]}}'
      exit 0 ;;
  esac
      echo '{"id":2,"result":{"account":null,"requiresOpenaiAuth":true}}'
    fi
    ;;
  *) exit 2 ;;
esac
`
	if err := os.WriteFile(codex, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	result, err := Discover(context.Background(), DiscoveryOptions{
		ConfiguredPaths: map[string]string{"codex": codex},
		Environment:     map[string]string{"PATH": root, "HOME": root},
		Timeout:         5 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	diagnostic := result.Diagnostics[0]
	if diagnostic.Status != "authentication_required" || diagnostic.Error == nil || diagnostic.Error.Code != "RUNTIME_AUTHENTICATION_REQUIRED" {
		t.Fatalf("Codex diagnostic = %+v", diagnostic)
	}
	if _, ok := result.Installations["codex"]; !ok {
		t.Fatal("authentication-required Codex installation was discarded")
	}
}

func TestDiscoverReportsClaudeAuthenticationRequiredWithoutPromptProbe(t *testing.T) {
	isolateClaudeKeychain(t)
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX script")
	}
	root := t.TempDir()
	claude := filepath.Join(root, "claude")
	promptMarker := filepath.Join(root, "prompt-called")
	script := `#!/bin/sh
if [ "$1" = "--version" ]; then echo "claude 2.1.282"; exit 0; fi
if [ "$1 $2 $3" = "auth status --json" ]; then echo '{"loggedIn":false}'; exit 1; fi
if [ "$1" = "--help" ]; then echo "--effort <level> (low, medium, high)"; exit 0; fi
echo called > "$PROMPT_MARKER"
exit 2
`
	if err := os.WriteFile(claude, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	result, err := Discover(context.Background(), DiscoveryOptions{
		ConfiguredPaths: map[string]string{"claude": claude},
		Environment: map[string]string{
			"PATH": root, "HOME": root, "PROMPT_MARKER": promptMarker,
		},
		Timeout: 3 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	diagnostic := result.Diagnostics[1]
	if diagnostic.Status != "authentication_required" || diagnostic.Error == nil || diagnostic.Error.Code != "RUNTIME_AUTHENTICATION_REQUIRED" {
		t.Fatalf("Claude diagnostic = %+v", diagnostic)
	}
	if len(diagnostic.Models) != 0 {
		t.Fatalf("logged-out Claude must not offer unverified models, got %+v", diagnostic.Models)
	}
	if _, err := os.Stat(promptMarker); !os.IsNotExist(err) {
		t.Fatal("Claude prompt protocol probe ran before authentication")
	}
}

func TestDiscoverProbesClaudeStreamProtocolAfterAuthentication(t *testing.T) {
	isolateClaudeKeychain(t)
	if runtime.GOOS == "windows" {
		t.Skip("fixture uses a POSIX script")
	}
	root := t.TempDir()
	claude := filepath.Join(root, "claude")
	promptMarker := filepath.Join(root, "prompt-called")
	script := `#!/bin/sh
if [ "$1" = "--version" ]; then echo "claude 2.1.282"; exit 0; fi
if [ "$1 $2 $3" = "auth status --json" ]; then echo '{"loggedIn":true}'; exit 0; fi
if [ "$1 $2" = "-p --input-format" ]; then
  IFS= read -r request
  printf '%s\n' '{"type":"control_response","response":{"subtype":"success","request_id":"linger-catalog","response":{"models":[{"value":"claude-fixture","displayName":"Claude fixture"}]}}}'
  if IFS= read -r unexpected; then exit 4; fi
  exit 0
fi
[ "$1 $2" = "-p --output-format" ] || exit 2
IFS= read -r request
[ "$request" = '{"type":"control_request","request_id":"linger-computer-doctor","request":{"subtype":"initialize"}}' ] || exit 3
echo called > "$PROMPT_MARKER"
printf '%s' '{"type":"control_response","response":'
printf '%s\n' '{"subtype":"success","request_id":"linger-computer-doctor"}}'
if IFS= read -r unexpected; then exit 4; fi
exit 0
`
	if err := os.WriteFile(claude, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	result, err := Discover(context.Background(), DiscoveryOptions{
		ConfiguredPaths: map[string]string{"claude": claude},
		Environment: map[string]string{
			"PATH": root, "HOME": root, "PROMPT_MARKER": promptMarker,
		},
		Timeout: 5 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	if diagnostic := result.Diagnostics[1]; diagnostic.Status != "ready" {
		t.Fatalf("Claude diagnostic = %+v", diagnostic)
	}
	if _, err := os.Stat(promptMarker); err != nil {
		t.Fatal("Claude stream protocol probe did not run")
	}
}
