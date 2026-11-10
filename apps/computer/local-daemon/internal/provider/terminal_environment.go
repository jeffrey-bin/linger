package provider

import (
	"context"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/process"
)

// terminalEnvironment resolves PATH as the user's terminal would, then appends
// the usual Runtime install directories, so a GUI launch with a minimal PATH
// still finds and runs Homebrew, npm and installer copies of the Runtimes.
func terminalEnvironment(ctx context.Context, source map[string]string) map[string]string {
	environment := maps.Clone(source)
	if environment == nil {
		environment = make(map[string]string)
	}
	if !captureTerminalPath(ctx, environment) {
		prependUserDirectories(environment)
	}
	appendCommonDirectories(environment)
	return environment
}

// commonRuntimeDirectories are where Runtime installers and package managers
// put executables when a login shell adds them to PATH.
func commonRuntimeDirectories(home string) []string {
	directories := []string{"/opt/homebrew/bin", "/usr/local/bin"}
	if filepath.IsAbs(home) {
		for _, relative := range []string{".local/bin", ".npm-global/bin", ".volta/bin", ".bun/bin", ".claude/local"} {
			directories = append(directories, filepath.Join(home, relative))
		}
	}
	return directories
}

// Without the terminal PATH (a slow profile at boot times out), the user's own
// install directories come first so an older global install inherited from the
// app (e.g. /usr/local/bin/claude) does not shadow the user's current one.
func prependUserDirectories(environment map[string]string) {
	home := environment["HOME"]
	if runtime.GOOS == "windows" || !filepath.IsAbs(home) {
		return
	}
	var entries []string
	for _, directory := range commonRuntimeDirectories(home) {
		if strings.HasPrefix(directory, home+string(os.PathSeparator)) {
			entries = append(entries, directory)
		}
	}
	if inherited := environment["PATH"]; inherited != "" {
		entries = append(entries, inherited)
	}
	environment["PATH"] = strings.Join(entries, string(os.PathListSeparator))
}

func appendCommonDirectories(environment map[string]string) {
	if runtime.GOOS == "windows" {
		return
	}
	entries := filepath.SplitList(environment["PATH"])
	present := make(map[string]bool, len(entries))
	for _, entry := range entries {
		present[filepath.Clean(entry)] = true
	}
	for _, directory := range commonRuntimeDirectories(environment["HOME"]) {
		if !present[directory] {
			entries = append(entries, directory)
			present[directory] = true
		}
	}
	environment["PATH"] = strings.Join(entries, string(os.PathListSeparator))
}

// Capture only PATH: shell startup output and credentials never enter diagnostics.
func captureTerminalPath(ctx context.Context, environment map[string]string) bool {
	shell := environment["SHELL"]
	if runtime.GOOS == "windows" || !filepath.IsAbs(shell) {
		return false
	}
	bounded, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	const marker = "\x00linger-runtime-path\x00"
	command := exec.CommandContext(bounded, shell, "-lic", `/bin/sh -c 'printf "\000linger-runtime-path\000%s\n" "$PATH"'`)
	command.Env = environmentList(environment)
	if home := environment["HOME"]; filepath.IsAbs(home) {
		command.Dir = home
	}
	stdout := &boundedProbeBuffer{limit: maxProbeOutputBytes}
	stderr := &boundedProbeBuffer{limit: maxProbeOutputBytes}
	command.Stdout, command.Stderr = stdout, stderr
	if err := process.Run(bounded, command, time.Second); err != nil || stdout.overflow || stderr.overflow {
		return false
	}
	_, captured, ok := strings.Cut(stdout.String(), marker)
	captured = strings.TrimSpace(captured)
	if !ok || captured == "" || strings.ContainsAny(captured, "\x00\r\n") {
		return false
	}
	// Keep bundled tools available after the user's terminal-selected executables.
	if inherited := environment["PATH"]; inherited != "" {
		captured += string(os.PathListSeparator) + inherited
	}
	environment["PATH"] = captured
	return true
}
