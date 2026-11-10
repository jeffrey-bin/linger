package provider

import (
	"encoding/json"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestDiscoverUsesInteractiveTerminalPath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX terminal fixture")
	}
	isolateClaudeKeychain(t)
	root := t.TempDir()
	locations := map[string]string{
		"pi":     filepath.Join(root, ".local/share/mise/installs/npm-earendil-works-pi-coding-agent/latest/node_modules/.bin"),
		"codex":  filepath.Join(root, ".local/bin"),
		"claude": filepath.Join(root, ".local/share/mise/installs/node/22.22.3/bin"),
	}
	versions := map[string]string{"codex": "codex-cli 0.144.1", "claude": "2.1.282", "pi": "1.2.0"}
	for name, directory := range locations {
		if err := os.MkdirAll(directory, 0700); err != nil {
			t.Fatal(err)
		}
		script := "#!/usr/bin/env fixture-node\nif [ \"$1\" = --version ]; then echo '" + versions[name] + "'; exit 0; fi\n"
		if name == "codex" {
			script += `
read initialize
echo '{"id":1,"result":{"userAgent":"fixture"}}'
read initialized
read request
case "$request" in
 *'"method":"model/list"'*) echo '{"id":2,"result":{"data":[{"id":"terminal-model"}],"nextCursor":null}}' ;;
 *) echo '{"id":2,"result":{"account":null,"requiresOpenaiAuth":false}}' ;;
esac
`
		}
		if err := os.WriteFile(filepath.Join(directory, name), []byte(script), 0700); err != nil {
			t.Fatal(err)
		}
	}
	nodeDir := locations["claude"]
	if err := os.WriteFile(filepath.Join(nodeDir, "fixture-node"), []byte("#!/bin/sh\nexec /bin/sh \"$@\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	shell := filepath.Join(root, "terminal-shell")
	if err := os.WriteFile(shell, []byte("#!/bin/sh\n[ \"$1\" = '-lic' ] || exit 2\nprintf 'mise startup notice\\n'\nexport PATH=\"$TERMINAL_PATH\"\nexec /bin/sh -c \"$2\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	original := map[string]string{"HOME": root, "SHELL": shell, "PATH": "/usr/bin:/bin", "TERMINAL_PATH": strings.Join([]string{locations["pi"], locations["codex"], nodeDir, "/usr/bin", "/bin"}, string(os.PathListSeparator))}
	result, err := Discover(t.Context(), DiscoveryOptions{Environment: original})
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"codex", "claude", "pi"} {
		var entry string
		var diagnostic RuntimeDiagnostic
		for _, value := range result.Diagnostics {
			if value.Type == name {
				diagnostic = value
				entry = diagnostic.EntryPath
			}
		}
		if entry != filepath.Join(locations[name], name) || diagnostic.Version == "" {
			t.Fatalf("%s was not discovered and version-probed: %+v", name, diagnostic)
		}
		environment := maps.Clone(original)
		environment["PATH"] = diagnostic.ExecutionPath
		command := exec.Command(entry, "--version")
		command.Env = environmentList(environment)
		if output, err := command.Output(); err != nil || strings.TrimSpace(string(output)) != versions[name] {
			t.Fatalf("%s interpreter PATH: output=%q err=%v", name, output, err)
		}
	}
	if result.Diagnostics[0].Status != "ready" {
		t.Fatalf("Codex probe lost terminal PATH: %+v", result.Diagnostics[0])
	}
	refreshed, err := RefreshRuntimeAuthentication(t.Context(), result, DiscoveryOptions{Environment: original})
	if err != nil || refreshed.Diagnostics[0].Status != "ready" {
		t.Fatalf("auth refresh lost terminal PATH: %+v %v", refreshed, err)
	}
	wire, err := DiagnosticsJSON(result.Diagnostics)
	if err != nil || strings.Contains(string(wire), root) {
		t.Fatalf("private paths entered diagnostic wire: %s %v", wire, err)
	}
	var decoded []RuntimeDiagnostic
	if err := json.Unmarshal(wire, &decoded); err != nil {
		t.Fatal(err)
	}
	if original["PATH"] != "/usr/bin:/bin" {
		t.Fatal("mutated caller environment")
	}
}

func TestTerminalEnvironmentKeepsInheritedPathOnShellFailure(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX terminal fixture")
	}
	root := t.TempDir()
	shell := filepath.Join(root, "shell")
	for _, script := range []string{"#!/bin/sh\nexit 1\n", "#!/bin/sh\nprintf 'unframed startup output\\n'\n"} {
		if err := os.WriteFile(shell, []byte(script), 0700); err != nil {
			t.Fatal(err)
		}
		environment := terminalEnvironment(t.Context(), map[string]string{"HOME": root, "SHELL": shell, "PATH": "/usr/bin:/bin"})
		userFirst := filepath.Join(root, ".claude/local") + ":/usr/bin:/bin:"
		if !strings.Contains(environment["PATH"], userFirst) || !strings.HasPrefix(environment["PATH"], filepath.Join(root, ".local/bin")+":") {
			t.Fatalf("PATH=%q", environment["PATH"])
		}
	}
}

func TestTerminalEnvironmentReadsBashInteractiveStartup(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux bash startup semantics")
	}
	shell, err := exec.LookPath("bash")
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, ".bash_profile"), []byte("printf 'login startup notice\\n'\n. \"$HOME/.bashrc\"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".bashrc"), []byte("case $- in *i*) export PATH=\"$TERMINAL_PATH\";; esac\n"), 0600); err != nil {
		t.Fatal(err)
	}
	terminalPath := filepath.Join(root, "mise/bin") + ":/usr/bin:/bin"
	environment := terminalEnvironment(t.Context(), map[string]string{"HOME": root, "PATH": "/usr/bin:/bin", "SHELL": shell, "TERMINAL_PATH": terminalPath})
	if !strings.HasPrefix(environment["PATH"], terminalPath) {
		t.Fatalf("interactive bash startup was not captured: %q", environment["PATH"])
	}
}

func TestTerminalEnvironmentAppendsCommonRuntimeDirectories(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX install directories")
	}
	root := t.TempDir()
	// A GUI launch has neither a login shell nor the Homebrew or npm directories.
	environment := terminalEnvironment(t.Context(), map[string]string{"HOME": root, "PATH": "/usr/bin:/bin:/usr/local/bin"})
	// Without a terminal PATH the user's own directories precede the inherited
	// /usr/local/bin, which can hold an older global install.
	want := strings.Join([]string{filepath.Join(root, ".local/bin"), filepath.Join(root, ".npm-global/bin"),
		filepath.Join(root, ".volta/bin"), filepath.Join(root, ".bun/bin"), filepath.Join(root, ".claude/local"),
		"/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew/bin"}, ":")
	if environment["PATH"] != want {
		t.Fatalf("PATH=%q, want %q", environment["PATH"], want)
	}
	claude := filepath.Join(root, ".npm-global/bin/linger-runtime-fixture")
	if err := os.MkdirAll(filepath.Dir(claude), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(claude, []byte("#!/bin/sh\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if path, err := resolveExecutableEntry(t.Context(), "fixture", "linger-runtime-fixture", DiscoveryOptions{Environment: environment}); err != nil || path != claude {
		t.Fatalf("resolved %q, %v; want %q", path, err, claude)
	}
}
