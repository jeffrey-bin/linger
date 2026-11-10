//go:build integration_process

package integration_test

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func startAgentManagerProcessWithRecordedCodexFixture(t *testing.T, computer *localBusinessProcessFixture, teamHubURL string) (func(), string) {
	t.Helper()
	fixtureRoot := t.TempDir()
	fixture, err := os.ReadFile(filepath.Join(repositoryPath(), "scripts/test-fixtures/codex-app-server-fixture.mjs"))
	if err != nil {
		t.Fatal(err)
	}
	// Retain the actual turn request as evidence of the provider input, separate
	// from the Agent workspace copy of the message.
	fixture = bytes.Replace(fixture, []byte("const request = JSON.parse(line);"), []byte(`const request = JSON.parse(line);
if (request.method === "turn/start") writeFileSync(new URL("./turn-" + process.pid + ".jsonl", import.meta.url), line + "\n", {flag: "a"});`), 1)
	fixturePath := filepath.Join(fixtureRoot, "codex.mjs")
	if err := os.WriteFile(fixturePath, fixture, 0o600); err != nil {
		t.Fatal(err)
	}
	stop := computer.start(t, teamHubURL, "#!/bin/sh\nexec node '"+fixturePath+"' \"$@\" --empty-thread-history --persist-threads\n")
	return stop, fixtureRoot
}

func withoutEnv(environ []string, keys ...string) []string {
	drop := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		drop[key] = struct{}{}
	}
	filtered := make([]string, 0, len(environ))
	for _, entry := range environ {
		key, _, _ := strings.Cut(entry, "=")
		if _, skip := drop[key]; skip {
			continue
		}
		filtered = append(filtered, entry)
	}
	return filtered
}

// Build from current sources even when dist exists, so a focused go test has the
// same preparation as a clean CI checkout and cannot consume a stale CLI bundle.
func buildTeamHubCLIForProcess(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "pnpm", "--filter", "@linger/teamhub-cli", "build")
	command.Dir = repositoryPath()
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("build standalone TeamHub CLI for process test: %v\n%s", err, output)
	}
	t.Logf("built standalone TeamHub CLI from current sources:\n%s", output)
}
